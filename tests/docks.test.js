import test from "node:test";
import assert from "node:assert/strict";
import { Docks } from "../src/ui/docks.js";

// パネルの出し入れはDOMを触るが、決めているのは「どれを開くか」の状態だけ。
// ブラウザを起こさずにその判断を確かめられるよう、必要な分だけの器を用意する。
function element() {
  const el = {
    hidden: false,
    children: [],
    dataset: {},
    classes: new Set(),
    classList: {
      toggle: (name, on) => (on ? el.classes.add(name) : el.classes.delete(name)),
    },
    append: (...nodes) => el.children.push(...nodes),
    replaceChildren: (...nodes) => (el.children = nodes),
    querySelector: () => null,
  };
  return el;
}
function stage(panels, modes) {
  const nodes = new Map();
  const at = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  for (const dock of Object.keys(modes)) {
    at(`[data-dock="${dock}"]`);
    at(`[data-splitter="${dock}"]`);
    at(`[data-tabs="${dock}"]`);
    at(`[data-dock="${dock}"] .panelBar`);
  }
  for (const p of panels) at(`[data-body="${p.id}"]`);
  const root = { querySelector: (selector) => nodes.get(selector) ?? null };
  return { at, root };
}
const PANELS = [
  { id: "project", title: "プロジェクト", dock: "left", openByDefault: true },
  { id: "tools", title: "ツール", dock: "center", openByDefault: true },
  { id: "viewer", title: "ビュー", dock: "center", fixed: true },
  { id: "content", title: "内容", dock: "right", openByDefault: true },
  { id: "camera", title: "Camera", dock: "right", openByDefault: true },
];
const MODES = { left: "tabs", center: "stack", right: "tabs" };
function docks(onChange = () => {}) {
  const { at, root } = stage(PANELS, MODES);
  return { at, docks: new Docks({ panels: PANELS, modes: MODES, root, onChange }) };
}
// renderはdocument.createElementでタブを作り、最大化の印をbodyへ付ける。
globalThis.document = {
  createElement: () => element(),
  body: { dataset: {} },
};

test("tabs show one panel at a time and stacks show every open one", () => {
  const { at, docks: d } = docks();
  d.render();
  assert.equal(at('[data-body="content"]').hidden, false, "前面のタブが隠れている");
  assert.equal(at('[data-body="camera"]').hidden, true, "裏のタブまで見えている");
  assert.equal(at('[data-body="tools"]').hidden, false, "積む側が隠れている");
  assert.equal(at('[data-body="viewer"]').hidden, false, "常設のパネルが隠れている");
  d.activate("camera");
  assert.equal(at('[data-body="camera"]').hidden, false, "選んだタブが出てこない");
  assert.equal(at('[data-body="content"]').hidden, true, "前のタブが残っている");
});

// 中身が無くなった枠が残ると場所だけ取る。仕切りも一緒に消す。
test("closing the last panel of a dock hides the dock and its splitter", () => {
  const { at, docks: d } = docks();
  d.render();
  assert.equal(at('[data-dock="left"]').hidden, false);
  d.close("project");
  assert.equal(at('[data-dock="left"]').hidden, true, "空の枠が残っている");
  assert.equal(at('[data-splitter="left"]').hidden, true, "仕切りだけ残っている");
  d.reveal("project");
  assert.equal(at('[data-dock="left"]').hidden, false, "呼び戻せない");
  assert.equal(at('[data-splitter="left"]').hidden, false);
});

// 閉じたら戻す手段が絵として無くなるパネルは、閉じる操作を受け付けない。
test("a fixed panel cannot be closed", () => {
  const { at, docks: d } = docks();
  d.close("viewer");
  d.render();
  assert.equal(d.isOpen("viewer"), true);
  assert.equal(at('[data-body="viewer"]').hidden, false);
});

// 前面にしていたタブを閉じたら、残っているタブが前面に出ないと中身が空になる。
test("closing the front tab brings the remaining one forward", () => {
  const { at, docks: d } = docks();
  d.activate("content");
  d.close("content");
  assert.equal(at('[data-body="camera"]').hidden, false, "残ったタブが出てこない");
});

test("changes are reported once so the caller can save them", () => {
  let count = 0;
  const { docks: d } = docks(() => count++);
  d.close("camera");
  d.open("camera");
  assert.equal(count, 2);
});

// 保存の中身は古い版や壊れた値でもあり得る。読めない分は捨て、常設のパネルは
// 必ず開いた状態にして、最低でも操作できる画面にして返す。
test("restore ignores junk and always leaves the app usable", () => {
  const { at, docks: d } = docks();
  d.restore({ open: ["project", "知らないパネル"], active: { right: "camera" }, max: "どこか" });
  assert.equal(d.isOpen("project"), true);
  assert.equal(d.isOpen("content"), false, "保存に無いパネルが開いている");
  assert.equal(d.isOpen("viewer"), true, "常設のパネルが閉じたままになっている");
  assert.equal(d.maximized(), null, "知らないドックを最大化している");
  assert.equal(at('[data-dock="right"]').hidden, true, "中身が無いのに枠が残っている");
  for (const junk of [null, undefined, 7, "layout", { open: "left" }]) {
    d.restore(junk);
    assert.equal(d.isOpen("viewer"), true, `${junk}で画面が壊れる`);
  }
});

test("maximize marks one dock and lets go of it", () => {
  const { at, docks: d } = docks();
  d.maximize("right");
  assert.equal(d.maximized(), "right");
  assert.equal(at('[data-dock="right"]').classes.has("maxed"), true);
  d.toggleMaximize("right");
  assert.equal(d.maximized(), null);
  assert.equal(at('[data-dock="right"]').classes.has("maxed"), false);
});

// 最大化したまま中身を全部閉じると、何も見えない画面のまま戻せなくなる。
test("emptying a maximized dock drops the maximize", () => {
  const { docks: d } = docks();
  d.maximize("left");
  d.close("project");
  assert.equal(d.maximized(), null);
});
