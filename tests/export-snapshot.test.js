import { test } from "node:test";
import assert from "node:assert/strict";
import { project, flatten } from "../src/model.js";
import {
  createExportSnapshot,
  snapshotAssetIds,
} from "../src/export-snapshot.js";

test("export snapshot is independent from later edits", () => {
  const p = project();
  const originalId = flatten(p)[0].panel.id;
  const snapshot = createExportSnapshot(p, {
    sessionId: "session-1",
    revision: 4,
  });
  p.title = "後から変更";
  p.scenes[0].shots[0].panels[0].frames = 120;
  assert.equal(snapshot.project.title, "無題のコンテ");
  assert.equal(snapshot.endFrame, 48);
  assert.equal(snapshot.rows[0].panel.id, originalId);
  assert.equal(snapshot.rows[0].end, 48);
  assert.deepEqual([...snapshotAssetIds(snapshot)], []);
  assert.equal(snapshot.sessionId, "session-1");
  assert.equal(snapshot.revision, 4);
});

test("snapshot project is deeply read-only", () => {
  const snapshot = createExportSnapshot(project());
  assert.throws(() => (snapshot.project.title = "変更"));
  assert.throws(() => (snapshot.project.scenes[0].shots[0].panels[0].frames = 1));
  assert.equal(snapshot.project.title, "無題のコンテ");
});
