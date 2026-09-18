import test from "node:test";
import assert from "node:assert/strict";
import {
  SHORTCUTS,
  GESTURES,
  comboOf,
  shortcutIndex,
  displayFor,
} from "../src/ui/shortcuts.js";

const press = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

// 表の1行が「効くキー」と「画面に出る説明」の両方になる。どちらかが欠けると
// 一覧に穴が開くか、説明だけがあって押しても動かない行が残る。
test("every shortcut carries what the panel needs to show it", () => {
  const ids = new Set();
  for (const entry of SHORTCUTS) {
    assert.ok(entry.id, "idの無い行がある");
    assert.equal(ids.has(entry.id), false, `idが重複している：${entry.id}`);
    ids.add(entry.id);
    for (const key of ["group", "display", "label"])
      assert.ok(entry[key], `${entry.id}に${key}が無い`);
    assert.ok(entry.combos.length > 0, `${entry.id}にキーの割り当てが無い`);
  }
});

// 同じ組み合わせを2つの行が取り合うと、どちらが動くかがファイルの並び順で
// 決まってしまう。気づけないまま片方が死ぬので、作る時点で弾く。
test("shortcutIndex rejects a combination claimed twice", () => {
  assert.equal(shortcutIndex().size > 0, true);
  assert.throws(
    () =>
      shortcutIndex([
        { id: "a", combos: ["mod+z"] },
        { id: "b", combos: ["mod+z"] },
      ]),
    /重複/,
  );
});

// 同じ行のキーは同じ説明でまとまって出る。説明が読める並びかどうかは、
// groupが飛び飛びになっていないかで決まる。
test("shortcut groups stay contiguous so the list reads in order", () => {
  const seen = [];
  for (const entry of SHORTCUTS)
    if (seen.at(-1) !== entry.group) {
      assert.equal(seen.includes(entry.group), false, `${entry.group}が離れている`);
      seen.push(entry.group);
    }
  assert.ok(seen.length > 1);
});

test("comboOf writes a key press the same way the table does", () => {
  assert.equal(comboOf(press("n")), "n");
  assert.equal(comboOf(press(" ")), "space");
  assert.equal(comboOf(press("Z", { ctrlKey: true, shiftKey: true })), "mod+shift+z");
  // CmdもCtrlも同じmodとして扱う。Macで効かないショートカットを作らない。
  assert.equal(comboOf(press("d", { metaKey: true })), "mod+d");
  assert.equal(comboOf(press("ArrowLeft", { shiftKey: true })), "shift+arrowleft");
  assert.equal(comboOf(press("Escape")), "escape");
});

// 記号キーはShiftを押して入力する環境がある。押し方が違うだけで効かなくなる
// のは事故なので、表がその打ち方も拾えていることを確かめる。
test("the table accepts the shifted way of typing +", () => {
  const index = shortcutIndex();
  assert.equal(index.get(comboOf(press("+", { shiftKey: true }))).id, "zoomTimeline");
  assert.equal(index.get(comboOf(press("+"))).id, "zoomTimeline");
  assert.equal(index.get(comboOf(press("-"))).id, "zoomTimeline");
});

// 入力欄で打っている最中に編集コマンドが動くと、台詞を書けない。素通しにする
// のは検索と取り消しだけで、それ以外は必ず止める側に倒す。
test("only the keys meant to work while typing are marked so", () => {
  const anywhere = SHORTCUTS.filter((s) => s.anywhere).map((s) => s.id);
  assert.deepEqual(anywhere.sort(), ["escape", "search"]);
});

test("displayFor swaps Ctrl for the Mac key only in what is shown", () => {
  const save = SHORTCUTS.find((s) => s.id === "save");
  assert.equal(displayFor(save, false), "Ctrl+S");
  assert.equal(displayFor(save, true), "⌘+S");
  assert.deepEqual(save.combos, ["mod+s"]);
});

test("gestures describe the operations that have no key", () => {
  assert.ok(GESTURES.length > 0);
  for (const g of GESTURES) assert.ok(g.group && g.label);
});
