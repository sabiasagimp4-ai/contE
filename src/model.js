export const uid = () => crypto.randomUUID();
export const panel = () => ({
  id: uid(),
  frames: 48,
  dialogue: "",
  sound: "",
  notes: "",
  strokes: [],
  camera: [{ t: 0, x: 0, y: 0, zoom: 1, rotation: 0 }],
});
export const project = () => ({
  version: 1,
  title: "無題のコンテ",
  fps: 24,
  scenes: [
    { id: uid(), name: "シーン01", shots: [{ id: uid(), panels: [panel()] }] },
  ],
});
export function flatten(p) {
  let start = 0;
  return p.scenes.flatMap((s, si) =>
    s.shots.flatMap((h, hi) =>
      h.panels.map((p, pi) => {
        const r = {
          panel: p,
          scene: s,
          shot: h,
          si,
          hi,
          pi,
          start,
          end: start + p.frames,
        };
        start = r.end;
        return r;
      }),
    ),
  );
}
const checkedStrokes = new WeakSet();
export function validate(p) {
  if (p?.version !== 1) throw Error("未対応のプロジェクトVersion");
  if (
    !Number.isInteger(p.fps) ||
    p.fps < 1 ||
    p.fps > 120 ||
    typeof p.title !== "string"
  )
    throw Error("不正なプロジェクト");
  const ids = new Set();
  const id = (o) => {
    if (typeof o.id !== "string" || ids.has(o.id))
      throw Error("IDが不正または重複");
    ids.add(o.id);
  };
  if (!Array.isArray(p.scenes) || !p.scenes.length)
    throw Error("Sceneが必要です");
  for (const s of p.scenes) {
    id(s);
    if (typeof s.name !== "string" || !s.shots?.length)
      throw Error("不正なScene");
    for (const h of s.shots) {
      id(h);
      if (!h.panels?.length) throw Error("空のShot");
      for (const b of h.panels) {
        id(b);
        if (!Number.isInteger(b.frames) || b.frames < 1 || b.frames > 864000)
          throw Error("不正な尺");
        for (const k of ["dialogue", "sound", "notes"])
          if (typeof b[k] !== "string") throw Error("不正なテキスト");
        if (
          !Array.isArray(b.strokes) ||
          !Array.isArray(b.camera) ||
          !b.camera.length
        )
          throw Error("不正な描画/Camera");
        if (!checkedStrokes.has(b.strokes)) {
          for (const stroke of b.strokes)
            if (
              !Array.isArray(stroke) ||
              !stroke.length ||
              stroke.some(
                (pt) =>
                  !Array.isArray(pt) ||
                  pt.length !== 2 ||
                  pt.some((v) => !Number.isFinite(v) || v < 0 || v > 1),
              )
            )
              throw Error("不正なストローク");
          for (const stroke of b.strokes) {
            for (const pt of stroke) Object.freeze(pt);
            Object.freeze(stroke);
          }
          Object.freeze(b.strokes);
          checkedStrokes.add(b.strokes);
        }
        for (const k of b.camera)
          if (
            !["t", "x", "y", "zoom", "rotation"].every((a) =>
              Number.isFinite(k[a]),
            ) ||
            k.t < 0 ||
            k.t > 1 ||
            k.zoom < 0.1 ||
            k.zoom > 10
          )
            throw Error("不正なCamera");
      }
    }
  }
  return p;
}
export function load(text) {
  return validate(JSON.parse(text));
}
export class Store {
  constructor(p = project()) {
    this.p = validate(p);
    this.past = [];
    this.future = [];
  }
  edit(fn) {
    const next = {
      ...this.p,
      scenes: this.p.scenes.map((s) => ({
        ...s,
        shots: s.shots.map((h) => ({
          ...h,
          panels: h.panels.map((b) => ({
            ...b,
            camera: b.camera.map((k) => ({ ...k })),
          })),
        })),
      })),
    };
    fn(next);
    validate(next);
    this.past.push(this.p);
    if (this.past.length > 80) this.past.shift();
    this.p = next;
    this.future = [];
  }
  undo() {
    if (this.past.length) {
      this.future.push(this.p);
      this.p = this.past.pop();
    }
  }
  redo() {
    if (this.future.length) {
      this.past.push(this.p);
      this.p = this.future.pop();
    }
  }
}
export function split(p, id) {
  const r = flatten(p).find((r) => r.panel.id === id);
  if (!r || r.pi === 0) return;
  const next = { id: uid(), panels: r.shot.panels.splice(r.pi) };
  r.scene.shots.splice(r.hi + 1, 0, next);
}
export function merge(p, id) {
  const r = flatten(p).find((r) => r.panel.id === id);
  if (!r || !r.hi) return;
  r.scene.shots[r.hi - 1].panels.push(...r.shot.panels);
  r.scene.shots.splice(r.hi, 1);
}
export function cameraAt(b, t) {
  const keys = [...b.camera].sort((a, b) => a.t - b.t);
  let a = keys[0],
    z = keys.at(-1);
  for (const k of keys) {
    if (k.t <= t) a = k;
    if (k.t >= t) {
      z = k;
      break;
    }
  }
  const f = a.t === z.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (z.t - a.t)));
  return Object.fromEntries(
    ["x", "y", "zoom", "rotation"].map((k) => [k, a[k] + (z[k] - a[k]) * f]),
  );
}
