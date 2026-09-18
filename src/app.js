import { frameAtTime, rowAtFrame } from "./playback.js";
import {
  Store,
  uid,
  flatten,
  load,
  cameraAt,
  cameraKeyIndex,
  BRUSH,
  describeCamera,
  CAMERA_FIELDS,
  PAPER_COLUMNS,
  LABEL_COLORS,
  LABEL_NAMES,
  LABEL_HEX,
} from "./model.js";
import { draw, cameraFrame } from "./drawing.js";
import {
  layoutPages,
  renderPage,
  download,
  COLUMN_LABEL,
  PAPER_PRESETS,
} from "./paper.js";
import {
  forEachPage,
  Job,
  Cancelled,
  ZipBuilder,
  canvasBytes,
} from "./exporter.js";
import * as animatic from "./animatic.js";
import * as tl from "./timeline.js";
import * as duration from "./derived/duration.js";
import { searchPanels } from "./derived/search.js";
import * as audio from "./audio.js";
import { AudioEngine } from "./audio.js";
import * as markers from "./markers.js";
import { ProjectRepository, Autosaver } from "./repository.js";
import { buildBundle, parseBundle, remapAssetId, planImport } from "./project-bundle.js";
import { buildShareHtml } from "./share.js";
import { IndexedDbStorage, MemoryStorage } from "./storage.js";
import { EditorSession } from "./editor-session.js";
import { EditorController } from "./application/editor-controller.js";
import { ImportController } from "./application/import-controller.js";
import { labelOf } from "./application/commands.js";
import { scrubAll, scrubNumber } from "./ui/number-scrub.js";
import { autoScroll } from "./ui/auto-scroll.js";
import * as shapeTools from "./ui/shape-tools.js";
const $ = (id) => document.getElementById(id);
const session = new EditorSession(new Store());
// 確定編集の入口はEditorControllerひとつ。副作用は下の購読で一度だけ行う。
const editor = new EditorController(session, {
  beforeCommand: () => {
    activeBefore = editor.activeId;
    stop();
  },
});
let activeBefore = null,
  afterCommit = null;
let store = editor.store,
  frame = 0,
  playing = false,
  raf,
  scaleIndex = tl.DEFAULT_SCALE,
  rows = [],
  stroke = null,
  fileDirty = false,
  // 文書の置き換えは一度に1つだけ。読み取りの待ち時間中にもう1つ始められると、
  // 「置き換えますか」を尋ねた時点と実際に置き換える時点で状態がずれ、
  // 確認なしに未保存の作業が消える。
  replacing = false;
// 選択中のCameraキー（アクティブなPanel内のindexの集合）。表示状態なので
// Projectにもlayoutにも保存しない。常に1つ以上を持つ。
let cameraKeys = new Set([0]);
const primaryCameraKey = () => Math.min(...cameraKeys);
// 目標尺（秒）。実行時の入力で、Projectにもlayoutにも保存しない（B1）。
let targetSeconds = null;
// ループ再生（B3）。表示状態でありProjectにもlayoutにも保存しない。
let loop = false;
// Cameraキーの実行時クリップボード（B4）。tの比率で持つので、尺が違う
// Panelへ貼っても動きの形は保たれる。Projectにもlayoutにも保存しない。
let cameraClipboard = null;
const sound = new AudioEngine();
let clipId = null,
  markerId = null,
  resolved = [],
  resolvedMarkers = [];
const scale = () => tl.scaleAt(scaleIndex);
const endFrame = () => tl.total(rows);
const viewport = () => $("timeline").clientWidth || 900;
// 画像素材の表示用ビットマップ。プロジェクトにはIDだけが入る。
const images = new Map();
// shapeはnullなら今まで通りのフリーハンド。line/rect/arrowのときは
// pointerdown〜upの2点から図形のpointsを作る（B7）。
const tool = { erase: false, size: 3 / 1280, shape: null, image: false };
// 前後のコマを薄く重ねる（オニオンスキン）。前は赤、後ろは青で区別する。
// 画面の見せ方なのでProjectにもlayoutにも保存しない。
const ONION = { on: false, alpha: 0.28, prev: "#d2544a", next: "#4a86d2" };
// Cameraの数値をドラッグしている間だけの一時的な値。確定前なので履歴も保存も
// 動かさない。ドラッグを離す・中止すると null に戻る。
let cameraPreview = null;
// Panelのコピー。別の作品へ貼っても絵が出るよう、参照する素材の情報も一緒に持つ。
// AnchorされたクリップもPanelと一緒に持ち運ぶ（B10）。
let clipboard = null;
const view = { zoom: 1, x: 0, y: 0 };
const activeId = () => store.selection.active;
const isSelected = (id) => store.selection.ids.includes(id);
const current = () => rows.find((r) => r.panel.id === activeId()) || rows[0];
const notice = (t) => ($("status").textContent = t);
function replaceStore(project, selection) {
  editor.replace(project, selection);
  store = editor.store;
  openScenes.clear();
  // 別の文書へ入れ替わったら、前の文書のためにデコードした素材は用がない。
  // ImageBitmapもAudioBufferもJSヒープの外に実体を持つので、このMapが抱えたまま
  // だと開き直すたびに積み上がってタブごと落ちる。同じIDが残る分（同じ素材を使う
  // Bundleの読み直しなど）はそのまま使い回す。
  // closeはしない。書き出し・録画は開始時点のimagesをコピーして持つ（E3）ので、
  // ここで閉じると進行中の出力の絵が抜ける。参照を手放せばGCが引き取る。
  const keep = new Set(store.p.assets.map((a) => a.id));
  for (const id of [...images.keys()]) if (!keep.has(id)) images.delete(id);
  sound.keepOnly(keep);
}
const panelById = (id) =>
  flatten(store.p).find((r) => r.panel.id === id)?.panel ?? null;
const startOf = (id) =>
  flatten(store.p).find((r) => r.panel.id === id)?.start ?? 0;
// 確定の直後・描画の前に一度だけ走らせたいUI状態の更新（選択中のCameraキーなど）。
function commitWith(after, run) {
  afterCommit = after;
  try {
    return run();
  } finally {
    afterCommit = null;
  }
}
const act = (name, args, after = null) =>
  commitWith(after, () => editor.execute(name, args));
// 素材取り込みは開始時の対象とSessionを固定する。完了が遅れても別の対象や
// 別の作品へは適用しない。
const imports = new ImportController(editor);
function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  // 停止時に音を残さない。次の再生は必ず予約し直す。
  sound.stop();
  $("play").textContent = "▶ 再生";
}
// 変更範囲を判定できない編集のための互換経路。順次Commandへ移す。
function edit(fn) {
  return editor.edit(fn);
}
// 一回の確定編集につき、dirty・保存予約・再描画はここで一度だけ行う。
editor.subscribe((result) => {
  store = editor.store;
  // Project差し替えは呼び出し側が画面と保存状態を作り直す。
  if (result.kind === "replace") return;
  try {
    if (result.failed) {
      notice(result.error.message);
      return;
    }
    // 変更がない操作はUndo段数も保存も消費しない。
    if (result.changed) {
      const movedActive = activeId() !== activeBefore;
      if (movedActive || result.kind === "undo" || result.kind === "redo")
        frame = startOf(activeId());
      markDirty();
      if (result.kind === "undo")
        notice(`元に戻す：${labelOf(result.undoneKind)}`);
      else if (result.kind === "redo")
        notice(`やり直す：${labelOf(result.undoneKind)}`);
    }
    afterCommit?.(result);
    render();
  } catch (e) {
    notice(e.message);
  }
});
// Ctrl/Cmdで増減、Shiftで全体順序上の範囲選択。
function select(id, e = {}) {
  stop();
  // マウス操作は常にキーボードでの範囲拡張のアンカーをリセットする。
  arrowAnchor = null;
  const all = rows.map((r) => r.panel.id);
  let ids;
  if (e.shiftKey) {
    const from = all.indexOf(store.selection.active),
      to = all.indexOf(id);
    ids = all.slice(Math.min(from, to), Math.max(from, to) + 1);
  } else if (e.ctrlKey || e.metaKey)
    ids = isSelected(id)
      ? store.selection.ids.filter((v) => v !== id)
      : [...store.selection.ids, id];
  else ids = [id];
  // 選択した時点でそのPanelの先頭へ頭出しする。これは選択操作側の作法。
  commitWith(
    () => (frame = startOf(editor.activeId)),
    () => editor.select({ active: id, ids }),
  );
}
// キーボードでの選択拡張。Shiftを押し続けている間は最初に掴んだ位置
// （アンカー）を固定し、そこから現在位置までを選択にする。他の選択操作
// （マウスクリック）が入るとselect()内でリセットする。
let arrowAnchor = null;
function moveSelection(targetIndex, extend) {
  const clamped = Math.max(0, Math.min(rows.length - 1, targetIndex));
  const target = rows[clamped];
  if (!target) return;
  if (extend) {
    if (arrowAnchor === null) arrowAnchor = activeId();
    const anchorIndex = rows.findIndex((r) => r.panel.id === arrowAnchor);
    const from = Math.min(anchorIndex, clamped),
      to = Math.max(anchorIndex, clamped);
    const ids = rows.slice(from, to + 1).map((r) => r.panel.id);
    commitWith(
      () => (frame = startOf(target.panel.id)),
      () => editor.select({ active: target.panel.id, ids }),
    );
  } else {
    arrowAnchor = null;
    select(target.panel.id);
  }
}
// 前後のShotの先頭Panelのindexを返す。全体順序でShotをまたいで移動する。
function shotBoundaryIndex(delta) {
  const i = rows.findIndex((r) => r.panel.id === activeId());
  if (delta > 0) {
    let j = i;
    while (j < rows.length - 1 && rows[j + 1].shot.id === rows[i].shot.id) j++;
    return Math.min(rows.length - 1, j + 1);
  }
  let j = i;
  while (j > 0 && rows[j - 1].shot.id === rows[i].shot.id) j--;
  if (j === 0) return 0;
  let k = j - 1;
  while (k > 0 && rows[k - 1].shot.id === rows[j - 1].shot.id) k--;
  return k;
}
function history(step) {
  return step === "undo" ? editor.undo() : editor.redo();
}
function button(text, fn, cls = "") {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  b.onclick = fn;
  return b;
}
// Panelのラベル色をTree・Strip・Timelineの見た目へ反映する（C2）。
// 色そのものはCSSではなく--label-colorへ直接入れるので、色数が増えても
// ビュー側のCSSを増やさずに済む。
function tagLabel(el, label) {
  if (!label) return;
  el.classList.add("labeled");
  el.style.setProperty("--label-color", LABEL_HEX[label]);
}
const thumbnailObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries)
      if (e.isIntersecting) {
        const b = rows.find(
          (r) => r.panel.id === e.target.dataset.panel,
        )?.panel;
        if (b) draw(e.target.getContext("2d"), b, 120, 68, null, images);
        thumbnailObserver.unobserve(e.target);
      }
  },
  { root: $("strip") },
);
// 直前に描いたときの目印。Projectのオブジェクトが同じなら表示内容も同じなので、
// TreeとStripは作り直さず、選択の印だけ付け替える。選択や矢印キーでの移動で
// 500 Panel分のDOMを毎回作り直さないための最小限の部分更新。
let painted = { project: null, shotId: null };
// 開いているSceneのidの集合。表示状態でありProjectにもlayoutにも保存しない。
// アクティブなSceneは常に開くが、他に開いたSceneがあれば閉じない。
const openScenes = new Set();
function renderTree(r) {
  openScenes.add(r.scene.id);
  $("tree").replaceChildren();
  store.p.scenes.forEach((s) => {
    const d = document.createElement("details");
    d.dataset.scene = s.id;
    d.open = openScenes.has(s.id);
    d.ontoggle = () => {
      if (d.open) openScenes.add(s.id);
      else openScenes.delete(s.id);
    };
    const summary = document.createElement("summary");
    summary.textContent = `${s.name} (${s.shots.length} Shots)`;
    summary.title = "ダブルクリックで名前を変更";
    summary.ondblclick = (e) => {
      e.preventDefault();
      rename(summary, s.name, (value) =>
        act("renameScene", { sceneId: s.id, name: value }),
      );
    };
    d.append(summary);
    s.shots.forEach((h, hi) => {
      const shot = button(h.name || `Shot ${hi + 1}`, (e) =>
        select(h.panels[0].id, e),
      );
      shot.className = "shot";
      shot.title = "ダブルクリックで名前を変更";
      shot.ondblclick = (e) => {
        e.preventDefault();
        rename(shot, h.name, (value) =>
          act("renameShot", { shotId: h.id, name: value }),
        );
      };
      d.append(shot);
      h.panels.forEach((p, pi) => {
        const b = button(
          `Panel ${pi + 1} · ${p.frames}f`,
          (e) => select(p.id, e),
          `panel ${isSelected(p.id) ? "selected" : ""}`,
        );
        b.dataset.panel = p.id;
        tagLabel(b, p.label);
        d.append(b);
      });
    });
    $("tree").append(d);
  });
}
function markTree(r) {
  openScenes.add(r.scene.id);
  for (const d of $("tree").children)
    d.open = openScenes.has(d.dataset.scene);
  for (const b of $("tree").querySelectorAll("button.panel"))
    b.classList.toggle("selected", isSelected(b.dataset.panel));
}
function renderStrip(r) {
  // サムネイルの遅延描画はStripを作り直すときだけ張り直す。
  thumbnailObserver.disconnect();
  $("strip").replaceChildren(
    ...r.shot.panels.map((p, i) => {
      const b = button(
        `P${i + 1} · ${p.frames}f`,
        () => {},
        isSelected(p.id) ? "selected" : "",
      );
      b.dataset.panel = p.id;
      tagLabel(b, p.label);
      b.onclick = (e) => {
        if (dragged) return;
        select(p.id, e);
      };
      b.onpointerdown = (e) => startReorder(e, p.id);
      const thumb = document.createElement("canvas");
      thumb.width = 120;
      thumb.height = 68;
      thumb.dataset.panel = p.id;
      b.prepend(thumb);
      thumbnailObserver.observe(thumb);
      return b;
    }),
  );
}
function markStrip() {
  for (const b of $("strip").children)
    b.classList.toggle("selected", isSelected(b.dataset.panel));
}
// 素材のデコードのように、Projectは変わらないのに絵が変わる場合に使う。
// 次のrenderでTreeとStripを作り直させ、サムネイルを描き直す。
function invalidateViews() {
  painted = { project: null, shotId: null };
}
function render() {
  rows = flatten(store.p);
  // 描画の直前に選択を現在のProjectへ正規化する。ここは通知を伴わない整合処理。
  session.store.select(store.selection);
  store = editor.store;
  resolved = audio.resolveClips(store.p, rows);
  resolvedMarkers = markers.resolveMarkers(store.p, rows);
  const r = current();
  const rebuilt = painted.project !== store.p;
  $("title").value = store.p.title;
  if (rebuilt) renderTree(r);
  else markTree(r);
  $("breadcrumb").textContent =
    `${r.scene.name}  /  ${r.shot.name || `Shot ${r.hi + 1}`}  /  Panel ${r.pi + 1}`;
  for (const k of ["frames", "dialogue", "sound", "notes"])
    $(k).value = r.panel[k];
  $("sceneName").value = r.scene.name;
  $("shotName").value = r.shot.name;
  const asset =
    r.panel.image && store.p.assets.find((a) => a.id === r.panel.image.assetId);
  $("imageOpacity").value = Math.round((r.panel.image?.opacity ?? 1) * 100);
  $("imageOpacity").disabled = $("imageClear").disabled = !r.panel.image;
  $("imageFit").value = r.panel.image?.fit ?? "contain";
  $("imageScale").value = r.panel.image?.scale ?? 1;
  $("imageFit").disabled = $("imageScale").disabled = !r.panel.image;
  $("assetInfo").textContent = asset
    ? `画像：${asset.name}（${asset.width}×${asset.height}${
        images.has(asset.id) ? "" : "・読み込めません"
      }）`
    : "画像なし";
  labelInspector(r);
  cameraInspector(r);
  soundInspector(r);
  markerInspector(r);
  if (rebuilt || painted.shotId !== r.shot.id) renderStrip(r);
  else markStrip();
  painted = { project: store.p, shotId: r.shot.id };
  timeline();
  durationInfo();
  paint();
  reveal();
}
// 総尺・目標尺との差・Shotごとの内訳（B1）。目標尺は保存しない実行時の値。
function durationInfo() {
  const s = duration.summary(store.p, rows);
  let text = `合計 ${s.frames}f / ${s.seconds.toFixed(2)}s`;
  if (targetSeconds !== null && targetSeconds > 0) {
    const gap = duration.gapTo(targetSeconds, s.frames, store.p.fps);
    text += gap.frames === 0
      ? "（目標ちょうど）"
      : `（目標${gap.frames > 0 ? "+" : ""}${gap.seconds.toFixed(2)}s）`;
  }
  $("durationSummary").textContent = text;
  const names = new Map();
  for (const sc of store.p.scenes)
    sc.shots.forEach((h, hi) => names.set(h.id, `${sc.name} / ${h.name || `Shot ${hi + 1}`}`));
  $("shotBreakdown").replaceChildren(
    ...duration.byShot(store.p, rows).map((entry) => {
      const line = document.createElement("div");
      line.textContent = `${names.get(entry.shotId)} : ${entry.frames}f / ${entry.seconds.toFixed(2)}s · ${entry.panels} Panel`;
      return line;
    }),
  );
}
// ラベル色の選択（C2）。表示はアクティブなPanelの色を映すが、適用は選択全体へ効く
// （imageOpacityなどInspectorの他の項目と同じ規則）。
function labelInspector(r) {
  $("labelSwatches").replaceChildren(
    button(
      "なし",
      () => act("setPanelLabel", { ids: editor.selectedIds, label: null }),
      `swatch none ${r.panel.label === null ? "on" : ""}`,
    ),
    ...LABEL_COLORS.map((color) => {
      const b = button(
        "",
        () => act("setPanelLabel", { ids: editor.selectedIds, label: color }),
        `swatch ${r.panel.label === color ? "on" : ""}`,
      );
      b.style.background = LABEL_HEX[color];
      b.title = LABEL_NAMES[color];
      return b;
    }),
  );
}
function cameraInspector(r) {
  const keys = r.panel.camera;
  cameraKeys = new Set([...cameraKeys].filter((i) => i >= 0 && i < keys.length));
  if (!cameraKeys.size) cameraKeys.add(0);
  const list = $("keyList");
  list.replaceChildren(
    ...keys.map((k, i) => {
      const option = document.createElement("option");
      option.value = i;
      option.selected = cameraKeys.has(i);
      option.textContent = `${Math.round(k.t * r.panel.frames)}f · X${k.x} Y${
        k.y
      } Z${k.zoom} R${k.rotation}°`;
      return option;
    }),
  );
  const motion = describeCamera(r.panel);
  $("cameraSummary").textContent = motion.hold
    ? "HOLD（動きなし）"
    : `${motion.moves.join(" / ")} · キー${keys.length}本${
        cameraKeys.size > 1 ? `（${cameraKeys.size}本選択中）` : ""
      }`;
  const key = keys[primaryCameraKey()];
  ["cx", "cy", "cz", "cr"].forEach(
    (id, i) => ($(id).value = key[CAMERA_FIELDS[i]]),
  );
  $("keyEase").value = key.ease;
  // 選んだキーが全部消えると0本になってしまう組み合わせは押せなくする。
  $("keyDelete").disabled = keys.length <= cameraKeys.size;
  $("cameraPasteReplace").disabled = $("cameraPasteMerge").disabled =
    !cameraClipboard?.length;
}
// このPanelにかかる音のみを出す。重なりで判断し、推測で結びつけない。
function soundInspector(r) {
  const here = audio.clipsInRange(resolved, r.start, r.end);
  if (!here.some((c) => c.clip.id === clipId))
    clipId = here[0]?.clip.id ?? null;
  $("clipList").replaceChildren(
    ...here.map((c) => {
      const option = document.createElement("option");
      option.value = c.clip.id;
      option.selected = c.clip.id === clipId;
      option.textContent = `${audio.TRACK_LABEL[c.clip.track]} · ${
        c.asset?.name ?? "素材不明"
      } · ${c.start}f→${c.end}f`;
      return option;
    }),
  );
  const current = here.find((c) => c.clip.id === clipId);
  for (const [id, value] of [
    ["clipGain", Math.round((current?.clip.gain ?? 1) * 100)],
    ["clipFrames", current?.clip.frames ?? ""],
    ["clipOffset", current?.clip.offset ?? ""],
  ])
    $(id).value = value;
  for (const id of ["clipGain", "clipFrames", "clipOffset", "clipDelete"])
    $(id).disabled = !current;
  const missing = current && !sound.has(current.clip.assetId);
  $("clipRepair").hidden = !missing;
  $("clipInfo").textContent = !current
    ? "このPanelにかかる音はありません"
    : missing
      ? `${current.asset?.name ?? "素材"} が見つかりません。差し替えると同じ位置で鳴ります。`
      : `${current.asset?.name} · ${sound.seconds(current.clip.assetId).toFixed(2)}秒の素材`;
}
// このPanelに立つマーカー（C1）。音声Clipと違い点なので、区間の重なりではなく
// 開始位置で判定する（markersInRangeと同じ規則）。
function markerInspector(r) {
  const here = markers.markersInRange(resolvedMarkers, r.start, r.end);
  if (!here.some((m) => m.marker.id === markerId))
    markerId = here[0]?.marker.id ?? null;
  $("markerList").replaceChildren(
    ...here.map((m) => {
      const option = document.createElement("option");
      option.value = m.marker.id;
      option.selected = m.marker.id === markerId;
      option.textContent = `${m.start}f · ${m.marker.text || "（本文なし）"}`;
      return option;
    }),
  );
  const current = here.find((m) => m.marker.id === markerId);
  $("markerText").value = current?.marker.text ?? "";
  $("markerColor").value = current?.marker.color ?? "#ffcc00";
  for (const id of ["markerText", "markerColor", "markerDelete"])
    $(id).disabled = !current;
}
// 音声レーン。波形は素材ごとに1度だけ計算し、クリップ幅に合わせて描く。
// レーン名は横スクロールしない左の列へ置く。行の高さはstyle.cssの--lane-hが
// 基準で、名前の列も同じ間隔で並べる。行の高さ切り替え（A9）で変わる。
const laneHeight = () =>
  parseFloat(getComputedStyle($("timeBody")).getPropertyValue("--lane-h")) ||
  26;
