// LOGIC_UX_AUDIT向けの大規模計測。1000/2500/5000 Panelで、既存bench.mjsが
// 測っていない経路（Store.edit複製コスト、render()相当のツリー生成数、
// movePanels、Asset GC、ZIP保持量）を対象にする。
//
// 計測はNode上でMemoryStorageを使う。ブラウザのDOM生成・IndexedDB実測・
// 画像デコードは含まない。ここでの数値は構造上の傾向を確認するためのもので、
// ブラウザでの体感速度を保証しない。
import { performance } from "node:perf_hooks";
import { project, panel, scene as makeScene, shot as makeShot, Store, flatten, BRUSH, uid } from "../src/model.js";
import { buildProjectIndex } from "../src/project-index.js";
import { movePanels } from "../src/model.js";
import * as audio from "../src/audio.js";
import { ProjectRepository } from "../src/repository.js";
import { MemoryStorage } from "../src/storage.js";
import { ZipBuilder } from "../src/exporter.js";
import * as timeline from "../src/timeline.js";

function buildProject(panelCount, { shotsPer = 15, panelsPerShot = 6 } = {}) {
  const p = project();
  p.scenes = [];
  let remaining = panelCount;
  let sceneIndex = 0;
  while (remaining > 0) {
    const sc = makeScene(`シーン${++sceneIndex}`);
    sc.shots = [];
    for (let s = 0; s < shotsPer && remaining > 0; s++) {
      const sh = makeShot(`Shot ${s + 1}`);
      sh.panels = [];
      for (let i = 0; i < panelsPerShot && remaining > 0; i++, remaining--) {
        const b = panel();
        b.strokes = Array.from({ length: 6 }, () => ({
          size: BRUSH.default,
          erase: false,
          points: Array.from({ length: 40 }, (_, k) => [k / 40, k / 40, 1]),
        }));
        sh.panels.push(b);
      }
      sc.shots.push(sh);
    }
    p.scenes.push(sc);
  }
  p.assets = [];
  p.audio = [];
  const rows = flatten(p);
  // 20 Panelに1本、音声クリップを置く（3トラックを循環）。
  const tracks = ["dialogue", "se", "bgm"];
  for (let i = 0; i < rows.length; i += 20) {
    const assetId = `asset-${i}`;
    if (!p.assets.some((a) => a.id === assetId))
      p.assets.push({ id: assetId, kind: "audio", name: `${assetId}.wav`, mime: "audio/wav", bytes: 1000 });
    audio.addClip(p, {
      assetId,
      track: tracks[(i / 20) % 3],
      anchor: rows[i].panel.id,
      at: 0,
      frames: Math.min(rows[i].panel.frames, 10),
    });
  }
  return p;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeit(label, count, fn, runs = 15) {
  const values = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    values.push(performance.now() - t);
  }
  console.log(
    `${count}\t${label}\tmedian ${median(values).toFixed(3)}ms\tp95 ${[...values].sort((a, b) => a - b)[Math.floor(runs * 0.95)].toFixed(3)}ms`,
  );
  return median(values);
}

for (const N of [1000, 2500, 5000]) {
  console.log(`\n=== N = ${N} Panels ===`);
  const p = buildProject(N);
  const rows = flatten(p);
  console.log(`  scenes=${p.scenes.length} shots=${p.scenes.reduce((n, s) => n + s.shots.length, 0)} audioClips=${p.audio.length}`);

  await timeit("flatten(p)", N, () => flatten(p));
  await timeit("buildProjectIndex(p)", N, () => buildProjectIndex(p));

  // render()の#treeが毎回作るノード数の目安（Scene detail + Shot button + Panel button）。
  const treeNodeCount = p.scenes.length + p.scenes.reduce((n, s) => n + s.shots.length, 0) + N;
  console.log(`  tree DOM nodes rebuilt per render() call (unconditional, not viewport-limited): ${treeNodeCount}`);

  const store = new Store(p);
  await timeit("Store.edit() single frames++ (full deep clone + validate)", N, () => {
    store.edit((proj) => {
      proj.scenes[0].shots[0].panels[0].frames =
        (proj.scenes[0].shots[0].panels[0].frames % 800) + 1;
    });
  });

  await timeit("movePanels() single panel to project end", N, () => {
    const target = rows.at(-1).panel.id;
    const source = rows[Math.floor(rows.length / 2)].panel.id;
    movePanels(p, [source], target, "after");
  });

  await timeit("audio.resolveClips(p, rows)", N, () => audio.resolveClips(p, rows));

  await timeit("timeline.visible() (bounded by viewport, control)", N, () =>
    timeline.visible(rows, 3, 12000, 900),
  );

  const repo = new ProjectRepository(new MemoryStorage());
  let savedId = null;
  await timeit("repository.save() (MemoryStorage, JSON.stringify included)", N, async () => {
    savedId = (await repo.save(p)).id;
  });

  // 8世代分のSnapshotを積んだ状態でのAsset GC。
  for (let i = 0; i < 8; i++) await repo.save(p);
  await timeit("repo.pruneAssets() with 8 snapshots retained", N, () => repo.pruneAssets(p, []));

  // 出力ZIP：PNG連番のBlob化前にchunks配列がどれだけメモリへ残るかの目安。
  // 1ページ相当を50KBのダミーPNGとみなし、F枚のframeを追加したときの保持量を計算する。
  const dummyPage = new Uint8Array(50 * 1024);
  for (const F of [300, 1000]) {
    const builder = new ZipBuilder();
    const t0 = performance.now();
    for (let i = 0; i < F; i++)
      builder.add({ name: `frame-${i}.png`, bytes: dummyPage });
    const addMs = performance.now() - t0;
    const heldBytes = builder.chunks.reduce((n, c) => n + c.byteLength, 0);
    console.log(
      `  ZipBuilder: ${F} frames x 50KB added in ${addMs.toFixed(1)}ms, held in memory before finish(): ${(heldBytes / 1e6).toFixed(1)}MB`,
    );
  }
}
