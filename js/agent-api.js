// window.agent 版本化契约（v1）：Agent 在真实页面中观测与行动的唯一接口面。
// 设计依据：docs/开发文档 §4.4。字段路径冻结在 .smoke/agent-contract.baseline.json，
// 变更须同步更新 baseline 并说明。所有写操作经 act() 转发 actions 命名命令——
// 不绕过 store 直改，自动获得撤销栈/草稿/ASS 预览联动；批量自动化写操作应传
// coalesceKey 合并撤销步（人机同屏时撤销栈不被步进淹没）。
import { sortCues } from './format/cue.js';

export const AGENT_API_VERSION = 1;

// act() 允许转发的命令白名单（读依赖仅 getSnapshot/getPeaks，写全走 actions）
const ACT_ALLOW = new Set([
  'updateCueTimes',
  'updateCueTimesBulk',
  'insertRelativeTo',
  'nudge',
  'insertAtTime',
  'duplicateCues',
  'removeCues',
  'removeCue',
  'splitCue',
  'mergeWithNext',
  'updateCue',
  'updateCueStyle',
  'select',
  'selectAll',
  'selectNeighbour',
  'setEditing',
  'copyCues',
  'cutCues',
  'pasteCues',
  'undo',
  'redo',
  'markExported',
]);

// 这些命令的末参收 {coalesceKey}：act(opts.coalesceKey) 非空时透传
const COALESCE_ACTIONS = new Set(['updateCueTimes', 'updateCueTimesBulk', 'insertRelativeTo']);

