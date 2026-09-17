// 编辑日志（edit-journal-v1）测试：commit 挂钩的命令名与字段级 diff、结构操作语义、
// actor 分流、队列持久化/轮转/清空、NDJSON 导出，以及「原始字幕 + 日志 = 最终字幕」重放还原。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/state.js';
import { createActions } from '../js/actions.js';
import { createJournal, replayCues, computeAudioContext, JOURNAL_SCHEMA } from '../js/journal.js';
import { createAgentApi } from '../js/agent-api.js';

// ---------- 假件 ----------

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// 峰值假件：0-1s 静音底噪(0.02)，1-2s 语音突发(0.5)，2-3s 静音
function fakeWaveformPeaks(rate = 100) {
  const samples = new Float32Array(rate * 3);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    samples[i] = t >= 1 && t < 2 ? 0.5 : 0.02;
  }
  return (t0, t1) => {
    const si = Math.max(0, Math.floor(t0 * rate));
    const ei = Math.min(samples.length, Math.ceil(t1 * rate));
    return { rate, start: si / rate, end: ei / rate, samples: samples.slice(si, ei) };
  };
}

function setup({ journalDeps = {} } = {}) {
  const storage = journalDeps.storage ?? fakeStorage();
  const store = createStore();
  const journal = createJournal(store, {
    storage,
    now: () => '2026-09-10T00:00:00Z',
    maxEvents: journalDeps.maxEvents,
    maxBytes: journalDeps.maxBytes,
    audioFeatures: journalDeps.audioFeatures ?? null,
    runId: journalDeps.runId ?? null,
    scenario: journalDeps.scenario ?? null,
  });
  const actions = createActions(store, { journal });
  return { store, actions, journal, storage };
}

function loadFixture(actions) {
  actions.loadSubtitle(
    [
      { id: 'a', start: 1, end: 3, text: '第一句' },
      { id: 'b', start: 4, end: 6, text: '第二句' },
    ],
    { name: 'x.srt', format: 'srt', doc: null },
  );
}

function parseNdjson(text) {
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function eventsOf(journal) {
  return parseNdjson(journal.exportText()).slice(1);
}

function project(cues) {
  return cues.map((c) => ({ id: c.id, start: c.start, end: c.end, text: c.text }));
}

// ---------- commit 挂钩：命令名与 diff ----------

test('updateCueTimes：命令名、字段级 modify diff 与 cue 上下文（前状态）', () => {
  const { actions, journal } = setup();
  loadFixture(actions);
  actions.updateCueTimes('a', 1.5, 3);
  assert.equal(journal.stats().events, 1);
  const [header, event] = parseNdjson(journal.exportText());
  assert.equal(header.schema, JOURNAL_SCHEMA);
  assert.equal(header.type, 'header');
  assert.equal(header.file.subtitle, 'x.srt');
  assert.equal(event.command, 'updateCueTimes');
  assert.equal(event.actor, 'human');
  assert.deepEqual(event.targets, ['a']);
  const d = event.diff[0];
  assert.equal(d.op, 'modify');
  assert.equal(d.id, 'a');
  assert.deepEqual(d.changes, [{ field: 'start', before: 1, after: 1.5 }]);
  // 上下文取变更前状态：a(1→3)，前无行后行 b 从 4 起
  assert.equal(event.context.cue.duration, 2);
  assert.equal(event.context.cue.gap_before, null);
  assert.equal(event.context.cue.gap_after, 1);
  assert.equal(event.context.cue.chars, 3);
  assert.equal(event.context.cue.cps, 1.5);
});

test('updateCue 文本+时间合并为一条 modify，多字段 changes', () => {
  const { actions, journal } = setup();
  loadFixture(actions);
  actions.updateCue('a', { text: '第一句改', start: 0.5 });
  const last = eventsOf(journal).at(-1);
  assert.equal(last.command, 'updateCue');
  const fields = last.diff[0].changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ['start', 'text']);
});

