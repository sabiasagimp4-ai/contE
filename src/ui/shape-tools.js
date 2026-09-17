// 図形ツール：pointsの列を作る純粋関数。ブラシ/消しゴムと同じStroke形式の
// まま直線・矩形・矢印を表現する（B7）。DOMは触らず、座標はPanelの正規化
// 座標（0..1）で受け渡す。
const pt = (x, y, pressure = 1) => [x, y, pressure];

// Shiftを押している間、直線・矢印は水平・垂直・45度刻みへ吸着する。
function snapAngle(x0, y0, x1, y1) {
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (!length) return [x0, y0];
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(y1 - y0, x1 - x0) / step) * step;
  return [x0 + Math.cos(angle) * length, y0 + Math.sin(angle) * length];
}

export function linePoints(x0, y0, x1, y1, snap = false) {
  const [ex, ey] = snap ? snapAngle(x0, y0, x1, y1) : [x1, y1];
  return [pt(x0, y0), pt(ex, ey)];
}

// Shiftを押している間、矩形は正方形になる（辺の長い方に揃える）。
export function rectPoints(x0, y0, x1, y1, snap = false) {
  let ex = x1,
    ey = y1;
  if (snap) {
    const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    ex = x0 + Math.sign(x1 - x0 || 1) * side;
    ey = y0 + Math.sign(y1 - y0 || 1) * side;
  }
  return [pt(x0, y0), pt(ex, y0), pt(ex, ey), pt(x0, ey), pt(x0, y0)];
}

// 矢印：本体1本＋かえし2本。かえしの長さ・開き角は固定値。
const HEAD_LENGTH = 0.035,
  HEAD_ANGLE = Math.PI / 7;
export function arrowPointSets(x0, y0, x1, y1, snap = false) {
  const [ex, ey] = snap ? snapAngle(x0, y0, x1, y1) : [x1, y1];
  const angle = Math.atan2(ey - y0, ex - x0);
  const barb = (sign) => [
    pt(ex, ey),
    pt(
      ex - HEAD_LENGTH * Math.cos(angle + sign * HEAD_ANGLE),
      ey - HEAD_LENGTH * Math.sin(angle + sign * HEAD_ANGLE),
    ),
  ];
  return [[pt(x0, y0), pt(ex, ey)], barb(1), barb(-1)];
}
