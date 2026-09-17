// 会话来源判定（四场景学习，定案文档 D25/D27）：从会话状态集中推导学习请求的
// task_id 与场景标签（scenario）。深链（?manifest=<url>）与管线面板载入产物都会把
// 来源任务写入 store.state.pipelineRun；"打开存量字幕"与"从零打轴"以会话里实际可得的
// 字段区分（subtitleSource 是否为 'file'——注意导出会改写 subtitleName，文件名不可靠）。
// 判定逻辑集中在本模块，保证可单测、两端（学习请求与 journal header）口径一致。
// 全部为纯函数，无 DOM / 网络。
//
// 场景标签取值与 8613 后端 /api/feedback/learn 的校验白名单对齐：
//   inline-review        工作台内修正（会话自带任务来源：深链 / 管线产物）
//   external-correction  外部工具修正上传（8613 上传窗口，编辑器不产生）
//   existing-subtitle    打开音频 + 存量字幕（有字幕文件名、无任务来源）
//   from-scratch-timing  从零打轴（无字幕来源、用户手工建轴）
export const SCENARIOS = {
  INLINE_REVIEW: 'inline-review',
  EXTERNAL_CORRECTION: 'external-correction',
  EXISTING_SUBTITLE: 'existing-subtitle',
  FROM_SCRATCH_TIMING: 'from-scratch-timing',
};

// 从 review-manifest-v1 的 URL 解析任务 ID：{origin}/api/tasks/{task_id}/manifest。
// 深链会话即使 manifest 拉取失败（服务端已清理等），任务上下文也不丢。
// 非 manifest 路径返回 null。
export function taskIdFromManifestUrl(url) {
  if (!url) return null;
  try {
    const path = new URL(url, 'http://localhost.invalid').pathname;
    const m = path.match(/^\/api\/tasks\/([^/]+)\/manifest\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// 核心判定（规则优先级自上而下，无法判定时 scenario 为 null——可选字段，不硬塞）：
//   1. 有任务来源（pipelineRun.taskId）→ inline-review，学习请求带 task_id；
//   2. 无任务来源、字幕来自打开的文件（subtitleSource='file'，含深链 subs/管线产物）→ existing-subtitle；
//   3. 无任务来源、无字幕文件（cue 为用户手工建出）→ from-scratch-timing；
//   4. 会话里没有任何可判定的依据（如空会话）→ 不带 scenario。
export function resolveSessionSource({ taskId, subtitleFromFile, cueCount } = {}) {
  const id = typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
  if (id) return { taskId: id, scenario: SCENARIOS.INLINE_REVIEW };
  const hasCues = Number(cueCount) > 0;
  if (subtitleFromFile) return { taskId: null, scenario: SCENARIOS.EXISTING_SUBTITLE };
  if (hasCues) return { taskId: null, scenario: SCENARIOS.FROM_SCRATCH_TIMING };
  return { taskId: null, scenario: null };
}

// 便捷入口：直接读中央状态（duck-typed，单测可传普通对象）。学习面板与 journal 的
// scenario 注入都经此取值，保证两处口径恒一致。
export function sessionSourceFromState(state) {
  return resolveSessionSource({
    taskId: state?.pipelineRun?.taskId,
    subtitleFromFile: state?.subtitleSource === 'file',
    cueCount: state?.cues?.length ?? 0,
  });
}
