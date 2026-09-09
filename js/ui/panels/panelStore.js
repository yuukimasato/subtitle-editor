// 面板状态仓库：从自研 floating-panel-kit 的 store.ts 移植为原生 JS（该层本就框架无关，
// 订阅接口 subscribe/getState 保留，渲染由 panelLayer.js 以原生 DOM 消费）。
// 语义与 kit 一致：open 同 id 复用聚焦、close 带退场动画、patchLayout 夹取工作区并
// 跳过无变化写入、dock 提交吸附落点、toggleMaximize 记忆还原图形。
import {
  bringToFront,
  choosePanelPosition,
  clampPanelRect,
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
} from './panelGeometry.js';

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 300;
const DEFAULT_Z_INDEX_BASE = 1000;
const DEFAULT_CLOSE_MS = 200;

function defaultWorkspace() {
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth || 1280;
  const height = typeof window === 'undefined' ? 800 : window.innerHeight || 800;
  return { x: 0, y: 0, width, height };
}

// options: { workspace?, zIndexBase?, savedLayouts?, closeAnimationMs? }
export function createPanelStore(options = {}) {
  const workspace = options.workspace ?? defaultWorkspace;
  const zIndexBase = options.zIndexBase ?? DEFAULT_Z_INDEX_BASE;
  const closeMs = options.closeAnimationMs ?? DEFAULT_CLOSE_MS;
  const savedLayouts = options.savedLayouts;

  let state = { panels: [], snapPreview: null };
  const listeners = new Set();
  const closeTimers = new Map();

  function notify() {
    for (const listener of listeners) listener();
  }

  function setState(next) {
    const panels = next.panels ?? state.panels;
    const snapPreview = next.snapPreview !== undefined ? next.snapPreview : state.snapPreview;
    if (panels === state.panels && snapPreview === state.snapPreview) return;
    state = { panels, snapPreview };
    notify();
  }

  function setPanels(next) {
    setState({ panels: next });
  }

  function replacePanel(id, patch) {
    setPanels(state.panels.map((panel) => (panel.id === id ? patch(panel) : panel)));
  }

  function clearCloseTimer(id) {
    const timer = closeTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      closeTimers.delete(id);
    }
  }

  function scheduleRemove(id) {
    clearCloseTimer(id);
    closeTimers.set(id, setTimeout(() => {
      closeTimers.delete(id);
      setPanels(state.panels.filter((panel) => panel.id !== id));
    }, closeMs));
  }

  function maxZIndex() {
    return state.panels.reduce((value, panel) => Math.max(value, panel.layout.zIndex), zIndexBase);
  }

  function focus(id) {
    setPanels(bringToFront(state.panels, id));
  }

  function optionsById(id) {
    return state.panels.find((panel) => panel.id === id);
  }

  function nextLayout(id, rect, overrides = {}) {
    return {
      mode: 'floating',
      dockTargetId: null,
      dockEdge: null,
      zIndex: maxZIndex() + 1,
      ...clampPanelRect(rect, workspace(), {
        width: optionsById(id)?.minWidth ?? MIN_PANEL_WIDTH,
        height: optionsById(id)?.minHeight ?? MIN_PANEL_HEIGHT,
      }),
      ...overrides,
    };
  }

  const store = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    workspace,

    open(opts) {
      const existing = optionsById(opts.id);
      if (existing) {
        // 复用：刷新内容、撤销进行中的关闭动画，然后置顶。
        clearCloseTimer(opts.id);
        replacePanel(opts.id, (panel) => ({
          ...panel,
          title: opts.title,
          content: opts.content,
          closable: opts.closable !== false,
          maximizable: opts.maximizable === true,
          closing: false,
          openedAt: Date.now(),
        }));
        focus(opts.id);
        return;
      }

      const minWidth = opts.minWidth ?? MIN_PANEL_WIDTH;
      const minHeight = opts.minHeight ?? MIN_PANEL_HEIGHT;
      const ws = workspace();
      const width = Math.min(Math.max(opts.width ?? DEFAULT_WIDTH, minWidth), ws.width);
      const height = Math.min(Math.max(opts.height ?? DEFAULT_HEIGHT, minHeight), ws.height);
      const min = { width: minWidth, height: minHeight };

      const saved = savedLayouts?.[opts.id];
      let rect;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        rect = clampPanelRect(
          { x: saved.x, y: saved.y, width: saved.width ?? width, height: saved.height ?? height },
          ws, min,
        );
      } else if (opts.x !== undefined && opts.y !== undefined) {
        rect = clampPanelRect({ x: opts.x, y: opts.y, width, height }, ws, min);
      } else {
        const position = choosePanelPosition({ width, height }, state.panels, ws);
        rect = clampPanelRect({ ...position, width, height }, ws, min);
      }

      const panel = {
        id: opts.id,
        title: opts.title,
        content: opts.content,
        layout: {
          mode: 'floating',
          dockTargetId: null,
          dockEdge: null,
          zIndex: maxZIndex() + 1,
          ...rect,
        },
        closable: opts.closable !== false,
        maximizable: opts.maximizable === true,
        minWidth,
        minHeight,
        restoreRect: null,
        openedAt: Date.now(),
        closing: false,
      };
      setPanels([...state.panels, panel]);
    },

    close(id) {
      const panel = optionsById(id);
      if (!panel || !panel.closable || panel.closing) return;
      replacePanel(id, (item) => ({ ...item, closing: true }));
      scheduleRemove(id);
    },

    remove(id) {
      clearCloseTimer(id);
      setPanels(state.panels.filter((panel) => panel.id !== id));
    },

    closeAll() {
      for (const panel of state.panels) {
        if (!panel.closable || panel.closing) continue;
        replacePanel(panel.id, (item) => ({ ...item, closing: true }));
        scheduleRemove(panel.id);
      }
    },

    focus,

    patchLayout(id, patch) {
      const panel = optionsById(id);
      if (!panel) return;
      const base = panel.layout;
      const rect = clampPanelRect(
        {
          x: patch.x ?? base.x,
          y: patch.y ?? base.y,
          width: patch.width ?? base.width,
          height: patch.height ?? base.height,
        },
        workspace(),
        { width: panel.minWidth, height: panel.minHeight },
      );
      const next = { ...base, ...patch, ...rect };
      // 跳过无变化的写入：拖动中高频触发，避免持续产生新引用驱动无意义的重渲染。
      if (Object.keys(next).every((key) => base[key] === next[key])) return;
      replacePanel(id, (item) => ({ ...item, layout: next }));
    },

    setSnapPreview(preview) {
      setState({ snapPreview: preview });
    },

    dock(id, targetId, edge) {
      const panel = optionsById(id);
      if (!panel || id === targetId) return;
      if (!targetId) {
        replacePanel(id, (item) => ({
          ...item,
          layout: { ...item.layout, mode: 'docked', dockTargetId: null, dockEdge: edge },
        }));
        setState({ snapPreview: null });
        return;
      }
      const target = state.panels.find((item) => item.id === targetId);
      if (!target) return;
      const targetLayout = target.layout;
      replacePanel(id, (item) => ({
        ...item,
        layout: {
          ...item.layout,
          mode: 'docked',
          dockTargetId: targetId,
          dockEdge: edge,
          x: edge === 'right' ? targetLayout.x + targetLayout.width : targetLayout.x,
          y: edge === 'bottom' ? targetLayout.y + targetLayout.height : targetLayout.y,
        },
      }));
      setState({ snapPreview: null });
    },

    undock(id) {
      const panel = optionsById(id);
      if (!panel) return;
      replacePanel(id, (item) => ({
        ...item,
        layout: { ...item.layout, mode: 'floating', dockTargetId: null, dockEdge: null },
      }));
      setState({ snapPreview: null });
    },

    toggleMaximize(id) {
      const panel = optionsById(id);
      if (!panel || !panel.maximizable) return;
      const ws = workspace();
      if (panel.restoreRect) {
        const restored = nextLayout(id, panel.restoreRect);
        replacePanel(id, (item) => ({ ...item, layout: restored, restoreRect: null }));
        return;
      }
      const restoreRect = {
        x: panel.layout.x, y: panel.layout.y,
        width: panel.layout.width, height: panel.layout.height,
      };
      const maximized = nextLayout(id, { x: ws.x, y: ws.y, width: ws.width, height: ws.height });
      replacePanel(id, (item) => ({ ...item, layout: maximized, restoreRect }));
    },
  };

  return store;
}
