// 大規模Projectでの実ブラウザ計測。LOGIC_UX_AUDITの性能検証で使った手順を
// 再現可能な形で残す。1000/2500/5000 Panelを読み込み、選択・尺変更のような
// 「本来はO(1)またはViewport相当で済むはずの操作」が実際にどれだけかかるかを
// 計測する。ここでの値はハードウェア・ブラウザ条件に依存するため、具体的な
// msを合否条件にはしない。DOM件数など、構造から決まる不変条件だけを検証する。
//
// 実行: PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE を指定して
//   node scripts/browser-scale.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { serve } from "./serve.mjs";

const loaded = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const { chromium } = loaded.chromium ? loaded : loaded.default;

const server = await serve(resolve("."), 0);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  args: process.env.CHROMIUM_EXECUTABLE
    ? ["--no-sandbox", "--no-zygote", "--disable-dev-shm-usage"]
    : ["--no-sandbox"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  const { project, panel: makePanel, uid, BRUSH } = await import("../src/model.js");

  const sizes = (process.env.SCALE_SIZES || "1000,2500,5000")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter(Boolean);

  const results = [];
  for (const N of sizes) {
    const data = project();
    data.title = `scale-${N}`;
    data.scenes = [];
    let remaining = N;
    // 実制作に近い構成：Sceneあたり15Shot、Shotあたり6Panel程度に分割する。
    while (remaining > 0) {
      const scene = { id: uid(), name: `Scene ${data.scenes.length + 1}`, shots: [] };
      for (let s = 0; s < 15 && remaining > 0; s++) {
        const shot = { id: uid(), name: "", panels: [] };
        for (let i = 0; i < 6 && remaining > 0; i++, remaining--) {
          shot.panels.push({
            ...makePanel(),
            strokes: Array.from({ length: 4 }, () => ({
              size: BRUSH.default,
              erase: false,
              points: Array.from({ length: 20 }, (_, k) => [k / 20, k / 20, 1]),
            })),
          });
        }
        scene.shots.push(shot);
      }
      data.scenes.push(scene);
    }

    await page.locator("#file").setInputFiles({
      name: `scale-${N}.contp`,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(data)),
    });
    await page.waitForFunction(
      (n) => document.querySelectorAll("#tree .panel").length === n,
      N,
      { timeout: 120000 },
    );

    const metrics = await page.evaluate(async () => {
      const twoFrames = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const measure = async (fn) => {
        const t = performance.now();
        fn();
        await twoFrames();
        return +(performance.now() - t).toFixed(2);
      };
      document.activeElement?.blur();
      const treeNodes = document.querySelectorAll("#tree button, #tree summary").length;
      const clipNodes = document.querySelectorAll("#clips .clip").length;
      const panelButtons = [...document.querySelectorAll("#tree .panel")];
      const firstBtn = panelButtons[0];
      const lastBtn = panelButtons[panelButtons.length - 1];
      const selectFirst_ms = await measure(() => firstBtn.click());
      const selectLast_ms = await measure(() => lastBtn.click());
      const editFrame_ms = await measure(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
      );
      const arrowSelect_ms = await measure(() =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
      );
      const mem = performance.memory
        ? {
            usedJSHeapMB: +(performance.memory.usedJSHeapSize / 1e6).toFixed(1),
            totalJSHeapMB: +(performance.memory.totalJSHeapSize / 1e6).toFixed(1),
          }
        : null;
      return { treeNodes, clipNodes, selectFirst_ms, selectLast_ms, editFrame_ms, arrowSelect_ms, mem };
    });
    results.push({ N, ...metrics });
    console.log(`N=${N}`, JSON.stringify(metrics));

    // 構造からの不変条件だけを検証する（msの合否判定はしない）。
    // Timeline/Stripは表示範囲だけをDOM化する設計なので、クリップ数はNに依存しないはず。
    assert.ok(
      metrics.clipNodes < 40,
      `timeline clip DOM should stay viewport-bounded, got ${metrics.clipNodes} at N=${N}`,
    );
    // Treeは現行実装ではPanel数に比例して増える（Section 5の既知の構造）。
    // ここでは「壊れていないか」の確認として、少なくともPanel数以上のノードがあることだけ見る。
    assert.ok(metrics.treeNodes >= N, `tree should contain at least ${N} nodes, got ${metrics.treeNodes}`);
  }
  assert.deepEqual(errors, []);
  console.log("RESULT", JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  server.close();
}