function audioTrack(px, left, width) {
  const node = $("audioTrack");
  const names = $("audioNames");
  const height = laneHeight();
  node.replaceChildren();
  names.replaceChildren();
  audio.AUDIO_TRACK_ORDER.forEach((track, index) => {
    const lane = document.createElement("div");
    lane.className = "audiolane";
    lane.style.top = `${index * height}px`;
    const name = document.createElement("div");
    name.className = "rowName audio";
    name.style.top = `${index * height}px`;
    name.textContent = audio.TRACK_LABEL[track];
    names.append(name);
    for (const item of audio.clipsInRange(
      resolved.filter((c) => c.clip.track === track),
      (left - width) / px,
      (left + width * 2) / px,
    ))
      lane.append(soundClip(item, px));
    node.append(lane);
  });
}
function soundClip(item, px) {
  const el = document.createElement("div");
  const missing = !sound.has(item.clip.assetId);
  el.className = `sound${item.clip.id === clipId ? " selected" : ""}${
    missing ? " missing" : ""
  }`;
  el.style.left = `${item.start * px}px`;
  el.style.width = `${Math.max(6, item.clip.frames * px)}px`;
  el.title = `${item.asset?.name ?? "素材不明"} · ${item.clip.frames}f`;
  // 列数は表示幅に合わせるが上限を持つ。長いクリップで巨大なCanvasを作らない。
  const columns = Math.max(2, Math.min(2000, Math.round(item.clip.frames * px)));
  const wave = sound.waveform(item.clip.assetId, columns, {
    offset: item.clip.offset,
    frames: item.clip.frames,
    fps: store.p.fps,
  });
  if (wave) {
    const canvas = document.createElement("canvas");
    canvas.width = columns;
    canvas.height = 18;
    const c = canvas.getContext("2d");
    c.fillStyle = "#8fdcc0";
    for (let i = 0; i < columns; i++) {
      const min = wave[i * 2],
        max = wave[i * 2 + 1];
      c.fillRect(i, 9 + min * 9, 1, Math.max(1, (max - min) * 9));
    }
    el.append(canvas);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = missing ? "素材なし" : (item.asset?.name ?? "");
  el.append(name);
  const trim = document.createElement("span");
  trim.className = "trim";
  trim.onpointerdown = (e) => startClipTrim(e, item, trim, el, px);
  el.append(trim);
  el.onpointerdown = (e) => startClipDrag(e, item, el, px);
  return el;
}
// Cameraキーの絶対フレーム位置。全Panelのキーをスナップ候補にする。
function allCameraKeyFrames() {
  const out = [];
  for (const r of rows)
    for (const k of r.panel.camera)
      out.push(r.start + Math.round(k.t * r.panel.frames));
  return out;
}
// 音クリップの端・Cameraキーを含めたスナップ候補を作る。
function snapCandidates() {
  return $("snap").checked
    ? tl.snapTargets(rows, store.p.fps, endFrame(), frame, {
        clips: resolved,
        keys: allCameraKeyFrames(),
      })
    : [];
}
// 吸着したときだけガイド線を出す。ドラッグ中の一時表示なのでDOMは使い回す。
function showSnapline(value, px) {
  const line = $("snapline");
  line.style.left = `${value * px}px`;
  line.hidden = false;
}
function hideSnapline() {
  $("snapline").hidden = true;
}
function startClipDrag(e, item, el, px) {
  if (e.target.className === "trim") return;
  stop();
  clipId = item.clip.id;
  const origin = e.clientX,
    start = item.start;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const scroller = autoScroll($("timeline"));
  const targets = snapCandidates();
  const next = (v) => {
    const raw = start + (v.clientX - origin) / px;
    if (!targets.length) return Math.max(0, Math.round(raw));
    const { value, hit } = tl.snapAt(raw, targets, px);
    if (hit) showSnapline(value, px);
    else hideSnapline();
    return Math.max(0, value);
  };
  el.onpointermove = (v) => {
    moved = true;
    scroller.track(v.clientX);
    el.style.left = `${next(v) * px}px`;
  };
  const finish = (v, commit) => {
    el.onpointermove = el.onpointerup = el.onpointercancel = null;
    scroller();
    const startFrame = commit && moved ? next(v) : null;
    hideSnapline();
    if (startFrame === null) return render();
    act("placeClip", { clipId: item.clip.id, startFrame });
  };
  el.onpointerup = (v) => finish(v, true);
  el.onpointercancel = (v) => finish(v, false);
}
function startClipTrim(e, item, trim, el, px) {
  e.stopPropagation();
  stop();
  clipId = item.clip.id;
  const origin = e.clientX,
    frames = item.clip.frames;
  trim.setPointerCapture(e.pointerId);
  const next = (v) =>
    Math.max(1, Math.round(frames + (v.clientX - origin) / px));
  trim.onpointermove = (v) => {
    el.style.width = `${next(v) * px}px`;
  };
  const finish = (v, commit) => {
    trim.onpointermove = trim.onpointerup = trim.onpointercancel = null;
    if (!commit) return render();
    act("trimClip", { clipId: item.clip.id, frames: next(v) });
  };
  trim.onpointerup = (v) => finish(v, true);
  trim.onpointercancel = (v) => finish(v, false);
}
// マーカーの行（C1）。音声Clipと同じ絶対フレーム換算だが、長さを持たない点なので
// ドラッグは位置の付け替え（moveMarker）だけで、トリムは無い。
function markerTrack(px, left, width) {
  const node = $("markerTrack");
  node.replaceChildren();
  for (const item of markers.markersInRange(
    resolvedMarkers,
    (left - width) / px,
    (left + width * 2) / px,
  ))
    node.append(markerFlag(item, px));
}
function markerFlag(item, px) {
  const el = document.createElement("div");
  el.className = `marker${item.marker.id === markerId ? " selected" : ""}`;
  el.style.left = `${item.start * px}px`;
  el.style.setProperty("--marker-color", item.marker.color);
  el.title = `${item.start}f · ${item.marker.text || "（本文なし）"}`;
  el.onpointerdown = (e) => startMarkerDrag(e, item, el, px);
  return el;
}
function startMarkerDrag(e, item, el, px) {
  stop();
  markerId = item.marker.id;
  const origin = e.clientX,
    start = item.start;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const scroller = autoScroll($("timeline"));
  const targets = snapCandidates();
  const next = (v) => {
    const raw = start + (v.clientX - origin) / px;
    if (!targets.length) return Math.max(0, Math.round(raw));
    const { value, hit } = tl.snapAt(raw, targets, px);
    if (hit) showSnapline(value, px);
    else hideSnapline();
    return Math.max(0, value);
  };
  el.onpointermove = (v) => {
    moved = true;
    scroller.track(v.clientX);
    el.style.left = `${next(v) * px}px`;
  };
  const finish = (v, commit) => {
    el.onpointermove = el.onpointerup = el.onpointercancel = null;
    scroller();
    const startFrame = commit && moved ? next(v) : null;
    hideSnapline();
    if (startFrame === null) return render();
    act("moveMarker", { markerId: item.marker.id, startFrame });
  };
  el.onpointerup = (v) => finish(v, true);
  el.onpointercancel = (v) => finish(v, false);
}
// 選択が変わったときだけ視界へ入れる。ユーザーのスクロールを毎回奪わない。
let revealed = null;
function reveal() {
  if (revealed === activeId()) return;
  revealed = activeId();
  for (const sel of ["#strip .selected", "#tree .panel.selected"])
    document.querySelector(sel)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  const view = $("timeline");
  view.scrollLeft = tl.follow(
    current().start,
    scale(),
    view.scrollLeft,
    viewport(),
  );
}
// その場で名前を編集する。Escでキャンセル、Enterと離脱で確定。
function rename(node, value, commit) {
  const input = document.createElement("input");
  input.className = "rename";
  input.value = value;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.replaceWith(node);
    if (save && input.value !== value) commit(input.value.slice(0, 60));
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  node.replaceWith(input);
  input.focus();
  input.select();
}
// Stripのドラッグ並べ替え。中断しても順序も描画も壊さない。
let dragged = null;
function startReorder(e, id) {
  if (e.button !== 0) return;
  const origin = e.clientX,
    node = e.currentTarget;
  node.setPointerCapture(e.pointerId);
  // 見えている範囲の外まで運べるよう、端に寄せている間は#stripを自動で送る。
  const scroller = autoScroll($("strip"));
  const clear = () => {
    for (const el of $("strip").children)
      el.classList.remove("before", "after");
  };
  const targetAt = (x) => {
    for (const el of $("strip").children) {
      const box = el.getBoundingClientRect();
      if (x >= box.left && x <= box.right && el.dataset.panel !== id)
        return {
          id: el.dataset.panel,
          place: x < box.left + box.width / 2 ? "before" : "after",
        };
    }
    return null;
  };
  node.onpointermove = (v) => {
    if (!dragged && Math.abs(v.clientX - origin) < 6) return;
    dragged = id;
    node.classList.add("dragging");
    scroller.track(v.clientX);
    clear();
    const target = targetAt(v.clientX);
    if (target)
      $("strip")
        .querySelector(`[data-panel="${target.id}"]`)
        ?.classList.add(target.place);
  };
  const end = (v, commit) => {
    node.onpointermove = node.onpointerup = node.onpointercancel = null;
    node.classList.remove("dragging");
    scroller();
    clear();
    const target = dragged && commit ? targetAt(v.clientX) : null;
    if (target) {
      const ids = isSelected(id) ? store.selection.ids : [id];
      act("reorderPanels", { ids, anchorId: target.id, place: target.place });
    } else if (dragged) render();
    setTimeout(() => (dragged = null));
  };
  node.onpointerup = (v) => end(v, true);
  node.onpointercancel = (v) => end(v, false);
}
// TimelineのDOMはEngineが決めた範囲・目盛・座標をそのまま描く。
function timeline() {
  const px = scale(),
    end = endFrame(),
    left = $("timeline").scrollLeft,
    width = viewport();
  $("track").style.width = `${Math.max(end * px, width)}px`;
  ruler(px, end, left, width);
  clips(px, left, width);
  cameraTrack(px, left, width);
  audioTrack(px, left, width);
  markerTrack(px, left, width);
  const span = tl.selectionRange(rows, store.selection.ids);
  const band = $("band");
  band.style.left = `${span.start * px}px`;
  band.style.width = `${Math.max(2, span.frames * px)}px`;
  $("range").textContent = `選択 ${span.panels} Panel · ${span.frames}f / ${(
    span.frames / store.p.fps
  ).toFixed(2)}s`;
  $("head").style.left = `${frame * px}px`;
  workAreaView(px);
}
// ワークエリア（C5）。設定中はTimelineへ帯で示し、Inspector横のoutputへ範囲を出す。
function workAreaView(px) {
  const area = store.p.workArea;
  const band = $("workAreaBand");
  band.hidden = !area;
  if (area) {
    band.style.left = `${area.from * px}px`;
    band.style.width = `${Math.max(2, (area.to - area.from) * px)}px`;
  }
  $("workAreaInfo").textContent = area
    ? `ワークエリア ${area.from}〜${area.to}f`
    : "ワークエリア未設定";
  $("workAreaClear").disabled = !area;
}
function ruler(px, end, left, width) {
  const node = $("ruler");
  node.replaceChildren();
  for (const t of tl.ticks(store.p.fps, px, left, width, end)) {
    const mark = document.createElement("span");
    mark.className = `tick${t.second ? " second" : ""}`;
    mark.style.left = `${t.frame * px}px`;
    mark.textContent = t.label;
    node.append(mark);
  }
}
function clips(px, left, width) {
  const node = $("clips");
  node.replaceChildren();
  for (const r of tl.visible(rows, px, left, width)) {
    const rect = tl.clipRect(r, px);
    const b = button(
      `P${r.pi + 1} · ${r.panel.frames}f`,
      () => {},
      `clip ${isSelected(r.panel.id) ? "selected" : ""}`,
    );
    b.style.left = `${rect.left}px`;
    b.style.width = `${rect.width}px`;
    b.dataset.panel = r.panel.id;
    tagLabel(b, r.panel.label);
    b.onclick = (e) => {
      // ドラッグで並べ替えた直後のクリックは選択に使わない。
      if (dragged || e.target.className?.includes("handle")) return;
      select(r.panel.id, e);
    };
    b.onpointerdown = (e) => startClipReorder(e, r, b);
    // 左端は「前のPanelとの境界」。先頭Panel（全体順序で最初）には出さない。
    const at = rows.indexOf(r);
    if (at > 0) {
      const start = document.createElement("span");
      start.className = "handle start";
      start.onpointerdown = (e) => startBoundary(e, rows[at - 1], r, b);
      b.append(start);
    }
    const h = document.createElement("span");
    h.className = "handle end";
    h.onpointerdown = (e) => startResize(e, r, b, h);
    b.append(h);
    node.append(b);
  }
}
// Timeline上でPanelを掴んで並べ替える。落とす先はコマの境界で示し、
// 離すまでProjectを書き換えない。Stripのドラッグと同じCommandへ着地する。
function startClipReorder(e, r) {
  if (e.button !== 0 || e.target.className?.includes("handle")) return;
  const id = r.panel.id;
  const node = e.currentTarget;
  const origin = e.clientX;
  const px = scale();
  node.setPointerCapture(e.pointerId);
  // 見えている範囲の外まで運べるよう、端に寄せている間は#timelineを自動で送る。
  const scroller = autoScroll($("timeline"));
  const moving = () => (isSelected(id) ? store.selection.ids : [id]);
  const marker = document.createElement("div");
  marker.className = "drop";
  const targetAt = (clientX) => {
    const f = tl.frameAt(
      clientX - $("track").getBoundingClientRect().left,
      scale(),
      endFrame(),
    );
    const row = rows.find((v) => f >= v.start && f < v.end) ?? rows.at(-1);
    if (!row) return null;
    const place = f - row.start < row.panel.frames / 2 ? "before" : "after";
    // 掴んでいるPanel自身へは落とせない。落としても動かない位置は示さない。
    return moving().includes(row.panel.id) ? null : { row, place };
  };
  const show = (target) => {
    if (!target) return marker.remove();
    marker.style.left = `${(target.place === "before" ? target.row.start : target.row.end) * px}px`;
    $("track").append(marker);
  };
  node.onpointermove = (v) => {
    if (!dragged && Math.abs(v.clientX - origin) < 6) return;
    dragged = id;
    node.classList.add("dragging");
    scroller.track(v.clientX);
    show(targetAt(v.clientX));
  };
  const end = (v, commit) => {
    node.onpointermove = node.onpointerup = node.onpointercancel = null;
    node.classList.remove("dragging");
    scroller();
    marker.remove();
    const target = dragged && commit ? targetAt(v.clientX) : null;
    if (target)
      act("reorderPanels", {
        ids: moving(),
        anchorId: target.row.panel.id,
        place: target.place,
      });
    else if (dragged) timeline();
    setTimeout(() => (dragged = null));
  };
  node.onpointerup = (v) => end(v, true);
  node.onpointercancel = (v) => end(v, false);
}
// 端のドラッグはスナップ候補へ吸着し、離すまでプロジェクトを書き換えない。
function startResize(e, r, clip, handle) {
  e.stopPropagation();
  stop();
  const px = scale(),
    origin = e.clientX,
    start = r.panel.frames;
  const targets = snapCandidates();
  const next = (v) => {
    const raw = r.start + start + (v.clientX - origin) / px;
    let snapped = Math.round(raw);
    if (targets.length) {
      const hit = tl.snapAt(raw, targets, px);
      snapped = hit.value;
      if (hit.hit) showSnapline(hit.value, px);
      else hideSnapline();
    }
    return Math.max(1, Math.min(864000, snapped - r.start));
  };
  handle.setPointerCapture(e.pointerId);
  handle.onpointermove = (v) => {
    clip.style.width = `${next(v) * px}px`;
  };
  handle.onpointerup = (v) => {
    const frames = next(v);
    handle.onpointermove = handle.onpointerup = null;
    hideSnapline();
    act("setPanelFrames", { ids: [r.panel.id], frames });
  };
  handle.onpointercancel = () => {
    handle.onpointermove = handle.onpointerup = null;
    hideSnapline();
    timeline();
  };
}
// 左端＝前のPanelとの境界。合計尺は変えず、双方1f未満にはしない。
// leftRow/rightRowはflatten()の全体順序で決めた隣接関係（Shot/Sceneをまたいでもよい）。
function startBoundary(e, leftRow, rightRow, rightClip) {
  e.stopPropagation();
  stop();
  const px = scale(),
    origin = e.clientX,
    startBoundaryFrame = rightRow.start,
    minFrame = leftRow.start + 1,
    maxFrame = rightRow.end - 1;
  const targets = snapCandidates();
  const next = (v) => {
    const raw = startBoundaryFrame + (v.clientX - origin) / px;
    let snapped = Math.round(raw);
    if (targets.length) {
      const hit = tl.snapAt(raw, targets, px);
      snapped = hit.value;
      if (hit.hit) showSnapline(hit.value, px);
      else hideSnapline();
    }
    return Math.max(minFrame, Math.min(maxFrame, snapped));
  };
  const leftClip = $("clips").querySelector(
    `[data-panel="${leftRow.panel.id}"]`,
  );
  rightClip.setPointerCapture(e.pointerId);
  rightClip.onpointermove = (v) => {
    const boundary = next(v);
    const leftFrames = boundary - leftRow.start;
    rightClip.style.left = `${boundary * px}px`;
    rightClip.style.width = `${(rightRow.end - boundary) * px}px`;
    if (leftClip) leftClip.style.width = `${leftFrames * px}px`;
  };
  const finish = () => {
    rightClip.onpointermove = rightClip.onpointerup = rightClip.onpointercancel = null;
    hideSnapline();
  };
  rightClip.onpointerup = (v) => {
    const boundary = next(v);
    finish();
    act("setBoundary", {
      leftId: leftRow.panel.id,
      rightId: rightRow.panel.id,
      leftFrames: boundary - leftRow.start,
    });
  };
  rightClip.onpointercancel = () => {
    finish();
    timeline();
  };
}
// Cameraトラック：Panelごとのレーンにキーを置く。ドラッグで移動、ダブルクリックで追加、
// 何もないところをドラッグすると矩形選択になる（A10）。
function cameraTrack(px, left, width) {
  const node = $("cameraTrack");
  node.replaceChildren();
  for (const r of tl.visible(rows, px, left, width)) {
    const rect = tl.clipRect(r, px);
    const lane = document.createElement("div");
    lane.className = `lane${r.panel.id === activeId() ? " active" : ""}`;
    lane.style.left = `${rect.left}px`;
    lane.style.width = `${rect.width}px`;
    lane.title = describeCamera(r.panel).moves.join(" / ") || "HOLD";
    lane.ondblclick = (e) => {
      const f = localFrame(e, r, px);
      const t = f / r.panel.frames;
      act("putCameraKey", { panelId: r.panel.id, t, values: {} }, () => {
        cameraKeys = new Set([Math.max(0, cameraKeyIndex(panelById(r.panel.id), t))]);
      });
    };
    lane.onpointerdown = (e) => startKeyMarquee(e, r, lane, px);
    r.panel.camera.forEach((k, index) => {
      const dot = document.createElement("span");
      dot.className = `camkey${
        r.panel.id === activeId() && cameraKeys.has(index) ? " selected" : ""
      }`;
      dot.dataset.index = index;
      dot.style.left = `${k.t * r.panel.frames * px}px`;
      dot.title = `${Math.round(k.t * r.panel.frames)}f`;
      dot.onpointerdown = (e) => startKeyDrag(e, r, index, dot, px);
      lane.append(dot);
    });
    node.append(lane);
  }
}
const localFrame = (e, r, px) =>
  Math.max(
    0,
    Math.min(
      r.panel.frames,
      Math.round(
        (e.clientX - $("track").getBoundingClientRect().left) / px - r.start,
      ),
    ),
  );
// 選んだキーの見た目だけを付け替える。フル再描画（cameraTrackの作り直し）はしない。
function markCameraKeys() {
  for (const el of $("cameraTrack").querySelectorAll(".camkey"))
    el.classList.toggle(
      "selected",
      el.closest(".lane").classList.contains("active") &&
        cameraKeys.has(Number(el.dataset.index)),
    );
  cameraInspector(current());
}
// クリックで1つだけ選ぶ／Shiftクリックで追加・除外／既に選択中のキーを掴んで
// ドラッグすると選択している全部を同じ量だけ一緒に動かす（A10）。
function startKeyDrag(e, r, index, dot, px) {
  e.stopPropagation();
  stop();
  const samePanel = r.panel.id === activeId();
  if (e.shiftKey && samePanel) {
    const next = new Set(cameraKeys);
    if (next.has(index) && next.size > 1) next.delete(index);
    else next.add(index);
    cameraKeys = next;
    markCameraKeys();
    return;
  }
  const selected = samePanel && cameraKeys.has(index) ? [...cameraKeys] : [index];
  let moved = false;
  dot.setPointerCapture(e.pointerId);
  const lane = dot.parentElement;
  const originals = new Map(selected.map((i) => [i, r.panel.camera[i].t]));
  const dots = new Map(
    selected.map((i) => [i, lane.querySelector(`.camkey[data-index="${i}"]`)]),
  );
  const position = (v) => localFrame(v, r, px);
  const anchorFrame = originals.get(index) * r.panel.frames;
  dot.onpointermove = (v) => {
    moved = true;
    const deltaFrames = position(v) - anchorFrame;
    for (const [i, t] of originals) {
      const el = dots.get(i);
      if (el) el.style.left = `${(t * r.panel.frames + deltaFrames) * px}px`;
    }
  };
  const finish = (v, commit) => {
    dot.onpointermove = dot.onpointerup = dot.onpointercancel = null;
    if (!commit) return timeline();
    // 動かさなかったときは位置を書き戻さない。選択をこの1つへ絞るだけ。
    if (!moved)
      return commitWith(
        () => (cameraKeys = new Set([index])),
        () => editor.select({ active: r.panel.id, ids: [r.panel.id] }),
      );
    const deltaT = (position(v) - anchorFrame) / r.panel.frames;
    act(
      "moveCameraKeys",
      { panelId: r.panel.id, indexes: selected, deltaT },
      () => {
        const b = panelById(r.panel.id) ?? r.panel;
        // 並べ替えでindexが変わるので、動かした先のフレーム位置から選び直す。
        cameraKeys = new Set(
          [...originals.values()].map((t) =>
            cameraKeyIndexAt(b, Math.round((t + deltaT) * r.panel.frames), 0),
          ),
        );
      },
    );
  };
  dot.onpointerup = (v) => finish(v, true);
  dot.onpointercancel = (v) => finish(v, false);
}
// Cameraレーンの何もない場所をドラッグすると矩形で複数のキーを選べる。
function startKeyMarquee(e, r, lane, px) {
  if (e.button !== 0) return;
  e.stopPropagation();
  stop();
  const startX = e.clientX;
  const laneLeft = lane.getBoundingClientRect().left;
  const overlay = document.createElement("div");
  overlay.className = "camkeyMarquee";
  overlay.hidden = true;
  lane.append(overlay);
  let box = null;
  lane.setPointerCapture(e.pointerId);
  lane.onpointermove = (v) => {
    const x0 = Math.min(startX, v.clientX) - laneLeft,
      x1 = Math.max(startX, v.clientX) - laneLeft;
    if (x1 - x0 < 3) {
      overlay.hidden = true;
      box = null;
      return;
    }
    overlay.hidden = false;
    overlay.style.left = `${x0}px`;
    overlay.style.width = `${x1 - x0}px`;
    box = [x0, x1];
  };
  const finish = (commit) => {
    lane.onpointermove = lane.onpointerup = lane.onpointercancel = null;
    overlay.remove();
    if (!commit || !box) return;
    const [x0, x1] = box;
    const hits = r.panel.camera
      .map((k, i) => [i, k.t * r.panel.frames * px])
      .filter(([, x]) => x >= x0 && x <= x1)
      .map(([i]) => i);
    if (!hits.length) return;
    if (r.panel.id !== activeId())
      return commitWith(
        () => (cameraKeys = new Set(hits)),
        () => editor.select({ active: r.panel.id, ids: [r.panel.id] }),
      );
    cameraKeys = e.shiftKey ? new Set([...cameraKeys, ...hits]) : new Set(hits);
    markCameraKeys();
  };
  lane.onpointerup = () => finish(true);
  lane.onpointercancel = () => finish(false);
}
// 移動後のキーは時刻順に並び替わるので、位置から選び直す。
function cameraKeyIndexAt(b, f, fallback) {
  if (f === null) return fallback;
  const t = f / b.frames;
  let best = 0;
  b.camera.forEach((k, i) => {
    if (Math.abs(k.t - t) < Math.abs(b.camera[best].t - t)) best = i;
  });
  return best;
}
function paint(preview = false) {
  const r = preview ? rowAtFrame(rows, frame) : current();
  const context = $("drawing").getContext("2d");
  draw(
    context,
    r.panel,
    1280,
    720,
    preview ? cameraAt(r.panel, (frame - r.start) / r.panel.frames) : null,
    images,
    preview ? null : view,
  );
  // 再生中は今のコマだけを見せる。編集中だけ前後を重ねる。
  if (!preview && ONION.on) {
    const at = rows.indexOf(r);
    for (const [row, tint] of [
      [rows[at - 1], ONION.prev],
      [rows[at + 1], ONION.next],
    ])
      if (row)
        draw(context, row.panel, 1280, 720, null, images, view, {
          background: false,
          alpha: ONION.alpha,
          tint,
        });
  }
  // Cameraの数値をドラッグしている間だけ、今どこを写すかを枠で示す。
  // 対象のPanelを見ているときだけ描き、実際の絵は変形しない。
  if (!preview && cameraPreview && cameraPreview.panelId === r.panel.id)
    cameraFrame(context, cameraPreview.values, 1280, 720);
  $("time").textContent = `${Math.floor(frame / store.p.fps)}s : ${Math.floor(
    frame % store.p.fps,
  )
    .toString()
    .padStart(2, "0")}f`;
  $("head").style.left = `${frame * scale()}px`;
}
// UIの操作名からCommandへの対応。編集の計算はcommands.js側にある。
const acts = {
  add: () => act("addPanel", { activeId: activeId() }),
  duplicate: () =>
    act("duplicatePanels", {
      ids: editor.selectedIds,
      withAudio: $("dupAudio").checked,
    }),
  delete: () => act("deletePanels", { ids: editor.selectedIds }),
  split: () => act("splitShot", { activeId: activeId() }),
  merge: () => act("mergeShot", { activeId: activeId() }),
  scene: () => act("addScene", {}),
  undo: () => history("undo"),
  redo: () => history("redo"),
  copy: () => copyPanels(),
  cut: () => {
    if (copyPanels()) act("deletePanels", { ids: editor.selectedIds });
  },
  paste: () => {
    if (!clipboard) return notice("コピーしたPanelがありません");
    act("pastePanels", {
      afterId: activeId(),
      panels: clipboard.panels,
      assets: clipboard.assets,
      clips: clipboard.clips,
      markers: clipboard.markers,
    });
    notice(`${clipboard.panels.length} Panelを貼り付けました`);
  },
};
// 選択中のPanelを全体の順序で控える。Projectは変えないので履歴も保存も動かない。
function copyPanels() {
  const ids = new Set(editor.selectedIds);
  const panels = rows.filter((r) => ids.has(r.panel.id)).map((r) => r.panel);
  if (!panels.length) return false;
  const clips = store.p.audio.filter((c) => ids.has(c.anchor));
  const markerList = store.p.markers.filter((m) => ids.has(m.anchor));
  const used = new Set(panels.map((b) => b.image?.assetId).filter(Boolean));
  for (const clip of clips) used.add(clip.assetId);
  clipboard = {
    panels: panels.map((b) => structuredClone(b)),
    clips: clips.map((c) => structuredClone(c)),
    markers: markerList.map((m) => structuredClone(m)),
    assets: store.p.assets
      .filter((asset) => used.has(asset.id))
      .map((asset) => structuredClone(asset)),
  };
  notice(`${panels.length} Panelをコピーしました`);
  return true;
}
for (const [name, delta] of [
  ["left", -1],
  ["right", 1],
])
  acts[name] = () => act("nudgePanel", { activeId: activeId(), delta });
document
  .querySelectorAll("[data-act]")
  .forEach((b) => (b.onclick = acts[b.dataset.act]));
for (const k of ["frames", "dialogue", "sound", "notes"])
  $(k).onchange = () =>
    k === "frames"
      ? act("setPanelFrames", {
          ids: editor.selectedIds,
          frames: Number($(k).value),
        })
      : act("setPanelField", {
          ids: editor.selectedIds,
          field: k,
          value: $(k).value,
        });
$("title").onchange = () => act("setTitle", { title: $("title").value });
// 選択Panelの尺を合計フレーム数で等分する（B6）。「全部同じ尺」は既存の
// #frames欄（setPanelFrames）が複数対応なのでそのまま使える。
$("distribute").onclick = () => {
  const total = Number($("distributeTotal").value);
  if (!Number.isFinite(total) || total < 1)
    return notice("等分する合計フレーム数を入力してください");
  act("distributeFrames", { ids: editor.selectedIds, total });
};
// キーは再生ヘッドがあるPanelへ置く。そのPanelを選択し直すので次の操作が続けやすい。
$("key").onclick = () => {
  const target = rowAtFrame(rows, Math.round(frame));
  const local = Math.max(
    0,
    Math.min(target.panel.frames, Math.round(frame) - target.start),
  );
  const t = local / target.panel.frames;
  act(
    "putCameraKey",
    {
      panelId: target.panel.id,
      t,
      values: target.panel.id === activeId() ? values() : {},
    },
    () => {
      cameraKeys = new Set([Math.max(0, cameraKeyIndex(panelById(target.panel.id), t))]);
    },
  );
};
$("keyDelete").onclick = () => {
  const indexes = [...cameraKeys];
  act(
    "deleteCameraKey",
    { panelId: activeId(), indexes },
    (result) => {
      if (result.changed)
        cameraKeys = new Set([Math.max(0, Math.min(...indexes) - 1)]);
    },
  );
};
$("keyList").onchange = () => {
  cameraKeys = new Set([Number($("keyList").value)]);
  render();
};
// Cameraキーのコピー/貼り付け（B4）。選んでいる本数分をコピーし、尺が
// 違うPanelへもtの比率のまま貼れる。
$("cameraCopy").onclick = () => {
  const keys = current().panel.camera;
  cameraClipboard = [...cameraKeys]
    .sort((a, b) => a - b)
    .map((i) => ({ ...keys[i] }));
  notice(`Cameraキーを${cameraClipboard.length}本コピーしました`);
  cameraInspector(current());
};
for (const [id, mode] of [
  ["cameraPasteReplace", "replace"],
  ["cameraPasteMerge", "merge"],
])
  $(id).onclick = () =>
    act("pasteCameraKeys", { panelId: activeId(), keys: cameraClipboard, mode });
const values = () =>
  Object.fromEntries(
    ["cx", "cy", "cz", "cr"].map((id, i) => [
      CAMERA_FIELDS[i],
      Number($(id).value),
    ]),
  );
for (const id of ["cx", "cy", "cz", "cr"])
  $(id).onchange = () => {
    // 確定した瞬間に一時的な値は不要になる。paint()はrender()の中で呼ばれる。
    cameraPreview = null;
    act("setCameraValues", {
      panelId: activeId(),
      indexes: [...cameraKeys],
      values: values(),
    });
  };
// 緩急（C3）はそのキーから次のキーまでの区間に効く。他の値と同じく
// 選択中の全キーへまとめて適用する。
$("keyEase").onchange = () =>
  act("setCameraValues", {
    panelId: activeId(),
    indexes: [...cameraKeys],
    values: { ease: $("keyEase").value },
  });
// ドラッグ中はProjectを変えず、Stageだけ一時的な値で描く。離すと上のonchangeが
// 一度だけ確定する。中止（PointerCancel）では掴む前の値へ戻り、履歴も動かさない。
for (const id of ["cx", "cy", "cz", "cr"])
  scrubNumber($(id), {
    onPreview: () => {
      cameraPreview = { panelId: activeId(), values: values() };
      paint();
    },
    onCancel: () => {
      cameraPreview = null;
      paint();
    },
  });
// 再生範囲（B3/C5）。複数Panelを選択していればその範囲を再生する。ループの
// ときはワークエリアがあればそれを、無ければ現在のShot全体をループする。
// 通常再生はこれまで通り現在位置から末尾まで（ワークエリアがあっても奪わない）。
function playRange() {
  const span = tl.selectionRange(rows, store.selection.ids);
  if (span && span.panels > 1) return { from: span.start, to: span.end };
  if (loop) {
    if (store.p.workArea) return store.p.workArea;
    const shotRows = rows.filter((r) => r.shot.id === current().shot.id);
    return { from: shotRows[0].start, to: shotRows.at(-1).end };
  }
  return { from: frame >= endFrame() ? 0 : Math.round(frame), to: endFrame() };
}
$("play").onclick = () => {
  if (playing) {
    stop();
    return;
  }
  playing = true;
  $("play").textContent = "■ 停止";
  const { from, to } = playRange();
  const playFrom = (base) => {
    frame = base;
    const start = performance.now();
    // 音があるときは音声時計を基準にする。無いときだけ表示用の時計を使う。
    const schedule = audio.scheduleFor(resolved, base, store.p.fps, to);
    if (schedule.length) sound.play(schedule, base, store.p.fps);
    const tick = (now) => {
      frame =
        sound.frameAt(store.p.fps) ?? frameAtTime(base, start, now, store.p.fps, to);
      frame = Math.max(base, Math.min(to, frame));
      const reachedEnd = frame >= to;
      if (reachedEnd) frame = to;
      paint(true);
      if ($("followHead").checked) {
        const view = $("timeline");
        view.scrollLeft = tl.follow(frame, scale(), view.scrollLeft, viewport());
      }
      if (reachedEnd) {
        if (loop) playFrom(from);
        else stop();
        return;
      }
      if (playing) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  playFrom(from);
};
$("loop").onchange = () => {
  loop = $("loop").checked;
};
// ワークエリア（C5）。IN/OUTは再生ヘッドの位置を使い、逆転しないよう詰める。
// Store.edit側でも総尺を超えないよう詰め直すので、ここでは大まかな整合だけ見る。
$("workAreaIn").onclick = () => {
  const from = Math.round(frame);
  const to = store.p.workArea?.to ?? endFrame();
  act("setWorkArea", { workArea: { from: Math.min(from, to - 1), to } });
};
$("workAreaOut").onclick = () => {
  const to = Math.round(frame);
  const from = store.p.workArea?.from ?? 0;
  act("setWorkArea", { workArea: { from, to: Math.max(to, from + 1) } });
};
$("workAreaClear").onclick = () => act("setWorkArea", { workArea: null });
function zoomTo(index, anchorFrame = frame) {
  const previous = scale();
  scaleIndex = Math.max(0, Math.min(tl.SCALES.length - 1, index));
  $("zoom").value = scaleIndex;
  $("timeline").scrollLeft = tl.anchorScroll(
    $("timeline").scrollLeft,
    previous,
    scale(),
    anchorFrame,
    viewport(),
  );
  timeline();
}
$("zoom").oninput = () => zoomTo(Number($("zoom").value));
$("fitTime").onclick = () =>
  zoomTo(tl.fitScaleIndex(endFrame(), viewport()), 0);
// ホイールは指した時刻を基準に拡大縮小する。素の縦スクロールは横移動に使う。
$("timeline").onwheel = (e) => {
  const view = $("timeline");
  if (e.ctrlKey || e.altKey || !e.deltaY) {
    e.preventDefault();
    const anchor = tl.frameAt(
      e.clientX - $("track").getBoundingClientRect().left,
      scale(),
      endFrame(),
    );
    zoomTo(scaleIndex + (e.deltaY < 0 ? 1 : -1), anchor);
    return;
  }
  if (!e.shiftKey) {
    e.preventDefault();
    view.scrollLeft += e.deltaY;
  }
};
$("timeline").onscroll = () => timeline();
// 目盛と空き領域はスクラブ。整数フレームでPanel境界をまたぐ。
$("track").onpointerdown = (e) => {
  if (
    ![$("track"), $("ruler"), $("clips"), $("cameraTrack")].includes(e.target)
  )
    return;
  stop();
  const targets = $("snap").checked
    ? tl.snapTargets(rows, store.p.fps, endFrame(), null, {
        clips: resolved,
        keys: allCameraKeyFrames(),
      })
    : [];
  const seek = (v) => {
    const raw = tl.frameAt(
      v.clientX - $("track").getBoundingClientRect().left,
      scale(),
      endFrame(),
    );
    if (targets.length && !v.altKey) {
      const hit = tl.snapAt(raw, targets, scale());
      frame = hit.value;
      if (hit.hit) showSnapline(hit.value, scale());
      else hideSnapline();
    } else {
      frame = raw;
      hideSnapline();
    }
    paint(true);
  };
  $("track").setPointerCapture(e.pointerId);
  seek(e);
  $("track").onpointermove = seek;
  $("track").onpointerup = $("track").onpointercancel = () => {
    $("track").onpointermove = null;
    hideSnapline();
  };
};
// 画面座標→表示変換を戻した正規化座標。ズーム/パン中でも描いた位置がずれない。
function point(e, clamp = true) {
  const r = $("drawing").getBoundingClientRect(),
    ratio = 16 / 9;
  let w = r.width,
    h = w / ratio;
  if (h > r.height) {
    h = r.height;
    w = h * ratio;
  }
  const fit = (v) => (clamp ? Math.max(0, Math.min(1, v)) : v);
  return [
    fit((e.clientX - r.left - (r.width - w) / 2) / w / view.zoom + view.x),
    fit((e.clientY - r.top - (r.height - h) / 2) / h / view.zoom + view.y),
  ];
}
const pressure = (e) =>
  e.pointerType === "pen" && e.pressure > 0
    ? Math.max(0.05, Math.min(1, e.pressure))
    : 1;
function setView(zoom, x, y) {
  view.zoom = Math.max(1, Math.min(8, zoom));
  // 1倍では常に全体を表示し、拡大時も外側へ行き過ぎない。
  const span = 1 - 1 / view.zoom;
  view.x = Math.max(0, Math.min(span, x));
  view.y = Math.max(0, Math.min(span, y));
  $("viewInfo").textContent = `${Math.round(view.zoom * 100)}%`;
  paint();
}
let panning = null,
  shapeStart = null,
  imageDrag = null;
// 直線・矩形・矢印のpointsを作る。ドラッグがほぼ無いクリックは何も足さない
// （フリーハンドの1点＝点とは違い、図形は最低限の大きさが要る）。Shiftで
// 直線/矢印は45度刻み、矩形は正方形へ吸着する（B7）。
function shapeStrokes(x0, y0, x1, y1, snap) {
  if (Math.hypot(x1 - x0, y1 - y0) < 0.004) return [];
  const wrap = (points) => ({ size: tool.size, erase: false, points });
  if (tool.shape === "line") return [wrap(shapeTools.linePoints(x0, y0, x1, y1, snap))];
  if (tool.shape === "rect") return [wrap(shapeTools.rectPoints(x0, y0, x1, y1, snap))];
  if (tool.shape === "arrow")
    return shapeTools.arrowPointSets(x0, y0, x1, y1, snap).map(wrap);
  return [];
}
$("drawing").onpointerdown = (e) => {
  stop();
  if (e.button === 1 || e.altKey) {
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    $("drawing").setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  // 画像移動（C4）。画像が無いPanelでは掴んでも何も動かさない。
  if (tool.image) {
    const b = current().panel;
    $("drawing").setPointerCapture(e.pointerId);
    if (!b.image) return;
    imageDrag = { start: point(e, false), offset: { ...b.image.offset } };
    return;
  }
  if (tool.shape) {
    shapeStart = point(e);
    $("drawing").setPointerCapture(e.pointerId);
    return;
  }
  stroke = {
    size: tool.size,
    erase: tool.erase,
    points: [[...point(e), pressure(e)]],
  };
  $("drawing").setPointerCapture(e.pointerId);
};
$("drawing").onpointermove = (e) => {
  if (panning) {
    const r = $("drawing").getBoundingClientRect();
    setView(
      view.zoom,
      panning.vx - (e.clientX - panning.x) / r.width / view.zoom,
      panning.vy - (e.clientY - panning.y) / r.height / view.zoom,
    );
    return;
  }
  if (imageDrag) {
    const [x, y] = point(e, false);
    imageDrag.preview = {
      x: imageDrag.offset.x + (x - imageDrag.start[0]),
      y: imageDrag.offset.y + (y - imageDrag.start[1]),
    };
    draw(
      $("drawing").getContext("2d"),
      { ...current().panel, image: { ...current().panel.image, offset: imageDrag.preview } },
      1280,
      720,
      null,
      images,
      view,
    );
    return;
  }
  if (shapeStart) {
    const [x1, y1] = point(e);
    const strokes = shapeStrokes(shapeStart[0], shapeStart[1], x1, y1, e.shiftKey);
    draw(
      $("drawing").getContext("2d"),
      { ...current().panel, strokes: [...current().panel.strokes, ...strokes] },
      1280,
      720,
      null,
      images,
      view,
    );
    return;
  }
  if (!stroke) return;
  stroke.points.push([...point(e), pressure(e)]);
  draw(
    $("drawing").getContext("2d"),
    { ...current().panel, strokes: [...current().panel.strokes, stroke] },
    1280,
    720,
    null,
    images,
    view,
  );
};
$("drawing").onpointerup = (e) => {
  panning = null;
  if (imageDrag) {
    const offset = imageDrag.preview ?? imageDrag.offset;
    imageDrag = null;
    act("setImageTransform", { panelId: activeId(), offset });
    return;
  }
  if (shapeStart) {
    const [x1, y1] = point(e);
    const strokes = shapeStrokes(shapeStart[0], shapeStart[1], x1, y1, e.shiftKey);
    shapeStart = null;
    if (strokes.length) act("addStrokes", { panelId: activeId(), strokes });
    else paint();
    return;
  }
  if (stroke) {
    const s = stroke;
    stroke = null;
    act("addStroke", { panelId: activeId(), stroke: s });
  }
};
$("drawing").onpointercancel = () => {
  panning = null;
  stroke = null;
  shapeStart = null;
  imageDrag = null;
  paint();
};
// ホイールはカーソル位置を基準に拡大縮小する。
$("drawing").onwheel = (e) => {
  e.preventDefault();
  const [px, py] = point(e, false);
  const zoom = Math.max(
    1,
    Math.min(8, view.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)),
  );
  setView(
    zoom,
    px - (px - view.x) * (view.zoom / zoom),
    py - (py - view.y) * (view.zoom / zoom),
  );
};
$("fit").onclick = () => setView(1, 0, 0);
const TOOL_BUTTONS = [
  "brushTool",
  "eraserTool",
  "lineTool",
  "rectTool",
  "arrowTool",
  "imageMoveTool",
];
const selectToolButton = (id) => {
  for (const t of TOOL_BUTTONS) $(t).classList.toggle("on", t === id);
};
for (const [id, erase] of [
  ["brushTool", false],
  ["eraserTool", true],
])
  $(id).onclick = () => {
    tool.erase = erase;
    tool.shape = null;
    tool.image = false;
    selectToolButton(id);
  };
for (const [id, shape] of [
  ["lineTool", "line"],
  ["rectTool", "rect"],
  ["arrowTool", "arrow"],
])
  $(id).onclick = () => {
    tool.shape = shape;
    tool.image = false;
    selectToolButton(id);
  };
// 画像移動（C4）。Stage上のドラッグでoffsetを動かす専用モード。
$("imageMoveTool").onclick = () => {
  tool.shape = null;
  tool.image = true;
  selectToolButton("imageMoveTool");
};
$("onion").onclick = () => {
  ONION.on = !ONION.on;
  $("onion").classList.toggle("on", ONION.on);
  paint();
};
$("brush").oninput = () => {
  tool.size = Math.max(
    BRUSH.min,
    Math.min(BRUSH.max, Number($("brush").value) / 1280),
  );
};
// 画像取り込み：原本をAssetとして保存し、表示用は長辺2048pxまで縮小する。
const MAX_DISPLAY = 2048;
async function bitmapFor(blob) {
  const raw = await createImageBitmap(blob);
  if (Math.max(raw.width, raw.height) <= MAX_DISPLAY) return raw;
  const scale = MAX_DISPLAY / Math.max(raw.width, raw.height);
  const small = await createImageBitmap(raw, {
    resizeWidth: Math.round(raw.width * scale),
    resizeHeight: Math.round(raw.height * scale),
  });
  raw.close?.();
  return small;
}
async function ensureImages(p) {
  const missing = [];
  for (const a of p.assets) {
    if (a.kind !== "image" || images.has(a.id)) continue;
    try {
      const blob = await repo.getAsset(a.id);
      if (!blob) throw Error("素材が見つかりません");
      images.set(a.id, await bitmapFor(blob));
    } catch {
      missing.push(a.name);
    }
  }
  return missing;
}
$("image").onclick = () => $("imageFile").click();
$("imageFile").onchange = async () => {
  const f = $("imageFile").files[0];
  $("imageFile").value = "";
  if (!f) return;
  // 取り込み先は押した時点のPanel。読み込み中に選択が変わっても移らない。
  const target = activeId();
  const opacity = Number($("imageOpacity").value) / 100 || 1;
  try {
    if (!f.type.startsWith("image/")) throw Error("画像ファイルではありません");
    if (f.size > 30e6) throw Error("30MBを超える画像は未対応です");
    // Projectへ参照される前の原本をGCから守る（E2/R05）。
    const id = uid();
    const outcome = await repo.withProtection(id, () =>
      imports.run({
        key: `image:${target}`,
        targetExists: () => !!panelById(target),
        load: async () => {
          const source = await createImageBitmap(f);
          const meta = {
            id,
            kind: "image",
            name: f.name.slice(0, 80),
            mime: f.type,
            bytes: f.size,
            width: source.width,
            height: source.height,
          };
          source.close?.();
          // 先にバイナリを保存する。保存できない画像をプロジェクトへ参照させない。
          await repo.putAsset(id, f);
          return { meta, bitmap: await bitmapFor(f) };
        },
        apply: ({ meta, bitmap }) => {
          images.set(meta.id, bitmap);
          // 既に画像があれば差し替え（B5）。無ければ普通に設定するのと同じ結果になる。
          return act("replacePanelImage", { panelIds: [target], asset: meta, opacity });
        },
        release: ({ bitmap }) => bitmap?.close?.(),
      }),
    );
    if (!outcome.applied) {
      notice("画像の取り込みは適用しませんでした（対象が変わりました）");
      return;
    }
    const { meta } = outcome.resource;
    notice(`${meta.name} を読み込みました（${meta.width}×${meta.height}）`);
  } catch (e) {
    notice(`画像を読み込めません：${e.message}`);
  }
};
$("imageClear").onclick = () => act("clearPanelImage", { panelId: activeId() });
$("imageOpacity").onchange = () =>
  act("setImageOpacity", {
    panelId: activeId(),
    opacity: Number($("imageOpacity").value) / 100,
  });
$("imageFit").onchange = () =>
  act("setImageTransform", { panelId: activeId(), fit: $("imageFit").value });
$("imageScale").onchange = () =>
  act("setImageTransform", {
    panelId: activeId(),
    scale: Number($("imageScale").value),
  });
// 音声取り込み：原本をAssetへ保存し、デコードしてから再生ヘッド位置へ置く。
$("audioAdd").onclick = () => $("audioFile").click();
$("audioFile").onchange = async () => {
  const file = $("audioFile").files[0];
  $("audioFile").value = "";
  if (!file) return;
  try {
    if (!file.type.startsWith("audio/"))
      throw Error("音声ファイルではありません");
    if (file.size > 80e6) throw Error("80MBを超える音声は未対応です");
    // 置き場所（再生ヘッドのPanelと相対位置）と種別を開始時に決める。
    const at = Math.round(frame);
    const host = rowAtFrame(rows, at);
    const anchor = host.panel.id;
    const offset = at - host.start;
    const track = $("audioKind").value;
    const fps = store.p.fps;
    // Projectへ参照される前の原本をGCから守る（E2/R05）。
    const id = uid();
    const outcome = await repo.withProtection(id, () =>
      imports.run({
        targetExists: () => !!panelById(anchor),
        load: async () => {
          const buffer = await sound.decode(id, file);
          await repo.putAsset(id, file);
          return { id, buffer };
        },
        apply: ({ id, buffer }) => {
          const added = uid();
          return act(
            "addAudioClip",
            {
              clipId: added,
              asset: {
                id,
                kind: "audio",
                name: file.name.slice(0, 80),
                mime: file.type,
                bytes: file.size,
              },
              track,
              anchor,
              at: offset,
              frames: Math.max(1, Math.round(buffer.duration * fps)),
            },
            (result) => {
              if (result.changed) clipId = added;
            },
          );
        },
        release: ({ id }) => sound.forget(id),
      }),
    );
    if (!outcome.applied) {
      notice("音声の配置は適用しませんでした（対象が変わりました）");
      return;
    }
    notice(
      `${file.name} を配置しました（${outcome.resource.buffer.duration.toFixed(2)}秒）`,
    );
  } catch (e) {
    notice(`音声を読み込めません：${e.message}`);
  }
};
const currentClip = () => store.p.audio.find((c) => c.id === clipId);
$("clipList").onchange = () => {
  clipId = $("clipList").value;
  render();
};
$("clipGain").onchange = () =>
  act("setClipField", {
    clipId,
    field: "gain",
    value: Number($("clipGain").value) / 100,
  });
for (const [id, key] of [
  ["clipFrames", "frames"],
  ["clipOffset", "offset"],
])
  $(id).onchange = () =>
    act("setClipField", {
      clipId,
      field: key,
      value: Math.min(
        864000,
        Math.max(key === "frames" ? 1 : 0, Math.round(Number($(id).value) || 0)),
      ),
    });
$("clipDelete").onclick = () => act("deleteClip", { clipId });
// 素材が見つからないクリップは、別のファイルを入れて直せる。
// 原本は不変として扱う。同じAsset IDへ上書きすると、履歴や過去のSnapshotが
// 指す音まで別物になってしまうため、新しいIDを作って参照だけを付け替える。
$("clipRepair").onclick = () => {
  const clip = currentClip();
  if (!clip) return;
  // 取り込みの対象は押した時点のClip。Sessionの照合はImportControllerが行う。
  const target = clip.id;
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "audio/*";
  picker.onchange = async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      if (!file.type.startsWith("audio/"))
        throw Error("音声ファイルではありません");
      if (file.size > 80e6) throw Error("80MBを超える音声は未対応です");
      // Projectへ参照される前の原本をGCから守る（E2/R05）。
      const id = uid();
      const outcome = await repo.withProtection(id, () =>
        imports.run({
          key: `clip:${target}`,
          targetExists: () => store.p.audio.some((c) => c.id === target),
          load: async () => {
            const buffer = await sound.decode(id, file);
            await repo.putAsset(id, file);
            return { id, buffer };
          },
          apply: ({ id }) =>
            act("replaceClipAsset", {
              clipId: target,
              asset: {
                id,
                kind: "audio",
                name: file.name.slice(0, 80),
                mime: file.type,
                bytes: file.size,
              },
            }),
          release: ({ id }) => sound.forget(id),
        }),
      );
      if (!outcome.applied) {
        notice("差し替えは適用しませんでした（対象が変わりました）");
        return;
      }
      notice(
        `素材を差し替えました（${outcome.resource.buffer.duration.toFixed(2)}秒／元に戻すで戻せます）`,
      );
    } catch (e) {
      notice(`差し替えられません：${e.message}`);
    }
  };
  picker.click();
};
// マーカー（C1）：再生ヘッドの位置へ、そこを含むPanelを基準に追加する。
// 音声と違い取込を伴わないので、Commandを直接呼ぶだけで済む。
$("markerAdd").onclick = () => {
  const at = Math.round(frame);
  const host = rowAtFrame(rows, at);
  const added = uid();
  act(
    "addMarker",
    { markerId: added, anchor: host.panel.id, at: at - host.start, text: "", color: "#ffcc00" },
    (result) => {
      if (result.changed) markerId = added;
    },
  );
};
$("markerList").onchange = () => {
  markerId = $("markerList").value;
  render();
};
$("markerText").onchange = () =>
  act("setMarkerField", { markerId, field: "text", value: $("markerText").value.slice(0, 200) });
$("markerColor").onchange = () =>
  act("setMarkerField", { markerId, field: "color", value: $("markerColor").value });
$("markerDelete").onclick = () => act("deleteMarker", { markerId });
for (const [id, key] of [
  ["sceneName", "renameScene"],
  ["shotName", "renameShot"],
])
  $(id).onchange = () => {
    const r = current();
    act(key, {
      sceneId: r.scene.id,
      shotId: r.shot.id,
      name: $(id).value.slice(0, 60),
    });
  };
for (const tab of document.querySelectorAll(".tab"))
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".tab"))
      t.classList.toggle("on", t === tab);
    for (const pane of document.querySelectorAll("#inspector .pane"))
      pane.hidden = pane.dataset.pane !== tab.dataset.tab;
  };
