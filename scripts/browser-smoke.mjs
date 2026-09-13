// Optional QA tools; not runtime dependencies. Install Playwright separately.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { serve } from "./serve.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const server = await serve(resolve("."), 0);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE
    ? {
        executablePath: process.env.CHROMIUM_EXECUTABLE,
        args: ["--no-sandbox", "--no-zygote", "--disable-dev-shm-usage"],
      }
    : {}),
});
try {
  const page = await browser.newPage({
      viewport: { width: 1536, height: 960 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await page.mouse.move(700, 400, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press("n");
  await page.keyboard.press("]");
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator("#frames").inputValue(), "48");
  await page.keyboard.press("Control+Shift+z");
  assert.equal(await page.locator("#frames").inputValue(), "49");
  await page
    .locator("#dialogue")
    .fill("台詞の入力中 n [ ] は編集コマンドにならない");
  await page.keyboard.type("n");
  await page.locator("#notes").click();
  assert.equal(await page.locator("#strip button").count(), 2);
  await page.locator("#paper").click();
  assert.equal(await page.locator("#pages canvas").count(), 1);
  assert.equal(await page.locator("#print").isDisabled(), false);
  const png = page.waitForEvent("download");
  await page.locator("#png").click();
  assert.equal((await png).suggestedFilename(), "conte-001.png");
  await page.locator("#closePaper").click();
  const drag = await page.locator(".handle").first().boundingBox();
  await page.mouse.move(drag.x + 5, drag.y + 20);
  await page.mouse.down();
  await page.mouse.move(drag.x + 35, drag.y + 20);
  await page.mouse.up();
  assert.match(await page.locator(".clip").first().innerText(), /58f/);
  const { project, panel, uid } = await import("../src/model.js");
  const data = project();
  data.scenes = Array.from({ length: 5 }, (_, si) => ({
    id: uid(),
    name: `Scene ${si + 1}`,
    shots: [
      {
        id: uid(),
        panels: Array.from({ length: 100 }, () => ({
          ...panel(),
          strokes: Array.from({ length: 10 }, () =>
            Array.from({ length: 50 }, (_, i) => [i / 50, i / 50]),
          ),
        })),
      },
    ],
  }));
  await page
    .locator("#file")
    .setInputFiles({
      name: "500.contp",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(data)),
    });
  await page.waitForFunction(
    () => document.querySelectorAll("#tree .panel").length === 500,
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
    document.activeElement.blur();
    return {
      durationUI_ms: await measure(() =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "]", bubbles: true }),
        ),
      ),
      sceneNavigation_ms: await measure(() =>
        document
          .querySelectorAll("#tree details")[4]
          .querySelector("button")
          .click(),
      ),
      scroll_ms: await measure(() => {
        document.querySelector("#timeline").scrollLeft = 10000;
      }),
      zoom_ms: await measure(() => {
        const z = document.querySelector("#zoom");
        z.value = 6;
        z.dispatchEvent(new Event("input"));
      }),
      playStart_ms: await measure(() =>
        document.querySelector("#play").click(),
      ),
    };
  });
  await page.locator("#play").click();
  const save = page.waitForEvent("download");
  await page.locator("#save").click();
  assert.equal((await save).suggestedFilename(), "project.contp");
  await page.locator("#paper").click();
  assert.equal(await page.locator("#pages canvas").count(), 1);
  assert.equal(await page.locator("#print").isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ smoke: "passed", metrics, errors }, null, 2));
} finally {
  await browser.close();
  server.close();
}
