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
  assert.equal((await zipDownload).suggestedFilename(), "conte-paper-png.zip");
  assert.match(await page.locator("#paperProgress").innerText(), /完了/);
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
  await page.locator("#zoom").fill("9");
  const save = page.waitForEvent("download");
  await page.locator("#save").click();
  assert.equal((await save).suggestedFilename(), "conte-paper.contb");
  // P1：画像取り込み。原本はAssetストアへ入り、プロジェクトはIDだけを持つ。
  await page.locator("#tree details").first().evaluate(el => el.open = true);
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

