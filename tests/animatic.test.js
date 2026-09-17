import { test } from "node:test";
import assert from "node:assert/strict";
import {
  plan,
  evaluate,
  outputName,
  recordingProgress,
  pickMime,
  RESOLUTIONS,
  FORMATS,
} from "../src/animatic.js";
import {
  project,
  panel,
  flatten,
  setCameraKey,
  cameraAt,
} from "../src/model.js";
const rowsOf = (count = 2, frames = 48) => {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: count }, () => ({
    ...panel(),
    frames,
  }));
  return flatten(p);
};
test("the plan maps output frames onto project time at any fps", () => {
  const spec = plan(0, 240, 24, 12, "480p");
  assert.equal(spec.seconds, 10);
  assert.equal(spec.frames, 120);
  assert.deepEqual([spec.width, spec.height], RESOLUTIONS["480p"]);
  assert.equal(spec.sourceFrame(0), 0);
  // 出力12fpsの60枚目は、プロジェクト24fpsの120フレーム目＝同じ時刻。
  assert.equal(spec.sourceFrame(60), 120);
  // 末尾はプロジェクトの終端を越えない。
  assert.ok(spec.sourceFrame(spec.frames) < 240);
  const fast = plan(0, 240, 24, 30, "1080p");
  assert.equal(fast.frames, 300);
  assert.deepEqual([fast.width, fast.height], [1920, 1080]);
  assert.equal(fast.sourceFrame(15), 12);
});
// C5：ワークエリア（出力範囲）。fromFrameを0以外にすると、その位置から始まる。
test("the plan can start from a non-zero work area (C5)", () => {
  const spec = plan(48, 240, 24, 24);
  assert.equal(spec.seconds, 8);
  assert.equal(spec.frames, 192);
  assert.equal(spec.sourceFrame(0), 48);
  assert.equal(spec.sourceFrame(48), 96);
  assert.ok(spec.sourceFrame(spec.frames) < 240);
});
test("frame evaluation matches playback at panel boundaries and mid-move", () => {
  const rows = rowsOf(2);
  setCameraKey(rows[1].panel, 1, { zoom: 2 });
  assert.equal(evaluate(rows, 47.9).row, rows[0]);
  // ちょうど境界は次のPanelの先頭。再生と同じ規則。
  assert.equal(evaluate(rows, 48).row, rows[1]);
  const mid = evaluate(rows, 72);
  assert.equal(mid.row, rows[1]);
  assert.deepEqual(mid.camera, cameraAt(rows[1].panel, 0.5));
  assert.equal(mid.camera.zoom, 1.5);
});
test("output names drop only the characters a file system rejects", () => {
  assert.equal(
    outputName("第1話 絵コンテ", "webm"),
    "第1話 絵コンテ-animatic.webm",
  );
  assert.equal(
    outputName('a/b:c*d?e"f<g>h|i', "zip"),
    "abcdefghi-animatic.zip",
  );
  assert.equal(outputName("   ", "webm"), "conte-animatic.webm");
  assert.equal(FORMATS.frames.extension, "zip");
});
test("recording progress counts frames and the remaining wall time", () => {
  const spec = plan(0, 240, 24, 24);
  assert.deepEqual(recordingProgress(0, spec), {
    done: 0,
    total: 240,
    remaining: 10,
  });
  assert.deepEqual(recordingProgress(2.5, spec), {
    done: 60,
    total: 240,
    remaining: 7.5,
  });
  // 実時間が予定を超えても、進捗は総数と0で止める。
  assert.deepEqual(recordingProgress(99, spec), {
    done: 240,
    total: 240,
    remaining: 0,
  });
});
test("the recording format falls back through the supported types", () => {
  assert.equal(
    pickMime("webm", (t) => t === "video/webm;codecs=vp8,opus"),
    "video/webm;codecs=vp8,opus",
  );
  assert.equal(
    pickMime("webm", () => true),
    "video/webm;codecs=vp9,opus",
  );
  assert.equal(
    pickMime("webm", () => false),
    null,
  );
  assert.equal(
    pickMime("frames", () => true),
    null,
  );
});
