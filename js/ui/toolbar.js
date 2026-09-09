// 顶栏：打开文件、拖放、撤销重做、导出、帮助与关于。
import { parseSubtitle, serializeSubtitle, ensureDoc, FORMATS } from '../format/index.js';
import { showToast } from './toast.js';

const MEDIA_EXT = /\.(mp4|webm|mkv|mov|avi|m4v|mp3|wav|flac|m4a|ogg|opus)$/i;
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

export function createToolbar({ store, actions, player, waveform, assPreview, draft, journal, flushEdits }) {
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

  // ---------- 编辑日志（本地行为记录，见 js/journal.js） ----------
  function syncJournalUi() {
    if (!journal) return;
    const stats = journal.stats();
    journalEnabledInput.checked = stats.enabled;
    journalStatsEl.textContent = `已记录 ${stats.events} 条事件${stats.overflow ? '（已达上限，请导出或清空）' : ''}`;
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
    let content;
    try {
      content = serializeSubtitle(fmt, s.cues, ensureDoc(fmt, s.cues, s.subDoc));
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
  };
}
