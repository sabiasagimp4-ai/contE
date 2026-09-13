import { test } from "node:test";
import assert from "node:assert/strict";
import { frameAtTime, rowAtFrame } from "../src/playback.js";
test("clock does not drift and stops at project end", () => {
  assert.equal(frameAtTime(24, 1000, 2000, 24, 100), 48);
  assert.equal(frameAtTime(24, 1000, 200000, 24, 100), 100);
});
test("exact boundary belongs to following panel", () => {
  const rows = [{ end: 48 }, { end: 96 }, { end: 144 }];
  assert.equal(rowAtFrame(rows, 48), rows[1]);
  assert.equal(rowAtFrame(rows, 144), rows[2]);
});
