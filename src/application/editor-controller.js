// 確定編集のあとの共通処理を一か所へ集める。
// 一回の確定編集につき、通知は一回だけ出す。購読側はその通知だけを見て
// dirty・保存予約・再描画を決める（計画 §18.3-4）。
// DOMもStorageもここには入れない。副作用の実体はappが購読として渡す。
import { changesOf, NO_CHANGES } from "../editor-session.js";
import { changeSetOf, commandOf } from "./commands.js";

export class EditorController {
  #session;
  #listeners = new Set();
  #beforeCommand;

  constructor(session, { beforeCommand } = {}) {
    if (!session || typeof session.edit !== "function")
      throw Error("EditorControllerにはEditorSessionが必要です");
    this.#session = session;
    // 現行の「操作の開始で再生を止める」挙動をそのまま保つための接続点。
    this.#beforeCommand = beforeCommand ?? (() => {});
  }

  get session() {
    return this.#session;
  }
  get store() {
    return this.#session.store;
  }
  get project() {
    return this.#session.store.p;
  }
  get selection() {
    return this.#session.store.selection;
  }
  get activeId() {
    return this.#session.store.selection.active;
  }
  get selectedIds() {
    return [...this.#session.store.selection.ids];
  }

  // 購読は解除関数を返す。Viewの寿命に合わせて必ず外せるようにする。
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(result) {
    for (const listener of [...this.#listeners]) listener(result);
    return result;
  }

  #failure(kind, error) {
    // 失敗は成功結果と区別して返す。履歴も保存予約も増やさない。
    return Object.freeze({
      kind,
      changed: false,
      selectionChanged: false,
      failed: true,
      error,
      sessionId: this.#session.sessionId,
      revision: this.#session.revision,
      changes: NO_CHANGES,
    });
  }

  #commit(kind, fn, changes) {
    this.#beforeCommand();
    let result;
    try {
      result = this.#session.edit(fn, kind, changes);
    } catch (error) {
      return this.#emit(this.#failure(kind, error));
    }
    return this.#emit(result);
  }

  // UIもテストもこの経路でコマンドを実行する。
  execute(name, args = {}) {
    const spec = commandOf(name);
    return this.#commit(name, spec.run(args), changesOf(changeSetOf(name, args)));
  }

  // 移行用の窓口。変更範囲を判定できないcallbackは全更新として扱う。
  edit(fn, kind = "edit") {
    return this.#commit(kind, fn);
  }

  select(selection) {
    this.#beforeCommand();
    return this.#emit(this.#session.select(selection));
  }

  undo() {
    this.#beforeCommand();
    return this.#emit(this.#session.undo());
  }

  redo() {
    this.#beforeCommand();
    return this.#emit(this.#session.redo());
  }

  replace(project, selection) {
    this.#beforeCommand();
    return this.#emit(this.#session.replace(project, selection));
  }

  capture() {
    return this.#session.capture();
  }
  isCurrent(token) {
    return this.#session.isCurrent(token);
  }
  isCurrentRevision(token) {
    return this.#session.isCurrentRevision(token);
  }
}
