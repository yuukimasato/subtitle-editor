// 编辑日志（edit-journal-v1）：记录「上下文而非操作」——每条事件对应一次 commit()
// （撤销步，保留 coalesceKey 供摄取端合并连续微调），内容为字段级 diff 加受影响 cue
// 的前后文特征与本地可算的音频特征（What 层）。纯本地：localStorage 队列按字幕文件
// 键存储（与草稿同构），导出字幕时搭车 .journal.jsonl；默认开启、可关停、可清空。
// 学习侧只消费导出文件（外部契约，见 docs/vad-provider-contract.md 同层的独立性约束），
// 本模块不联网。
import { sortCues } from './format/cue.js';
import { cueStyle } from './format/index.js';

const PREFIX = 'vstEditor.journal.';
const ENABLE_KEY = 'vstEditor.journalEnabled';
const SAVE_DELAY = 1000;
// 轮转上限：事件数或序列化体积（JSON 字符数近似，2M 字符 ≈ UTF-8 下 2-6MB，处于
// localStorage 5-10MB 配额安全区）任一触顶即丢最旧保最新，并置 overflow 提示导出
const MAX_EVENTS = 5000;
const MAX_CHARS = 2_000_000;
const SCHEMA_VERSION = 1;
export const JOURNAL_SCHEMA = 'edit-journal-v1';

