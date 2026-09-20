import { frameAtTime, rowAtFrame } from "./playback.js";
import {
  Store,
  panel,
  scene,
  uid,
  flatten,
  load,
  split,
  merge,
  cameraAt,
  movePanels,
  BRUSH,
  setCameraKey,
  moveCameraKey,
  removeCameraKey,
  describeCamera,
  CAMERA_FIELDS,
  PAPER_COLUMNS,
  clearPanelImage,
} from "./model.js";
import { draw } from "./drawing.js";
import { layoutPages, renderPage, download, COLUMN_LABEL } from "./paper.js";
import {
  forEachPage,
  Job,
  Cancelled,
  zip,
  ZipBuilder,
  canvasBytes,
} from "./exporter.js";
import * as animatic from "./animatic.js";
import * as tl from "./timeline.js";
import * as audio from "./audio.js";
import { AudioEngine } from "./audio.js";
import { ProjectRepository, Autosaver } from "./repository.js";
import { IndexedDbStorage, MemoryStorage } from "./storage.js";
import { EditorSession } from "./editor-session.js";
import { EditorController } from "./editor-controller.js";
import { buildProjectIndex } from "./project-index.js";
import { RenderScheduler } from "./render-scheduler.js";
import { readBundle } from "./bundle.js";
import { prepareProjectDownload, checkProjectSize } from "./project-io.js";
import { TextDrafts } from "./text-drafts.js";
import { createExportSnapshot } from "./export-snapshot.js";
import { AssetOperationCoordinator } from "./asset-flow.js";
const $ = (id) => document.getElementById(id);
const editor = new EditorController(new EditorSession(new Store()));
let store = editor.store,
  frame = 0,
  playing = false,
  raf,
  scaleIndex = tl.DEFAULT_SCALE,
  rows = [],
  index = null,
  stroke = null,
  fileDirty = false,
  cameraKey = 0;
const sound = new AudioEngine();
let clipId = null,
  resolved = [];
const scale = () => tl.scaleAt(scaleIndex);
const endFrame = () => index?.totalFrames ?? tl.total(rows);
const viewport = () => $("timeline").clientWidth || 900;
const timelineScheduler = new RenderScheduler(() => timeline());
const scheduleTimeline = (reason) => timelineScheduler.request(reason);
// 画像素材の表示用ビットマップ。プロジェクトにはIDだけが入る。
const images = new Map();
const tool = { erase: false, size: 3 / 1280 };
const view = { zoom: 1, x: 0, y: 0 };
const activeId = () => store.selection.active;
const isSelected = (id) => store.selection.ids.includes(id);
const current = () => index?.panelById.get(activeId()) || rows[0];
const rowFor = (id) => index?.panelById.get(id);
function reindex() {
  index = buildProjectIndex(store.p);
  rows = index.rows;
  return index;
}
function notice(t, retry = null) {
  $("status").textContent = t;
  $("status").title = t;
  if (retry || /失敗|できません|不正|見つかりません|未対応|一致しません|違います/.test(t)) {
    $("noticeText").textContent = t;
    $("errorNotice").hidden = false;
    $("noticeRetry").hidden = !retry;
    $("noticeRetry").onclick = retry;
  }
}
$("noticeDismiss").onclick = () => $("errorNotice").hidden = true;
$("noticeAssets").onclick = () => { openInspector(true); activateTab("sound"); };
let selectionKind = "panel", cameraMode = false, previewing = false, cameraDraft = null;
const treeOpen = new Map();
const drafts = new TextDrafts((entries) => {
  const result = editor.edit(p => {
    const all = flatten(p);
    for (const d of entries) {
      if (!editor.isCurrent(d.token)) continue;
      const row = all.find(r => r.panel.id === d.target);
      const object = d.kind === "project" ? p : row?.[d.kind];
      if (object) object[d.field] = d.value;
    }
  });
  store = editor.store;
  if (result.changed) { reindex(); markDirty(); }
});
function flushDrafts() { drafts.flush(); }
function displayValue(id, value) {
  const node = $(id);
  if (document.activeElement !== node || (!drafts.pending && !drafts.composing.has(id))) node.value = value;
}
function fileState() {
  $("filestate").textContent = fileDirty ? "ファイル未保存" : "";
}
function openInspector(open) {
  $("inspector").classList.toggle("is-open", open);
  $("toggleInspector").setAttribute("aria-expanded", String(open));
}
$("toggleInspector").onclick = () => openInspector(!$("inspector").classList.contains("is-open"));
$("closeInspector").onclick = () => { openInspector(false); $("toggleInspector").focus(); };

