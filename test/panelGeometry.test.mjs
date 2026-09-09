// 面板几何纯函数测试：从自研 floating-panel-kit 的 tests/geometry.test.ts 迁移到 node:test，
// 用例与断言保持一致（几何算法是编辑器与 kit 上游共享的测量锚点，不允许语义漂移）。
// 另补充 panelStore 的无头行为测试（注入固定 workspace，不依赖 DOM）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bringToFront,
  choosePanelPosition,
  clampPanelRect,
  getSnapPreview,
} from '../js/ui/panels/panelGeometry.js';
import { createPanelStore } from '../js/ui/panels/panelStore.js';

const workspace = { x: 0, y: 0, width: 1280, height: 800 };

function layout(patch = {}) {
  return {
    mode: 'floating', x: 0, y: 0, width: 400, height: 300,
    zIndex: 1, dockTargetId: null, dockEdge: null, ...patch,
  };
}

// ---------- clampPanelRect ----------

test('clampPanelRect：强制最小尺寸并夹取到工作区内', () => {
  const rect = clampPanelRect({ x: -50, y: -50, width: 10, height: 10 }, workspace);
  assert.equal(rect.width, 240);
  assert.equal(rect.height, 160);
  assert.equal(rect.x, 0);
  assert.equal(rect.y, 0);
});

test('clampPanelRect：右下越界时收回到工作区内', () => {
  const rect = clampPanelRect({ x: 1200, y: 700, width: 400, height: 300 }, workspace);
  assert.equal(rect.x, 1280 - 400);
  assert.equal(rect.y, 800 - 300);
});

test('clampPanelRect：尺寸超过工作区时被压到工作区大小', () => {
  const rect = clampPanelRect({ x: 0, y: 0, width: 9999, height: 9999 }, workspace);
  assert.equal(rect.width, 1280);
  assert.equal(rect.height, 800);
});

test('clampPanelRect：负尺寸抛错', () => {
  assert.throws(
    () => clampPanelRect({ x: 0, y: 0, width: -1, height: 100 }, workspace),
    /panel_geometry_invalid/,
  );
});

// ---------- getSnapPreview ----------

test('getSnapPreview：接近工作区左缘时贴边', () => {
  const preview = getSnapPreview({ x: 10, y: 100, width: 400, height: 300 }, workspace, []);
  assert.equal(preview?.dockEdge, 'left');
  assert.equal(preview?.rect.x, 0);
});

test('getSnapPreview：接近其他面板右缘时吸附到其右边缘', () => {
  const panels = [{ id: 'a', layout: layout({ x: 500, y: 100, width: 300, height: 300 }) }];
  const preview = getSnapPreview({ x: 790, y: 120, width: 200, height: 200 }, workspace, panels);
  assert.equal(preview?.targetId, 'a');
  assert.equal(preview?.dockEdge, 'right');
  assert.equal(preview?.rect.x, 800);
});

test('getSnapPreview：距离超出阈值时不吸附', () => {
  assert.equal(getSnapPreview({ x: 100, y: 100, width: 400, height: 300 }, workspace, []), null);
});

// ---------- choosePanelPosition ----------

test('choosePanelPosition：无既有面板时落在右上候选位', () => {
  const pos = choosePanelPosition({ width: 640, height: 520 }, [], workspace);
  assert.equal(pos.x, 1280 - 640 - 16);
  assert.equal(pos.y, 16);
});

test('choosePanelPosition：右上被占用时退到不重叠的候选位', () => {
  const existing = [{ id: 'a', layout: layout({ x: 624, y: 16, width: 640, height: 520 }) }];
  const pos = choosePanelPosition({ width: 300, height: 200 }, existing, workspace);
  const overlaps = existing.some((p) =>
    pos.x < p.layout.x + p.layout.width && pos.x + 300 > p.layout.x &&
    pos.y < p.layout.y + p.layout.height && pos.y + 200 > p.layout.y);
  assert.equal(overlaps, false);
});

test('choosePanelPosition：所有候选被占用时按 28px 级联偏移回退', () => {
  const existing = [{ id: 'a', layout: layout({ x: 624, y: 16, width: 640, height: 520 }) }];
  const pos = choosePanelPosition({ width: 640, height: 520 }, existing, workspace);
  assert.equal(pos.x, 16 + 28);
  assert.equal(pos.y, 16 + 28);
});

