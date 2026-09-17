// 反馈学习面板（双界面收敛 M2，方案 docs/双界面收敛方案-8613处理台与8631编辑台-2026-09-10.md §4）。
// 学习入口从 8613 webui 迁入编辑器：当前会话的音频 + 校对完成的字幕一键回传学习，
// 编辑日志（edit-journal）顺带上送（sink 按 (session_id, seq) 幂等去重）。
// 四场景学习（定案 D25/D27）：深链/管线会话带任务来源（pipelineRun.taskId）时学习请求
// 携带 task_id 与场景标签 scenario，服务端复用任务历史已存管线输出作基线（不重跑管线、
// 秒级返回、音频可省）；手动打开本地文件（无任务来源）时不携带，走音频上传重跑，行为
// 同现状。手动兜底：选择不在编辑器里的音频 + 修正字幕。
// 自动学习（定案 D24，工单 07）：面板内全局开关（默认关，localStorage 持久化）；开启后
// 导出字幕成功即自动执行与「确认学习」完全相同的上送——与手动共用 js/learn-flow.js 的
// 同一条请求路径（learn + 日志 sink），仅省去预览确认 UI、只 toast 告知；8613 离线时
// 跳过并一次性提示（js/auto-learn.js）。
// 学习历史（定案 D29，工单 08）：面板内「历史」折叠区（默认折叠）——进行中的异步学习
// 任务进度（复用既有任务通道 GET /api/tasks 与任务详情轮询）+ 最近 N 次学习结果摘要
// （持久化任务历史 GET /api/history，报告取自历史详情 learn_report，渲染复用本文件的
// renderReport）；完整治理视图（健康趋势/审核队列/回滚）经深链跳 8613 反馈档案工作区，
// 编辑台不重复建设。数据全部经既有 API 获取，离线/失败显示空态、绝不打断编辑。
// 本模块只做 UI 装配与流程编排，API 细节在 js/pipeline.js；8613 离线时入口按钮隐藏。
import { createPipelineClient, defaultBase, setDefaultBase } from '../pipeline.js';
import { sessionSourceFromState } from '../session-source.js';
import { createLearnFlow } from '../learn-flow.js';
import { isAutoLearnEnabled, setAutoLearnEnabled, createAutoLearnTrigger } from '../auto-learn.js';
import {
  HISTORY_FETCH_LIMIT,
  RECENT_LEARN_LIMIT,
  activeLearnTasks,
  describeLearnRecord,
  isLearnTaskEnvelope,
  learnProgressLabel,
  recentLearnRecords,
} from '../learn-history.js';
import { showToast } from './toast.js';

