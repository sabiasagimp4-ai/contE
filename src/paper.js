import {
  flatten,
  describeCamera,
  PAPER_SIZES,
  paperDefaults,
} from "./model.js";
import { resolveClips, soundNotes, soundText } from "./audio.js";
import { draw } from "./drawing.js";
export const defaults = paperDefaults;
// よく使う組み合わせを名前で呼び出せるようにする（D3）。header/footerは文書ごとの
// テキストなのでプリセットには含めない。ユーザーが保存した分はrepositoryのmeta
// ストアへ別に持つ。
export const PAPER_PRESETS = [
  {
    name: "標準",
    size: "A4",
    orientation: "portrait",
    rows: 4,
    margin: 45,
    font: 18,
    columns: [
      { key: "cut", width: 10 },
      { key: "image", width: 40 },
      { key: "dialogue", width: 18 },
      { key: "sound", width: 16 },
      { key: "notes", width: 16 },
    ],
  },
  {
    name: "台詞多め",
    size: "A4",
    orientation: "portrait",
    rows: 3,
    margin: 45,
    font: 20,
    columns: [
      { key: "cut", width: 8 },
      { key: "image", width: 28 },
      { key: "dialogue", width: 34 },
      { key: "sound", width: 15 },
      { key: "notes", width: 15 },
    ],
  },
  {
    name: "簡易一覧",
    size: "A3",
    orientation: "landscape",
    rows: 6,
    margin: 30,
    font: 14,
    columns: [
      { key: "cut", width: 10 },
      { key: "image", width: 55 },
      { key: "dialogue", width: 35 },
    ],
  },
];
export const COLUMN_LABEL = {
  cut: "CUT",
  image: "コンテ",
  dialogue: "台詞",
  sound: "SE / BGM",
  notes: "演出",
  camera: "Camera",
};
const font = (size, bold = false) =>
  `${bold ? "bold " : ""}${size}px "Noto Sans JP", sans-serif`;
// 用紙の実寸から、行と列の位置をすべて決めてから描く。描画中に配置を決めない。
export function pageGeometry(o) {
  const size = PAPER_SIZES[o.size] ?? PAPER_SIZES.A4;
  const [w, h] =
    o.orientation === "landscape" ? [size.px[1], size.px[0]] : size.px;
  const top = o.margin + 45,
    bottom = h - o.margin - (o.footer ? 28 : 10);
  const rowH = (bottom - top) / o.rows;
  const width = w - o.margin * 2;
  const total = o.columns.reduce((sum, c) => sum + c.width, 0) || 1;
  let x = o.margin;
  const columns = o.columns.map((c) => {
    const cw = (width * c.width) / total;
    const column = { ...c, x, width: cw };
    x += cw;
    return column;
  });
  return { width: w, height: h, top, bottom, rowH, columns, inner: width };
}
// 文字は幅で折り返すだけ。切り捨てはせず、入り切らない分は呼び出し側が次の行へ送る。
export function wrapLines(text, width, measure) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const ch of paragraph) {
      if (line && measure(line + ch) > width) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}
