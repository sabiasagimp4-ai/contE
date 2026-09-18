// 素材同梱の.conte.zip（D1）。ZIPの読み書き自体はexporter.jsに任せ、
// ここではBundleというフォーマット（manifest・照合・Project内のAsset ID付け替え）
// だけを扱う。Repository/Storeへは触れない純粋な関数群にして、取込先（IndexedDB）
// との結びつけはapp.js側で行う（他のPaper/Markers同様の役割分担）。
import { flatten, load, uid } from "./model.js";
import { ZipBuilder, readZip } from "./exporter.js";

export const BUNDLE_FORMAT = "conte-bundle";
export const BUNDLE_VERSION = 1;
const PROJECT_ENTRY = "project.contp";
const ASSET_PATH = /^assets\/[^/]+$/;

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const toBytes = async (blob) =>
  blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());

// getAsset(id) => Blob | Uint8Array | undefined（既存のProjectRepository#getAssetと同じ形）。
// 参照する原本が1件でも欠けていれば、途中まで書かずに例外で止める。
export async function buildBundle(project, getAsset) {
  const builder = new ZipBuilder();
  const manifestAssets = [];
  let seq = 0;
  for (const asset of project.assets) {
    const raw = await getAsset(asset.id);
    if (!raw) throw new Error(`素材の原本が見つかりません：${asset.name}`);
    const bytes = await toBytes(raw);
    seq++;
    const path = `assets/${String(seq).padStart(6, "0")}.bin`;
    builder.add({ name: path, bytes });
    manifestAssets.push({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      mime: asset.mime,
      bytes: bytes.length,
      ...(asset.width !== undefined ? { width: asset.width } : {}),
      ...(asset.height !== undefined ? { height: asset.height } : {}),
      path,
      sha256: await sha256Hex(bytes),
    });
  }
  builder.add({
    name: PROJECT_ENTRY,
    bytes: new TextEncoder().encode(JSON.stringify(project)),
  });
  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    project: PROJECT_ENTRY,
    assets: manifestAssets,
  };
  builder.add({
    name: "manifest.json",
    bytes: new TextEncoder().encode(JSON.stringify(manifest)),
  });
  return builder.finish();
}

const invalidManifestAsset = (a) =>
  typeof a?.id !== "string" ||
  !["image", "audio"].includes(a?.kind) ||
  typeof a?.name !== "string" ||
  typeof a?.mime !== "string" ||
  !Number.isInteger(a?.bytes) ||
  a.bytes < 0 ||
  typeof a?.path !== "string" ||
  typeof a?.sha256 !== "string" ||
  ["width", "height"].some(
    (k) => a[k] !== undefined && !(Number.isInteger(a[k]) && a[k] > 0),
  );

// ZIPを読み、形式・件数・パス・サイズ・ハッシュ・Projectとの参照整合をすべて
// 検証してから返す。何か1つでもおかしければ、ここで例外にして呼び出し側には
// 何も書き込ませない（R19の「途中失敗では既存データが変化しない」の前提）。
export async function parseBundle(zipBytes) {
  let entries;
  try {
    entries = readZip(zipBytes);
  } catch (e) {
    throw new Error(`.conte.zipとして読み取れません：${e.message}`);
  }
  const byName = new Map(entries.map((e) => [e.name, e.bytes]));
  const manifestBytes = byName.get("manifest.json");
  if (!manifestBytes) throw new Error("manifest.jsonがありません");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error("manifest.jsonを読み取れません");
  }
  if (manifest?.format !== BUNDLE_FORMAT)
    throw new Error("この.zipは.conte.zip形式ではありません");
  if (manifest.version !== BUNDLE_VERSION)
    throw new Error(`未対応のBundle Versionです：${manifest.version}`);
  if (!Array.isArray(manifest.assets))
    throw new Error("manifest.jsonの素材一覧が不正です");
  const projectPath = manifest.project ?? PROJECT_ENTRY;
  const projectBytes = byName.get(projectPath);
  if (!projectBytes) throw new Error(`${projectPath}がありません`);
  // load()がmigrate + validateまで行う。旧Versionでもここで最新へ揃う。
  const project = load(new TextDecoder().decode(projectBytes));
  const seenIds = new Set();
  const seenPaths = new Set();
  const assets = [];
  for (const entry of manifest.assets) {
    if (invalidManifestAsset(entry))
      throw new Error("manifest.jsonの素材項目が不正です");
    if (!ASSET_PATH.test(entry.path) || entry.path.includes(".."))
      throw new Error(`素材の格納パスが不正です：${entry.path}`);
    if (seenIds.has(entry.id))
      throw new Error(`素材IDが重複しています：${entry.id}`);
    if (seenPaths.has(entry.path))
      throw new Error(`素材の格納パスが重複しています：${entry.path}`);
    seenIds.add(entry.id);
    seenPaths.add(entry.path);
    const bytes = byName.get(entry.path);
    if (!bytes) throw new Error(`素材のデータがありません：${entry.path}`);
    if (bytes.length !== entry.bytes)
      throw new Error(`素材のサイズが一致しません：${entry.name}`);
    if ((await sha256Hex(bytes)) !== entry.sha256)
      throw new Error(`素材の内容が一致しません（改ざんまたは破損）：${entry.name}`);
    assets.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      mime: entry.mime,
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
      sha256: entry.sha256,
      blob: new Blob([bytes], { type: entry.mime }),
    });
  }
  const assetById = new Map(assets.map((a) => [a.id, a]));
  for (const asset of project.assets)
    if (!assetById.has(asset.id))
      throw new Error(`Projectが参照する素材がBundleにありません：${asset.name}`);
  return { project, assets };
}

// Asset IDの衝突解決（R19）。既存のIDと内容が違うときだけ、新しいIDへ
// Project内の全参照（Project.assets／Panel.image／AudioClip）をまとめて付け替える。
export function remapAssetId(project, oldId, newId) {
  if (oldId === newId) return;
  for (const asset of project.assets) if (asset.id === oldId) asset.id = newId;
  for (const row of flatten(project))
    if (row.panel.image?.assetId === oldId) row.panel.image.assetId = newId;
  for (const clip of project.audio) if (clip.assetId === oldId) clip.assetId = newId;
}

// 取り込む各素材について、書き込むかどうかとどのIDを使うかだけを決める純粋関数
// （R19）。同じIDの原本が既にあり内容も同じなら再利用（書かない）。同じIDで
// 内容が違えば新しいIDを発行して書く。IDが無ければそのまま書く。実際にRepositoryへ
// 書く・Projectへ反映するのは呼び出し側（app.js）が行う。
// getExisting(id) => Uint8Array | undefined
export async function planImport(assets, getExisting) {
  const plan = [];
  for (const asset of assets) {
    const existing = await getExisting(asset.id);
    if (!existing) {
      plan.push({ asset, finalId: asset.id, write: true });
      continue;
    }
    const same = (await sha256Hex(existing)) === asset.sha256;
    plan.push({ asset, finalId: same ? asset.id : uid(), write: !same });
  }
  return plan;
}
