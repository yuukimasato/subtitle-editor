import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/state.js';
import { createSubtitleSync } from '../js/sync.js';
import { makeCue } from '../js/format/cue.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 每个 test 独立 store，避免 cues 订阅定时器跨用例串扰
function makeStore() {
  const store = createStore();
  store.patch({
    cues: [makeCue(1, 2, '[说话人A]我的天')],
    subtitleName: 'sample.srt',
    mediaName: 'sample.wav',
    subtitleFormat: 'srt',
    dirty: true,
  });
  return store;
}

function makeSync(store, { posts, gate = null, includeSpeakers } = {}) {
  return createSubtitleSync(store, {
    delay: 5,
    serialize: (cues) => cues.map((c) => c.text).join('\n'),
    post: async (payload) => {
      posts.push(payload);
      if (gate) await gate;
      return { ok: true };
    },
    ...(includeSpeakers !== undefined ? { includeSpeakers } : {}),
  });
}

test('flush 上送载荷：含名称/格式/内容/行数/说话人开关', async () => {
  const store = makeStore();
  const posts = [];
  const sync = makeSync(store, { posts });
  store.patch({ cues: [makeCue(1, 2, '[说话人A]改过的台词')] });
  const result = await sync.flush();
  assert.equal(result.status, 'synced');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].name, 'sample.srt');
  assert.equal(posts[0].format, 'srt');
  assert.equal(posts[0].content, '[说话人A]改过的台词');
  assert.equal(posts[0].cue_count, 1);
  assert.equal(posts[0].include_speakers, true);
  assert.ok(posts[0].updated_at);
});

test('cues 变更经防抖自动上送', async () => {
  const store = makeStore();
  const posts = [];
  makeSync(store, { posts });
  store.patch({ cues: [makeCue(1, 2, '自动上送的一稿')] });
  await sleep(30);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].content, '自动上送的一稿');
});

test('includeSpeakers=false 时同步稿剥离说话人前缀', async () => {
  const store = makeStore();
  const posts = [];
  const sync = makeSync(store, { posts, includeSpeakers: () => false });
  await sync.flush();
  const payload = posts.at(-1);
  assert.equal(payload.include_speakers, false);
  assert.equal(payload.content, '我的天');
});

test('空表或无文件身份时不上送', async () => {
  const store = createStore();
  store.patch({ cues: [], subtitleName: '', mediaName: '' });
  const posts = [];
  const sync = makeSync(store, { posts });
  const result = await sync.flush();
  assert.equal(result.status, 'empty');
  assert.equal(posts.length, 0);
});

test('agent 会话不同步', async () => {
  const store = makeStore();
  const posts = [];
  const sync = createSubtitleSync(store, {
    agentMode: true,
    delay: 5,
    serialize: (cues) => cues.map((c) => c.text).join('\n'),
    post: async (payload) => posts.push(payload),
  });
  const result = await sync.flush();
  assert.equal(result.status, 'disabled');
  assert.equal(posts.length, 0);
});

test('失败后进入退避：退避窗口内的 flush 不再发起请求', async () => {
  const store = makeStore();
  const posts = [];
  let failNext = 1;
  const sync = createSubtitleSync(store, {
    delay: 5,
    serialize: (cues) => cues.map((c) => c.text).join('\n'),
    post: async (payload) => {
      posts.push(payload);
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('boom');
      }
      return { ok: true };
    },
  });
  const first = await sync.flush();
  assert.equal(first.status, 'error');
  assert.equal(posts.length, 1);
  const second = await sync.flush();
  assert.equal(second.status, 'offline');
  assert.equal(posts.length, 1); // 退避期内未重试
});

test('上送进行中的新改动会在完成后补送一次', async () => {
  const store = makeStore();
  const posts = [];
  let release = () => {};
  let gated = false;
  const sync = createSubtitleSync(store, {
    delay: 5,
    serialize: (cues) => cues.map((c) => c.text).join('\n'),
    post: async (payload) => {
      posts.push(payload);
      if (gated) await new Promise((resolve) => { release = resolve; });
      return { ok: true };
    },
  });
  await sync.flush(); // 排空装载引发的首送
  assert.equal(posts.length, 1);

  gated = true; // 首次上送挂起期间发生第二次编辑
  const inFlight = sync.flush();
  store.patch({ cues: [makeCue(1, 2, '第二次改动')] }); // → schedule → syncNow 发现 busy → 记 rerun
  await sleep(20);
  release();
  await inFlight;
  await sleep(30);
  assert.equal(posts.length, 3);
  assert.equal(posts.at(-1).content, '第二次改动');
});
