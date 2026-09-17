import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSession } from "../src/editor-session.js";
import { EditorController } from "../src/application/editor-controller.js";
import { commands, changeSetOf, labelOf } from "../src/application/commands.js";
import { Store, flatten, project, panel } from "../src/model.js";
import { addClip } from "../src/audio.js";

const controllerWith = (store = new Store()) => {
  const events = [];
  const controller = new EditorController(new EditorSession(store));
  controller.subscribe((result) => events.push(result));
  return { controller, events };
};
const ids = (controller) =>
  flatten(controller.project).map((row) => row.panel.id);

test("every command runs through one commit with one notification", () => {
  const { controller, events } = controllerWith();
  const result = controller.execute("addPanel", {
    activeId: controller.activeId,
  });

  assert.equal(events.length, 1, "確定編集ごとの通知は一回");
  assert.equal(events[0], result);
  assert.equal(result.changed, true);
  assert.equal(result.revision, 1);
  assert.equal(flatten(controller.project).length, 2);
  // 追加したPanelが選択され、変更範囲は構成と時間として通知される。
  assert.equal(controller.activeId, ids(controller)[1]);
  assert.deepEqual([...result.changes.kinds], ["structure", "timing"]);
  assert.equal(result.changes.all, false);
});

test("a no-op command consumes neither history nor a save", () => {
  const { controller, events } = controllerWith();
  controller.execute("setTitle", { title: "題名" });
  const again = controller.execute("setTitle", { title: "題名" });

  assert.equal(again.changed, false);
  assert.deepEqual([...again.changes.kinds], []);
  assert.equal(again.changes.all, false);
  assert.equal(controller.store.past.length, 1);
  assert.equal(events.length, 2);
  assert.equal(again.revision, 1);
});

test("a rejected command keeps the project, history and revision", () => {
  const { controller, events } = controllerWith();
  const only = controller.activeId;
  const failure = controller.execute("deletePanels", { ids: [only] });

  assert.equal(failure.failed, true);
  assert.equal(failure.changed, false);
  assert.match(failure.error.message, /最低1つのPanel/);
  assert.equal(events.length, 1, "失敗も通知は一回");
  assert.equal(flatten(controller.project).length, 1);
  assert.equal(controller.store.past.length, 0);
  assert.equal(controller.session.revision, 0);
});

test("text edits do not report timing or structure as changed", () => {
  const { controller } = controllerWith();
  const target = controller.activeId;
  const text = controller.execute("setPanelField", {
    ids: [target],
    field: "dialogue",
    value: "おはよう",
  });
  assert.deepEqual([...text.changes.kinds], ["text"]);
  assert.deepEqual([...text.changes.panelIds], [target]);

  const timing = controller.execute("setPanelFrames", {
    ids: [target],
    frames: 72,
  });
  assert.deepEqual([...timing.changes.kinds], ["timing"]);
  assert.equal(flatten(controller.project)[0].end, 72);
});

test("the UI and tests share the scene command", () => {
  const { controller } = controllerWith();
  const added = controller.execute("addScene", {});
  assert.equal(added.changed, true);
  assert.equal(controller.project.scenes.length, 2);
  assert.equal(controller.project.scenes[1].name, "シーン02");

  const undone = controller.undo();
  assert.equal(undone.changed, true);
  assert.equal(undone.changes.all, true, "Undoの変更範囲は当面all");
  assert.equal(controller.project.scenes.length, 1);
});

test("deleting panels drops their audio and reports the affected ids", () => {
  const store = new Store();
  store.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const { controller } = controllerWith(store);
  const [first, second] = ids(controller);
  controller.edit((p) => {
    p.assets.push({
      id: "sound-1",
      kind: "audio",
      name: "a.wav",
      mime: "audio/wav",
      bytes: 4,
    });
    addClip(p, {
      assetId: "sound-1",
      track: "se",
      anchor: second,
      at: 0,
      frames: 10,
    });
  });
  assert.equal(controller.project.audio.length, 1);

  const removed = controller.execute("deletePanels", { ids: [second] });
  assert.equal(removed.changed, true);
  assert.deepEqual([...removed.changes.panelIds], [second]);
  assert.equal(controller.project.audio.length, 0);
  assert.equal(controller.project.assets.length, 0);
  assert.equal(controller.activeId, first);
});

test("selection changes never schedule a project revision", () => {
  const store = new Store();
  store.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const { controller, events } = controllerWith(store);
  const [, second] = ids(controller);

  const before = controller.session.revision;
  const result = controller.select({ active: second, ids: [second] });
  assert.equal(result.changed, false);
  assert.equal(result.selectionChanged, true);
  assert.equal(result.changes.all, false);
  assert.deepEqual([...result.changes.kinds], []);
  // 選択だけの変化はProjectのrevisionを進めない。
  assert.equal(controller.session.revision, before);
  assert.equal(events.length, 1);
});