export function columnText(p, all, clips, r, o, key) {
  switch (key) {
    case "cut": {
      const index = all.findIndex((v) => v.panel.id === r.panel.id) + 1;
      const parts = [`CUT ${index}`];
      if (o.numbers) parts.push(`S${r.si + 1}/SH${r.hi + 1}/P${r.pi + 1}`);
      if (o.duration)
        parts.push(
          `${r.panel.frames}f`,
          `${(r.panel.frames / p.fps).toFixed(2)}s`,
        );
      return parts.join("\n");
    }
    case "dialogue":
      return r.panel.dialogue;
    case "sound": {
      const placed = soundText(
        soundNotes(p, all, r, clips).filter((n) => n.track !== "dialogue"),
      );
      return [r.panel.sound, placed].filter(Boolean).join("\n");
    }
    case "notes":
      return r.panel.notes;
    case "camera": {
      const { keys, moves, hold } = describeCamera(r.panel);
      return hold
        ? "HOLD"
        : `${moves.join(" / ")}\n${keys
            .map((k) => `${Math.round(k.t * r.panel.frames)}f`)
            .join(" → ")}`;
    }
    default:
      return "";
  }
}
// 1行に入る行数で切り、残りは次のページの「続き」へ回す。文字を捨てない。
export function layoutPages(p, o, measure, rows = flatten(p)) {
  const geometry = pageGeometry(o);
  const clips = resolveClips(p, rows);
  const lineHeight = o.font * 1.45;
  const pages = [];
  let page = [];
  const push = (entry) => {
    page.push(entry);
    if (page.length >= o.rows) {
      pages.push(page);
      page = [];
    }
  };
  rows.forEach((r, index) => {
    const label = `CUT ${index + 1}`;
    let pending = new Map(
      geometry.columns
        .filter((c) => c.key !== "image")
        .map((c) => [
          c.key,
          wrapLines(
            columnText(p, rows, clips, r, o, c.key),
            c.width - 16,
            (text) => measure(text, o.font),
          ),
        ]),
    );
    let first = true;
    while (true) {
      const available = Math.max(
        1,
        Math.floor((geometry.rowH - (first ? 26 : 30)) / lineHeight),
      );
      const cells = new Map();
      const rest = new Map();
      for (const [key, lines] of pending) {
        cells.set(key, lines.slice(0, available));
        const remaining = lines.slice(available);
        if (remaining.some((line) => line.trim())) rest.set(key, remaining);
      }
      // 続き行はCUT番号に「（続き）」を添える。全列に印を散らさない。
      if (!first && cells.has("cut"))
        cells.set("cut", [label, "（続き）", ...(cells.get("cut") ?? [])]);
      push({ row: r, cells, continuation: !first, label });
      if (!rest.size) break;
      pending = rest;
      first = false;
    }
  });
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}
// Camera表記は再生と同じキー列から作る。全キーを通る軌道と開始/終了枠を描く。
export function cameraNotation(c, b, x, y, w, h) {
  const { keys, moves, hold } = describeCamera(b);
  const center = (k) => [x + w / 2 + k.x * w, y + h / 2 + k.y * h];
  c.save();
  c.strokeStyle = "#bb3f27";
  c.fillStyle = "#bb3f27";
  c.lineWidth = 2;
  if (hold) {
    c.fillText("HOLD", x + 8, y + 22);
    c.restore();
    return;
  }
  const frame = (k, dashed) => {
    c.save();
    c.setLineDash(dashed ? [6, 4] : []);
    c.translate(...center(k));
    c.rotate((k.rotation * Math.PI) / 180);
    c.strokeRect(-w / (2 * k.zoom), -h / (2 * k.zoom), w / k.zoom, h / k.zoom);
    c.restore();
  };
  frame(keys[0], false);
  frame(keys.at(-1), true);
  c.beginPath();
  keys.forEach((k, i) => {
    const [cx, cy] = center(k);
    i ? c.lineTo(cx, cy) : c.moveTo(cx, cy);
  });
  c.stroke();
  const [px, py] = center(keys.at(-2) ?? keys[0]),
    [ex, ey] = center(keys.at(-1));
  if (px !== ex || py !== ey) {
    // PANは横、TILTは縦の矢印になる。軌道の向きがそのまま矢印の向き。
    const angle = Math.atan2(ey - py, ex - px);
    c.beginPath();
    c.moveTo(ex, ey);
    c.lineTo(ex - 12 * Math.cos(angle - 0.5), ey - 12 * Math.sin(angle - 0.5));
    c.moveTo(ex, ey);
    c.lineTo(ex - 12 * Math.cos(angle + 0.5), ey - 12 * Math.sin(angle + 0.5));
    c.stroke();
  }
  for (const k of keys.slice(1, -1)) {
    const [cx, cy] = center(k);
    c.beginPath();
    c.arc(cx, cy, 4, 0, Math.PI * 2);
    c.fill();
  }
  c.fillText(moves.join(" / "), x + 8, y + 22);
  c.restore();
}
export function renderPage(p, page, o, index, total, images, canvas) {
  const geometry = pageGeometry(o);
  const target = canvas ?? document.createElement("canvas");
  target.width = geometry.width;
  target.height = geometry.height;
  const c = target.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, geometry.width, geometry.height);
  c.fillStyle = "#111";
  c.font = font(28, true);
  c.fillText((o.header || p.title).slice(0, 60), o.margin, o.margin + 10);
  c.font = font(16);
  c.textAlign = "right";
  c.fillText(
    `${index + 1} / ${total} · ${p.fps} fps`,
    geometry.width - o.margin,
    o.margin + 10,
  );
  c.textAlign = "left";
  if (o.footer)
    c.fillText(o.footer.slice(0, 80), o.margin, geometry.height - o.margin / 2);
  const lineHeight = o.font * 1.45;
  page.forEach((entry, i) => {
    const y = geometry.top + i * geometry.rowH;
    c.strokeStyle = "#999";
    c.strokeRect(o.margin, y, geometry.inner, geometry.rowH);
    for (const column of geometry.columns) {
      if (column.x > o.margin) {
        c.beginPath();
        c.moveTo(column.x, y);
        c.lineTo(column.x, y + geometry.rowH);
        c.stroke();
      }
      c.save();
      c.beginPath();
      c.rect(column.x + 1, y + 1, column.width - 2, geometry.rowH - 2);
      c.clip();
      if (column.key === "image") {
        if (!entry.continuation) {
          const iw = Math.min(
            column.width - 16,
            ((geometry.rowH - 24) * 16) / 9,
          );
          const ih = (iw * 9) / 16;
          const ix = column.x + (column.width - iw) / 2,
            iy = y + (geometry.rowH - ih) / 2;
          c.save();
          c.beginPath();
          c.rect(ix, iy, iw, ih);
          c.clip();
          c.translate(ix, iy);
          draw(c, entry.row.panel, iw, ih, null, images);
          if (o.cameraMarks) cameraNotation(c, entry.row.panel, 0, 0, iw, ih);
          c.restore();
          c.strokeStyle = "#bbb";
          c.strokeRect(ix, iy, iw, ih);
        }
      } else {
        c.font = font(o.font);
        c.fillStyle = "#111";
        let ty = y + o.font + 8;
        // CUT列が無いときだけ、先頭の列に続きの印を置く。
        if (
          entry.continuation &&
          !entry.cells.has("cut") &&
          column === geometry.columns.find((v) => v.key !== "image")
        ) {
          c.fillStyle = "#777";
          c.fillText(`${entry.label}（続き）`, column.x + 8, ty);
          c.fillStyle = "#111";
          ty += lineHeight;
        }
        for (const line of entry.cells.get(column.key) ?? []) {
          c.fillText(line, column.x + 8, ty);
          ty += lineHeight;
        }
      }
      c.restore();
    }
  });
  return target;
}
export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
