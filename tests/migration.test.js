import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { load, migrate, validate, project, VERSION } from "../src/model.js";
const read = (name) =>
  readFile(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
const fixture = await read("v1.contp");
const fixtureV2 = await read("v2.contp");
test("v1 project loads, gains asset fields and keeps timing and drawing", () => {
  const p = load(fixture);
  assert.equal(p.version, VERSION);
  assert.deepEqual(p.assets, []);
  const panels = p.scenes[0].shots[0].panels;
  assert.equal(panels[0].image, null);
  assert.equal(panels[0].frames, 36);
  assert.equal(panels[0].dialogue, "おはよう");
  assert.deepEqual(panels[0].strokes, [
    {
      size: 1 / 500,
      erase: false,
      points: [
        [0.1, 0.2, 1],
        [0.4, 0.5, 1],
      ],
    },
  ]);
  assert.equal(p.scenes[0].shots[0].name, "");
  assert.equal(panels[1].camera.at(-1).zoom, 1.5);
});
test("v2 project keeps its asset reference and gains stroke attributes", () => {
  const p = load(fixtureV2);
  assert.equal(p.version, VERSION);
  assert.deepEqual(p.assets[0].id, "asset-v2");
  const b = p.scenes[0].shots[0].panels[0];
  assert.deepEqual(b.image, {
    assetId: "asset-v2",
    opacity: 0.5,
    fit: "contain",
    offset: { x: 0, y: 0 },
    scale: 1,
  });
  assert.equal(b.strokes[0].erase, false);
  assert.deepEqual(b.strokes[0].points, [
    [0.2, 0.3, 1],
    [0.6, 0.7, 1],
  ]);
});
// v6移行：markers/label/ease/画像fit・offset・scale/workArea/paper.verticalを
// 足す。既定値のままのv6は、新規作成したprojectと同じ形になる（計画§6.2）。
test("v5 project migrates to v6 with the documented defaults (v6)", () => {
  const raw = {
    version: 5,
    title: "旧v5",
    fps: 24,
    assets: [
      { id: "a1", kind: "image", name: "x.png", mime: "image/png", bytes: 1 },
    ],
    audio: [],
    paper: {
      size: "A4",
      orientation: "portrait",
      rows: 4,
      margin: 45,
      font: 18,
      header: "",
      footer: "",
      columns: [{ key: "cut", width: 10 }],
      duration: true,
      numbers: true,
      cameraMarks: true,
    },
    scenes: [
      {
        id: "s1",
        name: "シーン01",
        shots: [
          {
            id: "h1",
            name: "",
            panels: [
              {
                id: "b1",
                frames: 24,
                dialogue: "",
                sound: "",
                notes: "",
                strokes: [],
                image: { assetId: "a1", opacity: 1 },
                camera: [{ t: 0, x: 0, y: 0, zoom: 1, rotation: 0 }],
              },
            ],
          },
        ],
      },
    ],
  };
  const p = migrate(raw);
  assert.equal(p.version, VERSION);
  assert.deepEqual(p.markers, []);
  assert.equal(p.workArea, null);
  assert.equal(p.paper.vertical, false);
  const b = p.scenes[0].shots[0].panels[0];
  assert.equal(b.label, null);
  assert.deepEqual(b.image, {
    assetId: "a1",
    opacity: 1,
    fit: "contain",
    offset: { x: 0, y: 0 },
    scale: 1,
  });
  assert.equal(b.camera[0].ease, "linear");
  assert.equal(validate(p), p);
  const fresh = project();
  assert.deepEqual(p.markers, fresh.markers);
  assert.equal(p.workArea, fresh.workArea);
  assert.equal(p.paper.vertical, fresh.paper.vertical);
});
test("migration does not touch the source object", () => {
  for (const text of [fixture, fixtureV2]) {
    const raw = JSON.parse(text);
    const copy = JSON.parse(text);
    migrate(raw);
    assert.deepEqual(raw, copy);
  }
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
  b.image = { assetId: "missing", opacity: 1, fit: "contain", offset: { x: 0, y: 0 }, scale: 1 };
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
