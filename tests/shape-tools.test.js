import { test } from "node:test";
import assert from "node:assert/strict";
import { linePoints, rectPoints, arrowPointSets } from "../src/ui/shape-tools.js";

test("linePoints is just the two endpoints without snapping", () => {
  assert.deepEqual(linePoints(0.1, 0.1, 0.4, 0.3), [
    [0.1, 0.1, 1],
    [0.4, 0.3, 1],
  ]);
});

test("linePoints with snap locks the angle to 45-degree steps", () => {
  // ほぼ水平（わずかに下がっている）→ 0度へ吸着し、yはx0の高さに揃う。
  const [, [ex, ey]] = linePoints(0, 0, 1, 0.05, true);
  assert.ok(Math.abs(ey) < 1e-9, `expected horizontal, got y=${ey}`);
  assert.ok(ex > 0.9, "length should be preserved");

  // 45度ちょうどの入力はそのまま45度に残る。
  const [, [ex2, ey2]] = linePoints(0, 0, 1, 1, true);
  assert.ok(Math.abs(ex2 - ey2) < 1e-9, "45 degrees should keep x===y");

  // ほぼ垂直 → 90度へ吸着し、xはx0のまま。
  const [, [ex3]] = linePoints(0, 0, 0.05, 1, true);
  assert.ok(Math.abs(ex3) < 1e-9, `expected vertical, got x=${ex3}`);
});

test("rectPoints closes the shape back to the start", () => {
  const points = rectPoints(0.1, 0.1, 0.4, 0.3);
  assert.equal(points.length, 5);
  assert.deepEqual(points[0], points[4], "matrix must close back to the start");
  assert.deepEqual(points, [
    [0.1, 0.1, 1],
    [0.4, 0.1, 1],
    [0.4, 0.3, 1],
    [0.1, 0.3, 1],
    [0.1, 0.1, 1],
  ]);
});

test("rectPoints with snap forces equal sides in the dragged direction", () => {
  const points = rectPoints(0, 0, 0.6, 0.2, true);
  const width = points[1][0] - points[0][0];
  const height = points[2][1] - points[1][1];
  assert.equal(Math.abs(width), Math.abs(height), "snap should make a square");
  assert.equal(Math.abs(width), 0.6, "the longer dragged side wins");

  // 逆方向へドラッグしても向きは保たれる。
  const back = rectPoints(0.5, 0.5, 0.1, 0.5, true);
  assert.ok(back[1][0] < back[0][0], "square should still grow toward the drag");
});

test("arrowPointSets returns a shaft and two symmetric barbs", () => {
  const [shaft, barb1, barb2] = arrowPointSets(0, 0.5, 1, 0.5);
  assert.deepEqual(shaft, [
    [0, 0.5, 1],
    [1, 0.5, 1],
  ]);
  // 両かえしはtip(1,0.5)から始まり、tipを軸に上下対称。
  assert.deepEqual(barb1[0], [1, 0.5, 1]);
  assert.deepEqual(barb2[0], [1, 0.5, 1]);
  assert.ok(
    Math.abs(barb1[1][1] - 0.5 + (barb2[1][1] - 0.5)) < 1e-9,
    "barbs should be mirrored across the shaft",
  );
  assert.notEqual(barb1[1][1], barb2[1][1], "barbs should point to different sides");
});

test("arrowPointSets snaps the shaft angle just like a line", () => {
  const [shaft] = arrowPointSets(0, 0, 1, 0.05, true);
  assert.ok(Math.abs(shaft[1][1]) < 1e-9, "shaft should snap horizontal");
});
