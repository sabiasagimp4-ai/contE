import { flatten, describeCamera } from "./model.js";
import { resolveClips, soundNotes, soundText } from "./audio.js";
import { draw } from "./drawing.js";
export const defaults = {
  rows: 4,
  margin: 45,
  font: 18,
  imageWidth: 42,
  header: "",
  cut: true,
  image: true,
  duration: true,
  dialogue: true,
  sound: true,
  notes: true,
  camera: true,
  numbers: true,
};
export function paginate(p, o) {
  const rows = Math.max(1, Math.min(8, Math.round(o.rows)));
  const all = flatten(p);
  return Array.from({ length: Math.ceil(all.length / rows) }, (_, i) =>
    all.slice(i * rows, (i + 1) * rows),
  );
}
function wrap(c, text, x, y, w, line, maxY) {
  let row = "";
  for (const ch of text) {
    if (ch === "\n" || c.measureText(row + ch).width > w) {
      if (y + line > maxY) {
        c.fillText(row.slice(0, -1) + "…", x, y);
        return true;
      }
      c.fillText(row, x, y);
      y += line;
      row = ch === "\n" ? "" : ch;
    } else row += ch;
  }
  if (row) c.fillText(row, x, y);
  return false;
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
  // 中間キーも通る折れ線で軌道を示し、終端に矢印を付ける。
  c.beginPath();
  keys.forEach((k, i) => {
    const [cx, cy] = center(k);
    i ? c.lineTo(cx, cy) : c.moveTo(cx, cy);
  });
  c.stroke();
  const [px, py] = center(keys.at(-2) ?? keys[0]),
    [ex, ey] = center(keys.at(-1));
  if (px !== ex || py !== ey) {
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
export function renderPage(p, rows, o, page, total, images) {
  // 全Panelの並びと音の解決は1ページにつき1度だけ行う。行ごとに数え直さない。
  const all = flatten(p);
  const clips = resolveClips(p, all);
  const index = new Map(all.map((r, i) => [r.panel.id, i]));
  const canvas = document.createElement("canvas");
  canvas.width = 1240;
  canvas.height = 1754;
  const c = canvas.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, 1240, 1754);
  c.fillStyle = "#111";
  c.font = 'bold 28px "Noto Sans JP", sans-serif';
  c.fillText((o.header || p.title).slice(0, 60), o.margin, 55);
  c.font = '16px "Noto Sans JP", sans-serif';
  c.fillText(`${page + 1} / ${total} · ${p.fps} fps`, 1050, 55);
  const width = 1240 - o.margin * 2,
    rowH = (1650 - o.margin) / o.rows;
  let overflow = 0;
  rows.forEach((r, i) => {
    const y = 90 + i * rowH;
    c.strokeStyle = "#999";
    c.strokeRect(o.margin, y, width, rowH);
    c.save();
    c.beginPath();
    c.rect(o.margin + 1, y + 1, width - 2, rowH - 2);
    c.clip();
    const ix = o.margin + 12,
      iy = y + 45,
      iw = o.image
        ? Math.min((width * o.imageWidth) / 100, ((rowH - 65) * 16) / 9)
        : 0,
      ih = (iw * 9) / 16;
    c.font = `${o.font}px "Noto Sans JP", sans-serif`;
    c.fillStyle = "#111";
    let heading = [];
    if (o.cut) heading.push(`CUT ${(index.get(r.panel.id) ?? 0) + 1}`);
    if (o.numbers) heading.push(`S${r.si + 1} / SH${r.hi + 1} / P${r.pi + 1}`);
    if (o.duration)
      heading.push(
        `${r.panel.frames}f / ${(r.panel.frames / p.fps).toFixed(2)}s`,
      );
    c.fillText(heading.join("    "), ix, y + 28);
    if (o.image) {
      c.save();
      c.beginPath();
      c.rect(ix, iy, iw, ih);
      c.clip();
      c.translate(ix, iy);
      draw(c, r.panel, iw, ih, null, images);
      if (o.camera) cameraNotation(c, r.panel, 0, 0, iw, ih);
      c.restore();
    }
    const tx = o.image ? ix + iw + 20 : ix;
    const blocks = [];
    if (o.dialogue && r.panel.dialogue)
      blocks.push(`台詞: ${r.panel.dialogue}`);
    if (o.sound) {
      // 音注記は、明示的な注記欄と、時間が重なる音声クリップの両方から作る。
      const placed = soundText(
        soundNotes(p, all, r, clips).filter((n) => n.track !== "dialogue"),
      );
      const note = [r.panel.sound, placed].filter(Boolean).join(" / ");
      if (note) blocks.push(`SE / BGM: ${note}`);
    }
    if (o.notes && r.panel.notes) blocks.push(`演出: ${r.panel.notes}`);
    if (o.camera) {
      const { keys, moves, hold } = describeCamera(r.panel);
      blocks.push(
        hold
          ? "Camera: HOLD"
          : `Camera: ${moves.join(" / ")}（${keys
              .map((k) => `${Math.round(k.t * r.panel.frames)}f`)
              .join(" → ")}）`,
      );
    }
    if (
      wrap(
        c,
        blocks.join("\n"),
        tx,
        iy + o.font,
        width - (tx - o.margin) - 12,
        o.font * 1.5,
        y + rowH - 15,
      )
    )
      overflow++;
    c.restore();
  });
  return { canvas, overflow };
}
export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
