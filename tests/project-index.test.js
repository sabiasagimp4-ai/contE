import { test } from "node:test";
import assert from "node:assert/strict";
import { project, panel, scene, flatten } from "../src/model.js";
import { buildProjectIndex, rowOf } from "../src/project-index.js";

test("project index preserves timeline order and frame boundaries", () => {
  const p = project();
  const first = p.scenes[0].shots[0].panels[0];
  first.frames = 12;
  p.scenes[0].shots[0].panels.push(panel());
  p.scenes.push(scene("シーン02"));

  const index = buildProjectIndex(p);
  const rows = flatten(p);
  assert.equal(index.rows.length, rows.length);
  assert.deepEqual(
    index.panelIds,
    rows.map((row) => row.panel.id),
  );
  assert.equal(index.totalFrames, rows.at(-1).end);
  assert.equal(rowOf(index, first.id).start, 0);
  assert.equal(rowOf(index, first.id).end, 12);
  assert.equal(index.rowsByShotId.get(p.scenes[0].shots[0].id).length, 2);
  assert.equal(index.rowsBySceneId.get(p.scenes[1].id).length, 1);
});

test("index lookup returns null for an unknown panel", () => {
  const index = buildProjectIndex(project());
  assert.equal(rowOf(index, "missing"), null);
});

test("index rejects duplicate panel ids instead of overwriting a lookup", () => {
  const p = project();
  const duplicate = structuredClone(p.scenes[0].shots[0].panels[0]);
  p.scenes[0].shots[0].panels.push(duplicate);
  assert.throws(() => buildProjectIndex(p), /重複したPanel/);
});
