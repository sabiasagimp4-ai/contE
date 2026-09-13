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
} from "../src/model.js";
import { paginate, defaults } from "../src/paper.js";
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
  const pages = paginate(p, { ...defaults, rows: 6 });
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
