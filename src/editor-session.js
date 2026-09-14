import { Store } from "./model.js";

let fallbackId = 0;

function sessionId() {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  fallbackId += 1;
  return `session-${fallbackId}`;
}

const copySelection = (selection) => ({
  active: selection.active,
  ids: [...selection.ids],
});

const sameSelection = (a, b) =>
  a.active === b.active &&
  a.ids.length === b.ids.length &&
  a.ids.every((id, index) => id === b.ids[index]);

/**
 * Owns the lifetime of the current editor Store and identifies its revisions.
 *
 * The session deliberately has no DOM or persistence dependency. UI code can
 * use the result of each operation to decide whether to save, render, or only
 * refresh selection. A project replacement starts a new session identity so
 * late async work from the previous project can be rejected.
 */
export class EditorSession {
  constructor(store = new Store()) {
    if (!store || typeof store.edit !== "function")
      throw Error("EditorSessionにはStoreが必要です");
    this.store = store;
    this.sessionId = sessionId();
    this.revision = 0;
  }

  capture() {
    return Object.freeze({
      sessionId: this.sessionId,
      revision: this.revision,
    });
  }

  isCurrent(token) {
    return !!token && token.sessionId === this.sessionId;
  }

  isCurrentRevision(token) {
    return this.isCurrent(token) && token.revision === this.revision;
  }

  #result(kind, changed, selectionChanged, extra = {}) {
    return Object.freeze({
      kind,
      changed,
      selectionChanged,
      sessionId: this.sessionId,
      revision: this.revision,
      ...extra,
    });
  }

  #selectionChange(before) {
    return !sameSelection(before, this.store.selection);
  }

  edit(fn, kind = "edit") {
    const before = copySelection(this.store.selection);
    const changed = this.store.edit(fn);
    const selectionChanged = this.#selectionChange(before);
    if (changed) this.revision += 1;
    return this.#result(kind, changed, selectionChanged);
  }

  select(selection) {
    const before = copySelection(this.store.selection);
    this.store.select(selection);
    return this.#result(
      "select",
      false,
      this.#selectionChange(before),
    );
  }

  undo() {
    return this.#history("undo");
  }

  redo() {
    return this.#history("redo");
  }

  #history(kind) {
    const before = copySelection(this.store.selection);
    const changed = this.store[kind]();
    const selectionChanged = this.#selectionChange(before);
    if (changed) this.revision += 1;
    return this.#result(kind, changed, selectionChanged);
  }

  replace(project, selection) {
    const previousSessionId = this.sessionId;
    this.store = new Store(project, selection);
    this.sessionId = sessionId();
    this.revision = 0;
    return this.#result("replace", true, true, {
      sessionChanged: true,
      previousSessionId,
    });
  }
}