test('拆分=modify+add；合并=modify+remove；删除=remove；插入=add', () => {
  const { actions, journal } = setup();
  loadFixture(actions);

  actions.splitCue('a', 2); // head(a) 修改 end/text，tail 新增
  const split = eventsOf(journal).at(-1);
  assert.equal(split.command, 'splitCue');
  const splitOps = Object.fromEntries(split.diff.map((d) => [d.op, d]));
  assert.equal(splitOps.modify.id, 'a');
  assert.equal(splitOps.add.cue.start, 2);
  assert.equal(splitOps.add.index, 1);

  actions.mergeWithNext('a'); // a 吃掉自己的尾段：modify(a) + remove(tail)
  const merge = eventsOf(journal).at(-1);
  assert.equal(merge.command, 'mergeWithNext');
  const mergeOps = Object.fromEntries(merge.diff.map((d) => [d.op, d]));
  assert.ok(mergeOps.modify && mergeOps.remove);
  assert.equal(mergeOps.modify.id, 'a');

  actions.removeCues(['b']);
  const remove = eventsOf(journal).at(-1);
  assert.equal(remove.command, 'removeCues');
  assert.equal(remove.diff[0].op, 'remove');
  assert.equal(remove.diff[0].id, 'b');
  assert.equal(remove.diff[0].cue.text, '第二句');

  actions.insertAtTime(3.5);
  const insert = eventsOf(journal).at(-1);
  assert.equal(insert.command, 'insertAtTime');
  assert.equal(insert.diff[0].op, 'add');
});

test('coalesceKey 透传：连续微调逐条记录且键一致', () => {
  const { actions, journal } = setup();
  loadFixture(actions);
  actions.updateCueTimes('a', 1.1, 3, { coalesceKey: 'audio-timing' });
  actions.updateCueTimes('a', 1.2, 3, { coalesceKey: 'audio-timing' });
  const events = eventsOf(journal);
  assert.equal(events.length, 2); // 撤销合并为一步，日志仍是两条过程事件
  assert.ok(events.every((e) => e.coalesce_key === 'audio-timing'));
  assert.deepEqual(events.map((e) => e.seq), [0, 1]);
});

// ---------- actor 分流（人机数据不混） ----------

test('window.agent.act 期间事件标记为 agent，直接调用为 human', async () => {
  const { store, actions, journal } = setup();
  loadFixture(actions);
  const api = createAgentApi({ store, actions, journal });
  await api.act('updateCueTimes', ['a', 1.2, 3]);
  actions.updateCueTimes('a', 1.3, 3);
  const events = eventsOf(journal);
  assert.deepEqual(events.map((e) => e.actor), ['agent', 'human']);
});

test('getSnapshot 暴露 journal 统计，getJournalText 只读导出', async () => {
  const { store, actions, journal } = setup();
  loadFixture(actions);
  actions.updateCueTimes('a', 1.5, 3);
  const api = createAgentApi({ store, actions, journal });
  assert.deepEqual(api.getSnapshot().journal, { enabled: true, events: 1, overflow: false });
  assert.match(api.getJournalText(), /"type":"header"/);
  const bare = createAgentApi({ store, actions });
  assert.deepEqual(bare.getSnapshot().journal, { enabled: false, events: 0, overflow: false });
  assert.equal(bare.getJournalText(), null);
});

// ---------- 队列：持久化、轮转、清空、换文件 ----------

test('队列落盘并可跨实例恢复（stats 未编辑前也能读到）', () => {
  const storage = fakeStorage();
  const first = setup({ journalDeps: { storage } });
  loadFixture(first.actions);
  first.actions.updateCueTimes('a', 1.5, 3);
  first.journal.flush();
  const second = setup({ journalDeps: { storage } });
  loadFixture(second.actions);
  assert.equal(second.journal.stats().events, 1); // syncQueue：无需新编辑即可见历史
  const [, event] = parseNdjson(second.journal.exportText());
  assert.equal(event.command, 'updateCueTimes');
});

test('换文件即换队列，旧文件账本落盘、新文件独立', () => {
  const storage = fakeStorage();
  const { actions, journal } = setup({ journalDeps: { storage } });
  loadFixture(actions);
  actions.updateCueTimes('a', 1.5, 3);
  actions.loadSubtitle([{ id: 'z', start: 0, end: 1, text: '另文件' }], { name: 'y.srt', format: 'srt', doc: null });
  actions.updateCueTimes('z', 0.1, 1);
  assert.equal(journal.stats().events, 1); // 当前队列只有 y.srt 的事件
  const header = parseNdjson(journal.exportText())[0];
  assert.equal(header.file.subtitle, 'y.srt');
  // 切换前 x.srt 的队列已落盘，重新加载可读
  const reopened = setup({ journalDeps: { storage } });
  reopened.actions.loadSubtitle(
    [{ id: 'a', start: 1, end: 3, text: '第一句' }],
    { name: 'x.srt', format: 'srt', doc: null },
  );
  assert.equal(reopened.journal.stats().events, 1);
});

