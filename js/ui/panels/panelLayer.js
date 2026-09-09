// 面板渲染壳（原生 DOM）：对齐自研 floating-panel-kit 的 FloatingPanelLayer.tsx 语义——
// 标题栏拖动、8 向缩放手柄、吸附预览高亮、松手提交停靠、ESC 中断交互或关闭最顶层、
// 最大化/还原。面板几何完全由 panelStore 驱动，本层只做渲染与指针翻译。
// createPanelManager 再叠加 localStorage 布局持久化，供 main.js 一站式装配。
import { getSnapPreview } from './panelGeometry.js';
import { createPanelStore } from './panelStore.js';

const RESIZE_HANDLES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const MAX_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="9" width="11" height="11" rx="2"/><path d="M9 5h10v10"/></svg>';

// 全局同一时刻只有一次拖动/缩放；模块级引用让 ESC 能中断进行中的交互。
let activeInteractionCancel = null;

// deps: { mount?, snapThreshold? }
export function createPanelLayer(store, deps = {}) {
  const mount = deps.mount ?? document.body;
  const snapThreshold = deps.snapThreshold ?? 24;
  const roots = new Map(); // id -> {root, header, body, title, maxBtn, closeBtn}

  function resolveContent(panel, body) {
    body.textContent = '';
    const content = panel.content;
    if (typeof content === 'function') {
      const node = content(body);
      if (node) body.appendChild(node);
    } else if (content) {
      body.appendChild(content);
    }
  }

  function handleFor(panel, key) {
    const closable = panel.closable && key === 'close';
    const maximizable = panel.maximizable && key === 'max';
    return { closable, maximizable };
  }

  function createRoot(panel) {
    const root = document.createElement('div');
    root.className = 'fp-panel fp-float';
    root.tabIndex = 0;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.dataset.panelId = panel.id;

    const header = document.createElement('div');
    header.className = 'fp-header';
    const title = document.createElement('span');
    title.className = 'fp-title';
    const actions = document.createElement('div');
    actions.className = 'fp-actions';
    const maxBtn = document.createElement('button');
    maxBtn.type = 'button';
    maxBtn.className = 'fp-btn fp-btn-max';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fp-btn fp-btn-close';
    closeBtn.title = '关闭 (ESC)';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.addEventListener('click', () => store.close(panel.id));
    maxBtn.addEventListener('click', () => store.toggleMaximize(panel.id));
    actions.append(maxBtn, closeBtn);
    header.append(title, actions);

    const body = document.createElement('div');
    body.className = 'fp-body';
    root.append(header, body);
    for (const handle of RESIZE_HANDLES) {
      const el = document.createElement('div');
      el.className = `fp-resize-handle fp-resize-${handle}`;
      el.dataset.resizeHandle = handle;
      el.setAttribute('aria-label', `调整面板大小 ${handle}`);
      bindInteraction(el, panel.id, 'resize', handle, () => roots.get(panel.id));
      root.appendChild(el);
    }
    bindInteraction(header, panel.id, 'drag', null, () => roots.get(panel.id));
    root.addEventListener('pointerdown', () => store.focus(panel.id));
    root.addEventListener('focusin', () => store.focus(panel.id));

    mount.appendChild(root);
    const entry = { root, header, body, title, maxBtn, closeBtn };
    roots.set(panel.id, entry);
    resolveContent(panel, body);
    return entry;
  }

  function syncRoot(panel) {
    const entry = roots.get(panel.id) ?? createRoot(panel);
    const { root, title, maxBtn, closeBtn } = entry;
    const { layout } = panel;
    root.style.setProperty('--fp-x', `${layout.x}px`);
    root.style.setProperty('--fp-y', `${layout.y}px`);
    root.style.setProperty('--fp-w', `${layout.width}px`);
    root.style.setProperty('--fp-h', `${layout.height}px`);
    root.style.zIndex = layout.zIndex;
    if (title.textContent !== panel.title) {
      title.textContent = panel.title;
      root.setAttribute('aria-label', panel.title);
    }
    maxBtn.style.display = handleFor(panel, 'max').maximizable ? '' : 'none';
    maxBtn.innerHTML = panel.restoreRect ? RESTORE_ICON : MAX_ICON;
    maxBtn.title = panel.restoreRect ? '还原' : '最大化';
    closeBtn.style.display = handleFor(panel, 'close').closable ? '' : 'none';
    root.classList.toggle('fp-exit', panel.closing);
  }

  function syncAll() {
    const state = store.getState();
    for (const panel of state.panels) syncRoot(panel);
    for (const [id, entry] of roots) {
      if (!state.panels.some((panel) => panel.id === id)) {
        entry.root.remove();
        roots.delete(id);
      }
    }
  }

  function bindInteraction(el, id, kind, handle, getEntry) {
    let interaction = null; // {pointerId, startX, startY, initial}
    const setPointerCaptureSafe = (event) => {
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // 指针已释放等边缘情况：忽略
      }
    };
    const clear = () => {
      interaction = null;
      activeInteractionCancel = null;
      store.setSnapPreview(null);
      getEntry()?.root.classList.remove('fp-interacting');
    };
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (kind === 'drag' && isInteractiveTarget(event.target)) return;
      const panel = store.getState().panels.find((item) => item.id === id);
      if (!panel || panel.closing) return;
      event.preventDefault();
      event.stopPropagation();
      store.focus(id);
      const { layout } = panel;
      interaction = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        initial: { ...layout, mode: 'floating', dockTargetId: null, dockEdge: null },
      };
      if (layout.mode === 'docked') store.undock(id);
      activeInteractionCancel = cancel;
      getEntry()?.root.classList.add('fp-interacting');
      setPointerCaptureSafe(event);
    });
    el.addEventListener('pointermove', (event) => {
      if (!interaction || event.pointerId !== interaction.pointerId) return;
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      const base = interaction.initial;
      if (kind === 'drag') {
        const rect = { x: base.x + dx, y: base.y + dy, width: base.width, height: base.height };
        const preview = getSnapPreview(
          rect,
          store.workspace(),
          store.getState().panels.filter((item) => item.id !== id),
          snapThreshold,
        );
        store.patchLayout(id, rect);
        store.setSnapPreview(preview);
        return;
      }
      const h = handle ?? 'se';
      const x = h.includes('w') ? base.x + dx : base.x;
      const y = h.includes('n') ? base.y + dy : base.y;
      const width = h.includes('w') ? base.width - dx : h.includes('e') ? base.width + dx : base.width;
      const height = h.includes('n') ? base.height - dy : h.includes('s') ? base.height + dy : base.height;
      store.patchLayout(id, { x, y, width, height });
    });
    const finish = (event) => {
      if (!interaction) return;
      if (kind === 'drag') {
        const preview = store.getState().snapPreview;
        if (preview) {
          store.patchLayout(id, preview.rect);
          store.dock(id, preview.targetId, preview.dockEdge);
        }
      }
      if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
      clear();
    };
    const cancel = () => {
      if (!interaction) return;
      store.patchLayout(id, interaction.initial);
      clear();
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', cancel);
  }

  function isInteractiveTarget(target) {
    return typeof Element !== 'undefined' &&
      target instanceof Element &&
      Boolean(target.closest('button, input, textarea, select, a, [data-no-panel-drag]'));
  }

  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (activeInteractionCancel) {
      event.preventDefault();
      event.stopPropagation();
      activeInteractionCancel();
      return;
    }
    const top = [...store.getState().panels]
      .filter((panel) => panel.closable && !panel.closing)
      .sort((a, b) => b.layout.zIndex - a.layout.zIndex)[0];
    if (top) {
      event.preventDefault();
      event.stopPropagation();
      store.close(top.id);
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  const unsubscribe = store.subscribe(syncAll);
  syncAll();

  return {
    destroy() {
      unsubscribe();
      document.removeEventListener('keydown', onKeyDown, true);
      for (const [, entry] of roots) entry.root.remove();
      roots.clear();
    },
  };
}

