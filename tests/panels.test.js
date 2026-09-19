import test from "node:test";
import assert from "node:assert/strict";
import {
  PANELS,
  DOCK_MODES,
  MENU_GROUPS,
  DEFAULT_OPEN,
  WORKSPACES,
} from "../src/ui/panels.js";

const byId = new Map(PANELS.map((p) => [p.id, p]));

test("every panel names a dock that exists and has a unique id", () => {
  const seen = new Set();
  for (const panel of PANELS) {
    assert.ok(panel.title, `${panel.id}に名前が無い`);
    assert.ok(DOCK_MODES[panel.dock], `${panel.id}が知らないドックを指している`);
    assert.equal(seen.has(panel.id), false, `idが重複している：${panel.id}`);
    seen.add(panel.id);
  }
});

// ウィンドウメニューは閉じたパネルを呼び戻す唯一の入口。メニューに出ないパネルを
// 閉じられるようにすると、一度閉じたら戻す手段が無くなる。
test("every closable panel can be reopened from the window menu", () => {
  const docks = new Set(MENU_GROUPS.map((g) => g.dock));
  for (const group of MENU_GROUPS)
    assert.ok(DOCK_MODES[group.dock], `メニューが知らないドックを指している：${group.dock}`);
  for (const panel of PANELS)
    if (!panel.fixed)
      assert.ok(
        docks.has(panel.dock),
        `${panel.id}を閉じるとウィンドウメニューから戻せない`,
      );
});

// 閉じられないパネルは必ず開いた状態で始まる。全部閉じた画面は作れない。
test("panels that cannot be closed are open from the start", () => {
  for (const panel of PANELS)
    if (panel.fixed) assert.ok(DEFAULT_OPEN.includes(panel.id), `${panel.id}が最初から閉じている`);
});

test("each workspace only names panels that exist", () => {
  for (const workspace of WORKSPACES) {
    assert.ok(workspace.name, "名前の無い作業レイアウトがある");
    for (const id of workspace.panels.open)
      assert.ok(byId.has(id), `${workspace.name}が知らないパネルを開こうとしている：${id}`);
  }
});

// 前面にするパネルは、そのドックに属していて、かつ開いている必要がある。
// 食い違うと、切り替えた直後だけ意図と違うタブが前に出る。
test("each workspace brings a panel it actually opens to the front", () => {
  for (const workspace of WORKSPACES)
    for (const [dock, id] of Object.entries(workspace.panels.active ?? {})) {
      assert.ok(DOCK_MODES[dock], `${workspace.name}が知らないドックを指している：${dock}`);
      assert.equal(
        byId.get(id)?.dock,
        dock,
        `${workspace.name}：${id}は${dock}のパネルではない`,
      );
      assert.ok(
        workspace.panels.open.includes(id),
        `${workspace.name}：前面にする${id}を開いていない`,
      );
    }
});

// 「仕上げ（既定）」は閉じすぎたときの逃げ道も兼ねる。初期状態と一致していないと、
// 戻したつもりが戻っていない。
test("the last workspace is the state the app starts in", () => {
  assert.deepEqual([...WORKSPACES.at(-1).panels.open].sort(), [...DEFAULT_OPEN].sort());
  assert.deepEqual(WORKSPACES.at(-1).layout, {});
});
