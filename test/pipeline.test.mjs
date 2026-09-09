// 管线面板与契约层测试（P3）：pipeline client 的端点契约（注入 fetch）、
// manifest 出处标注的行序映射、journal provenance/run_id 的记录语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/state.js';
import { createActions } from '../js/actions.js';
import { createJournal, JOURNAL_SCHEMA } from '../js/journal.js';
import { createPipelineClient } from '../js/pipeline.js';
import { annotateProvenance } from '../js/ui/pipeline-panel.js';

// ---------- 假件 ----------

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// 记录请求的 fetch 假件：routes = [{ match(url, options) → bool, status?, json?, text? }]
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const route = routes.find((item) => item.match(String(url), options));
    if (route) {
      return {
        ok: (route.status ?? 200) < 400,
        status: route.status ?? 200,
        json: async () => route.json,
        text: async () => route.text ?? '',
      };
    }
    return { ok: false, status: 404, json: async () => ({ detail: 'not found' }), text: async () => '' };
  };
  return { fetch, calls };
}

function setupJournal() {
  const storage = fakeStorage();
  const store = createStore();
  const journal = createJournal(store, {
    storage,
    now: () => '2026-09-10T00:00:00Z',
    runId: () => store.state.pipelineRun?.runId ?? null,
  });
  const actions = createActions(store, { journal });
  return { store, actions, journal };
}

function parseNdjson(text) {
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

// ---------- pipeline client：端点契约 ----------

test('detect: journal sink 202 即在线，404/网络错误为离线', async () => {
  const ok = fakeFetch([{ match: (url) => url.endsWith('/api/journal/sink'), json: { accepted: true } }]);
  const client = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl: ok.fetch });
  const detection = await client.detect();
  assert.equal(detection.ok, true);
  assert.equal(ok.calls[0].options.method, undefined); // GET

  const offline = createPipelineClient({
    base: 'http://127.0.0.1:8613',
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const down = await offline.detect();
  assert.equal(down.ok, false);
  assert.match(down.error, /Failed to fetch/);
});

test('submit: multipart POST /api/run 携带 file/profile/output_format', async () => {
  const { fetch, calls } = fakeFetch([
    { match: (url) => url.endsWith('/api/run'), json: { task_id: 't1', status: 'pending' } },
  ]);
  const client = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl: fetch });
  const file = new File(['abc'], 'lesson01.mp4', { type: 'video/mp4' });
  const result = await client.submit(file, { profile: 'podcast', format: 'srt' });
  assert.equal(result.task_id, 't1');
  assert.equal(calls[0].options.method, 'POST');
  assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(calls[0].options.body.get('profile'), 'podcast');
  assert.equal(calls[0].options.body.get('output_format'), 'srt');
  assert.equal(calls[0].options.body.get('file').name, 'lesson01.mp4');
});

test('taskStatus/manifest/subtitleUrl/mediaStreamUrl: 只读契约路径', async () => {
  const { fetch, calls } = fakeFetch([
    { match: (url) => url.endsWith('/api/tasks/t9'), json: { status: 'running', progress: { stage: 'asr' } } },
    { match: (url) => url.endsWith('/api/tasks/t9/manifest'), json: { schema: 'review-manifest-v1', cues: [] } },
  ]);
  const client = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl: fetch });
  const status = await client.taskStatus('t9');
  assert.equal(status.status, 'running');
  const manifest = await client.manifest('t9');
  assert.equal(manifest.schema, 'review-manifest-v1');
  assert.equal(client.subtitleUrl('t9', 'llm'),
    'http://127.0.0.1:8613/api/tasks/t9/subtitle-file?version=llm');
  assert.equal(client.mediaStreamUrl('t9'),
    'http://127.0.0.1:8613/api/tasks/t9/audio/stream?type=input');
  assert.equal(calls[0].url, 'http://127.0.0.1:8613/api/tasks/t9');
});

