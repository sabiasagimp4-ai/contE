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
const imageAsset = (id, name) => ({
  id,
  kind: "image",
  name,
  mime: "image/png",
  bytes: 8,
  width: 10,
  height: 10,
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

test("replacePanelImage swaps the asset and undo restores the original (B5)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  controller.execute("setPanelImage", {
    panelId,
    asset: imageAsset("old-image", "元の絵.png"),
    opacity: 0.8,
  });
  const before = controller.project;

  const replaced = controller.execute("replacePanelImage", {
    panelIds: [panelId],
    asset: imageAsset("new-image", "差し替え.png"),
  });

  assert.equal(replaced.changed, true);
  const image = flatten(controller.project).find((r) => r.panel.id === panelId).panel.image;
  assert.equal(image.assetId, "new-image");
  assert.equal(image.opacity, 0.8, "opacityを省略したら元の値を保つ");
  assert.equal(before.assets.some((a) => a.id === "old-image"), true, "原本は不変");
  assert.equal(
    controller.project.assets.some((a) => a.id === "old-image"),
    false,
    "使われなくなった画像メタデータが残っている",
  );

  controller.undo();
  const restored = flatten(controller.project).find((r) => r.panel.id === panelId).panel.image;
  assert.equal(restored.assetId, "old-image");
  assert.equal(
    controller.project.assets.find((a) => a.id === "old-image").name,
    "元の絵.png",
  );
});

test("replacePanelImage keeps metadata other panels still reference (B5)", () => {
  const { controller } = controllerWith();
  controller.execute("addPanel", { activeId: controller.activeId });
  const [first, second] = flatten(controller.project).map((r) => r.panel.id);
  for (const panelId of [first, second])
    controller.execute("setPanelImage", {
      panelId,
      asset: imageAsset("shared", "共有.png"),
      opacity: 1,
    });
  assert.equal(controller.project.assets.length, 1);

  controller.execute("replacePanelImage", {
    panelIds: [first],
    asset: imageAsset("new-image", "差し替え.png"),
  });

  const images = flatten(controller.project).map((r) => r.panel.image.assetId);
  assert.deepEqual(images, ["new-image", "shared"]);
  assert.equal(controller.project.assets.length, 2);
});

test("replacePanelImage can set several panels at once", () => {
  const { controller } = controllerWith();
  controller.execute("addPanel", { activeId: controller.activeId });
  const [first, second] = flatten(controller.project).map((r) => r.panel.id);

  controller.execute("replacePanelImage", {
    panelIds: [first, second],
    asset: imageAsset("new-image", "差し替え.png"),
    opacity: 0.5,
  });

  const images = flatten(controller.project).map((r) => r.panel.image);
  assert.equal(images[0].assetId, "new-image");
  assert.equal(images[1].assetId, "new-image");
  assert.equal(images[0].opacity, 0.5);
});

test("distributeFrames splits the total evenly, front panels get the remainder (B6)", () => {
  const { controller } = controllerWith();
  controller.execute("addPanel", { activeId: controller.activeId });
  controller.execute("addPanel", { activeId: controller.activeId });
  const ids = flatten(controller.project).map((r) => r.panel.id);
  assert.equal(ids.length, 3);

  controller.execute("distributeFrames", { ids, total: 10 });
  const frames = flatten(controller.project).map((r) => r.panel.frames);
  assert.deepEqual(frames, [4, 3, 3], "端数は先頭から1fずつ配る");
  assert.equal(frames.reduce((a, b) => a + b), 10);
});

test("distributeFrames never creates a panel under 1 frame (B6)", () => {
  const { controller } = controllerWith();
  controller.execute("addPanel", { activeId: controller.activeId });
  controller.execute("addPanel", { activeId: controller.activeId });
  const ids = flatten(controller.project).map((r) => r.panel.id);

  controller.execute("distributeFrames", { ids, total: 1 });
  const frames = flatten(controller.project).map((r) => r.panel.frames);
  assert.deepEqual(frames, [1, 1, 1], "1本あたりの本数まで切り上げるべき");
});

test("distributeFrames only touches the chosen panels and undoes as one step (B6)", () => {
  const { controller } = controllerWith();
  controller.execute("addPanel", { activeId: controller.activeId });
  controller.execute("addPanel", { activeId: controller.activeId });
  const [first, second, third] = flatten(controller.project).map((r) => r.panel.id);
  const thirdBefore = flatten(controller.project).find((r) => r.panel.id === third)
    .panel.frames;

  controller.execute("distributeFrames", { ids: [first, second], total: 20 });
  const after = flatten(controller.project);
  assert.equal(after.find((r) => r.panel.id === first).panel.frames, 10);
  assert.equal(after.find((r) => r.panel.id === second).panel.frames, 10);
  assert.equal(
    after.find((r) => r.panel.id === third).panel.frames,
    thirdBefore,
    "選んでいないPanelは変わらないべき",
  );

  controller.undo();
  const before = flatten(controller.project);
  assert.equal(before.find((r) => r.panel.id === first).panel.frames, 48);
  assert.equal(before.find((r) => r.panel.id === second).panel.frames, 48);
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

const cameraKeysOf = (controller, panelId) =>
  flatten(controller.project).find((r) => r.panel.id === panelId).panel.camera;

test("setCameraValues applies the same values to every selected key (A10)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  controller.execute("putCameraKey", { panelId, t: 0.5, values: {} });
  controller.execute("putCameraKey", { panelId, t: 1, values: {} });
  controller.execute("setCameraValues", {
    panelId,
    indexes: [0, 1, 2],
    values: { zoom: 2 },
  });
  assert.deepEqual(
    cameraKeysOf(controller, panelId).map((k) => k.zoom),
    [2, 2, 2],
  );
});

test("deleteCameraKey removes several keys at once but never the last one (A10)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  controller.execute("putCameraKey", { panelId, t: 0.5, values: {} });
  controller.execute("putCameraKey", { panelId, t: 1, values: {} });
  const result = controller.execute("deleteCameraKey", {
    panelId,
    indexes: [0, 1],
  });
  assert.equal(result.changed, true);
  assert.equal(cameraKeysOf(controller, panelId).length, 1);
  const refused = controller.execute("deleteCameraKey", {
    panelId,
    indexes: [0],
  });
  assert.equal(refused.changed, false, "最後の1本は消せない");
  assert.equal(cameraKeysOf(controller, panelId).length, 1);
});

