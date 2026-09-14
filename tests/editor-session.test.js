import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSession } from "../src/editor-session.js";
import { panel, Store, flatten, project } from "../src/model.js";

test("editing returns a revision and does not advance it for a no-op", () => {
  const editor = new EditorSession(new Store());
  const first = editor.capture();
  const changed = editor.edit((p) => (p.title = "コンテ"), "title");

  assert.equal(changed.kind, "title");
  assert.equal(changed.changed, true);
  assert.equal(changed.selectionChanged, false);
  assert.equal(changed.revision, 1);
  assert.equal(editor.isCurrent(first), true);
  assert.equal(editor.isCurrentRevision(first), false);
  assert.equal(editor.isCurrentRevision(editor.capture()), true);

  const noOp = editor.edit((p) => (p.title = p.title), "title");
  assert.equal(noOp.changed, false);
  assert.equal(noOp.revision, 1);
  assert.equal(editor.store.past.length, 1);
});

test("selection changes are reported without becoming project revisions", () => {
  const editor = new EditorSession(new Store());
  editor.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const ids = flatten(editor.store.p).map((row) => row.panel.id);
  const result = editor.select({ active: ids[1], ids: [ids[1]] });

  assert.equal(result.changed, false);
  assert.equal(result.selectionChanged, true);
  assert.equal(result.revision, 1);
  assert.deepEqual(editor.store.selection, { active: ids[1], ids: [ids[1]] });
});

test("undo and redo share the edit result contract", () => {
  const editor = new EditorSession(new Store());
  editor.edit((p) => (p.title = "変更"));

  const undone = editor.undo();
  assert.equal(undone.kind, "undo");
  assert.equal(undone.changed, true);
  assert.equal(undone.revision, 2);
  assert.equal(editor.store.p.title, "無題のコンテ");

  const redone = editor.redo();
  assert.equal(redone.kind, "redo");
  assert.equal(redone.changed, true);
  assert.equal(redone.revision, 3);
  assert.equal(editor.store.p.title, "変更");
});

test("replacing a project invalidates tokens from the previous session", () => {
  const editor = new EditorSession(new Store());
  const oldToken = editor.capture();
  const replacement = project();
  replacement.title = "別のコンテ";

  const result = editor.replace(replacement);

  assert.equal(result.kind, "replace");
  assert.equal(result.sessionChanged, true);
  assert.equal(result.previousSessionId, oldToken.sessionId);
  assert.equal(editor.isCurrent(oldToken), false);
  assert.equal(editor.isCurrent(editor.capture()), true);
  assert.equal(editor.revision, 0);
  assert.equal(editor.store.p.title, "別のコンテ");
});

test("invalid edits remain atomic and do not change the session revision", () => {
  const editor = new EditorSession(new Store());
  const token = editor.capture();

  assert.throws(() =>
    editor.edit((p) => (p.scenes[0].shots[0].panels[0].frames = 0)),
  );
  assert.equal(editor.revision, 0);
  assert.equal(editor.isCurrent(token), true);
  assert.equal(editor.store.p.scenes[0].shots[0].panels[0].frames, 48);
});
