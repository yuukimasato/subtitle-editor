// 字幕自动同步（editor-sync-v1）：每次编辑提交（actions commit → cues 事件）后把当前
// 字幕序列化 POST 到本机处理台（8613）存储，处理台工作台可随时下载最新稿。
// - 「修改一次存一次」：cues 事件驱动，短防抖只合并按住连发（音频盒微调等），静止即上送；
//   导出成功与 flush()（页面隐藏/关闭）立即上送；
// - 说话人开关与导出共用同一策略（include=false 时同步稿同样剥离说话人）；
// - 处理台离线/未部署该端点时静默降级：状态条提示 + 30 秒退避，编辑器其余功能不受影响；
// - agent 会话（?agent=1）不同步：与人用会话互不覆盖（同草稿命名空间约定）。
// 本模块不含 DOM：序列化/网络/提示均可注入（单测）。
import { applySpeakerExport } from './format/speaker-export.js';

const SYNC_DELAY = 600; // 连发合并窗口；静止即上送
const RETRY_BACKOFF = 30_000; // 失败后的重试退避

export function createSubtitleSync(store, {
  agentMode = false,
  delay = SYNC_DELAY,
  serialize, // (cues, format, doc) => string：含骨架处理的序列化（装配层注入）
  post, // async (payload) => response：HTTP 上送（装配层注入）
  notify = () => {}, // (message, type?) => void：失败提示（toast）
  statusEl = null, // 同步状态条（复用 .save-status 样式）
  includeSpeakers = () => true, // 说话人开关（与导出同一数据源）
  clock = () => new Date(),
} = {}) {
  let timer = null;
  let busy = false;
  let rerun = false; // 上送进行中又有新改动：完成后补一次
  let unavailableUntil = 0;

  function status(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // 当前字幕稿的同步载荷；无可同步内容（空表/无文件身份/未装配序列化）返回 null
  function buildPayload() {
    if (typeof serialize !== 'function') return null;
    const s = store.state;
    if (!s.cues.length) return null;
    const name = s.subtitleName || s.mediaName;
    if (!name) return null;
    const format = s.subtitleFormat || 'srt';
    const include = Boolean(includeSpeakers());
    const cues = applySpeakerExport(s.cues, { format, include });
    return {
      name,
      media_name: s.mediaName || '',
      format,
      include_speakers: include,
      cue_count: s.cues.length,
      run_id: s.pipelineRun?.runId ?? null,
      task_id: s.pipelineRun?.taskId ?? null,
      updated_at: clock().toISOString(),
      content: serialize(cues, format, s.subDoc),
    };
  }

  async function syncNow() {
    clearTimeout(timer);
    timer = null;
    if (agentMode || typeof post !== 'function') return { status: 'disabled' };
    if (busy) {
      rerun = true;
      return { status: 'busy' };
    }
    if (Date.now() < unavailableUntil) return { status: 'offline' };
    const payload = buildPayload();
    if (!payload) return { status: 'empty' };
    busy = true;
    try {
      const res = await post(payload);
      status(`已同步到处理台 ${clock().toLocaleTimeString()}`);
      return { status: 'synced', res };
    } catch (err) {
      unavailableUntil = Date.now() + RETRY_BACKOFF;
      status('处理台离线，改动仅存本地草稿');
      notify(`字幕同步处理台失败：${err?.message || err}（稍后自动重试）`, 'error');
      return { status: 'error', error: String(err?.message || err) };
    } finally {
      busy = false;
      if (rerun) {
        rerun = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (agentMode) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, delay);
  }

  // 立即上送（导出成功 / 页面隐藏 / beforeunload）
  function flush() {
    return syncNow();
  }

  store.on('cues', schedule);

  return { schedule, flush, buildPayload };
}