test('轮转上限：丢最旧保最新并置 overflow，清空后恢复', () => {
  const { actions, journal } = setup({ journalDeps: { maxEvents: 3 } });
  loadFixture(actions);
  for (let i = 1; i <= 6; i++) actions.updateCueTimes('a', 1 + i * 0.01, 3);
  assert.equal(journal.stats().events, 3);
  assert.equal(journal.stats().rotated, 3);
  assert.equal(journal.stats().overflow, true);
  const [header, ...events] = parseNdjson(journal.exportText());
  assert.equal(header.rotated, 3);
  assert.equal(header.overflow, true);
  assert.deepEqual(events.map((e) => e.seq), [3, 4, 5]); // 最近 3 条
  assert.equal(events.at(-1).diff[0].changes[0].after, 1.06); // 最新状态可重放
  journal.clear();
  assert.deepEqual(journal.stats(), { enabled: true, events: 0, rotated: 0, overflow: false });
});

test('字节上限：超预算触发轮转，最新事件始终保留', () => {
  const { actions, journal } = setup({ journalDeps: { maxBytes: 500 } });
  loadFixture(actions);
  const longText = '字'.repeat(60);
  for (let i = 0; i < 5; i++) actions.updateCue('a', { text: longText + i });
  const stats = journal.stats();
  assert.ok(stats.events >= 1 && stats.events < 5, `轮转后应保留部分事件，实际 ${stats.events}`);
  assert.ok(stats.rotated >= 1);
  assert.equal(stats.overflow, true);
  const last = eventsOf(journal).at(-1);
  assert.equal(last.diff[0].changes[0].after, longText + '4');
});

test('关停后不记录', () => {
  const { actions, journal } = setup();
  loadFixture(actions);
  journal.setEnabled(false);
  actions.updateCueTimes('a', 1.5, 3);
  assert.deepEqual(journal.stats(), { enabled: false, events: 0, rotated: 0, overflow: false });
  assert.equal(journal.exportText(), null);
});

// ---------- 契约一致性（与 Python 摄取端/ sink 校验对齐） ----------

test('契约一致性：事件与 header 携带 session_id 必填字段，schema 为 edit-journal-v1', () => {
  const { actions, journal } = setup();
  loadFixture(actions);
  actions.updateCueTimes('a', 1.5, 3);
  const [header, event] = parseNdjson(journal.exportText());
  // 摄取端必填字段（vocal_subtitle/feedback/journal_ingest.py 与 webui routes_journal 同一契约）：
  // 缺任一项事件会被整体拒绝，学习闭环断流
  for (const field of ['schema', 'type', 'session_id', 'seq', 'command']) {
    assert.ok(field in event, `事件缺少契约必填字段 ${field}`);
  }
  assert.equal(event.schema, 'edit-journal-v1');
  assert.match(String(event.session_id), /^s-/);
  // sink 按 header.session_id 路由会话文件；sessions 数组为多会话队列的追加字段
  assert.equal(header.session_id, event.session_id);
  assert.deepEqual(header.sessions, [event.session_id]);
});

// ---------- 场景标签（四场景 D27，header 可选字段） ----------

test('header 携带 scenario：判定得出时写入，导出与上送（同一 exportText）均含该字段', () => {
  const { actions, journal } = setup({ journalDeps: { scenario: () => 'inline-review' } });
  loadFixture(actions);
  actions.updateCueTimes('a', 1.5, 3);
  const [header] = parseNdjson(journal.exportText());
  assert.equal(header.scenario, 'inline-review');
  assert.ok('scenario' in header);
});

test('header scenario 为可选：判定不出时字段缺省，与旧日志同构', () => {
  const { actions, journal } = setup({ journalDeps: { scenario: () => null } });
  loadFixture(actions);
  actions.updateCueTimes('a', 1.5, 3);
  const [header] = parseNdjson(journal.exportText());
  assert.equal('scenario' in header, false);
  // 未注入 scenario 依赖（旧装配路径）同样不产生该字段
  const bare = setup();
  loadFixture(bare.actions);
  bare.actions.updateCueTimes('a', 1.5, 3);
  assert.equal('scenario' in parseNdjson(bare.journal.exportText())[0], false);
});

