// 学习历史（js/learn-history.js，工单 08 / 定案 D29）：学习面板「历史」折叠区的数据侧
// 纯逻辑——learn 类型过滤、最近 N 条记录选取、记录摘要（场景/时间/覆盖率/参数调整）、
// 进行中任务进度文案、8613 治理视图深链 URL，以及 js/pipeline.js 三个既有路由客户端
// 方法的 URL 装配。UI 装配（feedback-panel）不在此测——本文件断言的摘要字段即渲染输入。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeLearnTasks,
  describeLearnRecord,
  filterLearnTasks,
  formatLearnTime,
  governanceUrl,
  isLearnTaskEnvelope,
  learnProgressLabel,
  recentLearnRecords,
  RECENT_LEARN_LIMIT,
} from '../js/learn-history.js';
import { createPipelineClient } from '../js/pipeline.js';

// ---------- 假件 ----------

// 模拟 GET /api/history 的混列记录：普通任务 task_type 为空串，学习任务为 "learn"
function historyFixture() {
  return [
    { task_id: 't-normal-1', task_type: '', scenario: '', status: 'completed',
      created_at: '2026-09-10T12:00:00Z', completed_at: '2026-09-10T12:05:00Z' },
    { task_id: 't-learn-1', task_type: 'learn', scenario: 'inline-review', status: 'completed',
      created_at: '2026-09-09T08:00:00Z', completed_at: '2026-09-09T08:01:00Z' },
    { task_id: 't-learn-2', task_type: 'learn', scenario: 'existing-subtitle', status: 'completed',
      created_at: '2026-09-10T09:00:00Z', completed_at: '2026-09-10T09:03:00Z' },
    { task_id: 't-learn-3', task_type: 'learn', scenario: 'from-scratch-timing', status: 'failed',
      created_at: '2026-09-10T10:00:00Z', completed_at: null },
    { task_id: 't-normal-2', task_type: '', scenario: '', status: 'completed',
      created_at: '2026-09-10T11:00:00Z', completed_at: '2026-09-10T11:02:00Z' },
    { task_id: 't-learn-4', task_type: 'learn', scenario: 'inline-review', status: 'completed',
      created_at: '2026-09-08T07:00:00Z', completed_at: '2026-09-08T07:02:00Z' },
  ];
}

// 模拟 GET /api/tasks 的内存任务列表：含进行中的异步学习任务（D28 冷重跑）
function tasksFixture() {
  return [
    { task_id: 't-run-1', task_type: '', scenario: '', status: 'running' },
    { task_id: 't-learn-run', task_type: 'learn', scenario: 'existing-subtitle', status: 'running' },
    { task_id: 't-learn-queue', task_type: 'learn', scenario: 'from-scratch-timing', status: 'pending' },
    { task_id: 't-learn-done', task_type: 'learn', scenario: 'inline-review', status: 'completed' },
    { task_id: 't-learn-fail', task_type: 'learn', scenario: 'inline-review', status: 'failed' },
  ];
}

function captureFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

// ---------- 过滤 learn 类型 ----------

test('过滤 learn 类型：普通任务（task_type 空串）不进历史区', () => {
  const learned = filterLearnTasks(historyFixture());
  assert.deepEqual(learned.map((t) => t.task_id), ['t-learn-1', 't-learn-2', 't-learn-3', 't-learn-4']);
});

test('进行中的学习任务：只取 pending/running 的 learn 任务，终态排除', () => {
  const active = activeLearnTasks(tasksFixture());
  assert.deepEqual(active.map((t) => t.task_id), ['t-learn-run', 't-learn-queue']);
});

// ---------- 最近 N 条学习记录（历史列表渲染的数据侧） ----------

test('最近 N 条学习记录：按时间倒序、截取 RECENT_LEARN_LIMIT(5) 条、混列任务被过滤', () => {
  const records = recentLearnRecords(historyFixture());
  assert.equal(records.length, 4); // 混列里只有 4 条 learn，不足 5 条全保留
  assert.equal(records[0].task_id, 't-learn-3'); // 无 completed_at 时回退 created_at 排序
  assert.equal(records[1].task_id, 't-learn-2');
  assert.equal(records[3].task_id, 't-learn-4'); // 最旧的排最后
});

test('最近 N 条学习记录：超过 limit 时只保留最新 N 条', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    task_id: `t-learn-${i}`,
    task_type: 'learn',
    scenario: 'inline-review',
    status: 'completed',
    created_at: `2026-09-0${i + 1}T00:00:00Z`,
    completed_at: `2026-09-0${i + 1}T01:00:00Z`,
  }));
  const records = recentLearnRecords(many, RECENT_LEARN_LIMIT);
  assert.equal(records.length, 5);
  assert.equal(records[0].task_id, 't-learn-8'); // 最新在前
});

// ---------- 空态 ----------

