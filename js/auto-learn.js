// 自动学习开关与导出触发（四场景 D24，工单 07）：全局设置项，localStorage 持久化，默认关。
// 开=导出字幕成功后自动执行与手动「确认学习」完全相同的上送（learn 请求 + 编辑日志 sink，
// 与手动共用 js/learn-flow.js 的同一条路径），仅 toast 告知、不弹确认框；关=维持现状语义
// （不点击=不上送=舍弃，本地 .journal.jsonl 照旧搭车导出）。8613 离线时跳过学习并做
// 一次性提示（页面会话内不重复打扰），导出流程本身不受任何影响。
// 本模块不含 DOM：存储可注入（单测），提示经 notify 注入（装配层接 js/ui/toast.js）。
import { isLearnTaskEnvelope } from './learn-history.js';

export const AUTO_LEARN_KEY = 'vstEditor.autoLearn';

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// 默认关（'1'=开，其余皆关）：与 journalEnabled 同款 '1'/'0' 存法、相反的默认值
export function isAutoLearnEnabled(storage = defaultStorage()) {
  try {
    return storage?.getItem(AUTO_LEARN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAutoLearnEnabled(enabled, storage = defaultStorage()) {
  try {
    storage?.setItem(AUTO_LEARN_KEY, enabled ? '1' : '0');
  } catch {
    // 存储不可用：仅本次会话生效
  }
}

// deps: {
//   storage  可注入（单测）；默认 localStorage
//   detect   () => Promise<{ok, error?}>：8613 能力探测（journal sink 202 即在线）
//   runLearn async () => { result, journalNote? }：学习面板注入的共享学习路径
//               （js/learn-flow.js 的 run，dryRun=false），与手动「确认学习」同一请求构造
//   notify   (message, type?) => void：结果/提示呈现（toast），默认 no-op
// }
export function createAutoLearnTrigger({ storage = defaultStorage(), detect, runLearn, notify = () => {} } = {}) {
  let offlineNotified = false; // 一次性提示标志：本次页面会话内离线只提示一次

  return {
    // 导出成功回调（toolbar 的 onExported 注入，fire-and-forget）：绝不抛错、不阻塞导出
    async afterExport() {
      if (!isAutoLearnEnabled(storage)) return { status: 'disabled' };
      let detection = { ok: false, error: '' };
      try {
        detection = await detect();
      } catch (err) {
        detection = { ok: false, error: String(err?.message || err) };
      }
      if (!detection?.ok) {
        // 离线：静默跳过学习，仅首次提示（同会话内不重复打扰）
        if (!offlineNotified) {
          offlineNotified = true;
          notify(`未检测到管线服务（${detection?.error || '离线'}），本次导出已跳过自动学习；导出文件不受影响`, 'error');
        }
        return { status: 'offline' };
      }
      try {
        const { result, journalNote = '' } = await runLearn();
        if (isLearnTaskEnvelope(result)) {
          // D28 冷重跑（V3/V4）：learn 返回异步任务标识而非报告——提交成功即告知，
          // 不当失败处理；进度与结果在处理台任务列表 / 学习面板「历史」折叠区可见。
          notify(`已提交异步学习任务 ${result.task_id}（冷重跑），进度与结果见处理台或学习面板「历史」`);
          return { status: 'submitted', result };
        }
        if (result?.status === 'ok') notify(`自动学习完成${journalNote}`);
        else notify(`自动学习未写入：${result?.message || '未知原因'}`, 'error');
        return { status: 'learned', result };
      } catch (err) {
        notify(`自动学习失败：${err.message}`, 'error');
        return { status: 'error', error: String(err.message || err) };
      }
    },
  };
}