// ---------- bringToFront ----------

test('bringToFront：把目标面板提到最高层级', () => {
  const panels = [
    { id: 'a', layout: layout({ zIndex: 3 }) },
    { id: 'b', layout: layout({ zIndex: 7 }) },
  ];
  const next = bringToFront(panels, 'a');
  assert.equal(next.find((p) => p.id === 'a').layout.zIndex, 8);
  assert.equal(next.find((p) => p.id === 'b').layout.zIndex, 7);
});

test('bringToFront：已是最高层时不产生新数组', () => {
  const panels = [
    { id: 'a', layout: layout({ zIndex: 3 }) },
    { id: 'b', layout: layout({ zIndex: 7 }) },
  ];
  assert.equal(bringToFront(panels, 'b'), panels);
});

// ---------- panelStore 无头行为（注入固定 workspace） ----------

function headlessStore(savedLayouts) {
  return createPanelStore({ workspace: () => workspace, savedLayouts });
}

test('store.open：新建面板带默认几何，同 id 复用聚焦不叠加', () => {
  const store = headlessStore();
  store.open({ id: 'p1', title: 'P1', content: null, width: 300, height: 200 });
  assert.equal(store.getState().panels.length, 1);
  assert.equal(store.getState().panels[0].layout.width, 300);
  store.open({ id: 'p1', title: 'P1 新标题', content: null });
  assert.equal(store.getState().panels.length, 1);
  assert.equal(store.getState().panels[0].title, 'P1 新标题');
});

test('store.open：savedLayouts 命中时恢复持久化几何', () => {
  const store = headlessStore({ p1: { x: 100, y: 50, width: 320, height: 240 } });
  store.open({ id: 'p1', title: 'P1', content: null, width: 300, height: 200 });
  const rect = store.getState().panels[0].layout;
  assert.equal(rect.x, 100);
  assert.equal(rect.y, 50);
});

test('store.patchLayout：夹取到工作区，无变化写入被跳过', () => {
  const store = headlessStore();
  store.open({ id: 'p1', title: 'P1', content: null, x: 1000, y: 600, width: 300, height: 200 });
  store.patchLayout('p1', { x: -500, y: -500 });
  const { layout } = store.getState().panels[0];
  assert.equal(layout.x, 0); // 夹取到左上角
  assert.equal(layout.y, 0);
  const ref = store.getState().panels[0];
  store.patchLayout('p1', { x: layout.x }); // 与现值相同：跳过写入，引用不变
  assert.equal(store.getState().panels[0], ref);
});

test('store.close：closable 面板进入退场并按 closeAnimationMs 移除', async () => {
  const store = createPanelStore({ workspace: () => workspace, closeAnimationMs: 5 });
  store.open({ id: 'p1', title: 'P1', content: null });
  store.close('p1');
  assert.equal(store.getState().panels[0].closing, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.getState().panels.length, 0);
});

test('store.dock / undock：贴边停靠记录 edge，拖动前自动 undock 语义由布局标记承载', () => {
  const store = headlessStore();
  store.open({ id: 'a', title: 'A', content: null, x: 0, y: 0, width: 300, height: 300 });
  store.open({ id: 'b', title: 'B', content: null, x: 900, y: 0, width: 300, height: 300 });
  store.dock('b', 'a', 'right');
  let b = store.getState().panels.find((p) => p.id === 'b').layout;
  assert.equal(b.mode, 'docked');
  assert.equal(b.dockTargetId, 'a');
  assert.equal(b.x, 300); // 摆到目标右缘
  store.undock('b');
  b = store.getState().panels.find((p) => p.id === 'b').layout;
  assert.equal(b.mode, 'floating');
  assert.equal(b.dockTargetId, null);
});

test('store.toggleMaximize：铺满工作区并记忆还原图形', () => {
  const store = headlessStore();
  store.open({ id: 'p1', title: 'P1', content: null, maximizable: true, x: 10, y: 10, width: 300, height: 200 });
  store.toggleMaximize('p1');
  let layout = store.getState().panels[0].layout;
  assert.equal(layout.width, 1280);
  assert.equal(layout.height, 800);
  assert.ok(store.getState().panels[0].restoreRect);
  store.toggleMaximize('p1');
  layout = store.getState().panels[0].layout;
  assert.equal(layout.width, 300);
  assert.equal(store.getState().panels[0].restoreRect, null);
});
