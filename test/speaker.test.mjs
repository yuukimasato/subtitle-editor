import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSpeaker, joinSpeaker } from '../js/format/cue.js';

test('拆出行首说话人前缀（无空格形态）', () => {
  const { speaker, body } = splitSpeaker('[说话人A]我的天,总算上来了');
  assert.equal(speaker, '说话人A');
  assert.equal(body, '我的天,总算上来了');
});

test('拆出说话人前缀并保留标签后的空格', () => {
  const split = splitSpeaker('[主持人] 大家好');
  assert.equal(split.speaker, '主持人');
  assert.equal(split.body, '大家好');
  assert.equal(split.prefix, '[主持人] ');
});

test('无前缀文本：speaker 为 null，正文原样返回', () => {
  const split = splitSpeaker('普通台词');
  assert.equal(split.speaker, null);
  assert.equal(split.prefix, '');
  assert.equal(split.body, '普通台词');
});

test('前缀必须紧跟行首：句中括号不算说话人', () => {
  assert.equal(splitSpeaker('你好[音乐]世界').speaker, null);
});

test('空文本与 null 安全', () => {
  assert.deepEqual(splitSpeaker(''), { speaker: null, prefix: '', body: '' });
  assert.deepEqual(splitSpeaker(null), { speaker: null, prefix: '', body: '' });
});

test('拼回：沿用原前缀，数据往返无损', () => {
  const original = '[说话人A]我的天';
  assert.equal(joinSpeaker(original, '我的天,总算上来了'), '[说话人A]我的天,总算上来了');
  // 正文未变时拼回结果与原文一致，不产生多余的历史记录
  assert.equal(joinSpeaker(original, '我的天'), original);
});

test('拼回：正文自带新前缀时原样采用（视为改标说话人）', () => {
  assert.equal(joinSpeaker('[说话人A]旧文本', '[说话人B]新文本'), '[说话人B]新文本');
});

test('拼回：无前缀 cue 保持无前缀', () => {
  assert.equal(joinSpeaker('普通台词', '改后的台词'), '改后的台词');
});
