import { performance } from "node:perf_hooks";
import { project, panel, Store, flatten, load } from "../src/model.js";
for (const count of [100, 500]) {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: count }, () => ({
    ...panel(),
    strokes: Array.from({ length: 10 }, () =>
      Array.from({ length: 50 }, (_, i) => [i / 50, i / 50]),
    ),
  }));
  const s = new Store(p);
  const bench = (name, f) => {
    const values = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      f();
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
  bench("timeline index", () => flatten(p));
  bench("duration + undo", () => {
    s.edit((p) => p.scenes[0].shots[0].panels[0].frames++);
    s.undo();
  });
  bench("serialize", () => JSON.stringify(p));
  const text = JSON.stringify(p);
  bench("load + validate", () => load(text));
  console.log("bytes", Buffer.byteLength(text));
}
