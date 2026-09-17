import { test } from "node:test";
import assert from "node:assert/strict";
import { project, flatten, panel, scene, shot } from "../src/model.js";
import { summary, byShot, selectionTotal, gapTo } from "../src/derived/duration.js";

test("summary totals frames/seconds/panels/shots/scenes", () => {
  const p = project();
  p.fps = 24;
  p.scenes[0].shots[0].panels = [panel(), panel(), panel()];
  for (const b of p.scenes[0].shots[0].panels) b.frames = 24;
  p.scenes.push(scene("シーン02", [shot([panel()])]));
  p.scenes[1].shots[0].panels[0].frames = 12;
  const rows = flatten(p);

  const s = summary(p, rows);
  assert.equal(s.frames, 24 * 3 + 12);
  assert.equal(s.seconds, (24 * 3 + 12) / 24);
  assert.equal(s.panels, 4);
  assert.equal(s.shots, 2);
  assert.equal(s.scenes, 2);
});

test("byShot keeps project order and per-shot totals", () => {
  const p = project();
  p.fps = 24;
  p.scenes[0].shots[0].panels = [panel(), panel()];
  for (const b of p.scenes[0].shots[0].panels) b.frames = 10;
  p.scenes[0].shots.push(shot([panel()]));
  p.scenes[0].shots[1].panels[0].frames = 30;
  const rows = flatten(p);

  const breakdown = byShot(p, rows);
  assert.equal(breakdown.length, 2);
  assert.equal(breakdown[0].frames, 20);
  assert.equal(breakdown[0].panels, 2);
  assert.equal(breakdown[0].seconds, 20 / 24);
  assert.equal(breakdown[1].frames, 30);
  assert.equal(breakdown[1].sceneId, p.scenes[0].id);
  assert.equal(breakdown[1].shotId, p.scenes[0].shots[1].id);
});

test("selectionTotal sums only the chosen panels, ignoring order and gaps", () => {
  const p = project();
  p.scenes[0].shots[0].panels = [panel(), panel(), panel()];
  const [a, b, c] = p.scenes[0].shots[0].panels;
  a.frames = 5;
  b.frames = 7;
  c.frames = 9;
  const rows = flatten(p);

  assert.equal(selectionTotal(rows, [a.id, c.id]), 14);
  assert.equal(selectionTotal(rows, []), 0);
  assert.equal(selectionTotal(rows, ["missing"]), 0);
});

test("gapTo reports overage as positive and shortfall as negative", () => {
  // 目標10秒、fps24 → 240f。実尺250fなら10f（約0.42秒）超過。
  const over = gapTo(10, 250, 24);
  assert.equal(over.frames, 10);
  assert.equal(over.seconds, 10 / 24);

  const under = gapTo(10, 200, 24);
  assert.equal(under.frames, -40);
  assert.ok(under.seconds < 0);

  const exact = gapTo(10, 240, 24);
  assert.equal(exact.frames, 0);
  assert.equal(exact.seconds, 0);
});

test("summary and byShot stay fast for 2000 panels", () => {
  const p = project();
  p.scenes = Array.from({ length: 20 }, () =>
    scene(undefined, [shot(Array.from({ length: 100 }, () => panel()))]),
  );
  const rows = flatten(p);
  assert.equal(rows.length, 2000);

  const t = performance.now();
  summary(p, rows);
  byShot(p, rows);
  assert.ok(performance.now() - t < 100, "2000 Panelの集計が遅すぎる");
});
