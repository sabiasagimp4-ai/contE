import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Store,
  project,
  panel,
  flatten,
  split,
  merge,
  load,
  cameraAt,
  movePanels,
  BRUSH,
  setCameraKey,
  moveCameraKey,
  removeCameraKey,
  describeCamera,
  clearPanelImage,
  scene,
  sceneName,
} from "../src/model.js";
import { layoutPages } from "../src/paper.js";
test("split and merge preserve frames, order and undo identity", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel(), panel()));
  const before = JSON.stringify(s.p),
    id = flatten(s.p)[1].panel.id;
  s.edit((p) => split(p, id));
  assert.equal(s.p.scenes[0].shots.length, 2);
  assert.equal(flatten(s.p).at(-1).end, 144);
  s.edit((p) => merge(p, id));
  assert.equal(JSON.stringify(s.p), before);
  s.undo();
  assert.equal(s.p.scenes[0].shots.length, 2);
  s.redo();
  assert.equal(JSON.stringify(s.p), before);
});
test("invalid edit is atomic and leaves redo intact", () => {
  const s = new Store();
  s.edit((p) => (p.title = "changed"));
  s.undo();
  const old = JSON.stringify(s.p);
  assert.throws(() =>
    s.edit((p) => (p.scenes[0].shots[0].panels[0].frames = 0)),
  );
  assert.equal(JSON.stringify(s.p), old);
  s.redo();
  assert.equal(s.p.title, "changed");
});
test("save/load rejects future schemas, duplicate ids and invalid geometry", () => {
  const p = project();
  assert.deepEqual(load(JSON.stringify(p)), p);
  assert.throws(() => load("{"));
  assert.throws(() => load(JSON.stringify({ ...p, version: 99 })));
  p.scenes[0].shots[0].panels.push(
    structuredClone(p.scenes[0].shots[0].panels[0]),
  );
  assert.throws(() => load(JSON.stringify(p)));
});
test("camera interpolates and clamps endpoint", () => {
  const b = panel();
  b.camera.push({ t: 1, x: 1, y: -1, zoom: 2, rotation: 90 });
  assert.deepEqual(cameraAt(b, 0.5), {
    x: 0.5,
    y: -0.5,
    zoom: 1.5,
    rotation: 45,
  });
  assert.equal(cameraAt(b, 2).zoom, 2);
});
test("500 panels paginate exactly once with continuous frame boundaries", () => {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: 500 }, panel);
  const pages = layoutPages(
    p,
    { ...p.paper, rows: 6 },
    (text, size) => [...text].length * size * 0.6,
  );
  assert.equal(pages.length, 84);
  assert.equal(pages.flat().length, 500);
  assert.equal(flatten(p).at(-1).end, 24000);
});
const line = (points, extra = {}) => ({
  size: BRUSH.default,
  erase: false,
  points,
  ...extra,
});
test("stroke sharing cannot mutate history and permits drawing replacement", () => {
  const s = new Store();
  s.edit((p) => {
    p.scenes[0].shots[0].panels[0].strokes = [
      line([
        [0.1, 0.2, 1],
        [0.3, 0.4, 0.5],
      ]),
    ];
  });
  const old = s.p.scenes[0].shots[0].panels[0].strokes;
  s.edit((p) => p.scenes[0].shots[0].panels[0].frames++);
  assert.equal(s.p.scenes[0].shots[0].panels[0].strokes, old);
  assert.throws(() => old.push(line([[0, 0, 1]])));
  assert.throws(() => (old[0].size = 0.01));
  assert.throws(() => old[0].points.push([0.5, 0.5, 1]));
  s.edit(
    (p) =>
      (p.scenes[0].shots[0].panels[0].strokes = [
        ...old,
        line([[0.5, 0.5, 1]], { erase: true }),
      ]),
  );
  s.undo();
  assert.equal(s.p.scenes[0].shots[0].panels[0].strokes.length, 1);
});
test("brush size, eraser flag and pressure are validated", () => {
  const s = new Store();
  const set = (stroke) => () =>
    s.edit((p) => (p.scenes[0].shots[0].panels[0].strokes = [stroke]));
  assert.throws(set(line([[0.1, 0.1, 0]])), /ストローク/);
  assert.throws(set(line([[0.1, 0.1, 1.5]])), /ストローク/);
  assert.throws(set(line([[0.1, 0.1]])), /ストローク/);
  assert.throws(set(line([[0.1, 0.1, 1]], { size: 0 })), /ストローク/);
  assert.throws(set(line([[0.1, 0.1, 1]], { size: 1 })), /ストローク/);
  assert.throws(set(line([[0.1, 0.1, 1]], { erase: "yes" })), /ストローク/);
  assert.equal(set(line([[0.1, 0.1, 0.3]], { erase: true }))(), true);
});
test("panels move between shots and scenes keeping global order", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel(), panel()));
  const ids = flatten(s.p).map((r) => r.panel.id);
  s.edit((p) => split(p, ids[2]));
  s.edit((p) => {
    p.scenes.push({
      id: "scene-2",
      name: "シーン02",
      shots: [{ id: "shot-2", name: "", panels: [panel()] }],
    });
  });
  const last = flatten(s.p).at(-1).panel.id;
  // 別Sceneの末尾Panelを、先頭Shotの2番目の前へ移す。
  s.edit((p) => movePanels(p, [last], ids[1], "before"));
  assert.deepEqual(
    flatten(s.p).map((r) => r.panel.id),
    [ids[0], last, ids[1], ids[2]],
  );
  // 空になったShot/Sceneは残さない。
  assert.equal(s.p.scenes.length, 1);
  s.undo();
  assert.equal(s.p.scenes.length, 2);
});
test("moving onto itself or an unknown anchor changes nothing", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const [a, b] = flatten(s.p).map((r) => r.panel.id);
  assert.equal(
    s.edit((p) => movePanels(p, [a], a)),
    false,
  );
  assert.equal(
    s.edit((p) => movePanels(p, [a], "missing")),
    false,
  );
  assert.equal(
    s.edit((p) => movePanels(p, [], b)),
    false,
  );
  assert.deepEqual(
    flatten(s.p).map((r) => r.panel.id),
    [a, b],
  );
});
test("no-op commands consume neither history nor redo", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  s.undo();
  const head = flatten(s.p)[0].panel.id;
  assert.equal(
    s.edit((p) => split(p, head)),
    false,
  );
  assert.equal(
    s.edit((p) => merge(p, head)),
    false,
  );
  assert.equal(
    s.edit((p) => (p.title = s.p.title)),
    false,
  );
  assert.equal(s.past.length, 0);
  s.redo();
  assert.equal(flatten(s.p).length, 2);
});
test("undo restores the selection the edit started from", () => {
  const s = new Store();
  const first = flatten(s.p)[0].panel.id;
  s.edit((p) => {
    const b = panel();
    p.scenes[0].shots[0].panels.push(b);
    return { active: b.id, ids: [b.id] };
  });
  const added = s.selection.active;
  assert.notEqual(added, first);
  s.undo();
  assert.deepEqual(s.selection, { active: first, ids: [first] });
  s.redo();
  assert.deepEqual(s.selection, { active: added, ids: [added] });
});
test("a command returning a plain value keeps the selection it had", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel(), panel()));
  const second = flatten(s.p)[1].panel.id;
  s.select({ active: second, ids: [second] });
  // 代入式の戻り値（数値・真偽値・配列）を選択と取り違えない。
  for (const command of [
    (p) => (p.scenes[0].shots[0].panels[2].frames = 60),
    (p) => true,
    (p) =>
      (p.scenes[0].shots[0].panels[1].strokes = [
        { size: BRUSH.default, erase: false, points: [[0.2, 0.2, 1]] },
      ]),
    (p) => (p.title = `題 ${p.scenes[0].shots[0].panels[2].frames}`),
  ]) {
    s.edit(command);
    assert.equal(s.selection.active, second);
    assert.deepEqual(s.selection.ids, [second]);
  }
});
test("deleting the selected panel moves selection to a surviving panel", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel(), panel()));
  const [a, b] = flatten(s.p).map((r) => r.panel.id);
  s.select({ active: b, ids: [b] });
  s.edit((p) => {
    p.scenes[0].shots[0].panels = p.scenes[0].shots[0].panels.filter(
      (x) => x.id !== b,
    );
  });
  assert.equal(s.selection.active, a);
  assert.deepEqual(s.selection.ids, [a]);
  s.undo();
  assert.equal(s.selection.active, b);
});
test("active selection always remains inside the selected panel ids", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const [a, b] = flatten(s.p).map((r) => r.panel.id);
  s.select({ active: b, ids: [a, b] });
  const selection = s.select({ active: b, ids: [a] });
  assert.deepEqual(selection, { active: a, ids: [a] });
});
test("clearing an image preserves audio asset metadata and clips", () => {
  const p = project();
  const target = flatten(p)[0].panel;
  p.assets.push(
    {
      id: "image-1",
      kind: "image",
      name: "board.png",
      mime: "image/png",
      bytes: 4,
      width: 2,
      height: 2,
    },
    {
      id: "audio-1",
      kind: "audio",
      name: "voice.wav",
      mime: "audio/wav",
      bytes: 8,
    },
  );
  target.image = { assetId: "image-1", opacity: 1 };
  p.audio.push({
    id: "clip-1",
    assetId: "audio-1",
    track: "dialogue",
    anchor: target.id,
    at: 0,
    frames: 24,
    offset: 0,
    gain: 1,
  });
  assert.equal(clearPanelImage(p, target.id), true);
  assert.deepEqual(
    p.assets.map((asset) => asset.id),
    ["audio-1"],
  );
  assert.doesNotThrow(() => new Store(p));
});
test("camera keys can be added, moved and removed at any time", () => {
  const b = panel();
  const at = setCameraKey(b, 0.5, { x: 1, zoom: 2 });
  assert.equal(at, 1);
  assert.equal(b.camera.length, 2);
  // 追加しただけでは、その時点の映りは変わらない。
  const mid = setCameraKey(b, 0.25);
  assert.deepEqual(cameraAt(b, 0.25), { x: 0.5, y: 0, zoom: 1.5, rotation: 0 });
  assert.equal(b.camera[mid].t, 0.25);
  assert.ok(b.camera.every((k, i) => !i || k.t > b.camera[i - 1].t));
  assert.equal(moveCameraKey(b, 1, 0.75), true);
  assert.deepEqual(
    b.camera.map((k) => k.t),
    [0, 0.5, 0.75],
  );
  // 同じ時刻へ重ねたキーは1本にまとめる。
  assert.equal(moveCameraKey(b, 2, 0.5), true);
  assert.equal(b.camera.length, 2);
  assert.equal(removeCameraKey(b, 1), true);
  assert.equal(removeCameraKey(b, 0), false, "最後の1本は消せない");
  assert.equal(b.camera.length, 1);
});
test("camera keys stay valid and stretch with the panel duration", () => {
  const s = new Store();
  const id = flatten(s.p)[0].panel.id;
  s.edit((p) => {
    setCameraKey(flatten(p)[0].panel, 1, { x: 1 });
  });
  assert.equal(flatten(s.p)[0].panel.camera.length, 2);
  // 尺を倍にしても比率は変わらない。動きだけが伸びる。
  s.edit((p) => (flatten(p)[0].panel.frames = 96));
  const b = flatten(s.p)[0].panel;
  assert.deepEqual(
    b.camera.map((k) => k.t),
    [0, 1],
  );
  assert.equal(cameraAt(b, 0.5).x, 0.5);
  s.undo();
  s.undo();
  assert.equal(flatten(s.p)[0].panel.camera.length, 1);
  assert.equal(flatten(s.p)[0].panel.id, id);
});
test("camera description names the move for paper and inspector", () => {
  const b = panel();
  assert.deepEqual(describeCamera(b), {
    keys: b.camera,
    moves: [],
    hold: true,
  });
  setCameraKey(b, 1, { x: 0.4, y: -0.3, zoom: 0.5, rotation: 10 });
  assert.deepEqual(describeCamera(b).moves, [
    "PAN →",
    "TILT ↑",
    "ZOOM OUT",
    "ROLL ↻",
  ]);
  assert.equal(describeCamera(b).hold, false);
});
test("splitting a shot keeps every camera key with its own panel", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel(), panel()));
  s.edit((p) => {
    const rows = flatten(p);
    setCameraKey(rows[1].panel, 0.5, { x: 0.5 });
    setCameraKey(rows[1].panel, 1, { zoom: 2 });
    setCameraKey(rows[2].panel, 1, { y: 0.25 });
  });
  const before = flatten(s.p).map((r) => cameraAt(r.panel, 0.5));
  s.edit((p) => split(p, flatten(p)[1].panel.id));
  assert.equal(s.p.scenes[0].shots.length, 2);
  assert.deepEqual(
    flatten(s.p).map((r) => cameraAt(r.panel, 0.5)),
    before,
  );
  s.undo();
  assert.deepEqual(
    flatten(s.p).map((r) => cameraAt(r.panel, 0.5)),
    before,
  );
  assert.deepEqual(
    flatten(s.p).map((r) => r.panel.camera.length),
    [1, 3, 2],
  );
});
test("scene and shot factories always produce validatable branches", () => {
  const s = new Store();
  // UIのScene追加と同じ生成経路を使う。名前を書き忘れた枝はここで作れない。
  s.edit((p) => {
    const added = scene(sceneName(p.scenes.length + 1));
    p.scenes.push(added);
    return { active: added.shots[0].panels[0].id, ids: [] };
  });
  assert.equal(s.p.scenes.length, 2);
  assert.equal(s.p.scenes[1].name, "シーン02");
  assert.equal(s.p.scenes[1].shots[0].name, "");
  assert.equal(flatten(s.p).length, 2);
  assert.equal(s.selection.active, s.p.scenes[1].shots[0].panels[0].id);
  s.undo();
  assert.equal(s.p.scenes.length, 1);
  s.redo();
  assert.equal(s.p.scenes.length, 2);
  assert.deepEqual(load(JSON.stringify(s.p)), s.p);
});
test("split reuses the shot factory so new shots stay valid", () => {
  const s = new Store();
  s.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const id = flatten(s.p)[1].panel.id;
  s.edit((p) => split(p, id));
  const created = s.p.scenes[0].shots[1];
  assert.equal(created.name, "");
  assert.equal(typeof created.id, "string");
  assert.deepEqual(load(JSON.stringify(s.p)), s.p);
});
