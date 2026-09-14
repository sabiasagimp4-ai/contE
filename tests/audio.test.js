import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveClips,
  clipsInRange,
  scheduleFor,
  soundNotes,
  soundText,
  peaks,
  sampleRange,
  addClip,
  placeClip,
  trimClip,
  removeClips,
  pruneClips,
  pruneAudioAssets,
  AudioEngine,
} from "../src/audio.js";
import { project, panel, flatten, Store, validate } from "../src/model.js";
const withAudio = (panels = 3) => {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: panels }, panel);
  p.assets.push({
    id: "sound-1",
    kind: "audio",
    name: "waves.wav",
    mime: "audio/wav",
    bytes: 1000,
  });
  return p;
};
test("clips resolve to absolute frames through their anchor panel", () => {
  const p = withAudio();
  const rows = flatten(p);
  addClip(p, {
    assetId: "sound-1",
    track: "se",
    anchor: rows[1].panel.id,
    at: 12,
    frames: 30,
  });
  assert.equal(validate(p), p);
  const [resolved] = resolveClips(p, rows);
  assert.equal(resolved.start, 60);
  assert.equal(resolved.end, 90);
  assert.equal(resolved.asset.name, "waves.wav");
});
test("a clip follows its panel when earlier durations change", () => {
  const s = new Store(withAudio());
  const anchor = flatten(s.p)[1].panel.id;
  s.edit((p) =>
    addClip(p, {
      assetId: "sound-1",
      track: "bgm",
      anchor,
      at: 0,
      frames: 48,
    }),
  );
  assert.equal(resolveClips(s.p)[0].start, 48);
  // 前のPanelを伸ばすと、音も同じだけ後ろへ動く。
  s.edit((p) => (flatten(p)[0].panel.frames = 72));
  assert.equal(resolveClips(s.p)[0].start, 72);
  // 基準のPanel自身の尺を変えても、クリップの長さは変わらない。
  s.edit((p) => (flatten(p)[1].panel.frames = 12));
  assert.equal(resolveClips(s.p)[0].end - resolveClips(s.p)[0].start, 48);
  s.undo();
  s.undo();
  assert.equal(resolveClips(s.p)[0].start, 48);
});
test("moving a clip re-anchors it to the panel it starts on", () => {
  const p = withAudio();
  const rows = flatten(p);
  const clip = addClip(p, {
    assetId: "sound-1",
    track: "se",
    anchor: rows[0].panel.id,
    at: 0,
    frames: 20,
  });
  assert.equal(placeClip(p, rows, clip.id, 100), true);
  assert.equal(clip.anchor, rows[2].panel.id);
  assert.equal(clip.at, 4);
  assert.equal(resolveClips(p, rows)[0].start, 100);
  // 同じ位置へ置き直しても履歴を消費しない。
  assert.equal(placeClip(p, rows, clip.id, 100), false);
  assert.equal(trimClip(p, clip.id, 0), true);
  assert.equal(clip.frames, 1);
});
test("deleting a panel takes its clips with it and leaves no orphans", () => {
  const p = withAudio();
  const rows = flatten(p);
  addClip(p, {
    assetId: "sound-1",
    track: "se",
    anchor: rows[2].panel.id,
    at: 0,
    frames: 10,
  });
  p.scenes[0].shots[0].panels.pop();
  assert.equal(pruneClips(p), true);
  assert.deepEqual(p.audio, []);
  assert.equal(pruneAudioAssets(p), true);
  assert.deepEqual(p.assets, []);
  assert.equal(validate(p), p);
});
test("playback schedules only what is still ahead, trimmed to the project end", () => {
  const p = withAudio();
  const rows = flatten(p);
  addClip(p, {
    assetId: "sound-1",
    track: "bgm",
    anchor: rows[0].panel.id,
    at: 24,
    frames: 96,
    offset: 12,
    gain: 0.5,
  });
  const resolved = resolveClips(p, rows);
  assert.deepEqual(scheduleFor(resolved, 0, 24), [
    {
      id: p.audio[0].id,
      assetId: "sound-1",
      track: "bgm",
      gain: 0.5,
      when: 1,
      offset: 0.5,
      duration: 4,
    },
  ]);
  // 途中から再生するときは、素材の中の位置も同じだけ進める。
  const mid = scheduleFor(resolved, 48, 24)[0];
  assert.equal(mid.when, 0);
  assert.equal(mid.offset, (12 + 24) / 24);
  assert.equal(mid.duration, 3);
  // 終端より後ろは鳴らさない。
  assert.equal(scheduleFor(resolved, 0, 24, 36)[0].duration, 0.5);
  assert.deepEqual(scheduleFor(resolved, 200, 24), []);
});
test("sound notes come from overlap, not from guessing", () => {
  const p = withAudio();
  const rows = flatten(p);
  rows[0].panel.dialogue = "行こう";
  addClip(p, {
    assetId: "sound-1",
    track: "se",
    anchor: rows[0].panel.id,
    at: 10,
    frames: 80,
  });
  const first = soundNotes(p, rows, rows[0]);
  assert.deepEqual(first, [
    { track: "dialogue", text: "行こう" },
    { track: "se", text: "waves.wav +10f" },
  ]);
  assert.equal(soundText(first), "台詞: 行こう / SE: waves.wav +10f");
  // またいだ先のPanelでは続きとして出す。
  assert.deepEqual(soundNotes(p, rows, rows[1]), [
    { track: "se", text: "waves.wav（続き）" },
  ]);
  assert.deepEqual(soundNotes(p, rows, rows[2]), []);
  assert.deepEqual(clipsInRange(resolveClips(p, rows), 96, 144), []);
});
test("waveform peaks keep the extremes of every column", () => {
  const samples = Float32Array.from({ length: 100 }, (_, i) =>
    i === 10 ? -1 : i === 90 ? 1 : 0,
  );
  const wave = peaks(samples, 10);
  assert.equal(wave.length, 20);
  assert.equal(wave[2], -1);
  assert.equal(wave[19], 1);
  assert.equal(wave[0], 0);
});
test("the engine caches decodes and never leaves two playbacks running", async () => {
  let decodes = 0,
    stops = 0,
    now = 0;
  const made = [];
  const fakeContext = {
    get currentTime() {
      return now;
    },
    decodeAudioData: async () => {
      decodes++;
      return { duration: 4, getChannelData: () => new Float32Array(1000) };
    },
    createBufferSource: () => {
      const source = {
        connect: (node) => node,
        disconnect() {},
        start() {},
        stop() {
          stops++;
        },
      };
      made.push(source);
      return source;
    },
    createGain: () => ({
      gain: { value: 1 },
      connect: (node) => node,
      disconnect() {},
    }),
    destination: {},
    resume() {},
  };
  const engine = new AudioEngine(() => fakeContext);
  const blob = { arrayBuffer: async () => new ArrayBuffer(8) };
  await engine.decode("sound-1", blob);
  await engine.decode("sound-1", blob);
  assert.equal(decodes, 1, "decode must be cached");
  assert.equal(engine.waveform("sound-1", 8).length, 16);
  assert.equal(engine.waveform("sound-1", 8), engine.waveform("sound-1", 8));
  const schedule = [
    { assetId: "sound-1", when: 0, offset: 0, duration: 2, gain: 1 },
  ];
  engine.play(schedule, 0, 24);
  now = 1;
  assert.equal(Math.round(engine.frameAt(24)), Math.round((1 - 0.06) * 24));
  // 繰り返しseekしても、前の音を止めてから鳴らす。
  engine.play(schedule, 48, 24);
  assert.equal(stops, 1);
  assert.equal(made.length, 2);
  engine.stop();
  assert.equal(stops, 2);
  assert.equal(engine.frameAt(24), null);
  engine.forget("sound-1");
  assert.equal(engine.has("sound-1"), false);
  assert.equal(engine.waveform("sound-1", 8), null);
});

