import { performance } from "node:perf_hooks";
import { project, panel, Store, flatten, load, BRUSH } from "../src/model.js";
import { ProjectRepository } from "../src/repository.js";
import { MemoryStorage } from "../src/storage.js";
import * as timeline from "../src/timeline.js";
import * as paper from "../src/paper.js";
for (const count of [100, 500]) {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: count }, () => ({
    ...panel(),
    strokes: Array.from({ length: 10 }, () => ({
      size: BRUSH.default,
      erase: false,
      points: Array.from({ length: 50 }, (_, i) => [i / 50, i / 50, 1]),
    })),
  }));
  const s = new Store(p);
  const bench = async (name, f) => {
    const values = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await f();
      values.push(performance.now() - t);
    }
    values.sort((a, b) => a - b);
    console.log(
      count,
      name,
      "median",
      values[10].toFixed(2),
      "ms",
      "p95",
      values[19].toFixed(2),
      "ms",
    );
  };
  await bench("timeline index", () => flatten(p));
  await bench("duration + undo", () => {
    s.edit((p) => p.scenes[0].shots[0].panels[0].frames++);
    s.undo();
  });
  await bench("serialize", () => JSON.stringify(p));
  const text = JSON.stringify(p);
  await bench("load + validate", () => load(text));
  // 保存はメモリ上のStorageで計測する。ディスク/IndexedDBの時間は含まない。
  const repo = new ProjectRepository(new MemoryStorage());
  let id = null;
  await bench("repository save", async () => {
    id = (await repo.save(p)).id;
  });
  await bench("repository load", () => repo.load(id));
  // Timeline Engine：スクロール/ズームのたびに走る計算だけを測る。
  const rows = flatten(p);
  const end = rows.at(-1).end;
  await bench("timeline visible", () => timeline.visible(rows, 3, 12000, 900));
  await bench("timeline ticks", () =>
    timeline.ticks(p.fps, 3, 12000, 900, end),
  );
  const targets = timeline.snapTargets(rows, p.fps, end, 100);
  await bench("timeline snap", () => timeline.snap(4321, targets, 3));
  // 紙コンテのページ割り。文字幅は簡易計測で代用し、レイアウト計算だけを測る。
  const measure = (text, size) => [...text].length * size * 0.6;
  await bench("paper layout", () =>
    paper.layoutPages(p, p.paper, measure, rows),
  );
  console.log("bytes", Buffer.byteLength(text));
}
