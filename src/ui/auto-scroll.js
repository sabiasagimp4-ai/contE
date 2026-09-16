// ドラッグ中に画面端へポインタを寄せると、そのコンテナを自動でスクロールする。
// StripやTimelineのドラッグ並べ替えなど、見えている範囲の外へも運べるようにする。
// 速度計算はDOMを知らない純粋関数として分け、rectを渡せば試験できる。

/**
 * ポインタ位置からスクロール量（1フレームあたりのpx、符号付き）を求める。
 * 端から edge px以内にいる間だけ動き、端に近いほど速い。範囲外では0。
 */
export function scrollDelta(clientX, rect, { edge = 40, speed = 12 } = {}) {
  const leftGap = clientX - rect.left;
  const rightGap = rect.right - clientX;
  if (leftGap < edge) return -speed * (1 - Math.max(0, leftGap) / edge);
  if (rightGap < edge) return speed * (1 - Math.max(0, rightGap) / edge);
  return 0;
}

/**
 * containerの自動スクロールを開始する。返す関数を呼ぶと停止する。
 * ドラッグのpointermoveごとに stop.track(clientX) を呼び、離すときに stop() する。
 */
export function autoScroll(container, options = {}) {
  let delta = 0,
    raf = null;
  const tick = () => {
    if (delta) container.scrollLeft += delta;
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    delta = 0;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  };
  stop.track = (clientX) => {
    delta = scrollDelta(clientX, container.getBoundingClientRect(), options);
    if (delta && raf === null) raf = requestAnimationFrame(tick);
  };
  return stop;
}
