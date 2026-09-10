// 管线面板（方案 P3/D2/D8）：提交任务 → 看进度 → 载入产物 → 精修 → 导出的审核工作流。
// feature-detect localhost 后端（journal sink 202 即在线）；产物载入后把
// review-manifest-v1 的 per-cue 出处标注到 cue 上，供编辑日志记录 provenance。
// 本模块只做 UI 装配与流程编排，API 细节在 js/pipeline.js。
import { createPipelineClient, defaultBase, setDefaultBase } from '../pipeline.js';
import { showToast } from './toast.js';

const SUBTITLE_VERSION_LABEL = { clean: 'ASR 干净版', llm: 'LLM 优化版' };

// manifest.cues[i].index（1 起的行序号）→ cue.provenance；
// 拆分/合并产生的新行没有对应 index，保持无出处（学习侧接受为 null）。
export function annotateProvenance(cues, manifest) {
  if (!manifest || !Array.isArray(manifest.cues)) return 0;
  const byIndex = new Map(manifest.cues.map((cue) => [cue.index, cue]));
  let matched = 0;
  cues.forEach((cue, position) => {
    const source = byIndex.get(position + 1);
    if (!source) {
      delete cue.provenance;
      return;
    }
    cue.provenance = {
      source_stage: source.source_stage ?? null,
      confidence: source.confidence ?? null,
      ...(source.speaker_id !== undefined && source.speaker_id !== null
        ? { speaker_id: source.speaker_id } : {}),
      ...(source.speaker_label ? { speaker_label: source.speaker_label } : {}),
    };
    matched += 1;
  });
  return matched;
}

