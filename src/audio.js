import { flatten, uid, AUDIO_TRACKS } from "./model.js";
// Audio Engine：クリップの時間計算・波形・再生の予約を担当する。
// 時間計算と波形は純粋関数として分け、Web Audioが無い環境でも検証できるようにする。
export const AUDIO_TRACK_ORDER = AUDIO_TRACKS;
export const TRACK_LABEL = {
  dialogue: "台詞",
  se: "SE",
  bgm: "BGM",
};
// クリップは「開始位置があるPanel」からの相対位置で持つ。
// 尺を変えてもそのPanelに付いて動き、Panelを消せばクリップも一緒に消える。
export function resolveClips(p, rows = flatten(p)) {
  const starts = new Map(rows.map((r) => [r.panel.id, r.start]));
  const assets = new Map(p.assets.map((asset) => [asset.id, asset]));
  return p.audio
    .map((clip) => {
      const base = starts.get(clip.anchor);
      if (base === undefined) return null;
      const start = base + clip.at;
      return {
        clip,
        asset: assets.get(clip.assetId) ?? null,
        start,
        end: start + clip.frames,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.clip.id.localeCompare(b.clip.id));
}
export const clipsInRange = (resolved, from, to) =>
  resolved.filter((r) => r.end > from && r.start < to);
// 再生の予約。fromFrameから鳴らす分だけを、音声時計の秒へ直して返す。
export function scheduleFor(resolved, fromFrame, fps, endFrame = Infinity) {
  const schedule = [];
  for (const r of resolved) {
    if (r.end <= fromFrame || r.start >= endFrame) continue;
    const startFrame = Math.max(r.start, fromFrame);
    const stopFrame = Math.min(r.end, endFrame);
    const skipped = startFrame - r.start;
    schedule.push({
      id: r.clip.id,
      assetId: r.clip.assetId,
      track: r.clip.track,
      gain: r.clip.gain,
      when: (startFrame - fromFrame) / fps,
      offset: (r.clip.offset + skipped) / fps,
      duration: (stopFrame - startFrame) / fps,
    });
  }
  return schedule;
}
// 紙コンテの音注記：時間が重なるクリップと、そのPanelの台詞テキストから作る。
export function soundNotes(p, rows, row, resolved = resolveClips(p, rows)) {
  const notes = [];
  if (row.panel.dialogue.trim())
    notes.push({ track: "dialogue", text: row.panel.dialogue.trim() });
  for (const r of clipsInRange(resolved, row.start, row.end)) {
    const lead = Math.max(0, r.start - row.start);
    notes.push({
      track: r.clip.track,
      text: `${r.asset?.name ?? "素材不明"}${lead ? ` +${lead}f` : ""}${
        r.start < row.start ? "（続き）" : ""
      }`,
    });
  }
  return notes;
}
export const soundText = (notes) =>
  notes.map((n) => `${TRACK_LABEL[n.track] ?? n.track}: ${n.text}`).join(" / ");
// 波形のピーク。1列あたりの最小/最大を1度だけ計算してキャッシュする。
// from/toは素材内のサンプル位置。素材の外にはみ出した範囲は無音として描く。
export function peaks(samples, columns, from = 0, to = samples.length) {
  const out = new Float32Array(columns * 2);
  const per = (to - from) / columns;
  for (let c = 0; c < columns; c++) {
    const start = Math.max(0, Math.floor(from + c * per)),
      stop = Math.min(samples.length, Math.floor(from + (c + 1) * per));
    let min = 0,
      max = 0;
    for (let i = start; i < stop; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[c * 2] = min;
    out[c * 2 + 1] = max;
  }
  return out;
}
// v5のoffsetとframesはProjectのfpsで数えた整数フレーム。素材内の位置へ直すときは
// 一度秒へ直し、素材自身のsampleRateでサンプル位置にする（計画 §18.5 R08）。
export function sampleRange({ offset = 0, frames, fps }, sampleRate) {
  const from = Math.round((offset / fps) * sampleRate);
  return { from, to: from + Math.round((frames / fps) * sampleRate) };
}
export function addClip(
  p,
  { id = uid(), assetId, track, anchor, at, frames, offset = 0, gain = 1 },
) {
  if (!AUDIO_TRACKS.includes(track)) return null;
  const clip = {
    id,
    assetId,
    track,
    anchor,
    at: Math.round(at),
    frames: Math.max(1, Math.round(frames)),
    offset: Math.max(0, Math.round(offset)),
    gain,
  };
  p.audio.push(clip);
  return clip;
}
// 移動先のPanelを基準に付け替える。どのPanelに属するかは開始位置で決まる。
export function placeClip(p, rows, id, startFrame) {
  const clip = p.audio.find((c) => c.id === id);
  if (!clip) return false;
  const start = Math.max(0, Math.round(startFrame));
  const host =
    rows.find((r) => start >= r.start && start < r.end) ?? rows.at(-1);
  const next = { anchor: host.panel.id, at: start - host.start };
  if (clip.anchor === next.anchor && clip.at === next.at) return false;
  Object.assign(clip, next);
  return true;
}
export function trimClip(p, id, frames) {
  const clip = p.audio.find((c) => c.id === id);
  const next = Math.max(1, Math.min(864000, Math.round(frames)));
  if (!clip || clip.frames === next) return false;
  clip.frames = next;
  return true;
}
export function removeClips(p, ids) {
  const drop = new Set(ids);
  const before = p.audio.length;
  p.audio = p.audio.filter((c) => !drop.has(c.id));
  return p.audio.length !== before;
}
// Panelが消えたときは、そのPanelに属する音も一緒に消す。孤児を残さない。
export function pruneClips(p) {
  const panels = new Set(flatten(p).map((r) => r.panel.id));
  const before = p.audio.length;
  p.audio = p.audio.filter((c) => panels.has(c.anchor));
  return p.audio.length !== before;
}
export function pruneAudioAssets(p) {
  const used = new Set(p.audio.map((c) => c.assetId));
  const before = p.assets.length;
  p.assets = p.assets.filter((a) => a.kind !== "audio" || used.has(a.id));
  return p.assets.length !== before;
}
// デコードと波形をキャッシュし、再生はいつでも1本の予約だけが生きている状態にする。
export class AudioEngine {
  constructor(
    createContext = () =>
      new (window.AudioContext || window.webkitAudioContext)(),
  ) {
    this.createContext = createContext;
    this.ctx = null;
    this.buffers = new Map();
    this.waves = new Map();
    this.sources = [];
    this.generation = 0;
    this.startedAt = 0;
    this.baseFrame = 0;
  }
  context() {
    if (!this.ctx) this.ctx = this.createContext();
    return this.ctx;
  }
  async decode(assetId, blob) {
    if (this.buffers.has(assetId)) return this.buffers.get(assetId);
    const data = await blob.arrayBuffer();
    const buffer = await this.context().decodeAudioData(data);
    this.buffers.set(assetId, buffer);
    return buffer;
  }
  has(assetId) {
    return this.buffers.has(assetId);
  }
  forget(assetId) {
    this.buffers.delete(assetId);
    for (const key of [...this.waves.keys()])
      if (key.startsWith(`${assetId}:`)) this.waves.delete(key);
  }
  seconds(assetId) {
    return this.buffers.get(assetId)?.duration ?? 0;
  }
  // 表示するのはクリップが実際に使う区間だけ。offsetやtrimを変えれば形も変わる。
  // 波形はChannel 0だけを見る（現行仕様。混合や左右別表示は別の変更とする）。
  waveform(assetId, columns, segment = null) {
    const buffer = this.buffers.get(assetId);
    if (!buffer) return null;
    const { from, to } = segment
      ? sampleRange(segment, buffer.sampleRate)
      : { from: 0, to: buffer.length };
    // 同じ素材でも区間と解像度が違えば別の波形。キャッシュキーに両方を含める。
    const key = `${assetId}:${columns}:${from}:${to}`;
    if (!this.waves.has(key))
      this.waves.set(
        key,
        peaks(buffer.getChannelData(0), columns, from, to),
      );
    return this.waves.get(key);
  }
  // 書き出し用の出力先。録画では同じ予約をこのストリームへ流す。
  streamDestination() {
    const ctx = this.context();
    this.stream ??= ctx.createMediaStreamDestination();
    return this.stream;
  }
  // 予約し直すたびに世代を進め、前の予約の音は必ず止める。二重再生を作らない。
  play(schedule, fromFrame, fps, lead = 0.06, destination = null) {
    this.stop();
    const ctx = this.context();
    ctx.resume?.();
    const base = ctx.currentTime + lead;
    this.generation++;
    for (const item of schedule) {
      const buffer = this.buffers.get(item.assetId);
      if (!buffer || item.duration <= 0) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = item.gain;
      source.connect(gain).connect(destination ?? ctx.destination);
      const offset = Math.min(
        item.offset,
        Math.max(0, buffer.duration - 0.001),
      );
      source.start(base + item.when, offset, item.duration);
      this.sources.push(source);
    }
    this.startedAt = base;
    this.baseFrame = fromFrame;
    return base;
  }
  stop() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // 既に終わっている音は無視してよい。
      }
      source.disconnect();
    }
    this.sources = [];
  }
  // 音声時計を基準にしたフレーム位置。音が無いときはnullを返し、UIが別の時計を使う。
  frameAt(fps) {
    if (!this.ctx || !this.sources.length) return null;
    return this.baseFrame + (this.ctx.currentTime - this.startedAt) * fps;
  }
  close() {
    this.stop();
    this.ctx?.close?.();
    this.ctx = null;
  }
}
