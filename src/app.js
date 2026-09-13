import { frameAtTime, rowAtFrame } from "./playback.js";
import {
  Store,
  panel,
  uid,
  flatten,
  load,
  split,
  merge,
  cameraAt,
  movePanels,
  BRUSH,
} from "./model.js";
import { draw } from "./drawing.js";
import { defaults, paginate, renderPage, download } from "./paper.js";
import { ProjectRepository, Autosaver } from "./repository.js";
import { IndexedDbStorage, MemoryStorage } from "./storage.js";
const $ = (id) => document.getElementById(id);
let store = new Store(),
  frame = 0,
  playing = false,
  raf,
  scale = 3,
  rows = [],
  stroke = null,
  fileDirty = false;
// 画像素材の表示用ビットマップ。プロジェクトにはIDだけが入る。
const images = new Map();
const tool = { erase: false, size: 3 / 1280 };
const view = { zoom: 1, x: 0, y: 0 };
const activeId = () => store.selection.active;
const isSelected = (id) => store.selection.ids.includes(id);
const current = () => rows.find((r) => r.panel.id === activeId()) || rows[0];
const notice = (t) => ($("status").textContent = t);
function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  $("play").textContent = "▶ 再生";
}
function edit(fn) {
  const before = activeId();
  stop();
  try {
    // 変更がない操作はUndo段数も保存も消費しない。
    if (store.edit(fn)) {
      if (activeId() !== before)
        frame =
          flatten(store.p).find((r) => r.panel.id === activeId())?.start || 0;
      markDirty();
    }
    render();
  } catch (e) {
    notice(e.message);
  }
}
// Ctrl/Cmdで増減、Shiftで全体順序上の範囲選択。
function select(id, e = {}) {
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
  store.select({ active: id, ids });
  frame = rows.find((r) => r.panel.id === id).start;
  render();
}
function history(step) {
  stop();
  if (store[step]()) {
    frame = flatten(store.p).find((r) => r.panel.id === activeId())?.start || 0;
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
  thumbnailObserver.disconnect();
  rows = flatten(store.p);
  store.select(store.selection);
  const r = current();
  $("title").value = store.p.title;
  $("tree").replaceChildren();
  store.p.scenes.forEach((s) => {
    const d = document.createElement("details");
    d.open = s.id === r.scene.id;
    const summary = document.createElement("summary");
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
      h.panels.forEach((p, pi) =>
        d.append(
          button(
            `Panel ${pi + 1} · ${p.frames}f`,
            (e) => select(p.id, e),
            `panel ${isSelected(p.id) ? "selected" : ""}`,
          ),
        ),
      );
    });
    $("tree").append(d);
  });
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
  $("assetInfo").textContent = asset
    ? `画像：${asset.name}（${asset.width}×${asset.height}${
        images.has(asset.id) ? "" : "・読み込めません"
      }）`
    : "画像なし";
  const cam = r.panel.camera.at(-1);
  ["cx", "cy", "cz", "cr"].forEach(
    (id, i) => ($(id).value = cam[["x", "y", "zoom", "rotation"][i]]),
  );
  $("strip").replaceChildren(
    ...r.shot.panels.map((p, i) => {
      const b = button(
        `P${i + 1} · ${p.frames}f`,
        () => {},
        isSelected(p.id) ? "selected" : "",
      );
      b.dataset.panel = p.id;
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
  reveal();
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
  const view = $("timeline"),
    x = current().start * scale;
  if (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth - 40)
    view.scrollLeft = Math.max(0, x - view.clientWidth / 3);
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
function timeline() {
  const track = $("track");
  track.replaceChildren();
  track.style.width = `${rows.at(-1).end * scale}px`;
  const left = $("timeline").scrollLeft,
    right = left + $("timeline").clientWidth;
  for (const r of rows) {
    if (r.end * scale < left - 100 || r.start * scale > right + 100) continue;
    const b = button(
      `P${r.pi + 1} · ${r.panel.frames}f`,
      () => {},
      `clip ${isSelected(r.panel.id) ? "selected" : ""}`,
    );
    b.style.left = `${r.start * scale}px`;
    b.style.width = `${r.panel.frames * scale}px`;
    b.onclick = (e) => {
      if (e.target.className !== "handle") select(r.panel.id, e);
    };
    const h = document.createElement("span");
    h.className = "handle";
    h.onpointerdown = (e) => {
      e.stopPropagation();
      stop();
      const x = e.clientX,
        original = r.panel.frames;
      h.setPointerCapture(e.pointerId);
      h.onpointermove = (v) => {
        b.style.width = `${Math.max(1, original + Math.round((v.clientX - x) / scale)) * scale}px`;
      };
      h.onpointerup = (v) => {
        const n = Math.max(
          1,
          Math.min(864000, original + Math.round((v.clientX - x) / scale)),
        );
        edit(
          (p) =>
            (flatten(p).find((a) => a.panel.id === r.panel.id).panel.frames =
              n),
        );
      };
      h.onpointercancel = () => timeline();
    };
    b.append(h);
    track.append(b);
  }
  const head = document.createElement("div");
  head.id = "head";
  head.style.left = `${frame * scale}px`;
  track.append(head);
}
function paint(preview = false) {
  const r = preview ? rowAtFrame(rows, frame) : current();
  draw(
    $("drawing").getContext("2d"),
    r.panel,
    1280,
    720,
    preview ? cameraAt(r.panel, (frame - r.start) / r.panel.frames) : null,
    images,
    preview ? null : view,
  );
  $("time").textContent = `${Math.floor(frame / store.p.fps)}s : ${Math.floor(
    frame % store.p.fps,
  )
    .toString()
    .padStart(2, "0")}f`;
  if ($("head")) $("head").style.left = `${frame * scale}px`;
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
    }),
  split: () => edit((p) => split(p, activeId())),
  merge: () => edit((p) => merge(p, activeId())),
  scene: () =>
    edit((p) => {
      const b = panel();
      p.scenes.push({
        id: uid(),
        name: `シーン${p.scenes.length + 1}`,
        shots: [{ id: uid(), panels: [b] }],
      });
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
for (const k of ["frames", "dialogue", "sound", "notes"])
  $(k).onchange = () =>
    edit((p) => {
      const ids = new Set(store.selection.ids);
      for (const r of flatten(p))
        if (ids.has(r.panel.id))
          r.panel[k] = k === "frames" ? Number($(k).value) : $(k).value;
    });
$("title").onchange = () => edit((p) => (p.title = $("title").value));
$("key").onclick = () =>
  edit((p) => {
    const b = flatten(p).find((r) => r.panel.id === activeId()).panel;
    const k = {
      t: 1,
      x: Number($("cx").value),
      y: Number($("cy").value),
      zoom: Number($("cz").value),
      rotation: Number($("cr").value),
    };
    b.camera = [b.camera[0], k];
  });
$("play").onclick = () => {
  if (playing) {
    stop();
    return;
  }
  playing = true;
  $("play").textContent = "■ 停止";
  if (frame >= rows.at(-1).end) frame = 0;
  const start = performance.now(),
    base = frame;
  const tick = (now) => {
    frame = frameAtTime(base, start, now, store.p.fps, rows.at(-1).end);
    if (frame >= rows.at(-1).end) {
      frame = rows.at(-1).end;
      stop();
    }
    paint(true);
    if (playing) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
};
$("zoom").oninput = () => {
  const anchor = $("timeline").scrollLeft / scale;
  scale = Number($("zoom").value);
  $("timeline").scrollLeft = anchor * scale;
  timeline();
};
$("timeline").onscroll = () => timeline();
$("track").onpointerdown = (e) => {
  if (e.target !== $("track")) return;
  stop();
  const seek = (v) => {
    frame = Math.max(
      0,
      Math.min(
        rows.at(-1).end,
        (v.clientX - $("track").getBoundingClientRect().left) / scale,
      ),
    );
    paint(true);
  };
  $("track").setPointerCapture(e.pointerId);
  seek(e);
  $("track").onpointermove = seek;
  $("track").onpointerup = () => {
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
  stop();
  if (e.button === 1 || e.altKey) {
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    $("drawing").setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
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
    const s = stroke;
    stroke = null;
    edit(
      (p) =>
        (flatten(p).find((r) => r.panel.id === activeId()).panel.strokes = [
          ...flatten(p).find((r) => r.panel.id === activeId()).panel.strokes,
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
  try {
    if (!f.type.startsWith("image/")) throw Error("画像ファイルではありません");
    if (f.size > 30e6) throw Error("30MBを超える画像は未対応です");
    const source = await createImageBitmap(f);
    const id = uid();
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
    images.set(id, await bitmapFor(f));
    const target = activeId();
    edit((p) => {
      p.assets.push(meta);
      flatten(p).find((r) => r.panel.id === target).panel.image = {
        assetId: id,
        opacity: Number($("imageOpacity").value) / 100 || 1,
      };
    });
    notice(`${meta.name} を読み込みました（${meta.width}×${meta.height}）`);
  } catch (e) {
    notice(`画像を読み込めません：${e.message}`);
  }
};
$("imageClear").onclick = () =>
  edit((p) => {
    const b = flatten(p).find((r) => r.panel.id === activeId()).panel;
    b.image = null;
    // どのPanelからも参照されない素材はプロジェクトから外す。
    const used = new Set(
      flatten(p)
        .map((r) => r.panel.image?.assetId)
        .filter(Boolean),
    );
    p.assets = p.assets.filter((a) => used.has(a.id));
  });
$("imageOpacity").onchange = () =>
  edit((p) => {
    const b = flatten(p).find((r) => r.panel.id === activeId()).panel;
    if (b.image) b.image.opacity = Number($("imageOpacity").value) / 100;
  });
for (const [id, key] of [
  ["sceneName", "scene"],
  ["shotName", "shot"],
])
  $(id).onchange = () =>
    edit((p) => {
      const r = flatten(p).find((v) => v.panel.id === activeId());
      r[key].name = $(id).value.slice(0, 60);
    });
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
    store = new Store(p);
    frame = 0;
    fileDirty = false;
    render();
    notice("読み込み完了");
    markDirty();
    await loadImages();
  } catch (e) {
    notice(e.message);
  } finally {
    $("file").value = "";
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
document.addEventListener("keydown", (e) => {
  if (
    /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) ||
    $("paperDialog").open ||
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
  else if (k === "n") fn = acts.add;
  else if (k === "k") fn = () => $("key").click();
  else if (k === "e")
    fn = () => $(tool.erase ? "brushTool" : "eraserTool").click();
  else if (k === "0") fn = () => $("fit").click();
  else if (k === "+" || k === "=" || k === "-")
    fn = () => {
      $("zoom").value = Math.max(1, Math.min(12, scale + (k === "-" ? -1 : 1)));
      $("zoom").dispatchEvent(new Event("input"));
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
const options = { ...defaults };
for (const [key, title, min, max] of [
  ["rows", "コマ / ページ", 1, 8],
  ["margin", "余白 (px)", 20, 100],
  ["font", "文字サイズ (px)", 12, 30],
  ["imageWidth", "画像列幅 (%)", 20, 65],
  ["header", "ヘッダー"],
]) {
  const l = document.createElement("label");
  l.textContent = title;
  const i = document.createElement("input");
  i.type = key === "header" ? "text" : "number";
  i.value = options[key];
  if (min) {
    i.min = min;
    i.max = max;
  }
  i.onchange = () => {
    options[key] =
      key === "header"
        ? i.value
        : Math.max(min, Math.min(max, Math.round(Number(i.value)) || min));
    preview();
  };
  l.append(i);
  $("paperSettings").append(l);
}
for (const [key, title] of Object.entries({
  cut: "CUT番号",
  image: "コンテ画像",
  duration: "尺",
  dialogue: "台詞",
  sound: "SE / BGM",
  notes: "演出メモ",
  camera: "Camera",
  numbers: "階層番号",
})) {
  const l = document.createElement("label"),
    i = document.createElement("input");
  i.type = "checkbox";
  i.checked = true;
  i.onchange = () => {
    options[key] = i.checked;
    preview();
  };
  l.append(i, title);
  $("paperSettings").append(l);
}
let pageIndex = 0,
  groups = [],
  hasOverflow = false;
const paging = document.createElement("div");
const previous = button("← 前ページ", () => {
  pageIndex = Math.max(0, pageIndex - 1);
  showPage();
});
const next = button("次ページ →", () => {
  pageIndex = Math.min(groups.length - 1, pageIndex + 1);
  showPage();
});
const pageLabel = document.createElement("span");
paging.append(previous, pageLabel, next);
$("pages").before(paging);
function showPage() {
  const page = renderPage(
    store.p,
    groups[pageIndex],
    options,
    pageIndex,
    groups.length,
    images,
  );
  $("pages").replaceChildren(page.canvas);
  pageLabel.textContent = ` ${pageIndex + 1} / ${groups.length} `;
  previous.disabled = pageIndex === 0;
  next.disabled = pageIndex === groups.length - 1;
}
function preview() {
  groups = paginate(store.p, options);
  pageIndex = Math.min(pageIndex, groups.length - 1);
  hasOverflow = false;
  for (let i = 0; i < groups.length; i++) {
    const page = renderPage(
      store.p,
      groups[i],
      options,
      i,
      groups.length,
      images,
    );
    hasOverflow ||= page.overflow > 0;
    page.canvas.width = 0;
    page.canvas.height = 0;
  }
  showPage();
  $("print").disabled = hasOverflow;
  $("png").disabled = hasOverflow;
  notice(
    hasOverflow
      ? "文字が収まらないコマがあります。コマ数を減らすか文字を小さくしてください。"
      : "紙コンテの準備完了",
  );
}
$("paper").onclick = async () => {
  stop();
  $("paperDialog").showModal();
  await ensureImages(store.p);
  preview();
};
$("closePaper").onclick = () => $("paperDialog").close();
$("print").onclick = async () => {
  const sheets = [];
  for (let i = 0; i < groups.length; i++) {
    const { canvas } = renderPage(
      store.p,
      groups[i],
      options,
      i,
      groups.length,
      images,
    );
    const img = new Image();
    img.src = canvas.toDataURL("image/png");
    await img.decode();
    sheets.push(img);
    canvas.width = 0;
    canvas.height = 0;
  }
  $("pages").replaceChildren(...sheets);
  window.print();
};
window.addEventListener("afterprint", () => {
  if ($("paperDialog").open) showPage();
});
$("png").onclick = async () => {
  for (let i = 0; i < groups.length; i++) {
    const { canvas } = renderPage(
      store.p,
      groups[i],
      options,
      i,
      groups.length,
      images,
    );
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    download(blob, `conte-${String(i + 1).padStart(3, "0")}.png`);
    canvas.width = 0;
    canvas.height = 0;
  }
  notice(
    "PNG連番をダウンロードしました（複数ダウンロードの許可が必要な場合があります）",
  );
};
// ペインの幅/高さ。ドラッグで変え、次回の起動でも同じ配置で開く。
const layout = { tree: 220, inspector: 260, timeline: 190 };
const limits = {
  tree: [140, 480],
  inspector: [180, 520],
  timeline: [120, 520],
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
      timeline();
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
    if (persistence) saver.schedule(() => store.p);
  } catch (e) {
    notice(`自動保存を予約できません：${e.message}`);
  }
}
async function persist(kind) {
  if (!persistence) return null;
  const snapshot = store.p;
  try {
    const meta = await repo.save(snapshot, { kind });
    await repo.pruneAssets(snapshot).catch(() => {});
    if (store.p === snapshot) saver.resolved(meta);
    return meta;
  } catch (e) {
    notice(`ブラウザ内保存に失敗：${e.message}`);
    return null;
  }
}
// 素材のビットマップを用意し、見つからないものは黙って無視しない。
async function loadImages() {
  const missing = await ensureImages(store.p);
  render();
  if (missing.length)
    notice(
      `画像素材が${missing.length}件見つかりません（${missing[0]}ほか）。.contpに素材は含まれません。`,
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
    store = new Store(project);
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
