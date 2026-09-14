import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pageGeometry,
  wrapLines,
  columnText,
  layoutPages,
  COLUMN_LABEL,
} from "../src/paper.js";
import {
  forEachPage,
  Job,
  Cancelled,
  zip,
  ZipBuilder,
  crc32,
} from "../src/exporter.js";
import {
  project,
  panel,
  flatten,
  paperDefaults,
  validate,
  setCameraKey,
} from "../src/model.js";
import { addClip } from "../src/audio.js";
// 1文字の幅をフォントサイズの0.6倍と見なす簡易計測。実ブラウザの代わりに使う。
const measure = (text, size = 18) => [...text].length * size * 0.6;
const settings = (over = {}) => ({ ...paperDefaults(), ...over });
test("page geometry follows the paper size, orientation and column widths", () => {
  const portrait = pageGeometry(settings());
  assert.deepEqual([portrait.width, portrait.height], [1240, 1754]);
  const landscape = pageGeometry(settings({ orientation: "landscape" }));
  assert.deepEqual([landscape.width, landscape.height], [1754, 1240]);
  const a3 = pageGeometry(settings({ size: "A3" }));
  assert.deepEqual([a3.width, a3.height], [1754, 2480]);
  // 列は指定した順に並び、幅の比率どおりに分ける。
  const custom = pageGeometry(
    settings({
      columns: [
        { key: "image", width: 50 },
        { key: "dialogue", width: 50 },
      ],
    }),
  );
  assert.equal(custom.columns[0].key, "image");
  assert.equal(custom.columns[0].width, custom.columns[1].width);
  assert.equal(
    custom.columns[1].x,
    custom.columns[0].x + custom.columns[0].width,
  );
  assert.equal(
    Math.round(custom.columns.reduce((s, c) => s + c.width, 0)),
    custom.inner,
  );
  assert.equal(COLUMN_LABEL.cut, "CUT");
});
test("wrapping keeps every character and respects explicit newlines", () => {
  const lines = wrapLines(
    "あいうえおかきくけこ\nさしすせそ",
    6 * 18 * 0.6,
    measure,
  );
  assert.deepEqual(lines, ["あいうえおか", "きくけこ", "さしすせそ"]);
  assert.equal(lines.join("").length, "あいうえおかきくけこさしすせそ".length);
  assert.deepEqual(wrapLines("", 100, measure), [""]);
});
test("long text continues onto the next row instead of being cut", () => {
  const p = project();
  const rows = flatten(p);
  rows[0].panel.dialogue = "あ".repeat(600);
  const pages = layoutPages(p, settings({ rows: 2 }), measure, rows);
  const entries = pages
    .flat()
    .filter((e) => e.row.panel.id === rows[0].panel.id);
  assert.ok(entries.length > 1, "long dialogue did not continue");
  assert.equal(entries[0].continuation, false);
  assert.ok(entries.at(-1).continuation);
  const kept = entries
    .flatMap((e) => e.cells.get("dialogue") ?? [])
    .join("").length;
  assert.equal(kept, 600, `kept ${kept} of 600 characters`);
});
test("pagination fills pages in order and never loses a panel", () => {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: 9 }, panel);
  const rows = flatten(p);
  for (const count of [1, 4, 8]) {
    const pages = layoutPages(p, settings({ rows: count }), measure, rows);
    assert.equal(pages.length, Math.ceil(9 / count));
    assert.deepEqual(
      pages.flat().map((e) => e.row.panel.id),
      rows.map((r) => r.panel.id),
    );
    assert.ok(pages.every((page) => page.length <= count));
  }
});
test("column text reports numbers, duration, sound and camera consistently", () => {
  const p = project();
  p.assets.push({
    id: "s1",
    kind: "audio",
    name: "door.wav",
    mime: "audio/wav",
    bytes: 10,
  });
  const rows = flatten(p);
  rows[0].panel.sound = "遠くで雷";
  addClip(p, {
    assetId: "s1",
    track: "se",
    anchor: rows[0].panel.id,
    at: 6,
    frames: 12,
  });
  validate(p);
  const o = settings();
  const clips = undefined;
  assert.match(columnText(p, rows, clips, rows[0], o, "cut"), /CUT 1/);
  assert.match(columnText(p, rows, clips, rows[0], o, "cut"), /48f/);
  assert.equal(
    columnText(p, rows, clips, rows[0], o, "sound"),
    "遠くで雷\nSE: door.wav +6f",
  );
  assert.equal(columnText(p, rows, clips, rows[0], o, "camera"), "HOLD");
  assert.equal(
    columnText(
      p,
      rows,
      clips,
      rows[0],
      { ...o, numbers: false, duration: false },
      "cut",
    ),
    "CUT 1",
  );
});
test("export runs page by page, reports progress and stops when cancelled", async () => {
  const seen = [];
  const done = await forEachPage(3, async (i) => i * 2, {
    onProgress: (p) => seen.push(p.done),
  });
  assert.deepEqual(done, [0, 2, 4]);
  assert.deepEqual(seen, [1, 2, 3]);
  const job = new Job();
  const made = [];
  await assert.rejects(
    () =>
      forEachPage(
        5,
        async (i) => {
          made.push(i);
          if (i === 1) job.cancel();
          return i;
        },
        { job },
      ),
    Cancelled,
  );
  assert.deepEqual(made, [0, 1], "cancel must stop the next page");
});
test("invalid export yield intervals still yield safely", async () => {
  const seen = [];
  await forEachPage(2, async (i) => i, {
    yieldEvery: 0,
    onProgress: ({ done }) => seen.push(done),
  });
  assert.deepEqual(seen, [1, 2]);
});
test("the zip container keeps each file readable", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const blob = zip([
    { name: "conte-001.png", bytes },
    { name: "conte-002.png", bytes: new Uint8Array([9]) },
  ]);
  const data = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(data.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(new TextDecoder().decode(data.slice(30, 43)), "conte-001.png");
  assert.equal(view.getUint32(14, true), crc32(bytes));
  // 末尾のセントラルディレクトリが2件を指している。
  const end = data.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
});
test("ZipBuilder matches zip and accepts files incrementally", async () => {
  const builder = new ZipBuilder();
  builder.add({ name: "a.txt", bytes: new Uint8Array([1, 2]) });
  builder.add({ name: "b.txt", bytes: new Uint8Array([3]) });
  const data = new Uint8Array(await builder.finish().arrayBuffer());
  const view = new DataView(data.buffer);
  const end = data.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  assert.equal(view.getUint32(14, true), crc32(new Uint8Array([1, 2])));
});
test("paper camera column draws the trajectory of a round trip", () => {
  const p = project();
  const rows = flatten(p);
  setCameraKey(rows[0].panel, 0.5, { zoom: 2 });
  setCameraKey(rows[0].panel, 1, { zoom: 1 });
  validate(p);
  const text = columnText(p, rows, undefined, rows[0], settings(), "camera");
  assert.notEqual(text, "HOLD");
  assert.match(text, /ZOOM IN \/ ZOOM OUT/);
  // 表記にはキーの位置も並ぶので、往復が読み取れる。
  assert.match(text, /0f → 24f → 48f/);
});