// deps: {
//   store            中央状态（js/state.js）
//   actions          命名命令层（js/actions.js）
//   waveform         波形控制器（需暴露 getPeaksData(t0,t1)）
//   player           播放器（读当前时间）
//   loadMedia(url) / loadSubs(url)   固化的 fetch 加载路径（main.js 与 autoload 共用）
//   saveDraft()      显式草稿落盘（agent 命名空间）
//   journal          编辑日志（js/journal.js，可选）：快照暴露统计，getJournalText 只读导出；
//                    act() 执行期间事件 actor 自动标记为 agent（人机数据分流）
//   canvasFactory()  可注入（单测）；默认 document.createElement('canvas')
// }
export function createAgentApi(deps) {
  const { store, actions, waveform, player, loadMedia, loadSubs, saveDraft, journal, canvasFactory } = deps;

  function getSnapshot() {
    const s = store.state;
    const cues = sortCues(s.cues);
    return {
      version: AGENT_API_VERSION,
      media: {
        name: s.mediaName,
        loaded: !!s.mediaLoaded,
        duration: s.duration,
        currentTime: player?.getCurrentTime?.() ?? null,
        waveform: waveform?.getPeaksData ? 'available' : 'unavailable',
      },
      subtitle: {
        name: s.subtitleName,
        format: s.subtitleFormat,
        count: cues.length,
        dirty: !!s.dirty,
        savedAt: s.savedAt,
      },
      cues: cues.map((c, i) => ({
        index: i + 1,
        id: c.id,
        start: c.start,
        end: c.end,
        duration: Math.round((c.end - c.start) * 1000) / 1000,
        text: c.text,
      })),
      selection: { selectedId: s.selectedId, selectedIds: [...(s.selectedIds ?? [])] },
      history: {
        canUndo: !!actions.history.canUndo,
        canRedo: !!actions.history.canRedo,
        depth: actions.history.past.length, // Agent 批量写操作后核对 coalesce 生效
      },
      journal: journal
        ? journal.stats()
        : { enabled: false, events: 0, overflow: false },
    };
  }

  // [t0,t1] 内的单声道采样；超过 maxPoints 时按桶取 |峰值| 整数抽取，
  // 返回 {rate, start, end, duration, samples}（rate 为抽取后的有效采样率）。
  function getPeaks(t0 = 0, t1 = null, { maxPoints = 20000 } = {}) {
    const data = waveform?.getPeaksData?.(t0, t1);
    if (!data) return null;
    const { samples, rate, start, end, duration: dur } = data;
    const k = Math.max(1, Math.ceil(samples.length / maxPoints));
    if (k === 1) return { rate, start, end, duration: dur, samples };
    const out = new Float32Array(Math.ceil(samples.length / k));
    for (let i = 0; i < out.length; i++) {
      let m = 0;
      for (let j = i * k, e = Math.min(samples.length, j + k); j < e; j++) {
        const v = Math.abs(samples[j]);
        if (v > m) m = v;
      }
      out[i] = m;
    }
    return { rate: rate / k, start, end, duration: dur, samples: out };
  }

  // 渲染 [t0,t1] 波形 PNG（dataURL），标定元数据烧进图内角落：
  // 视觉模型只答判断题（"边界是否在波谷内"），标定丢失会退化为"猜"。
  function renderWaveform({ t0 = 0, t1 = null, pxPerSec = 100, width = 800, height = 160 } = {}) {
    const data = getPeaks(t0, t1, { maxPoints: 1e9 });
    if (!data) return null;
    const make = canvasFactory ?? ((w, h) => document.createElement('canvas'));
    const canvas = make(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, width, height);
    // 波形：每像素列取样本桶的 |峰值|
    const { rate, samples, start } = data;
    const mid = height / 2;
    const span = data.end - data.start;
    const samplesPerPx = (span * rate) / width;
    ctx.strokeStyle = '#7c9cff';
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const si = Math.max(0, Math.floor(x * samplesPerPx));
      const ei = Math.min(samples.length, Math.max(si + 1, Math.ceil((x + 1) * samplesPerPx)));
      let m = 0;
      for (let j = Math.max(0, si), e = Math.min(samples.length, ei); j < e; j++) {
        const v = Math.abs(samples[j]);
        if (v > m) m = v;
      }
      const h = Math.min(mid, m * mid);
      ctx.moveTo(x + 0.5, mid - h);
      ctx.lineTo(x + 0.5, mid + h);
    }
    ctx.stroke();
    // 标定水印（必须烧进 PNG，否则 Agent 转发图像时标定丢失）
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '11px monospace';
    const t0Text = `t0=${data.start.toFixed(3)}s t1=${data.end.toFixed(3)}s pxPerSec=${pxPerSec} rate=${rate.toFixed(1)}`;
    ctx.fillText(t0Text, 6, height - 6);
    return {
      dataUrl: canvas.toDataURL('image/png'),
      t0: data.start,
      t1: data.end,
      pxPerSec,
      width,
      height,
      calibration: t0Text,
    };
  }

  async function act(name, args, opts = {}) {
    if (!ACT_ALLOW.has(name)) {
      return { ok: false, error: `命令不在白名单：${name}` };
    }
    const fn = actions[name];
    if (typeof fn !== 'function') {
      return { ok: false, error: `actions 上不存在命令：${name}` };
    }
    const callArgs = [...(args ?? [])];
    if (opts.coalesceKey && COALESCE_ACTIONS.has(name)) {
      callArgs.push({ coalesceKey: opts.coalesceKey });
    }
    // 编辑日志的 actor 分流：Agent 会话期间的写操作不混入人工行为数据
    journal?.setActor?.('agent');
    try {
      const result = await fn(...callArgs);
      return { ok: true, result: result === undefined ? null : result };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    } finally {
      journal?.setActor?.('human');
    }
  }

  // 只读导出：当前文件的编辑日志 NDJSON（无事件时 null）
  function getJournalText() {
    return journal?.exportText?.() ?? null;
  }

  return {
    version: AGENT_API_VERSION,
    getSnapshot,
    getPeaks,
    renderWaveform,
    loadMedia,
    loadSubs,
    act,
    getJournalText,
    saveDraft,
  };
}
