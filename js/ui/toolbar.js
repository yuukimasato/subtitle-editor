// 顶栏：打开文件、拖放、撤销重做、导出、说话人开关、帮助与关于。
import { parseSubtitle, serializeSubtitle, ensureDoc, FORMATS } from '../format/index.js';
import { applySpeakerExport } from '../format/speaker-export.js';
import { showToast } from './toast.js';

const MEDIA_EXT = /\.(mp4|webm|mkv|mov|avi|m4v|mp3|wav|flac|m4a|ogg|opus)$/i;
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
// 说话人开关持久化键：'0'=导出剥离说话人，其余（含未设置）=携带（默认开）
const EXPORT_SPEAKERS_KEY = 'vstEditor.exportSpeakers';

export function speakersIncluded(storage = safeStorage()) {
  try {
    return storage.getItem(EXPORT_SPEAKERS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setSpeakersIncluded(value, storage = safeStorage()) {
  try {
    storage.setItem(EXPORT_SPEAKERS_KEY, value ? '1' : '0');
  } catch {
    // 存储不可用：仅本次会话生效
  }
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function createToolbar({ store, actions, player, waveform, assPreview, draft, journal, flushEdits, onExported }) {
  const mediaInput = document.getElementById('media-input');
  const subtitleInput = document.getElementById('subtitle-input');
  const buttons = {
    openMedia: document.getElementById('btn-open-media'),
    openSubtitle: document.getElementById('btn-open-subtitle'),
    undo: document.getElementById('btn-undo'),
    redo: document.getElementById('btn-redo'),
    help: document.getElementById('btn-help'),
    journal: document.getElementById('btn-journal'),
    about: document.getElementById('btn-about'),
  };
  const exportButtons = new Map(
    [...document.querySelectorAll('[data-export]')].map((b) => [b.dataset.export, b]),
  );
  const helpDialog = document.getElementById('help-dialog');
  const aboutDialog = document.getElementById('about-dialog');
  const journalDialog = document.getElementById('journal-dialog');
  const journalEnabledInput = document.getElementById('journal-enabled');
  const journalStatsEl = document.getElementById('journal-stats');

  buttons.openMedia.addEventListener('click', () => mediaInput.click());
  buttons.openSubtitle.addEventListener('click', () => subtitleInput.click());
  mediaInput.addEventListener('change', () => {
    if (mediaInput.files[0]) openMediaFile(mediaInput.files[0]);
    mediaInput.value = '';
  });
  subtitleInput.addEventListener('change', () => {
    if (subtitleInput.files[0]) openSubtitleFile(subtitleInput.files[0]);
    subtitleInput.value = '';
  });

  // 与 Ctrl+Z/Ctrl+Shift+Z 一致：先落盘未提交的行内编辑再撤销/重做
  buttons.undo.addEventListener('click', () => {
    flushEdits?.();
    actions.undo();
  });
  buttons.redo.addEventListener('click', () => {
    flushEdits?.();
    actions.redo();
  });
  store.on('history', () => {
    buttons.undo.disabled = !actions.history.canUndo;
    buttons.redo.disabled = !actions.history.canRedo;
  });
  buttons.help.addEventListener('click', () => helpDialog.showModal());
  buttons.about.addEventListener('click', () => aboutDialog.showModal());
  exportButtons.forEach((btn, format) => {
    btn.addEventListener('click', () => download(format));
  });

  // ---------- 说话人开关（导出/同步是否携带说话人，默认开） ----------
  const speakersInput = document.getElementById('export-speakers');
  if (speakersInput) {
    speakersInput.checked = speakersIncluded();
    speakersInput.addEventListener('change', () => {
      setSpeakersIncluded(speakersInput.checked);
      showToast(speakersInput.checked ? '导出将携带说话人' : '导出将剥离说话人（编辑数据不受影响）');
    });
  }

  // ---------- 编辑日志（本地行为记录，见 js/journal.js） ----------
  function syncJournalUi() {
    if (!journal) return;
    const stats = journal.stats();
    journalEnabledInput.checked = stats.enabled;
    journalStatsEl.textContent = stats.rotated
      ? `已记录 ${stats.events} 条事件（已轮转最旧 ${stats.rotated} 条，建议导出留档）`
      : `已记录 ${stats.events} 条事件`;
  }
  if (journal) {
    buttons.journal.addEventListener('click', () => {
      syncJournalUi();
      journalDialog.showModal();
    });
    journalEnabledInput.addEventListener('change', () => {
      journal.setEnabled(journalEnabledInput.checked);
      syncJournalUi();
    });
    document.getElementById('btn-journal-export').addEventListener('click', () => {
      const text = journal.exportText();
      if (!text) {
        showToast('当前文件还没有可导出的日志', 'error');
        return;
      }
      const base = (store.state.subtitleName || store.state.mediaName || 'subtitles').replace(/\.[^.]+$/, '');
      downloadTextFile(`${base}.journal.jsonl`, text, 'application/x-ndjson');
      showToast('编辑日志已导出');
      syncJournalUi();
    });
    // 本机 sink 上送（V1.5）：探测 → 批量 POST，服务端按 (session_id, seq) 幂等去重。
    // 惰性 import：不联网的 standalone 用例不加载管线客户端。
    const pushBtn = document.getElementById('btn-journal-push');
    pushBtn?.addEventListener('click', async () => {
      const text = journal.exportText();
      if (!text) {
        showToast('当前文件还没有可上送的日志', 'error');
        return;
      }
      pushBtn.disabled = true;
      try {
        const { createPipelineClient } = await import('../pipeline.js');
        const pipeline = createPipelineClient();
        const detection = await pipeline.detect();
        if (!detection.ok) {
          showToast(`未检测到管线服务（${detection.error || '离线'}），请改用「导出日志」`, 'error');
          return;
        }
        const result = await pipeline.postJournal(text);
        showToast(`日志已上送：接收 ${result.accepted} 条${result.duplicates ? `，去重 ${result.duplicates} 条` : ''}${result.rejected ? `，拒绝 ${result.rejected} 条` : ''}`);
      } catch (err) {
        showToast(`上送失败：${err.message}`, 'error');
      } finally {
        pushBtn.disabled = false;
      }
    });
    document.getElementById('btn-journal-clear').addEventListener('click', () => {
      if (confirm('确定清空当前文件的编辑日志？清空后不可恢复。')) {
        journal.clear();
        syncJournalUi();
      }
    });
  } else {
    buttons.journal.hidden = true;
  }

  // ---------- 文件 ----------
  async function openMediaFile(file) {
    try {
      const url = await player.loadFile(file);
      await waveform.loadMedia(url);
      showToast(`已加载媒体：${file.name}`);
    } catch (err) {
      showToast(`媒体加载失败：${err.message}`, 'error');
    }
  }

  async function openSubtitleFile(file) {
    let text;
    try {
      text = await file.text();
    } catch {
      showToast('无法读取字幕文件', 'error');
      return;
    }
    try {
      const parsed = parseSubtitle(text, { filename: file.name });
      const draftData = draft.lookup(file.name, store.state.mediaName);
      if (
        draftData?.cues?.length &&
        JSON.stringify(draftData.cues) !== JSON.stringify(parsed.cues)
      ) {
        const when = new Date(draftData.savedAt ?? Date.now()).toLocaleString();
        if (confirm(`检测到本地编辑草稿（保存于 ${when}），比文件内容更新。\n\n确定：恢复草稿；取消：放弃草稿并打开文件内容。`)) {
          actions.loadSubtitle(draftData.cues, {
            name: file.name,
            format: draftData.format ?? parsed.format,
            doc: draftData.doc ?? parsed.doc,
          });
          store.patch({ dirty: true });
          showToast('已恢复编辑草稿');
          return;
        }
        // 用户放弃草稿：立即删除，避免下次打开重复弹恢复确认
        draft.discard(file.name, store.state.mediaName);
      }
      actions.loadSubtitle(parsed.cues, {
        name: file.name,
        format: parsed.format,
        doc: parsed.doc,
      });
      showToast(`已加载字幕：${file.name}（${parsed.cues.length} 条）`);
    } catch (err) {
      showToast(`字幕解析失败：${err.message}`, 'error');
    }
  }

  // 拖放：媒体与字幕各取第一个匹配项
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    const media = files.find((f) => f.type.startsWith('video/') || f.type.startsWith('audio/') || MEDIA_EXT.test(f.name));
    const sub = files.find((f) => SUB_EXT.test(f.name));
    if (media) openMediaFile(media);
    if (sub) openSubtitleFile(sub);
  });

  // ---------- 导出 ----------
  function download(format) {
    flushEdits?.(); // 先落盘尚未提交的行内编辑
    const s = store.state;
    if (!s.cues.length) {
      showToast('没有可导出的字幕', 'error');
      return;
    }
    const fmt = FORMATS.some((f) => f.id === format) ? format : 'ass';
    // 说话人开关（默认开）：导出稿按策略携带/剥离说话人；副本变换，编辑数据不动
    const exportCues = applySpeakerExport(s.cues, { format: fmt, include: speakersIncluded() });
    let content;
    try {
      content = serializeSubtitle(fmt, exportCues, ensureDoc(fmt, exportCues, s.subDoc));
    } catch (err) {
      showToast(`导出失败：${err.message}`, 'error');
      return;
    }
    const base = (s.subtitleName || s.mediaName || 'subtitles').replace(/\.[^.]+$/, '') || 'subtitles';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const draftName = s.subtitleName || s.mediaName; // markExported 会改写 subtitleName，先取草稿键名
    actions.markExported(fmt, `${base}.${fmt}`);
    draft.discard(draftName, s.mediaName); // 导出成功即落盘，草稿完成使命
    // 编辑日志搭车导出（账本语义：导出不清空队列，重复导出由摄取端去重）
    let journalNote = '';
    const journalText = journal?.exportText?.();
    if (journalText) {
      downloadTextFile(`${base}.journal.jsonl`, journalText, 'application/x-ndjson');
      journalNote = ' 及编辑日志';
      if (journal.stats().overflow) journalNote += '（日志已达上限，建议尽快留档）';
    }
    showToast(`已导出 ${base}.${fmt}${journalNote}`);
    onExported?.(); // 导出即最新：立即同步一稿到处理台（如已启用）
  }

  function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    exportCurrent: () => download(store.state.subtitleFormat || 'ass'),
    openMediaFile,
    openSubtitleFile,
    speakersIncluded,
  };
}
