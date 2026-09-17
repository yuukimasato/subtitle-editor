// 会话学习流程核心（四场景学习，定案 D24/D25/D27）：从当前会话推导学习输入（参考字幕 +
// 任务来源 task_id/scenario）→ 构造 learn 请求 → 编辑日志 sink 顺带上送。
// 手动「确认学习」（学习面板）与导出自动学习（D24，工单 07）共用本模块的同一条路径，
// 保证两者请求内容恒一致、请求构造只此一份；差异只在来源与呈现——手动兜底文件与
// 进度/报告 UI 留在面板（js/ui/feedback-panel.js），本模块无 DOM / toast，结果由调用方呈现。
// multipart 表单细节在 js/pipeline.js 的 learn/postJournal；任务来源判定在 js/session-source.js。
import { serializeSubtitle, ensureDoc } from './format/index.js';
import { sessionSourceFromState } from './session-source.js';

// deps: {
//   store         中央状态（duck-typed，单测可传 createStore() 产物）
//   pipeline      js/pipeline.js 客户端（fetch 可注入）
//   journal       编辑日志（js/journal.js），可空；exportText() 为上送文本唯一来源
//   getMediaFile  () => File | null；会话媒体文件（main.js 注入最近一次打开的媒体）
// }
export function createLearnFlow({ store, pipeline, journal = null, getMediaFile = null }) {
  // 学习来源：reference 恒为当前 cue 序列化的 SRT；带任务来源（D25）时 audio 可省
  // （服务端复用任务历史基线，秒级返回）；无任务来源则携带会话音频。手动兜底文件在
  // 会话之外、不携带 task_id/scenario（行为与现状一致），由调用方经 run({ files }) 覆盖。
  function gatherSource() {
    const cues = store.state.cues;
    if (!cues.length) throw new Error('当前没有字幕 cue，请先打开或校对字幕');
    const srt = serializeSubtitle('srt', cues, ensureDoc('srt', cues, store.state.subDoc));
    const base = (store.state.subtitleName || store.state.mediaName || 'edited').replace(/\.[^.]+$/, '');
    const reference = new File([srt], `${base}_edited.srt`, { type: 'text/plain' });
    const session = sessionSourceFromState(store.state);
    if (session.taskId) {
      // 深链/管线会话：服务端复用任务已存管线输出，音频无需上传（秒级返回）
      return { audio: null, reference, fromSession: true, taskId: session.taskId, scenario: session.scenario };
    }
    const media = getMediaFile?.();
    if (!media) throw new Error('当前没有已加载的音频，请先打开媒体或改用手动选择文件');
    return { audio: media, reference, fromSession: true, taskId: null, scenario: session.scenario };
  }

  // 执行一次学习请求（预览 dryRun=true / 确认 dryRun=false）。
  // files：手动兜底来源 { audio, reference, fromSession:false, taskId:null, scenario:null }，
  //        缺省取当前会话；onStage(source)：取到来源后、请求发出前的回调（面板用于进度文案）。
  // 返回 { result, journalNote, source }；确认路径且来源为会话时日志顺带上送（sink 按
  // (session_id, seq) 幂等去重），失败不阻塞学习结果、只拼进 journalNote 由调用方呈现。
  async function run({
    dryRun = false,
    profile = 'default',
    feedbackProfile = 'user_default',
    files = null,
    onStage = () => {},
  } = {}) {
    const source = files ?? gatherSource();
    onStage(source);
    const result = await pipeline.learn(source.audio, source.reference, {
      profile,
      feedbackProfile: feedbackProfile || 'user_default',
      dryRun,
      taskId: source.taskId,
      scenario: source.scenario,
    });
    const journalNote = !dryRun && source.fromSession ? await pushJournalQuietly() : '';
    return { result, journalNote, source };
  }

  // 日志顺带上送（幂等去重）；失败不阻塞学习结果
  async function pushJournalQuietly() {
    const text = journal?.exportText?.();
    if (!text) return '';
    try {
      const result = await pipeline.postJournal(text);
      const dupes = result.duplicates ? `，去重 ${result.duplicates}` : '';
      return `，日志已上送（接收 ${result.accepted ?? '?'} 条${dupes}）`;
    } catch (err) {
      return `，⚠ 日志上送失败：${err.message}`;
    }
  }

  return { gatherSource, run };
}
