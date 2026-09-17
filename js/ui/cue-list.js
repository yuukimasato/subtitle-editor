// 字幕表格（底部面板）：单击选中行、双击进入文本/时间编辑（防抖自动提交与草稿保存）、
// 多选（Ctrl/Shift）与右键行操作菜单、播放高亮与跟随滚动。
// 渲染采用行级增量更新，编辑中不整表重建，避免打断输入焦点。
import { formatClock, formatDuration, parseFlexibleTime } from '../format/time.js';
import { splitSpeaker, joinSpeaker } from '../format/cue.js';
import { splitAssTags, joinAssTags } from '../format/ass.js';
import { cueStyle } from '../format/index.js';
import { showToast } from './toast.js';

const TEXT_COMMIT_DELAY = 700;
const COLS = 8;
// 说话人列显隐持久化键：'0'=隐藏，其余（含未设置）=显示（默认显示，取自文本开头的 [标签] 前缀）
const SHOW_SPEAKERS_KEY = 'vstEditor.showSpeakers';

function showSpeakersPreferred() {
  try {
    return localStorage.getItem(SHOW_SPEAKERS_KEY) !== '0';
  } catch {
    return true; // 存储不可用：本次会话保持默认显示
  }
}

export function createCueList({
  store,
  actions,
  player,
  tbodyEl,
  wrapEl,
  countEl,
  toolsEl,
  statusEl,
  menu,
  pasteDialog,
}) {
  const rows = new Map(); // id → 行视图
  const pending = new Map(); // id → 文本字段防抖定时器
  const timeDirty = new Set(); // id → 时间字段已改动，待 blur/Enter 提交
  const rawEdits = new Set(); // id → 编辑框已换成含标签原始正文，提交按原样采用
  let showSpeakers = showSpeakersPreferred();
  let orderedIds = [];
  let focusedId = null;
  let lastActiveId = null;
  let playerPlaying = false;
  let menuRefId = null;

  // ---------- 工具条 ----------
  // 按 id 获取，避免依赖 DOM 顺序的解构
  const insertBtn = document.getElementById('cue-insert');
  const deleteBtn = document.getElementById('cue-delete');
  const splitBtn = document.getElementById('cue-split');
  const mergeBtn = document.getElementById('cue-merge');
  const followBox = toolsEl.querySelector('input[type="checkbox"]');
  insertBtn.addEventListener('click', () => {
    const cue = actions.insertAtTime(player.currentTime());
    if (cue) actions.setEditing(cue.id); // 新建后直接进入文本输入
  });
  deleteBtn.addEventListener('click', () => actions.removeCues(store.state.selectedIds));
  splitBtn.addEventListener('click', () => {
    const cue = store.selectedCue();
    if (cue) actions.splitCue(cue.id, player.currentTime());
  });
  mergeBtn.addEventListener('click', () => {
    const cue = store.selectedCue();
    if (cue) actions.mergeWithNext(cue.id);
  });
  followBox.checked = store.state.follow;
  followBox.addEventListener('change', () => store.patch({ follow: followBox.checked }));
  store.on('follow', (s) => {
    followBox.checked = s.follow;
  });

  // 说话人列开关（默认隐藏）：勾选且数据里确有前缀时才显示整列
  const speakersBox = toolsEl.querySelector('#show-speakers');
  if (speakersBox) {
    speakersBox.checked = showSpeakers;
    speakersBox.addEventListener('change', () => {
      showSpeakers = speakersBox.checked;
      try {
        localStorage.setItem(SHOW_SPEAKERS_KEY, showSpeakers ? '1' : '0');
      } catch {
        // 存储不可用：仅本次会话生效
      }
      reconcile();
    });
  }

  // 草稿自动保存状态提示
  store.on('savedAt', (s) => {
    if (statusEl && s.savedAt) {
      statusEl.textContent = `已自动保存 ${new Date(s.savedAt).toLocaleTimeString()}`;
    }
  });
  // 草稿保存失败（draft.js 配额不足时经 draftSaveFailedAt 通知）
  store.on('draftSaveFailedAt', () => {
    if (statusEl) statusEl.textContent = '草稿保存失败（存储配额不足？）';
  });

  // ---------- 编辑提交 ----------
  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function scheduleCommit(id) {
    clearTimeout(pending.get(id));
    pending.set(id, setTimeout(() => commitRow(id), TEXT_COMMIT_DELAY));
  }

  // 文本字段的防抖提交（只管文本；时间改走 blur/Enter 提交，避免半输入中间值写库）。
  // 输入框里是去掉说话人前缀与 ASS 标签段的纯正文，提交时按原前缀/原标签拼回，
  // cue.text 数据保持完整；双击进入的编辑换成原始正文，提交按原样采用（可增删标签）
  function commitRow(id) {
    clearTimeout(pending.get(id));
    if (!pending.delete(id)) return; // 该行没有等待提交的文本编辑
    const view = rows.get(id);
    const cue = store.state.cues.find((c) => c.id === id);
    if (!view || !cue) return;
    const isAss = store.state.subtitleFormat === 'ass';
    let editedBody = view.text.value;
    if (isAss && !rawEdits.delete(id)) {
      editedBody = joinAssTags(splitSpeaker(cue.text).body, editedBody);
    }
    const nextText = joinSpeaker(cue.text, editedBody);
    if (nextText !== cue.text) actions.updateCue(id, { text: nextText });
  }

  // 时间字段的提交：blur/Enter（或 flushEdits）时执行；无效值不落库（blur 校验已提示）
  function commitTimes(id) {
    if (!timeDirty.delete(id)) return;
    const view = rows.get(id);
    const cue = store.state.cues.find((c) => c.id === id);
    if (!view || !cue) return;
    const start = parseFlexibleTime(view.start.value);
    const end = parseFlexibleTime(view.end.value);
    if (start === null || end === null || end <= start) return;
    const patch = {};
    if (start !== cue.start) patch.start = start;
    if (end !== cue.end) patch.end = end;
    if (Object.keys(patch).length) actions.updateCue(id, patch);
  }

  // 外部操作前的统一落库入口：时间字段提交未 blur 的改动，文本字段照旧防抖提交
  function flushEdits() {
    [...timeDirty].forEach((id) => commitTimes(id));
    [...pending.keys()].forEach((id) => commitRow(id));
  }

  function validateTimeInput(input) {
    const text = input.value.trim();
    if (text !== '' && parseFlexibleTime(text) === null) {
      input.classList.add('invalid');
      showToast(`无法识别时间 "${input.value}"`, 'error');
      return false;
    }
    input.classList.remove('invalid');
    return true;
  }

  function checkTimes(id) {
    const view = rows.get(id);
    if (!view) return;
    const start = parseFlexibleTime(view.start.value);
    const end = parseFlexibleTime(view.end.value);
    if (start !== null && end !== null && end <= start) {
      view.end.classList.add('invalid');
      showToast('结束时间必须晚于开始时间', 'error');
    }
  }

  // ---------- 行构建 ----------
  // 编辑态 = 行上的 .editing（CSS 只在该状态下放行输入框的指针事件）。
  // 单击只选中行；双击（或 actions.setEditing）才进入编辑，避免输入框抢走焦点后
  // 把小键盘时间轴键位当成数字输入吞掉。
  function setEditingRow(id, editing) {
    rows.get(id)?.tr.classList.toggle('editing', editing);
  }

  // 双击落点 → 文本偏移（Chrome/WebKit 两套 API；取不到就退回行尾）
  function caretOffsetFromPoint(el, x, y) {
    try {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos?.offsetNode && el.contains(pos.offsetNode)) return pos.offset;
      } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range && el.contains(range.startContainer)) return range.startOffset;
      }
    } catch {
      // 落点不可解析：用默认位置
    }
    return null;
  }

  function focusText(id) {
    const view = rows.get(id);
    if (!view) return;
    setEditingRow(id, true);
    view.text.focus();
    const len = view.text.value.length;
    view.text.setSelectionRange(len, len);
  }

  // 双击进入编辑：文本按落点定位光标，时间整段选中便于直接重打。
  // ASS 文本换成含标签的原始正文（展示层平时剥掉标签，进编辑才可见可改）
  function beginEdit(id, field, event) {
    const view = rows.get(id);
    if (!view) return;
    // 先加 .editing：输入框恢复指针事件后 caretPositionFromPoint 才命中输入框内部
    setEditingRow(id, true);
    const isTime = field === 'start' || field === 'end';
    const input = isTime ? view[field] : view.text;
    if (!isTime && !pending.has(id)) {
      const cue = store.state.cues.find((c) => c.id === id);
      if (cue && store.state.subtitleFormat === 'ass') {
        view.text.value = splitSpeaker(cue.text).body;
        rawEdits.add(id);
        autosize(view.text);
      }
    }
    input.focus();
    if (isTime) {
      input.select();
      return;
    }
    const offset = caretOffsetFromPoint(view.text, event.clientX, event.clientY);
    if (offset === null) {
      const len = view.text.value.length;
      view.text.setSelectionRange(len, len);
    } else {
      view.text.setSelectionRange(offset, offset);
    }
  }

  function playCue(id) {
    const cue = store.state.cues.find((c) => c.id === id);
    if (!cue) return;
    actions.select(id);
    const end = cue.end > cue.start
      ? cue.end
      : Math.min(store.state.duration || cue.start + 2, cue.start + 2); // 零时长行试听 2s
    player.playRange(cue.start, end);
  }

  function buildRow(cue) {
    const id = cue.id;
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    tr.className = 'cue-row';
    tr.innerHTML = `
      <td class="num mono"></td>
      <td class="time" title="开始时间（双击编辑，回车或移开焦点提交）"><input class="edit-time mono" data-field="start"></td>
      <td class="time" title="结束时间（双击编辑，回车或移开焦点提交）"><input class="edit-time mono" data-field="end"></td>
      <td class="dur mono"></td>
      <td class="style-cell"><select class="edit-style" title="ASS 样式（Aegisub 样式列）"></select></td>
      <td class="speaker-cell"></td>
      <td class="text-cell" title="字幕文本（双击编辑，修改后自动保存）"><textarea class="edit-text" rows="1"></textarea></td>
      <td class="ops"><button type="button" class="op play" title="播放此句">▶</button></td>`;
    const view = {
      tr,
      num: tr.querySelector('.num'),
      start: tr.querySelector('[data-field="start"]'),
      end: tr.querySelector('[data-field="end"]'),
      dur: tr.querySelector('.dur'),
      style: tr.querySelector('.edit-style'),
      speaker: tr.querySelector('.speaker-cell'),
      text: tr.querySelector('.edit-text'),
      play: tr.querySelector('.op.play'),
    };
    view.style.addEventListener('change', () => {
      actions.updateCueStyle([id], view.style.value);
      // 选完即收回焦点：下拉保持聚焦时，小键盘数字会跳选到同首字符的样式项
      view.style.blur();
    });
    view.play.addEventListener('click', (e) => {
      e.stopPropagation();
      playCue(id);
    });
    [view.start, view.end].forEach((input) => {
      // 时间字段不做逐键防抖：停顿即提交会把半输入的中间值（如「0:0」=0s）写进数据，
      // 只在 blur/Enter 时经 commitTimes 落库
      input.addEventListener('input', () => {
        input.classList.remove('invalid');
        timeDirty.add(id);
      });
      input.addEventListener('blur', () => {
        validateTimeInput(input);
        commitTimes(id);
        checkTimes(id);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur(); // 走 blur 流程统一提交并校验
        } else if (e.key === 'Escape') {
          input.blur(); // 退出编辑态，回到小键盘键位上下文
        }
      });
    });
    view.text.addEventListener('input', () => {
      autosize(view.text);
      scheduleCommit(id);
    });
    view.text.addEventListener('blur', () => commitRow(id));
    view.text.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') view.text.blur(); // 退出编辑态（已输入内容照常提交）
    });
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, select')) return;
      const mode = e.shiftKey ? 'range' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'single';
      actions.select(id, { mode });
      // 时间可能已被编辑，实时取最新值
      if (mode === 'single') {
        const fresh = store.state.cues.find((c) => c.id === id);
        if (fresh) player.seek(fresh.start);
      }
    });
    // 双击进入编辑：文本按落点定位、时间整段选中；播放按钮与样式下拉保持单击
    tr.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, select')) return;
      const input = e.target.closest('td')?.querySelector('input, textarea');
      if (input) beginEdit(id, input.dataset.field ?? 'text', e);
    });
    rows.set(id, view);
    return view;
  }

  // ---------- 样式列（ASS） ----------
  // 样式清单来自 subDoc.styles（解析 [V4+ Styles] 所得）；非 ASS 或无样式表时整列隐藏
  function styleCatalog() {
    const s = store.state;
    return s.subtitleFormat === 'ass' ? (s.subDoc?.styles ?? []) : [];
  }

  function syncStyleSelects() {
    const styles = styleCatalog();
    wrapEl.classList.toggle('hide-style', !styles.length);
    if (!styles.length) return;
    rows.forEach((view) => {
      const current = view.style.value;
      view.style.replaceChildren(...styles.map((name) => new Option(name, name)));
      if (current && !styles.includes(current)) view.style.appendChild(new Option(current, current));
      view.style.value = current;
    });
  }

  function paintStyle(view, cue) {
    if (pending.has(cue.id)) return;
    const value = cueStyle(cue);
    if (value === null) return;
    // 属性选择器对含特殊字符的样式名不可靠，直接遍历比较 value
    const exists = [...view.style.options].some((opt) => opt.value === value);
    if (!exists) {
      view.style.appendChild(new Option(value, value));
    }
    if (view.style.value !== value) view.style.value = value;
  }

  // ---------- 渲染（增量） ----------
  // 展示用纯正文：数据里的说话人前缀与行首 ASS 标签段都只在显示层拆掉
  function displayBodyOf(cue) {
    const { body } = splitSpeaker(cue.text);
    return store.state.subtitleFormat === 'ass' ? splitAssTags(body).body : body;
  }

  function updateRow(view, cue) {
    if (pending.has(cue.id)) return; // 编辑中的行等提交后再回写
    const active = document.activeElement;
    const startText = formatClock(cue.start);
    const endText = formatClock(cue.end);
    // 说话人/标签在显示层拆出（数据仍是完整 cue.text），文本框只放纯正文
    const { speaker } = splitSpeaker(cue.text);
    if (view.speaker.textContent !== (speaker ?? '')) {
      view.speaker.textContent = speaker ?? '';
      view.speaker.title = speaker ?? ''; // 长标签被省略号截断时悬停看全称
    }
    if (active !== view.start && view.start.value !== startText) view.start.value = startText;
    if (active !== view.end && view.end.value !== endText) view.end.value = endText;
    const body = displayBodyOf(cue);
    if (active !== view.text && view.text.value !== body) {
      view.text.value = body;
      autosize(view.text); // 仅文本变化时量高：每行一次强制重排，大表下开销显著
    }
    // 时间已是一致值（提交后回写）：清掉上次非法输入或起止冲突留下的红框，
    // 否则修正数据后红框会一直挂着（checkTimes 标的是另一个输入框）
    if (cue.end > cue.start) {
      view.start.classList.remove('invalid');
      view.end.classList.remove('invalid');
    }
    paintStyle(view, cue);
    view.dur.textContent = formatDuration(cue.end - cue.start);
  }

  function reconcile() {
    const cues = store.state.cues;
    const cueIds = new Set(cues.map((c) => c.id)); // 集合化避免逐行 some() 的 O(n²)

    // 说话人列默认隐藏：勾选「说话人」且数据里确有前缀时才显示（同样式列的 hide-style 约定）
    wrapEl.classList.toggle(
      'hide-speaker',
      !(showSpeakers && cues.some((c) => splitSpeaker(c.text).speaker !== null)),
    );

    rows.forEach((view, id) => {
      if (!cueIds.has(id)) {
        view.tr.remove();
        clearTimeout(pending.get(id));
        pending.delete(id);
        timeDirty.delete(id);
        rawEdits.delete(id);
        rows.delete(id);
      }
    });
    cues.forEach((cue) => {
      let view = rows.get(cue.id);
      if (!view) {
        view = buildRow(cue);
        tbodyEl.appendChild(view.tr);
      }
      updateRow(view, cue);
    });

    const ids = cues.map((c) => c.id);
    const orderChanged = ids.length !== orderedIds.length
      || ids.some((id, i) => id !== orderedIds[i]);
    // 该行还在编辑（文本防抖或时间未 blur 提交）时推迟重排，提交后自然归位；
    // 移动 DOM 会让聚焦输入框 blur，避免半输入的时间值被立即提交
    if (orderChanged && !(focusedId && (pending.has(focusedId) || timeDirty.has(focusedId)))) {
      let cursor = tbodyEl.firstChild;
      ids.forEach((id) => {
        const tr = rows.get(id).tr;
        if (tr === cursor) {
          cursor = cursor.nextSibling;
          return;
        }
        tbodyEl.insertBefore(tr, cursor);
      });
      orderedIds = ids;
    }

    cues.forEach((cue, index) => {
      rows.get(cue.id).num.textContent = String(index + 1);
    });

    if (!cues.length) {
      if (!tbodyEl.querySelector('.cue-empty')) {
        tbodyEl.textContent = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = COLS;
        td.className = 'cue-empty';
        td.textContent = '暂无字幕：拖入字幕文件、按 N 在播放头处新建，或右键插入新行';
        tr.appendChild(td);
        tbodyEl.appendChild(tr);
      }
    } else {
      tbodyEl.querySelector('.cue-empty')?.parentElement?.remove();
    }
    countEl.textContent = cues.length ? `共 ${cues.length} 条` : '';
    highlightActive(player.currentTime(), true);
  }

  function paintSelection() {
    const selected = new Set(store.state.selectedIds ?? []);
    rows.forEach((view, id) => {
      view.tr.classList.toggle('selected', selected.has(id));
    });
  }

  // ---------- 播放高亮与跟随 ----------
  function highlightActive(t, force) {
    const cue = store.cueAt(t);
    const id = cue?.id ?? null;
    if (id === lastActiveId && !force) return;
    if (lastActiveId) rows.get(lastActiveId)?.tr.classList.remove('active');
    if (id) {
      const view = rows.get(id);
      if (view) {
        view.tr.classList.add('active');
        if (playerPlaying && store.state.follow) view.tr.scrollIntoView({ block: 'nearest' });
      }
    }
    lastActiveId = id;
  }

  player.onTime((t, playing) => {
    playerPlaying = playing;
    highlightActive(t, false);
  });

  tbodyEl.addEventListener('focusin', (event) => {
    focusedId = event.target.closest('tr[data-id]')?.dataset.id ?? null;
  });
  tbodyEl.addEventListener('focusout', (event) => {
    focusedId = null;
    // 焦点离开本行（含点到行外）即退出编辑态：输入框重新让出指针事件，单击回到只选中行
    const tr = event.target.closest?.('tr[data-id]');
    if (tr && !tr.contains(event.relatedTarget)) {
      tr.classList.remove('editing');
      // 双击编辑可能把文本框换成了含标签原始正文，退出后回写展示用纯正文
      const id = tr.dataset.id;
      const view = rows.get(id);
      const cue = view && !pending.has(id) ? store.state.cues.find((c) => c.id === id) : null;
      rawEdits.delete(id); // 无论本次是否提交过，退出编辑后不再按「原始正文编辑」对待
      if (view && cue) {
        const plain = displayBodyOf(cue);
        if (view.text.value !== plain) {
          view.text.value = plain;
          autosize(view.text);
        }
      }
    }
  });

  // ---------- 右键行操作菜单 ----------
  // 捕获阶段记录右键目标行；点在多选行上时保留多选，否则单选该行。
  // 右键落在输入框内时不改选中、放行浏览器原生菜单（剪切/粘贴等）。
  const inEditField = (event) => Boolean(event.target.closest('input, textarea, select'));
  wrapEl.addEventListener(
    'contextmenu',
    (event) => {
      if (inEditField(event)) return;
      const tr = event.target.closest('tr[data-id]');
      if (tr) {
        menuRefId = tr.dataset.id;
        if (!(store.state.selectedIds ?? []).includes(menuRefId)) actions.select(menuRefId);
      } else {
        menuRefId = store.state.selectedId ?? store.state.cues.at(-1)?.id ?? null;
      }
    },
    true,
  );

  const tryPaste = (result) => {
    Promise.resolve(result)
      .then((res) => {
        // 兼容两种契约：false = 无可粘贴行；{ ok, skipped } = 部分行时间未粘贴
        if (!res) showToast('剪贴板中没有可粘贴的字幕行', 'error');
        else if (res?.skipped > 0) showToast(`${res.skipped} 行时间未粘贴：剪贴板时间非法，或与目标行保留的时间冲突`, 'warn');
      })
      .catch((err) => showToast(err?.message ?? '粘贴失败', 'error'));
  };
  // 选择性粘贴：纯文本剪贴板（无时间轴）直接按行新建字幕行，不弹字段对话框；
  // 字幕格式剪贴板才进入字段覆盖对话框。
  const smartPasteSpecial = async (refId) => {
    let kind = null;
    try {
      kind = await actions.clipboardKind();
    } catch (err) {
      showToast(err?.message ?? '无法读取剪贴板', 'error');
      return;
    }
    if (!kind) {
      showToast('剪贴板中没有可粘贴的字幕行', 'error');
      return;
    }
    if (kind === 'text') {
      tryPaste(actions.pasteCues({ refId, after: true, videoTime: player.currentTime() }));
      return;
    }
    openPasteDialog(refId);
  };

  function buildMenuItems() {
    const refId = menuRefId;
    const inSelection = refId && (store.state.selectedIds ?? []).includes(refId);
    const selIds = inSelection ? store.state.selectedIds : refId ? [refId] : [];
    const hasRef = Boolean(refId);
    const insert = (opts) => {
      const cue = actions.insertRelativeTo(refId, opts);
      if (cue) actions.setEditing(cue.id);
    };
    return [
      { label: '插入(之前)', enabled: hasRef, onClick: () => insert({ after: false }) },
      { label: '插入(之后)', enabled: hasRef, onClick: () => insert({ after: true }) },
      { label: '以视频时间插入(之前)', onClick: () => insert({ after: false, videoTime: player.currentTime() }) },
      { label: '以视频时间插入(之后)', onClick: () => insert({ after: true, videoTime: player.currentTime() }) },
      { type: 'separator' },
      { label: '重复行', enabled: selIds.length > 0, onClick: () => actions.duplicateCues(selIds) },
      { type: 'separator' },
      { label: '剪切行', enabled: selIds.length > 0, shortcut: 'Ctrl+X', onClick: () => actions.cutCues(selIds) },
      { label: '复制行', enabled: selIds.length > 0, shortcut: 'Ctrl+C', onClick: () => actions.copyCues(selIds) },
      {
        label: '粘贴行',
        shortcut: 'Ctrl+V',
        onClick: () => tryPaste(actions.pasteCues({ refId, after: true, videoTime: player.currentTime() })),
      },
      {
        label: '选择性粘贴…',
        onClick: () => smartPasteSpecial(refId),
      },
      { type: 'separator' },
      { label: '删除行', danger: true, enabled: selIds.length > 0, shortcut: 'Del', onClick: () => actions.removeCues(selIds) },
    ];
  }

  function openPasteDialog(refId) {
    if (pasteDialog?.open) return; // 防重入：对话框已打开时忽略本次请求
    if (!pasteDialog) {
      tryPaste(actions.pasteSpecial({ start: true, end: true, text: true }, { refId }));
      return;
    }
    pasteDialog.returnValue = '';
    pasteDialog.showModal();
    pasteDialog.addEventListener(
      'close',
      () => {
        if (pasteDialog.returnValue !== 'ok') return;
        const fields = { start: false, end: false, text: false };
        pasteDialog.querySelectorAll('input[data-field]').forEach((box) => {
          fields[box.dataset.field] = box.checked;
        });
        tryPaste(actions.pasteSpecial(fields, { refId, videoTime: player.currentTime() }));
      },
      { once: true },
    );
  }

  menu.attach(wrapEl, () => buildMenuItems(), (event) => !inEditField(event));

  store.on('cues', reconcile);
  store.on('selection', paintSelection);
  store.on('subDoc', syncStyleSelects);
  store.on('subtitleFormat', syncStyleSelects);
  // setEditing(id) → 聚焦该行文本框（插入新行 / 波形双击的入口）
  store.on('editingId', (s) => {
    const id = s.editingId;
    if (!id) return;
    store.patch({ editingId: null });
    const view = rows.get(id);
    if (view) {
      focusText(id);
      view.tr.scrollIntoView({ block: 'nearest' });
    }
  });

  syncStyleSelects();
  reconcile();

  return { flush: flushEdits };
}
