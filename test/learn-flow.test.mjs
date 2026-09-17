// 会话学习流程（js/learn-flow.js）测试：请求构造只此一份——手动「确认学习」与导出
// 自动学习（工单 07 / 定案 D24）共用本模块，这里断言的 multipart 内容即两种触发方式
// 的请求内容（含 task_id/场景标签/日志顺带上送）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/state.js';
import { createActions } from '../js/actions.js';
import { createJournal } from '../js/journal.js';
import { createPipelineClient } from '../js/pipeline.js';
import { createLearnFlow } from '../js/learn-flow.js';

// ---------- 假件 ----------

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// 捕获全部 HTTP 调用；sinkFail 为真时 journal sink 上送抛网络错误（学习请求本身正常）
function captureFetch({ sinkFail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (sinkFail && url.endsWith('/api/journal/sink') && options.method === 'POST') {
      throw new TypeError('Failed to fetch');
    }
    return {
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/api/journal/sink')
        ? { accepted: 3, duplicates: 1 }
        : { status: 'ok', alignment_coverage: 0.9 }),
    };
  };
  return { calls, fetchImpl };
}

function setup({ sinkFail = false, mediaFile = null } = {}) {
  const store = createStore();
  const journal = createJournal(store, { storage: fakeStorage(), now: () => '2026-09-10T00:00:00Z' });
  const actions = createActions(store, { journal }); // commit 挂钩日志（与 main.js 装配同构）
  const { calls, fetchImpl } = captureFetch({ sinkFail });
  const pipeline = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl });
  const flow = createLearnFlow({
    store,
    pipeline,
    journal,
    getMediaFile: () => mediaFile,
  });
  return { store, actions, journal, flow, calls };
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

function mediaDummy() {
  return new File(['audio-bytes'], 'episode.wav', { type: 'audio/wav' });
}

// FormData → 可比较结构（File 取名字/类型/文本内容）
async function formToMap(form) {
  const map = {};
  for (const [key, value] of form.entries()) {
    map[key] = value instanceof File
      ? { name: value.name, type: value.type, text: await value.text() }
      : value;
  }
  return map;
}

// ---------- 请求构造（确认学习 = 自动学习的请求内容） ----------

test('确认学习：multipart 携带 task_id/scenario/reference，audio 可省，日志 sink 顺带上送', async () => {
  const env = setup();
  loadFixture(env.actions);
  env.store.patch({ pipelineRun: { taskId: 'task-abc123', runId: null } }); // 深链/管线会话来源
  env.actions.updateCueTimes('a', 1.5, 3); // 产生一条日志事件

  const { result, journalNote, source } = await env.flow.run({ dryRun: false });

  assert.equal(result.status, 'ok');
  assert.equal(source.taskId, 'task-abc123');
  assert.equal(env.calls.length, 2); // learn → journal sink
  const { url, options } = env.calls[0];
  assert.equal(url, 'http://127.0.0.1:8613/api/feedback/learn');
  assert.equal(options.method, 'POST');
  const form = await formToMap(options.body);
  assert.equal(form.reference.name, 'x_edited.srt');
  assert.equal(form.reference.type, 'text/plain');
  assert.match(form.reference.text, /第一句/);
  assert.equal(form.task_id, 'task-abc123');
  assert.equal(form.scenario, 'inline-review');
  assert.equal(form.audio, undefined); // 带 task_id 时不传音频
  assert.equal(form.dry_run, 'false');
  assert.equal(form.run_pipeline_first, 'true');
  assert.equal(form.profile, 'default');
  assert.equal(form.feedback_profile, 'user_default');
  // 日志顺带上送：正文即 journal.exportText()（导出与上送唯一文本来源）
  assert.equal(env.calls[1].url, 'http://127.0.0.1:8613/api/journal/sink');
  assert.equal(env.calls[1].options.body, env.journal.exportText());
  assert.match(journalNote, /日志已上送（接收 3 条，去重 1）/);
});

