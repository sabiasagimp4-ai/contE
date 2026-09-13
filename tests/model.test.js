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
test("stroke sharing cannot mutate history and permits drawing replacement", () => {
  const s = new Store();
  s.edit((p) => {
    p.scenes[0].shots[0].panels[0].strokes = [
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    ];
  });
  const old = s.p.scenes[0].shots[0].panels[0].strokes;
  s.edit((p) => p.scenes[0].shots[0].panels[0].frames++);
  assert.equal(s.p.scenes[0].shots[0].panels[0].strokes, old);
  assert.throws(() => old.push([]));
  s.edit(
    (p) => (p.scenes[0].shots[0].panels[0].strokes = [...old, [[0.5, 0.5]]]),
  );
  s.undo();
  assert.equal(s.p.scenes[0].shots[0].panels[0].strokes.length, 1);
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
