export const uid = () => crypto.randomUUID();
export const VERSION = 6;
// ブラシ幅は画面幅に対する割合で持つ。出力サイズが変わっても線の太さが崩れない。
export const BRUSH = { min: 0.0005, max: 0.05, default: 3 / 1280 };
// Panelのラベル色（C2）。固定の色表から選ぶ。増減はいつでもできるが、
// 保存済みのキー文字列は変えない（既存ファイルのラベルが変わってしまう）。
export const LABEL_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"];
// 画像の収め方（C4）。containは全体を収め、coverは枠を埋めて超過分を切る。
export const IMAGE_FITS = ["contain", "cover"];
// Cameraキーの緩急（C3）。"linear"は現行の一次補間と同じ式になる。
export const CAMERA_EASES = ["linear", "easeIn", "easeOut", "easeInOut"];
const EASE_FNS = {
  linear: (f) => f,
  easeIn: (f) => f * f,
  easeOut: (f) => 1 - (1 - f) * (1 - f),
  easeInOut: (f) => (f < 0.5 ? 2 * f * f : 1 - ((-2 * f + 2) ** 2) / 2),
};
export const panel = () => ({
  id: uid(),
  frames: 48,
  dialogue: "",
  sound: "",
  notes: "",
  strokes: [],
  image: null,
  label: null,
  camera: [{ t: 0, x: 0, y: 0, zoom: 1, rotation: 0, ease: "linear" }],
});
export const AUDIO_TRACKS = ["dialogue", "se", "bgm"];
// 紙コンテの用紙。mmと150dpiのピクセル数を持ち、向きで縦横を入れ替える。
export const PAPER_SIZES = {
  A4: { mm: [210, 297], px: [1240, 1754] },
  A3: { mm: [297, 420], px: [1754, 2480] },
  B4: { mm: [257, 364], px: [1517, 2150] },
  letter: { mm: [216, 279], px: [1275, 1650] },
};
export const PAPER_COLUMNS = [
  "cut",
  "image",
  "dialogue",
  "sound",
  "notes",
  "camera",
];
export const paperDefaults = () => ({
  size: "A4",
  orientation: "portrait",
  rows: 4,
  margin: 45,
  font: 18,
  header: "",
  footer: "",
  columns: [
    { key: "cut", width: 10 },
    { key: "image", width: 40 },
    { key: "dialogue", width: 18 },
    { key: "sound", width: 16 },
    { key: "notes", width: 16 },
  ],
  duration: true,
  numbers: true,
  cameraMarks: true,
  vertical: false,
});
// Scene / Shotの生成はここへ集約する。呼び出し側で必須項目を書き忘れると
// validateが後から弾くだけになるので、UIもテストも同じ生成関数を使う。
export const shot = (panels = [panel()], name = "") => ({
  id: uid(),
  name,
  panels,
});
export const sceneName = (index) => `シーン${String(index).padStart(2, "0")}`;
export const scene = (name = sceneName(1), shots = [shot()]) => ({
  id: uid(),
  name,
  shots,
});
export const project = () => ({
  version: VERSION,
  title: "無題のコンテ",
  fps: 24,
  assets: [],
  audio: [],
  paper: paperDefaults(),
  scenes: [scene()],
  markers: [],
  workArea: null,
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
  const audioAssets = new Set();
  for (const a of p.assets) {
    id(a);
    if (
      !["image", "audio"].includes(a.kind) ||
      typeof a.name !== "string" ||
      typeof a.mime !== "string" ||
      !Number.isInteger(a.bytes) ||
      a.bytes < 0 ||
      ["width", "height"].some(
        (k) => a[k] !== undefined && !(Number.isInteger(a[k]) && a[k] > 0),
      )
    )
      throw Error("不正な素材");
    assets.add(a.id);
    if (a.kind === "audio") audioAssets.add(a.id);
  }
  if (!Array.isArray(p.scenes) || !p.scenes.length)
    throw Error("Sceneが必要です");
  const panels = new Set();
  let totalFrames = 0;
  for (const s of p.scenes) {
    id(s);
    if (typeof s.name !== "string" || !s.shots?.length)
      throw Error("不正なScene");
    for (const h of s.shots) {
      id(h);
      if (typeof h.name !== "string") throw Error("不正なShot名");
      if (!h.panels?.length) throw Error("空のShot");
      for (const b of h.panels) {
        id(b);
        if (!Number.isInteger(b.frames) || b.frames < 1 || b.frames > 864000)
          throw Error("不正な尺");
        totalFrames += b.frames;
        for (const k of ["dialogue", "sound", "notes"])
          if (typeof b[k] !== "string") throw Error("不正なテキスト");
        if (b.label !== null && !LABEL_COLORS.includes(b.label))
          throw Error("不正なラベル色");
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
            b.image.opacity > 1 ||
            !IMAGE_FITS.includes(b.image.fit) ||
            !Number.isFinite(b.image.offset?.x) ||
            !Number.isFinite(b.image.offset?.y) ||
            !Number.isFinite(b.image.scale) ||
            b.image.scale < 0.1 ||
            b.image.scale > 10
          )
            throw Error("不正な画像参照");
        }
        if (!checkedStrokes.has(b.strokes)) {
          for (const stroke of b.strokes) {
            if (
              typeof stroke?.size !== "number" ||
              !Number.isFinite(stroke.size) ||
              stroke.size < BRUSH.min ||
              stroke.size > BRUSH.max ||
              typeof stroke.erase !== "boolean" ||
              !Array.isArray(stroke.points) ||
              !stroke.points.length ||
              stroke.points.some(
                (pt) =>
                  !Array.isArray(pt) ||
                  pt.length !== 3 ||
                  pt.some((v) => !Number.isFinite(v)) ||
                  pt[0] < 0 ||
                  pt[0] > 1 ||
                  pt[1] < 0 ||
                  pt[1] > 1 ||
                  pt[2] <= 0 ||
                  pt[2] > 1,
              )
            )
              throw Error("不正なストローク");
          }
          for (const stroke of b.strokes) {
            for (const pt of stroke.points) Object.freeze(pt);
            Object.freeze(stroke.points);
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
            k.zoom > 10 ||
            !CAMERA_EASES.includes(k.ease)
          )
            throw Error("不正なCamera");
        panels.add(b.id);
      }
    }
  }
  validatePaper(p.paper);
  // 音声クリップは素材IDと、基準にするPanelへの参照だけを持つ。
  if (!Array.isArray(p.audio)) throw Error("不正な音声一覧");
  for (const c of p.audio) {
    id(c);
    if (
      !AUDIO_TRACKS.includes(c.track) ||
      !audioAssets.has(c.assetId) ||
      !panels.has(c.anchor) ||
      !Number.isInteger(c.at) ||
      !Number.isInteger(c.frames) ||
      c.frames < 1 ||
      c.frames > 864000 ||
      !Number.isInteger(c.offset) ||
      c.offset < 0 ||
      !Number.isFinite(c.gain) ||
      c.gain < 0 ||
      c.gain > 4
    )
      throw Error("不正な音声クリップ");
  }
  // マーカーは音声Clipと同じくPanelへのAnchor＋相対位置で持つ（C1）。
  if (!Array.isArray(p.markers)) throw Error("不正なマーカー一覧");
  for (const m of p.markers) {
    id(m);
    if (
      !panels.has(m.anchor) ||
      !Number.isInteger(m.at) ||
      typeof m.text !== "string" ||
      typeof m.color !== "string" ||
      !m.color
    )
      throw Error("不正なマーカー");
  }
  // 再生・出力の既定範囲（C5）。総尺を超える範囲は指定できない。
  if (p.workArea !== null) {
    if (
      !Number.isInteger(p.workArea.from) ||
      !Number.isInteger(p.workArea.to) ||
      p.workArea.from < 0 ||
      p.workArea.to <= p.workArea.from ||
      p.workArea.to > totalFrames
    )
      throw Error("不正な作業範囲");
  }
  return p;
}
// 紙面設定はプロジェクトと一緒に保存する。壊れた設定で出力を始めない。
export function validatePaper(o) {
  if (!o || typeof o !== "object") throw Error("不正な紙面設定");
  if (
    !PAPER_SIZES[o.size] ||
    !["portrait", "landscape"].includes(o.orientation)
  )
    throw Error("不正な用紙");
  if (
    !Number.isInteger(o.rows) ||
    o.rows < 1 ||
    o.rows > 12 ||
    !Number.isFinite(o.margin) ||
    o.margin < 0 ||
    o.margin > 200 ||
    !Number.isFinite(o.font) ||
    o.font < 8 ||
    o.font > 48 ||
    typeof o.header !== "string" ||
    typeof o.footer !== "string" ||
    ["duration", "numbers", "cameraMarks", "vertical"].some(
      (k) => typeof o[k] !== "boolean",
    )
  )
    throw Error("不正な紙面設定");
  if (!Array.isArray(o.columns) || !o.columns.length)
    throw Error("列がありません");
  const seen = new Set();
  for (const column of o.columns) {
    if (
      !PAPER_COLUMNS.includes(column.key) ||
      seen.has(column.key) ||
      !Number.isFinite(column.width) ||
      column.width <= 0 ||
      column.width > 100
    )
      throw Error("不正な列");
    seen.add(column.key);
  }
  return o;
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
  2: (p) => ({
    ...p,
    version: 3,
    scenes: p.scenes.map((s) => ({
      ...s,
      shots: s.shots.map((h) => ({
        ...h,
        name: h.name ?? "",
        panels: h.panels.map((b) => ({
          ...b,
          // v2の線は太さ一定・筆圧なし。見た目を変えずに属性つきの形式へ移す。
          strokes: b.strokes.map((stroke) => ({
            size: 1 / 500,
            erase: false,
            points: stroke.map(([x, y]) => [x, y, 1]),
          })),
        })),
      })),
    })),
  }),
  3: (p) => ({ ...p, version: 4, audio: [] }),
  4: (p) => ({ ...p, version: 5, paper: paperDefaults() }),
  5: (p) => ({
    ...p,
    version: 6,
    markers: [],
    workArea: null,
    paper: { ...p.paper, vertical: false },
    scenes: p.scenes.map((s) => ({
      ...s,
      shots: s.shots.map((h) => ({
        ...h,
        panels: h.panels.map((b) => ({
          ...b,
          label: null,
          image: b.image
            ? { ...b.image, fit: "contain", offset: { x: 0, y: 0 }, scale: 1 }
            : null,
          camera: b.camera.map((k) => ({ ...k, ease: "linear" })),
        })),
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
  a === b ||
  (!!a &&
    !!b &&
    a.assetId === b.assetId &&
    a.opacity === b.opacity &&
    a.fit === b.fit &&
    a.offset.x === b.offset.x &&
    a.offset.y === b.offset.y &&
    a.scale === b.scale);
const samePanel = (a, b) =>
  a === b ||
  (sameKeys(a, b, ["id", "frames", "dialogue", "sound", "notes", "label"]) &&
    sameImage(a.image, b.image) &&
    // ストロークは履歴間で共有された不変配列なので参照比較で足りる。
    sameList(a.strokes, b.strokes, (x, y) => x === y) &&
    sameList(a.camera, b.camera, (x, y) =>
      sameKeys(x, y, ["t", "x", "y", "zoom", "rotation", "ease"]),
    ));
const sameWorkArea = (a, b) =>
  a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
export function sameProject(a, b) {
  if (a === b) return true;
  return (
    sameKeys(a, b, ["version", "title", "fps"]) &&
    // 紙面設定は項目数が少ないのでJSONで比較して十分。
    JSON.stringify(a.paper) === JSON.stringify(b.paper) &&
    sameWorkArea(a.workArea, b.workArea) &&
    sameList(a.assets, b.assets, (x, y) =>
      sameKeys(x, y, [
        "id",
        "kind",
        "name",
        "mime",
        "bytes",
        "width",
        "height",
      ]),
    ) &&
    sameList(a.audio, b.audio, (x, y) =>
      sameKeys(x, y, [
        "id",
        "assetId",
        "track",
        "anchor",
        "at",
        "frames",
        "offset",
        "gain",
      ]),
    ) &&
    sameList(a.markers, b.markers, (x, y) =>
      sameKeys(x, y, ["id", "anchor", "at", "text", "color"]),
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
              (sameKeys(h, u, ["id", "name"]) &&
                sameList(h.panels, u.panels, samePanel)),
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
  const requested =
    selection?.active && known.has(selection.active)
      ? selection.active
      : (ids[0] ?? rows[0].panel.id);
  // Inspectorの表示対象と一括編集の対象を常に一致させる。
  const active = ids.length && !ids.includes(requested) ? ids[0] : requested;
  return { active, ids: ids.length ? ids : [active] };
}

// どのPanelからも参照されなくなった画像メタデータを外す。音声素材は画像の
// 参照集合に含まれないため、ここでは決して削除しない。
export function pruneImageAssets(p) {
  const used = new Set(
    flatten(p)
      .map((r) => r.panel.image?.assetId)
      .filter(Boolean),
  );
  p.assets = p.assets.filter((asset) => asset.kind !== "image" || used.has(asset.id));
}
// Panel画像だけを外し、他のPanelからも使われていない画像メタデータを整理する。
export function clearPanelImage(p, panelId) {
  const target = flatten(p).find((r) => r.panel.id === panelId)?.panel;
  if (!target?.image) return false;
  target.image = null;
  pruneImageAssets(p);
  return true;
}
const isSelection = (value) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  ("active" in value || "ids" in value);
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
  // kindはCommand名などの識別子。Undo/Redoの内容表示にだけ使う。
  edit(fn, kind) {
    const next = {
      ...this.p,
      assets: this.p.assets.map((a) => ({ ...a })),
      paper: {
        ...this.p.paper,
        columns: this.p.paper.columns.map((c) => ({ ...c })),
      },
      audio: this.p.audio.map((c) => ({ ...c })),
      markers: this.p.markers.map((m) => ({ ...m })),
      workArea: this.p.workArea ? { ...this.p.workArea } : null,
      scenes: this.p.scenes.map((s) => ({
        ...s,
        shots: s.shots.map((h) => ({
          ...h,
          panels: h.panels.map((b) => ({
            ...b,
            image: b.image ? { ...b.image, offset: { ...b.image.offset } } : null,
            camera: b.camera.map((k) => ({ ...k })),
          })),
        })),
      })),
    };
    const requested = fn(next);
    validate(next);
    const changed = !sameProject(this.p, next);
    // 選択を返したときだけ選択を変える。代入式の戻り値（配列や真偽値）は選択ではない。
    const selection = normalizeSelection(
      isSelection(requested) ? requested : this.selection,
      next,
    );
    if (!changed) {
      this.selection = selection;
      return false;
    }
    this.past.push({ p: this.p, selection: this.selection, kind });
    if (this.past.length > 80) this.past.shift();
    this.p = next;
    this.selection = selection;
    this.future = [];
    return true;
  }
  // 戻す/やり直す対象のkindを返す。何も動かなければnull。
  #move(from, to) {
    if (!from.length) return null;
    const entry = from.pop();
    to.push({ p: this.p, selection: this.selection, kind: entry.kind });
    this.p = entry.p;
    this.selection = normalizeSelection(entry.selection, this.p);
    return { kind: entry.kind };
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
  r.scene.shots.splice(r.hi + 1, 0, shot(r.shot.panels.splice(r.pi)));
}
export function merge(p, id) {
  const r = flatten(p).find((r) => r.panel.id === id);
  if (!r || !r.hi) return;
  r.scene.shots[r.hi - 1].panels.push(...r.shot.panels);
  r.scene.shots.splice(r.hi, 1);
}
// 選択Panelをanchorの前後へ移す。Shot/Sceneをまたいでも全体の順序を保つ。
export function movePanels(p, ids, anchorId, place = "before") {
  const moving = new Set(ids);
  if (!moving.size || moving.has(anchorId)) return false;
  const anchor = flatten(p).find((r) => r.panel.id === anchorId);
  if (!anchor) return false;
  const taken = [];
  for (const s of p.scenes)
    for (const h of s.shots) {
      const keep = [];
      for (const b of h.panels) (moving.has(b.id) ? taken : keep).push(b);
      h.panels = keep;
    }
  if (!taken.length) return false;
  const shot = p.scenes
    .flatMap((s) => s.shots)
    .find((h) => h.id === anchor.shot.id);
  shot.panels.splice(
    shot.panels.indexOf(anchor.panel) + (place === "after" ? 1 : 0),
    0,
    ...taken,
  );
  for (const s of p.scenes) s.shots = s.shots.filter((h) => h.panels.length);
  p.scenes = p.scenes.filter((s) => s.shots.length);
  return true;
}
export const CAMERA_FIELDS = ["x", "y", "zoom", "rotation"];
const round = (t) => Math.round(clampT(t) * 1e6) / 1e6;
const clampT = (t) => Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
const sortKeys = (b) => b.camera.sort((x, y) => x.t - y.t);
// Cameraキーは尺に対する比率tで持つ。尺を変えると動きも同じ比率で伸縮する。
// UIはフレーム位置で見せるが、保存も再生も紙コンテもこの比率を共有する。
export function cameraKeyIndex(b, t, epsilon = 1e-4) {
  return b.camera.findIndex((k) => Math.abs(k.t - round(t)) <= epsilon);
}
export function setCameraKey(b, t, values = {}) {
  const at = round(t);
  const base = cameraAt(b, at);
  const key = { t: at, ease: "linear", ...base, ...values };
  const existing = cameraKeyIndex(b, at);
  if (existing >= 0) b.camera[existing] = key;
  else b.camera.push(key);
  sortKeys(b);
  return cameraKeyIndex(b, at);
}
export function moveCameraKey(b, index, t) {
  const key = b.camera[index];
  if (!key) return false;
  const at = round(t);
  if (key.t === at) return false;
  const collision = cameraKeyIndex(b, at);
  if (collision >= 0 && collision !== index) b.camera.splice(collision, 1);
  key.t = at;
  sortKeys(b);
  return true;
}
export function removeCameraKey(b, index) {
  // キーが1つも無いPanelは作らない。最後の1本は消せない。
  if (b.camera.length < 2 || !b.camera[index]) return false;
  b.camera.splice(index, 1);
  return true;
}
// 動きの向きは全キーを通して拾う。閾値より小さい揺れは動きとして数えず、
// 閾値を超えて向きが変わったところだけを折り返しとして記録する。
// 始点と終点だけを比べると、0→0.5→0のような往復を静止と誤って要約してしまう。
function swingDirections(values, epsilon) {
  const directions = [];
  let pivot = values[0],
    extreme = values[0],
    direction = 0;
  for (const value of values.slice(1)) {
    if (!direction) {
      if (Math.abs(value - pivot) > epsilon) {
        direction = Math.sign(value - pivot);
        directions.push(direction);
        extreme = value;
      }
      continue;
    }
    // 同じ向きへ伸びる間は先端を更新し、戻りが閾値を超えたら折り返しとする。
    if ((value - extreme) * direction > 0) extreme = value;
    else if ((extreme - value) * direction > epsilon) {
      direction = -direction;
      directions.push(direction);
      pivot = extreme;
      extreme = value;
    }
  }
  return directions;
}
const CAMERA_MOVES = [
  { field: "x", epsilon: 0.005, labels: { 1: "PAN →", "-1": "PAN ←" } },
  { field: "y", epsilon: 0.005, labels: { 1: "TILT ↓", "-1": "TILT ↑" } },
  { field: "zoom", epsilon: 0.005, labels: { 1: "ZOOM IN", "-1": "ZOOM OUT" } },
  { field: "rotation", epsilon: 0.5, labels: { 1: "ROLL ↻", "-1": "ROLL ↺" } },
];
// 紙コンテ・Inspector・再生で同じ言葉を使うためのCamera動作の要約。
export function describeCamera(b) {
  const keys = [...b.camera].sort((x, y) => x.t - y.t);
  const moves = [];
  for (const { field, epsilon, labels } of CAMERA_MOVES) {
    const directions = swingDirections(
      keys.map((k) => k[field]),
      epsilon,
    );
    // 同じ向きは一度だけ書く。往復は出た順に両方の向きを残す。
    for (const direction of [...new Set(directions)]) moves.push(labels[direction]);
  }
  return { keys, moves, hold: !moves.length };
}
// 区間の緩急は開始側キーのeaseで決める（C3）。"linear"は補間比そのままで、
// 既存ファイル・出力のフレームを1つも変えない。
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
  const raw = a.t === z.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (z.t - a.t)));
  const f = (EASE_FNS[a.ease] ?? EASE_FNS.linear)(raw);
  return Object.fromEntries(
    ["x", "y", "zoom", "rotation"].map((k) => [k, a[k] + (z[k] - a[k]) * f]),
  );
}
