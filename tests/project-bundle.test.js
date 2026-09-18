import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBundle,
  parseBundle,
  remapAssetId,
  planImport,
  sha256Hex,
} from "../src/project-bundle.js";
import { ZipBuilder } from "../src/exporter.js";
import { project, flatten, validate } from "../src/model.js";
import { addClip } from "../src/audio.js";

// D1：Bundle（.conte.zip）はProject＋参照する原本を1つのZIPへ詰める。
const imageBytes = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const withImage = (id = "img-1") => {
  const p = project();
  p.assets.push({
    id,
    kind: "image",
    name: "bg.png",
    mime: "image/png",
    bytes: 8,
    width: 2,
    height: 2,
  });
  flatten(p)[0].panel.image = {
    assetId: id,
    opacity: 1,
    fit: "contain",
    offset: { x: 0, y: 0 },
    scale: 1,
  };
  validate(p);
  return p;
};
const assetStore = (entries) => (id) => entries.get(id);

test("buildBundle then parseBundle round-trips the project and asset bytes", async () => {
  const p = withImage();
  const store = new Map([["img-1", imageBytes()]]);
  const blob = await buildBundle(p, assetStore(store));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { project: restored, assets } = await parseBundle(bytes);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), restored);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].id, "img-1");
  assert.equal(assets[0].sha256, await sha256Hex(imageBytes()));
  assert.deepEqual(
    new Uint8Array(await assets[0].blob.arrayBuffer()),
    imageBytes(),
  );
});

test("buildBundle refuses to produce a bundle missing a referenced asset's original", async () => {
  const p = withImage();
  await assert.rejects(
    () => buildBundle(p, assetStore(new Map())),
    /見つかりません/,
  );
});

test("parseBundle rejects a zip that is not the conte-bundle format", async () => {
  const zip = new ZipBuilder()
    .add({ name: "manifest.json", bytes: new TextEncoder().encode("{}") })
    .finish();
  const bytes = new Uint8Array(await zip.arrayBuffer());
  await assert.rejects(() => parseBundle(bytes), /conte\.zip形式ではありません/);
});

test("parseBundle rejects an unknown bundle version", async () => {
  const manifest = {
    format: "conte-bundle",
    version: 999,
    project: "project.contp",
    assets: [],
  };
  const zip = new ZipBuilder()
    .add({
      name: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    })
    .add({
      name: "project.contp",
      bytes: new TextEncoder().encode(JSON.stringify(project())),
    })
    .finish();
  const bytes = new Uint8Array(await zip.arrayBuffer());
  await assert.rejects(() => parseBundle(bytes), /未対応のBundle Version/);
});

test("parseBundle rejects a zip entry whose bytes were corrupted (CRC mismatch)", async () => {
  const p = withImage();
  const store = new Map([["img-1", imageBytes()]]);
  const blob = await buildBundle(p, assetStore(store));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // 素材の実体バイトを1つだけ書き換える。ZIP自体のCRCで検出できるはず。
  const marker = imageBytes();
  const at = bytes.findIndex((_, i) =>
    marker.every((b, j) => bytes[i + j] === b),
  );
  assert.ok(at >= 0, "テスト用の素材バイト列が見つからない");
  const tampered = bytes.slice();
  tampered[at] = tampered[at] ^ 0xff;
  await assert.rejects(() => parseBundle(tampered), /CRCが一致しません/);
});

test("parseBundle rejects an asset whose content does not match manifest's declared hash", async () => {
  // ZIP自体は壊れていない（CRCは実際のバイト列と一致する）が、manifestが
  // 宣言したsha256が実体と食い違う場合を、Bundle側の検証で検出できること。
  const bytes = imageBytes();
  const manifest = {
    format: "conte-bundle",
    version: 1,
    project: "project.contp",
    assets: [
      {
        id: "img-1",
        kind: "image",
        name: "bg.png",
        mime: "image/png",
        bytes: bytes.length,
        path: "assets/000001.bin",
        sha256: "0".repeat(64),
      },
    ],
  };
  const zip = new ZipBuilder()
    .add({
      name: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    })
    .add({
      name: "project.contp",
      bytes: new TextEncoder().encode(JSON.stringify(withImage())),
    })
    .add({ name: "assets/000001.bin", bytes })
    .finish();
  const zipBytes = new Uint8Array(await zip.arrayBuffer());
  await assert.rejects(() => parseBundle(zipBytes), /内容が一致しません/);
});

