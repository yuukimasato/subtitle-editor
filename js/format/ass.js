// ASS/SSA 骨架式解析与序列化。
// 原则：非 Dialogue 行原样保留；Dialogue 只重写 时间与文本 字段，
// {\...} 标签在文本中原样保留；\N / \n 与换行双向转换。
import { ParseError, parseTimestamp, formatAssTime } from './time.js';
import { makeCue, sortCues } from './cue.js';

export const DEFAULT_ASS_FIELDS = [
  'layer', 'start', 'end', 'style', 'name',
  'marginl', 'marginr', 'marginv', 'effect', 'text',
];

const MINIMAL_HEADER = [
  '[Script Info]',
  '; Exported by Subtitle Timing Editor',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];

function dialoguePrefix(line) {
  const m = /^\s*Dialogue:\s?/i.exec(line);
  return m ? line.slice(m[0].length) : null;
}

// 按逗号分割且保留最后一段中的逗号（JS split 的 limit 会截断丢弃，不能直接用）
function splitWithRest(body, count) {
  const parts = body.split(',');
  if (parts.length <= count) return parts;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(',')];
}

// ASS 文本 ↔ cue 文本：\N 为硬换行（→ 实际换行），\n 为软换行（→ U+2028 占位），
// 两者语义不同，不能在解析时合并；写回时逆向还原并清理 CR。
function assTextToCueText(s) {
  return String(s).replace(/\\N/g, '\n').replace(/\\n/g, '\u2028');
}

function cueTextToAssText(s) {
  return String(s ?? '').replace(/\r/g, '').replace(/\n/g, '\\N').replace(/\u2028/g, '\\n');
}

// 行首连续覆盖标签段（{\c&H..&\pos(..)}台词 → 标签段 + 台词）。
// 只认行首一整段：句中标签（如逐字卡拉OK）位置与正文耦合，显示层不动它。
const LEADING_ASS_TAGS_RE = /^(?:\{[^{}]*\})+/;

// 拆出行首覆盖标签段，供表格显示纯文本（cue.text 数据保持原样，导出/渲染不受影响）
export function splitAssTags(text) {
  const s = String(text ?? '');
  const m = LEADING_ASS_TAGS_RE.exec(s);
  return m ? { tags: m[0], body: s.slice(m[0].length) } : { tags: '', body: s };
}

// 编辑提交时拼回：正文若自带标签段则原样采用（视为改写标签），否则沿用原标签段
export function joinAssTags(originalText, editedBody) {
  const body = String(editedBody ?? '');
  if (LEADING_ASS_TAGS_RE.test(body)) return body;
  return splitAssTags(originalText).tags + body;
}

// 用 cue 的当前时间/文本重写字段值（fields 为字段名数组，返回原数组便于链式）
function applyCueParts(parts, fields, cue) {
  parts[fields.indexOf('start')] = formatAssTime(cue.start);
  parts[fields.indexOf('end')] = formatAssTime(cue.end);
  parts[fields.indexOf('text')] = cueTextToAssText(cue.text);
  return parts;
}

export function parseAss(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  // 文件末尾换行产生的空行不进入骨架：它会被当作 raw 行原样写回，而
  // serializeAss 结尾还会再补一个 '\n'，反复打开/保存会让尾部空行不断累积
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const docLines = [];
  const cues = [];
  let section = '';
  let fields = null;
  let sawEvents = false;
  let lastEventsLen = 0;
  const styles = []; // [V4+ Styles] 段的样式名（按出现顺序）
  let styleFields = null;

  lines.forEach((line) => {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      // 宽容匹配：[Events] / [V4+ Events] / [V4 Events] 等变体
      if (section.includes('event')) {
        section = 'events';
        sawEvents = true;
      } else if (section.includes('style')) {
        section = 'styles';
      }
      docLines.push({ t: 'raw', s: line });
      if (section === 'events') lastEventsLen = docLines.length;
      return;
    }
    if (section === 'styles') {
      if (/^\s*Format\s*:/i.test(line)) {
        styleFields = line.replace(/^\s*Format\s*:/i, '').split(',').map((s) => s.trim().toLowerCase());
      } else if (/^\s*Style\s*:/i.test(line)) {
        const parts = line.replace(/^\s*Style\s*:/i, '').split(',');
        const nameIdx = styleFields ? styleFields.indexOf('name') : 0;
        const name = (parts[nameIdx >= 0 ? nameIdx : 0] ?? '').trim();
        if (name) styles.push(name);
      }
      docLines.push({ t: 'raw', s: line });
      return;
    }
    if (section === 'events' && /^\s*Format\s*:/i.test(line)) {
      fields = line.replace(/^\s*Format\s*:/i, '').split(',').map((s) => s.trim().toLowerCase());
      docLines.push({ t: 'raw', s: line });
      lastEventsLen = docLines.length;
      return;
    }
    // Dialogue 宽容解析：Aegisub 复制出的剪贴板只有裸 Dialogue 行（无 [Events] 段头）
    const body = dialoguePrefix(line);
    if (body !== null) {
      const fmt = fields ?? DEFAULT_ASS_FIELDS;
      const startIdx = fmt.indexOf('start');
      const endIdx = fmt.indexOf('end');
      const textIdx = fmt.indexOf('text');
      // 最后一段为 Text，允许其中包含逗号
      const parts = splitWithRest(body, fmt.length);
      const maxIdx = Math.max(startIdx, endIdx, textIdx);
      const usable = startIdx >= 0 && endIdx >= 0 && textIdx >= 0 && parts.length >= maxIdx + 1;
      if (!usable) {
        docLines.push({ t: 'raw', s: line });
      } else {
        const start = parseTimestamp(parts[startIdx]);
        const end = parseTimestamp(parts[endIdx]);
        if (start === null || end === null) {
          throw new ParseError(`ASS：无效的 Dialogue 时间 "${parts[startIdx]}" / "${parts[endIdx]}"`);
        }
        if (end < start) {
          throw new ParseError(`ASS：Dialogue 结束时间早于开始时间`);
        }
        const cue = makeCue(start, end, assTextToCueText(parts[textIdx]), {
          meta: { fields: fmt, parts, startIdx, endIdx, textIdx },
        });
        cues.push(cue);
        docLines.push({ t: 'dlg', id: cue.id });
      }
      lastEventsLen = docLines.length;
      return;
    }
    docLines.push({ t: 'raw', s: line });
    // Events 段内的普通 raw 行（如 Comment:）同样推进段末位置，保证新增 cue 插在这些行之后
    if (section === 'events') lastEventsLen = docLines.length;
  });

  const doc = {
    lines: docLines,
    fields,
    appendAt: lastEventsLen || docLines.length,
    styles,
    defaultStyle: styles[0] ?? 'Default',
  };
  return { cues, doc };
}

