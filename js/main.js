// 装配入口：状态 → 动作 → 播放器/定时控制器/音频盒/预览/列表/工具栏 → 快捷键。
import { createStore } from './state.js';
import { createActions } from './actions.js';
import { createTimingController } from './audio/timing.js';
import { createAudioCommands } from './audio/commands.js';
import { initShortcuts } from './shortcuts.js';
import { createPlayer } from './ui/player.js';
import { createWaveform } from './ui/waveform.js';
import { createAudioToolbar } from './ui/audio-toolbar.js';
import { createAssPreview } from './ui/ass-preview.js';
import { createCueList } from './ui/cue-list.js';
import { createContextMenu } from './ui/context-menu.js';
import { createToolbar } from './ui/toolbar.js';
import { initSplitters } from './ui/splitters.js';
import { createDraftStore } from './draft.js';
import { createJournal, computeAudioContext } from './journal.js';
import { createPanelManager } from './ui/panels/panelLayer.js';
import { createPipelinePanel } from './ui/pipeline-panel.js';
import { createFeedbackPanel } from './ui/feedback-panel.js';
import { createDetachableBlock, createDetachButton } from './ui/detach.js';
import { serializeSubtitle } from './format/index.js';
import { createAgentApi } from './agent-api.js';
import { showToast } from './ui/toast.js';

const $ = (selector) => document.querySelector(selector);

initSplitters();

// agent 会话（?agent=1）：草稿走独立命名空间且不自动落盘（人机同屏互不覆盖，见 docs/开发文档 §4.5）
const AGENT_QUERY_FLAG = 'agent';
const agentMode = new URLSearchParams(location.search).has(AGENT_QUERY_FLAG);

const store = createStore();

// 编辑日志：What 层音频特征由波形峰值派生（锚点前后各 2 秒窗口），waveform 稍后装配、惰性引用
const journal = createJournal(store, {
  namespace: agentMode ? AGENT_QUERY_FLAG : '',
  runId: () => store.state.pipelineRun?.runId ?? null,
  audioFeatures: (t0, t1) => {
    if (!waveform?.getPeaksData) return null;
    const anchor = t1 ?? t0;
    const data = waveform.getPeaksData(Math.max(0, t0 - 2), anchor + 2);
    if (!data) return null;
    return computeAudioContext(data.samples, data.rate, data.start, t0, anchor);
  },
});

const actions = createActions(store, { journal });

const player = createPlayer({
  store,
  mountEl: $('#video-mount'),
  transportEl: $('#transport'),
  onError: () => showToast('媒体播放出错：浏览器不支持该格式或文件已损坏', 'error'),
});

// Aegisub 对话定时控制器：改动先进 pending，提交时批量落库
let waveform = null;
const timing = createTimingController({
  cues: () => store.state.cues,
  activeId: () => store.state.selectedId,
  selectedIds: () => store.state.selectedIds ?? [],
  inactiveMode: () => store.state.audioOptions.inactiveMode,
  autoCommit: () => store.state.audioOptions.autoCommit,
  dragTiming: () => store.state.audioOptions.dragTiming,
  duration: () => store.state.duration,
  onApply: (entries, { auto }) => actions.updateCueTimesBulk(entries, {
    coalesceKey: auto ? 'audio-timing' : null,
  }),
  onChange: () => waveform?.syncView(),
});

// 行内编辑落库入口（cueList 稍后装配，这里惰性引用）
let cueList = null;
const flushEdits = () => cueList?.flush();

const audioCommands = createAudioCommands({
  store,
  actions,
  player,
  timing,
  flushEdits,
  waveform: {
    scrollToSelection: () => waveform?.scrollToSelection(),
    scrollByViewport: (dir) => waveform?.scrollByViewport(dir),
  },
});

waveform = createWaveform({
  store,
  actions,
  player,
  timing,
  displayEl: $('#wave-display'),
  containerEl: $('#waveform'),
  fallbackEl: $('#wave-fallback'),
  messageEl: $('#wave-msg'),
});