function replaceStore(project, selection) {
  drafts.clear(); treeOpen.clear(); previewing = false; selectionKind = "panel";
  editor.replace(project, selection);
  store = editor.store;
  reindex();
}
function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  // 停止時に音を残さない。次の再生は必ず予約し直す。
  sound.stop();
  $("play").textContent = "▶ 再生";
}
function edit(fn) {
  flushDrafts();
  const before = activeId();
  stop();
  try {
    // 変更がない操作はUndo段数も保存も消費しない。
    const result = editor.edit(fn);
    store = editor.store;
    if (result.changed) {
      reindex();
      if (activeId() !== before)
        frame =
          rowFor(activeId())?.start || 0;
      markDirty();
    }
    render();
  } catch (e) {
    notice(e.message);
  }
}
// Ctrl/Cmdで増減、Shiftで全体順序上の範囲選択。
function select(id, e = {}) {
  flushDrafts();
  selectionKind = "panel"; previewing = false;
  stop();
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
  editor.select({ active: id, ids });
  store = editor.store;
  const selection = store.selection;
  frame = rows.find((r) => r.panel.id === selection.active).start;
  render();
}
function history(step) {
  flushDrafts();
  stop();
  const result = step === "undo" ? editor.undo() : editor.redo();
  store = editor.store;
  if (result.changed) {
    reindex();
    frame = rowFor(activeId())?.start || 0;
    markDirty();
  }
  render();
}
function button(text, fn, cls = "") {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  b.onclick = fn;
  return b;
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
function render() {
  const focused = document.activeElement?.dataset?.focusKey;
  const treeScroll = $("tree").scrollTop, stripScroll = $("strip").scrollLeft;
  for (const d of $("tree").querySelectorAll("details[data-scene]")) treeOpen.set(d.dataset.scene, d.open);
  timelineScheduler.cancel();
  thumbnailObserver.disconnect();
  reindex();
  editor.select(store.selection);
  store = editor.store;
  resolved = audio.resolveClips(store.p, rows);
  const r = current();
  displayValue("title", store.p.title);
  fileState();
  $("tree").replaceChildren();
  store.p.scenes.forEach((s) => {
    const d = document.createElement("details");
    d.dataset.scene = s.id;
    d.open = treeOpen.get(s.id) ?? (s.id === r.scene.id);
    const summary = document.createElement("summary");
    summary.dataset.focusKey = `scene-${s.id}`;
    summary.textContent = `${s.name} (${s.shots.length} Shots)`;
    summary.title = "ダブルクリックで名前を変更";
    summary.ondblclick = (e) => {
      e.preventDefault();
      rename(summary, s.name, (value) =>
        edit((p) => (p.scenes.find((x) => x.id === s.id).name = value)),
      );
    };
    d.append(summary);
    s.shots.forEach((h, hi) => {
      const shot = button(h.name || `Shot ${hi + 1}`, (e) =>
        select(h.panels[0].id, e),
      );
      shot.className = "shot";
      shot.dataset.focusKey = `shot-${h.id}`;
      shot.title = "ダブルクリックで名前を変更";
      shot.ondblclick = (e) => {
        e.preventDefault();
        rename(shot, h.name, (value) =>
          edit((p) => {
            for (const sc of p.scenes)
              for (const sh of sc.shots) if (sh.id === h.id) sh.name = value;
          }),
        );
      };
      d.append(shot);
      h.panels.forEach((p, pi) => {
        const node = button(
            `Panel ${pi + 1} · ${p.frames}f`,
            (e) => select(p.id, e),
            `panel ${isSelected(p.id) ? "selected" : ""}`,
          );
        node.dataset.focusKey = `tree-${p.id}`;
        d.append(node);
      });
    });
    $("tree").append(d);
  });
  $("breadcrumb").textContent =
    `${r.scene.name}  /  ${r.shot.name || `Shot ${r.hi + 1}`}  /  Panel ${r.pi + 1}`;
  for (const k of ["frames", "dialogue", "sound", "notes"])
    displayValue(k, r.panel[k]);
  displayValue("sceneName", r.scene.name);
  displayValue("shotName", r.shot.name);
  const selected = rows.filter(row => isSelected(row.panel.id));
  const mixed = ["frames", "dialogue", "sound", "notes"].filter(k => new Set(selected.map(row => row.panel[k])).size > 1);
  $("selectionInfo").textContent = selected.length > 1
    ? `${selected.length}コマ選択中${mixed.length ? "・値が混在" : ""}。文章は表示中のコマのみ、尺は選択全体へ適用。`
    : "表示中のコマを編集";
  $("bulkText").hidden = selected.length < 2;
  $("frames").placeholder = mixed.includes("frames") ? "値が混在" : "";
  if (mixed.includes("frames") && document.activeElement !== $("frames")) $("frames").value = "";
  const asset =
    r.panel.image && store.p.assets.find((a) => a.id === r.panel.image.assetId);
  $("imageOpacity").value = Math.round((r.panel.image?.opacity ?? 1) * 100);
  $("imageOpacity").disabled = $("imageClear").disabled = !r.panel.image;
  $("assetInfo").textContent = asset
    ? `画像：${asset.name}（${asset.width}×${asset.height}${
        images.has(asset.id) ? "" : "・読み込めません"
      }）`
    : "画像なし";
  cameraInspector(r);
  soundInspector(r);
  $("strip").replaceChildren(
    ...r.shot.panels.map((p, i) => {
      const b = button(
        `P${i + 1} · ${p.frames}f`,
        () => {},
        isSelected(p.id) ? "selected" : "",
      );
      b.dataset.panel = p.id;
      b.dataset.focusKey = `strip-${p.id}`;
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
  timeline();
  paint();
  $("tree").scrollTop = treeScroll; $("strip").scrollLeft = stripScroll;
  if (focused) document.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
  reveal();
}
// Cameraキーの一覧と値。位置はフレームで見せ、保存は比率のまま。
function cameraInspector(r) {
  const keys = r.panel.camera;
  cameraKey = Math.max(0, Math.min(cameraKey, keys.length - 1));
  const list = $("keyList");
  list.replaceChildren(
    ...keys.map((k, i) => {
      const option = document.createElement("option");
      option.value = i;
      option.selected = i === cameraKey;
      option.textContent = `${Math.round(k.t * r.panel.frames)}f · X${k.x} Y${
        k.y
      } Z${k.zoom} R${k.rotation}°`;
      return option;
    }),
  );
  const motion = describeCamera(r.panel);
  $("cameraSummary").textContent = motion.hold
    ? "HOLD（動きなし）"
    : `${motion.moves.join(" / ")} · キー${keys.length}本`;
  const key = keys[cameraKey];
  ["cx", "cy", "cz", "cr"].forEach(
    (id, i) => ($(id).value = key[CAMERA_FIELDS[i]]),
  );
  $("keyDelete").disabled = keys.length < 2;
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
// 音声レーン。波形は素材ごとに1度だけ計算し、クリップ幅に合わせて描く。
function audioTrack(px, left, width) {
  const node = $("audioTrack");
  node.replaceChildren();
  audio.AUDIO_TRACK_ORDER.forEach((track, index) => {
    const lane = document.createElement("div");
    lane.className = "audiolane";
    lane.style.top = `${index * 26}px`;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = audio.TRACK_LABEL[track];
    lane.append(label);
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
  const columns = Math.max(2, Math.round(item.clip.frames * px));
  const wave = sound.waveform(item.clip.assetId, columns);
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
function startClipDrag(e, item, el, px) {
  if (e.target.className === "trim") return;
  stop();
  flushDrafts();
  selectionKind = "audio";
  clipId = item.clip.id;
  editor.select({active:item.clip.anchor, ids:[item.clip.anchor]}); store = editor.store;
  previewing = false; activateTab("sound", false);
  const origin = e.clientX,
    start = item.start;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const targets = $("snap").checked
    ? tl.snapTargets(rows, store.p.fps, endFrame(), frame)
    : [];
  const next = (v) => {
    const raw = start + (v.clientX - origin) / px;
    return Math.max(
      0,
      targets.length ? tl.snap(raw, targets, px) : Math.round(raw),
    );
  };
  el.onpointermove = (v) => {
    moved = true;
    el.style.left = `${next(v) * px}px`;
  };
  const finish = (v, commit) => {
    el.onpointermove = el.onpointerup = el.onpointercancel = null;
    if (!commit || !moved) return render();
    const at = next(v);
    edit((p) => audio.placeClip(p, flatten(p), item.clip.id, at));
  };
  el.onpointerup = (v) => finish(v, true);
  el.onpointercancel = (v) => finish(v, false);
}
function startClipTrim(e, item, trim, el, px) {
  e.stopPropagation();
  stop();
  flushDrafts();
  selectionKind = "audio";
  clipId = item.clip.id;
  editor.select({active:item.clip.anchor, ids:[item.clip.anchor]}); store = editor.store;
  previewing = false; activateTab("sound", false);
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
    const value = next(v);
    edit((p) => audio.trimClip(p, item.clip.id, value));
  };
  trim.onpointerup = (v) => finish(v, true);
  trim.onpointercancel = (v) => finish(v, false);
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
    clear();
    const target = dragged && commit ? targetAt(v.clientX) : null;
    if (target) {
      const ids = isSelected(id) ? store.selection.ids : [id];
      edit((p) => movePanels(p, ids, target.id, target.place));
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
  const span = tl.selectionRange(rows, store.selection.ids);
  const band = $("band");
  band.style.left = `${span.start * px}px`;
  band.style.width = `${Math.max(2, span.frames * px)}px`;
  $("range").textContent = `選択 ${span.panels} Panel · ${span.frames}f / ${(
    span.frames / store.p.fps
  ).toFixed(2)}s`;
  $("head").style.left = `${frame * px}px`;
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
      `${r.scene.name} / ${r.shot.name || `Shot ${r.hi + 1}`} / P${r.pi + 1} · ${r.panel.frames}f`,
      () => {},
      `clip ${isSelected(r.panel.id) ? "selected" : ""}`,
    );
    b.title = b.textContent;
    b.dataset.focusKey = `timeline-${r.panel.id}`;
    b.classList.toggle("shot-start", r.pi === 0);
    const label = document.createElement("span"); label.className = "clip-label";
    label.textContent = b.textContent; b.replaceChildren(label);
    if (rect.width >= 65) {
      const thumb = document.createElement("canvas"); thumb.className = "timeline-thumb";
      thumb.width = 88; thumb.height = 50;
      draw(thumb.getContext("2d"), r.panel, 88, 50, null, images);
      b.append(thumb);
    }
    b.style.left = `${rect.left}px`;
    b.style.width = `${rect.width}px`;
    b.onclick = (e) => {
      if (e.target.className !== "handle") select(r.panel.id, e);
    };
    const h = document.createElement("span");
    h.className = "handle";
    h.onpointerdown = (e) => startResize(e, r, b, h);
    b.append(h);
    node.append(b);
  }
}
// 端のドラッグはスナップ候補へ吸着し、離すまでプロジェクトを書き換えない。
function startResize(e, r, clip, handle) {
  e.stopPropagation();
  stop();
  const px = scale(),
    origin = e.clientX,
    start = r.panel.frames;
  const targets = $("snap").checked
    ? tl.snapTargets(rows, store.p.fps, endFrame(), frame)
    : [];
  const next = (v) => {
    const raw = r.start + start + (v.clientX - origin) / px;
    const snapped = targets.length
      ? tl.snap(raw, targets, px)
      : Math.round(raw);
    return Math.max(1, Math.min(864000, snapped - r.start));
  };
  handle.setPointerCapture(e.pointerId);
  handle.onpointermove = (v) => {
    clip.style.width = `${next(v) * px}px`;
  };
  handle.onpointerup = (v) => {
    const frames = next(v);
    handle.onpointermove = handle.onpointerup = null;
    edit(
      (p) =>
        (flatten(p).find((a) => a.panel.id === r.panel.id).panel.frames =
          frames),
    );
  };
  handle.onpointercancel = () => {
    handle.onpointermove = handle.onpointerup = null;
    timeline();
  };
}
// Cameraトラック：Panelごとのレーンにキーを置く。ドラッグで移動、ダブルクリックで追加。
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
      edit((p) => {
        const b = flatten(p).find((v) => v.panel.id === r.panel.id).panel;
        cameraKey = setCameraKey(b, f / r.panel.frames);
        return { active: r.panel.id, ids: [r.panel.id] };
      });
    };
    r.panel.camera.forEach((k, index) => {
      const dot = document.createElement("span");
      dot.className = `camkey${
        r.panel.id === activeId() && index === cameraKey ? " selected" : ""
      }`;
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
function startKeyDrag(e, r, index, dot, px) {
  flushDrafts(); selectionKind = "camera"; activateTab("camera", false);
  e.stopPropagation();
  stop();
  let moved = false;
  dot.setPointerCapture(e.pointerId);
  const position = (v) => localFrame(v, r, px);
  dot.onpointermove = (v) => {
    moved = true;
    dot.style.left = `${position(v) * px}px`;
  };
  const finish = (v, commit) => {
    dot.onpointermove = dot.onpointerup = dot.onpointercancel = null;
    if (!commit) return timeline();
    const f = position(v);
    edit((p) => {
      const b = flatten(p).find((a) => a.panel.id === r.panel.id).panel;
      if (moved) moveCameraKey(b, index, f / r.panel.frames);
      cameraKey = Math.max(0, cameraKeyIndexAt(b, moved ? f : null, index));
      return { active: r.panel.id, ids: [r.panel.id] };
    });
    if (!moved) render();
  };
  dot.onpointerup = (v) => finish(v, true);
  dot.onpointercancel = (v) => finish(v, false);
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
  preview = preview || playing || previewing;
  const r = preview ? rowAtFrame(rows, frame) : current();
  const key = cameraDraft ?? r.panel.camera[cameraKey] ?? r.panel.camera[0];
  const camera = preview ? cameraAt(r.panel, (frame-r.start)/r.panel.frames)
    : cameraMode && $("cameraPreview").checked ? key : null;
  draw(
    $("drawing").getContext("2d"),
    r.panel,
    1280,
    720,
    camera,
    images,
    preview || cameraMode ? null : view,
  );
  updateCameraOverlay();
  $("time").textContent = `${Math.floor(frame / store.p.fps)}s : ${Math.floor(
    frame % store.p.fps,
  )
    .toString()
    .padStart(2, "0")}f`;
  $("head").style.left = `${frame * scale()}px`;
}
const acts = {
  add: () =>
    edit((p) => {
      const r = flatten(p).find((r) => r.panel.id === activeId()),
        b = panel();
      r.shot.panels.splice(r.pi + 1, 0, b);
      return { active: b.id, ids: [b.id] };
    }),
  duplicate: () =>
    edit((p) => {
      const ids = new Set(store.selection.ids);
      for (const h of p.scenes.flatMap((s) => s.shots)) {
        h.panels = h.panels.flatMap((b) =>
          ids.has(b.id) ? [b, { ...structuredClone(b), id: uid() }] : [b],
        );
      }
    }),
  delete: () =>
    edit((p) => {
      const ids = new Set(store.selection.ids);
      if (ids.size === flatten(p).length)
        throw Error("最低1つのPanelを残してください");
      for (const s of p.scenes) {
        for (const h of s.shots)
          h.panels = h.panels.filter((b) => !ids.has(b.id));
        s.shots = s.shots.filter((h) => h.panels.length);
      }
      p.scenes = p.scenes.filter((s) => s.shots.length);
      // 消えたPanelに付いていた音も一緒に消す。孤児のクリップを残さない。
      audio.pruneClips(p);
      audio.pruneAudioAssets(p);
    }),
  split: () => edit((p) => split(p, activeId())),
  merge: () => edit((p) => merge(p, activeId())),
  scene: () =>
    edit((p) => {
      const next = scene(`シーン${p.scenes.length + 1}`);
      p.scenes.push(next);
      const b = next.shots[0].panels[0];
      return { active: b.id, ids: [b.id] };
    }),
  undo: () => history("undo"),
  redo: () => history("redo"),
};
for (const [name, delta] of [
  ["left", -1],
  ["right", 1],
])
  acts[name] = () =>
    edit((p) => {
      const r = flatten(p).find((r) => r.panel.id === activeId()),
        to = r.pi + delta;
      if (to >= 0 && to < r.shot.panels.length) {
        const [b] = r.shot.panels.splice(r.pi, 1);
        r.shot.panels.splice(to, 0, b);
      }
    });
document
  .querySelectorAll("[data-act]")
  .forEach((b) => (b.onclick = acts[b.dataset.act]));
$("frames").onchange = () => {
  if (!$("frames").value) return;
  const value = Number($("frames").value);
  edit(p => { for (const r of flatten(p)) if (isSelected(r.panel.id)) r.panel.frames = value; });
};
for (const [id, kind, field] of [
  ["title", "project", "title"], ["dialogue", "panel", "dialogue"],
  ["sound", "panel", "sound"], ["notes", "panel", "notes"],
  ["sceneName", "scene", "name"], ["shotName", "shot", "name"],
]) {
  const node = $(id);
  const stage = () => {
    stop();
    drafts.stage(id, {kind, field, target:activeId(), token:editor.capture(),
      value: kind === "scene" || kind === "shot" ? node.value.slice(0,60) : node.value});
    fileDirty = true; fileState();
    $("savestate").textContent = "入力中・保存待ち";
  };
  node.oninput = stage;
  node.oncompositionstart = () => drafts.composition(id, true);
  node.oncompositionend = () => { stage(); drafts.composition(id, false); };
  node.onchange = () => { stage(); flushDrafts(); };
  node.onblur = () => { drafts.composition(id, false); flushDrafts(); };
}
$("bulkText").onclick = () => {
  flushDrafts();
  if (!confirm(`選択した${store.selection.ids.length}コマの台詞・音注記・演出メモを、このコマの文章で置き換えますか？`)) return;
  const source = current().panel;
  edit(p => { for (const r of flatten(p)) if (isSelected(r.panel.id))
    for (const key of ["dialogue", "sound", "notes"]) r.panel[key] = source[key]; });
};
// キーは再生ヘッドがあるPanelへ置く。そのPanelを選択し直すので次の操作が続けやすい。
$("key").onclick = () => {
  flushDrafts(); selectionKind = "camera";
  const target = rowAtFrame(rows, Math.round(frame));
  edit((p) => {
    const r = flatten(p).find((v) => v.panel.id === target.panel.id);
    const local = Math.max(
      0,
      Math.min(r.panel.frames, Math.round(frame) - r.start),
    );
    cameraKey = setCameraKey(
      r.panel,
      local / r.panel.frames,
      target.panel.id === activeId() ? values() : {},
    );
    return { active: r.panel.id, ids: [r.panel.id] };
  });
};
$("keyDelete").onclick = () =>
  edit((p) => {
    const b = flatten(p).find((v) => v.panel.id === activeId()).panel;
    if (removeCameraKey(b, cameraKey)) cameraKey = Math.max(0, cameraKey - 1);
  });
$("keyList").onchange = () => {
  cameraKey = Number($("keyList").value); selectionKind = "camera"; previewing = false;
  render();
};
const values = () =>
  Object.fromEntries(
    ["cx", "cy", "cz", "cr"].map((id, i) => [
      CAMERA_FIELDS[i],
      Number($(id).value),
    ]),
  );
for (const id of ["cx", "cy", "cz", "cr"])
  $(id).onchange = () =>
    edit((p) => {
      const b = flatten(p).find((v) => v.panel.id === activeId()).panel;
      const key = b.camera[cameraKey];
      if (key) Object.assign(key, values());
      previewing = false; selectionKind = "camera";
    });
$("play").onclick = () => {
  flushDrafts();
  if (playing) {
    stop();
    return;
  }
  playing = true;
  $("play").textContent = "■ 停止";
  if (frame >= endFrame()) frame = 0;
  const start = performance.now(),
    base = Math.round(frame);
  frame = base;
  // 音があるときは音声時計を基準にする。無いときだけ表示用の時計を使う。
  const schedule = audio.scheduleFor(resolved, base, store.p.fps, endFrame());
  if (schedule.length) sound.play(schedule, base, store.p.fps);
  const tick = (now) => {
    frame =
      sound.frameAt(store.p.fps) ??
      frameAtTime(base, start, now, store.p.fps, endFrame());
    frame = Math.max(base, Math.min(endFrame(), frame));
    if (frame >= endFrame()) {
      frame = endFrame();
      stop();
    }
    const shown = rowAtFrame(rows, Math.min(frame, endFrame() - 1));
    if (shown.panel.id !== activeId()) {
      editor.select({active:shown.panel.id, ids:[shown.panel.id]}); store = editor.store;
      render();
    }
    previewing = true;
    paint(true);
    if ($("followHead").checked) {
      const view = $("timeline");
      view.scrollLeft = tl.follow(frame, scale(), view.scrollLeft, viewport());
    }
    if (playing) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
};
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
  scheduleTimeline("zoom");
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
$("timeline").onscroll = () => scheduleTimeline("scroll");
// 目盛と空き領域はスクラブ。整数フレームでPanel境界をまたぐ。
$("track").onpointerdown = (e) => {
  if (
    ![$("track"), $("ruler"), $("clips"), $("cameraTrack")].includes(e.target) && !e.target.closest(".tick")
  )
    return;
  stop();
  flushDrafts(); selectionKind = "panel";
  const targets = $("snap").checked
    ? tl.snapTargets(rows, store.p.fps, endFrame(), null)
    : [];
  const seek = (v) => {
    const raw = tl.frameAt(
      v.clientX - $("track").getBoundingClientRect().left,
      scale(),
      endFrame(),
    );
    frame = targets.length && !v.altKey ? tl.snap(raw, targets, scale()) : raw;
    const shown = rowAtFrame(rows, frame);
    previewing = true;
    if (shown.panel.id !== activeId()) {
      editor.select({active:shown.panel.id, ids:[shown.panel.id]}); store = editor.store;
      render();
    }
    paint(true);
  };
  $("track").setPointerCapture(e.pointerId);
  seek(e);
  $("track").onpointermove = seek;
  $("track").onpointerup = $("track").onpointercancel = () => {
    $("track").onpointermove = null;
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
let panning = null;
$("drawing").onpointerdown = (e) => {
  flushDrafts();
  stop();
  if (cameraMode) return;
  if (previewing) {
    const shown = rowAtFrame(rows, frame);
    editor.select({active:shown.panel.id, ids:[shown.panel.id]}); store = editor.store;
    previewing = false; render();
  }
  selectionKind = "panel";
  if (e.button === 1 || e.altKey) {
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    $("drawing").setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  stroke = {
    targetId: activeId(),
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
$("drawing").onpointerup = () => {
  panning = null;
  if (stroke) {
    const {targetId, ...s} = stroke;
    stroke = null;
    edit(
      (p) =>
        (flatten(p).find((r) => r.panel.id === targetId).panel.strokes = [
          ...flatten(p).find((r) => r.panel.id === targetId).panel.strokes,
          s,
        ]),
    );
  }
};
$("drawing").onpointercancel = () => {
  panning = null;
  stroke = null;
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
for (const [id, erase] of [
  ["brushTool", false],
  ["eraserTool", true],
])
  $(id).onclick = () => {
    tool.erase = erase;
    $("brushTool").classList.toggle("on", !erase);
    $("eraserTool").classList.toggle("on", erase);
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
  let operation = null;
  let id = null;
  let bitmap = null;
  try {
    if (!f.type.startsWith("image/")) throw Error("画像ファイルではありません");
    if (f.size > 30e6) throw Error("30MBを超える画像は未対応です");
    const token = editor.capture();
    const target = activeId();
    id = uid();
    operation = assetOps.begin({
      sessionId: token.sessionId,
      targetId: target,
      assetId: id,
    });
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
    await repo.putAsset(id, f);
    bitmap = await bitmapFor(f);
    if (!assetOps.isCurrent(operation, editor.capture().sessionId))
      throw Error("読み込み先が変更されたため画像を破棄しました");
    images.set(id, bitmap);
    bitmap = null;
    edit((p) => {
      const row = flatten(p).find((r) => r.panel.id === target);
      if (!row) throw Error("読み込み先Panelが存在しません");
      p.assets.push(meta);
      row.panel.image = {
        assetId: id,
        opacity: Number($("imageOpacity").value) / 100 || 1,
      };
    });
    assetOps.finish(operation);
    operation = null;
    notice(`${meta.name} を読み込みました（${meta.width}×${meta.height}）`);
  } catch (e) {
    bitmap?.close?.();
    if (operation) {
      await discardImportedAsset(operation, id, "image");
      operation = null;
    }
    notice(`画像を読み込めません：${e.message}`);
  }
};
$("imageClear").onclick = () =>
  edit((p) => clearPanelImage(p, activeId()));
$("imageOpacity").onchange = () =>
  edit((p) => {
    const b = flatten(p).find((r) => r.panel.id === activeId()).panel;
    if (b.image) b.image.opacity = Number($("imageOpacity").value) / 100;
  });
// 音声取り込み：原本をAssetへ保存し、デコードしてから再生ヘッド位置へ置く。
$("audioAdd").onclick = () => $("audioFile").click();
$("audioFile").onchange = async () => {
  const file = $("audioFile").files[0];
  $("audioFile").value = "";
  if (!file) return;
  let operation = null;
  let id = null;
  try {
    if (!file.type.startsWith("audio/"))
      throw Error("音声ファイルではありません");
    if (file.size > 80e6) throw Error("80MBを超える音声は未対応です");
    const token = editor.capture();
    const at = Math.round(frame);
    const host = rowAtFrame(rows, at);
    if (!host) throw Error("音声の配置先Panelがありません");
    const target = host.panel.id;
    const relativeAt = Math.max(0, at - host.start);
    id = uid();
    operation = assetOps.begin({
      sessionId: token.sessionId,
      targetId: target,
      assetId: id,
    });
    const buffer = await sound.decode(id, file);
    await repo.putAsset(id, file);
    if (!assetOps.isCurrent(operation, editor.capture().sessionId))
      throw Error("読み込み先が変更されたため音声を破棄しました");
    const frames = Math.max(1, Math.round(buffer.duration * store.p.fps));
    edit((p) => {
      const row = flatten(p).find((r) => r.panel.id === target);
      if (!row) throw Error("読み込み先Panelが存在しません");
      p.assets.push({
        id,
        kind: "audio",
        name: file.name.slice(0, 80),
        mime: file.type,
        bytes: file.size,
      });
      const clip = audio.addClip(p, {
        assetId: id,
        track: $("audioKind").value,
        anchor: target,
        at: Math.min(relativeAt, row.panel.frames),
        frames,
      });
      if (!clip) throw Error("音声トラックが不正です");
      clipId = clip.id;
      return { active: target, ids: [target] };
    });
    assetOps.finish(operation);
    operation = null;
    notice(`${file.name} を配置しました（${buffer.duration.toFixed(2)}秒）`);
  } catch (e) {
    if (operation) {
      await discardImportedAsset(operation, id, "audio");
      operation = null;
    }
    notice(`音声を読み込めません：${e.message}`);
  }
};
const currentClip = () => store.p.audio.find((c) => c.id === clipId);
$("clipList").onchange = () => {
  clipId = $("clipList").value;
  render();
};
$("clipGain").onchange = () =>
  edit((p) => {
    const clip = p.audio.find((c) => c.id === clipId);
    if (clip) clip.gain = Number($("clipGain").value) / 100;
  });
for (const [id, key] of [
  ["clipFrames", "frames"],
  ["clipOffset", "offset"],
])
  $(id).onchange = () =>
    edit((p) => {
      const clip = p.audio.find((c) => c.id === clipId);
      if (!clip) return;
      const value = Math.max(
        key === "frames" ? 1 : 0,
        Math.round(Number($(id).value) || 0),
      );
      clip[key] = Math.min(864000, value);
    });
$("clipDelete").onclick = () =>
  edit((p) => {
    audio.removeClips(p, [clipId]);
    audio.pruneAudioAssets(p);
  });
// 素材が見つからないクリップは、同じIDへ別のファイルを入れて直せる。
$("clipRepair").onclick = () => {
  const clip = currentClip();
  if (!clip) return;
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "audio/*";
  picker.onchange = async () => {
    const file = picker.files[0];
    if (!file) return;
    let operation = null;
    let id = null;
    try {
      if (!file.type.startsWith("audio/"))
        throw Error("音声ファイルではありません");
      if (file.size > 80e6) throw Error("80MBを超える音声は未対応です");
      const token = editor.capture();
      const oldAssetId = clip.assetId;
      id = uid();
      operation = assetOps.begin({
        sessionId: token.sessionId,
        targetId: clip.anchor,
        assetId: id,
      });
      const buffer = await sound.decode(id, file);
      await repo.putAsset(id, file);
      if (!assetOps.isCurrent(operation, editor.capture().sessionId))
        throw Error("読み込み先が変更されたため音声を破棄しました");
      edit((p) => {
        const current = p.audio.find((item) => item.id === clip.id);
        if (!current || current.assetId !== oldAssetId)
          throw Error("差し替え対象の音声クリップが変更されています");
        p.assets.push({
          id,
          kind: "audio",
          name: file.name.slice(0, 80),
          mime: file.type,
          bytes: file.size,
        });
        current.assetId = id;
      });
      assetOps.finish(operation);
      operation = null;
      notice(`素材を差し替えました（${buffer.duration.toFixed(2)}秒）`);
    } catch (e) {
      if (operation) {
        await discardImportedAsset(operation, id, "audio");
        operation = null;
      }
      notice(`差し替えられません：${e.message}`);
    }
  };
  picker.click();
};
function activateTab(name, redraw = true) {
  for (const t of document.querySelectorAll(".tab")) {
    t.classList.toggle("on", t.dataset.tab === name);
    t.setAttribute("aria-pressed", String(t.dataset.tab === name));
  }
  for (const pane of document.querySelectorAll("#inspector .pane")) pane.hidden = pane.dataset.pane !== name;
  cameraMode = name === "camera"; previewing = false;
  if (redraw) { selectionKind = cameraMode ? "camera" : name === "sound" ? "audio" : "panel"; paint(); }
}
for (const tab of document.querySelectorAll(".tab")) tab.onclick = () => {flushDrafts(); activateTab(tab.dataset.tab);};
$("cameraPreview").onchange = () => paint();
$("save").onclick = async () => {
  if ($("save").disabled) return;
  flushDrafts();
  $("save").disabled = true;
  notice("素材をまとめています…");
  try {
    const output = await prepareProjectDownload(store.p, editor.capture(), repo);
    download(output.blob, output.name);
    if (editor.isCurrentRevision(output.token) && !drafts.pending) fileDirty = false;
    fileState();
    notice(fileDirty ? "ファイルを書き出しました。その後の編集は未保存です。" : `${output.name} のダウンロードを開始しました`);
    await persist("manual");
  } catch (e) {
    notice(`プロジェクトを保存できません：${e.message}`, () => $("save").click());
  } finally { $("save").disabled = false; }
};
$("open").onclick = () => { flushDrafts(); $("file").click(); };
$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  try {
    flushDrafts();
    const isBundle = f.name.toLowerCase().endsWith(".contb");
    checkProjectSize(f.size, isBundle);
    // BundleはProjectと素材を検証してから、現在の編集内容へ触れる。
    let bundle = null;
    const p = isBundle
      ? (bundle = await readBundle(f)).project
      : load(await f.text());
    if (
      (fileDirty || saver.pending) &&
      !confirm("編集中の内容を置き換えて開きますか？")
    )
      return;
    flushDrafts();
    const token = editor.capture();
    const adopt = () => { stop(); replaceStore(p); };
    if (bundle) await repo.importAssets(bundle.assets, {
      isCurrent: () => editor.isCurrentRevision(token) && !drafts.pending, adopt,
    });
    else adopt();
    frame = 0;
    fileDirty = false;
    render();
    notice(bundle ? "Project Bundleを読み込みました" : "読み込み完了");
    markDirty();
    await loadImages();
  } catch (e) {
    notice(e.message, () => $("open").click());
  } finally {
    $("file").value = "";
  }
};
window.addEventListener("beforeunload", (e) => {
  // ブラウザ内保存が済んでいれば次回の起動で復旧できるので引き止めない。
  if (drafts.pending || saver.pending || (!persistence && fileDirty)) {
    e.preventDefault();
    e.returnValue = "";
  }
});
for (const event of ["pagehide", "visibilitychange"])
  window.addEventListener(event, () => {
    if (event === "pagehide" || document.visibilityState === "hidden") {
      flushDrafts(); saver.flush();
    }
  });
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault(); flushDrafts(); $("save").click(); return;
  }
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
  else if (mod && k === "s") fn = () => $("save").click();
  else if (mod && e.shiftKey && k === "k") fn = acts.merge;
  else if (mod && k === "k") fn = acts.split;
  else if (mod || e.altKey) return;
  else if (k === "n") fn = acts.add;
  else if (k === "k") fn = () => $("key").click();
  else if (k === "e")
    fn = () => $(tool.erase ? "brushTool" : "eraserTool").click();
  else if (k === "0") fn = () => $("fit").click();
  else if (k === "f") fn = () => $("fitTime").click();
  else if (k === "delete" || k === "backspace")
    fn = () => {
      if (selectionKind === "camera") { if (!$("keyDelete").disabled) $("keyDelete").click(); }
      else if (selectionKind === "audio") { if (!$("clipDelete").disabled) $("clipDelete").click(); }
      else acts.delete();
    };
  else if (k === "+" || k === "=" || k === "-")
    fn = () => {
      zoomTo(scaleIndex + (k === "-" ? -1 : 1));
    };
  else if (k === " ") fn = () => $("play").click();
  else if (k === "arrowright" || k === "arrowleft")
    fn = () => {
      const i = rows.findIndex((r) => r.panel.id === activeId());
      select(
        rows[
          Math.max(
            0,
            Math.min(rows.length - 1, i + (k === "arrowright" ? 1 : -1)),
          )
        ].panel.id,
      );
    };
  else if (k === "[" || k === "]")
    fn = () =>
      edit((p) => {
        const ids = new Set(store.selection.ids);
        for (const r of flatten(p))
          if (ids.has(r.panel.id))
            r.panel.frames = Math.max(
              1,
              Math.min(864000, r.panel.frames + (k === "]" ? 1 : -1)),
            );
      });
  if (fn) {
    e.preventDefault();
    fn();
  }
});
// 紙面設定はプロジェクトの一部。変更は履歴と自動保存に乗る。
const paper = () => store.p.paper;
const paperEdit = (change) => {
  edit((p) => change(p.paper));
  columnSettings();
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
}
// 列は順番・幅・表示/非表示をそのまま編集する。並びがそのまま紙面の並びになる。
function columnSettings() {
  const o = paper();
  const list = $("paperColumns");
  list.replaceChildren();
  const used = new Map(o.columns.map((c) => [c.key, c]));
  for (const key of [...o.columns.map(c => c.key), ...PAPER_COLUMNS.filter(k => !used.has(k))]) {
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
    const at = o.columns.findIndex(c => c.key === key);
    up.disabled = !column || at === 0;
    down.disabled = !column || at === o.columns.length - 1;
    show.disabled = !!column && o.columns.length === 1;
    show.setAttribute("aria-label", `${COLUMN_LABEL[key]}を表示`);
    width.setAttribute("aria-label", `${COLUMN_LABEL[key]}の幅`);
    up.setAttribute("aria-label", `${COLUMN_LABEL[key]}を左へ`);
    down.setAttribute("aria-label", `${COLUMN_LABEL[key]}を右へ`);
    row.append(show, name, width, up, down);
    list.append(row);
  }
}
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
    "#paperSettings input, #paperSettings select, #paperColumns input, #paperColumns button, #print, #png",
  ))
    node.disabled = running;
  if (!running) columnSettings();
}
// 出力は1ページずつ。途中でキャンセルできるようJobを渡す。
async function exportPages(handle, label) {
  if (job) return null;
  job = new Job();
  try {
    // 生成中に編集されても、1つの出力内で設定やProjectが混ざらないよう固定する。
    const exportSnapshot = createExportSnapshot(store.p, editor.capture());
    const exportProject = exportSnapshot.project;
    const exportPaper = exportProject.paper;
    const exportPagesList = layoutPages(
      exportProject,
      exportPaper,
      measureText,
      exportSnapshot.rows,
    );
    const exportImages = new Map(images);
    const total = exportPagesList.length;
    progress(`${label} 0 / ${total}`, true);
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
  flushDrafts();
  stop();
  $("paperDialog").showModal();
  await ensureImages(store.p);
  paperSettings();
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
$("png").onclick = async () => {
  const files = await exportPages(
    async (canvas, i) => ({
      name: `conte-${String(i + 1).padStart(3, "0")}.png`,
      bytes: await canvasBytes(canvas),
    }),
    "PNGを生成",
  );
  if (!files) return showPage();
  // ファイル名に使えない記号を落とす。空になったらcontEの既定名にする。
  const base =
    store.p.title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
      .trim()
      .slice(0, 40) || "conte";
  const name = `${base}-png.zip`;
  download(zip(files), name);
  notice(`${files.length}枚のPNGを${name}にまとめました`);
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
function animaticSpec(snapshot = null) {
  const project = snapshot?.project ?? store.p;
  return animatic.plan(
    snapshot?.endFrame ?? endFrame(),
    project.fps,
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
async function animaticFrames(spec, snapshot) {
  const canvas = $("animaticPreview");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const context = canvas.getContext("2d");
  animaticJob = new Job();
  const builder = new ZipBuilder();
  await forEachPage(
    spec.frames,
    async (i) => {
      animatic.renderFrame(
        context,
        snapshot.rows,
        spec.sourceFrame(i),
        spec.width,
        spec.height,
        images,
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
async function animaticRecord(spec, mime, snapshot) {
  const canvas = $("animaticPreview");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(spec.outFps);
  const snapshotAudio = audio.resolveClips(snapshot.project, snapshot.rows);
  const schedule = audio.scheduleFor(
    snapshotAudio,
    0,
    snapshot.project.fps,
    snapshot.endFrame,
  );
  if (schedule.length) {
    const destination = sound.streamDestination();
    for (const track of destination.stream.getAudioTracks())
      stream.addTrack(track);
    sound.play(schedule, 0, snapshot.project.fps, 0.12, destination);
  }
  const recorder = new animatic.Recorder(stream, mime);
  animaticJob = new Job();
  recorder.start();
  const started = performance.now();
  try {
    while (true) {
      const clock = sound.frameAt(snapshot.project.fps);
      const elapsed =
        clock !== null
          ? clock / snapshot.project.fps
          : (performance.now() - started) / 1000;
      if (elapsed >= spec.seconds) break;
      animaticJob.check();
      animatic.renderFrame(
        context,
        snapshot.rows,
        Math.max(
          0,
          Math.min(
            snapshot.endFrame - 1e-6,
            elapsed * snapshot.project.fps,
          ),
        ),
        spec.width,
        spec.height,
        images,
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
  flushDrafts();
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
  const format = $("animaticFormat").value;
  try {
    const exportSnapshot = createExportSnapshot(store.p, editor.capture());
    const spec = animaticSpec(exportSnapshot);
    animaticProgress("準備中…", true);
    // 出力中はスナップショットだけを参照し、編集中のProjectと混ぜない。
    const blob =
      format === "webm"
        ? await animaticRecord(
            spec,
            animatic.pickMime("webm"),
            exportSnapshot,
          )
        : await animaticFrames(spec, exportSnapshot);
    const name = animatic.outputName(
      exportSnapshot.project.title,
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
// Camera frame is shown in source-image coordinates; pointer gestures are a
// preview only until pointerup, so one drag is exactly one Undo operation.
function canvasGeometry() {
  const box = $("drawing").getBoundingClientRect();
  const width = Math.min(box.width, box.height * 16 / 9), height = width * 9 / 16;
  return {width, height, left:(box.width-width)/2, top:(box.height-height)/2, box};
}
function updateCameraOverlay() {
  const show = cameraMode && !playing && !previewing && !$("cameraPreview").checked;
  $("cameraOverlay").hidden = !show;
  if (!show || !current()) return;
  const g = canvasGeometry(), key = cameraDraft ?? current().panel.camera[cameraKey];
  const node = $("cameraFrame"), width = g.width/key.zoom, height = g.height/key.zoom;
  Object.assign(node.style, {left:`${g.left+g.width*(.5+key.x)-width/2}px`,
    top:`${g.top+g.height*(.5+key.y)-height/2}px`, width:`${width}px`, height:`${height}px`,
    transform:`rotate(${-key.rotation}deg)`});
}
function startCameraGesture(e, resize) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation(); flushDrafts(); stop();
  previewing = false; selectionKind = "camera";
  const node = e.currentTarget, token = editor.capture(), id = activeId(), index = cameraKey;
  const base = {...current().panel.camera[index]}, g = canvasGeometry();
  const x = e.clientX, y = e.clientY;
  const centerX = g.box.left+g.left+g.width*(.5+base.x), centerY = g.box.top+g.top+g.height*(.5+base.y);
  const distance = Math.max(1, Math.hypot(x-centerX,y-centerY));
  cameraDraft = {...base}; node.setPointerCapture(e.pointerId);
  node.onpointermove = v => {
    cameraDraft = resize ? {...base, zoom:Math.max(.1,Math.min(10,base.zoom*distance/Math.max(1,Math.hypot(v.clientX-centerX,v.clientY-centerY))))}
      : {...base,x:Math.max(-2,Math.min(2,base.x+(v.clientX-x)/g.width)),y:Math.max(-2,Math.min(2,base.y+(v.clientY-y)/g.height))};
    paint();
  };
  const finish = commit => {
    const value = cameraDraft; cameraDraft = null;
    node.onpointermove = node.onpointerup = node.onpointercancel = null;
    if (commit && editor.isCurrentRevision(token) && value)
      edit(p => Object.assign(flatten(p).find(r=>r.panel.id===id).panel.camera[index], value));
    else paint();
  };
  node.onpointerup = () => finish(true); node.onpointercancel = () => finish(false);
}
$("cameraFrame").onpointerdown = e => startCameraGesture(e, false);
$("cameraResize").onpointerdown = e => startCameraGesture(e, true);
new ResizeObserver(updateCameraOverlay).observe($("canvasArea"));
// ペインの幅/高さ。ドラッグで変え、次回の起動でも同じ配置で開く。
// Timelineの初期高さは目盛・Panel・Camera・音声の4段が全部見える値にする。
const layout = { tree: 220, inspector: 260, timeline: 270 };
const limits = {
  tree: [140, 480],
  inspector: [180, 520],
  timeline: [150, 560],
};
function applyLayout() {
  for (const [key, value] of Object.entries(layout))
    document.documentElement.style.setProperty(`--${key}`, `${value}px`);
}
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
      scheduleTimeline("layout");
    };
    node.onpointerup = node.onpointercancel = () => {
      node.onpointermove = null;
      if (persistence) repo.setLayout({ ...layout }).catch(() => {});
    };
  };
applyLayout();
render();
// 永続化はProjectRepositoryへ集約する。UIは保存の成否をそのまま表示する。
const repo = new ProjectRepository(
  IndexedDbStorage.available() ? new IndexedDbStorage() : new MemoryStorage(),
);
const assetOps = new AssetOperationCoordinator({
  retain: (id) => repo.retainAsset(id),
});
async function discardImportedAsset(operation, id, kind) {
  assetOps.finish(operation);
  if (kind === "image") {
    const bitmap = images.get(id);
    images.delete(id);
    bitmap?.close?.();
  } else if (kind === "audio") {
    sound.forget(id);
  }
  await repo.removeAsset(id).catch(() => {});
}

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
    if (drafts.pending && state === "saved") $("savestate").textContent = "入力中・保存待ち";
    if (state === "failed") notice(`自動保存に失敗：${message}`, () => saver.flush());
  },
});
function markDirty() {
  fileDirty = true; fileState();
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
  render();
  if (missing.length)
    notice(
      `素材が${missing.length}件見つかりません（${missing[0]}ほか）。.contpに素材は含まれません。音は「音」タブから差し替えられます。`,
    );
  return missing;
}
function offerRecovery({ meta, project }) {
  $("recoverInfo").textContent = `${clock(meta.savedAt)} ／ ${
    meta.title
  } ／ ${meta.panels} Panel ／ ${meta.kind === "manual" ? "手動保存" : "自動保存"}`;
  $("recover").onclick = async () => {
    $("recoverDialog").close();
    stop();
    replaceStore(project);
    frame = 0;
    fileDirty = true;
    render();
    saver.resolved(meta);
    notice("前回の作業を復旧しました。ファイルへの保存は別に行ってください。");
    await loadImages();
  };
  $("discardRecovery").onclick = async () => {
    $("recoverDialog").close();
    await repo.dismiss(meta.savedAt).catch(() => {});
    notice("復旧候補を今回は使いません（保存データは残っています）");
  };
  $("recoverDialog").showModal();
}
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

