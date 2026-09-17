// cue 构造与排序约定。

// 说话人前缀约定：SRT/VTT 的 cue 文本以行首「[标签]」标注说话人（标签任意，如 说话人A / 主持人）。
// 表格在显示层拆分（cue.text 数据保持原样，导出/草稿/学习日志不受影响）。
// 标签长度上限防误伤正文里成对的中括号引用。
const SPEAKER_PREFIX_RE = /^[ \t]*\[([^\[\]]{1,64})\]\s*/;

// 拆出行首说话人前缀：'[说话人A]文本' → { speaker:'说话人A', prefix:'[说话人A]', body:'文本' }；
// 无前缀时 speaker/prefix 为 null/''。prefix 原样保留（含标签后的空格），拼回时不改变原格式。
export function splitSpeaker(text) {
  const s = String(text ?? '');
  const m = SPEAKER_PREFIX_RE.exec(s);
  return m
    ? { speaker: m[1], prefix: m[0], body: s.slice(m[0].length) }
    : { speaker: null, prefix: '', body: s };
}

// 编辑提交时拼回：正文若自带「[标签]」前缀则原样采用（视为改标说话人），否则沿用原前缀
export function joinSpeaker(originalText, editedBody) {
  const body = String(editedBody ?? '');
  if (SPEAKER_PREFIX_RE.test(body)) return body;
  return splitSpeaker(originalText).prefix + body;
}

let counter = 0;

export function makeCue(start, end, text, extra = {}) {
  counter += 1;
  return {
    id: `cue-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    start,
    end,
    text: String(text ?? ''),
    ...extra,
  };
}

// cues 恒按 start 稳定排序（同 start 按.end）
export function sortCues(cues) {
  return [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function findCueAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (t < cue.start) hi = mid - 1;
    else if (t >= cue.end) lo = mid + 1;
    else return cue;
  }
  return null;
}

export function indexAfter(cues, t) {
  // 第一个 start > t 的下标
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