// 从 SRT/VTT 等“纯 cue”来源导出 ASS 时，构造最小合法骨架
export function buildAssDoc(cues) {
  const fields = DEFAULT_ASS_FIELDS;
  const lines = MINIMAL_HEADER.map((s) => ({ t: 'raw', s }));
  cues.forEach((cue) => lines.push({ t: 'dlg', id: cue.id }));
  return { lines, fields, appendAt: lines.length, styles: ['Default'], defaultStyle: 'Default' };
}

function defaultPart(field, cue) {
  switch (field) {
    case 'start': return formatAssTime(cue.start);
    case 'end': return formatAssTime(cue.end);
    case 'text': return cueTextToAssText(cue.text);
    case 'layer': return '0';
    case 'style': return 'Default';
    case 'marginl':
    case 'marginr':
    case 'marginv': return '0';
    case 'name':
    case 'effect': return '';
    default: return '';
  }
}

export function serializeAss(cues, doc) {
  const lines = doc?.lines ?? buildAssDoc(cues).lines;
  const fmt = doc?.fields ?? DEFAULT_ASS_FIELDS;
  const byId = new Map(cues.map((c) => [c.id, c]));
  const out = [];
  let insertAt = out.length;
  let sawAppendPoint = false;

  lines.forEach((entry, i) => {
    if (!sawAppendPoint && i >= (doc?.appendAt ?? lines.length)) {
      sawAppendPoint = true;
      insertAt = out.length;
    }
    if (entry.t === 'raw') {
      out.push(entry.s);
      return;
    }
    const cue = byId.get(entry.id);
    if (!cue) return; // 已删除：整行移除
    // meta 缺失时按文档字段序兜底；parts 缺失时按字段构造默认值
    const meta = cue.meta ?? { fields: fmt, startIdx: fmt.indexOf('start'), endIdx: fmt.indexOf('end'), textIdx: fmt.indexOf('text') };
    const fieldsFor = meta.fields ?? fmt;
    const parts = applyCueParts(
      meta.parts ? [...meta.parts] : defaultPartsFor(fieldsFor, cue, doc?.defaultStyle),
      fieldsFor,
      cue,
    );
    out.push(`Dialogue: ${parts.join(',')}`);
  });
  if (!sawAppendPoint) insertAt = out.length;

  // 新增（骨架中不存在）的 cue：按时间序插入到 Events 段末尾
  const known = new Set(lines.filter((e) => e.t === 'dlg').map((e) => e.id));
  const fresh = sortCues(cues.filter((c) => !known.has(c.id)));
  const freshLines = fresh.map((cue) => {
    const fieldsFor = cue.meta?.fields ?? fmt;
    const parts = applyCueParts(
      cue.meta?.parts ? [...cue.meta.parts] : defaultPartsFor(fieldsFor, cue, doc?.defaultStyle),
      fieldsFor,
      cue,
    );
    return `Dialogue: ${parts.join(',')}`;
  });
  out.splice(insertAt, 0, ...freshLines);
  return out.join('\n') + '\n';
}

function defaultPartsFor(fields, cue, defaultStyle) {
  const parts = fields.map((field) => defaultPart(field, cue));
  const styleIdx = fields.indexOf('style');
  if (defaultStyle && styleIdx >= 0) parts[styleIdx] = defaultStyle;
  return parts;
}

// 为“新建 cue”生成 ASS 元数据（其余格式为空）；defaultStyle 取文档首个样式
export function makeAssMeta(fields, cue, defaultStyle) {
  const fmt = fields ?? DEFAULT_ASS_FIELDS;
  const meta = {
    fields: fmt,
    parts: defaultPartsFor(fmt, cue, defaultStyle),
    startIdx: fmt.indexOf('start'),
    endIdx: fmt.indexOf('end'),
    textIdx: fmt.indexOf('text'),
  };
  return meta;
}
