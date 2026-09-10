// 反馈学习客户端契约（双界面收敛 M2）：createPipelineClient.learn 的 multipart 装配。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineClient } from '../js/pipeline.js';

function captureFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', alignment_coverage: 0.9 }),
    };
  };
  return { calls, fetchImpl };
}

test('learn posts multipart to /api/feedback/learn with expected fields', async () => {
  const { calls, fetchImpl } = captureFetch();
  const pipeline = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl });
  const audio = new File(['audio-bytes'], 'episode.wav', { type: 'audio/wav' });
  const reference = new File(['1\n00:00:00,000 --> 00:00:01,000\n你好\n'], 'edited.srt', { type: 'text/plain' });

  const result = await pipeline.learn(audio, reference, { profile: 'podcast', feedbackProfile: 'user_default', dryRun: true });

  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'http://127.0.0.1:8613/api/feedback/learn');
  assert.equal(options.method, 'POST');
  const form = options.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('profile'), 'podcast');
  assert.equal(form.get('feedback_profile'), 'user_default');
  assert.equal(form.get('run_pipeline_first'), 'true');
  assert.equal(form.get('dry_run'), 'true');
  assert.equal(form.get('audio').name, 'episode.wav');
  assert.equal(form.get('audio').type, 'audio/wav');
  assert.equal(form.get('reference').name, 'edited.srt');
});

test('learn defaults to a real (non-dry) run against user_default', async () => {
  const { calls, fetchImpl } = captureFetch();
  const pipeline = createPipelineClient({ base: 'http://127.0.0.1:8613', fetchImpl });
  await pipeline.learn(new File(['a'], 'a.wav'), new File(['s'], 's.srt'));
  const form = calls[0].options.body;
  assert.equal(form.get('dry_run'), 'false');
  assert.equal(form.get('profile'), 'default');
  assert.equal(form.get('feedback_profile'), 'user_default');
});
