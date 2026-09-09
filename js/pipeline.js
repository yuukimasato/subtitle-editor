// 管线服务 API 客户端（跨栈契约层，方案 §3.3）。
// 端点为 webui 既有路由（契约冻结）+ 新增 journal sink / manifest（追加式）：
//   POST /api/run                        提交任务（multipart）
//   GET  /api/tasks/{id}                 进度与结果
//   GET  /api/tasks/{id}/manifest        review-manifest-v1 审核清单
//   GET  /api/tasks/{id}/subtitle-file   字幕产物（version=clean|llm）
//   GET  /api/tasks/{id}/audio/stream    输入音频流（<audio> 可直接用）
//   GET  /api/journal/sink               能力探测（202）
//   POST /api/journal/sink               日志批量上送（V1.5）
// fetch 可注入（单测）；所有方法不抛网络细节之外的状态，非 2xx 以 Error(message) 呈现。

const DEFAULT_BASE = 'http://127.0.0.1:8613';
export const PIPELINE_BASE_KEY = 'vstEditor.pipeline.base';

export function defaultBase() {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(PIPELINE_BASE_KEY) || DEFAULT_BASE;
    }
  } catch {
    // 存储不可用：用默认地址
  }
  return DEFAULT_BASE;
}

export function setDefaultBase(base) {
  try {
    localStorage.setItem(PIPELINE_BASE_KEY, base);
  } catch {
    // 存储不可用：仅本次会话生效
  }
}

export function createPipelineClient({ base = defaultBase(), fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  async function request(path, options = {}) {
    if (!fetchImpl) throw new Error('fetch 不可用');
    const res = await fetchImpl(`${base}${path}`, options);
    if (!res.ok && res.status !== 202) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data?.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      } catch {
        // 非 JSON 错误体：保留状态码
      }
      throw new Error(detail);
    }
    return res;
  }

  return {
    base,

    // 能力探测：管线面板据此判断后端在线（journal sink 202 即在线）
    async detect() {
      try {
        const res = await request('/api/journal/sink');
        const data = await res.json().catch(() => ({}));
        return { ok: true, version: data?.version ?? null, raw: data };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    },

    async profiles() {
      const res = await request('/api/profiles');
      return res.json();
    },

    // 提交任务：媒体文件 + 场景模板 + 输出格式
    async submit(file, { profile = 'default', format = 'srt', skipSeparation = false } = {}) {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('profile', profile);
      form.append('output_format', format);
      form.append('skip_separation', String(skipSeparation));
      const res = await request('/api/run', { method: 'POST', body: form });
      return res.json();
    },

    async taskStatus(taskId) {
      const res = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
      return res.json();
    },

    // review-manifest-v1：per-cue 出处（index 对应字幕行序号，1 起）
    async manifest(taskId) {
      const res = await request(`/api/tasks/${encodeURIComponent(taskId)}/manifest`);
      return res.json();
    },

    async postJournal(ndjsonText) {
      const res = await request('/api/journal/sink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body: ndjsonText,
      });
      return res.json();
    },

    subtitleUrl(taskId, version = 'clean') {
      return `${base}/api/tasks/${encodeURIComponent(taskId)}/subtitle-file?version=${version}`;
    },

    mediaStreamUrl(taskId) {
      return `${base}/api/tasks/${encodeURIComponent(taskId)}/audio/stream?type=input`;
    },
  };
}
