import { test } from "node:test";
import assert from "node:assert/strict";
import { scrollDelta } from "../src/ui/auto-scroll.js";

const rect = { left: 100, right: 500 };

test("no scroll while the pointer is away from both edges", () => {
  assert.equal(scrollDelta(300, rect, { edge: 40 }), 0);
  assert.equal(scrollDelta(141, rect, { edge: 40 }), 0);
  assert.equal(scrollDelta(459, rect, { edge: 40 }), 0);
});

test("scrolls left near the left edge, right near the right edge", () => {
  assert.ok(scrollDelta(110, rect, { edge: 40 }) < 0);
  assert.ok(scrollDelta(490, rect, { edge: 40 }) > 0);
});

test("speed increases the closer the pointer is to the edge", () => {
  const far = Math.abs(scrollDelta(130, rect, { edge: 40, speed: 12 }));
  const near = Math.abs(scrollDelta(102, rect, { edge: 40, speed: 12 }));
  assert.ok(near > far, "端に近いほうが遅い");
  // ちょうど端(0)では最大速度になる。
  assert.equal(scrollDelta(100, rect, { edge: 40, speed: 12 }), -12);
  assert.equal(scrollDelta(500, rect, { edge: 40, speed: 12 }), 12);
});

test("pointer outside the container keeps scrolling at the capped max speed", () => {
  // 端の外側（ドラッグでコンテナの外まで出た場合）も同じ向きへ動き続けるが、
  // 際限なく速くはならず最大速度で頭打ちにする。
  assert.equal(scrollDelta(50, rect, { edge: 40, speed: 12 }), -12);
  assert.equal(scrollDelta(-1000, rect, { edge: 40, speed: 12 }), -12);
  assert.equal(scrollDelta(600, rect, { edge: 40, speed: 12 }), 12);
  assert.equal(scrollDelta(10000, rect, { edge: 40, speed: 12 }), 12);
});
