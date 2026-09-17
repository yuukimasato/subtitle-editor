import test from 'node:test';
import assert from 'node:assert/strict';
import { applySpeakerExport } from '../js/format/speaker-export.js';
import { makeCue } from '../js/format/cue.js';
import { DEFAULT_ASS_FIELDS } from '../js/format/ass.js';

// 构造 ASS cue：meta.parts 与 fields 对齐，name 字段可指定
function assCue(text, name = '') {
  const cue = makeCue(1, 2, text, {
    meta: {
      fields: [...DEFAULT_ASS_FIELDS],
      parts: DEFAULT_ASS_FIELDS.map((f) => (f === 'name' ? name : f === 'text' ? text : f === 'start' ? '0:00:01.00' : f === 'end' ? '0:00:02.00' : f === 'style' ? 'Default' : '0')),
      startIdx: DEFAULT_ASS_FIELDS.indexOf('start'),
      endIdx: DEFAULT_FIELDS_IDX.end,
      textIdx: DEFAULT_FIELDS_IDX.text,
    },
  });
  return cue;
}

const DEFAULT_FIELDS_IDX = { end: DEFAULT_ASS_FIELDS.indexOf('end'), text: DEFAULT_ASS_FIELDS.indexOf('text') };

test('SRT/VTT 导出携带说话人：文本前缀原样保留', () => {
  const cues = [makeCue(1, 2, '[说话人A]我的天')];
  const out = applySpeakerExport(cues, { format: 'srt', include: true });
  assert.equal(out[0].text, '[说话人A]我的天'); // 无需变换时允许原样返回（不可变保证只在变换时相关）
});

test('SRT/VTT 导出携带说话人：ASS Name 字段补行首前缀（跨格式保持）', () => {
  const cue = assCue('大家好', '主持人');
  const out = applySpeakerExport([cue], { format: 'srt', include: true });
  assert.equal(out[0].text, '[主持人]大家好');
  assert.equal(cue.text, '大家好'); // 原数据不动
});

test('ASS 导出携带说话人：文本前缀写进 Name 字段，文本保持原样', () => {
  const cues = [assCue('[说话人A]我的天', '')];
  const out = applySpeakerExport(cues, { format: 'ass', include: true });
  const nameIdx = out[0].meta.fields.indexOf('name');
  assert.equal(out[0].meta.parts[nameIdx], '说话人A');
  assert.equal(out[0].text, '[说话人A]我的天');
});

test('ASS 导出携带说话人：无 meta 的纯 cue 靠文本前缀保持说话人', () => {
  const cues = [makeCue(1, 2, '[说话人A]我的天')];
  const out = applySpeakerExport(cues, { format: 'ass', include: true });
  assert.equal(out[0].text, '[说话人A]我的天'); // 文本前缀原样（序列化时作为可见文本保留）
  assert.equal(out[0].meta, undefined);
});

test('ASS 导出携带说话人：已有 Name 不被覆盖', () => {
  const cue = assCue('[说话人A]我的天', '原名');
  const out = applySpeakerExport([cue], { format: 'ass', include: true });
  const nameIdx = out[0].meta.fields.indexOf('name');
  assert.equal(out[0].meta.parts[nameIdx], '原名');
});

test('关闭开关：SRT/VTT 导出剥离文本前缀', () => {
  const cues = [makeCue(1, 2, '[主持人] 大家好'), makeCue(3, 4, '普通台词')];
  const out = applySpeakerExport(cues, { format: 'vtt', include: false });
  assert.equal(out[0].text, '大家好');
  assert.equal(out[1].text, '普通台词');
  assert.equal(cues[0].text, '[主持人] 大家好'); // 原数据不动
});

test('关闭开关：ASS 导出清空 Name 并剥离文本前缀', () => {
  const cue = assCue('[说话人A]我的天', '说话人A');
  const out = applySpeakerExport([cue], { format: 'ass', include: false });
  const nameIdx = out[0].meta.fields.indexOf('name');
  assert.equal(out[0].meta.parts[nameIdx], '');
  assert.equal(out[0].text, '我的天');
  const origNameIdx = cue.meta.fields.indexOf('name');
  assert.equal(cue.meta.parts[origNameIdx], '说话人A'); // 原数据不动
});

test('ASS meta 副本独立：修改导出副本不改原 parts 数组', () => {
  const cue = assCue('大家好', '主持人');
  const out = applySpeakerExport([cue], { format: 'ass', include: false });
  const nameIdx = cue.meta.fields.indexOf('name');
  assert.notEqual(out[0].meta.parts, cue.meta.parts); // parts 必须是副本
  assert.equal(out[0].meta.parts[nameIdx], '');
  assert.equal(cue.meta.parts[nameIdx], '主持人'); // 原 parts 不动
});

test('无说话人的普通台词在任何策略下内容不变', () => {
  const cues = [makeCue(1, 2, '普通台词')];
  assert.equal(applySpeakerExport(cues, { format: 'srt', include: true })[0].text, '普通台词');
  assert.equal(applySpeakerExport(cues, { format: 'ass', include: true })[0].text, '普通台词');
  assert.equal(applySpeakerExport(cues, { format: 'srt', include: false })[0].text, '普通台词');
});
