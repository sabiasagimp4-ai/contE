import { EditorSession } from "./editor-session.js";

const METHODS = ["edit", "select", "undo", "redo", "replace", "capture"];

export class EditorController {
  constructor(session = new EditorSession(), { onResult = () => {} } = {}) {
    if (!session || METHODS.some((method) => typeof session[method] !== "function"))
      throw Error("EditorControllerにはEditorSessionが必要です");
    this.session = session;
    this.onResult = onResult;
  }

  get store() {
    return this.session.store;
  }

  get sessionId() {
    return this.session.sessionId;
  }

  capture() {
    return this.session.capture();
  }

  isCurrent(token) {
    return this.session.isCurrent(token);
  }

  isCurrentRevision(token) {
    return this.session.isCurrentRevision(token);
  }

  #notify(result) {
    this.onResult(result, this.store);
    return result;
  }

  edit(fn, kind = "edit") {
    return this.#notify(this.session.edit(fn, kind));
  }

  select(selection) {
    return this.#notify(this.session.select(selection));
  }

  undo() {
    return this.#notify(this.session.undo());
  }

  redo() {
    return this.#notify(this.session.redo());
  }

  replace(project, selection) {
    return this.#notify(this.session.replace(project, selection));
  }
}