// deps: {
//   namespace     存储键命名空间（agent 会话与人互不混写）
//   storage       可注入（单测）；默认 localStorage，不可用时静默降级为内存队列
//   now           可注入（单测）；返回 ISO 时间戳
//   maxEvents     可注入（单测）；默认 MAX_EVENTS
//   maxBytes      可注入（单测）；默认 MAX_CHARS（序列化 JSON 字符数预算）
//   audioFeatures (t0, t1) => 音频特征 | null；main.js 由波形峰值派生注入
//   runId         () => string | null；管线运行 ID（manifest 载入后），进导出 header
// }
export function createJournal(store, deps = {}) {
  const storage = deps.storage ?? defaultStorage();
  const now = deps.now ?? (() => new Date().toISOString());
  const maxEvents = deps.maxEvents ?? MAX_EVENTS;
  const maxBytes = deps.maxBytes ?? MAX_CHARS;
  const audioFeatures = deps.audioFeatures ?? null;
  const prefix = deps.namespace ? `${PREFIX}${deps.namespace}:` : PREFIX;

  let actor = 'human'; // human | agent（window.agent.act 执行期间置 agent）
  let current = null; // 当前会话 {id, seq}
  let loadedKey = null; // 当前队列对应的存储键（换文件即换队列）
  let queue = emptyQueue();
  let timer = null;

  function emptyQueue() {
    return { version: SCHEMA_VERSION, file: { subtitle: '', media: '' }, overflow: false, rotated: 0, bytes: 0, events: [] };
  }

  function isEnabled() {
    if (typeof storage?.getItem !== 'function') return true;
    try {
      return storage.getItem(ENABLE_KEY) !== '0';
    } catch {
      return true;
    }
  }

  function setEnabled(value) {
    try {
      storage?.setItem(ENABLE_KEY, value ? '1' : '0');
    } catch {
      // 存储不可用：仅本次会话生效
    }
  }

  // 文件身份：与草稿键同构（完整文件名小写），换文件即换队列
  function fileIdentity() {
    const s = store.state;
    return { subtitle: s.subtitleName || '', media: s.mediaName || '' };
  }

  function identityKey(file) {
    return String(file.subtitle || file.media || '').trim().toLowerCase();
  }

  function queueKey(file) {
    const key = identityKey(file);
    return key ? prefix + key : null;
  }

  function loadQueue(file) {
    if (loadedKey) persistNow(); // 切换前先把旧文件队列落盘，避免跨文件丢账
    const key = queueKey(file);
    loadedKey = key;
    current = null;
    if (!key || typeof storage?.getItem !== 'function') {
      queue = emptyQueue();
      queue.file = file;
      return;
    }
    try {
      const raw = storage.getItem(key);
      const data = raw ? JSON.parse(raw) : null;
      if (data?.version === SCHEMA_VERSION && Array.isArray(data.events)) {
        // 旧版队列没有 rotated/bytes 字段：字节预算从现有事件重算（轮转才需要，装载时算一次）
        queue = {
          version: SCHEMA_VERSION,
          file: data.file ?? { subtitle: '', media: '' },
          overflow: Boolean(data.overflow),
          rotated: Number.isFinite(data.rotated) ? data.rotated : 0,
          bytes: Number.isFinite(data.bytes)
            ? data.bytes
            : data.events.reduce((sum, event) => sum + JSON.stringify(event).length, 0),
          events: data.events,
        };
      } else {
        queue = emptyQueue();
        queue.file = file;
      }
    } catch {
      queue = emptyQueue();
      queue.file = file;
    }
  }

  function persistNow() {
    clearTimeout(timer);
    timer = null;
    if (typeof storage?.setItem !== 'function') return;
    const key = loadedKey ?? queueKey(queue.file);
    if (!key) return;
    try {
      queue.updatedAt = Date.now();
      storage.setItem(key, JSON.stringify(queue));
    } catch (err) {
      console.warn('[journal] 日志落盘失败（存储配额不足或不可用？）:', err);
    }
  }

  function persistLater() {
    clearTimeout(timer);
    timer = setTimeout(persistNow, SAVE_DELAY);
  }

  function newSession() {
    current = { id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, seq: 0 };
  }

  // 确保内存队列与当前文件对应（换文件即换队列）；无可识别文件身份时返回 false
  function syncQueue() {
    const file = fileIdentity();
    const key = queueKey(file);
    if (!key) return false;
    if (key !== loadedKey) loadQueue(file);
    return true;
  }

  // 记录一次 commit。before/after 为 commit 前后的 cues 全量数组，diff 在此计算，
  // 让 actions.js 保持薄挂钩（只传命令名与前后状态）。
  function record({ command, coalesceKey = null, before, after }) {
    if (!isEnabled()) return;
    if (!syncQueue()) return; // 未加载字幕：无上下文可记
    queue.file = fileIdentity();
    if (!current) newSession();
    const diff = diffCues(before, after);
    if (!diff.length) return;
    const primary = primaryCue(diff);
    const anchorCues = primary?.side === 'after' ? after : before;
    const event = {
      schema: JOURNAL_SCHEMA,
      type: 'event',
      session_id: current.id,
      seq: current.seq++,
      ts: now(),
      actor,
      command,
      coalesce_key: coalesceKey,
      targets: [...new Set(diff.map((d) => d.id))],
      diff,
      context: {
        cue: primary ? cueContext(anchorCues, primary.id) : null,
        audio: primary && audioFeatures ? safeAudio(anchorCues, primary.id, primary.field) : null,
        provenance: primary ? provenanceOf(anchorCues, primary.id) : null,
      },
    };
    queue.events.push(event);
    queue.bytes += JSON.stringify(event).length;
    // 轮转：丢最旧保最新（近期编辑最有价值），overflow 提示尽快导出留档；
    // 单条事件即超预算时仍保留最新一条（最后状态可重放优先于体积预算）
    while (queue.events.length > 1 &&
           (queue.events.length > maxEvents || (maxBytes > 0 && queue.bytes > maxBytes))) {
      queue.bytes -= JSON.stringify(queue.events[0]).length;
      queue.events.shift();
      queue.rotated += 1;
    }
    queue.overflow = queue.rotated > 0;
    persistLater();
  }

  function safeAudio(cues, id, field) {
    const cue = cues.find((c) => c.id === id);
    if (!cue) return null;
    try {
      // 终点微调以结束时间为锚，其余以开始时间为锚
      return audioFeatures(field === 'end' ? cue.end : cue.start, cue.end) ?? null;
    } catch {
      return null;
    }
  }

  // 管线出处：cue 上的 provenance 由管线面板载入产物时标注（见 ui/pipeline-panel.js）
  function provenanceOf(cues, id) {
    const cue = cues.find((c) => c.id === id);
    return cue?.provenance ?? null;
  }

  // 导出 NDJSON：首行文件级 header，其后按记录顺序逐行事件（session/seq 在事件内）。
  // 账本语义：导出不清空队列，重复导出由摄取端按 (session, seq) 去重。
  function exportText() {
    syncQueue();
    persistNow();
    if (!queue.events.length) return null;
    const sessions = [...new Set(queue.events.map((e) => e.session_id))];
    const header = {
      schema: JOURNAL_SCHEMA,
      type: 'header',
      version: SCHEMA_VERSION,
      exported_at: now(),
      file: { ...queue.file },
      run_id: deps.runId?.() ?? null,
      event_count: queue.events.length,
      session_id: sessions[0] ?? null,
      sessions,
      rotated: queue.rotated,
      overflow: queue.overflow,
    };
    return [JSON.stringify(header), ...queue.events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  }

  function clear() {
    syncQueue();
    queue = emptyQueue();
    queue.file = fileIdentity();
    current = null;
    if (loadedKey && typeof storage?.removeItem === 'function') {
      try {
        storage.removeItem(loadedKey);
      } catch {
        // 忽略
      }
    }
    persistNow();
  }

  function flush() {
    persistNow();
  }

  function stats() {
    syncQueue();
    return { enabled: isEnabled(), events: queue.events.length, rotated: queue.rotated, overflow: queue.overflow };
  }

  return {
    record,
    exportText,
    clear,
    flush,
    stats,
    setEnabled,
    setActor(value) {
      actor = value === 'agent' ? 'agent' : 'human';
    },
  };
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// ---------- diff 与上下文特征（纯函数） ----------

// 字段级 diff：修改记变更字段；结构操作记整行快照加位置（重放与归因都需要）。
// V1 覆盖 start/end/text/style；ASS meta 其余部分不在日志范围。
function diffCues(before, after) {
  const beforeById = new Map(before.map((c) => [c.id, c]));
  const afterById = new Map(after.map((c) => [c.id, c]));
  const diff = [];
  for (const cue of after) {
    const prev = beforeById.get(cue.id);
    if (!prev) {
      diff.push({ op: 'add', id: cue.id, index: after.indexOf(cue), cue: snapshot(cue) });
      continue;
    }
    const changes = [];
    for (const field of ['start', 'end', 'text']) {
      if (prev[field] !== cue[field]) changes.push({ field, before: prev[field], after: cue[field] });
    }
    if (cueStyle(prev) !== cueStyle(cue)) {
      changes.push({ field: 'style', before: cueStyle(prev), after: cueStyle(cue) });
    }
    if (changes.length) diff.push({ op: 'modify', id: cue.id, changes });
  }
  for (const cue of before) {
    if (!afterById.has(cue.id)) {
      diff.push({ op: 'remove', id: cue.id, index: before.indexOf(cue), cue: snapshot(cue) });
    }
  }
  return diff;
}

function snapshot(cue) {
  return { start: cue.start, end: cue.end, text: cue.text };
}

// 主影响 cue：修改/删除取 before 侧首条，纯新增取 after 侧首条；
// field 用于音频特征选锚（只动 end 时以结束时间为锚）。
function primaryCue(diff) {
  const first = diff.find((d) => d.op === 'modify') ?? diff[0];
  if (!first) return null;
  if (first.op === 'add') return { id: first.id, side: 'after', field: 'start' };
  const field = first.op === 'modify' ? first.changes[0]?.field : 'start';
  return { id: first.id, side: 'before', field };
}

// 单条 cue 的前后文特征：时长、与前后行的留白、字数与 CPS（从有序数组按位置取邻行）
function cueContext(cues, id) {
  const index = cues.findIndex((c) => c.id === id);
  if (index === -1) return null;
  const cue = cues[index];
  const prev = cues[index - 1] ?? null;
  const next = cues[index + 1] ?? null;
  const duration = r3(cue.end - cue.start);
  const chars = String(cue.text ?? '').length;
  return {
    id,
    duration,
    gap_before: prev ? r3(cue.start - prev.end) : null,
    gap_after: next ? r3(next.start - cue.end) : null,
    chars,
    cps: duration > 0 ? r2(chars / duration) : null,
  };
}

// 音频特征（What 层，与 agent/vad.js 的能量 VAD 同参数体系）：
// 噪声底取窗口 20 分位，语音阈值 3 倍；local_energy 为 [t0,t1] 的均值振幅。
function computeAudioContext(samples, rate, windowStart, t0, t1) {
  if (!samples?.length || !rate) return null;
  const abs = (v) => Math.abs(v);
  const lo = Math.max(0, Math.floor((t0 - windowStart) * rate));
  const hi = Math.min(samples.length, Math.ceil((t1 - windowStart) * rate));
  if (hi <= lo) return null;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += abs(samples[i]);
  const localEnergy = sum / (hi - lo);
  // 噪声底：窗口抽样（超 4000 点跨步取样）后取 20 分位
  const step = Math.max(1, Math.floor(samples.length / 4000));
  const noise = [];
  for (let i = 0; i < samples.length; i += step) noise.push(abs(samples[i]));
  noise.sort((a, b) => a - b);
  const floor = noise[Math.floor(noise.length * 0.2)] ?? 0;
  const threshold = floor * 3;
  // 最近语音边界：分类跳变点（静音↔语音）中离锚点最近者
  const anchor = t0;
  let nearest = null;
  let previousSpeech = null;
  for (let i = 0; i < samples.length; i++) {
    const speech = abs(samples[i]) > threshold;
    if (previousSpeech !== null && speech !== previousSpeech) {
      const t = windowStart + i / rate;
      const dist = t - anchor;
      if (nearest === null || Math.abs(dist) < Math.abs(nearest.dist)) {
        nearest = { t: r3(t), dist: r3(dist) };
      }
    }
    previousSpeech = speech;
  }
  return {
    local_energy: r3(localEnergy),
    vad_speech: threshold > 0 ? localEnergy > threshold : null,
    nearest_speech_boundary: nearest,
  };
}

function r3(v) {
  return Math.round(v * 1000) / 1000;
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

// 重放：原始 cues + 全量事件 → 最终 cues。每次事件后按时间序稳定排序，
// 与 actions.js 的 sortCues 语义一致（add 的 index 即当时排序后的插入位置）。
// V1 重放字段为 start/end/text/style 中的前三个；style 变更不影响重放结果。
export function replayCues(originalCues, events) {
  let cues = originalCues.map((c) => ({ ...c }));
  for (const event of events) {
    if (event?.type !== 'event' || !Array.isArray(event.diff)) continue;
    for (const d of event.diff) {
      if (d.op === 'modify') {
        const cue = cues.find((c) => c.id === d.id);
        if (!cue) continue;
        for (const change of d.changes) {
          if (change.field === 'start' || change.field === 'end' || change.field === 'text') {
            cue[change.field] = change.after;
          }
        }
      } else if (d.op === 'remove') {
        cues = cues.filter((c) => c.id !== d.id);
      } else if (d.op === 'add') {
        const cue = { id: d.id, ...d.cue };
        const at = Math.min(Math.max(d.index, 0), cues.length);
        cues.splice(at, 0, cue);
      }
    }
    cues = sortCues(cues);
  }
  return cues;
}

export { computeAudioContext };