test('请求内容与手动点击一致：自动学习（默认参数）与手动确认（面板默认 UI 值）的 multipart 恒等', async () => {
  const auto = setup();
  loadFixture(auto.actions);
  auto.store.patch({ pipelineRun: { taskId: 'task-abc123', runId: null } });
  auto.actions.updateCueTimes('a', 1.5, 3);
  const manual = setup();
  loadFixture(manual.actions);
  manual.store.patch({ pipelineRun: { taskId: 'task-abc123', runId: null } });
  manual.actions.updateCueTimes('a', 1.5, 3);

  // 自动学习路径：runLearn 注入的就是 flow.run({ dryRun: false })（默认参数）
  const autoRun = await auto.flow.run({ dryRun: false });
  // 手动路径：面板以 UI 当前值显式传参（默认 UI 即 default/user_default、写入式）
  const manualRun = await manual.flow.run({
    dryRun: false,
    profile: 'default',
    feedbackProfile: 'user_default',
  });

  const autoForm = await formToMap(auto.calls[0].options.body);
  const manualForm = await formToMap(manual.calls[0].options.body);
  assert.deepEqual(autoForm, manualForm); // 同一构造路径，字段逐项一致
  assert.deepEqual(autoRun.journalNote, manualRun.journalNote);
});

test('无任务来源：携带会话音频、不带 task_id，场景标签为 existing-subtitle', async () => {
  const env = setup({ mediaFile: mediaDummy() });
  loadFixture(env.actions);
  assert.equal(env.store.state.subtitleSource, 'file'); // loadSubtitle 即文件来源

  const { source } = await env.flow.run({ dryRun: false });

  assert.equal(source.taskId, null);
  assert.equal(source.scenario, 'existing-subtitle');
  assert.equal(source.fromSession, true);
  const form = await formToMap(env.calls[0].options.body);
  assert.equal(form.audio.name, 'episode.wav');
  assert.equal(form.task_id, undefined);
});

test('预览（dryRun=true）不发日志：只调 learn，journalNote 为空', async () => {
  const env = setup({ mediaFile: mediaDummy() });
  loadFixture(env.actions);

  const { journalNote } = await env.flow.run({ dryRun: true });

  assert.equal(env.calls.length, 1); // 无 journal sink 调用
  const form = await formToMap(env.calls[0].options.body);
  assert.equal(form.dry_run, 'true');
  assert.equal(journalNote, '');
});

test('日志上送失败不阻塞学习结果：journalNote 记失败、learn 结果照常返回', async () => {
  const env = setup({ sinkFail: true, mediaFile: mediaDummy() });
  loadFixture(env.actions);
  env.actions.updateCueTimes('a', 1.5, 3); // 产生一条日志事件，才有可上送的正文

  const { result, journalNote } = await env.flow.run({ dryRun: false });

  assert.equal(result.status, 'ok');
  assert.match(journalNote, /日志上送失败：Failed to fetch/);
});

test('无 cue / 无媒体时 gatherSource 报错（调用方据此 toast，不构成第二份请求）', () => {
  const empty = setup({ mediaFile: null });
  assert.throws(() => empty.flow.gatherSource(), /当前没有字幕 cue/);
  const noMedia = setup({ mediaFile: null });
  loadFixture(noMedia.actions);
  assert.throws(() => noMedia.flow.gatherSource(), /当前没有已加载的音频/);
});

test('手动兜底来源（files 覆盖）：不携带 task_id/scenario，日志不随该路径上送', async () => {
  const env = setup();
  loadFixture(env.actions);
  env.store.patch({ pipelineRun: { taskId: 'task-abc123', runId: null } });
  env.actions.updateCueTimes('a', 1.5, 3);

  const { source, journalNote } = await env.flow.run({
    dryRun: false,
    files: {
      audio: mediaDummy(),
      reference: new File(['1\n00:00:00,000 --> 00:00:01,000\n外部\n'], 'outer.srt', { type: 'text/plain' }),
      fromSession: false,
      taskId: null,
      scenario: null,
    },
  });

  assert.equal(source.fromSession, false);
  const form = await formToMap(env.calls[0].options.body);
  assert.equal(form.task_id, undefined);
  assert.equal(form.scenario, undefined);
  assert.equal(env.calls.length, 1); // 非会话来源不顺带上送日志
  assert.equal(journalNote, '');
});