test('空态：空历史 / 无 learn 记录 / 非数组输入都得到空列表', () => {
  assert.deepEqual(recentLearnRecords([]), []);
  assert.deepEqual(recentLearnRecords(historyFixture().filter((t) => t.task_type !== 'learn')), []);
  assert.deepEqual(recentLearnRecords(null), []);
  assert.deepEqual(activeLearnTasks(undefined), []);
});

test('空态摘要：报告缺失时覆盖率为占位、参数调整数为 0，不抛错', () => {
  const info = describeLearnRecord({ task_id: 't-learn-3', scenario: 'from-scratch-timing', status: 'failed' }, null);
  assert.equal(info.coverage, '—');
  assert.equal(info.adjustmentCount, 0);
  assert.equal(info.adjustmentSummary, '');
});

// ---------- 记录摘要（折叠区单条记录的头行字段） ----------

test('记录摘要：场景标签/时间/状态/对齐覆盖率/参数调整摘要逐项拼出', () => {
  const record = {
    task_id: 't-learn-2',
    scenario: 'existing-subtitle',
    status: 'completed',
    created_at: '2026-09-10T09:00:00Z',
    completed_at: '2026-09-10T09:03:00Z',
  };
  const report = {
    alignment_coverage: 0.914,
    param_adjustments: {
      'asr.hotwords': { direction: 'increase', reason: '专有名词' },
      'segment.max_len': { direction: 'decrease' },
      'llm.temperature': { direction: 'increase' },
      'timeline.bias': { direction: 'decrease' },
    },
  };
  const info = describeLearnRecord(record, report);
  assert.equal(info.taskId, 't-learn-2');
  assert.equal(info.scenario, 'existing-subtitle');
  assert.match(info.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); // 人读本地时间
  assert.equal(info.status, '已完成');
  assert.equal(info.coverage, '91.4%');
  assert.equal(info.adjustmentCount, 4);
  assert.match(info.adjustmentSummary, /↑ asr\.hotwords；↓ segment\.max_len/);
  assert.match(info.adjustmentSummary, /等 4 项/); // 超过 3 条折叠为摘要
});

test('时间格式化：非法/缺省输入原样或占位呈现，绝不抛错', () => {
  assert.equal(formatLearnTime(''), '—');
  assert.equal(formatLearnTime(null), '—');
  assert.equal(formatLearnTime('not-a-date'), 'not-a-date');
});

// ---------- 进行中进度展示 ----------

test('进行中进度文案：优先 stage/description，progress 换算百分比', () => {
  assert.equal(learnProgressLabel({
    status: 'running',
    progress: { stage: 'separation', progress: 0.42, description: '人声分离中' },
  }), '学习中：人声分离中 42%');
  assert.equal(learnProgressLabel({ status: 'pending' }), '学习中…');
  assert.equal(learnProgressLabel({
    status: 'running',
    progress: { stage: 'asr', progress: 2 }, // 越界比例被夹取
  }), '学习中：asr 100%');
});

// ---------- 异步学习任务提交响应（D28 envelope） ----------

test('envelope 识别：task_type=learn 且带 task_id 即异步任务响应，报告/空值不算', () => {
  assert.equal(isLearnTaskEnvelope({
    task_id: 't-learn-run', status: 'pending', task_type: 'learn', scenario: 'existing-subtitle',
  }), true);
  assert.equal(isLearnTaskEnvelope({
    task_id: 't-learn-done', status: 'completed', task_type: 'learn', deduplicated: true,
  }), true); // 去重命中也转「历史」看结果
  assert.equal(isLearnTaskEnvelope({ status: 'ok', alignment_coverage: 0.9 }), false); // 同步学习报告
  assert.equal(isLearnTaskEnvelope({ status: 'error', message: 'x' }), false);
  assert.equal(isLearnTaskEnvelope(null), false);
});

// ---------- 深链 URL 构造 ----------

test('深链 URL：站点根 + 反馈档案工作区 hash，容错尾斜杠', () => {
  assert.equal(governanceUrl('http://127.0.0.1:8613'), 'http://127.0.0.1:8613/#feedback');
  assert.equal(governanceUrl('http://127.0.0.1:8613/'), 'http://127.0.0.1:8613/#feedback');
  assert.equal(governanceUrl('http://127.0.0.1:8613///'), 'http://127.0.0.1:8613/#feedback');
});

// ---------- pipeline 客户端：既有路由的 URL 装配 ----------

test('客户端 tasks()/history()/historyDetail() 命中既有任务/历史路由', async () => {
  const { calls, fetchImpl } = captureFetch();
  const pipeline = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl });

  await pipeline.tasks();
  await pipeline.history({ limit: 100 });
  await pipeline.history({ limit: 20, status: 'completed' });
  await pipeline.historyDetail('task abc');
  assert.equal(pipeline.governanceUrl(), 'http://127.0.0.1:8613/#feedback');

  assert.deepEqual(calls.map((c) => c.url), [
    'http://127.0.0.1:8613/api/tasks',
    'http://127.0.0.1:8613/api/history?limit=100',
    'http://127.0.0.1:8613/api/history?limit=20&status=completed',
    'http://127.0.0.1:8613/api/history/task%20abc',
  ]);
});
