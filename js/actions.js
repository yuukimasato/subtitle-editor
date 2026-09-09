// 字幕变更动作集合。所有可撤销的变更都经过 commit()：先推快照，再写 store。
// 行操作（插入/重复/剪切/复制/粘贴/删除）与 Aegisub 语义对齐：作用于多选行。
import { History } from './history.js';
import { sortCues, findCueAt, indexAfter } from './format/cue.js';
import { makeNewCue, withCueStyle, cueStyle, classifyClipboard, ParseError } from './format/index.js';
import { formatSrtTime } from './format/time.js';

const MIN_LEN = 0.05;
const BLANK_LEN = 5; // 「插入(之前/之后)」空白行与纯文本粘贴新行的时长(秒)

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function clampEnd(start, end) {
  return Math.max(end, start + MIN_LEN);
}

// deps.readClipboardText 可注入（单测用）；默认读系统剪贴板
// deps.journal 编辑日志（js/journal.js）：commit 时记录字段级 diff 与上下文，可选
export function createActions(store, deps = {}) {
  const journal = deps.journal ?? null;
  const history = new History();
  let clipboard = []; // 内部行剪贴板：{start, end, text, meta?}

  function selectionIds() {
    return store.state.selectedIds ?? (store.state.selectedId ? [store.state.selectedId] : []);
  }

  function pruneSelection(next) {
    const ids = selectionIds().filter((id) => next.some((c) => c.id === id));
    const anchor = store.state.selectedId && ids.includes(store.state.selectedId)
      ? store.state.selectedId
      : ids[0] ?? null;
    return { selectedIds: ids, selectedId: anchor };
  }

  // coalesceKey：相同键的连续提交合并为一个撤销步骤（音频盒自动提交用）。
  // 合并命中时快照会被 push 丢弃，先判断再克隆，省掉自动提交拖拽中每帧的整表深拷贝。
  // command：触发本次提交的动作名，透传给编辑日志（journal.record）。
  function commit(next, extra = {}, coalesceKey = null, command = null) {
    const before = store.state.cues;
    const snapshot = history.wouldCoalesce(coalesceKey) ? before : structuredClone(before);
    history.push(snapshot, { coalesceKey });
    journal?.record({ command, coalesceKey, before, after: next });
    store.patch({ cues: next, dirty: history.isDirty, ...pruneSelection(next), ...extra });
    store.emit('selection');
    store.emit('history');
  }

  function setSelection(ids) {
    store.patch({ selectedIds: ids, selectedId: ids[ids.length - 1] ?? null });
    store.emit('selection');
  }

  function resolveCue(id) {
    const cue = store.state.cues.find((c) => c.id === (id ?? store.state.selectedId));
    return cue ?? null;
  }

  // 选中的行按 cue 顺序展开；ids 缺省时取当前多选
  function orderedSelection(ids) {
    const wanted = new Set(ids?.length ? ids : selectionIds());
    return store.state.cues.filter((c) => wanted.has(c.id));
  }

  // ---------- 系统剪贴板同步（尽力而为，失败仅用内部剪贴板） ----------
  function copySystemClipboard(list) {
    const text = list
      .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${String(c.text ?? '')}`)
      .join('\n\n');
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
      navigator.clipboard.writeText(text).catch(() => {});
    } catch {
      // file:// 或权限受限：忽略
    }
  }

  function readSystemClipboard() {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return null;
    return navigator.clipboard.readText();
  }

  // 系统剪贴板 → 内部行条目：字幕条目 {start,end,text}，纯文本条目无时间（start/end=null）。
  // 嗅探成功但解析失败（残缺字幕）时抛出 ParseError 交由调用方提示；权限被拒等返回 false。
  async function loadExternalClipboard() {
    try {
      const text = await (deps.readClipboardText ? deps.readClipboardText() : readSystemClipboard());
      if (!text) return false;
      const parsed = classifyClipboard(text);
      if (!parsed) return false;
      clipboard = parsed.kind === 'subtitle'
        ? parsed.cues.map((c) => ({
          start: c.start,
          end: c.end,
          text: c.text,
          ...(c.meta ? { meta: structuredClone(c.meta) } : {}),
        }))
        : parsed.lines.map((line) => ({ start: null, end: null, text: line }));
      return true;
    } catch (err) {
      if (err instanceof ParseError) throw err;
      return false;
    }
  }

  const api = {
    history,

    canUndo() {
      return history.canUndo;
    },

    // 撤销栈深度（window.agent.getSnapshot 的 history.depth 用：核对 coalesce 是否生效）
    historyDepth() {
      return history.past.length;
    },

    undo() {
      const snap = history.undo(structuredClone(store.state.cues));
      if (!snap) return false;
      store.patch({ cues: snap, dirty: history.isDirty, editingId: null, ...pruneSelection(snap) });
      store.emit('selection');
      store.emit('history');
      return true;
    },

    redo() {
      const snap = history.redo(structuredClone(store.state.cues));
      if (!snap) return false;
      store.patch({ cues: snap, dirty: history.isDirty, editingId: null, ...pruneSelection(snap) });
      store.emit('selection');
      store.emit('history');
      return true;
    },

    // 打开字幕文件：清空历史
    loadSubtitle(cues, { name, format, doc }) {
      history.clear();
      const sorted = sortCues(cues);
      store.patch({
        cues: sorted,
        subDoc: doc,
        subtitleFormat: format,
        subtitleName: name,
        dirty: false,
        editingId: null,
        selectedIds: sorted[0] ? [sorted[0].id] : [],
        selectedId: sorted[0]?.id ?? null,
      });
      store.emit('selection');
      store.emit('history');
    },

    // mode: single=单选并定位锚点；toggle=Ctrl 加选/取消；range=Shift 从锚点到此处连选
    select(id, { mode = 'single' } = {}) {
      const cues = store.state.cues;
      if (!cues.some((c) => c.id === id)) return;
      if (mode === 'toggle') {
        const set = new Set(selectionIds());
        if (set.has(id)) set.delete(id);
        else set.add(id);
        setSelection(cues.filter((c) => set.has(c.id)).map((c) => c.id));
        return;
      }
      if (mode === 'range') {
        const anchor = store.state.selectedId ?? id;
        const a = cues.findIndex((c) => c.id === anchor);
        const b = cues.findIndex((c) => c.id === id);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        setSelection(cues.slice(lo, hi + 1).map((c) => c.id));
        return;
      }
      setSelection([id]);
    },

    selectAll() {
      setSelection(store.state.cues.map((c) => c.id));
    },

    selectNeighbour(delta, fallbackTime) {
      const cues = store.state.cues;
      if (!cues.length) return null;
      const current = store.selectedCue() ?? findCueAt(cues, fallbackTime ?? -1);
      let index = current ? cues.indexOf(current) + delta : delta > 0 ? 0 : cues.length - 1;
      index = clamp(index, 0, cues.length - 1);
      const cue = cues[index];
      setSelection([cue.id]);
      return cue;
    },

    setEditing(id) {
      if (id) setSelection([id]);
      store.patch({ editingId: id });
    },

    // 行内编辑统一入口：文本与时间合并为一次撤销快照
    updateCue(id, patch = {}) {
      const cue = resolveCue(id);
      if (!cue) return false;
      const next = { ...cue };
      if (patch.text !== undefined && patch.text !== cue.text) next.text = patch.text;
      if (patch.start !== undefined || patch.end !== undefined) {
        const start = patch.start ?? cue.start;
        const end = patch.end ?? cue.end;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
        next.start = Math.max(0, start);
        next.end = end;
      }
      if (next.start === cue.start && next.end === cue.end && next.text === cue.text) return false;
      commit(sortCues(store.state.cues.map((c) => (c.id === cue.id ? next : c))), {}, null, 'updateCue');
      return true;
    },

    // 修改 ASS 样式（作用于多选行，一次撤销快照）；非 ASS cue（无 meta/样式字段）忽略
    updateCueStyle(ids, style) {
      const wanted = new Set(ids?.length ? ids : selectionIds());
      if (!wanted.size) return false;
      let changed = false;
      const next = store.state.cues.map((cue) => {
        if (!wanted.has(cue.id)) return cue;
        const updated = withCueStyle(cue, style);
        if (!updated || cueStyle(cue) === style) return cue;
        changed = true;
        return updated;
      });
      if (!changed) return false;
      commit(next, {}, null, 'updateCueStyle');
      return true;
    },

    updateCueTimes(id, start, end, { coalesceKey = null } = {}) {
      const cue = resolveCue(id);
      if (!cue) return false;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
      if (start < 0) start = 0;
      if (cue.start === start && cue.end === end) return false;
      commit(
        sortCues(store.state.cues.map((c) => (c.id === cue.id ? { ...c, start, end } : c))),
        {},
        coalesceKey,
        'updateCueTimes',
      );
      return true;
    },

    // 音频盒提交：批量写多行时间，合并为一次撤销快照（Aegisub「提交」语义）。
    // entries = [{id, start, end}]，由调用方保证 end > start；
    // coalesceKey 用于自动提交的连续写入合并为一个撤销步骤。
    updateCueTimesBulk(entries, { coalesceKey = null } = {}) {
      const wanted = new Map(
        entries
          .filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end))
          .map((e) => [e.id, e]),
      );
      if (!wanted.size) return false;
      let changed = false;
      const next = store.state.cues.map((cue) => {
        const patch = wanted.get(cue.id);
        if (!patch) return cue;
        const start = Math.max(0, patch.start);
        const end = Math.max(start + 0.001, patch.end);
        if (start === cue.start && end === cue.end) return cue;
        changed = true;
        return { ...cue, start, end };
      });
      if (!changed) return false;
      commit(sortCues(next), {}, coalesceKey, 'updateCueTimesBulk');
      return true;
    },

    // 小键盘微调：which = 'start' | 'end'
    nudge(id, which, delta) {
      const cue = resolveCue(id);
      if (!cue || !delta) return false;
      let { start, end } = cue;
      if (which === 'start') {
        start = clamp(start + delta, 0, end - MIN_LEN);
      } else {
        end = Math.max(start + MIN_LEN, end + delta);
      }
      if (start === cue.start && end === cue.end) return false;
      commit(sortCues(store.state.cues.map((c) => (c.id === cue.id ? { ...c, start, end } : c))), {}, null, 'nudge');
      return true;
    },

    // 播放头处插入；与下一句重叠时缩短
    insertAtTime(t) {
      const cues = store.state.cues;
      const next = cues.find((c) => c.start > t);
      let end = t + 2;
      if (next && next.start < end) end = Math.max(t + MIN_LEN, next.start);
      const cue = makeNewCue(store.state.subtitleFormat, store.state.subDoc, t, end, '');
      commit(sortCues([...cues, cue]), {}, null, 'insertAtTime');
      setSelection([cue.id]);
      return cue;
    },

    // 在参考行的前/后插入 5 秒空白行（Aegisub「插入」）：
    // 之前 = 占用参考行开始前的 5 秒；之后 = 占用参考行结束后的 5 秒。
    // videoTime 给定时（「以视频时间插入」）新行起止均为视频时间（零时长行），
    // 没有参考行时按时间序插入。
    insertRelativeTo(refId, { after = false, videoTime = null, coalesceKey = null } = {}) {
      const cues = store.state.cues;
      const ref = cues.find((c) => c.id === refId) ?? null;
      if (!ref && videoTime === null) return null;
      let start;
      let end;
      if (videoTime !== null) {
        start = Math.max(0, videoTime);
        end = start; // 零时长行，随后由用户调整
      } else if (after) {
        start = ref.end;
        end = start + BLANK_LEN;
      } else {
        end = ref.start;
        start = Math.max(0, end - BLANK_LEN);
      }
      const cue = makeNewCue(store.state.subtitleFormat, store.state.subDoc, start, end, '');
      let at;
      if (ref) at = cues.indexOf(ref) + (after ? 1 : 0);
      else at = indexAfter(cues, start);
      const next = [...cues];
      next.splice(at, 0, cue);
      // 稳定排序：相同时间键保持插入的相对位置；coalesceKey 供「提交并新建」等多步操作合并撤销
      commit(sortCues(next), {}, coalesceKey, 'insertRelativeTo');
      setSelection([cue.id]);
      return cue;
    },

    duplicateCues(ids) {
      const cues = store.state.cues;
      const wanted = new Set(ids?.length ? ids : selectionIds());
      if (!wanted.size) return false;
      const clones = new Map();
      const next = [];
      cues.forEach((cue) => {
        next.push(cue);
        if (wanted.has(cue.id)) {
          const copy = makeNewCue(
            store.state.subtitleFormat,
            store.state.subDoc,
            cue.start,
            clampEnd(cue.start, cue.end),
            cue.text,
          );
          if (cue.meta) copy.meta = structuredClone(cue.meta);
          clones.set(cue.id, copy);
          next.push(copy);
        }
      });
      commit(sortCues(next), {}, null, 'duplicateCues');
      setSelection(cues.filter((c) => wanted.has(c.id)).map((c) => clones.get(c.id).id));
      return true;
    },

    removeCues(ids) {
      const wanted = new Set(ids?.length ? ids : selectionIds());
      if (!wanted.size) return false;
      const cues = store.state.cues;
      const firstIdx = cues.findIndex((c) => wanted.has(c.id));
      const rest = cues.filter((c) => !wanted.has(c.id));
      commit(rest, { editingId: null }, null, 'removeCues');
      const fallback = rest[Math.min(Math.max(firstIdx, 0), rest.length - 1)] ?? null;
      setSelection(fallback ? [fallback.id] : []);
      return true;
    },

    removeCue(id) {
      return api.removeCues([id]);
    },

    // 在 atTime（通常为播放头）处拆分；时间比例决定文本切分点
    splitCue(id, atTime) {
      const cue = resolveCue(id);
      if (!cue) return false;
      let at = atTime;
      if (!(at > cue.start + MIN_LEN && at < cue.end - MIN_LEN)) {
        at = (cue.start + cue.end) / 2;
      }
      const ratio = (at - cue.start) / (cue.end - cue.start);
      const cut = clamp(Math.round(cue.text.length * ratio), 0, cue.text.length);
      const headText = cue.text.slice(0, cut);
      const tailText = cue.text.slice(cut);
      const tail = makeNewCue(
        store.state.subtitleFormat,
        store.state.subDoc,
        at,
        cue.end,
        tailText,
      );
      const head = { ...cue, end: at, text: headText };
      if (cue.meta) {
        head.meta = { ...cue.meta, parts: [...cue.meta.parts] };
        tail.meta = { ...cue.meta, parts: [...cue.meta.parts] };
      }
      commit(sortCues([
        ...store.state.cues.filter((c) => c.id !== cue.id),
        head,
        tail,
      ]), {}, null, 'splitCue');
      setSelection([tail.id]);
      return true;
    },

    mergeWithNext(id) {
      const cues = store.state.cues;
      const cue = resolveCue(id);
      if (!cue) return false;
      const index = cues.indexOf(cue);
      if (index === -1 || index === cues.length - 1) return false;
      const next = cues[index + 1];
      const merged = {
        ...cue,
        end: Math.max(cue.end, next.end),
        text: `${cue.text}${cue.text && next.text ? '\n' : ''}${next.text}`,
      };
      if (cue.meta) merged.meta = { ...cue.meta, parts: [...cue.meta.parts] };
      commit(sortCues(cues.filter((c) => c.id !== next.id).map((c) => (c.id === cue.id ? merged : c))), {}, null, 'mergeWithNext');
      return true;
    },

    // ---------- 行剪贴板 ----------
    canPaste() {
      return clipboard.length > 0;
    },

    // 确保剪贴板已加载（内部为空时读系统剪贴板），返回内容类别；
    // null = 无可粘贴内容（读取失败或剪贴板为空）
    async clipboardKind() {
      if (!clipboard.length && !(await loadExternalClipboard())) return null;
      return clipboard.some((item) => item.start === null) ? 'text' : 'subtitle';
    },

    copyCues(ids) {
      const list = orderedSelection(ids);
      if (!list.length) return false;
      clipboard = list.map((c) => ({
        start: c.start,
        end: c.end,
        text: c.text,
        ...(c.meta ? { meta: structuredClone(c.meta) } : {}),
      }));
      copySystemClipboard(list);
      return true;
    },

    cutCues(ids) {
      const list = orderedSelection(ids);
      if (!list.length) return false;
      if (!api.copyCues(list.map((c) => c.id))) return false;
      return api.removeCues(list.map((c) => c.id));
    },

    // 在参考行后（或按时间序）插入剪贴板行，选中新插入的行。
    // 纯文本条目（无时间）：从参考行结束处（无参考行则播放头/文档开头）起
    // 每行顺序占位 BLANK_LEN 秒，首尾相接互不重叠，随后由用户逐句打轴。
    async pasteCues({ refId = null, after = true, videoTime = null } = {}) {
      if (!clipboard.length && !(await loadExternalClipboard())) return null;
      const cues = store.state.cues;
      const ref = cues.find((c) => c.id === refId) ?? null;
      let clock = null; // 纯文本顺序占位游标，惰性初始化
      const inserts = clipboard.map((item) => {
        let start = item.start;
        let end = item.end;
        if (start === null) {
          if (clock === null) clock = ref ? ref.end : Math.max(0, videoTime ?? 0);
          start = clock;
          end = clock + BLANK_LEN;
          clock = end;
        }
        const cue = makeNewCue(
          store.state.subtitleFormat,
          store.state.subDoc,
          start,
          clampEnd(start, end),
          item.text,
        );
        if (item.meta) cue.meta = structuredClone(item.meta);
        return cue;
      });
      let at;
      if (ref) at = cues.indexOf(ref) + (after ? 1 : 0);
      else if (videoTime !== null) at = indexAfter(cues, Math.max(0, videoTime));
      else at = cues.length;
      const next = [...cues];
      next.splice(at, 0, ...inserts);
      commit(sortCues(next), {}, null, 'pasteCues');
      setSelection(inserts.map((c) => c.id));
      return inserts;
    },

    // 选择性粘贴（Aegisub 语义）：从参考行起逐行覆盖勾选字段，
    // 剪贴板行多于剩余行时在末尾追加新行（新行文本未勾选时留空，时间始终取剪贴板值）。
    // 纯文本剪贴板没有可覆盖的时间字段，直接委托为按行新建。
    // 返回 { ok: true, skipped }（skipped = 时间非法被跳过的行数）或 false（无变化）。
    async pasteSpecial(fields, { refId = null, videoTime = null } = {}) {
      if (!clipboard.length && !(await loadExternalClipboard())) return false;
      if (clipboard.some((item) => item.start === null)) {
        return api.pasteCues({ refId, after: true, videoTime });
      }
      const cues = store.state.cues;
      const anchorIdx = cues.findIndex((c) => c.id === (refId ?? store.state.selectedId));
      const from = anchorIdx >= 0 ? anchorIdx : 0;
      const targets = cues.slice(from);
      const count = Math.max(targets.length, clipboard.length);
      const updated = new Map();
      const additions = [];
      let skipped = 0;
      for (let i = 0; i < count; i += 1) {
        const item = clipboard[i];
        if (!item) break; // 剪贴板行已用尽，剩余目标行原样保留
        const target = targets[i];
        if (target) {
          const merged = { ...target };
          if (fields.start || fields.end) {
            const start = fields.start ? item.start : target.start;
            const end = fields.end ? item.end : target.end;
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
              merged.start = Math.max(0, start);
              merged.end = end;
            } else {
              // 只勾一端时，「粘贴值 + 保留的另一端」可能冲突（如只贴开始时间而它
              // 晚于目标行结束时间）。不写非法区间，该行时间保持原值并计入 skipped
              skipped += 1;
            }
          }
          if (fields.text) merged.text = item.text;
          if (merged.start !== target.start || merged.end !== target.end || merged.text !== target.text) {
            updated.set(target.id, merged);
          }
        } else {
          const cue = makeNewCue(
            store.state.subtitleFormat,
            store.state.subDoc,
            item.start,
            clampEnd(item.start, item.end),
            fields.text ? item.text : '',
          );
          if (item.meta) cue.meta = structuredClone(item.meta);
          additions.push(cue);
        }
      }
      if (!updated.size && !additions.length) return skipped ? { ok: true, skipped } : false;
      const next = [...cues];
      if (additions.length) next.splice(from + targets.length, 0, ...additions);
      commit(sortCues(next.map((c) => updated.get(c.id) ?? c)), {}, null, 'pasteSpecial');
      if (additions.length) setSelection(additions.map((c) => c.id));
      return { ok: true, skipped };
    },

    // 导出成功后的状态收口：以导出内容为干净基线，撤销回到基线时不再视为未保存
    markExported(format, name) {
      history.markBaseline();
      store.patch({ dirty: false, subtitleFormat: format, subtitleName: name });
    },
  };
  return api;
}