// 一站式装配：store + 渲染壳 + 布局持久化（localStorage，防抖 300ms，与 kit 语义一致）。
// options: { mount?, namespace?, storageKey?, snapThreshold?, zIndexBase?, storage? }
export function createPanelManager(options = {}) {
  const storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  const key = `vstEditor.panels.${options.namespace ? `${options.namespace}:` : ''}${options.storageKey ?? 'default'}`;

  let savedLayouts = {};
  try {
    savedLayouts = JSON.parse(storage?.getItem(key) ?? '{}') ?? {};
  } catch {
    savedLayouts = {};
  }

  const store = createPanelStore({
    zIndexBase: options.zIndexBase,
    savedLayouts,
  });
  const layer = createPanelLayer(store, {
    mount: options.mount,
    snapThreshold: options.snapThreshold,
  });

  let timer = null;
  const unsubscribe = store.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const layouts = {};
      for (const panel of store.getState().panels) {
        if (panel.closing) continue;
        const { x, y, width, height } = panel.layout;
        layouts[panel.id] = { x, y, width, height };
      }
      try {
        storage?.setItem(key, JSON.stringify(layouts));
      } catch {
        // 存储不可用：布局不持久化
      }
    }, 300);
  });

  return {
    store,
    open: (opts) => store.open(opts),
    close: (id) => store.close(id),
    closeAll: () => store.closeAll(),
    focus: (id) => store.focus(id),
    destroy() {
      clearTimeout(timer);
      unsubscribe();
      layer.destroy();
    },
  };
}
