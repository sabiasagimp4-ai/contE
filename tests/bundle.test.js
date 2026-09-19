import { test } from "node:test";
import assert from "node:assert/strict";
import { project } from "../src/model.js";
import { createBundle, readBundle } from "../src/bundle.js";

test("bundle round-trips project metadata and every asset binary", async () => {
  const p = project();
  p.assets.push({
    id: "image-1",
    kind: "image",
    name: "board.png",
    mime: "image/png",
    bytes: 4,
    width: 2,
    height: 2,
  });
  const input = new Uint8Array([1, 2, 3, 4]);
  const bundle = await createBundle(p, [{ id: "image-1", bytes: input }]);
  const loaded = await readBundle(bundle);
  assert.equal(loaded.project.title, p.title);
  assert.deepEqual(
    [...loaded.assets[0].bytes],
    [...input],
  );
  assert.equal(loaded.assets[0].sha256.length, 64);
});

test("bundle refuses missing or unrelated asset binaries", async () => {
  const p = project();
  p.assets.push({
    id: "image-1",
    kind: "image",
    name: "board.png",
    mime: "image/png",
    bytes: 1,
    width: 1,
    height: 1,
  });
  await assert.rejects(
    () => createBundle(p, []),
    /Assetバイナリがありません/,
  );
  await assert.rejects(
    () => createBundle(p, [{ id: "other", bytes: new Uint8Array([1]) }]),
    /存在しないAsset/,
  );
});
