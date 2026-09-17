// 说话人跨格式导出策略（纯函数；绝不改动传入的 cue，全部返回副本）。
// 说话人的载体约定：SRT/VTT 为文本行首「[标签]」前缀；ASS 为 Dialogue 的 Name 字段
// （cue.meta.parts）。导出任何格式都尽量保留说话人：
//   include=true  —— SRT/VTT 目标：文本无前缀但 ASS Name 有说话人时补行首前缀；
//                    ASS 目标：Name 为空但文本有前缀时把标签写进 Name（文本不动）。
//   include=false —— 剥离说话人：SRT/VTT 去文本前缀；ASS 清 Name 并去文本前缀。
import { splitSpeaker } from './cue.js';

// ASS Name 字段取值；非 ASS cue（无 meta/parts）返回 null
function assNameOf(cue) {
  const idx = cue?.meta?.fields?.indexOf('name') ?? -1;
  if (!cue?.meta?.parts || idx < 0) return null;
  const name = String(cue.meta.parts[idx] ?? '').trim();
  return name || null;
}

function withAssName(cue, name) {
  const idx = cue?.meta?.fields?.indexOf('name') ?? -1;
  if (!cue?.meta?.parts || idx < 0) return cue;
  const meta = { ...cue.meta, parts: [...cue.meta.parts] };
  meta.parts[idx] = name;
  return { ...cue, meta };
}

// 生成导出用 cue 副本数组。format: 'srt' | 'vtt' | 'ass'；include: 是否携带说话人。
export function applySpeakerExport(cues, { format, include }) {
  const isAss = format === 'ass';
  return cues.map((cue) => {
    const { speaker, body } = splitSpeaker(cue.text);
    if (include) {
      if (isAss) {
        return !assNameOf(cue) && speaker ? withAssName(cue, speaker) : cue;
      }
      if (!speaker) {
        const name = assNameOf(cue);
        if (name) return { ...cue, text: `[${name}]${cue.text}` };
      }
      return cue;
    }
    if (isAss) {
      const cleared = assNameOf(cue) ? withAssName(cue, '') : cue;
      return speaker ? { ...cleared, text: body } : cleared;
    }
    return speaker ? { ...cue, text: body } : cue;
  });
}