$("save").onclick = async () => {
  download(
    new Blob([JSON.stringify(store.p)], { type: "application/json" }),
    "project.contp",
  );
  fileDirty = false;
  notice("プロジェクトをダウンロードしました");
  await persist("manual");
};
$("open").onclick = () => $("file").click();
$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  if (replacing) {
    $("file").value = "";
    return notice("別の読み込みが進行中です");
  }
  replacing = true;
  try {
    if (f.size > 50e6) throw Error("50MBを超えるファイルは未対応です");
    // 読み込みに失敗しても現在のプロジェクトへは触れない。
    const p = load(await f.text());
    if (
      (fileDirty || saver.pending) &&
      !confirm("編集中の内容を置き換えて開きますか？")
    )
      return;
    stop();
    replaceStore(p);
    frame = 0;
    fileDirty = false;
    render();
    notice("読み込み完了");
    markDirty();
    await loadImages();
  } catch (e) {
    notice(e.message);
  } finally {
    replacing = false;
    $("file").value = "";
  }
};
// 素材同梱の.conte.zip（D1）。書き出しは今のProjectが参照する原本をRepositoryから
// 集めてZIPへ詰めるだけ。読み込みはparseBundleで検証を終えたものだけを受け取り、
// 実際に書くのはID衝突の解決（同じ内容なら使い回し、違えば新しいIDへ付け替え）を
// 決めた後にする。
$("exportBundle").onclick = async () => {
  try {
    const project = store.p;
    const blob = await buildBundle(project, (id) => repo.getAsset(id));
    download(blob, `${exportFileBase()}.conte.zip`);
    notice(`素材ごと書き出しました（素材${project.assets.length}件）`);
  } catch (e) {
    notice(`書き出しに失敗：${e.message}`);
  }
};
$("importBundle").onclick = () => $("bundleFile").click();
$("bundleFile").onchange = async () => {
  const f = $("bundleFile").files[0];
  if (!f) return;
  if (replacing) {
    $("bundleFile").value = "";
    return notice("別の読み込みが進行中です");
  }
  replacing = true;
  try {
    if (f.size > 200e6) throw Error("200MBを超えるファイルは未対応です");
    // 検証をすべて終えるまでRepositoryへは何も書かない。
    const { project, assets } = await parseBundle(new Uint8Array(await f.arrayBuffer()));
    if (
      (fileDirty || saver.pending) &&
      !confirm("編集中の内容を置き換えて開きますか？")
    )
      return;
    // 内容が同じIDは書き直さずに再利用するので、既存を調べ始める時点から
    // 保護する。計画を立てている間にGCへ消されると、書かないと決めた原本を
    // 参照したままProjectを公開してしまう。
    await repo.withProtectionAll(
      assets.map((asset) => asset.id),
      async () => {
        const plan = await planImport(assets, async (id) => {
          const existing = await repo.getAsset(id);
          if (!existing) return undefined;
          return existing instanceof Uint8Array
            ? existing
            : new Uint8Array(await existing.arrayBuffer());
        });
        for (const { asset, finalId } of plan)
          if (finalId !== asset.id) remapAssetId(project, asset.id, finalId);
        // 衝突して発行し直したIDは、書いてからProjectへ公開するまでの間も守る。
        await repo.withProtectionAll(
          plan.map((entry) => entry.finalId),
          async () => {
            for (const { asset, finalId, write } of plan)
              if (write) await repo.putAsset(finalId, asset.blob);
            stop();
            replaceStore(project);
            frame = 0;
            fileDirty = false;
            render();
            notice(`Bundleを読み込みました（素材${assets.length}件）`);
            markDirty();
            await loadImages();
          },
        );
      },
    );
  } catch (e) {
    notice(`読み込みに失敗：${e.message}`);
  } finally {
    replacing = false;
    $("bundleFile").value = "";
  }
};
window.addEventListener("beforeunload", (e) => {
  // ブラウザ内保存が済んでいれば次回の起動で復旧できるので引き止めない。
  if (saver.pending || (!persistence && fileDirty)) {
    e.preventDefault();
    e.returnValue = "";
  }
});
for (const event of ["pagehide", "visibilitychange"])
  window.addEventListener(event, () => {
    if (event === "pagehide" || document.visibilityState === "hidden")
      saver.flush();
  });