export function createPipelinePanel({ store, panels, openMediaFile, openSubtitleFile, client } = {}) {
  let pipeline = client ?? createPipelineClient();
  let input = null; // {file, taskId, manifest, pollTimer, disposed}

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

  function render(body) {
    body.textContent = '';

    // ---- 连接状态 ----
    const statusDot = el('span', { class: 'pipe-dot', 'aria-hidden': 'true' });
    const statusText = el('span', { class: 'pipe-status-text', text: '正在探测本地管线服务…' });
    const baseInput = el('input', {
      class: 'pipe-base',
      type: 'url',
      value: defaultBase(),
      'aria-label': '管线服务地址',
      'data-no-panel-drag': '',
    });
    baseInput.addEventListener('change', () => {
      const next = baseInput.value.trim().replace(/\/+$/, '');
      if (next && next !== pipeline.base) {
        setDefaultBase(next);
        pipeline = createPipelineClient({ base: next });
        input = null;
        refresh();
      }
    });
    const reconnectBtn = el('button', { class: 'btn pipe-small', type: 'button', text: '重连', onclick: () => {
      const next = baseInput.value.trim().replace(/\/+$/, '');
      setDefaultBase(next);
      pipeline = createPipelineClient({ base: next });
      input = null;
      refresh();
    } });
    const statusRow = el('div', { class: 'pipe-row pipe-status' }, statusDot, statusText, baseInput, reconnectBtn);

    // ---- 提交表单 ----
    const profileSelect = el('select', { class: 'pipe-select', 'aria-label': '场景模板', 'data-no-panel-drag': '' },
      el('option', { value: 'default', text: 'default' }));
    const formatSelect = el('select', { class: 'pipe-select', 'aria-label': '输出格式', 'data-no-panel-drag': '' },
      ...['srt', 'vtt', 'ass'].map((fmt) => el('option', { value: fmt, text: fmt })));
    const fileInput = el('input', {
      class: 'pipe-file', type: 'file', accept: 'audio/*,video/*,.mp3,.wav,.flac,.m4a,.mp4,.mkv,.mov',
      'aria-label': '选择音视频文件', 'data-no-panel-drag': '',
    });
    const fileName = el('span', { class: 'pipe-file-name', text: '未选择文件' });
    fileInput.addEventListener('change', () => {
      fileName.textContent = fileInput.files[0]?.name ?? '未选择文件';
      submitBtn.disabled = !fileInput.files[0] || !input?.online;
    });
    const submitBtn = el('button', { class: 'btn btn-primary pipe-submit', type: 'button', text: '提交管线', disabled: '' });
    submitBtn.addEventListener('click', () => submit());
    const formRow = el('div', { class: 'pipe-row' },
      el('label', { class: 'pipe-label' }, '模板', profileSelect),
      el('label', { class: 'pipe-label' }, '格式', formatSelect),
    );
    const fileRow = el('div', { class: 'pipe-row' }, fileInput, fileName, submitBtn);

    // ---- 进度 ----
    const progressText = el('div', { class: 'pipe-progress-text', text: '' });
    const progressBar = el('div', { class: 'pipe-progress-bar', style: 'width:0%' });
    const progress = el('div', { class: 'pipe-progress', hidden: '' }, progressText,
      el('div', { class: 'pipe-progress-track' }, progressBar));

    // ---- 产物载入 ----
    const loadBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '载入字幕精修', hidden: '' });
    const loadMediaBtn = el('button', { class: 'btn', type: 'button', text: '载入原声', hidden: '' });
    const manifestInfo = el('span', { class: 'pipe-hint', text: '' });
    const resultRow = el('div', { class: 'pipe-row pipe-result' }, loadBtn, loadMediaBtn, manifestInfo);
    const hint = el('div', { class: 'pipe-hint pipe-flow-hint',
      text: '流程：选择音视频 → 提交管线 → 完成后载入字幕与原声 → 精修 → 顶部导出（日志搭车）。' });

    function setStatus(online, text) {
      statusDot.classList.toggle('pipe-dot-on', online);
      statusDot.classList.toggle('pipe-dot-off', !online);
      statusText.textContent = text;
      submitBtn.disabled = !online || !fileInput.files[0] || Boolean(input?.taskId);
      if (input) input.online = online;
    }

    async function refresh() {
      const detection = await pipeline.detect();
      setStatus(detection.ok,
        detection.ok ? `已连接管线服务 ${pipeline.base}` : `未检测到管线服务（${detection.error || '离线'}）`);
      if (detection.ok && profileSelect.options.length <= 1) {
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

    function setProgress(text, ratio = null) {
      progress.hidden = !text;
      progressText.textContent = text;
      progressBar.style.width = ratio == null ? '100%' : `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    }

    async function submit() {
      const file = fileInput.files[0];
      if (!file || input?.disposed) return;
      submitBtn.disabled = true;
      setProgress('正在上传…');
      try {
        const { task_id: taskId } = await pipeline.submit(file, {
          profile: profileSelect.value,
          format: formatSelect.value,
        });
        input = { ...(input ?? {}), file, taskId, online: true };
        setProgress(`任务 ${taskId} 已提交，等待管线…`, 0);
        poll(taskId);
      } catch (err) {
        setProgress('');
        showToast(`提交失败：${err.message}`, 'error');
        submitBtn.disabled = false;
      }
    }

    async function poll(taskId) {
      if (input?.disposed) return; // 面板已销毁：停止轮询，不再写已脱离的 DOM
      try {
        const task = await pipeline.taskStatus(taskId);
        if (input?.disposed) return;
        if (task.status === 'completed' || task.status === 'degraded_completed') {
          setProgress('管线完成，可以载入产物', 1);
          await prepareResult(taskId);
          return;
        }
        if (task.status === 'failed') {
          setProgress('');
          showToast(`管线任务失败：${task.error || '未知错误'}`, 'error');
          submitBtn.disabled = false;
          return;
        }
        const stage = task.progress?.description || task.progress?.stage;
        setProgress(stage ? `处理中：${stage}` : '处理中…', task.progress?.progress ?? null);
      } catch (err) {
        if (input?.disposed) return;
        setProgress('');
        showToast(`查询进度失败：${err.message}`, 'error');
        submitBtn.disabled = false;
        return;
      }
      // 输入被重置（换地址/重渲染）时不再续订下一轮
      if (input) input.pollTimer = setTimeout(() => poll(taskId), 1500);
    }

    async function prepareResult(taskId) {
      try {
        const manifest = await pipeline.manifest(taskId).catch(() => null);
        input = { ...(input ?? {}), taskId, manifest };
        loadBtn.hidden = false;
        loadMediaBtn.hidden = false;
        const runId = manifest?.run_id || taskId;
        manifestInfo.textContent = manifest
          ? `run ${runId} · ${manifest.cues?.length ?? 0} 条出处`
          : '未取得 manifest（provenance 将记为空）';
      } catch {
        loadBtn.hidden = false;
        loadMediaBtn.hidden = false;
      }
    }

    async function loadResult(version = 'clean') {
      const current = input;
      if (!current?.taskId) return;
      try {
        const res = await fetch(pipeline.subtitleUrl(current.taskId, version));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const name = `${(current.file?.name ?? 'subtitle').replace(/\.[^.]+$/, '')}_${version}.srt`;
        await openSubtitleFile(new File([text], name, { type: 'text/plain' }));
        // 载入后按行序标注 manifest 出处（openSubtitleFile 同步重建 cues）
        if (current.manifest) {
          const matched = annotateProvenance(store.state.cues, current.manifest);
          store.patch({ pipelineRun: { taskId: current.taskId, runId: current.manifest.run_id ?? null } });
          showToast(`已标注 ${matched} 条 cue 出处`);
        }
      } catch (err) {
        showToast(`载入字幕失败：${err.message}`, 'error');
      }
    }

    async function loadMedia() {
      const current = input;
      if (!current?.taskId) return;
      try {
        const res = await fetch(pipeline.mediaStreamUrl(current.taskId));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const name = current.file?.name ?? 'media.wav';
        await openMediaFile(new File([blob], name));
      } catch (err) {
        showToast(`载入原声失败：${err.message}`, 'error');
      }
    }

    loadBtn.addEventListener('click', () => loadResult('clean'));
    loadMediaBtn.addEventListener('click', () => loadMedia());

    body.append(statusRow, formRow, fileRow, progress, resultRow, hint);
    refresh();
    return body;
  }

  function open() {
    panels.open({
      id: 'pipeline',
      title: '管线',
      width: 460,
      height: 260,
      content: (body) => render(body),
    });
  }

  function dispose() {
    clearTimeout(input?.pollTimer);
    if (input) input.disposed = true;
  }

  return { open, dispose, annotate: (cues, manifest) => annotateProvenance(cues, manifest) };
}