test("the compatibility path reports an unknown change range", () => {
  const { controller } = controllerWith();
  const result = controller.edit((p) => (p.title = "手書きの編集"));
  assert.equal(result.changed, true);
  assert.equal(result.changes.all, true);
});

test("every command declares a change range and is callable", () => {
  for (const name of Object.keys(commands)) {
    const set = changeSetOf(name, {
      ids: [],
      asset: { id: "a" },
      anchor: "panel",
      panelId: "panel",
    });
    assert.ok(set.kinds.length > 0, `${name} に変更種類がない`);
    assert.equal(typeof commands[name].run, "function");
  }
});

test("commands run before a project replacement never reach the new session", () => {
  const { controller } = controllerWith();
  const token = controller.capture();
  controller.replace(project());

  assert.equal(controller.isCurrent(token), false);
  assert.equal(controller.isCurrentRevision(controller.capture()), true);
});

test("subscribers can be released with the returned function", () => {
  const controller = new EditorController(new EditorSession(new Store()));
  let calls = 0;
  const release = controller.subscribe(() => calls++);
  controller.execute("setTitle", { title: "一回目" });
  release();
  controller.execute("setTitle", { title: "二回目" });
  assert.equal(calls, 1, "解除後の通知が残っている");
});

test("stopping playback happens once per command, before the commit", () => {
  const calls = [];
  const controller = new EditorController(new EditorSession(new Store()), {
    beforeCommand: () => calls.push("stop"),
  });
  controller.subscribe(() => calls.push("notify"));
  controller.execute("setTitle", { title: "再生中の編集" });
  controller.select(controller.selection);
  controller.undo();

  assert.deepEqual(calls, [
    "stop",
    "notify",
    "stop",
    "notify",
    "stop",
    "notify",
  ]);
});

const audioAsset = (id, name) => ({
  id,
  kind: "audio",
  name,
  mime: "audio/wav",
  bytes: 8,
});

test("replacing a clip's source keeps the original reachable through undo", () => {
  const { controller } = controllerWith();
  const anchor = controller.activeId;
  controller.execute("addAudioClip", {
    clipId: "clip-1",
    asset: audioAsset("old-asset", "元の音.wav"),
    track: "se",
    anchor,
    at: 0,
    frames: 12,
  });
  const before = controller.project;

  const replaced = controller.execute("replaceClipAsset", {
    clipId: "clip-1",
    asset: audioAsset("new-asset", "差し替え.wav"),
  });

  assert.equal(replaced.changed, true);
  assert.deepEqual([...replaced.changes.assetIds], ["new-asset"]);
  assert.equal(controller.project.audio[0].assetId, "new-asset");
  // 原本は不変。古いProjectは元の素材を指したままにする。
  assert.equal(before.audio[0].assetId, "old-asset");
  assert.equal(
    controller.project.assets.some((a) => a.id === "old-asset"),
    false,
    "使われなくなった素材メタデータが現在のProjectに残っている",
  );

  controller.undo();
  assert.equal(controller.project.audio[0].assetId, "old-asset");
  assert.equal(
    controller.project.assets.find((a) => a.id === "old-asset").name,
    "元の音.wav",
  );
});

test("replacing one clip leaves other clips on the original source", () => {
  const { controller } = controllerWith();
  const anchor = controller.activeId;
  for (const clipId of ["clip-1", "clip-2"])
    controller.execute("addAudioClip", {
      clipId,
      asset: audioAsset("shared", "共有.wav"),
      track: "se",
      anchor,
      at: 0,
      frames: 12,
    });
  assert.equal(controller.project.assets.length, 1);

  controller.execute("replaceClipAsset", {
    clipId: "clip-1",
    asset: audioAsset("new-asset", "差し替え.wav"),
  });

  const [first, second] = controller.project.audio;
  assert.equal(first.assetId, "new-asset");
  assert.equal(second.assetId, "shared", "他のクリップまで差し替わっている");
  assert.equal(controller.project.assets.length, 2);
});

test("replacing a clip that no longer exists changes nothing", () => {
  const { controller } = controllerWith();
  const result = controller.execute("replaceClipAsset", {
    clipId: "missing",
    asset: audioAsset("new-asset", "差し替え.wav"),
  });
  assert.equal(result.changed, false);
  assert.equal(controller.project.assets.length, 0);
  assert.equal(controller.store.past.length, 0);
});

test("pasting panels duplicates them with new ids after the target", () => {
  const { controller } = controllerWith();
  const first = controller.activeId;
  controller.execute("setPanelField", {
    ids: [first],
    field: "dialogue",
    value: "元のコマ",
  });
  const source = flatten(controller.project)[0].panel;

  const pasted = controller.execute("pastePanels", {
    afterId: first,
    panels: [structuredClone(source), structuredClone(source)],
  });

  const rows = flatten(controller.project);
  assert.equal(pasted.changed, true);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.panel.dialogue),
    ["元のコマ", "元のコマ", "元のコマ"],
  );
  // 貼り付けたPanelは別のIDを持ち、選択もそちらへ移る。
  const ids = rows.map((r) => r.panel.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(controller.activeId, ids[1]);
  assert.deepEqual(controller.selectedIds, [ids[1], ids[2]]);

  controller.undo();
  assert.equal(flatten(controller.project).length, 1);
});

