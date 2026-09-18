// Exporter：ページの生成を進捗つきで回し、途中で止められるようにする。
// 何を描くかはPaper Rendererが決める。ここは順番・進捗・中断・まとめ方だけを持つ。
export class Cancelled extends Error {
  constructor() {
    super("出力を中止しました");
    this.name = "Cancelled";
  }
}
export class Job {
  constructor() {
    this.cancelled = false;
  }
  cancel() {
    this.cancelled = true;
  }
  check() {
    if (this.cancelled) throw new Cancelled();
  }
}
const nextFrame = () =>
  new Promise((resolve) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 0),
  );
// 1ページずつ作り、その都度UIへ制御を返す。500ページでも画面が固まらない。
export async function forEachPage(
  count,
  produce,
  { job = new Job(), onProgress = () => {}, yieldEvery = 1 } = {},
) {
  const results = [];
  const interval = Number.isInteger(yieldEvery) && yieldEvery > 0 ? yieldEvery : 1;
  for (let i = 0; i < count; i++) {
    job.check();
    results.push(await produce(i));
    onProgress({ done: i + 1, total: count });
    if ((i + 1) % interval === 0) await nextFrame();
  }
  return results;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// 無圧縮ZIP。追加ライブラリを持ち込まず、連番出力を1件ずつ追加できる。
// Builderを使う経路ではフレーム全件のメタデータ配列を保持しない。
export class ZipBuilder {
  constructor() {
    this.encoder = new TextEncoder();
    this.chunks = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
  }
  add(file) {
    const { encoder } = this;
    const name = encoder.encode(file.name);
    const body = file.bytes;
    const sum = crc32(body);
    const localBuffer = new ArrayBuffer(30 + name.length);
    const local = new Uint8Array(localBuffer);
    const localData = new DataView(localBuffer);
    localData.setUint32(0, 0x04034b50, true);
    localData.setUint16(4, 20, true);
    localData.setUint16(6, 0x0800, true); // 名前はUTF-8
    localData.setUint16(8, 0, true); // 無圧縮
    localData.setUint32(14, sum, true);
    localData.setUint32(18, body.length, true);
    localData.setUint32(22, body.length, true);
    localData.setUint16(26, name.length, true);
    local.set(name, 30);
    this.chunks.push(localBuffer, body);
    const entryBuffer = new ArrayBuffer(46 + name.length);
    const entry = new Uint8Array(entryBuffer);
    const entryData = new DataView(entryBuffer);
    entryData.setUint32(0, 0x02014b50, true);
    entryData.setUint16(4, 20, true);
    entryData.setUint16(6, 20, true);
    entryData.setUint16(8, 0x0800, true);
    entryData.setUint16(10, 0, true);
    entryData.setUint32(16, sum, true);
    entryData.setUint32(20, body.length, true);
    entryData.setUint32(24, body.length, true);
    entryData.setUint16(28, name.length, true);
    entryData.setUint32(42, this.offset, true);
    entry.set(name, 46);
    this.central.push(entryBuffer);
    this.offset += localBuffer.byteLength + body.length;
    this.count++;
    return this;
  }
  finish() {
    const directory = this.central.reduce((sum, entry) => sum + entry.byteLength, 0);
    const endBuffer = new ArrayBuffer(22);
    const end = new DataView(endBuffer);
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, directory, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.chunks, ...this.central, endBuffer], {
      type: "application/zip",
    });
  }
}
export function zip(files) {
  const builder = new ZipBuilder();
  for (const file of files) builder.add(file);
  return builder.finish();
}
// ZipBuilderが書いた形式だけを読む（無圧縮・ZIP64無し・UTF-8名）。任意の外部ZIPへの
// 対応は目的にしない（D1）。各エントリはCRC32とサイズを照合してから返す。
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchFrom = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= searchFrom; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIPの終端レコードが見つかりません");
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset + directorySize > eocd)
    throw new Error("ZIPの中央ディレクトリの範囲が不正です");
  const decoder = new TextDecoder();
  const entries = [];
  let pos = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== CENTRAL_SIGNATURE)
      throw new Error("ZIPの中央ディレクトリが読み取れません");
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    if (method !== 0) throw new Error(`未対応の圧縮方式です：${name}`);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE)
      throw new Error(`ローカルヘッダが読み取れません：${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength;
    const bodyEnd = bodyStart + compressedSize;
    if (bodyEnd > bytes.length)
      throw new Error(`データの範囲が不正です：${name}`);
    const body = bytes.slice(bodyStart, bodyEnd);
    if (body.length !== size) throw new Error(`サイズが一致しません：${name}`);
    if (crc32(body) !== crc) throw new Error(`CRCが一致しません：${name}`);
    entries.push({ name, bytes: body });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
export const canvasBytes = async (canvas) => {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
};
