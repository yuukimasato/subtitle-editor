import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAssTags, joinAssTags } from '../js/format/ass.js';

test('拆出行首覆盖标签段（特效标签 + 定位标签）', () => {
  const { tags, body } = splitAssTags(
    '{\\c&H34F9F7&\\frz2.866\\frx12\\fry358\\fscx102\\fscy78\\pos(956.571,1065.429)}空野你醒啦？',
  );
  assert.equal(tags, '{\\c&H34F9F7&\\frz2.866\\frx12\\fry358\\fscx102\\fscy78\\pos(956.571,1065.429)}');
  assert.equal(body, '空野你醒啦？');
});

test('连续多个标签块整体视为一段前缀', () => {
  const split = splitAssTags('{\\i1}{\\b1}粗斜体');
  assert.equal(split.tags, '{\\i1}{\\b1}');
  assert.equal(split.body, '粗斜体');
});

test('无行首标签：tags 为空，正文原样返回', () => {
  assert.deepEqual(splitAssTags('普通台词'), { tags: '', body: '普通台词' });
});

test('句中标签不属于行首段：显示层不动它', () => {
  const split = splitAssTags('前半{\\fscx80}后半');
  assert.equal(split.tags, '');
  assert.equal(split.body, '前半{\\fscx80}后半');
});

test('换行后的标签不属于行首段（\\N 已是真实换行）', () => {
  const split = splitAssTags('第一行\\N{\\i1}第二行'.replace('\\N', '\n'));
  assert.equal(split.tags, '');
  assert.equal(split.body, '第一行\n{\\i1}第二行');
});

test('空文本与 null 安全', () => {
  assert.deepEqual(splitAssTags(''), { tags: '', body: '' });
  assert.deepEqual(splitAssTags(null), { tags: '', body: '' });
});

test('拼回：沿用原标签段，数据往返无损', () => {
  const original = '{\\pos(956,1065)}空野你醒啦？';
  assert.equal(joinAssTags(original, '空野你醒啦？'), original);
  // 正文未变时拼回结果与原文一致，不产生多余的历史记录
  assert.equal(joinAssTags(original, '空野你醒啦'), '{\\pos(956,1065)}空野你醒啦');
});

test('拼回：正文自带标签段时原样采用（视为改写标签）', () => {
  assert.equal(joinAssTags('{\\pos(1,2)}台词', '{\\pos(3,4)}新台词'), '{\\pos(3,4)}新台词');
});

test('拼回：原文无标签时不产生多余前缀', () => {
  assert.equal(joinAssTags('台词', '新台词'), '新台词');
});

test('标签段必须紧跟行首：句中标签拼回时不添加前缀', () => {
  const split = splitAssTags('你好{\\pos(1,2)}世界');
  assert.equal(split.tags, '');
  // 原文行首无标签段 → 拼回不添加任何前缀
  assert.equal(joinAssTags('你好{\\pos(1,2)}世界', '你好世界'), '你好世界');
});

test('与说话人前缀叠加：先拆说话人再拆标签（cue-list 的管线顺序）', () => {
  const text = '[空野]{\\pos(956,1065)}空野你醒啦？';
  const noSpeaker = text.replace('[空野]', '');
  const { tags, body } = splitAssTags(noSpeaker);
  assert.equal(tags, '{\\pos(956,1065)}');
  assert.equal(body, '空野你醒啦？');
  assert.equal(joinAssTags(noSpeaker, body), noSpeaker);
});