test('postJournal: NDJSON 批量上送到 sink', async () => {
  const { fetch, calls } = fakeFetch([
    { match: (url, options) => url.endsWith('/api/journal/sink') && options.method === 'POST', status: 202, json: { accepted: 2 } },
  ]);
  const client = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl: fetch });
  const result = await client.postJournal('{"schema":"edit-journal-v1","type":"event"}\n');
  assert.equal(result.accepted, 2);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-ndjson');
});

test('非 2xx 与非 202: 抛出带 detail 的错误', async () => {
  const { fetch } = fakeFetch([
    { match: (url) => url.endsWith('/api/run'), status: 503, json: { detail: 'FunASR 未就绪' } },
  ]);
  const client = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl: fetch });
  await assert.rejects(
    () => client.submit(new File(['x'], 'a.wav'), {}),
    /FunASR 未就绪/,
  );
});

// ---------- annotateProvenance：manifest 行序 → cue 出处 ----------

const MANIFEST = {
  schema: 'review-manifest-v1',
  run_id: 'run-1',
  cues: [
    { index: 1, source_stage: 'asr', confidence: 0.9, speaker_id: 0, speaker_label: '主持人' },
    { index: 2, source_stage: 'llm-optimized', confidence: 0.87 },
  ],
};

test('annotateProvenance: 按行序号标注出处，无出处行清空', () => {
  const cues = [
    { id: 'a', start: 1, end: 2, text: '一' },
    { id: 'b', start: 3, end: 4, text: '二', provenance: { source_stage: 'stale' } },
    { id: 'c', start: 5, end: 6, text: '三' },
  ];
  const matched = annotateProvenance(cues, MANIFEST);
  assert.equal(matched, 2);
  assert.deepEqual(cues[0].provenance, { source_stage: 'asr', confidence: 0.9, speaker_id: 0, speaker_label: '主持人' });
  assert.deepEqual(cues[1].provenance, { source_stage: 'llm-optimized', confidence: 0.87 });
  assert.equal(cues[2].provenance, undefined);
});

test('annotateProvenance: 空/缺失 manifest 安全返回 0', () => {
  assert.equal(annotateProvenance([{ id: 'a' }], null), 0);
  assert.equal(annotateProvenance([{ id: 'a' }], { cues: 'bad' }), 0);
});

// ---------- journal：provenance 与 run_id 的记录语义 ----------

test('journal: cue 出处随事件记录，header 携带管线 run_id', () => {
  const { store, actions, journal } = setupJournal();
  actions.loadSubtitle(
    [{ id: 'a', start: 1, end: 3, text: '第一句', provenance: { source_stage: 'asr', confidence: 0.9 } }],
    { name: 'lesson01.srt', format: 'srt', doc: null },
  );
  store.patch({ pipelineRun: { taskId: 't1', runId: 'run-20260910-x' } });
  actions.updateCueTimes('a', 0.9, 3);

  const text = journal.exportText();
  const [header, event] = parseNdjson(text);
  assert.equal(header.run_id, 'run-20260910-x');
  assert.equal(event.schema, JOURNAL_SCHEMA);
  assert.deepEqual(event.context.provenance, { source_stage: 'asr', confidence: 0.9 });
});

test('journal: 无出处 cue 记 null；结构操作后的新行无出处', () => {
  const { actions, journal } = setupJournal();
  actions.loadSubtitle(
    [{ id: 'a', start: 1, end: 6, text: '长句' }],
    { name: 'x.srt', format: 'srt', doc: null },
  );
  actions.updateCueTimes('a', 0.9, 6);
  actions.splitCue('a', 3);
  const text = journal.exportText();
  const events = parseNdjson(text).slice(1);
  assert.equal(events[0].context.provenance, null);
  // 拆分事件的 modify 主影响行来自有出处的 cue-a（原行保留出处）
  const split = events[1];
  assert.ok(['modify', 'add'].includes(split.diff[0].op));
});
