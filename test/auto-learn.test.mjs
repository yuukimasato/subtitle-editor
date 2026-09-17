// 自动学习开关（工单 07 / 定案 D24）测试：设置持久化两态（localStorage，默认关）、
// 导出触发开关分流、8613 离线一次性提示、上送失败仅 notify 不抛错（导出绝不受影响）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_LEARN_KEY,
  isAutoLearnEnabled,
  setAutoLearnEnabled,
  createAutoLearnTrigger,
} from '../js/auto-learn.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function brokenStorage() {
  return {
    getItem() { throw new Error('quota'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('quota'); },
  };
}

// ---------- 设置项持久化（开关两态） ----------

test('设置键名清晰且默认关：未设置/存储不可用时均为关', () => {
  assert.equal(AUTO_LEARN_KEY, 'vstEditor.autoLearn');
  assert.equal(isAutoLearnEnabled(fakeStorage()), false);
  assert.equal(isAutoLearnEnabled(brokenStorage()), false);
  assert.equal(isAutoLearnEnabled(null), false); // 无存储环境（如 node 单测）默认关
});

test('开关两态：开启持久化为 1，关闭持久化为 0，可跨实例读取', () => {
  const storage = fakeStorage();
  setAutoLearnEnabled(true, storage);
  assert.equal(storage.getItem(AUTO_LEARN_KEY), '1');
  assert.equal(isAutoLearnEnabled(storage), true); // 同一存储的新读方（如重开的设置面板）
  setAutoLearnEnabled(false, storage);
  assert.equal(storage.getItem(AUTO_LEARN_KEY), '0');
  assert.equal(isAutoLearnEnabled(storage), false);
});

test('存储不可用时写操作不抛错（仅本次会话生效）', () => {
  assert.doesNotThrow(() => setAutoLearnEnabled(true, brokenStorage()));
});

// ---------- 导出触发分流 ----------

function makeTrigger({ storage, detect = async () => ({ ok: true }), runLearn, notify } = {}) {
  return createAutoLearnTrigger({
    storage,
    detect,
    runLearn: runLearn ?? (async () => ({ result: { status: 'ok' }, journalNote: '' })),
    notify: notify ?? (() => {}),
  });
}

test('开关关：导出回调直接短路——不探测、不上送、不打扰（导出行为与现状一致）', async () => {
  let detectCalls = 0;
  let learnCalls = 0;
  const notifyCalls = [];
  const trigger = makeTrigger({
    storage: fakeStorage({ [AUTO_LEARN_KEY]: '0' }),
    detect: async () => { detectCalls += 1; return { ok: true }; },
    runLearn: async () => { learnCalls += 1; return { result: { status: 'ok' } }; },
    notify: (...args) => notifyCalls.push(args),
  });

  const outcome = await trigger.afterExport();

  assert.deepEqual(outcome, { status: 'disabled' });
  assert.equal(detectCalls, 0);
  assert.equal(learnCalls, 0);
  assert.deepEqual(notifyCalls, []);
});

test('开关开 + 在线：执行学习一次，成功消息携带日志上送备注', async () => {
  let learnCalls = 0;
  const notifyCalls = [];
  const trigger = makeTrigger({
    storage: fakeStorage({ [AUTO_LEARN_KEY]: '1' }),
    runLearn: async () => {
      learnCalls += 1;
      return { result: { status: 'ok' }, journalNote: '，日志已上送（接收 3 条）' };
    },
    notify: (...args) => notifyCalls.push(args),
  });

  const outcome = await trigger.afterExport();

  assert.equal(outcome.status, 'learned');
  assert.equal(learnCalls, 1);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0][0], '自动学习完成，日志已上送（接收 3 条）');
  assert.equal(notifyCalls[0].length, 1); // 成功 toast 不带 error 类型
});

// ---------- 8613 离线：一次性提示 ----------

test('离线分支：跳过学习并提示一次，同会话内再次导出不再打扰', async () => {
  let learnCalls = 0;
  const notifyCalls = [];
  const trigger = makeTrigger({
    storage: fakeStorage({ [AUTO_LEARN_KEY]: '1' }),
    detect: async () => ({ ok: false, error: 'fetch 失败' }),
    runLearn: async () => { learnCalls += 1; return { result: { status: 'ok' } }; },
    notify: (...args) => notifyCalls.push(args),
  });

  const first = await trigger.afterExport();
  const second = await trigger.afterExport();

  assert.equal(first.status, 'offline');
  assert.equal(second.status, 'offline');
  assert.equal(learnCalls, 0); // 离线不发学习请求
  assert.equal(notifyCalls.length, 1); // 一次性提示
  const [message, type] = notifyCalls[0];
  assert.match(message, /未检测到管线服务（fetch 失败）.*跳过自动学习.*导出文件不受影响/);
  assert.equal(type, 'error');
});

test('探测本身抛错按离线处理（导出流程不受影响）', async () => {
  const notifyCalls = [];
  const trigger = makeTrigger({
    storage: fakeStorage({ [AUTO_LEARN_KEY]: '1' }),
    detect: async () => { throw new TypeError('Failed to fetch'); },
    notify: (...args) => notifyCalls.push(args),
  });

  const outcome = await trigger.afterExport();

  assert.equal(outcome.status, 'offline');
  assert.match(notifyCalls[0][0], /Failed to fetch/);
});

// ---------- 上送失败：仅 notify，绝不抛错 ----------

test('在线但学习失败：notify 错误详情，afterExport 不抛（fire-and-forget 安全）', async () => {
  const notifyCalls = [];
  const trigger = makeTrigger({
    storage: fakeStorage({ [AUTO_LEARN_KEY]: '1' }),
    runLearn: async () => { throw new Error('HTTP 500'); },
    notify: (...args) => notifyCalls.push(args),
  });

  const outcome = await trigger.afterExport();

  assert.deepEqual(outcome, { status: 'error', error: 'HTTP 500' });
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0][0], '自动学习失败：HTTP 500');
  assert.equal(notifyCalls[0][1], 'error');
});

test('服务端未写入（status 非 ok）：notify 未写入原因', async () => {
  const notifyCalls = [];
  const trigger = makeTrigger({
    storage: fakeStorage({ [AUTO_LEARN_KEY]: '1' }),
    runLearn: async () => ({ result: { status: 'skipped', message: '对齐率过低' } }),
    notify: (...args) => notifyCalls.push(args),
  });

  const outcome = await trigger.afterExport();

  assert.equal(outcome.status, 'learned');
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0][0], '自动学习未写入：对齐率过低');
  assert.equal(notifyCalls[0][1], 'error');
});

// D28 冷重跑（工单 08 联动）：V3/V4 自动学习返回异步任务标识而非报告——不算失败
test('异步学习任务 envelope：notify 任务标识，返回 submitted 而非错误', async () => {
  const notifyCalls = [];
  const trigger = makeTrigger({
    storage: fakeStorage({ [AUTO_LEARN_KEY]: '1' }),
    runLearn: async () => ({
      result: { task_id: 't-learn-9', status: 'pending', task_type: 'learn', scenario: 'from-scratch-timing' },
      journalNote: '，日志已上送（接收 2 条）',
    }),
    notify: (...args) => notifyCalls.push(args),
  });

  const outcome = await trigger.afterExport();

  assert.equal(outcome.status, 'submitted');
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0][0], /已提交异步学习任务 t-learn-9/);
  assert.equal(notifyCalls[0].length, 1); // 非 error 级提示
});
