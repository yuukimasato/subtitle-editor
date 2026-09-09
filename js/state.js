// 中央状态 + 发布订阅。高频播放进度不走这里（由 player 的 rAF 直接分发）。
import { findCueAt } from './format/cue.js';

export function createStore() {
  const state = {
    cues: [],
    selectedId: null, // 锚点行(最后一个单击选中的行)
    selectedIds: [], // 多选行(按 cue 顺序)
    editingId: null,
    duration: 0,
    fps: 25,
    rate: 1,
    follow: true,
    loopCue: false,
    previewOn: true,
    assPreview: true, // 加载 ASS 时是否启用样式预览（可开关）
    mediaName: '',
    subtitleName: '',
    subtitleFormat: '',
    subDoc: null,
    dirty: false,
    savedAt: 0, // 最近一次草稿自动保存时间戳
    mediaLoaded: false,
    pipelineRun: null, // { taskId, runId }：管线面板载入产物后记录（journal header 关联）
    // 音频盒选项（默认值对齐 Aegisub 3.2）
    audioOptions: {
      autoCommit: false, // Audio/Auto/Commit：改动立即写入（撤销合并）
      autoNext: true, // Audio/Next Line on Commit：提交后转至下一行
      autoScroll: true, // Audio/Auto/Scroll：换行时滚动视图；点击释放在边缘时滚屏
      snap: false, // Audio/Snap/Enable：拖动时吸附其他行边界（10px）
      dragTiming: true, // Audio/Drag Timing：扫选拖结束标记；关闭则拖开始标记
      inactiveMode: 1, // Audio/Inactive Lines Display Mode：0 无 1 上一行 2 前后各一行 3 全部
      vZoom: 50, // Audio/Zoom/Vertical（纵向振幅，经渲染高度体现）
      vLink: true, // Audio/Link：纵向缩放与音量联动
    },
  };
  const listeners = new Map();

  const store = {
    state,
    on(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key).delete(fn);
    },
    emit(key) {
      (listeners.get(key) ?? new Set()).forEach((fn) => fn(state));
    },
    patch(props) {
      Object.assign(state, props);
      Object.keys(props).forEach((k) => store.emit(k));
    },
    selectedCue() {
      return state.cues.find((c) => c.id === state.selectedId) ?? null;
    },
    cueAt(t) {
      return findCueAt(state.cues, t);
    },
  };
  return store;
}
