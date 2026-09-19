// Timeline Engine：フレームと画面座標の変換、目盛、スナップ、範囲、追従を担当する。
// DOMもプロジェクトの書き換えも行わない。UIはここで決まった値を描画するだけ。
// px/frame の段階。最小は500 Panel規模を1画面へ収めるため、最大は1フレーム単位の調整用。
export const SCALES = [
  0.04, 0.08, 0.15, 0.25, 0.4, 0.6, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24,
];
export const DEFAULT_SCALE = SCALES.indexOf(3);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const scaleAt = (index) =>
  SCALES[clamp(Math.round(index), 0, SCALES.length - 1)];
export const total = (rows) => (rows.length ? rows.at(-1).end : 0);
export const xOf = (frame, scale) => frame * scale;
export const frameAt = (x, scale, end) => clamp(Math.round(x / scale), 0, end);
// 画面に入っているPanelだけを返す。500 Panelでも生成するDOMは一定に保つ。
function firstEndAtLeast(rows, frame) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].end < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstStartAfter(rows, frame) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].start <= frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function visible(rows, scale, scrollLeft, width, pad = 120) {
  const from = (scrollLeft - pad) / scale,
    to = (scrollLeft + width + pad) / scale;
  if (!rows.length) return [];
  const start = firstEndAtLeast(rows, from);
  const end = firstStartAfter(rows, to);
  return rows.slice(start, end);
}
// 目盛の間隔はfps基準の候補から選ぶ。ラベルが重なる間隔は使わない。
export function tickStep(fps, scale, minPx = 70) {
  const steps = [
    1,
    2,
    5,
    10,
    Math.round(fps / 4),
    Math.round(fps / 2),
    fps,
    fps * 2,
    fps * 5,
    fps * 10,
    fps * 30,
    fps * 60,
    fps * 300,
  ].filter((s) => s >= 1);
  const sorted = [...new Set(steps)].sort((a, b) => a - b);
  return sorted.find((s) => s * scale >= minPx) ?? sorted.at(-1);
}
export function tickLabel(frame, fps) {
  const seconds = Math.floor(frame / fps),
    rest = frame % fps;
  return rest ? `${seconds}s${rest}f` : `${seconds}s`;
}
export function ticks(fps, scale, scrollLeft, width, end, minPx = 70) {
  const step = tickStep(fps, scale, minPx);
  const from = Math.max(
    0,
    Math.floor((scrollLeft - width) / scale / step) * step,
  );
  const to = Math.min(end, (scrollLeft + width * 2) / scale);
  const out = [];
  for (let f = from; f <= to; f += step)
    out.push({ frame: f, label: tickLabel(f, fps), second: f % fps === 0 });
  return out;
}
// スナップ候補：Panelの境界、秒の目盛、再生ヘッド、プロジェクトの末尾。
// 長尺プロジェクトでも候補配列を膨らませない。秒の目盛は十分な密度を
// 保ちつつ上限を設け、細かいPanel境界は常にすべて残す。
export function snapTargets(
  rows,
  fps,
  end,
  playhead,
  { maxSecondTicks = 4096 } = {},
) {
  const targets = new Set([0, end]);
  for (const r of rows) targets.add(r.start).add(r.end);
  const seconds = Math.floor(end / fps) + 1;
  const stride = Math.max(1, Math.ceil(seconds / maxSecondTicks));
  for (let f = 0; f <= end; f += fps * stride) targets.add(f);
  if (Number.isFinite(playhead)) targets.add(Math.round(playhead));
  return [...targets];
}
export function snap(frame, targets, scale, tolerancePx = 8) {
  let best = frame,
    distance = tolerancePx / scale;
  for (const t of targets) {
    const d = Math.abs(t - frame);
    if (d < distance) {
      distance = d;
      best = t;
    }
  }
  return Math.round(best);
}
// Zoomは指定したフレームが画面上の同じ位置に留まるようスクロールを合わせる。
export function anchorScroll(
  scrollLeft,
  oldScale,
  newScale,
  anchorFrame,
  width,
) {
  const offset = anchorFrame * oldScale - scrollLeft;
  return Math.max(0, anchorFrame * newScale - clamp(offset, 0, width));
}
// 再生ヘッドが画面の端に来たときだけスクロールする。中央へ寄せ続けない。
export function follow(frame, scale, scrollLeft, width, margin = 80) {
  const x = frame * scale;
  if (x < scrollLeft + margin) return Math.max(0, x - margin);
  if (x > scrollLeft + width - margin) return Math.max(0, x - width + margin);
  return scrollLeft;
}
export function selectionRange(rows, ids) {
  const selected = new Set(ids);
  const chosen = rows.filter((r) => selected.has(r.panel.id));
  if (!chosen.length) return null;
  const start = Math.min(...chosen.map((r) => r.start)),
    end = Math.max(...chosen.map((r) => r.end));
  return { start, end, frames: end - start, panels: chosen.length };
}
// 全体を1画面へ収めるための倍率。ぴったりではなく段階の中から選ぶ。
export function fitScaleIndex(end, width) {
  if (!end) return DEFAULT_SCALE;
  for (let i = SCALES.length - 1; i >= 0; i--)
    if (end * SCALES[i] <= width) return i;
  return 0;
}
export const clipRect = (row, scale) => ({
  left: row.start * scale,
  width: Math.max(2, row.panel.frames * scale),
});