test("parseBundle rejects a manifest asset path outside the assets/ directory", async () => {
  const manifest = {
    format: "conte-bundle",
    version: 1,
    project: "project.contp",
    assets: [
      {
        id: "img-1",
        kind: "image",
        name: "bg.png",
        mime: "image/png",
        bytes: 4,
        path: "../evil.bin",
        sha256: "0".repeat(64),
      },
    ],
  };
  const zip = new ZipBuilder()
    .add({
      name: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    })
    .add({
      name: "project.contp",
      bytes: new TextEncoder().encode(JSON.stringify(withImage())),
    })
    .add({ name: "../evil.bin", bytes: new Uint8Array([1, 2, 3, 4]) })
    .finish();
  const bytes = new Uint8Array(await zip.arrayBuffer());
  await assert.rejects(() => parseBundle(bytes), /格納パスが不正/);
});

test("parseBundle rejects a bundle whose project references an asset it does not carry", async () => {
  const p = withImage();
  const manifest = {
    format: "conte-bundle",
    version: 1,
    project: "project.contp",
    assets: [],
  };
  const zip = new ZipBuilder()
    .add({
      name: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    })
    .add({
      name: "project.contp",
      bytes: new TextEncoder().encode(JSON.stringify(p)),
    })
    .finish();
  const bytes = new Uint8Array(await zip.arrayBuffer());
  await assert.rejects(() => parseBundle(bytes), /Bundleにありません/);
});

test("remapAssetId renames every reference: Project.assets, Panel.image, AudioClip", () => {
  const p = withImage("old-id");
  p.assets.push({
    id: "snd-1",
    kind: "audio",
    name: "se.wav",
    mime: "audio/wav",
    bytes: 4,
  });
  addClip(p, {
    assetId: "snd-1",
    track: "se",
    anchor: flatten(p)[0].panel.id,
    at: 0,
    frames: 4,
  });
  validate(p);

  remapAssetId(p, "old-id", "new-id");
  assert.equal(p.assets.find((a) => a.name === "bg.png").id, "new-id");
  assert.equal(flatten(p)[0].panel.image.assetId, "new-id");
  assert.equal(p.audio[0].assetId, "snd-1", "無関係なIDは変わらない");

  remapAssetId(p, "snd-1", "snd-2");
  assert.equal(p.audio[0].assetId, "snd-2");
  validate(p);
});

test("remapAssetId is a no-op when old and new ids are the same", () => {
  const p = withImage("same-id");
  const before = JSON.stringify(p);
  remapAssetId(p, "same-id", "same-id");
  assert.equal(JSON.stringify(p), before);
});

// D1/R19：ID衝突の解決。既存が無ければそのまま書き、同じ内容なら再利用し、
// 内容が違えば新しいIDを発行する（既存Snapshotが指す原本を上書きしない）。
test("planImport writes as-is when no asset with that id exists yet", async () => {
  const asset = { id: "img-1", sha256: await sha256Hex(imageBytes()) };
  const plan = await planImport([asset], async () => undefined);
  assert.deepEqual(plan, [{ asset, finalId: "img-1", write: true }]);
});

test("planImport reuses the existing id when the content is identical", async () => {
  const bytes = imageBytes();
  const asset = { id: "img-1", sha256: await sha256Hex(bytes) };
  const plan = await planImport([asset], async (id) =>
    id === "img-1" ? bytes : undefined,
  );
  assert.deepEqual(plan, [{ asset, finalId: "img-1", write: false }]);
});

test("planImport assigns a new id and writes when an existing id's content differs", async () => {
  const asset = { id: "img-1", sha256: await sha256Hex(imageBytes()) };
  const differentContent = new Uint8Array([9, 9, 9]);
  const plan = await planImport([asset], async () => differentContent);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].write, true);
  assert.notEqual(
    plan[0].finalId,
    "img-1",
    "既存Snapshotが指す原本を上書きしないよう、別のIDへ差し替えるはず",
  );
});

test("planImport decides independently per asset", async () => {
  const bytesA = imageBytes();
  const bytesB = new Uint8Array([9, 9, 9]);
  const assets = [
    { id: "same", sha256: await sha256Hex(bytesA) }, // 既存と同じ内容
    { id: "diff", sha256: await sha256Hex(bytesB) }, // 既存と違う内容
    { id: "new", sha256: await sha256Hex(bytesA) }, // 既存なし
  ];
  const existing = new Map([
    ["same", bytesA],
    ["diff", new Uint8Array([1, 2, 3])],
  ]);
  const plan = await planImport(assets, async (id) => existing.get(id));
  const byId = Object.fromEntries(plan.map((e) => [e.asset.id, e]));
  assert.deepEqual(
    { finalId: byId.same.finalId, write: byId.same.write },
    { finalId: "same", write: false },
  );
  assert.equal(byId.diff.write, true);
  assert.notEqual(byId.diff.finalId, "diff");
  assert.deepEqual(
    { finalId: byId.new.finalId, write: byId.new.write },
    { finalId: "new", write: true },
  );
});