const audioToolbar = createAudioToolbar({
  store,
  actions,
  player,
  waveform,
  commands: audioCommands,
  toolbarEl: $('#audio-toolbar'),
  sideEl: $('#wave-side'),
});

const assPreview = createAssPreview({
  store,
  player,
  serialize: serializeSubtitle,
  onNotice: (message) => showToast(message),
});

const menu = createContextMenu();
cueList = createCueList({
  store,
  actions,
  player,
  tbodyEl: $('#cue-tbody'),
  wrapEl: $('.cue-table-wrap'),
  countEl: $('#cue-count'),
  toolsEl: $('#cue-tools'),
  statusEl: $('#save-status'),
  menu,
  pasteDialog: $('#paste-dialog'),
});

const draft = createDraftStore(store, agentMode ? { namespace: AGENT_QUERY_FLAG, autoSave: false } : {});

// 浮动面板系统：P2 落地渲染壳与持久化，默认零面板（现有固定布局不受影响）；
// P3 起管线面板等新界面经 panels.open() 打开（可拖动/缩放/吸附停靠）
const panels = createPanelManager({ namespace: agentMode ? AGENT_QUERY_FLAG : '' });

// 存量区块浮出（P2 收尾，方案 §3.4）：默认固定布局零变化，点「⧉」把整块搬进可拖动/
// 缩放/吸附的浮动窗口，关闭面板（X/ESC）即自动回驻。波形依赖 ResizeObserver 自适应，
// DOM 原地迁移后无需重建；浮出状态持久化，重载恢复。
const waveDetachBtn = createDetachButton();
waveDetachBtn.el.className = 'abtn detach-btn';
$('#audio-toolbar').appendChild(waveDetachBtn.el);
const waveBlock = createDetachableBlock({
  panels,
  store: panels.store,
  id: 'wave',
  title: '音频盒（波形定时区）',
  slot: $('.wave-wrap'),
  nodes: [$('.wave-main'), $('#audio-toolbar')],
  width: 820,
  height: 240,
  minWidth: 420,
  minHeight: 180,
  namespace: agentMode ? AGENT_QUERY_FLAG : '',
  onChange: (isDetached) => waveDetachBtn.sync(isDetached),
});
waveDetachBtn.el.addEventListener('click', () => (waveBlock.detached ? waveBlock.dock() : waveBlock.detach()));

const cueDetachBtn = createDetachButton();
cueDetachBtn.el.className = 'btn detach-btn';
$('#cue-tools').appendChild(cueDetachBtn.el);
const cueBlock = createDetachableBlock({
  panels,
  store: panels.store,
  id: 'cues',
  title: '字幕列表',
  slot: $('.cue-pane'),
  nodes: [$('#cue-tools'), $('.cue-table-wrap')],
  width: 440,
  height: 480,
  minWidth: 340,
  minHeight: 240,
  namespace: agentMode ? AGENT_QUERY_FLAG : '',
  onChange: (isDetached) => cueDetachBtn.sync(isDetached),
});
cueDetachBtn.el.addEventListener('click', () => (cueBlock.detached ? cueBlock.dock() : cueBlock.detach()));
waveBlock.restore();
cueBlock.restore();

const toolbar = createToolbar({
  store,
  actions,
  player,
  waveform,
  assPreview,
  draft,
  journal,
  flushEdits,
});

// 管线面板（P3）：提交任务 → 进度 → 载入产物（manifest 出处标注）→ 精修 → 导出
// 反馈学习面板（双界面收敛 M2）：当前会话音频 + 校对后字幕一键回传学习；
// lastMediaFile 记录最近一次打开的媒体（File），供学习面板"从当前会话学习"取用。
let lastMediaFile = null;
const openMediaFileTracked = (file) => {
  lastMediaFile = file;
  return toolbar.openMediaFile(file);
};

const pipelinePanel = createPipelinePanel({
  store,
  panels,
  openMediaFile: (file) => openMediaFileTracked(file),
  openSubtitleFile: (file) => toolbar.openSubtitleFile(file),
});
document.getElementById('btn-pipeline')?.addEventListener('click', () => pipelinePanel.open());

