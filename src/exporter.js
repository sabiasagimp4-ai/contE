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
  for (let i = 0; i < count; i++) {
    job.check();
    results.push(await produce(i));
    onProgress({ done: i + 1, total: count });
    if ((i + 1) % yieldEvery === 0) await nextFrame();
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
// 無圧縮ZIP。追加ライブラリを持ち込まずに連番PNGを1ファイルへまとめる。
export function zip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const view = (length) => {
    const buffer = new ArrayBuffer(length);
    return { buffer: new Uint8Array(buffer), data: new DataView(buffer) };
  };
  for (const file of files) {
    const name = encoder.encode(file.name);
    const body = file.bytes;
    const sum = crc32(body);
    const local = view(30 + name.length);
    local.data.setUint32(0, 0x04034b50, true);
    local.data.setUint16(4, 20, true);
    local.data.setUint16(6, 0x0800, true); // 名前はUTF-8
    local.data.setUint16(8, 0, true); // 無圧縮
    local.data.setUint32(14, sum, true);
    local.data.setUint32(18, body.length, true);
    local.data.setUint32(22, body.length, true);
    local.data.setUint16(26, name.length, true);
    local.buffer.set(name, 30);
    chunks.push(local.buffer, body);
    const entry = view(46 + name.length);
    entry.data.setUint32(0, 0x02014b50, true);
    entry.data.setUint16(4, 20, true);
    entry.data.setUint16(6, 20, true);
    entry.data.setUint16(8, 0x0800, true);
    entry.data.setUint16(10, 0, true);
    entry.data.setUint32(16, sum, true);
    entry.data.setUint32(20, body.length, true);
    entry.data.setUint32(24, body.length, true);
    entry.data.setUint16(28, name.length, true);
    entry.data.setUint32(42, offset, true);
    entry.buffer.set(name, 46);
    central.push(entry.buffer);
    offset += local.buffer.length + body.length;
  }
  const directory = central.reduce((sum, e) => sum + e.length, 0);
  const end = view(22);
  end.data.setUint32(0, 0x06054b50, true);
  end.data.setUint16(8, files.length, true);
  end.data.setUint16(10, files.length, true);
  end.data.setUint32(12, directory, true);
  end.data.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], {
    type: "application/zip",
  });
}
export const canvasBytes = async (canvas) => {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
};
