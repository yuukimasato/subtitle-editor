// 会话来源判定（四场景学习 D25/D27）：manifest URL → 任务 ID、会话状态 → 场景标签。
// 判定规则集中在 js/session-source.js，此处覆盖：解析、四场景映射、无法判定不带标签、
// 以及学习面板与 journal 共用的便捷入口口径一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIOS,
  taskIdFromManifestUrl,
  resolveSessionSource,
  sessionSourceFromState,
} from '../js/session-source.js';

// ---------- taskIdFromManifestUrl：深链 manifest URL → 任务 ID ----------

test('taskIdFromManifestUrl：标准深链 URL（8613 生成形态）解析任务 ID', () => {
  assert.equal(taskIdFromManifestUrl('http://127.0.0.1:8613/api/tasks/task-abc123/manifest'), 'task-abc123');
  assert.equal(taskIdFromManifestUrl('http://127.0.0.1:8613/api/tasks/task-abc123/manifest?v=2'), 'task-abc123');
  assert.equal(taskIdFromManifestUrl('/api/tasks/t9/manifest'), 't9');
  assert.equal(taskIdFromManifestUrl('http://127.0.0.1:8613/api/tasks/t%20x/manifest'), 't x');
});

test('taskIdFromManifestUrl：非 manifest 路径与非法输入返回 null', () => {
  assert.equal(taskIdFromManifestUrl('http://127.0.0.1:8613/api/tasks/t9/subtitle-file'), null);
  assert.equal(taskIdFromManifestUrl('http://127.0.0.1:8613/api/tasks/t9/manifest/extra'), null);
  assert.equal(taskIdFromManifestUrl('http://127.0.0.1:8613/media/a.wav'), null);
  assert.equal(taskIdFromManifestUrl(''), null);
  assert.equal(taskIdFromManifestUrl(null), null);
  assert.equal(taskIdFromManifestUrl('::not-a-url::'), null);
});

// ---------- resolveSessionSource：四场景映射 ----------

test('有任务来源 → inline-review，task_id 原样透传（优先级最高）', () => {
  assert.deepEqual(
    resolveSessionSource({ taskId: 'task-1', subtitleFromFile: true, cueCount: 5 }),
    { taskId: 'task-1', scenario: SCENARIOS.INLINE_REVIEW },
  );
  // 深链打开但 cue 为手工新建：任务来源仍在，仍为 inline-review
  assert.deepEqual(
    resolveSessionSource({ taskId: 'task-1', subtitleFromFile: false, cueCount: 3 }),
    { taskId: 'task-1', scenario: SCENARIOS.INLINE_REVIEW },
  );
});

test('无任务来源、字幕来自打开的文件 → existing-subtitle（V3）', () => {
  assert.deepEqual(
    resolveSessionSource({ taskId: null, subtitleFromFile: true, cueCount: 10 }),
    { taskId: null, scenario: SCENARIOS.EXISTING_SUBTITLE },
  );
});

test('无任务来源、无字幕文件（手工建轴）→ from-scratch-timing（V4）', () => {
  assert.deepEqual(
    resolveSessionSource({ taskId: null, subtitleFromFile: false, cueCount: 2 }),
    { taskId: null, scenario: SCENARIOS.FROM_SCRATCH_TIMING },
  );
});

test('空串/非字符串任务 ID 视为无任务来源；无法判定时不带 scenario（可选字段不硬塞）', () => {
  assert.deepEqual(
    resolveSessionSource({ taskId: '  ', subtitleFromFile: false, cueCount: 0 }),
    { taskId: null, scenario: null },
  );
  assert.deepEqual(
    resolveSessionSource({ taskId: 42, subtitleFromFile: false, cueCount: 4 }),
    { taskId: null, scenario: SCENARIOS.FROM_SCRATCH_TIMING },
  );
  assert.deepEqual(resolveSessionSource({}), { taskId: null, scenario: null });
  assert.deepEqual(resolveSessionSource(), { taskId: null, scenario: null });
});

// ---------- sessionSourceFromState：学习请求与 journal header 共用入口 ----------

test('sessionSourceFromState：duck-typed 中央状态，与 resolveSessionSource 口径一致', () => {
  assert.deepEqual(
    sessionSourceFromState({
      pipelineRun: { taskId: 't1', runId: 'run-1' },
      subtitleSource: 'file',
      cues: [{ id: 'a' }],
    }),
    { taskId: 't1', scenario: SCENARIOS.INLINE_REVIEW },
  );
  assert.deepEqual(
    sessionSourceFromState({ pipelineRun: null, subtitleSource: 'file', cues: [] }),
    { taskId: null, scenario: SCENARIOS.EXISTING_SUBTITLE },
  );
  assert.deepEqual(
    sessionSourceFromState({ pipelineRun: null, subtitleSource: null, cues: [{ id: 'a' }] }),
    { taskId: null, scenario: SCENARIOS.FROM_SCRATCH_TIMING },
  );
});

test('sessionSourceFromState：缺字段/空状态安全返回 null scenario', () => {
  assert.deepEqual(sessionSourceFromState({}), { taskId: null, scenario: null });
  assert.deepEqual(sessionSourceFromState(null), { taskId: null, scenario: null });
});
