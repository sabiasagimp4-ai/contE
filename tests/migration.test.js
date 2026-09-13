import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { load, migrate, validate, project, VERSION } from "../src/model.js";
const fixture = await readFile(
  fileURLToPath(new URL("./fixtures/v1.contp", import.meta.url)),
  "utf8",
);
test("v1 project loads, gains asset fields and keeps timing and drawing", () => {
  const p = load(fixture);
  assert.equal(p.version, VERSION);
  assert.deepEqual(p.assets, []);
  const panels = p.scenes[0].shots[0].panels;
  assert.equal(panels[0].image, null);
  assert.equal(panels[0].frames, 36);
  assert.equal(panels[0].dialogue, "おはよう");
  assert.deepEqual(panels[0].strokes, [
    [
      [0.1, 0.2],
      [0.4, 0.5],
    ],
  ]);
  assert.equal(panels[1].camera.at(-1).zoom, 1.5);
});
test("migration does not touch the source object", () => {
  const raw = JSON.parse(fixture);
  const copy = JSON.parse(fixture);
  migrate(raw);
  assert.deepEqual(raw, copy);
});
test("unknown versions and non-objects are refused with a readable message", () => {
  assert.throws(() => migrate({ version: 99 }), /Version/);
  assert.throws(() => migrate({}), /Version/);
  assert.throws(() => migrate([]), /読み取れません/);
  assert.throws(() => migrate(null), /読み取れません/);
});
test("v2 asset references must resolve inside the project", () => {
  const p = project();
  const b = p.scenes[0].shots[0].panels[0];
  b.image = { assetId: "missing", opacity: 1 };
  assert.throws(() => validate(p), /画像参照/);
  p.assets.push({
    id: "missing",
    kind: "image",
    name: "board.png",
    mime: "image/png",
    bytes: 1024,
  });
  assert.equal(validate(p), p);
  p.assets[0].bytes = -1;
  assert.throws(() => validate(p), /素材/);
});