export function createFeedbackPanel({ store, panels, journal, getMediaFile } = {}) {
  let pipeline = createPipelineClient();
  // 会话学习核心：手动「确认学习」与导出自动学习共用（请求构造 + 日志顺带上送只此一份，
  // 见 js/learn-flow.js）；本面板只叠加 UI（进度/报告/toast 与手动兜底文件）。
  // pipeline 重连换地址后需重建（见 render() 的重连按钮）。
  let flow = createLearnFlow({ store, pipeline, journal, getMediaFile });
  // 自动学习触发器（D24）：开关与离线一次性提示在 js/auto-learn.js；runLearn 注入共享
  // 学习路径（默认参数），与手动「确认学习」唯一差异是不走预览确认 UI。
  const autoLearn = createAutoLearnTrigger({
    detect: () => pipeline.detect(),
    runLearn: () => flow.run({ dryRun: false }),
    notify: (message, type) => showToast(message, type),
  });
  let manualAudio = null;
  let manualSub = null;
  let busy = false;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child == null) continue;
      node.append(child);
    }
    return node;
  }

  function sessionSummary() {
    const session = sessionSourceFromState(store.state);
    const sourceNote = session.taskId
      ? `学习来源：任务 ${session.taskId}（${session.scenario}，复用已存管线基线）`
      : session.scenario
        ? `学习来源：当前会话（${session.scenario}）`
        : '学习来源：当前会话';
    const media = getMediaFile?.();
    const cues = store.state.cues?.length ?? 0;
    if (!media || !cues) return `${sourceNote}；当前会话：尚未同时具备音频与字幕`;
    const journalNote = journal?.stats?.().events ?? 0;
    return `${sourceNote}；当前会话：${media.name} + ${cues} 条 cue（日志 ${journalNote} 条事件）`;
  }

  function renderReport(target, report) {
    target.textContent = '';
    if (!report) return;
    const metrics = [
      ['对齐覆盖率', report.alignment_coverage !== undefined ? `${(Number(report.alignment_coverage) * 100).toFixed(1)}%` : '—'],
      ['总配对', report.total_pairs ?? 0],
      ['时间偏移', report.time_shifts_count ?? 0],
      ['合并/拆分', report.merge_actions_count ?? 0],
      ['文本编辑', report.text_edits_count ?? 0],
    ];
    target.append(el('div', { class: 'pipe-hint' },
      ...metrics.map(([label, value]) => el('div', {}, `${label}: ${value}`))));
    const adjustments = Object.entries(report.param_adjustments ?? {});
    if (adjustments.length) {
      target.append(el('div', { class: 'pipe-hint', text: `参数调整 ${adjustments.length} 项：` }));
      for (const [path, adj] of adjustments) {
        const direction = adj?.direction === 'increase' ? '↑' : (adj?.direction === 'decrease' ? '↓' : '·');
        const reason = adj?.reason ? ` — ${adj.reason}` : '';
        target.append(el('div', { class: 'pipe-hint', text: `${direction} ${path}${reason}` }));
      }
    } else {
      target.append(el('div', { class: 'pipe-hint', text: report.status === 'ok' ? '无需调整参数 — 当前参数已匹配用户偏好' : '' }));
    }
    if (report.structural_revision) {
      target.append(el('div', { class: 'pipe-hint', text: '⚠ 检测到结构性修订，参数权重将降低' }));
    }
    if (report.message) {
      target.append(el('div', { class: 'pipe-hint', text: report.message }));
    }
  }

  function render(body) {
    body.textContent = '';

    // ---- 连接状态（与管线面板一致：journal sink 202 即在线） ----
    const statusDot = el('span', { class: 'pipe-dot', 'aria-hidden': 'true' });
    const statusText = el('span', { class: 'pipe-status-text', text: '正在探测本地管线服务…' });
    const baseInput = el('input', {
      class: 'pipe-base', type: 'url', value: defaultBase(),
      'aria-label': '管线服务地址', 'data-no-panel-drag': '',
    });
    const reconnectBtn = el('button', { class: 'btn pipe-small', type: 'button', text: '重连', onclick: () => {
      const next = baseInput.value.trim().replace(/\/+$/, '');
      if (next && next !== pipeline.base) {
        setDefaultBase(next);
        pipeline = createPipelineClient({ base: next });
        flow = createLearnFlow({ store, pipeline, journal, getMediaFile }); // 手动/自动学习同步跟上新地址
      }
      refresh();
    } });
    const statusRow = el('div', { class: 'pipe-row pipe-status' }, statusDot, statusText, baseInput, reconnectBtn);

    // ---- 学习来源 ----
    const sourceSummary = el('div', { class: 'pipe-hint', text: sessionSummary() });
    const manualAudioInput = el('input', {
      class: 'pipe-file', type: 'file', accept: 'audio/*,video/*,.mp3,.wav,.flac,.m4a,.mp4,.mkv,.mov',
      'aria-label': '手动选择音频', 'data-no-panel-drag': '',
    });
    const manualSubInput = el('input', {
      class: 'pipe-file', type: 'file', accept: '.srt,.ass',
      'aria-label': '手动选择修正字幕', 'data-no-panel-drag': '',
    });
    const manualSummary = el('span', { class: 'pipe-file-name', text: '兜底：未选择文件（留空则用当前会话）' });
    function syncManualSummary() {
      manualAudio = manualAudioInput.files[0] ?? null;
      manualSub = manualSubInput.files[0] ?? null;
      if (manualAudio && manualSub) manualSummary.textContent = `兜底：${manualAudio.name} + ${manualSub.name}`;
      else manualSummary.textContent = '兜底：未选择文件（留空则用当前会话）';
    }
    manualAudioInput.addEventListener('change', syncManualSummary);
    manualSubInput.addEventListener('change', syncManualSummary);

    // ---- 参数 ----
    const profileSelect = el('select', { class: 'pipe-select', 'aria-label': '场景模板', 'data-no-panel-drag': '' },
      el('option', { value: 'default', text: 'default' }));
    const fbProfileInput = el('input', {
      class: 'pipe-base', type: 'text', value: 'user_default',
      'aria-label': '反馈档案名', 'data-no-panel-drag': '',
    });
    const paramRow = el('div', { class: 'pipe-row' },
      el('label', { class: 'pipe-label' }, '模板', profileSelect),
      el('label', { class: 'pipe-label' }, '档案', fbProfileInput),
    );

    // ---- 动作与结果 ----
    const previewBtn = el('button', { class: 'btn', type: 'button', text: '预览差异' });
    const learnBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '确认学习' });
    const actionRow = el('div', { class: 'pipe-row' }, previewBtn, learnBtn);
    const statusLine = el('div', { class: 'pipe-hint', text: '' });
    const report = el('div', { class: 'pipe-hint' });
    const hint = el('div', { class: 'pipe-hint pipe-flow-hint',
      text: '学习在无任务来源时先由服务端跑一遍管线提取自动字幕（耗时较长）；深链/管线会话带任务来源则复用已存基线，秒级返回。建议先「预览差异」再「确认学习」。' });

    function setBusy(stage) {
      busy = Boolean(stage);
      previewBtn.disabled = busy;
      learnBtn.disabled = busy;
      statusLine.textContent = stage ?? '';
    }

    // 进度文案：带任务来源时复用已存基线（秒级），否则服务端先跑管线（耗时较长）
    function stageText(write, source) {
      return source.taskId
        ? (write ? '学习中（复用来源任务已存基线，通常秒级）…' : '预览分析中（复用来源任务已存基线）…')
        : (write ? '学习中（服务端先跑管线，可能需要几分钟）…' : '预览分析中（服务端先跑管线）…');
    }

    async function run(write) {
      if (busy) return;
      // 手动兜底：文件在会话之外，不携带 task_id/scenario（行为与现状一致）
      const files = manualAudio && manualSub
        ? { audio: manualAudio, reference: manualSub, fromSession: false, taskId: null, scenario: null }
        : null;
      try {
        const { result, journalNote } = await flow.run({
          dryRun: !write,
          profile: profileSelect.value,
          feedbackProfile: fbProfileInput.value.trim() || 'user_default',
          files,
          onStage: (source) => setBusy(stageText(write, source)),
        });
        if (write && isLearnTaskEnvelope(result)) {
          // D28 冷重跑（V3/V4）：确认学习返回异步任务标识而非学习报告——不在报告区
          // 渲染占位指标，转入「历史」折叠区跟进进度/结果（既有任务通道轮询）。
          report.textContent = '';
          showToast(`已提交异步学习任务 ${result.task_id}，进度与结果见下方「历史」`);
          statusLine.textContent = `学习任务 ${result.task_id} 已提交${
            result.status === 'completed' ? '（去重命中，已完成）' : ''
          }，进度与结果见下方「历史」`;
          if (histLoaded) loadHistory();
          else setHistoryOpen(true);
        } else {
          renderReport(report, result);
          if (write) {
            showToast(result.status === 'ok'
              ? `反馈学习完成${journalNote}`
              : `学习未写入：${result.message || '未知原因'}`, result.status === 'ok' ? undefined : 'error');
          } else {
            showToast('差异预览完成 — 未写入配置');
          }
          statusLine.textContent = write
            ? (result.status === 'ok' ? `学习完成，已写入反馈档案${journalNote}` : '学习未写入')
            : '预览完成（dry_run，未写入）';
        }
      } catch (err) {
        statusLine.textContent = '';
        showToast(`${write ? '学习' : '预览'}失败：${err.message}`, 'error');
      } finally {
        setBusy(null);
      }
    }

    previewBtn.addEventListener('click', () => run(false));
    learnBtn.addEventListener('click', () => run(true));

    // ---- 自动学习开关（D24，全局设置，默认关）----
    // 开启后导出字幕成功即自动执行与「确认学习」完全相同的上送（触发点在 toolbar 的
    // 导出成功回调 → autoLearnAfterExport），仅 toast 告知；离线时跳过并一次性提示。
    const autoLearnInput = el('input', {
      type: 'checkbox',
      'data-no-panel-drag': '',
      onchange: () => setAutoLearnEnabled(autoLearnInput.checked),
    });
    autoLearnInput.checked = isAutoLearnEnabled();
    const autoLearnRow = el('div', { class: 'pipe-row' },
      el('label', {
        class: 'pipe-label',
        title: '全局设置（默认关）：开启后每次导出字幕成功即自动执行与「确认学习」完全相同的上送（含编辑日志），仅提示告知、不再弹确认；8613 离线时跳过。',
      }, autoLearnInput, '导出后自动学习'));

    // ---- 学习历史（D29，默认折叠）----
    // 数据源全部为既有 API：进行中任务走 GET /api/tasks（内存任务通道，异步学习任务带
    // task_type="learn"），进度详情轮询走既有 GET /api/tasks/{id}（与管线面板同款
    // setTimeout 轮询，2000ms，面板关闭/折叠即停）；最近记录走持久化 GET /api/history
    // 客户端过滤 learn 类型，报告逐条取自 GET /api/history/{id} 的 learn_report。
    const histToggleBtn = el('button', { class: 'btn pipe-small', type: 'button', text: '历史 ▸' });
    const histStatus = el('div', { class: 'pipe-hint', text: '' });
    const activeBox = el('div', { class: 'learn-history-active' });
    const recordsBox = el('div', { class: 'learn-history-records' });
    const governanceBtn = el('button', {
      class: 'btn pipe-small', type: 'button', text: '在 8613 查看治理',
      title: '健康趋势 / 审核队列 / 参数回滚在处理台的反馈档案工作区（新开页签）',
      onclick: () => window.open(pipeline.governanceUrl(), '_blank', 'noopener'),
    });
    const histBody = el('div', { class: 'learn-history-body', hidden: '' },
      histStatus, activeBox, recordsBox,
      el('div', { class: 'pipe-row' },
        governanceBtn,
        el('span', { class: 'pipe-hint', text: '完整治理视图（健康趋势/审核队列/回滚）在处理台，编辑台不重复建设' })));
    const historySection = el('div', { class: 'learn-history' },
      el('div', { class: 'pipe-row' }, histToggleBtn), histBody);

    let histLoaded = false; // 本次面板生命周期内已拉取过（避免反复展开重复请求）
    let histLoading = false;
    let histQueued = false; // 拉取期间的再拉请求（如轮询到终态）合并为一次补拉

    function setHistoryOpen(open) {
      histBody.hidden = !open;
      histToggleBtn.textContent = open ? '历史 ▾' : '历史 ▸';
      if (open && !histLoaded) {
        histLoaded = true;
        loadHistory();
      }
    }
    histToggleBtn.addEventListener('click', () => setHistoryOpen(histBody.hidden));

    // 进行中的异步学习任务：逐个起 setTimeout 轮询（复用既有任务详情通道），面板关闭
    // （DOM 脱离）或折叠即自停；任务到终态后重拉一次历史区（进度行消失、新记录出现）。
    function renderActiveLearnTasks(tasks) {
      const active = activeLearnTasks(tasks);
      activeBox.textContent = '';
      for (const task of active) {
        const text = el('div', { class: 'pipe-progress-text', text: '学习中…' });
        const bar = el('div', { class: 'pipe-progress-bar', style: 'width:0%' });
        activeBox.append(el('div', { class: 'learn-history-active-task' },
          el('div', { class: 'pipe-hint', text: `进行中的学习任务 ${task.task_id}（${task.scenario || '—'}）` }),
          el('div', { class: 'pipe-progress' }, text, el('div', { class: 'pipe-progress-track' }, bar))));
        pollActiveLearnTask(task.task_id, { text, bar });
      }
    }

    function activeStill() {
      return body.isConnected && !histBody.hidden;
    }

    async function pollActiveLearnTask(taskId, nodes) {
      let task = null;
      try {
        task = await pipeline.taskStatus(taskId);
      } catch {
        // 单次查询失败不打断：下一轮重试（离线兜底由 loadHistory 的空态负责）
      }
      if (!activeStill()) return;
      const status = String(task?.status || '');
      if (task && status !== 'pending' && status !== 'running') {
        loadHistory(); // 到终态：刷新整区（错误状态也会反映在记录列表）
        return;
      }
      nodes.text.textContent = learnProgressLabel(task);
      const ratio = task?.progress?.progress;
      nodes.bar.style.width = typeof ratio === 'number'
        ? `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`
        : '0%';
      setTimeout(() => pollActiveLearnTask(taskId, nodes), 2000);
    }

    // 最近 N 次学习记录：头行=场景/时间/状态，报告体复用手动学习的 renderReport
    // （该函数无副作用，只写入传入节点——学习报告结构与手动学习响应一致）
    async function renderLearnRecords(records) {
      for (const record of records) {
        const head = el('div', { class: 'pipe-hint learn-history-head' });
        const reportBox = el('div', { class: 'learn-history-report' });
        recordsBox.append(el('div', { class: 'learn-history-record' }, head, reportBox));
        let report = null;
        try {
          const detail = await pipeline.historyDetail(record.task_id);
          report = detail?.result_summary?.learn_report ?? null;
        } catch {
          // 详情缺失（会话清理/瞬时失败）：退化为列表层摘要，不影响其余记录
        }
        const info = describeLearnRecord(record, report);
        head.append(
          el('span', { class: 'learn-history-scenario', text: info.scenario }),
          ` ${info.when} · ${info.status}`,
        );
        if (report) {
          renderReport(reportBox, report);
        } else {
          head.append(` · 对齐覆盖率 ${info.coverage}`);
          reportBox.append(el('div', {
            class: 'pipe-hint',
            text: info.status === '失败' ? '学习未完成，无学习报告' : '报告详情不可用（任务详情未取到）',
          }));
        }
      }
    }

    async function loadHistory() {
      if (histLoading) {
        histQueued = true;
        return;
      }
      histLoading = true;
      histStatus.textContent = '正在加载学习历史…';
      activeBox.textContent = '';
      recordsBox.textContent = '';
      try {
        const tasks = await pipeline.tasks();
        if (!activeStill()) return;
        renderActiveLearnTasks(tasks);
        const history = await pipeline.history({ limit: HISTORY_FETCH_LIMIT });
        if (!activeStill()) return;
        const records = recentLearnRecords(history?.items, RECENT_LEARN_LIMIT);
        if (!records.length) {
          histStatus.textContent = '暂无学习记录 —— 完成一次「确认学习」或开启「导出后自动学习」后，这里会列出最近的学习结果';
          return;
        }
        histStatus.textContent = `最近 ${records.length} 次学习：`;
        await renderLearnRecords(records);
      } catch (err) {
        if (!body.isConnected) return;
        histStatus.textContent = `离线，无法加载学习历史（${err.message || '请求失败'}）`;
        activeBox.textContent = '';
        recordsBox.textContent = '';
      } finally {
        histLoading = false;
        if (histQueued && body.isConnected && !histBody.hidden) {
          histQueued = false;
          loadHistory();
        } else {
          histQueued = false;
        }
      }
    }

    async function refresh() {
      const detection = await pipeline.detect();
      const online = Boolean(detection.ok);
      statusDot.classList.toggle('pipe-dot-on', online);
      statusDot.classList.toggle('pipe-dot-off', !online);
      statusText.textContent = online
        ? `已连接管线服务 ${pipeline.base}`
        : `未检测到管线服务（${detection.error || '离线'}），学习不可用`;
      previewBtn.disabled = busy || !online;
      learnBtn.disabled = busy || !online;
      if (online && profileSelect.options.length <= 1) {
        try {
          const profiles = await pipeline.profiles();
          profileSelect.textContent = '';
          for (const profile of profiles) {
            profileSelect.append(el('option', { value: profile.name, text: profile.name }));
          }
        } catch {
          // 模板列表拉取失败：保留 default
        }
      }
      // 有进行中的异步学习任务（D28 冷重跑）时自动展开历史区，让进度可见；
      // 探测失败静默（历史区仍可手动展开），用户已自己展开过则不再抢操作。
      if (online && !histLoaded) {
        try {
          const tasks = await pipeline.tasks();
          if (activeLearnTasks(tasks).length) setHistoryOpen(true);
        } catch {
          // 探测失败：不展开、不打扰
        }
      }
    }

    body.append(statusRow, sourceSummary, paramRow,
      el('div', { class: 'pipe-row' }, manualAudioInput, manualSubInput, manualSummary),
      autoLearnRow, actionRow, statusLine, report, hint, historySection);
    refresh();
    // 内容已直接 append 进 body；不能 return body——resolveContent 会把返回值
    // appendChild 进 body（自己装自己 → HierarchyRequestError，面板样式应用中断）。
    return undefined;
  }

  function open() {
    panels.open({
      id: 'feedback',
      title: '学习',
      width: 480,
      height: 400,
      content: (body) => render(body),
    });
  }

  // 启动时探测：8613 离线则隐藏顶栏入口（编辑器离线能力不受影响）
  async function syncAvailability(button) {
    if (!button) return;
    try {
      const detection = await pipeline.detect();
      button.hidden = !detection.ok;
    } catch {
      button.hidden = true;
    }
  }

  // 导出成功回调（D24 自动学习）：toolbar 的 onExported 注入，fire-and-forget——
  // 开关关时直接短路（导出行为与现状完全一致）；内部自带 try/catch，绝不抛错、不阻塞导出。
  function autoLearnAfterExport() {
    return autoLearn.afterExport();
  }

  return { open, syncAvailability, autoLearnAfterExport };
}
