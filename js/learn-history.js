// 学习历史记录（四场景学习，定案 D28/D29，工单 08）：学习面板「历史」折叠区的数据侧
// 纯逻辑——从既有任务/历史 API 的响应里过滤出学习任务、挑进行中任务、取最近 N 条记录、
// 拼装摘要字段与 8613 治理视图深链 URL。全部为纯函数，无 DOM / 网络；API 细节在
// js/pipeline.js（GET /api/tasks、GET /api/history、GET /api/history/{id}，均为既有路由，
// 编辑台零后端定位不破）；UI 装配在 js/ui/feedback-panel.js。
//
// 服务端字段事实（webui/api_serializers.py）：
//   GET /api/tasks 列表项：{ task_id, status, run_id, error, task_type, scenario }——
//     内存任务通道，含进行中的异步学习任务（D28 冷重跑）；
//   GET /api/history 列表项：history_item 序列化，含 task_type/scenario/created_at/
//     completed_at/status（学习报告不在此层，需按 id 取详情）；
//   GET /api/history/{id} 详情：result_summary.learn_report 为学习报告，结构与手动学习
//     响应一致（alignment_coverage / param_adjustments / …）。

// 学习任务的 task_type 标记（与 8613 后端 LEARN_TASK_TYPE 对齐；普通任务为空串）
export const LEARN_TASK_TYPE = 'learn';

// 进行中状态（终态之外皆视为进行中：pending/running，以及未知的新状态宁可多显示）
const ACTIVE_STATUSES = new Set(['pending', 'running']);

// 「历史」折叠区展示的记录条数（实现要点建议 5-10，取小值控制详情请求数）
export const RECENT_LEARN_LIMIT = 5;

// /api/history 拉取窗口：学习任务与普通任务混在同一历史里，先取一批再客户端过滤
export const HISTORY_FETCH_LIMIT = 100;

export function isLearnTask(task) {
  return task?.task_type === LEARN_TASK_TYPE;
}

// 进行中的学习任务（异步冷重跑进行时）：非终态即进行中
export function isLearnTaskActive(task) {
  return isLearnTask(task) && ACTIVE_STATUSES.has(String(task?.status || ''));
}

export function filterLearnTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(isLearnTask);
}

export function activeLearnTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(isLearnTaskActive);
}

// 异步学习任务提交响应（D28 冷重跑，V3/V4 场景）：learn 请求返回任务标识而非学习
// 报告——调用方（学习面板/自动学习）据此转入「历史」折叠区跟进进度与结果
export function isLearnTaskEnvelope(result) {
  return result?.task_type === LEARN_TASK_TYPE && Boolean(result?.task_id);
}

// 记录时间：完成时间优先，未完成回退创建时间（服务端均已按创建倒序，仍防御性重排）
export function learnRecordTime(record) {
  return record?.completed_at || record?.created_at || '';
}

// 最近 N 条学习记录：过滤 task_type === "learn" → 按时间倒序 → 截取 N
export function recentLearnRecords(historyItems, limit = RECENT_LEARN_LIMIT) {
  return (Array.isArray(historyItems) ? historyItems : [])
    .filter(isLearnTask)
    .sort((a, b) => String(learnRecordTime(b)).localeCompare(String(learnRecordTime(a))))
    .slice(0, Math.max(0, limit));
}

// ISO 时间 → 人读本地时间（YYYY-MM-DD HH:mm）；解析失败原样返回，绝不上抛
export function formatLearnTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const STATUS_LABELS = {
  pending: '排队中',
  running: '运行中',
  completed: '已完成',
  degraded_completed: '已完成（降级）',
  failed: '失败',
};

export function learnStatusLabel(status) {
  return STATUS_LABELS[String(status || '')] || String(status || '—');
}

// 进行中任务的进度文案（GET /api/tasks/{id} 的 progress：{stage, progress, description?}；
// 列表项无 progress 时给占位）。ratio ∈ [0,1] 或 null。
export function learnProgressLabel(task) {
  const stage = task?.progress?.description || task?.progress?.stage || '';
  const ratio = task?.progress?.progress;
  const percent = typeof ratio === 'number'
    ? ` ${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`
    : '';
  const base = stage ? `学习中：${stage}` : '学习中…';
  return `${base}${percent}`;
}

// 8613 治理视图（反馈档案工作区）深链：8613 静态页以 location.hash 路由工作区
// （#process/#feedback/#dataset），#feedback 进入反馈档案（健康趋势/审核队列/回滚）。
export function governanceUrl(base) {
  const origin = String(base || '').trim().replace(/\/+$/, '');
  return `${origin}/#feedback`;
}

// 记录摘要（折叠区单条记录的头行字段）：场景标签/时间/状态 + 对齐覆盖率/参数调整摘要
// （report 来自任务详情 learn_report，结构与手动学习响应一致；缺失时字段为占位）。
export function describeLearnRecord(record, report = null) {
  const coverage = report?.alignment_coverage;
  const adjustments = Object.entries(report?.param_adjustments ?? {});
  const arrows = adjustments.map(([path, adj]) => {
    const direction = adj?.direction === 'increase' ? '↑' : (adj?.direction === 'decrease' ? '↓' : '·');
    return `${direction} ${path}`;
  });
  return {
    taskId: String(record?.task_id ?? ''),
    scenario: String(record?.scenario || '—'),
    when: formatLearnTime(learnRecordTime(record)),
    status: learnStatusLabel(record?.status),
    coverage: coverage !== undefined && coverage !== null
      ? `${(Number(coverage) * 100).toFixed(1)}%`
      : '—',
    adjustmentCount: adjustments.length,
    adjustmentSummary: arrows.slice(0, 3).join('；') + (adjustments.length > 3 ? ` 等 ${adjustments.length} 项` : ''),
  };
}
