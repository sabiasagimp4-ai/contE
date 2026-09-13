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
} from "./model.js";
import { draw } from "./drawing.js";
import { defaults, paginate, renderPage, download } from "./paper.js";
const $ = (id) => document.getElementById(id);
let store = new Store(),
  selected = new Set([flatten(store.p)[0].panel.id]),
  active = [...selected][0],
  frame = 0,
  playing = false,
  raf,
  scale = 3,
  rows = [],
  stroke = null,
  dirty = false;
const current = () => rows.find((r) => r.panel.id === active) || rows[0];
const notice = (t) => ($("status").textContent = t);
function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  $("play").textContent = "▶ 再生";
}
function edit(fn) {
  const oldActive = active;
  stop();
  try {
    store.edit(fn);
    if (active !== oldActive)
      frame = flatten(store.p).find((r) => r.panel.id === active)?.start || 0;
    dirty = true;
    render();
  } catch (e) {
    notice(e.message);
  }
}
function select(id, multi = false) {
  stop();
  active = id;
  if (multi) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    if (!selected.size) selected.add(id);
  } else selected = new Set([id]);
  frame = rows.find((r) => r.panel.id === id).start;
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
        if (b) draw(e.target.getContext("2d"), b, 120, 68);
        thumbnailObserver.unobserve(e.target);
      }
  },
  { root: $("strip") },
);
function render() {
  thumbnailObserver.disconnect();
  rows = flatten(store.p);
  selected = new Set(
    [...selected].filter((id) => rows.some((r) => r.panel.id === id)),
  );
  if (!rows.some((r) => r.panel.id === active)) active = rows[0].panel.id;
  if (!selected.size) selected.add(active);
  const r = current();
  $("title").value = store.p.title;
  $("tree").replaceChildren();
  store.p.scenes.forEach((s, si) => {
    const d = document.createElement("details");
    d.open = s.id === r.scene.id;
    const summary = document.createElement("summary");
    summary.textContent = `${s.name} (${s.shots.length} Shots)`;
    d.append(summary);
    s.shots.forEach((h, hi) => {
      d.append(button(`Shot ${hi + 1}`, () => select(h.panels[0].id)));
      h.panels.forEach((p, pi) =>
        d.append(
          button(
            `Panel ${pi + 1} · ${p.frames}f`,
            (e) => select(p.id),
            `panel ${selected.has(p.id) ? "selected" : ""}`,
          ),
        ),
      );
    });
    $("tree").append(d);
  });
  $("breadcrumb").textContent =
    `${r.scene.name}  /  Shot ${r.hi + 1}  /  Panel ${r.pi + 1}`;
  for (const k of ["frames", "dialogue", "sound", "notes"])
    $(k).value = r.panel[k];
  const cam = r.panel.camera.at(-1);
  ["cx", "cy", "cz", "cr"].forEach(
    (id, i) => ($(id).value = cam[["x", "y", "zoom", "rotation"][i]]),
  );
  $("strip").replaceChildren(
    ...r.shot.panels.map((p, i) => {
      const b = button(
        `P${i + 1} · ${p.frames}f`,
        () => select(p.id),
        selected.has(p.id) ? "selected" : "",
      );
      b.onclick = (e) => select(p.id, e.ctrlKey || e.metaKey);
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
      `clip ${selected.has(r.panel.id) ? "selected" : ""}`,
    );
    b.style.left = `${r.start * scale}px`;
    b.style.width = `${r.panel.frames * scale}px`;
    b.onclick = (e) => {
      if (e.target.className !== "handle")
        select(r.panel.id, e.ctrlKey || e.metaKey);
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
      const r = flatten(p).find((r) => r.panel.id === active),
        b = panel();
      r.shot.panels.splice(r.pi + 1, 0, b);
      active = b.id;
      selected = new Set([active]);
    }),
  duplicate: () =>
    edit((p) => {
      for (const h of p.scenes.flatMap((s) => s.shots)) {
        h.panels = h.panels.flatMap((b) =>
          selected.has(b.id) ? [b, { ...structuredClone(b), id: uid() }] : [b],
        );
      }
    }),
  delete: () =>
    edit((p) => {
      if (selected.size === rows.length)
        throw Error("最低1つのPanelを残してください");
      for (const s of p.scenes) {
        for (const h of s.shots)
          h.panels = h.panels.filter((b) => !selected.has(b.id));
        s.shots = s.shots.filter((h) => h.panels.length);
      }
      p.scenes = p.scenes.filter((s) => s.shots.length);
    }),
  split: () => edit((p) => split(p, active)),
  merge: () => edit((p) => merge(p, active)),
  scene: () =>
    edit((p) => {
      const b = panel();
      p.scenes.push({
        id: uid(),
        name: `シーン${p.scenes.length + 1}`,
        shots: [{ id: uid(), panels: [b] }],
      });
      active = b.id;
      selected = new Set([active]);
    }),
  undo: () => {
    stop();
    store.undo();
    dirty = true;
    render();
  },
  redo: () => {
    stop();
    store.redo();
    dirty = true;
    render();
  },
};
for (const [name, delta] of [
  ["left", -1],
  ["right", 1],
])
  acts[name] = () =>
    edit((p) => {
      const r = flatten(p).find((r) => r.panel.id === active),
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
      for (const r of flatten(p))
        if (selected.has(r.panel.id))
          r.panel[k] = k === "frames" ? Number($(k).value) : $(k).value;
    });
$("title").onchange = () => edit((p) => (p.title = $("title").value));
$("key").onclick = () =>
  edit((p) => {
    const b = flatten(p).find((r) => r.panel.id === active).panel;
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
function point(e) {
  const r = $("drawing").getBoundingClientRect(),
    ratio = 16 / 9;
  let w = r.width,
    h = w / ratio;
  if (h > r.height) {
    h = r.height;
    w = h * ratio;
  }
  return [
    Math.max(0, Math.min(1, (e.clientX - r.left - (r.width - w) / 2) / w)),
    Math.max(0, Math.min(1, (e.clientY - r.top - (r.height - h) / 2) / h)),
  ];
}
$("drawing").onpointerdown = (e) => {
  if (e.button !== 0) return;
  stop();
  stroke = [point(e)];
  $("drawing").setPointerCapture(e.pointerId);
};
$("drawing").onpointermove = (e) => {
  if (!stroke) return;
  stroke.push(point(e));
  draw(
    $("drawing").getContext("2d"),
    { ...current().panel, strokes: [...current().panel.strokes, stroke] },
    1280,
    720,
  );
};
$("drawing").onpointerup = () => {
  if (stroke) {
    const s = stroke;
    stroke = null;
    edit(
      (p) =>
        (flatten(p).find((r) => r.panel.id === active).panel.strokes = [
          ...flatten(p).find((r) => r.panel.id === active).panel.strokes,
          s,
        ]),
    );
  }
};
$("drawing").onpointercancel = () => {
  stroke = null;
  paint();
};
$("save").onclick = () => {
  download(
    new Blob([JSON.stringify(store.p)], { type: "application/json" }),
    "project.contp",
  );
  dirty = false;
  notice("プロジェクトをダウンロードしました");
};
$("open").onclick = () => $("file").click();
$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  try {
    if (f.size > 50e6) throw Error("50MBを超えるファイルは未対応です");
    const p = load(await f.text());
    if (dirty && !confirm("未保存の変更を破棄して開きますか？")) return;
    stop();
    store = new Store(p);
    frame = 0;
    dirty = false;
    render();
    notice("読み込み完了");
  } catch (e) {
    notice(e.message);
  } finally {
    $("file").value = "";
  }
};
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || $("paperDialog").open)
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
  else if (k === "+" || k === "=" || k === "-") fn = () => {
    $("zoom").value=Math.max(1,Math.min(12,scale+(k==="-"?-1:1)));
    $("zoom").dispatchEvent(new Event("input"));
  };
  else if (k === " ") fn = () => $("play").click();
  else if (k === "arrowright" || k === "arrowleft")
    fn = () => {
      const i = rows.findIndex((r) => r.panel.id === active);
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
        for (const r of flatten(p))
          if (selected.has(r.panel.id))
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
    const page = renderPage(store.p, groups[i], options, i, groups.length);
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
$("paper").onclick = () => {
  stop();
  $("paperDialog").showModal();
  preview();
};
$("closePaper").onclick = () => $("paperDialog").close();
$("print").onclick = async () => {
  const images = [];
  for (let i = 0; i < groups.length; i++) {
    const { canvas } = renderPage(
      store.p,
      groups[i],
      options,
      i,
      groups.length,
    );
    const img = new Image();
    img.src = canvas.toDataURL("image/png");
    await img.decode();
    images.push(img);
    canvas.width = 0;
    canvas.height = 0;
  }
  $("pages").replaceChildren(...images);
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
render();
