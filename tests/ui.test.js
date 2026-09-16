import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubValue, scaleFor } from "../src/ui/number-scrub.js";

test("scrubbing moves one step every three pixels", () => {
  assert.equal(scrubValue(48, 0, { step: 1 }), 48);
  assert.equal(scrubValue(48, 30, { step: 1 }), 58);
  assert.equal(scrubValue(48, -30, { step: 1 }), 38);
  // 3px未満は同じ目盛りに丸まる。手が少し動いただけで値が変わらない。
  assert.equal(scrubValue(48, 1, { step: 1 }), 48);
});

test("scrubbing follows the input's own step and stays on its grid", () => {
  assert.equal(scrubValue(1, 30, { step: 0.1 }), 2);
  assert.equal(scrubValue(1, 3, { step: 0.1 }), 1.1);
  // 0.1刻みで誤差が積もらない。
  assert.equal(scrubValue(1, 9, { step: 0.1 }), 1.3);
  assert.equal(scrubValue(0, 15, { step: 5 }), 25);
});

test("modifiers make the step coarse or fine", () => {
  assert.equal(scaleFor({ shiftKey: true }), 10);
  assert.equal(scaleFor({ altKey: true }), 0.1);
  assert.equal(scaleFor({}), 1);
  assert.equal(scrubValue(48, 30, { step: 1, scale: 10 }), 148);
  assert.equal(scrubValue(1, 30, { step: 0.1, scale: 0.1 }), 1.1);
});

test("scrubbing stays inside the input's range", () => {
  assert.equal(scrubValue(2, -300, { step: 1, min: 1, max: 864000 }), 1);
  assert.equal(scrubValue(9.9, 300, { step: 0.1, min: 0.1, max: 10 }), 10);
  // 範囲の指定がなければ止めない。
  assert.equal(scrubValue(0, -30, { step: 1 }), -10);
});