const feedbackPanel = createFeedbackPanel({
  store,
  panels,
  journal,
  getMediaFile: () => lastMediaFile,
});
const feedbackBtn = document.getElementById('btn-feedback');
feedbackBtn?.addEventListener('click', () => feedbackPanel.open());
// 8613 离线时隐藏学习入口（编辑器离线能力不受影响）；探测放在空闲时避免抢占首屏
feedbackBtn && queueMicrotask(() => feedbackPanel.syncAvailability(feedbackBtn));

initShortcuts({
  store,
  actions,
  player,
  commands: audioCommands,
  waveform,
  exportCurrent: () => toolbar.exportCurrent(),
  flushEdits,
  seekStep: () => waveform.seekStep(),
});

// ASS 样式预览开关联动
function syncAssPreview() {
  assPreview.setEnabled(store.state.assPreview && store.state.subtitleFormat === 'ass');
}
store.on('assPreview', syncAssPreview);
store.on('subtitleFormat', syncAssPreview);
store.on('mediaLoaded', () => assPreview.onMediaChanged());
store.on('cues', () => assPreview.requestRefresh());

// 空状态与离开提醒（关闭前先提交未落库的编辑并立刻保存草稿）
const stageEmpty = $('#stage-empty');
store.on('mediaLoaded', (s) => {
  stageEmpty.hidden = s.mediaLoaded;
});
window.addEventListener('beforeunload', (e) => {
  flushEdits();
  draft.saveNow();
  journal.flush();
  if (store.state.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// URL 加载：autoload 与 window.agent.loadMedia/loadSubs 共用的固化 fetch 路径（与打开文件同路）
async function loadFromUrl(url, open) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const name = decodeURIComponent(url.split('/').pop() || 'media');
  if (/\.(srt|vtt|ass|ssa)$/i.test(name)) {
    await open(new File([await res.text()], name, { type: 'text/plain' }));
  } else {
    await open(new File([await res.blob()], name));
  }
}

// 自动化测试/演示辅助：?media=<url>&subs=<url>&manifest=<url> 启动时直接加载
// （与打开文件同一路径）；manifest 为 review-manifest-v1，载入后标注 cue 出处。
async function autoloadFromQuery() {
  const q = new URLSearchParams(location.search);
  const media = q.get('media');
  const subs = q.get('subs');
  const manifestUrl = q.get('manifest');
  if (!media && !subs && !manifestUrl) return;
  try {
    if (media) await loadFromUrl(media, (f) => openMediaFileTracked(f));
    if (subs) await loadFromUrl(subs, (f) => toolbar.openSubtitleFile(f));
    if (manifestUrl) {
      const res = await fetch(manifestUrl);
      if (res.ok) {
        const manifest = await res.json();
        store.patch({ pipelineRun: { taskId: manifest.task_id ?? null, runId: manifest.run_id ?? null } });
        const { annotateProvenance } = await import('./ui/pipeline-panel.js');
        const matched = annotateProvenance(store.state.cues, manifest);
        if (matched) console.info(`[manifest] 已标注 ${matched} 条 cue 出处`);
      }
    }
  } catch (err) {
    console.warn('[autoload] 失败:', err);
  }
}
autoloadFromQuery();

// window.agent：版本化契约（见 js/agent-api.js 与 .smoke/agent-contract.baseline.json）；
// 调试句柄 __editor 保留（非契约，控制台排查用）
window.__editor = { store, actions, player, waveform, timing, audioCommands, assPreview, journal, panels };
window.agent = createAgentApi({
  store,
  actions,
  player,
  waveform,
  journal,
  loadMedia: (url) => loadFromUrl(url, (f) => openMediaFileTracked(f)),
  loadSubs: (url) => loadFromUrl(url, (f) => toolbar.openSubtitleFile(f)),
  saveDraft: () => draft.saveNow(true),
});