test("waveform shows the segment the clip actually uses", () => {
  // 前半1秒は無音、後半1秒だけ振れる素材。offsetを動かすと形が変わるはず。
  const rate = 100;
  const samples = new Float32Array(rate * 2);
  for (let i = rate; i < samples.length; i++) samples[i] = i % 2 ? 0.8 : -0.8;
  const engine = new AudioEngine(() => ({}));
  engine.buffers.set("sound-1", {
    duration: 2,
    length: samples.length,
    sampleRate: rate,
    getChannelData: () => samples,
  });
  const fps = 24;
  const head = engine.waveform("sound-1", 4, { offset: 0, frames: 24, fps });
  const tail = engine.waveform("sound-1", 4, { offset: 24, frames: 24, fps });
  assert.deepEqual([...head], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(
    [...tail].some((v) => Math.abs(v) > 0.5),
    "使用区間のピークが出ていない",
  );
  // 素材の終わりを越えた分は無音として描く。形が引き伸ばされない。
  const beyond = engine.waveform("sound-1", 4, { offset: 24, frames: 96, fps });
  assert.ok(Math.abs(beyond[0]) > 0.5, "先頭は素材内なので振れるはず");
  assert.deepEqual([...beyond.slice(4)], [0, 0, 0, 0]);
  // 区間ごとに別のキャッシュを持ち、同じ要求は同じ配列を返す。
  assert.equal(
    engine.waveform("sound-1", 4, { offset: 24, frames: 24, fps }),
    tail,
  );
  assert.notEqual(head, tail);
  engine.forget("sound-1");
  assert.equal(engine.waves.size, 0);
});

test("sample ranges convert project frames through the source rate", () => {
  assert.deepEqual(sampleRange({ offset: 24, frames: 48, fps: 24 }, 48000), {
    from: 48000,
    to: 144000,
  });
  // fpsが違えば同じフレーム数でも別の秒数になる。
  assert.deepEqual(sampleRange({ offset: 0, frames: 30, fps: 30 }, 22050), {
    from: 0,
    to: 22050,
  });
});
