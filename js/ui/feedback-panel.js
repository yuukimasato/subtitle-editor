// 反馈学习面板（双界面收敛 M2，方案 docs/双界面收敛方案-8613处理台与8631编辑台-2026-09-10.md §4）。
// 学习入口从 8613 webui 迁入编辑器：当前会话的音频 + 校对完成的字幕一键回传学习，
// 编辑日志（edit-journal）顺带上送（sink 按 (session_id, seq) 幂等去重）。
// 手动兜底：选择不在编辑器里的音频 + 修正字幕（服务端 run_pipeline_first 重跑管线对齐）。
// 本模块只做 UI 装配与流程编排，API 细节在 js/pipeline.js；8613 离线时入口按钮隐藏。
import { createPipelineClient, defaultBase, setDefaultBase } from '../pipeline.js';
import { serializeSubtitle, ensureDoc } from '../format/index.js';
import { showToast } from './toast.js';

export function createFeedbackPanel({ store, panels, journal, getMediaFile } = {}) {
  let pipeline = createPipelineClient();
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

  // ---- 学习来源 ----
  // 一键：当前会话（媒体 + 当前 cue 序列化为 SRT）；兜底：手动选择的文件。
  async function gatherSource() {
    if (manualAudio && manualSub) {
      return { audio: manualAudio, reference: manualSub, fromSession: false };
    }
    const media = getMediaFile?.();
    if (!media) throw new Error('当前没有已加载的音频，请先打开媒体或改用手动选择文件');
    const cues = store.state.cues;
    if (!cues.length) throw new Error('当前没有字幕 cue，请先打开或校对字幕');
    const srt = serializeSubtitle('srt', cues, ensureDoc('srt', cues, store.state.subDoc));
    const base = (store.state.subtitleName || store.state.mediaName || 'edited').replace(/\.[^.]+$/, '');
    const reference = new File([srt], `${base}_edited.srt`, { type: 'text/plain' });
    return { audio: media, reference, fromSession: true };
  }

  function sessionSummary() {
    const media = getMediaFile?.();
    const cues = store.state.cues?.length ?? 0;
    if (!media || !cues) return '当前会话：尚未同时具备音频与字幕';
    const journalNote = journal?.stats?.().events ?? 0;
    return `当前会话：${media.name} + ${cues} 条 cue（日志 ${journalNote} 条事件）`;
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
      text: '学习会先在服务端跑一遍管线提取自动字幕（耗时较长），建议先「预览差异」再「确认学习」。' });

    function setBusy(stage) {
      busy = Boolean(stage);
      previewBtn.disabled = busy;
      learnBtn.disabled = busy;
      statusLine.textContent = stage ?? '';
    }

    async function run(write) {
      if (busy) return;
      let source;
      try {
        source = await gatherSource();
      } catch (err) {
        showToast(err.message, 'error');
        return;
      }
      setBusy(write ? '学习中（服务端先跑管线，可能需要几分钟）…' : '预览分析中（服务端先跑管线）…');
      try {
        const result = await pipeline.learn(source.audio, source.reference, {
          profile: profileSelect.value,
          feedbackProfile: fbProfileInput.value.trim() || 'user_default',
          dryRun: !write,
        });
        renderReport(report, result);
        let journalNote = '';
        if (write && source.fromSession) {
          journalNote = await pushJournalQuietly();
        }
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
      } catch (err) {
        statusLine.textContent = '';
        showToast(`${write ? '学习' : '预览'}失败：${err.message}`, 'error');
      } finally {
        setBusy(null);
      }
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

    previewBtn.addEventListener('click', () => run(false));
    learnBtn.addEventListener('click', () => run(true));

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
    }

    body.append(statusRow, sourceSummary, paramRow,
      el('div', { class: 'pipe-row' }, manualAudioInput, manualSubInput, manualSummary),
      actionRow, statusLine, report, hint);
    refresh();
    return body;
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

  return { open, syncAvailability };
}
