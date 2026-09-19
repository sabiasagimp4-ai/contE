import { validate } from "./model.js";
import { ZipBuilder, crc32 } from "./exporter.js";
import { createExportSnapshot } from "./export-snapshot.js";

export const BUNDLE_FORMAT = "contE-bundle";
export const BUNDLE_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function bytesOf(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  if (typeof value?.arrayBuffer === "function")
    return new Uint8Array(await value.arrayBuffer());
  throw Error("Assetバイナリを読み取れません");
}

export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw Error("SHA-256を利用できる環境が必要です");
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function textFile(value) {
  return encoder.encode(JSON.stringify(value));
}

function assetEntries(value) {
  if (value instanceof Map)
    return [...value].map(([id, bytes]) => ({ id, bytes }));
  if (value && typeof value[Symbol.iterator] === "function")
    return [...value].map((entry) =>
      Array.isArray(entry)
        ? { id: entry[0], bytes: entry[1] }
        : entry,
    );
  throw Error("Asset一覧が不正です");
}

function safeAssetId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id);
}

export async function createBundle(project, assets) {
  const snapshot = createExportSnapshot(project);
  const projectAssets = new Map(
    snapshot.project.assets.map((asset) => [asset.id, asset]),
  );
  const entries = new Map();

  for (const entry of assetEntries(assets)) {
    const meta = projectAssets.get(entry?.id);
    if (!meta || !safeAssetId(entry.id))
      throw Error("Projectに存在しないAssetをBundleへ追加できません");
    if (entries.has(entry.id)) throw Error("Asset IDが重複しています");
    const bytes = await bytesOf(entry.bytes);
    if (bytes.length !== meta.bytes)
      throw Error(`Assetサイズが一致しません：${entry.id}`);
    entries.set(entry.id, {
      id: entry.id,
      name: meta.name,
      mime: meta.mime,
      bytes,
      sha256: await sha256Hex(bytes),
    });
  }

  for (const meta of snapshot.project.assets)
    if (!entries.has(meta.id))
      throw Error(`Assetバイナリがありません：${meta.name}`);

  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    projectVersion: snapshot.project.version,
    assets: [...entries.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, name, mime, bytes, sha256 }) => ({
        id,
        name,
        mime,
        bytes: bytes.length,
        sha256,
      })),
  };
  const builder = new ZipBuilder();
  builder.add({ name: "manifest.json", bytes: textFile(manifest) });
  builder.add({
    name: "project.json",
    bytes: encoder.encode(JSON.stringify(snapshot.project)),
  });
  for (const entry of [...entries.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  ))
    builder.add({ name: `assets/${entry.id}`, bytes: entry.bytes });
  return builder.finish();
}

function storedFiles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50)
      throw Error("BundleのZIP構造が不正です");
    if (offset + 30 > bytes.length) throw Error("Bundleのヘッダが切れています");
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const original = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (flags & 0x0008 || method !== 0 || compressed !== original)
      throw Error("圧縮または遅延サイズのBundleは未対応です");
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameLength + extraLength;
    const bodyEnd = bodyStart + compressed;
    if (bodyEnd > bytes.length) throw Error("BundleのAssetが切れています");
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("..") ||
      name.includes("\\") ||
      files.has(name)
    )
      throw Error("Bundleのファイル名が不正です");
    const body = bytes.slice(bodyStart, bodyEnd);
    if (crc32(body) !== view.getUint32(offset + 14, true))
      throw Error(`BundleのCRCが一致しません：${name}`);
    files.set(name, body);
    offset = bodyEnd;
  }
  return files;
}

function requiredFile(files, name) {
  const file = files.get(name);
  if (!file) throw Error(`Bundleに${name}がありません`);
  return file;
}

export async function readBundle(input) {
  const files = storedFiles(await bytesOf(input));
  let manifest;
  let project;
  try {
    manifest = JSON.parse(decoder.decode(requiredFile(files, "manifest.json")));
    project = JSON.parse(decoder.decode(requiredFile(files, "project.json")));
  } catch (error) {
    throw Error(`BundleのJSONを読めません：${error.message}`);
  }
  if (
    manifest?.format !== BUNDLE_FORMAT ||
    manifest.version !== BUNDLE_VERSION ||
    manifest.projectVersion !== project?.version ||
    !Array.isArray(manifest.assets)
  )
    throw Error("未対応のBundle形式です");
  validate(project);
  const projectAssets = new Map(
    project.assets.map((asset) => [asset.id, asset]),
  );
  const listed = new Set();
  const assets = [];
  for (const item of manifest.assets) {
    if (
      !safeAssetId(item?.id) ||
      listed.has(item.id) ||
      typeof item.name !== "string" ||
      typeof item.mime !== "string" ||
      !Number.isInteger(item.bytes) ||
      item.bytes < 0 ||
      typeof item.sha256 !== "string"
    )
      throw Error("BundleのAssetメタデータが不正です");
    const meta = projectAssets.get(item.id);
    if (
      !meta ||
      meta.name !== item.name ||
      meta.mime !== item.mime ||
      meta.bytes !== item.bytes
    )
      throw Error("BundleのProjectとAssetメタデータが一致しません");
    const bytes = files.get(`assets/${item.id}`);
    if (!bytes || bytes.length !== item.bytes)
      throw Error(`BundleのAssetがありません：${item.id}`);
    if (await sha256Hex(bytes) !== item.sha256)
      throw Error(`BundleのSHA-256が一致しません：${item.id}`);
    listed.add(item.id);
    assets.push({ ...item, bytes });
  }
  if (listed.size !== project.assets.length)
    throw Error("BundleのAsset一覧がProjectと一致しません");
  for (const name of files.keys())
    if (name.startsWith("assets/") && !listed.has(name.slice("assets/".length)))
      throw Error("Bundleに未登録のAssetがあります");
  return { project, assets };
}
