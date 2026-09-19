import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCALES,
  scaleAt,
  frameAt,
  visible,
  tickStep,
  tickLabel,
  ticks,
  snap,
  snapTargets,
  anchorScroll,
  follow,
  selectionRange,
  fitScaleIndex,
  total,
} from "../src/timeline.js";
import { project, panel, flatten } from "../src/model.js";
const rowsOf = (count, frames = 48) => {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: count }, () => ({
    ...panel(),
    frames,
  }));
  return flatten(p);
};
test("frames and pixels convert both ways and stay inside the project", () => {
  assert.equal(frameAt(300, 3, 1000), 100);
  assert.equal(frameAt(-50, 3, 1000), 0);
  assert.equal(frameAt(9999, 3, 1000), 1000);
  assert.equal(frameAt(10.4, 1, 1000), 10);
  assert.equal(scaleAt(-5), SCALES[0]);
  assert.equal(scaleAt(999), SCALES.at(-1));
});
test("only panels near the viewport are laid out", () => {
  const rows = rowsOf(500);
  assert.equal(total(rows), 24000);
  const shown = visible(rows, 3, 3000, 900);
  assert.ok(shown.length < 12, `laid out ${shown.length} clips`);
  assert.ok(shown[0].end >= (3000 - 120) / 3);
  assert.ok(shown.at(-1).start <= (3000 + 900 + 120) / 3);
  // 画面の外は作らないが、境界にかかるPanelは落とさない。
  const wide = visible(rows, 0.1, 0, 1000);
  assert.equal(
    wide.length,
    rows.filter((r) => r.start <= 11200 && r.end >= -1200).length,
  );
});
test("tick spacing follows fps and never crowds labels", () => {
  assert.equal(tickStep(24, 3), 24);
  assert.equal(tickStep(24, 0.1), 24 * 30);
  assert.equal(tickStep(24, 12), 6);
  assert.equal(tickStep(30, 24), 5);
  assert.equal(tickLabel(48, 24), "2s");
  assert.equal(tickLabel(53, 24), "2s5f");
  const list = ticks(24, 3, 0, 900, 24000);
  assert.ok(list.every((t, i) => !i || t.frame > list[i - 1].frame));
  assert.ok(list.every((t) => t.frame % 24 === 0 && t.second));
  assert.ok(list.at(-1).frame <= 24000);
});
test("snapping prefers the nearest boundary within the pixel tolerance", () => {
  const rows = rowsOf(3);
  const targets = snapTargets(rows, 24, 144, 100);
  assert.equal(snap(50, targets, 3), 48);
  assert.equal(snap(101, targets, 3), 100);
  // 遠いときは動かさない。勝手に吸い寄せない。
  assert.equal(snap(60, targets, 3), 60);
  // 拡大するほど吸着範囲はフレーム単位では狭くなる。
  assert.equal(snap(50, targets, 24), 50);
});
test("snap candidates stay bounded for an extremely long project", () => {
  const rows = [
    { start: 0, end: 864000 },
    { start: 864000, end: 864000000 },
  ];
  const started = performance.now();
  const targets = snapTargets(rows, 24, 864000000, 123456);
  const elapsed = performance.now() - started;
  assert.ok(targets.length <= 20005, `generated ${targets.length} targets`);
  assert.ok(elapsed < 100, `candidate generation took ${elapsed.toFixed(1)}ms`);
  assert.ok(targets.includes(123456));
  assert.ok(targets.includes(864000));
});
test("zoom keeps the anchored frame under the same pixel", () => {
  // 画面左から300pxの位置にある100フレーム目を掴んだまま2倍にする。
  assert.equal(anchorScroll(0, 3, 6, 100, 900), 300);
  assert.equal(anchorScroll(300, 3, 6, 200, 900), 900);
  assert.ok(anchorScroll(0, 3, 1.5, 10, 900) >= 0);
});
test("the playhead scrolls only when it reaches the edge", () => {
  assert.equal(follow(100, 3, 0, 900), 0);
  assert.equal(follow(400, 3, 0, 900), 400 * 3 - 900 + 80);
  assert.equal(follow(10, 3, 500, 900), 0);
  assert.equal(follow(200, 3, 520, 900), 520);
});
test("selection range spans the chosen panels only", () => {
  const rows = rowsOf(4);
  const ids = [rows[1].panel.id, rows[2].panel.id];
  assert.deepEqual(selectionRange(rows, ids), {
    start: 48,
    end: 144,
    frames: 96,
    panels: 2,
  });
  assert.equal(selectionRange(rows, []), null);
});
test("fit chooses the largest scale that still shows everything", () => {
  for (const [end, width] of [
    [24000, 1000],
    [2000, 1000],
    [480, 900],
  ]) {
    const index = fitScaleIndex(end, width);
    assert.ok(end * SCALES[index] <= width, `${end} frames in ${width}px`);
    assert.ok(index === SCALES.length - 1 || end * SCALES[index + 1] > width);
  }
  // どの段階でも収まらないときは最小倍率に留める。
  assert.equal(fitScaleIndex(10e6, 300), 0);
  assert.equal(fitScaleIndex(0, 1000) >= 0, true);
});


test("visible rows keep exact edge semantics on a large sorted timeline", () => {
  const rows = Array.from({ length: 100000 }, (_, i) => ({
    id: i,
    start: i * 10,
    end: (i + 1) * 10,
  }));
  const visibleRows = visible(rows, 1, 500000, 100);
  const expected = rows.filter(
    (row) => row.end >= 499880 && row.start <= 500220,
  );
  assert.deepEqual(visibleRows, expected);
  assert.deepEqual(visible([], 3, 0, 900), []);
});