test("pasting carries the asset metadata its panels reference", () => {
  const { controller } = controllerWith();
  const first = controller.activeId;
  const asset = {
    id: "image-1",
    kind: "image",
    name: "bg.png",
    mime: "image/png",
    bytes: 32,
  };
  const source = structuredClone(flatten(controller.project)[0].panel);
  source.image = { assetId: "image-1", opacity: 1 };

  controller.execute("pastePanels", {
    afterId: first,
    panels: [source],
    assets: [asset],
  });

  const pasted = flatten(controller.project)[1].panel;
  assert.equal(pasted.image.assetId, "image-1");
  assert.equal(controller.project.assets.length, 1);
  assert.equal(controller.project.assets[0].name, "bg.png");
});

test("pasting drops image references it cannot carry", () => {
  const { controller } = controllerWith();
  const source = structuredClone(flatten(controller.project)[0].panel);
  source.image = { assetId: "missing", opacity: 1 };

  const result = controller.execute("pastePanels", {
    afterId: controller.activeId,
    panels: [source],
  });

  assert.equal(result.failed, undefined, "壊れた参照で編集ごと失敗している");
  assert.equal(flatten(controller.project)[1].panel.image, null);
  assert.equal(controller.project.assets.length, 0);
});

test("pasting nothing changes nothing", () => {
  const { controller } = controllerWith();
  const result = controller.execute("pastePanels", {
    afterId: controller.activeId,
    panels: [],
  });
  assert.equal(result.changed, false);
  assert.equal(controller.store.past.length, 0);
});

test("setBoundary moves frames between two panels without changing the total", () => {
  const store = new Store();
  store.edit((p) => p.scenes[0].shots[0].panels.push(panel(), panel()));
  const { controller } = controllerWith(store);
  const [first, second] = ids(controller);
  const totalBefore = controller.project.scenes[0].shots[0].panels[0].frames +
    controller.project.scenes[0].shots[0].panels[1].frames;

  const result = controller.execute("setBoundary", {
    leftId: first,
    rightId: second,
    leftFrames: 60,
  });

  assert.equal(result.changed, true);
  assert.deepEqual([...result.changes.kinds], ["timing"]);
  const [leftPanel, rightPanel] = controller.project.scenes[0].shots[0].panels;
  assert.equal(leftPanel.frames, 60);
  assert.equal(leftPanel.frames + rightPanel.frames, totalBefore);
});

test("setBoundary never lets either side drop below 1 frame", () => {
  const store = new Store();
  store.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const { controller } = controllerWith(store);
  const [first, second] = ids(controller);
  const total = controller.project.scenes[0].shots[0].panels[0].frames +
    controller.project.scenes[0].shots[0].panels[1].frames;

  controller.execute("setBoundary", { leftId: first, rightId: second, leftFrames: -50 });
  let [leftPanel, rightPanel] = controller.project.scenes[0].shots[0].panels;
  assert.equal(leftPanel.frames, 1);
  assert.equal(rightPanel.frames, total - 1);

  controller.execute("setBoundary", {
    leftId: first,
    rightId: second,
    leftFrames: total + 999,
  });
  [leftPanel, rightPanel] = controller.project.scenes[0].shots[0].panels;
  assert.equal(leftPanel.frames, total - 1);
  assert.equal(rightPanel.frames, 1);
});

test("setBoundary undoes as a single step for both panels", () => {
  const store = new Store();
  store.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const { controller } = controllerWith(store);
  const [first, second] = ids(controller);
  const before = controller.project.scenes[0].shots[0].panels.map(
    (b) => b.frames,
  );

  controller.execute("setBoundary", { leftId: first, rightId: second, leftFrames: 20 });
  controller.undo();

  const after = controller.project.scenes[0].shots[0].panels.map(
    (b) => b.frames,
  );
  assert.deepEqual(after, before);
});

test("undo/redo report the Command name as kind, with a label for display (A7)", () => {
  const store = new Store();
  store.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const { controller } = controllerWith(store);
  const [first, second] = ids(controller);

  controller.execute("setBoundary", { leftId: first, rightId: second, leftFrames: 20 });
  const undone = controller.undo();
  assert.equal(undone.undoneKind, "setBoundary");
  assert.equal(labelOf(undone.undoneKind), "境界の移動");

  const redone = controller.redo();
  assert.equal(redone.undoneKind, "setBoundary");

  // 未知のkindでも表示は落ちない。
  assert.equal(labelOf("foo"), "編集");
});

test("setBoundary changes nothing for an unknown panel id", () => {
  const { controller } = controllerWith();
  const result = controller.execute("setBoundary", {
    leftId: "missing",
    rightId: controller.activeId,
    leftFrames: 10,
  });
  assert.equal(result.changed, false);
  assert.equal(controller.store.past.length, 0);
});