test("moveCameraKeys moves a group together and keeps it inside 0..1 (A10)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  controller.execute("putCameraKey", { panelId, t: 0.3, values: {} });
  controller.execute("putCameraKey", { panelId, t: 0.6, values: {} });
  const ts = () => cameraKeysOf(controller, panelId).map((k) => k.t);

  controller.execute("moveCameraKeys", { panelId, indexes: [1, 2], deltaT: 0.1 });
  assert.deepEqual(ts(), [0, 0.4, 0.7]);

  // 端まで動かしても間隔を保ったまま、範囲の外へは出ない（潰れて重ならない）。
  controller.execute("moveCameraKeys", { panelId, indexes: [1, 2], deltaT: 10 });
  assert.deepEqual(ts(), [0, 0.7, 1]);
});

test("moveCameraKeys evicts an unselected key it lands on exactly (A10)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  controller.execute("putCameraKey", { panelId, t: 0.5, values: { zoom: 9 } });
  controller.execute("moveCameraKeys", { panelId, indexes: [0], deltaT: 0.5 });
  const keys = cameraKeysOf(controller, panelId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].t, 0.5);
  assert.equal(keys[0].zoom, 1, "動かした側のキーが優先で残るべき");
});

test("moveCameraKeys undoes as a single step for the whole group (A10)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  controller.execute("putCameraKey", { panelId, t: 0.3, values: {} });
  controller.execute("putCameraKey", { panelId, t: 0.6, values: {} });
  const before = cameraKeysOf(controller, panelId).map((k) => k.t);
  controller.execute("moveCameraKeys", {
    panelId,
    indexes: [0, 1, 2],
    deltaT: 0.05,
  });
  controller.undo();
  assert.deepEqual(cameraKeysOf(controller, panelId).map((k) => k.t), before);
});

test("pasteCameraKeys replace swaps the whole set but never leaves 0 keys (B4)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  const keys = [
    { t: 0, x: 0.2, y: 0, zoom: 1, rotation: 0 },
    { t: 0.5, x: 0.4, y: 0, zoom: 2, rotation: 0 },
  ];
  controller.execute("pasteCameraKeys", { panelId, keys, mode: "replace" });
  assert.deepEqual(cameraKeysOf(controller, panelId), keys);

  const refused = controller.execute("pasteCameraKeys", {
    panelId,
    keys: [],
    mode: "replace",
  });
  assert.equal(refused.changed, false, "空のクリップボードでは0本にしてはいけない");
  assert.equal(cameraKeysOf(controller, panelId).length, 2);
});

test("pasteCameraKeys merge only overwrites keys at the same t (B4)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  controller.execute("putCameraKey", { panelId, t: 0.5, values: { zoom: 5 } });
  // t=0(既存の初期キー) と t=0.5(上のキーと同じt) を貼り付け、t=1は新規で足す。
  const keys = [
    { t: 0, x: 0.9, y: 0, zoom: 1, rotation: 0 },
    { t: 0.5, x: 0, y: 0, zoom: 9, rotation: 0 },
    { t: 1, x: 0, y: 0, zoom: 1, rotation: 0 },
  ];
  controller.execute("pasteCameraKeys", { panelId, keys, mode: "merge" });
  const after = cameraKeysOf(controller, panelId);
  assert.equal(after.length, 3);
  assert.equal(after.find((k) => k.t === 0).x, 0.9, "同じtの既存キーを上書きしていない");
  assert.equal(after.find((k) => k.t === 0.5).zoom, 9);
  assert.ok(after.find((k) => k.t === 1), "新しいtのキーが足されていない");
});

test("pasteCameraKeys keeps the t ratio, so the shape survives a different frame count (B4)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  const keys = [
    { t: 0, x: 0, y: 0, zoom: 1, rotation: 0 },
    { t: 0.25, x: 1, y: 0, zoom: 1, rotation: 0 },
  ];
  controller.execute("setPanelFrames", { ids: [panelId], frames: 200 });
  controller.execute("pasteCameraKeys", { panelId, keys, mode: "replace" });
  const after = cameraKeysOf(controller, panelId);
  assert.deepEqual(
    after.map((k) => k.t),
    [0, 0.25],
    "尺を変えてもtの比率は変わらない",
  );
});

test("pasteCameraKeys undoes as a single step (B4)", () => {
  const { controller } = controllerWith();
  const panelId = controller.activeId;
  const before = cameraKeysOf(controller, panelId);
  controller.execute("pasteCameraKeys", {
    panelId,
    keys: [
      { t: 0, x: 1, y: 1, zoom: 3, rotation: 10 },
      { t: 0.5, x: 0, y: 0, zoom: 1, rotation: 0 },
    ],
    mode: "replace",
  });
  controller.undo();
  assert.deepEqual(cameraKeysOf(controller, panelId), before);
});