// 台詞・注記・Scene名・Shot名の検索（B2）。Ctrl+Fはテキスト入力中でも開けるので、
// 下の主なショートカットのハンドラとは別に持つ。開閉はProjectにもlayoutにも
// 保存しない画面状態。
const FIELD_LABEL = {
  dialogue: "台詞",
  sound: "SE/BGM",
  notes: "演出メモ",
  sceneName: "Scene名",
  shotName: "Shot名",
};
function openSearch() {
  $("search").hidden = false;
  $("searchQuery").focus();
  $("searchQuery").select();
  runSearch();
}
function closeSearch() {
  $("search").hidden = true;
}
function runSearch() {
  const query = $("searchQuery").value;
  const hits = query ? searchPanels(store.p, query) : [];
  $("searchResults").replaceChildren(
    ...hits.map((hit) => {
      const b = document.createElement("button");
      b.className = "searchHit";
      const field = document.createElement("span");
      field.className = "field";
      field.textContent = `${FIELD_LABEL[hit.field]} `;
      const match = document.createElement("b");
      match.textContent = hit.text.slice(hit.index, hit.index + query.length);
      b.append(
        field,
        document.createTextNode(hit.text.slice(0, hit.index)),
        match,
        document.createTextNode(hit.text.slice(hit.index + query.length)),
      );
      b.onclick = () =>
        commitWith(
          () => (frame = startOf(hit.panelId)),
          () => editor.select({ active: hit.panelId, ids: [hit.panelId] }),
        );
      return b;
    }),
  );
  $("searchStatus").textContent = query ? `${hits.length}件` : "";
}
$("searchQuery").oninput = runSearch;
$("searchClose").onclick = closeSearch;
// プレゼンモード（B8）。body.presentingでStageだけを見せる。Fullscreen APIは
// 任意で、失敗してもクラスの付け外しだけで成立する。Projectにもlayoutにも
// 保存しない画面状態。←/→でのPanel送りとSpaceでの再生は既存のキー操作を
// そのまま使う。
$("present").onclick = () => {
  document.body.classList.add("presenting");
  document.documentElement.requestFullscreen?.().catch(() => {});
};
function exitPresent() {
  document.body.classList.remove("presenting");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if ($("paperDialog").open || $("animaticDialog").open || $("recoverDialog").open)
    return;
  if (mod && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearch();
  } else if (e.key === "Escape" && !$("search").hidden) {
    closeSearch();
  } else if (e.key === "Escape" && document.body.classList.contains("presenting")) {
    exitPresent();
  }
});
document.addEventListener("keydown", (e) => {
  if (
    /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) ||
    $("paperDialog").open ||
    $("animaticDialog").open ||
    $("recoverDialog").open
  )
    return;
  const mod = e.ctrlKey || e.metaKey,
    k = e.key.toLowerCase();
  let fn;
  if (mod && k === "z") fn = e.shiftKey ? acts.redo : acts.undo;
  else if (mod && k === "d") fn = acts.duplicate;
  else if (mod && k === "c") fn = acts.copy;
  else if (mod && k === "x") fn = acts.cut;
  else if (mod && k === "v") fn = acts.paste;
  else if (mod && k === "s") fn = () => $("save").click();
  else if (mod && e.shiftKey && k === "k") fn = acts.merge;
  else if (mod && k === "k") fn = acts.split;
  else if (k === "n") fn = acts.add;
  else if (k === "k") fn = () => $("key").click();
  else if (k === "e")
    fn = () => $(tool.erase ? "brushTool" : "eraserTool").click();
  else if (k === "o") fn = () => $("onion").click();
  else if (k === "0") fn = () => $("fit").click();
  else if (k === "f") fn = () => $("fitTime").click();
  else if (k === "delete" || k === "backspace")
    fn = () => !$("keyDelete").disabled && $("keyDelete").click();
  else if (k === "+" || k === "=" || k === "-")
    fn = () => {
      zoomTo(scaleIndex + (k === "-" ? -1 : 1));
    };
  else if (k === " ") fn = () => $("play").click();
  else if (k === "arrowright" || k === "arrowleft")
    fn = () => {
      const delta = k === "arrowright" ? 1 : -1;
      const i = rows.findIndex((r) => r.panel.id === activeId());
      const targetIndex = mod ? shotBoundaryIndex(delta) : i + delta;
      moveSelection(targetIndex, e.shiftKey);
    };
  else if (k === "home") fn = () => moveSelection(0, e.shiftKey);
  else if (k === "end") fn = () => moveSelection(rows.length - 1, e.shiftKey);
  else if (k === "[" || k === "]")
    fn = () =>
      act("nudgePanelFrames", {
        ids: editor.selectedIds,
        delta: k === "]" ? 1 : -1,
      });
  if (fn) {
    e.preventDefault();
    fn();
  }
});
// 紙面設定はプロジェクトの一部。変更は履歴と自動保存に乗る。
const paper = () => store.p.paper;
const paperEdit = (change) => {
  act("updatePaper", { change });
  schedulePreview();
};
function paperSettings() {
  const o = paper();
  const box = $("paperSettings");
  box.replaceChildren();
  const field = (title, node) => {
    const label = document.createElement("label");
    label.textContent = title;
    label.append(node);
    box.append(label);
    return node;
  };
  const select = (title, key, entries) => {
    const node = document.createElement("select");
    node.replaceChildren(
      ...entries.map(([value, text]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        option.selected = o[key] === value;
        return option;
      }),
    );
    node.onchange = () => paperEdit((paper) => (paper[key] = node.value));
    return field(title, node);
  };
  select("用紙", "size", [
    ["A4", "A4"],
    ["A3", "A3"],
    ["B4", "B4"],
    ["letter", "Letter"],
  ]);
  select("向き", "orientation", [
    ["portrait", "縦"],
    ["landscape", "横"],
  ]);
  for (const [key, title, min, max] of [
    ["rows", "コマ / ページ", 1, 12],
    ["margin", "余白 (px)", 10, 150],
    ["font", "文字サイズ (px)", 8, 40],
  ]) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = min;
    input.max = max;
    input.value = o[key];
    input.onchange = () =>
      paperEdit(
        (paper) =>
          (paper[key] = Math.max(
            min,
            Math.min(max, Math.round(Number(input.value)) || min),
          )),
      );
    field(title, input);
  }
  for (const [key, title] of [
    ["header", "ヘッダー"],
    ["footer", "フッター"],
  ]) {
    const input = document.createElement("input");
    input.value = o[key];
    input.placeholder = key === "header" ? store.p.title : "";
    input.onchange = () =>
      paperEdit((paper) => (paper[key] = input.value.slice(0, 80)));
    field(title, input);
  }
  for (const [key, title] of [
    ["duration", "尺"],
    ["numbers", "階層番号"],
    ["cameraMarks", "画像にCamera作画"],
    ["vertical", "縦書き"],
  ]) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = o[key];
    input.onchange = () => paperEdit((paper) => (paper[key] = input.checked));
    const label = document.createElement("label");
    label.className = "check";
    label.append(input, title);
    box.append(label);
  }
  columnSettings();
  scrubAll($("paperSettings"));
}
// 列は順番・幅・表示/非表示をそのまま編集する。並びがそのまま紙面の並びになる。
function columnSettings() {
  const o = paper();
  const list = $("paperColumns");
  list.replaceChildren();
  const used = new Map(o.columns.map((c) => [c.key, c]));
  for (const key of PAPER_COLUMNS) {
    const column = used.get(key);
    const row = document.createElement("div");
    row.className = "column";
    const show = document.createElement("input");
    show.type = "checkbox";
    show.checked = !!column;
    show.onchange = () =>
      paperEdit((paper) => {
        if (show.checked)
          paper.columns.push({ key, width: 100 / (paper.columns.length + 1) });
        else if (paper.columns.length > 1)
          paper.columns = paper.columns.filter((c) => c.key !== key);
      });
    const name = document.createElement("span");
    name.textContent = COLUMN_LABEL[key];
    const width = document.createElement("input");
    width.type = "number";
    width.min = 1;
    width.max = 100;
    width.value = column ? Math.round(column.width) : "";
    width.disabled = !column;
    width.onchange = () =>
      paperEdit((paper) => {
        const target = paper.columns.find((c) => c.key === key);
        if (target)
          target.width = Math.max(1, Math.min(100, Number(width.value) || 1));
      });
    const move = (delta) =>
      button(delta < 0 ? "↑" : "↓", () =>
        paperEdit((paper) => {
          const at = paper.columns.findIndex((c) => c.key === key);
          const to = at + delta;
          if (at < 0 || to < 0 || to >= paper.columns.length) return;
          const [moved] = paper.columns.splice(at, 1);
          paper.columns.splice(to, 0, moved);
        }),
      );
    const up = move(-1),
      down = move(1);
    up.disabled = down.disabled = !column;
    row.append(show, name, width, up, down);
    list.append(row);
  }
  scrubAll(list);
}
// 紙面プリセット（D3）。組み込み分はpaper.jsの定数、保存した分はrepoのmetaストア。
// header/footerや尺・階層番号・Camera作画の表示は文書ごとの選択なので含めない。
async function renderPaperPresets() {
  const select = $("paperPreset");
  const custom = persistence ? await repo.getPaperPresets().catch(() => []) : [];
  select.replaceChildren(
    new Option("選択…", ""),
    ...PAPER_PRESETS.map((p) => new Option(p.name, `builtin:${p.name}`)),
    ...custom.map((p) => new Option(`${p.name}（保存済み）`, `custom:${p.name}`)),
  );
  $("paperPresetDelete").disabled = true;
}
function applyPaperPreset(preset) {
  paperEdit((paper) => {
    paper.size = preset.size;
    paper.orientation = preset.orientation;
    paper.rows = preset.rows;
    paper.margin = preset.margin;
    paper.font = preset.font;
    paper.columns = preset.columns.map((c) => ({ ...c }));
  });
  paperSettings();
}
$("paperPreset").onchange = async () => {
  const value = $("paperPreset").value;
  $("paperPresetDelete").disabled = !value.startsWith("custom:");
  if (value.startsWith("builtin:")) {
    const preset = PAPER_PRESETS.find((p) => p.name === value.slice(8));
    if (preset) applyPaperPreset(preset);
  } else if (value.startsWith("custom:")) {
    const name = value.slice(7);
    const preset = (await repo.getPaperPresets().catch(() => [])).find(
      (p) => p.name === name,
    );
    if (preset) applyPaperPreset(preset);
  }
};
$("paperPresetSave").onclick = async () => {
  if (!persistence)
    return notice("プリセットを保存できません（ブラウザ内保存が使えません）");
  const name = prompt("プリセット名")?.trim();
  if (!name) return;
  const o = paper();
  const preset = {
    name,
    size: o.size,
    orientation: o.orientation,
    rows: o.rows,
    margin: o.margin,
    font: o.font,
    columns: o.columns.map((c) => ({ ...c })),
  };
  const list = (await repo.getPaperPresets().catch(() => [])).filter(
    (p) => p.name !== name,
  );
  list.push(preset);
  await repo.setPaperPresets(list);
  await renderPaperPresets();
  $("paperPreset").value = `custom:${name}`;
  $("paperPresetDelete").disabled = false;
  notice(`プリセット「${name}」を保存しました`);
};
$("paperPresetDelete").onclick = async () => {
  const value = $("paperPreset").value;
  if (!value.startsWith("custom:")) return;
  const name = value.slice(7);
  const list = (await repo.getPaperPresets().catch(() => [])).filter(
    (p) => p.name !== name,
  );
  await repo.setPaperPresets(list);
  await renderPaperPresets();
  notice(`プリセット「${name}」を削除しました`);
};
let pageIndex = 0,
  pages = [],
  job = null;
