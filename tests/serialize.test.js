import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeProject } from "../src/serialize.js";
import { project, scene, shot, panel, flatten, load, migrate } from "../src/model.js";
import { addClip } from "../src/audio.js";

// 大きさの異なるProjectを作る。画像・音声つきで、実際の保存内容に近づける。
function bigProject(panelCount, scenesCount = Math.max(1, panelCount / 100)) {
  const p = project();
  const perScene = Math.ceil(panelCount / scenesCount);
  let remaining = panelCount;
  p.scenes = [];
  while (remaining > 0) {
    const count = Math.min(perScene, remaining);
    p.scenes.push(scene(undefined, [shot(Array.from({ length: count }, panel))]));
    remaining -= count;
  }
  const rows = flatten(p);
  p.assets.push({
    id: "image-1",
    kind: "image",
    name: "bg.png",
    mime: "image/png",
    bytes: 1234,
  });
  rows[0].panel.image = { assetId: "image-1", opacity: 0.8 };
  p.assets.push({
    id: "sound-1",
    kind: "audio",
    name: "a.wav",
    mime: "audio/wav",
    bytes: 4321,
  });
  addClip(p, { assetId: "sound-1", track: "se", anchor: rows[0].panel.id, at: 0, frames: 10 });
  rows[0].panel.dialogue = "台詞にも日本語や\"引用符\"、改行\nを混ぜる。";
  rows[0].panel.strokes = [
    { size: 1 / 500, erase: false, points: [[0.1, 0.1, 1], [0.9, 0.4, 0.4]] },
  ];
  return p;
}

for (const count of [100, 500, 2000]) {
  test(`serializeProject matches JSON.stringify exactly for ${count} panels`, async () => {
    const p = bigProject(count);
    const expected = JSON.stringify(p);
    const actual = await serializeProject(p);
    assert.equal(actual, expected);
  });
}

test("serializeProject's output round-trips through load()", async () => {
  const p = bigProject(120);
  const text = await serializeProject(p);
  assert.deepEqual(load(text), p);
});

test("serializeProject yields between scenes without changing the result (custom yieldEvery)", async () => {
  const p = bigProject(300, 6);
  const expected = JSON.stringify(p);
  const actual = await serializeProject(p, { yieldEvery: 2 });
  assert.equal(actual, expected);
});

test("serializeProject can be interrupted through an AbortSignal", async () => {
  const p = bigProject(300, 6);
  const controller = new AbortController();
  let processed = 0;
  // scenesを直接数えられないので、途中で打ち切ったことをAbortErrorそのもので確認する。
  const attempt = serializeProject(p, {
    yieldEvery: 1,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(attempt, (e) => {
    assert.equal(e.name, "AbortError");
    return true;
  });
});

test("serializeProject rejects immediately when the signal is already aborted", async () => {
  const p = bigProject(10, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    serializeProject(p, { signal: controller.signal }),
    (e) => e.name === "AbortError",
  );
});

test("serializeProject matches JSON.stringify even when scenes is not the last key (migrated project)", async () => {
  // v1からの移行では audio と paper が scenes より後ろに付く（migrations参照）。
  // "scenes"を最後の鍵と決めつけたコードだとここで壊れる。
  const raw = {
    version: 1,
    title: "旧いプロジェクト",
    fps: 24,
    scenes: [scene(undefined, [shot(Array.from({ length: 30 }, panel))])],
  };
  const p = migrate(raw);
  assert.ok(Object.keys(p).indexOf("scenes") < Object.keys(p).length - 1);
  assert.equal(await serializeProject(p), JSON.stringify(p));
});

test("serializeProject handles an empty scenes array like JSON.stringify does", async () => {
  const p = project();
  p.scenes = [];
  assert.equal(await serializeProject(p), JSON.stringify(p));
});
