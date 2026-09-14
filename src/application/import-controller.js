// 素材取り込みの非同期規約を一か所へ集める（計画 §18.3-5）。
// - 対象（PanelやClip）とSessionは開始時に固定する。途中で選択が変わっても、
//   取り込みは最初に狙った対象へ適用する。
// - 作品を開き直した、対象が消えた、同じ対象へ次の要求が来た場合は適用しない。
//   その場合もデコード結果は解放する。
// - 無関係な編集で取り込み全体を捨てない。
// デコードや保存の実体はここに持たない。呼び出し側がload/apply/releaseで渡す。
export class ImportController {
  #editor;
  #latest = new Map();
  #sequence = 0;

  constructor(editor) {
    if (!editor || typeof editor.capture !== "function")
      throw Error("ImportControllerにはEditorControllerが必要です");
    this.#editor = editor;
  }

  get pending() {
    return this.#latest.size;
  }

  /**
   * @param {object} request
   * @param {string} [request.key] 同じ対象への要求をまとめる鍵。省略すると
   *   追い越し判定を行わない（音声の新規配置のように毎回別の対象を作る場合）。
   * @param {() => Promise<any>} request.load デコードや原本保存。
   * @param {(resource:any) => any} request.apply 確定編集。Commandを呼ぶ。
   * @param {(resource:any) => void} [request.release] 使わない結果の後始末。
   * @param {() => boolean} [request.targetExists] 対象がまだあるか。
   */
  async run({ key = null, load, apply, release = () => {}, targetExists }) {
    const token = this.#editor.capture();
    const id = ++this.#sequence;
    if (key) this.#latest.set(key, id);
    const current = () => !key || this.#latest.get(key) === id;
    const done = () => {
      if (key && this.#latest.get(key) === id) this.#latest.delete(key);
    };
    let resource;
    try {
      resource = await load();
    } catch (error) {
      done();
      throw error;
    }
    // 完了してから、開始時の対象へまだ適用してよいかを確かめる。
    const stale = !this.#editor.isCurrent(token)
      ? "session"
      : !current()
        ? "superseded"
        : targetExists && !targetExists()
          ? "missing"
          : null;
    if (stale) {
      done();
      release(resource);
      return { applied: false, reason: stale, resource };
    }
    done();
    const result = apply(resource);
    if (result && result.changed === false) {
      release(resource);
      return { applied: false, reason: "rejected", result, resource };
    }
    return { applied: true, result, resource };
  }
}