const paging = document.createElement("div");
paging.className = "paging";
const previous = button("← 前ページ", () => {
  pageIndex = Math.max(0, pageIndex - 1);
  showPage();
});
const next = button("次ページ →", () => {
  pageIndex = Math.min(pages.length - 1, pageIndex + 1);
  showPage();
});
const pageLabel = document.createElement("span");
paging.append(previous, pageLabel, next);
$("pages").before(paging);
const measureText = (() => {
  const context = document.createElement("canvas").getContext("2d");
  return (text, size) => {
    context.font = `${size}px "Noto Sans JP", sans-serif`;
    return context.measureText(text).width;
  };
})();
// プレビューは表示するページだけを描く。全ページを走査しない。
function showPage() {
  pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
  const canvas = renderPage(
    store.p,
    pages[pageIndex] ?? [],
    paper(),
    pageIndex,
    pages.length,
    images,
  );
  $("pages").replaceChildren(canvas);
  pageLabel.textContent = ` ${pageIndex + 1} / ${pages.length} `;
  previous.disabled = pageIndex === 0;
  next.disabled = pageIndex >= pages.length - 1;
}
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, 120);
}
function preview() {
  pages = layoutPages(store.p, paper(), measureText, rows);
  showPage();
  const continued = pages.flat().filter((e) => e.continuation).length;
  notice(
    `紙コンテ ${pages.length}ページ / ${rows.length} Panel${
      continued ? ` · 続き行 ${continued}` : ""
    }`,
  );
}
function progress(text, running) {
  $("paperProgress").textContent = text;
  $("cancelExport").hidden = !running;
  for (const node of document.querySelectorAll(
    "#paperSettings input, #paperSettings select, #paperColumns input, #paperColumns button, #print, #png, #shareHtml",
  ))
    node.disabled = running;
}
// 出力は1ページずつ。途中でキャンセルできるようJobを渡す。
async function exportPages(handle, label) {
  if (job) return null;
  job = new Job();
  // 生成中に編集されても、1つの出力内で設定やProjectが混ざらないよう固定する。
  const exportProject = store.p;
  const exportPaper = paper();
  const exportPagesList = pages.slice();
  const exportImages = new Map(images);
  const total = exportPagesList.length;
  progress(`${label} 0 / ${total}`, true);
  try {
    const result = await forEachPage(
      total,
      async (i) => {
        const canvas = renderPage(
          exportProject,
          exportPagesList[i],
          exportPaper,
          i,
          total,
          exportImages,
        );
        const value = await handle(canvas, i);
        canvas.width = canvas.height = 0;
        return value;
      },
      {
        job,
        onProgress: ({ done, total }) =>
          progress(`${label} ${done} / ${total}`, true),
      },
    );
    progress(`${label} 完了（${total}ページ）`, false);
    return result;
  } catch (e) {
    progress(
      e instanceof Cancelled
        ? "出力を中止しました"
        : `出力に失敗：${e.message}`,
      false,
    );
    return null;
  } finally {
    job = null;
  }
}
$("cancelExport").onclick = () => job?.cancel();
$("paper").onclick = async () => {
  stop();
  $("paperDialog").showModal();
  await ensureImages(store.p);
  paperSettings();
  renderPaperPresets();
  preview();
};
$("closePaper").onclick = () => {
  job?.cancel();
  $("paperDialog").close();
};
$("print").onclick = async () => {
  const sheets = await exportPages(async (canvas) => {
    const img = new Image();
    img.src = canvas.toDataURL("image/png");
    await img.decode();
    return img;
  }, "印刷用に生成");
  if (!sheets) return showPage();
  $("pages").replaceChildren(...sheets);
  window.print();
};
window.addEventListener("afterprint", () => {
  if ($("paperDialog").open) showPage();
});
// PNGは1ファイルのZIPにまとめる。連番の個別ダウンロードを何十回も許可させない。
// 全ページ分の{name,bytes}を配列で貯めてからzip()するとPNGを二重に抱えるので、
// 1ページできるたびにZipBuilderへ足し、Blobは最後にまとめて作る（D2）。
// ファイル名に使えない記号を落とす。空になったらcontEの既定名にする。
const exportFileBase = () =>
  store.p.title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 40) || "conte";
