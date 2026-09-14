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
export const canvasBytes = async (canvas) => {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
};