test('旧队列（无 scenario 概念的持久化数据）装载不受影响，导出正常且按需补 scenario', () => {
  const storage = fakeStorage();
  // 直接写入旧版队列 JSON：结构与 edit-journal-v1 现存字段一致，无任何 scenario 痕迹
  storage.setItem(
    'vstEditor.journal.x.srt',
    JSON.stringify({
      version: 1,
      file: { subtitle: 'x.srt', media: '' },
      overflow: false,
      events: [{
        schema: JOURNAL_SCHEMA,
        type: 'event',
        session_id: 's-old',
        seq: 0,
        ts: '2026-01-01T00:00:00Z',
        actor: 'human',
        command: 'updateCueTimes',
        coalesce_key: null,
        targets: ['a'],
        diff: [{ op: 'modify', id: 'a', changes: [{ field: 'start', before: 1, after: 1.5 }] }],
        context: { cue: null, audio: null, provenance: null },
      }],
    }),
  );
  const { actions, journal } = setup({ journalDeps: { storage, scenario: () => 'existing-subtitle' } });
  loadFixture(actions); // x.srt 命中旧队列
  assert.equal(journal.stats().events, 1); // 装载无报错，事件完整
  const [header, event] = parseNdjson(journal.exportText());
  assert.equal(event.session_id, 's-old'); // 旧事件原样导出（上送对缺失字段宽容）
  assert.equal(header.scenario, 'existing-subtitle'); // scenario 在导出时按当前会话补齐
});

// ---------- 重放还原（验收：原始字幕 + 日志 = 最终字幕） ----------

test('多操作序列重放还原最终状态', () => {
  const { store, actions, journal } = setup();
  loadFixture(actions);
  const original = JSON.parse(JSON.stringify(store.state.cues));

  actions.updateCue('a', { text: '第一句修订' }); // 1 modify: text
  actions.updateCueTimes('a', 0.8, 3); // 2 modify: start
  actions.splitCue('a', 2); // 3 modify + add（尾段新行）
  actions.mergeWithNext('a'); // 4 modify + remove（a 吃回尾段）
  actions.removeCues(['b']); // 5 remove
  actions.insertAtTime(6.5); // 6 add（空行占位）
  actions.duplicateCues([store.state.cues[0].id]); // 7 add（复制首行）
  actions.nudge(store.state.cues[0].id, 'end', 0.25); // 8 modify: end

  const events = parseNdjson(journal.exportText()).filter((l) => l.type === 'event');
  assert.equal(events.length, 8);
  const replayed = replayCues(original, events);
  assert.deepEqual(project(replayed), project(store.state.cues));
});

// ---------- 音频特征（What 层） ----------

test('computeAudioContext：局部能量、语音判定与最近边界', () => {
  const peaks = fakeWaveformPeaks();
  const win = peaks(0.5, 2.5);
  const ctx = computeAudioContext(win.samples, 100, win.start, 1.2, 1.8);
  assert.equal(ctx.local_energy > 0.4, true); // 窗口大部分处于语音突发内
  assert.equal(ctx.vad_speech, true);
  assert.equal(ctx.nearest_speech_boundary.dist, -0.2); // 1.0s 处静音→语音跳变
  const silentWin = peaks(2.1, 2.9);
  const silent = computeAudioContext(silentWin.samples, 100, silentWin.start, 2.2, 2.8);
  assert.equal(silent.vad_speech, false);
});

test('audioFeatures 注入：事件携带音频上下文', () => {
  const peaks = fakeWaveformPeaks();
  const { actions, journal } = setup({
    journalDeps: {
      audioFeatures: (t0, t1) => {
        const d = peaks(Math.max(0, t0 - 2), t1 + 2);
        return computeAudioContext(d.samples, d.rate, d.start, t0, t1);
      },
    },
  });
  loadFixture(actions);
  actions.updateCueTimes('a', 1.5, 3);
  const event = eventsOf(journal).at(-1);
  assert.equal(event.context.audio.vad_speech, true);
  assert.ok(event.context.audio.nearest_speech_boundary);
  assert.equal(event.context.provenance, null); // manifest 通道 P3 接入
});
