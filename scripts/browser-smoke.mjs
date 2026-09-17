// Optional QA tools; not runtime dependencies. Install Playwright separately.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { serve } from "./serve.mjs";
// ZipBuilder（src/exporter.js）が書く終端レコードの並びに合わせて件数だけ読む。
// コメント無しの無圧縮ZIPなので、末尾22バイトの固定位置に総エントリ数がある。
async function zipEntryCount(download) {
  const buffer = await readFile(await download.path());
  return buffer.readUInt16LE(buffer.length - 12);
}
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
// テスト用の実WAV（16bit PCMのサイン波）。これも検証スクリプト内だけで使う。
function testWav(seconds = 3, rate = 22050, freq = 440) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(
      Math.round(Math.sin((i / rate) * freq * Math.PI * 2) * 12000),
      i * 2,
    );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const server = await serve(resolve("."), 0);
const browser = await chromium.launch({
  headless: true,
  // 音を含むAnimaticの録画を無人で走らせるため、自動再生の制限だけ外す。
  args: ["--autoplay-policy=no-user-gesture-required"],
  ...(process.env.CHROMIUM_EXECUTABLE
    ? {
        executablePath: process.env.CHROMIUM_EXECUTABLE,
        args: [
          "--no-sandbox",
          "--no-zygote",
          "--disable-dev-shm-usage",
          "--autoplay-policy=no-user-gesture-required",
        ],
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
  // 書き出し名はプロジェクト名から作るので、最初に名前を付けておく。
  await page.locator("#title").fill("conte-smoke");
  await page.locator("#title").blur();
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await page.mouse.move(700, 400, { steps: 10 });
  await page.mouse.up();
  // B7：直線ツール。ドラッグで1本のStrokeを1回のUndoで戻る量として足す。
  await page.locator("#lineTool").click();
  const drawBox = await page.locator("#drawing").boundingBox();
  const shapeProbe = () =>
    page.evaluate(() => [
      ...document
        .querySelector("#drawing")
        .getContext("2d")
        .getImageData(Math.round(1280 * 0.4), Math.round(720 * 0.6), 1, 1).data,
    ]);
  const beforeLine = await shapeProbe();
  await page.mouse.move(drawBox.x + drawBox.width * 0.2, drawBox.y + drawBox.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + drawBox.width * 0.6, drawBox.y + drawBox.height * 0.6);
  await page.mouse.up();
  assert.deepEqual(
    await shapeProbe(),
    [37, 41, 50, 255],
    "直線が描けていない",
  );
  await page.keyboard.press("Control+z");
  assert.deepEqual(await shapeProbe(), beforeLine, "Undo1回で直線が消えていない");
  await page.locator("#brushTool").click();
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
  // B8：プレゼンモード。Stageだけを見せるクラスの付け外しと、プレゼン中も
  // ←/→でPanelが進むことを確認する。
  const presentBreadcrumbBefore = await page.locator("#breadcrumb").innerText();
  await page.locator("#present").click();
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("presenting")),
    true,
    "プレゼンモードのクラスが付いていない",
  );
  assert.equal(await page.locator("nav").isVisible(), false, "プレゼン中もnavが見えている");
  assert.equal(await page.locator("#stage").isVisible(), true, "プレゼン中にStageが隠れている");
  await page.keyboard.press("ArrowLeft");
  assert.notEqual(
    await page.locator("#breadcrumb").innerText(),
    presentBreadcrumbBefore,
    "プレゼン中に矢印キーでPanelが進まない",
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("presenting")),
    false,
    "Escでプレゼンモードから戻れない",
  );
  assert.equal(await page.locator("nav").isVisible(), true, "戻ってもnavが見えない");
  await page.locator("#paper").click();
  assert.equal(await page.locator("#pages canvas").count(), 1);
  // D3：紙面プリセット。組み込みを選ぶと即座に用紙設定へ反映され、保存した分は
  // Dialogを閉じて開き直しても一覧に残る。
  const beforePreset = await page.evaluate(() => {
    const c = document.querySelector("#pages canvas");
    return [c.width, c.height];
  });
  await page.locator("#paperPreset").selectOption("builtin:簡易一覧");
  await page.waitForFunction(
    (before) => {
      const c = document.querySelector("#pages canvas");
      return c.width !== before[0] || c.height !== before[1];
    },
    beforePreset,
  );
  assert.deepEqual(
    await page.evaluate(() => {
      const c = document.querySelector("#pages canvas");
      return [c.width, c.height];
    }),
    [2480, 1754],
    "プリセット選択で用紙寸法が変わっていない（簡易一覧はA3横）",
  );
  await page.evaluate(() => {
    window.prompt = () => "私のプリセット";
  });
  await page.locator("#paperPresetSave").click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#paperPreset option")].some(
      (o) => o.value === "custom:私のプリセット",
    ),
  );
  await page.locator("#closePaper").click();
  await page.locator("#paper").click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#paperPreset option")].some(
      (o) => o.value === "custom:私のプリセット",
    ),
  );
  await page.locator("#paperPreset").selectOption("custom:私のプリセット");
  assert.equal(
    await page.locator("#paperPresetDelete").isDisabled(),
    false,
    "保存したプリセットを選んでも削除ボタンが有効にならない",
  );
  await page.locator("#paperPresetDelete").click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("#paperPreset option")].some(
        (o) => o.value === "custom:私のプリセット",
      ),
  );
  await page.locator("#paperPreset").selectOption("builtin:標準");
  await page.waitForFunction(() => {
    const c = document.querySelector("#pages canvas");
    return c.width === 1240 && c.height === 1754;
  });
  assert.equal(await page.locator("#print").isDisabled(), false);
  const png = page.waitForEvent("download");
  await page.locator("#png").click();
  assert.equal((await png).suggestedFilename(), "conte-smoke-png.zip");
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
  // P2：Timelineのコマを掴んで並べ替える。落とし先の印が出て、Undoで戻る。
  const clipOrder = async () =>
    (await page.locator(".clip").allInnerTexts()).map((t) =>
      t.split("·").at(-1).trim(),
    );
  const clipsBefore = await clipOrder();
  const firstClip = await page.locator(".clip").first().boundingBox();
  const lastClip = await page.locator(".clip").last().boundingBox();
  await page.mouse.move(firstClip.x + 20, firstClip.y + firstClip.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastClip.x + lastClip.width - 6, lastClip.y + 10, {
    steps: 10,
  });
  assert.equal(await page.locator(".drop").count(), 1, "落とし先の印が出ていない");
  await page.mouse.up();
  await page.waitForFunction(
    (was) =>
      document.querySelector(".clip")?.innerText.split("·").at(-1).trim() !==
      was,
    clipsBefore[0],
  );
  assert.deepEqual(await clipOrder(), [
    ...clipsBefore.slice(1),
    clipsBefore[0],
  ]);
  assert.equal(await page.locator(".drop").count(), 0, "印が残っている");
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("Control+z");
  assert.deepEqual(await clipOrder(), clipsBefore);
  // A1：左端（境界）ドラッグ。合計尺は変えず、前後のPanelだけ尺が動く。
  const clipFrames = async () =>
    (await page.locator(".clip").allInnerTexts()).map((t) =>
      Number(t.split("·").at(-1).trim().replace("f", "")),
    );
  const boundaryFramesBefore = await clipFrames();
  const boundaryTotalBefore = boundaryFramesBefore[0] + boundaryFramesBefore[1];
  const secondClip = await page.locator(".clip").nth(1).boundingBox();
  // 左端の.handle.startは境界(border-left 3px)の内側にある。+2だと境界自体（親の
  // button）に当たってしまうので、確実にhandle上に乗る位置を使う。
  await page.mouse.move(secondClip.x + 6, secondClip.y + secondClip.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondClip.x + 40, secondClip.y + secondClip.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForFunction(
    (was) => {
      const clips = [...document.querySelectorAll(".clip")];
      return Number(clips[0]?.innerText.split("·").at(-1).replace("f", "")) !== was;
    },
    boundaryFramesBefore[0],
  );
  const boundaryFramesAfter = await clipFrames();
  assert.equal(
    boundaryFramesAfter[0] + boundaryFramesAfter[1],
    boundaryTotalBefore,
    "境界ドラッグで合計尺が変わった",
  );
  assert.notEqual(
    boundaryFramesAfter[0],
    boundaryFramesBefore[0],
    "境界ドラッグが尺を動かしていない",
  );
  await page.keyboard.press("Control+z");
  assert.deepEqual(await clipFrames(), boundaryFramesBefore);
  // P1：選択だけの操作ではTreeのDOMを作り直さない（部分更新の契約）。
  // 尺のようにProjectが変わる操作では作り直す。
  const treeIdentity = async () =>
    page.evaluate(() => {
      const node = document.querySelector("#tree .panel");
      const same = window.__treeNode === node;
      window.__treeNode = node;
      return same;
    });
  await treeIdentity();
  await page.locator("#strip button").first().click();
  assert.equal(await treeIdentity(), true, "選択でTreeを作り直している");
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("ArrowRight");
  assert.equal(await treeIdentity(), true, "矢印キーでTreeを作り直している");
  await page.keyboard.press("]");
  assert.equal(await treeIdentity(), false, "尺の変更でTreeが更新されていない");
  await page.keyboard.press("Control+z");
  // P1：Panelのコピーと貼り付け。貼った分だけ増え、Undoで1段戻る。
  await page.evaluate(() => document.activeElement.blur());
  const panelsBefore = await page.locator("#strip button").count();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForFunction(
    (was) => document.querySelectorAll("#strip button").length === was + 1,
    panelsBefore,
  );
  assert.match(await page.locator("#status").innerText(), /貼り付け/);
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator("#strip button").count(), panelsBefore);
  // P1：オニオンスキン。前のコマの線が薄く重なり、切ると消える。
  const inked = () =>
    page.evaluate(() => {
      const c = document.querySelector("#drawing");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let marked = 0;
      for (let i = 0; i < d.length; i += 4)
        if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) marked++;
      return marked;
    });
  await page.locator("#strip button").nth(1).click();
  const plain = await inked();
  await page.keyboard.press("o");
  const ghosted = await inked();
  assert.ok(
    ghosted > plain + 200,
    `onion skin added only ${ghosted - plain} pixels`,
  );
  await page.keyboard.press("o");
  assert.equal(await inked(), plain, "オニオンスキンを切っても残っている");
  await page.locator("#strip button").nth(1).click();
  // P1：数値はドラッグでも変えられる（AEのホットテキスト）。1回のドラッグは
  // 1段のUndoで戻り、途中の値は履歴に積まれない。
  const framesBox = await page.locator("#frames").boundingBox();
  const framesBefore = Number(await page.locator("#frames").inputValue());
  await page.mouse.move(
    framesBox.x + framesBox.width / 2,
    framesBox.y + framesBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(framesBox.x + framesBox.width / 2 + 30, framesBox.y + 8, {
    steps: 6,
  });
  await page.mouse.up();
  await page.waitForFunction(
    (was) => Number(document.querySelector("#frames").value) > was,
    framesBefore,
  );
  const framesScrubbed = Number(await page.locator("#frames").inputValue());
  assert.equal(framesScrubbed, framesBefore + 10, "3pxで1フレーム進んでいない");
  // 反映先は選択中のPanelのクリップ。先頭のクリップとは限らない。
  assert.match(
    await page.locator(".clip.selected").first().innerText(),
    new RegExp(`${framesScrubbed}f`),
  );
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("Control+z");
  assert.equal(
    Number(await page.locator("#frames").inputValue()),
    framesBefore,
    "ドラッグ1回が1段のUndoで戻らない",
  );
  // A8：数値入力はフォーカス中だけホイールで刻む。フォーカスが無ければ
  // ページ側のスクロールを奪わない。
  const pageScrollBefore = await page.evaluate(() => window.scrollY);
  await page.locator("#frames").focus();
  await page.locator("#frames").hover();
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(
    (was) => Number(document.querySelector("#frames").value) > was,
    framesBefore,
  );
  assert.equal(
    Number(await page.locator("#frames").inputValue()),
    framesBefore + 1,
    "ホイール1目盛りで1段刻んでいない",
  );
  assert.equal(
    await page.evaluate(() => window.scrollY),
    pageScrollBefore,
    "フォーカス中のホイールでページが動いた",
  );
  await page.mouse.wheel(0, 100);
  assert.equal(Number(await page.locator("#frames").inputValue()), framesBefore);
  await page.evaluate(() => document.activeElement.blur());
  const beforeUnfocusedWheel = Number(
    await page.locator("#frames").inputValue(),
  );
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(50);
  assert.equal(
    Number(await page.locator("#frames").inputValue()),
    beforeUnfocusedWheel,
    "フォーカスが無いのに数値が変わった",
  );
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
  // P1：Scene追加はUIのボタン経路で確認する。生成したShotが検証を通らないと
  // 「不正なShot名」で編集が捨てられ、Sceneが増えないまま状態表示だけが変わる。
  const scenesBefore = await page.locator("#tree details").count();
  await page.locator('[data-tab="structure"]').click();
  await page.locator('[data-act="scene"]').click();
  assert.equal(
    await page.locator("#tree details").count(),
    scenesBefore + 1,
    `Scene追加が失敗した：${await page.locator("#status").innerText()}`,
  );
  assert.match(await page.locator("#breadcrumb").innerText(), /シーン02/);
  // A6：新しいSceneを開いたまま、1つ目のPanelを選んでも閉じないこと。
  assert.equal(await page.locator("#tree details").nth(0).evaluate((d) => d.open), true);
  assert.equal(await page.locator("#tree details").nth(1).evaluate((d) => d.open), true);
  await page.locator("#tree details").nth(0).locator("button.panel").first().click();
  assert.match(await page.locator("#breadcrumb").innerText(), /オープニング/);
  assert.equal(await page.locator("#tree details").nth(0).evaluate((d) => d.open), true);
  assert.equal(
    await page.locator("#tree details").nth(1).evaluate((d) => d.open),
    true,
    "選択で戻っても2つ目のSceneが閉じてしまった",
  );
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator("#tree details").count(), scenesBefore);
  assert.match(await page.locator("#breadcrumb").innerText(), /オープニング/);
  await page.locator('[data-tab="content"]').click();
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
  // A9：行の高さ切り替え。数値はカスタムプロパティ1か所から出るので、
  // 大きさを変えても行名の列とTimeline本体の帯がずれてはいけない。
  const rowMetrics = () =>
    page.evaluate(() => {
      const trackTop = document.querySelector("#track").getBoundingClientRect().top;
      const rel = (sel) =>
        +(document.querySelector(sel).getBoundingClientRect().top - trackTop).toFixed(2);
      return {
        clip: rel(".clip"),
        rowNameClips: rel(".rowName.clips"),
        camera: rel("#cameraTrack"),
        rowNameCamera: rel(".rowName.camera"),
        cameraHeight: document.querySelector("#cameraTrack").getBoundingClientRect().height,
      };
    });
  const mdMetrics = await rowMetrics();
  assert.equal(mdMetrics.clip, mdMetrics.rowNameClips, "中：コマの帯と行名がずれている");
  assert.equal(mdMetrics.camera, mdMetrics.rowNameCamera, "中：Cameraの帯と行名がずれている");
  await page.locator("#rowSize").selectOption("lg");
  const lgMetrics = await rowMetrics();
  assert.equal(lgMetrics.clip, lgMetrics.rowNameClips, "大：コマの帯と行名がずれている");
  assert.equal(lgMetrics.camera, lgMetrics.rowNameCamera, "大：Cameraの帯と行名がずれている");
  assert.ok(lgMetrics.cameraHeight > mdMetrics.cameraHeight, "大で行が高くなっていない");
  await page.locator("#rowSize").selectOption("sm");
  const smMetrics = await rowMetrics();
  assert.equal(smMetrics.clip, smMetrics.rowNameClips, "小：コマの帯と行名がずれている");
  assert.equal(smMetrics.camera, smMetrics.rowNameCamera, "小：Cameraの帯と行名がずれている");
  assert.ok(smMetrics.cameraHeight < mdMetrics.cameraHeight, "小で行が低くなっていない");
  // 以降の座標に基づくテストへ影響しないよう、既定の「中」へ戻しておく。
  await page.locator("#rowSize").selectOption("md");
  // B2：台詞・注記の検索。Ctrl+Fはテキスト入力中でも開き、選ぶとそのPanelへ
  // ジャンプする。Escで閉じる。
  await page.locator("#dialogue").fill("検索テスト用の台詞ひとつめ");
  await page.locator("#dialogue").blur();
  await page.keyboard.press("n");
  await page.locator("#dialogue").fill("検索テスト用の台詞ふたつめ");
  await page.locator("#dialogue").blur();
  assert.equal(await page.locator("#search").isHidden(), true, "検索窓が最初から開いている");
  await page.keyboard.press("Control+f");
  assert.equal(await page.locator("#search").isVisible(), true, "Ctrl+Fで検索窓が開かない");
  assert.equal(await page.evaluate(() => document.activeElement.id), "searchQuery");
  await page.locator("#searchQuery").fill("検索テスト用の台詞");
  await page.waitForTimeout(30);
  assert.equal(await page.locator(".searchHit").count(), 2, "2件見つかるはず");
  assert.match(await page.locator("#searchStatus").innerText(), /2件/);
  const searchBreadcrumbBefore = await page.locator("#breadcrumb").innerText();
  await page.locator(".searchHit").first().click();
  assert.notEqual(
    await page.locator("#breadcrumb").innerText(),
    searchBreadcrumbBefore,
    "検索結果を選んでもジャンプしない",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#search").isHidden(), true, "Escで閉じない");
  // 台詞入力中でもCtrl+Fは効く（ブラウザ標準の検索を横取りする必要があるため）。
  await page.locator("#dialogue").click();
  await page.keyboard.press("Control+f");
  assert.equal(await page.locator("#search").isVisible(), true, "台詞入力中はCtrl+Fが効かない");
  await page.keyboard.press("Escape");
  // P2：fps目盛、選択範囲の表示、Cameraキーの追加/移動/削除とUndo。
  const ticks = await page.locator("#ruler .tick").allInnerTexts();
  assert.ok(ticks.length > 1, "ruler has no ticks");
  assert.ok(
    ticks.every((t) => /^\d+s(\d+f)?$/.test(t)),
    `unexpected tick labels ${ticks.join(",")}`,
  );
  await page.locator("#strip button").first().click();
  await page
    .locator("#strip button")
    .nth(2)
    .click({ modifiers: ["Shift"] });
  assert.match(await page.locator("#range").innerText(), /選択 3 Panel/);
  await page.locator("#strip button").first().click();
  await page.locator('[data-tab="camera"]').click();
  assert.match(await page.locator("#cameraSummary").innerText(), /HOLD/);
  const trackBox = await page.locator("#track").boundingBox();
  const keysBefore = await page.locator(".camkey").count();
  // 再生ヘッドのあるPanelへキーを置き、値を変えるとCameraの動きとして要約される。
  await page.mouse.click(trackBox.x + 40, trackBox.y + 8);
  await page.locator("#key").click();
  assert.equal(await page.locator(".camkey").count(), keysBefore + 1);
  await page.locator("#cz").fill("2");
  await page.locator("#cz").press("Enter");
  assert.match(await page.locator("#cameraSummary").innerText(), /ZOOM IN/);
  // A2：Cameraの数値をドラッグしている間、Stageに枠のプレビューが出る。
  // 離すと消え、1回のドラッグは1段のUndoで戻る。
  const overlayColor = () =>
    page.evaluate(() => {
      const c = document.querySelector("#drawing");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4)
        if (d[i] === 224 && d[i + 1] === 160 && d[i + 2] === 106) return true;
      return false;
    });
  assert.equal(await overlayColor(), false, "ドラッグ前から枠が出ている");
  const zoomBefore = await page.locator("#cz").inputValue();
  const czBox = await page.locator("#cz").boundingBox();
  await page.mouse.move(czBox.x + czBox.width / 2, czBox.y + czBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    czBox.x + czBox.width / 2 + 60,
    czBox.y + czBox.height / 2,
    { steps: 8 },
  );
  await page.waitForFunction(() => {
    const c = document.querySelector("#drawing");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] === 224 && d[i + 1] === 160 && d[i + 2] === 106) return true;
    return false;
  });
  await page.mouse.up();
  assert.equal(await overlayColor(), false, "ドラッグを離しても枠が残っている");
  assert.notEqual(
    await page.locator("#cz").inputValue(),
    zoomBefore,
    "ドラッグでズームが変わっていない",
  );
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("Control+z");
  assert.equal(
    await page.locator("#cz").inputValue(),
    zoomBefore,
    "ドラッグ1回が1段のUndoで戻らない",
  );
  // ここでredoはしない。次のCameraキー移動が新しい編集としてfutureを
  // 消すので、以降の履歴段数は元のテストのままになる。
  const dot = page.locator(".lane.active .camkey").last();
  const dotBox = await dot.boundingBox();
  const keyBefore = await page.locator("#keyList option").nth(1).innerText();
  await page.mouse.move(dotBox.x + 6, dotBox.y + 6);
  await page.mouse.down();
  await page.mouse.move(dotBox.x + 60, dotBox.y + 6, { steps: 8 });
  await page.mouse.up();
  // ドラッグしたキーは時刻が変わり、Inspectorの一覧もその位置を指す。
  await page.waitForFunction(
    (was) => document.querySelector("#keyList").options[1]?.textContent !== was,
    keyBefore,
  );
  await page.locator("#keyDelete").click();
  assert.equal(await page.locator(".camkey").count(), keysBefore);
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator(".camkey").count(), keysBefore + 1);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator(".camkey").count(), keysBefore);
  // A10：Cameraキーの複数選択。Shiftクリックで追加、矩形ドラッグでもまとめて
  // 選べる。選択している1本をドラッグすると選択全部が同じ量だけ動く。
  // レーンのダブルクリックはそのPanel自身へキーを置くので、再生ヘッドの
  // 位置に関係なく確実にアクティブなPanelへ2本追加できる。
  const seedLane = await page.locator(".lane.active").boundingBox();
  await page.mouse.click(
    seedLane.x + seedLane.width * 0.3,
    seedLane.y + seedLane.height / 2,
    { clickCount: 2 },
  );
  await page.mouse.click(
    seedLane.x + seedLane.width * 0.7,
    seedLane.y + seedLane.height / 2,
    { clickCount: 2 },
  );
  assert.equal(await page.locator(".camkey").count(), keysBefore + 2);
  const camDots = page.locator(".lane.active .camkey");
  const titleOf = (i) => camDots.nth(i).getAttribute("title");
  const [f0, f1, f2] = await Promise.all([titleOf(0), titleOf(1), titleOf(2)]);
  // .camkeyは45度回転した菱形。当たり判定はbounding boxの中心を使う
  // （角は菱形の外に出るので、隅をクリックするとレーンの背景に抜ける）。
  const centerOf = async (locator) => {
    const box = await locator.boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const c0 = await centerOf(camDots.nth(0));
  const c1 = await centerOf(camDots.nth(1));
  await page.mouse.click(...c0);
  await page.keyboard.down("Shift");
  await page.mouse.click(...c1);
  await page.keyboard.up("Shift");
  assert.deepEqual(
    await camDots.evaluateAll((els) =>
      els.map((el) => el.classList.contains("selected")),
    ),
    [true, true, false],
    "Shiftクリックで2本目まで選ばれていない",
  );
  await page.mouse.move(...c1);
  await page.mouse.down();
  await page.mouse.move(c1[0] + 30, c1[1]);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const [g0, g1, g2] = await Promise.all([titleOf(0), titleOf(1), titleOf(2)]);
  assert.notEqual(g0, f0, "選択している1本目も一緒に動くべき");
  assert.notEqual(g1, f1, "掴んだ2本目が動くべき");
  assert.equal(g2, f2, "選んでいない3本目は動かないべき");
  await page.keyboard.press("Control+z");
  // 矩形ドラッグ：レーンの何もない場所からドラッグすると範囲内のキーを選べる。
  // .camkeyは行の中央に置かれるので、上端に寄せてダイヤの当たり判定を避ける。
  // 1本目（t=0）はレーンの起点そのものにあるので、その手前からではなく
  // 1本目と2本目の間から始めて2・3本目だけを範囲に入れる。
  const activeLaneBox = await page.locator(".lane.active").boundingBox();
  await page.mouse.move(
    activeLaneBox.x + activeLaneBox.width * 0.15,
    activeLaneBox.y + 2,
  );
  await page.mouse.down();
  await page.mouse.move(activeLaneBox.x + activeLaneBox.width - 2, activeLaneBox.y + 2);
  await page.mouse.up();
  assert.deepEqual(
    await camDots.evaluateAll((els) =>
      els.map((el) => el.classList.contains("selected")),
    ),
    [false, true, true],
    "矩形ドラッグで範囲内の2・3本目が選ばれていない",
  );
  // 後始末：矩形選択した2・3本目をそのまま消してkeysBeforeへ戻す。
  await page.locator("#keyDelete").click();
  assert.equal(await page.locator(".camkey").count(), keysBefore);
  // P3：音声を置き、波形・移動・再生・二重再生防止・同期のずれを確認する。
  await page.locator('[data-tab="sound"]').click();
  await page.locator("#audioFile").setInputFiles({
    name: "tone.wav",
    mimeType: "audio/wav",
    buffer: testWav(3),
  });
  await page.waitForFunction(
    () => document.querySelectorAll(".sound").length === 1,
  );
  assert.equal(await page.locator(".sound canvas").count(), 1, "no waveform");
  assert.match(await page.locator("#clipInfo").innerText(), /3\.00秒/);
  // A3：音クリップの端もスナップ候補になる。境界ドラッグが音クリップの終端へ
  // 吸着すると案内線が出て、離すとその位置で確定する。
  await page.locator('[data-tab="structure"]').click();
  const soundEdge = (await page.locator(".sound").boundingBox()).x +
    (await page.locator(".sound").boundingBox()).width;
  const firstClipHandle = await page
    .locator(".clip")
    .first()
    .locator(".handle.end")
    .boundingBox();
  await page.mouse.move(
    firstClipHandle.x + firstClipHandle.width / 2,
    firstClipHandle.y + firstClipHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(soundEdge - 2, firstClipHandle.y + firstClipHandle.height / 2, {
    steps: 8,
  });
  assert.equal(
    await page.evaluate(() => !document.querySelector("#snapline").hidden),
    true,
    "音クリップの端で案内線が出ていない",
  );
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => document.querySelector("#snapline").hidden),
    true,
    "ドラッグを離しても案内線が残っている",
  );
  assert.match(await page.locator(".clip").first().innerText(), /72f/);
  await page.keyboard.press("Control+z");
  await page.locator('[data-tab="sound"]').click();
  const clipBefore = await page.locator("#clipList option").first().innerText();
  const clipBox = await page.locator(".sound").first().boundingBox();
  await page.mouse.move(clipBox.x + 20, clipBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(clipBox.x + 70, clipBox.y + 10);
  await page.mouse.move(clipBox.x + 120, clipBox.y + 10);
  await page.mouse.up();
  await page.waitForFunction(
    (was) =>
      document.querySelector("#clipList option")?.textContent !== was &&
      document.querySelector("#clipList option"),
    clipBefore,
  );
  // 音を置いたPanelを消すと音も消え、Undoで一緒に戻る。
  const clipTitle = await page.locator("#clipList option").first().innerText();
  await page.locator('[data-tab="structure"]').click();
  await page.locator('[data-act="delete"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll(".sound").length === 0,
  );
  await page.keyboard.press("Control+z");
  await page.waitForFunction(
    () => document.querySelectorAll(".sound").length === 1,
  );
  await page.locator('[data-tab="sound"]').click();
  assert.equal(
    await page.locator("#clipList option").first().innerText(),
    clipTitle,
  );
  // 同期：音声時計を基準に進むので、実時間とのずれをフレーム数で記録する。
  const sync = await page.evaluate(async () => {
    const parse = () => {
      const [s, f] = document
        .querySelector("#time")
        .textContent.split(":")
        .map((v) => parseInt(v, 10));
      return s * 24 + f;
    };
    document.querySelector("#play").click();
    const started = performance.now(),
      from = parse();
    // 連打しても二重に鳴らさないことを確かめるため、止めて掛け直す。
    document.querySelector("#play").click();
    document.querySelector("#play").click();
    await new Promise((r) => setTimeout(r, 4000));
    const ran = (performance.now() - started) / 1000;
    const reached = parse();
    document.querySelector("#play").click();
    return {
      seconds: +ran.toFixed(2),
      advanced: reached - from,
      driftFrames: +(reached - from - ran * 24).toFixed(1),
    };
  });
  assert.ok(sync.advanced > 24, `playback advanced ${sync.advanced} frames`);
  assert.ok(
    Math.abs(sync.driftFrames) < 12,
    `audio clock drifted ${sync.driftFrames} frames in ${sync.seconds}s`,
  );
  // B3：範囲再生・Shotループ。複数Panelを選んでからループを付けると、その
  // 範囲だけを再生して先頭へ戻り続ける（=ループしていなければ範囲の終わりで
  // 止まるはずの時間を過ぎても再生を続けている）。
  await page.locator('[data-tab="structure"]').click();
  await page.locator("#strip button").first().click();
  await page.locator("#strip button").nth(1).click({ modifiers: ["Shift"] });
  assert.match(await page.locator("#range").innerText(), /選択 2 Panel/);
  await page.locator("#loop").check();
  const loopResult = await page.evaluate(async () => {
    document.querySelector("#play").click();
    await new Promise((r) => setTimeout(r, 6000));
    const stillPlaying = document
      .querySelector("#play")
      .textContent.includes("停止");
    document.querySelector("#play").click();
    return { stillPlaying };
  });
  assert.equal(loopResult.stillPlaying, true, "ループが効かず途中で止まってしまった");
  await page.locator("#loop").uncheck();
  await page.locator("#strip button").first().click();
  // P5：Animatic出力。フレーム厳密なPNG連番と、音つきWebMの実録画。
  await page.locator("#animatic").click();
  const animaticInfo = await page.locator("#animaticInfo").innerText();
  assert.match(animaticInfo, /フレーム/);
  await page.locator("#animaticFormat").selectOption("frames");
  await page.locator("#animaticFps").selectOption("8");
  await page.locator("#animaticSize").selectOption("480p");
  const framesZip = page.waitForEvent("download");
  await page.locator("#animaticStart").click();
  assert.match((await framesZip).suggestedFilename(), /-animatic\.zip$/);
  assert.match(
    await page.locator("#animaticProgress").innerText(),
    /書き出しました/,
  );
  // WebM：録画したファイルを再生して、尺・音・絵の切り替わりを確かめる。
  // 録画したファイルを調べたいので、この間だけダウンロードを横取りする。
  await page.evaluate(() => {
    window.__captured = null;
    window.__realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith("blob:")) {
        window.__captured = this.href;
        return;
      }
      return window.__realClick.call(this);
    };
  });
  await page.locator("#animaticFormat").selectOption("webm");
  await page.locator("#animaticFps").selectOption("24");
  const expected = Number(
    (await page.locator("#animaticInfo").innerText()).match(/([\d.]+)秒/)[1],
  );
  await page.locator("#animaticStart").click();
  await page.waitForFunction(() => window.__captured, null, { timeout: 90000 });
  const animatic = await page.evaluate(async (expectedSeconds) => {
    const blob = await (await fetch(window.__captured)).blob();
    const out = { bytes: blob.size };
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    let peak = 0;
    for (const v of buffer.getChannelData(0))
      peak = Math.max(peak, Math.abs(v));
    out.audio = {
      seconds: +buffer.duration.toFixed(2),
      peak: +peak.toFixed(3),
    };
    const video = document.createElement("video");
    video.src = window.__captured;
    video.muted = true;
    await new Promise((r) => (video.onloadedmetadata = r));
    video.currentTime = 1e6;
    await new Promise((r) => (video.onseeked = r));
    out.seconds = +video.duration.toFixed(2);
    out.size = [video.videoWidth, video.videoHeight];
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const c = canvas.getContext("2d");
    const darkAt = async (t) => {
      video.currentTime = t;
      await new Promise((r) => (video.onseeked = r));
      c.drawImage(video, 0, 0);
      const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 150) dark++;
      return dark;
    };
    out.first = await darkAt(Math.min(0.4, expectedSeconds / 4));
    out.later = await darkAt(expectedSeconds * 0.8);
    out.drift = +(out.seconds - expectedSeconds).toFixed(2);
    return out;
  }, expected);
  assert.deepEqual(animatic.size, [854, 480]);
  // 実時間の録画なので、予約リードと停止の後始末のぶんだけ長くなる。
  // どれだけ長いかは数値で出し、大きくずれたときだけ失敗させる。
  assert.ok(
    animatic.drift >= -0.2 && animatic.drift < 0.8,
    `recorded ${animatic.seconds}s for a ${expected}s project`,
  );
  assert.ok(animatic.audio.peak > 0.01, "the recording carries no audio");
  // 音声トラックの長さは鳴っている区間に依存する（末尾の無音は詰められる）。
  // 長さそのものは記録に留め、音が入っていることと絵の尺だけを条件にする。
  animatic.expected = expected;
  animatic.audioDrift = +(animatic.audio.seconds - expected).toFixed(2);
  assert.ok(animatic.first > 0, "the first panel is blank in the recording");
  assert.notEqual(
    animatic.first,
    animatic.later,
    "the recording never changes panel",
  );
  // 横取りを戻す。以降のダウンロードは普通に保存されるようにする。
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click = window.__realClick;
  });
  await page.locator("#closeAnimatic").click();
  await page.locator('[data-tab="content"]').click();
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
  // A6：Project差し替えでは開いていたSceneの記憶が消え、アクティブなSceneだけ開く。
  assert.deepEqual(
    await page.locator("#tree details").evaluateAll((els) => els.map((d) => d.open)),
    [true, false, false, false, false],
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
  // P4：用紙設定・長文の続き・PNGのZIPまとめ。
  // 読み込んだプロジェクトには元の名前が入っているので、付け直してから書き出す。
  await page.locator("#title").fill("conte-paper");
  await page.locator("#title").blur();
  await page.locator("#dialogue").fill("セリフ：" + "あいうえお、".repeat(40));
  await page.locator("#dialogue").blur();
  await page.locator("#paper").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("ページ"),
  );
  const a4 = await page.evaluate(() => {
    const c = document.querySelector("#pages canvas");
    return [c.width, c.height];
  });
  assert.deepEqual(a4, [1240, 1754]);
  await page.locator("#paperSettings select").first().selectOption("A3");
  await page.waitForFunction(
    () => document.querySelector("#pages canvas").width === 1754,
  );
  await page.locator("#paperSettings select").nth(1).selectOption("landscape");
  await page.waitForFunction(
    () => document.querySelector("#pages canvas").height === 1754,
  );
  await page.locator("#paperSettings select").first().selectOption("A4");
  await page.locator("#paperSettings select").nth(1).selectOption("portrait");
  await page.waitForFunction(
    () => document.querySelector("#pages canvas").width === 1240,
  );
  // 長文は切れずに続き行へ送られる。
  assert.match(await page.locator("#status").innerText(), /続き行 [1-9]/);
  const zipDownload = page.waitForEvent("download");
  await page.locator("#png").click();
  const zip = await zipDownload;
  assert.equal(zip.suggestedFilename(), "conte-paper-png.zip");
  const paperDone = await page.locator("#paperProgress").innerText();
  assert.match(paperDone, /完了/);
  // D2：1ページずつZipBuilderへ足すので、書き出したファイル数は最終ページ数と一致する。
  const pageTotal = Number(paperDone.match(/完了（(\d+)ページ）/)[1]);
  assert.equal(await zipEntryCount(zip), pageTotal);
  // D4：共有用HTML。埋め込んだページ画像の枚数が紙面のページ数と一致すること。
  const shareDownload = page.waitForEvent("download");
  await page.locator("#shareHtml").click();
  const shareFile = await shareDownload;
  assert.match(shareFile.suggestedFilename(), /-share\.html$/);
  assert.match(await page.locator("#paperProgress").innerText(), /完了/);
  const shareHtml = await readFile(await shareFile.path(), "utf8");
  const imgCount = (shareHtml.match(/<img class="page"/g) || []).length;
  assert.equal(
    imgCount,
    pageTotal,
    "共有用HTMLに埋め込まれたページ数が紙面のページ数と一致しない",
  );
  await page.locator("#closePaper").click();
  // P2：500 Panelでも生成するクリップは画面分だけ。全体表示と境界スクラブも確認する。
  const clipCount = await page.locator(".clip").count();
  assert.ok(clipCount < 40, `laid out ${clipCount} clips for 500 panels`);
  await page.locator("#fitTime").click();
  assert.ok(
    (await page.locator(".clip").count()) < 520,
    "fit must not explode the DOM",
  );
  await page.locator("#zoom").fill("9");
  const boundary = await page.evaluate(() => {
    // 48フレーム目ちょうどは次のPanelの先頭。境界で絵が入れ替わる。
    const track = document.querySelector("#track");
    const box = track.getBoundingClientRect();
    // Altを押した操作はスナップしない。押さなければ境界へ吸着する。
    const at = (frame, altKey) => {
      const event = (type) =>
        new PointerEvent(type, {
          clientX: box.left + frame * 3,
          clientY: box.top + 8,
          bubbles: true,
          pointerId: 1,
          altKey,
        });
      track.dispatchEvent(event("pointerdown"));
      track.dispatchEvent(event("pointerup"));
      return document.querySelector("#time").textContent;
    };
    return { snapped: at(47, false), before: at(47, true), on: at(48, true) };
  });
  assert.equal(boundary.snapped, "2s : 00f");
  assert.equal(boundary.before, "1s : 23f");
  assert.equal(boundary.on, "2s : 00f");
  // 再生ヘッド追従：端に近い位置から再生するとTimelineが自分で送られる。
  await page.locator("#zoom").fill("15");
  const width = await page.evaluate(
    () => document.querySelector("#timeline").clientWidth,
  );
  await page.mouse.click(trackBox.x + width - 60, trackBox.y + 8);
  const scrolledBefore = await page.evaluate(
    () => document.querySelector("#timeline").scrollLeft,
  );
  await page.locator("#play").click();
  await page.waitForFunction(
    (was) => document.querySelector("#timeline").scrollLeft > was,
    scrolledBefore,
    { timeout: 5000 },
  );
  await page.locator("#play").click();
  // A4：ドラッグ中に端へ寄せると、見えている範囲の外までStripが自動で送られる。
  await page.evaluate(() => (document.querySelector("#strip").scrollLeft = 0));
  const stripBoxAuto = await page.locator("#strip").boundingBox();
  const firstStripBtn = await page.locator("#strip button").first().boundingBox();
  await page.mouse.move(
    firstStripBtn.x + firstStripBtn.width / 2,
    firstStripBtn.y + firstStripBtn.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    firstStripBtn.x + firstStripBtn.width / 2 + 20,
    firstStripBtn.y + firstStripBtn.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(
    stripBoxAuto.x + stripBoxAuto.width - 10,
    firstStripBtn.y + firstStripBtn.height / 2,
    { steps: 2 },
  );
  await page.waitForFunction(
    () => document.querySelector("#strip").scrollLeft > 0,
  );
  await page.mouse.up();
  const scrollAtRelease = await page.evaluate(
    () => document.querySelector("#strip").scrollLeft,
  );
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => document.querySelector("#strip").scrollLeft),
    scrollAtRelease,
    "ドラッグを離した後も自動スクロールが止まっていない",
  );
  await page.locator("#zoom").fill("9");
  const save = page.waitForEvent("download");
  await page.locator("#save").click();
  assert.equal((await save).suggestedFilename(), "project.contp");
  // P1：画像取り込み。原本はAssetストアへ入り、プロジェクトはIDだけを持つ。
  // A6でSceneの開閉を記憶するようになったので、summaryのクリック（トグル）では
  // なく直接openを立てて開く。既に開いていてもここでは閉じてはいけない。
  await page.locator("#tree details").first().evaluate((d) => (d.open = true));
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
  // B5：画像の差し替え。既に画像があるPanelへ別の画像を選ぶと、参照だけ新しい
  // Asset IDへ付け替わり、使われなくなった元の画像メタデータは消える。
  await page.locator("#imageFile").setInputFiles({
    name: "bg2.png",
    mimeType: "image/png",
    buffer: testPng(8, 8, [60, 200, 90]),
  });
  await page.waitForFunction(() =>
    document.querySelector("#assetInfo").textContent.includes("bg2.png"),
  );
  assert.doesNotMatch(
    await page.locator("#assetInfo").innerText(),
    /bg\.png/,
    "差し替えたはずの古い画像名がまだ出ている",
  );
  assert.deepEqual(
    await page.evaluate(() => [
      ...document
        .querySelector("#drawing")
        .getContext("2d")
        .getImageData(900, 200, 1, 1).data,
    ]),
    [60, 200, 90, 255],
    "差し替えた画像が反映されていない",
  );
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() =>
    document.querySelector("#assetInfo").textContent.includes("bg.png") &&
    !document.querySelector("#assetInfo").textContent.includes("bg2.png"),
  );
  assert.deepEqual(
    await page.evaluate(() => [
      ...document
        .querySelector("#drawing")
        .getContext("2d")
        .getImageData(900, 200, 1, 1).data,
    ]),
    [200, 90, 60, 255],
    "Undoで元の画像へ戻っていない",
  );
  // A9：行の高さはlayoutと同じ仕組み（IndexedDbのmeta）で持つので、
  // 再起動をまたいで保たれる。
  await page.locator("#rowSize").selectOption("lg");
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
  // 復旧で読み直した素材はサムネイルにも出る（部分更新で取りこぼさない）。
  // 対角線の線と重ならない位置を見る。画像は横26..94・縦0..68に収まる。
  await page.waitForFunction(() => {
    const c = document.querySelector("#strip canvas");
    if (!c) return false;
    const [r, g, b] = c.getContext("2d").getImageData(80, 18, 1, 1).data;
    return r > 150 && g < 150 && b < 120;
  });
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--tree")
        .trim(),
    ),
    paneWidth,
  );
  // A9：再起動後も「大」のまま。以降のテストへ影響しないよう既定へ戻す。
  assert.equal(await page.locator("#rowSize").inputValue(), "lg");
  await page.locator("#rowSize").selectOption("md");
  // B9：保存履歴から選んで復元。世代Aは直前の自動復旧で戻した状態、
  // ここでもう1コマ足して世代Bを作り、履歴一覧から世代Aへ戻せることを確かめる。
  const genA = persisted.panels;
  await page.evaluate(async () => {
    document.activeElement.blur();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
    while (!document.querySelector("#savestate").textContent.startsWith("ブラウザに保存"))
      await new Promise((r) => setTimeout(r, 50));
  });
  const genB = await page.evaluate(
    () => document.querySelectorAll("#tree .panel").length,
  );
  assert.equal(genB, genA + 1, "世代Bの生成に失敗している");
  await page.locator("#history").click();
  await page.waitForSelector("#recoverDialog[open]");
  assert.equal(await page.locator("#recoverInfo").isHidden(), true);
  await page.waitForFunction(
    () => document.querySelectorAll("#recoverHistory .recoverRow").length >= 2,
  );
  const rowA = page.locator("#recoverHistory .recoverRow", {
    hasText: new RegExp(`／ ${genA} Panel ／`),
  });
  await rowA.first().click();
  await page.waitForFunction(
    (n) => document.querySelectorAll("#tree .panel").length === n,
    genA,
  );
  assert.equal(await page.locator("#recoverDialog").isVisible(), false);
  assert.match(await page.locator("#status").innerText(), /復元しました/);
  // P4：500 Panelでもプレビューが返り、出力は途中で止められる。
  const paperStart = Date.now();
  await page.locator("#paper").click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent.includes("ページ"),
    null,
    { timeout: 30000 },
  );
  const paperReady = Date.now() - paperStart;
  assert.equal(await page.locator("#pages canvas").count(), 1);
  assert.equal(await page.locator("#print").isDisabled(), false);
  await page.locator("#png").click();
  // 0ページ目の表示ではなく、1ページ以上できた時点を待つ。
  await page.waitForFunction(() =>
    /[1-9]\d* \/ \d+/.test(
      document.querySelector("#paperProgress").textContent,
    ),
  );
  const partial = await page.locator("#paperProgress").innerText();
  await page.locator("#cancelExport").click();
  await page.waitForFunction(() =>
    document.querySelector("#paperProgress").textContent.includes("中止"),
  );
  const cancelled = Number(partial.match(/(\d+) \//)?.[1] ?? 0);
  assert.ok(cancelled > 0, "cancel happened before any page was rendered");
  assert.ok(
    cancelled < Number(partial.match(/\/ (\d+)/)?.[1] ?? 0),
    "cancel did not stop the export",
  );
  await page.locator("#closePaper").click();
  // P3：素材のない音声クリップを差し替える。原本を上書きせず新しいIDを作るので、
  // Undoで「素材が見つからない」状態へ戻る。
  const orphan = project();
  orphan.title = "missing-audio";
  const lost = uid();
  orphan.assets.push({
    id: lost,
    kind: "audio",
    name: "lost.wav",
    mime: "audio/wav",
    bytes: 2048,
  });
  orphan.audio.push({
    id: uid(),
    assetId: lost,
    track: "se",
    anchor: orphan.scenes[0].shots[0].panels[0].id,
    at: 0,
    frames: 24,
    offset: 0,
    gain: 1,
  });
  await page.locator("#file").setInputFiles({
    name: "missing-audio.contp",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(orphan)),
  });
  await page.waitForFunction(
    () => document.querySelector("#title").value === "missing-audio",
  );
  await page.locator('[data-tab="sound"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#clipInfo").textContent.includes("見つかりません"),
  );
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#clipRepair").click();
  await (
    await chooser
  ).setFiles({
    name: "replaced.wav",
    mimeType: "audio/wav",
    buffer: testWav(2, 22050, 880),
  });
  await page.waitForFunction(() =>
    document.querySelector("#clipInfo").textContent.includes("replaced.wav"),
  );
  assert.match(await page.locator("#clipInfo").innerText(), /2\.00秒/);
  assert.equal(await page.locator(".sound canvas").count(), 1);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() =>
    document.querySelector("#clipInfo").textContent.includes("見つかりません"),
  );
  // E1：保存を止めない（分割シリアライズ）。2000 Panel（各10Stroke×50点つき）を
  // 読み込んで自動保存させ、その間も描画（rAF）が進み続けること、長タスクの
  // 最大値を記録する。
  const { project: mkProject, panel: mkPanel, uid: mkUid, BRUSH: mkBrush } =
    await import("../src/model.js");
  const heavy = mkProject();
  heavy.scenes = Array.from({ length: 20 }, (_, si) => ({
    id: mkUid(),
    name: `Scene ${si + 1}`,
    shots: [
      {
        id: mkUid(),
        name: "",
        panels: Array.from({ length: 100 }, () => ({
          ...mkPanel(),
          strokes: Array.from({ length: 10 }, () => ({
            size: mkBrush.default,
            erase: false,
            points: Array.from({ length: 50 }, (_, i) => [i / 50, i / 50, 1]),
          })),
        })),
      },
    ],
  }));
  await page.locator("#file").setInputFiles({
    name: "2000.contp",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(heavy)),
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#tree .panel").length === 2000,
  );
  const e1 = await page.evaluate(async () => {
    let frames = 0,
      running = true;
    const tick = () => {
      frames++;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let maxLongTask = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        maxLongTask = Math.max(maxLongTask, entry.duration);
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long Tasks APIが無い環境でも、rAFの進み具合だけで応答性は確認できる。
    }
    document.activeElement.blur();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
    const text = () => document.querySelector("#savestate").textContent;
    while (!text().startsWith("ブラウザに保存"))
      await new Promise((r) => setTimeout(r, 20));
    running = false;
    observer.disconnect();
    return { frames, maxLongTask: +maxLongTask.toFixed(1) };
  });
  assert.ok(
    e1.frames > 3,
    `2000 Panelの自動保存中に描画が止まった（rAFが${e1.frames}回しか進まなかった）`,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        smoke: "passed",
        metrics,
        persisted,
        sync,
        paperReady,
        animatic,
        e1,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.close();
}
