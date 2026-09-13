// Optional QA tools; not runtime dependencies. Install Playwright separately.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { serve } from "./serve.mjs";
const loaded = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const { chromium } = loaded.chromium ? loaded : loaded.default;
// テスト用の実PNGを作る。アプリの依存ではなく、この検証スクリプト内だけで使う。
function testPng(width = 8, height = 8, rgb = [200, 90, 60]) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    let c = 0xffffffff;
    for (const byte of body) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.from(Array.from({ length: width }, () => rgb).flat()),
      ]),
    ),
  );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
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
  // P1：消しゴムが線を消し、白紙に穴を開けない。
  const darkPixels = () =>
    page.evaluate(() => {
      const c = document.querySelector("#drawing");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let dark = 0,
        clear = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 255) clear++;
        else if (d[i] < 128) dark++;
      }
      return { dark, clear };
    });
  const line = async () => {
    await page.mouse.move(600, 320);
    await page.mouse.down();
    await page.mouse.move(820, 430, { steps: 12 });
    await page.mouse.up();
  };
  const base = await darkPixels();
  await line();
  const drawn = await darkPixels();
  assert.ok(
    drawn.dark > base.dark + 500,
    `stroke added only ${drawn.dark - base.dark} pixels`,
  );
  await page.locator("#eraserTool").click();
  await page.locator("#brush").fill("40");
  await line();
  const erased = await darkPixels();
  // 消しゴムはなぞった線だけを消し、紙に穴を開けない。
  assert.ok(
    erased.dark <= base.dark + 20,
    `eraser left ${erased.dark - base.dark} extra pixels`,
  );
  assert.equal(erased.clear, 0, "eraser must not punch holes in the paper");
  await page.locator("#brushTool").click();
  await page.keyboard.press("Control+z");
  // P1：Shift範囲選択とドラッグ順序変更、Undoで元の並びへ戻る。
  await page.keyboard.press("n");
  const strip = page.locator("#strip button");
  await strip.nth(0).click();
  await strip.nth(2).click({ modifiers: ["Shift"] });
  assert.equal(await page.locator("#strip button.selected").count(), 3);
  await strip.nth(0).click();
  // 並びは尺で見分ける。ラベルのP番号は並べ替えで振り直される。
  const order = async () =>
    (await page.locator("#strip button").allInnerTexts()).map((t) =>
      t.split("·").at(-1).trim(),
    );
  const before = await order();
  const from = await strip.nth(0).boundingBox(),
    onto = await strip.nth(2).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(onto.x + onto.width - 6, onto.y + onto.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await page.waitForFunction(
    (first) =>
      !document.querySelector("#strip button")?.innerText.includes(first),
    before[0],
  );
  assert.deepEqual(await order(), [before[1], before[2], before[0]]);
  await page.keyboard.press("Control+z");
  assert.deepEqual(await order(), before);
  // P1：Scene名の編集とペイン幅の保存。
  await page.locator("#tree summary").first().dblclick();
  await page.locator("input.rename").fill("オープニング");
  await page.keyboard.press("Enter");
  assert.match(await page.locator("#breadcrumb").innerText(), /オープニング/);
  const splitter = await page.locator("#splitTree").boundingBox();
  await page.mouse.move(splitter.x + 3, splitter.y + 120);
  await page.mouse.down();
  await page.mouse.move(splitter.x + 100, splitter.y + 120, { steps: 6 });
  await page.mouse.up();
  const paneWidth = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--tree")
      .trim(),
  );
  assert.notEqual(paneWidth, "220px");
  const { project, panel, uid, BRUSH } = await import("../src/model.js");
  const data = project();
  data.scenes = Array.from({ length: 5 }, (_, si) => ({
    id: uid(),
    name: `Scene ${si + 1}`,
    shots: [
      {
        id: uid(),
        name: "",
        panels: Array.from({ length: 100 }, () => ({
          ...panel(),
          strokes: Array.from({ length: 10 }, () => ({
            size: BRUSH.default,
            erase: false,
            points: Array.from({ length: 50 }, (_, i) => [i / 50, i / 50, 1]),
          })),
        })),
      },
    ],
  }));
  await page.locator("#file").setInputFiles({
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
  // P1：画像取り込み。原本はAssetストアへ入り、プロジェクトはIDだけを持つ。
  await page.locator("#tree details").first().locator("summary").click();
  await page.locator("#tree .panel").first().click();
  await page.locator("#imageFile").setInputFiles({
    name: "bg.png",
    mimeType: "image/png",
    buffer: testPng(),
  });
  await page.waitForFunction(() =>
    document.querySelector("#assetInfo").textContent.includes("bg.png"),
  );
  assert.deepEqual(
    await page.evaluate(() => [
      ...document
        .querySelector("#drawing")
        .getContext("2d")
        .getImageData(900, 200, 1, 1).data,
    ]),
    [200, 90, 60, 255],
  );
  // 自動保存と復旧：編集 → ブラウザ内保存 → 再起動 → 復旧で同じ内容へ戻る。
  const persisted = await page.evaluate(async () => {
    document.activeElement.blur();
    const t = performance.now();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
    const text = () => document.querySelector("#savestate").textContent;
    while (!text().startsWith("ブラウザに保存"))
      await new Promise((r) => setTimeout(r, 50));
    return {
      panels: document.querySelectorAll("#tree .panel").length,
      title: document.querySelector("#title").value,
      autosave_ms: +(performance.now() - t).toFixed(2),
    };
  });
  await page.reload();
  await page.waitForSelector("#recoverDialog[open]");
  assert.match(
    await page.locator("#recoverInfo").innerText(),
    new RegExp(`${persisted.panels} Panel`),
  );
  await page.locator("#recover").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll("#tree .panel").length === n,
    persisted.panels,
  );
  assert.equal(await page.locator("#title").inputValue(), persisted.title);
  await page.waitForFunction(() =>
    document.querySelector("#assetInfo").textContent.includes("bg.png"),
  );
  assert.doesNotMatch(
    await page.locator("#assetInfo").innerText(),
    /読み込めません/,
  );
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--tree")
        .trim(),
    ),
    paneWidth,
  );
  await page.locator("#paper").click();
  assert.equal(await page.locator("#pages canvas").count(), 1);
  assert.equal(await page.locator("#print").isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ smoke: "passed", metrics, persisted, errors }, null, 2),
  );
} finally {
  await browser.close();
  server.close();
}
