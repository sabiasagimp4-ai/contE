export const uid = () => crypto.randomUUID();
export const VERSION = 2;
export const panel = () => ({
  id: uid(),
  frames: 48,
  dialogue: "",
  sound: "",
  notes: "",
  strokes: [],
  image: null,
  camera: [{ t: 0, x: 0, y: 0, zoom: 1, rotation: 0 }],
});
export const project = () => ({
  version: VERSION,
  title: "無題のコンテ",
  fps: 24,
  assets: [],
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
  if (p?.version !== VERSION) throw Error("未対応のプロジェクトVersion");
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
  // 素材はIDとメタデータだけを持つ。バイナリはProjectRepositoryが別に保持する。
  if (!Array.isArray(p.assets)) throw Error("不正な素材一覧");
  const assets = new Set();
  for (const a of p.assets) {
    id(a);
    if (
      !["image", "audio"].includes(a.kind) ||
      typeof a.name !== "string" ||
      typeof a.mime !== "string" ||
      !Number.isInteger(a.bytes) ||
      a.bytes < 0
    )
      throw Error("不正な素材");
    assets.add(a.id);
  }
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
        if (b.image !== null) {
          if (
            !assets.has(b.image?.assetId) ||
            !Number.isFinite(b.image.opacity) ||
            b.image.opacity < 0 ||
            b.image.opacity > 1
          )
            throw Error("不正な画像参照");
        }
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
// 旧形式は読み込み時に一段ずつ持ち上げる。元データは変更しない。
const migrations = {
  1: (p) => ({
    version: 2,
    title: p.title,
    fps: p.fps,
    assets: [],
    scenes: p.scenes.map((s) => ({
      ...s,
      shots: s.shots.map((h) => ({
        ...h,
        panels: h.panels.map((b) => ({ ...b, image: b.image ?? null })),
      })),
    })),
  }),
};
export function migrate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("プロジェクトとして読み取れません");
  let p = raw;
  while (p.version !== VERSION) {
    const step = migrations[p.version];
    if (!step)
      throw Error(
        `未対応のプロジェクトVersion: ${JSON.stringify(p.version)}（このアプリはv${VERSION}まで）`,
      );
    p = step(p);
  }
  return p;
}
export function load(text) {
  return validate(migrate(JSON.parse(text)));
}
const sameList = (a, b, eq) =>
  a === b || (a.length === b.length && a.every((v, i) => eq(v, b[i])));
const sameKeys = (a, b, keys) => keys.every((k) => a[k] === b[k]);
const sameImage = (a, b) =>
  a === b || (!!a && !!b && a.assetId === b.assetId && a.opacity === b.opacity);
const samePanel = (a, b) =>
  a === b ||
  (sameKeys(a, b, ["id", "frames", "dialogue", "sound", "notes"]) &&
    sameImage(a.image, b.image) &&
    // ストロークは履歴間で共有された不変配列なので参照比較で足りる。
    sameList(a.strokes, b.strokes, (x, y) => x === y) &&
    sameList(a.camera, b.camera, (x, y) =>
      sameKeys(x, y, ["t", "x", "y", "zoom", "rotation"]),
    ));
export function sameProject(a, b) {
  if (a === b) return true;
  return (
    sameKeys(a, b, ["version", "title", "fps"]) &&
    sameList(a.assets, b.assets, (x, y) =>
      sameKeys(x, y, ["id", "kind", "name", "mime", "bytes"]),
    ) &&
    sameList(
      a.scenes,
      b.scenes,
      (s, t) =>
        s === t ||
        (sameKeys(s, t, ["id", "name"]) &&
          sameList(
            s.shots,
            t.shots,
            (h, u) =>
              h === u ||
              (h.id === u.id && sameList(h.panels, u.panels, samePanel)),
          )),
    )
  );
}
export function selectionOf(p) {
  const first = flatten(p)[0].panel.id;
  return { active: first, ids: [first] };
}
// 選択は常に存在するPanelを指す。削除やUndoの後も選択が迷子にならない。
export function normalizeSelection(selection, p) {
  const rows = flatten(p);
  const known = new Set(rows.map((r) => r.panel.id));
  const ids = (selection?.ids ?? []).filter((id) => known.has(id));
  const active =
    selection?.active && known.has(selection.active)
      ? selection.active
      : (ids[0] ?? rows[0].panel.id);
  return { active, ids: ids.length ? ids : [active] };
}
const sameSelection = (a, b) =>
  a.active === b.active && sameList(a.ids, b.ids, (x, y) => x === y);
export class Store {
  constructor(p = project(), selection) {
    this.p = validate(p);
    this.selection = normalizeSelection(selection, this.p);
    this.past = [];
    this.future = [];
  }
  select(selection) {
    this.selection = normalizeSelection(selection, this.p);
    return this.selection;
  }
  // fnは選択を返せる。プロジェクトが変わらない操作は履歴段数を消費しない。
  edit(fn) {
    const next = {
      ...this.p,
      assets: this.p.assets.map((a) => ({ ...a })),
      scenes: this.p.scenes.map((s) => ({
        ...s,
        shots: s.shots.map((h) => ({
          ...h,
          panels: h.panels.map((b) => ({
            ...b,
            image: b.image ? { ...b.image } : null,
            camera: b.camera.map((k) => ({ ...k })),
          })),
        })),
      })),
    };
    const requested = fn(next);
    validate(next);
    const changed = !sameProject(this.p, next);
    const selection = normalizeSelection(requested ?? this.selection, next);
    if (!changed) {
      this.selection = selection;
      return false;
    }
    this.past.push({ p: this.p, selection: this.selection });
    if (this.past.length > 80) this.past.shift();
    this.p = next;
    this.selection = selection;
    this.future = [];
    return true;
  }
  #move(from, to) {
    if (!from.length) return false;
    to.push({ p: this.p, selection: this.selection });
    const entry = from.pop();
    this.p = entry.p;
    this.selection = normalizeSelection(entry.selection, this.p);
    return true;
  }
  undo() {
    return this.#move(this.past, this.future);
  }
  redo() {
    return this.#move(this.future, this.past);
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
