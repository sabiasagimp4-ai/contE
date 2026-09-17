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

// 確定した変更の範囲。判定できない編集は必ずallにする。通知漏れで古い表示を
// 残すより、全更新のほうが安全側に倒れる（計画 §18.3-3）。
export const ALL_CHANGES = Object.freeze({
  all: true,
  kinds: Object.freeze([]),
  panelIds: Object.freeze([]),
  assetIds: Object.freeze([]),
});
export const NO_CHANGES = Object.freeze({
  all: false,
  kinds: Object.freeze([]),
  panelIds: Object.freeze([]),
  assetIds: Object.freeze([]),
});
export const changesOf = ({ kinds = [], panelIds = [], assetIds = [] } = {}) =>
  Object.freeze({
    all: false,
    kinds: Object.freeze([...kinds]),
    panelIds: Object.freeze([...panelIds]),
    assetIds: Object.freeze([...assetIds]),
  });

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

  edit(fn, kind = "edit", changes = ALL_CHANGES) {
    const before = copySelection(this.store.selection);
    const changed = this.store.edit(fn, kind);
    const selectionChanged = this.#selectionChange(before);
    if (changed) this.revision += 1;
    return this.#result(kind, changed, selectionChanged, {
      // 何も変わらなかった編集は無効化する対象を持たない。
      changes: changed ? changes : NO_CHANGES,
    });
  }

  select(selection) {
    const before = copySelection(this.store.selection);
    this.store.select(selection);
    return this.#result("select", false, this.#selectionChange(before), {
      changes: NO_CHANGES,
    });
  }

  undo() {
    return this.#history("undo");
  }

  redo() {
    return this.#history("redo");
  }

  #history(step) {
    const before = copySelection(this.store.selection);
    const outcome = this.store[step]();
    const changed = !!outcome;
    const selectionChanged = this.#selectionChange(before);
    if (changed) this.revision += 1;
    // Undo/Redoの逆方向の変更範囲はまだ判定しない。全更新で正しさを優先する。
    return this.#result(step, changed, selectionChanged, {
      changes: changed ? ALL_CHANGES : NO_CHANGES,
      // 戻した/やり直した編集の種類。状態表示が「元に戻す：尺の変更」のように出す。
      undoneKind: outcome ? outcome.kind : null,
    });
  }

  replace(project, selection) {
    const previousSessionId = this.sessionId;
    this.store = new Store(project, selection);
    this.sessionId = sessionId();
    this.revision = 0;
    return this.#result("replace", true, true, {
      changes: ALL_CHANGES,
      sessionChanged: true,
      previousSessionId,
    });
  }
}
