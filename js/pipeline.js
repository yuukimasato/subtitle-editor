// 管线服务 API 客户端（跨栈契约层，方案 §3.3）。
// 端点为 webui 既有路由（契约冻结）+ 新增 journal sink / manifest（追加式）：
//   POST /api/run                        提交任务（multipart）
//   GET  /api/tasks                       任务列表（含学习任务的 task_type/scenario 标记）
//   GET  /api/tasks/{id}                 进度与结果（学习任务完成后含 learn_report）
//   GET  /api/tasks/{id}/manifest        review-manifest-v1 审核清单
//   GET  /api/tasks/{id}/subtitle-file   字幕产物（version=clean|llm）
//   GET  /api/tasks/{id}/audio/stream    输入音频流（<audio> 可直接用）
//   GET  /api/history                     任务历史（持久化；学习记录按 task_type 过滤）
//   GET  /api/history/{id}                历史详情（result_summary.learn_report 学习报告）
//   GET  /api/journal/sink               能力探测（202）
//   POST /api/journal/sink               日志批量上送（V1.5）
// fetch 可注入（单测）；所有方法不抛网络细节之外的状态，非 2xx 以 Error(message) 呈现。

import { governanceUrl as buildGovernanceUrl } from './learn-history.js';

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

    // 任务列表（既有通道）：学习面板「历史」折叠区据此发现进行中的异步学习任务
    // （D28 冷重跑带 task_type="learn" 标记出现在同一任务通道里）
    async tasks() {
      const res = await request('/api/tasks');
      return res.json();
    },

    // 任务历史（持久化 SQLite）：学习记录与普通任务混列，客户端按 task_type 过滤
    // （服务端仅支持 status 过滤与 limit/offset，见 webui/routes_history.py）
    async history({ limit = 20, status = null } = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (status) params.set('status', String(status));
      const res = await request(`/api/history?${params.toString()}`);
      return res.json();
    },

    // 历史详情：result_summary.learn_report 为学习报告（结构与手动学习响应一致），
    // 供「历史」折叠区复用报告渲染。注意详情响应含全量 events，调用方应控制条数。
    async historyDetail(taskId) {
      const res = await request(`/api/history/${encodeURIComponent(taskId)}`);
      return res.json();
    },

    // 8613 治理视图（反馈档案工作区）深链：完整治理视图不进编辑台，跳转处理台
    governanceUrl() {
      return buildGovernanceUrl(base);
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

    // 编辑台字幕同步（editor-sync-v1）：编辑提交/导出后把当前字幕稿 POST 到处理台，
    // 处理台工作台可随时列出并下载最新稿。旧版处理台无此端点（404）→ 调用方按离线降级。
    async postSubtitleSync(payload) {
      const body = JSON.stringify(payload);
      const res = await request('/api/editor-sync/subtitle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        // 页面关闭/隐藏瞬间的最后一次改动也能发出（fetch keepalive 上限 64KB，超限自动降级普通请求）
        keepalive: body.length < 60_000,
      });
      return res.json();
    },

    // 反馈学习（双界面收敛 M2）：音频 + 人工修订字幕 → 对齐/归因 → 写用户档案。
    // 服务端契约：POST /api/feedback/learn（webui 反馈学习路由，字段见该路由定义）；
    // dry_run=true 为预览差异，不写档案。无 task_id 时服务端 run_pipeline_first 会先跑
    // 一遍管线，耗时较长。
    // 四场景学习（D25/D27）：task_id 为深链/管线会话的来源任务（带 task_id 时服务端直接
    // 复用任务历史已存管线输出作基线，不重跑管线、秒级返回，audio 可省——上传即瓶颈）；
    // scenario 为场景标签（inline-review/existing-subtitle/from-scratch-timing 等，可选）。
    // 两者皆缺时保持既有行为：必须传音频、服务端重跑管线。
    async learn(audioFile, referenceFile, {
      profile = 'default',
      feedbackProfile = 'user_default',
      dryRun = false,
      taskId = null,
      scenario = null,
    } = {}) {
      const form = new FormData();
      if (audioFile) form.append('audio', audioFile, audioFile.name);
      form.append('reference', referenceFile, referenceFile.name);
      form.append('profile', profile);
      form.append('feedback_profile', feedbackProfile);
      form.append('run_pipeline_first', 'true');
      form.append('dry_run', String(dryRun));
      if (taskId) form.append('task_id', String(taskId));
      if (scenario) form.append('scenario', String(scenario));
      const res = await request('/api/feedback/learn', { method: 'POST', body: form });
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