$("png").onclick = async () => {
  const builder = new ZipBuilder();
  const result = await exportPages(async (canvas, i) => {
    builder.add({
      name: `conte-${String(i + 1).padStart(3, "0")}.png`,
      bytes: await canvasBytes(canvas),
    });
    return null;
  }, "PNGを生成");
  if (!result) return showPage();
  const name = `${exportFileBase()}-png.zip`;
  download(builder.finish(), name);
  notice(`${builder.count}枚のPNGを${name}にまとめました`);
  showPage();
};
// 共有用HTML（D4）。1ファイルへdata URIで埋め込むので、ページ数×PNGサイズを
// そのまま抱える。累計が上限を超えたら残りを生成せず断る（保存を壊さない）。
const SHARE_HTML_LIMIT = 60 * 1024 * 1024;
$("shareHtml").onclick = async () => {
  const pngPages = [];
  let total = 0,
    overLimit = false;
  const result = await exportPages(async (canvas) => {
    const bytes = await canvasBytes(canvas);
    total += bytes.length;
    if (total > SHARE_HTML_LIMIT) {
      overLimit = true;
      job?.cancel();
      return null;
    }
    pngPages.push(bytes);
    return null;
  }, "共有用HTMLを生成");
  if (overLimit) {
    notice(
      `共有用HTMLの上限（${Math.round(SHARE_HTML_LIMIT / 1024 / 1024)}MB）を超えるため書き出しを中止しました`,
    );
    return showPage();
  }
  if (!result) return showPage();
  const name = `${exportFileBase()}-share.html`;
  const html = buildShareHtml({ title: store.p.title, pages: pngPages });
  download(new Blob([html], { type: "text/html" }), name);
  notice(`${pngPages.length}ページを${name}にまとめました`);
  showPage();
};
// Animatic出力。映像は再生と同じ評価、音は再生と同じ予約をストリームへ流す。
let animaticJob = null;
function animaticSetup() {
  const fill = (id, entries, selected) => {
    $(id).replaceChildren(
      ...entries.map(([value, text]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        option.selected = String(selected) === String(value);
        return option;
      }),
    );
  };
  fill(
    "animaticFormat",
    Object.entries(animatic.FORMATS).map(([key, f]) => [key, f.label]),
    "webm",
  );
  fill(
    "animaticFps",
    animatic.FPS_CHOICES.map((v) => [v, `${v} fps`]),
    animatic.FPS_CHOICES.includes(store.p.fps) ? store.p.fps : 24,
  );
  fill(
    "animaticSize",
    Object.keys(animatic.RESOLUTIONS).map((key) => [
      key,
      `${key}（${animatic.RESOLUTIONS[key].join("×")}）`,
    ]),
    "720p",
  );
  for (const id of ["animaticFormat", "animaticFps", "animaticSize"])
    $(id).onchange = animaticInfo;
  animaticInfo();
}
// ワークエリア（C5）が設定されていれば出力もその範囲に絞る。無ければ全体。
function animaticSpec() {
  const { from, to } = store.p.workArea ?? { from: 0, to: endFrame() };
  return animatic.plan(
    from,
    to,
    store.p.fps,
    Number($("animaticFps").value),
    $("animaticSize").value,
  );
}
function animaticInfo() {
  const spec = animaticSpec();
  const format = $("animaticFormat").value;
  const mime = format === "webm" ? animatic.pickMime("webm") : null;
  $("animaticStart").disabled = format === "webm" && !mime;
  $("animaticInfo").textContent =
    `${spec.seconds.toFixed(2)}秒 / ${spec.frames}フレーム / ${spec.width}×${spec.height}` +
    (store.p.workArea ? "・ワークエリアのみ" : "") +
    (format === "webm"
      ? mime
        ? ` · ${mime}・音${resolved.length ? "あり" : "なし"}・録画に約${Math.ceil(spec.seconds)}秒`
        : " · この環境では録画形式が使えません"
      : " · フレームを1枚ずつ描いてZIPにまとめます");
}
function animaticProgress(text, running) {
  $("animaticProgress").textContent = text;
  $("animaticCancel").hidden = !running;
  $("animaticStart").disabled = running;
  for (const id of ["animaticFormat", "animaticFps", "animaticSize"])
    $(id).disabled = running;
}
// PNG連番：フレーム厳密。再生時計に頼らず、出力フレームごとに時刻を決める。
async function animaticFrames(spec) {
  const canvas = $("animaticPreview");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const context = canvas.getContext("2d");
  animaticJob = new Job();
  // 開始時点の内容に固定する（E3）。rowsの中身は編集のたびに作り直されるので
  // 参照を控えるだけでよいが、imagesは同じMapへ後から素材が足されるためコピーする。
  const frozenRows = rows;
  const frozenImages = new Map(images);
  const builder = new ZipBuilder();
  await forEachPage(
    spec.frames,
    async (i) => {
      animatic.renderFrame(
        context,
        frozenRows,
        spec.sourceFrame(i),
        spec.width,
        spec.height,
        frozenImages,
      );
      builder.add({
        name: `frame-${String(i + 1).padStart(5, "0")}.png`,
        bytes: await canvasBytes(canvas),
      });
      return null;
    },
    {
      job: animaticJob,
      // 4フレーム単位で制御を返し、PNG連番の不要な1フレーム待ちを減らす。
      // 各フレームのcancel判定は維持するため、中止の応答性は変えない。
      yieldEvery: 4,
      onProgress: ({ done, total }) =>
        animaticProgress(`フレーム ${done} / ${total}`, true),
    },
  );
  return builder.finish();
}
// WebM：実時間の録画。音は再生と同じ予約を録音用の出力先へ流す。
async function animaticRecord(spec, mime) {
  const canvas = $("animaticPreview");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(spec.outFps);
  // 開始時点の内容に固定する（E3）。録画は実時間かかるので、途中で素材取り込みが
  // 終わっても絵と音がその時点のまま変わらないようにする。
  const frozenRows = rows;
  const frozenImages = new Map(images);
  const frozenResolved = resolved;
  const fps = store.p.fps;
  // ワークエリア（C5）が設定されていれば、その範囲だけを実時間で録る。
  const schedule = audio.scheduleFor(frozenResolved, spec.from, fps, spec.to);
  if (schedule.length) {
    const destination = sound.streamDestination();
    for (const track of destination.stream.getAudioTracks())
      stream.addTrack(track);
    sound.play(schedule, spec.from, fps, 0.12, destination);
  }
  const recorder = new animatic.Recorder(stream, mime);
  animaticJob = new Job();
  recorder.start();
  const started = performance.now();
  try {
    while (true) {
      const clock = sound.frameAt(fps);
      const elapsed =
        clock !== null
          ? (clock - spec.from) / fps
          : (performance.now() - started) / 1000;
      if (elapsed >= spec.seconds) break;
      animaticJob.check();
      animatic.renderFrame(
        context,
        frozenRows,
        Math.max(spec.from, Math.min(spec.to - 1e-6, spec.from + elapsed * fps)),
        spec.width,
        spec.height,
        frozenImages,
      );
      const state = animatic.recordingProgress(Math.max(0, elapsed), spec);
      animaticProgress(
        `録画 ${state.done} / ${state.total}（残り約${Math.ceil(state.remaining)}秒）`,
        true,
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return await recorder.finish();
  } catch (e) {
    await recorder.discard();
    throw e;
  } finally {
    sound.stop();
    for (const track of stream.getVideoTracks()) track.stop();
  }
}
$("animatic").onclick = () => {
  stop();
  animaticSetup();
  animaticProgress("", false);
  $("animaticDialog").showModal();
};
$("closeAnimatic").onclick = () => {
  animaticJob?.cancel();
  $("animaticDialog").close();
};
$("animaticCancel").onclick = () => animaticJob?.cancel();
$("animaticStart").onclick = async () => {
  if (animaticJob) return;
  const spec = animaticSpec();
  const format = $("animaticFormat").value;
  try {
    animaticProgress("準備中…", true);
    // 出力中はプロジェクトへ触れない。失敗しても素材と編集内容は元のまま。
    const blob =
      format === "webm"
        ? await animaticRecord(spec, animatic.pickMime("webm"))
        : await animaticFrames(spec);
    const name = animatic.outputName(
      store.p.title,
      animatic.FORMATS[format].extension,
    );
    download(blob, name);
    animaticProgress(
      `${name} を書き出しました（${(blob.size / 1e6).toFixed(2)}MB）`,
      false,
    );
  } catch (e) {
    animaticProgress(
      e instanceof Cancelled
        ? "出力を中止しました（途中のファイルは残していません）"
        : `出力に失敗：${e.message}`,
      false,
    );
  } finally {
    animaticJob = null;
    animaticProgress($("animaticProgress").textContent, false);
  }
};
// ペインの幅/高さ。ドラッグで変え、次回の起動でも同じ配置で開く。
// Timelineの初期高さは目盛・Panel・Camera・音声の4段が全部見える値にする。
// rowSizeはProjectではなくlayoutの一部（表示状態）として持つ（A9）。
const layout = { tree: 220, inspector: 260, timeline: 270, rowSize: "md" };
const limits = {
  tree: [140, 480],
  inspector: [180, 520],
  timeline: [150, 560],
};
function applyLayout() {
  for (const [key, value] of Object.entries(layout))
    if (key !== "rowSize")
      document.documentElement.style.setProperty(`--${key}`, `${value}px`);
  $("timeBody").dataset.rowSize = layout.rowSize;
  $("rowSize").value = layout.rowSize;
}
$("rowSize").onchange = () => {
  layout.rowSize = $("rowSize").value;
  applyLayout();
  timeline();
  if (persistence) repo.setLayout({ ...layout }).catch(() => {});
};
// 目標尺は表示だけの値。Projectにもlayoutにも保存しない（B1）。
$("targetSeconds").onchange = () => {
  const v = Number($("targetSeconds").value);
  targetSeconds = $("targetSeconds").value === "" || !Number.isFinite(v) ? null : v;
  durationInfo();
};
for (const [id, key, axis, sign] of [
  ["splitTree", "tree", "x", 1],
  ["splitInspector", "inspector", "x", -1],
  ["splitTimeline", "timeline", "y", -1],
])
  $(id).onpointerdown = (e) => {
    e.preventDefault();
    const node = $(id),
      start = axis === "x" ? e.clientX : e.clientY,
      base = layout[key];
    node.setPointerCapture(e.pointerId);
    node.onpointermove = (v) => {
      const delta = ((axis === "x" ? v.clientX : v.clientY) - start) * sign;
      const [min, max] = limits[key];
      layout[key] = Math.round(Math.max(min, Math.min(max, base + delta)));
      applyLayout();
      timeline();
    };
    node.onpointerup = node.onpointercancel = () => {
      node.onpointermove = null;
      if (persistence) repo.setLayout({ ...layout }).catch(() => {});
    };
  };
applyLayout();
// 数値入力はどれもドラッグで変えられるようにする（紙面設定は作り直すたびに付ける）。
scrubAll();
render();
// 永続化はProjectRepositoryへ集約する。UIは保存の成否をそのまま表示する。
const repo = new ProjectRepository(
  IndexedDbStorage.available() ? new IndexedDbStorage() : new MemoryStorage(),
);
// 他タブのGCが、保存前の参照を壊さないよう問い合わせに答える（E4）。
repo.setLiveAssets(() => new Set(store.p.assets.map((a) => a.id)));
let persistence = false;
const clock = (t) =>
  new Date(t).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
const saver = new Autosaver(repo, {
  isCurrent: (token) => editor.isCurrentRevision(token),
  onState: ({ state, meta, message }) => {
    $("savestate").textContent =
      {
        idle: "",
        pending: "未保存の変更",
        saving: "自動保存中…",
        saved: meta ? `ブラウザに保存 ${clock(meta.savedAt)}` : "保存済み",
        failed: `自動保存に失敗：${message}／保存ボタンでファイルへ`,
      }[state] ?? "";
    $("savestate").className = state;
  },
});
function markDirty() {
  fileDirty = true;
  // 自動保存の失敗で編集操作そのものを止めない。
  try {
    if (persistence) saver.schedule(() => store.p, editor.capture());
  } catch (e) {
    notice(`自動保存を予約できません：${e.message}`);
  }
}
async function persist(kind) {
  if (!persistence) return null;
  const token = editor.capture();
  const snapshot = store.p;
  try {
    const meta = await repo.save(snapshot, { kind });
    if (editor.isCurrentRevision(token)) {
      // 保存世代とUndo/Redoから戻せる素材はGCの対象にしない。
      const history = [...store.past, ...store.future].map((entry) => entry.p);
      await repo.pruneAssets(snapshot, history).catch(() => {});
      if (editor.isCurrentRevision(token)) saver.resolved(meta);
    }
    return meta;
  } catch (e) {
    notice(`ブラウザ内保存に失敗：${e.message}`);
    return null;
  }
}
// 音声素材をデコードしておく。見つからない素材は名前を控えて知らせる。
async function ensureAudio(p) {
  const missing = [];
  for (const asset of p.assets) {
    if (asset.kind !== "audio" || sound.has(asset.id)) continue;
    try {
      const blob = await repo.getAsset(asset.id);
      if (!blob) throw Error("素材が見つかりません");
      await sound.decode(asset.id, blob);
    } catch {
      missing.push(asset.name);
    }
  }
  return missing;
}
// 素材のビットマップを用意し、見つからないものは黙って無視しない。
async function loadImages() {
  const token = editor.capture();
  const project = store.p;
  const missing = [
    ...(await ensureImages(project)),
    ...(await ensureAudio(project)),
  ];
  // Projectを開き直していたら、古い読み込み結果で新しい画面を再描画しない。
  if (!editor.isCurrent(token)) return [];
  // 素材が入ったので、サムネイルを含めて描き直す。
  invalidateViews();
  render();
  if (missing.length)
    notice(
      `素材が${missing.length}件見つかりません（${missing[0]}ほか）。.contpに素材は含まれません。音は「音」タブから差し替えられます。`,
    );
  return missing;
}
// 複数の入口（起動時の自動候補／履歴ボタン）で共有する復元の実処理。
async function restoreFrom(meta, project) {
  if (replacing) return notice("別の読み込みが進行中です");
  replacing = true;
  try {
    $("recoverDialog").close();
    stop();
    replaceStore(project);
    frame = 0;
    fileDirty = true;
    render();
    saver.resolved(meta);
    notice(`${clock(meta.savedAt)}の保存を復元しました。ファイルへの保存は別に行ってください。`);
    await loadImages();
  } finally {
    replacing = false;
  }
}
// 保存履歴から選んで復元する一覧（B9）。読めない世代は理由つきで灰色にし、
// 選べないだけで削除はしない。SNAPSHOT_LIMIT件までなので毎回読み直しても軽い。
async function renderRecoveryList() {
  const node = $("recoverHistory");
  node.textContent = "読み込み中…";
  const metas = await repo.list().catch(() => []);
  const rows = await Promise.all(
    metas.map(async (meta) => {
      try {
        return { meta, project: await repo.load(meta.id) };
      } catch (e) {
        return { meta, error: e.message };
      }
    }),
  );
  if (!rows.length) {
    node.textContent = "保存履歴はありません。";
    return;
  }
  node.replaceChildren(
    ...rows.map(({ meta, project, error }) => {
      const b = document.createElement("button");
      b.className = "recoverRow";
      b.disabled = !project;
      const kind = meta.kind === "manual" ? "手動保存" : "自動保存";
      const size = `${(meta.bytes / 1024).toFixed(1)}KB`;
      b.textContent = `${clock(meta.savedAt)} ／ ${meta.title} ／ ${kind} ／ ${meta.panels} Panel ／ ${size}`;
      if (error) {
        const reason = document.createElement("span");
        reason.className = "broken";
        reason.textContent = `（読み込めません：${error}）`;
        b.append(reason);
      } else {
        b.onclick = () => restoreFrom(meta, project);
      }
      return b;
    }),
  );
}
// 復旧候補として提示中の保存時刻。他タブの保存通知と突き合わせて、
// 提示を重複させないために使う（E4）。
let offeredSavedAt = null;
function offerRecovery({ meta, project }) {
  offeredSavedAt = meta.savedAt;
  for (const id of ["recoverInfo", "recoverHint", "recover", "discardRecovery"])
    $(id).hidden = false;
  $("recoverTitle").textContent = "前回の作業が残っています";
  $("recoverInfo").textContent = `${clock(meta.savedAt)} ／ ${
    meta.title
  } ／ ${meta.panels} Panel ／ ${meta.kind === "manual" ? "手動保存" : "自動保存"}`;
  $("recover").onclick = () => restoreFrom(meta, project);
  $("discardRecovery").onclick = async () => {
    $("recoverDialog").close();
    await repo.dismiss(meta.savedAt).catch(() => {});
    notice("復旧候補を今回は使いません（保存データは残っています）");
  };
  renderRecoveryList();
  $("recoverDialog").showModal();
}
$("history").onclick = () => {
  for (const id of ["recoverInfo", "recoverHint", "recover", "discardRecovery"])
    $(id).hidden = true;
  $("recoverTitle").textContent = "保存履歴";
  renderRecoveryList();
  $("recoverDialog").showModal();
};
$("recoverClose").onclick = () => $("recoverDialog").close();
// 別タブが自分より新しく保存したら、提示中の復旧候補は用済みなので閉じる
// （E4：復旧候補の提示を重複させない）。履歴一覧を見ているだけのときは閉じない。
repo.onRemoteSave(({ savedAt }) => {
  if (
    $("recoverDialog").open &&
    !$("recoverInfo").hidden &&
    offeredSavedAt !== null &&
    savedAt > offeredSavedAt
  ) {
    $("recoverDialog").close();
    notice("別のタブで保存が進んだため、復旧の確認を閉じました");
  }
});
(async () => {
  try {
    await repo.open();
    persistence = true;
    // 開き終わる前の編集も取りこぼさない。
    if (fileDirty) markDirty();
  } catch (e) {
    // 保存できない環境でも編集と画像取り込みは続けられるようにする。
    repo.storage = new MemoryStorage();
    await repo.open();
    $("savestate").textContent =
      `自動保存を使えません：${e.message}／保存ボタンでファイルへ`;
    $("savestate").className = "failed";
    return;
  }
  const saved = await repo.getLayout().catch(() => null);
  if (saved) {
    Object.assign(layout, saved);
    applyLayout();
    timeline();
  }
  try {
    const candidate = await repo.latest();
    if (!candidate) return;
    if (candidate.broken.length)
      notice(
        `読み取れない保存データを${candidate.broken.length}件読み飛ばしました（削除はしていません）`,
      );
    if (!candidate.project) return;
    if (candidate.meta.savedAt <= (await repo.dismissed())) return;
    offerRecovery(candidate);
  } catch (e) {
    notice(`復旧候補を確認できません：${e.message}`);
  }
})();
