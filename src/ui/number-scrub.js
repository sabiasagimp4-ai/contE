// 数値入力を横ドラッグで変えられるようにする（AEのホットテキスト）。
// 履歴の粒度は現行のまま保つ。ドラッグ中は表示だけを動かし、離したときに
// 一度だけchangeを出すので、1回のドラッグが1段のUndoになる。
// 値の計算はDOMを知らない純粋関数として分け、試験できるようにする。
const decimalsOf = (step) => (String(step).split(".")[1] ?? "").length;

/**
 * ドラッグ量から次の値を求める。
 * @param {number} base つかんだ時点の値
 * @param {number} dx 横方向の移動量（px）
 * @param {object} range step / min / max / scale
 */
export function scrubValue(base, dx, { step = 1, min, max, scale = 1 } = {}) {
  // 3pxで1目盛り。動かした量のほうを目盛りに丸めるので、掴んだ値の端数は保たれる。
  const unit = (Math.abs(step) || 1) * scale;
  const moved = Math.round(dx / 3) * unit;
  const digits = Math.min(6, decimalsOf(step) + (scale < 1 ? 1 : 0));
  const value = Number((base + moved).toFixed(digits));
  return Math.min(
    max ?? Infinity,
    Math.max(min ?? -Infinity, Number.isFinite(value) ? value : base),
  );
}

// Shiftで粗く、Altで細かく。AEと同じ修飾キーの意味にそろえる。
export const scaleFor = (event) =>
  event.shiftKey ? 10 : event.altKey || event.ctrlKey || event.metaKey ? 0.1 : 1;

const numberOr = (text, fallback) => {
  const value = Number(text);
  return text === "" || !Number.isFinite(value) ? fallback : value;
};

/**
 * 1つの数値入力をドラッグ可能にする。クリックやキーボード入力は今までどおり。
 * 3px動かすまではスクラブを始めないので、押して離すだけならフォーカスが入る。
 */
export function scrubNumber(input, { onPreview, onCancel } = {}) {
  if (!input || input.dataset.scrub === "on") return input;
  input.dataset.scrub = "on";
  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || input.disabled || input.readOnly) return;
    const step = Number(input.step) || 1;
    const min = numberOr(input.min, undefined);
    const max = numberOr(input.max, undefined);
    const startX = event.clientX;
    const base = Number(input.value) || 0;
    let scrubbing = false;
    const move = (v) => {
      const dx = v.clientX - startX;
      if (!scrubbing) {
        if (Math.abs(dx) < 3) return;
        scrubbing = true;
        input.setPointerCapture?.(v.pointerId);
        input.classList.add("scrubbing");
      }
      input.value = scrubValue(base, dx, { step, min, max, scale: scaleFor(v) });
      // 確定前の値を見ながら調整できるよう、動かすたびに呼び出し元へ知らせる。
      // Projectはまだ変えない。履歴も保存もここでは動かさない。
      onPreview?.(Number(input.value));
    };
    const finish = (commit) => {
      input.removeEventListener("pointermove", move);
      input.removeEventListener("pointerup", up);
      input.removeEventListener("pointercancel", cancel);
      input.classList.remove("scrubbing");
      if (!scrubbing) return;
      // 中止したときは掴んだ時点の値へ戻し、確定も通知もしない。
      if (!commit) {
        input.value = base;
        onCancel?.();
        return;
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    input.addEventListener("pointermove", move);
    input.addEventListener("pointerup", up);
    input.addEventListener("pointercancel", cancel);
  });
  // フォーカスがある間だけホイールで刻む。ページのスクロールはフォーカスが
  // 無ければ奪わない。1目盛りごとに確定するので、ドラッグのような予告表示は無い。
  input.addEventListener("wheel", (event) => {
    if (document.activeElement !== input || input.disabled || input.readOnly)
      return;
    event.preventDefault();
    const step = Number(input.step) || 1;
    const min = numberOr(input.min, undefined);
    const max = numberOr(input.max, undefined);
    const base = Number(input.value) || 0;
    const dir = event.deltaY < 0 ? 1 : -1;
    input.value = scrubValue(base, dir * 3, {
      step,
      min,
      max,
      scale: scaleFor(event),
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return input;
}

// まとめて適用する。動的に作られる入力（紙面設定など）にも後から呼べる。
export function scrubAll(root = document) {
  for (const input of root.querySelectorAll('input[type="number"]'))
    scrubNumber(input);
}
