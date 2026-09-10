// 区块「浮出」为浮动面板（P2 收尾，方案 §3.4/D10）：默认固定布局零变化——
// 只有用户点「浮出」才把区块内容 DOM 迁入面板体（宿主容器搬运，节点引用不变，
// 波形等依赖 ResizeObserver 的自适应照常工作）；关闭面板（X/ESC/关闭全部任一路径）
// 自动回驻原槽位，占位条点击也可回驻。浮出状态持久化到 localStorage（沿用
// vstEditor. 命名空间与 agent 隔离），重载后恢复上次的浮出布局。
//
// 面板系统本体见 ui/panels/（store 渲染壳与本模块解耦，panels 只需提供 open/close/store）。

function storageKey(namespace) {
  return `vstEditor.detach.${namespace ? `${namespace}:` : ''}default`;
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// deps: { panels, store, id, title, slot, nodes, width?, height?, minWidth?, minHeight?, namespace?, storage?, onChange? }
export function createDetachableBlock(deps) {
  const {
    panels, store, id, title, slot, nodes,
    width = 720, height = 260, minWidth = 360, minHeight = 180,
    namespace = '', storage = defaultStorage(), onChange = null,
  } = deps;

  const host = document.createElement('div');
  host.className = `detach-host detach-host-${id}`;

  const placeholder = document.createElement('div');
  placeholder.className = 'detach-placeholder';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn';
  backBtn.textContent = '已浮出为浮动窗口 · 点击回驻';
  backBtn.addEventListener('click', () => dock());
  placeholder.append(backBtn);

  let detached = false;

  function readState() {
    try {
      const raw = storage?.getItem(storageKey(namespace));
      const data = raw ? JSON.parse(raw) : null;
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  function persist(value) {
    try {
      storage?.setItem(storageKey(namespace), JSON.stringify({ ...readState(), [id]: value }));
    } catch {
      // 存储不可用：仅本次会话生效
    }
  }

  function detach() {
    if (detached) return;
    for (const node of nodes) host.appendChild(node); // 引用不变地搬进宿主
    slot.textContent = '';
    slot.appendChild(placeholder);
    detached = true;
    // 面板初始尺寸取槽位当前几何（视觉连续），越界由面板系统夹取
    const rect = slot.getBoundingClientRect();
    panels.open({
      id,
      title,
      width: Math.max(minWidth, Math.round(rect.width)) ,
      height: Math.max(minHeight, Math.round(rect.height)),
      minWidth,
      minHeight,
      content: () => host,
    });
    persist(true);
    onChange?.(true);
  }

  function dock() {
    if (!detached) return;
    panels.close(id); // 实际回驻由 store 监听统一处理（覆盖 X/ESC/关闭全部）
  }

  // 面板从状态中消失（任何关闭路径）→ 内容搬回槽位原顺序
  const unsubscribe = store.subscribe(() => {
    if (!detached) return;
    const exists = store.getState().panels.some((panel) => panel.id === id);
    if (exists) return;
    detached = false;
    placeholder.remove();
    for (const node of nodes) slot.appendChild(node);
    persist(false);
    onChange?.(false);
  });

  return {
    detach,
    dock,
    restore() {
      if (readState()[id]) detach();
    },
    get detached() {
      return detached;
    },
    destroy: unsubscribe,
  };
}

// 浮出/回驻共用的小按钮（跟随区块内容一起移动，两种形态下都可点）
export function createDetachButton({ label = '⧉', titleDetach = '浮出为浮动窗口（可拖动/缩放/吸附）', titleDock = '回驻固定布局' } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'detach-btn';
  btn.textContent = label;
  btn.title = titleDetach;
  btn.setAttribute('aria-label', titleDetach);
  return {
    el: btn,
    sync(isDetached) {
      btn.title = isDetached ? titleDock : titleDetach;
      btn.setAttribute('aria-label', isDetached ? titleDock : titleDetach);
      btn.classList.toggle('detach-btn-active', isDetached);
    },
  };
}
