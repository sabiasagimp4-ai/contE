import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, project, flatten } from "../src/model.js";
import { EditorSession } from "../src/editor-session.js";
import { EditorController } from "../src/editor-controller.js";

test("controller exposes one operation boundary and reports results", () => {
  const results = [];
  const controller = new EditorController(
    new EditorSession(new Store()),
    { onResult: (result) => results.push(result) },
  );
  const first = flatten(controller.store.p)[0].panel.id;
  assert.equal(controller.edit((p) => (p.title = "変更"), "rename").changed, true);
  assert.equal(controller.store.p.title, "変更");
  assert.equal(controller.select({ active: first, ids: [first] }).kind, "select");
  assert.equal(controller.undo().kind, "undo");
  assert.equal(controller.redo().kind, "redo");
  assert.deepEqual(
    results.map((result) => result.kind),
    ["rename", "select", "undo", "redo"],
  );
  assert.equal(controller.capture().revision, 3);
});

test("replace starts a new session through the same controller", () => {
  const controller = new EditorController();
  const before = controller.capture();
  const replacement = project();
  replacement.title = "別Project";
  const result = controller.replace(replacement);
  assert.equal(result.sessionChanged, true);
  assert.equal(controller.store.p.title, "別Project");
  assert.equal(controller.isCurrent(before), false);
  assert.equal(controller.capture().revision, 0);
});
