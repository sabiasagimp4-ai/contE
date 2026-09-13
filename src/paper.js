import { flatten } from "./model.js";
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
export function cameraNotation(c, b, x, y, w, h) {
  const a = b.camera[0],
    z = b.camera.at(-1);
  c.save();
  c.strokeStyle = "#bb3f27";
  c.fillStyle = "#bb3f27";
  c.lineWidth = 2;
  const frame = (k) => {
    c.save();
    c.translate(x + w / 2 + k.x * w, y + h / 2 + k.y * h);
    c.rotate((k.rotation * Math.PI) / 180);
    c.strokeRect(-w / (2 * k.zoom), -h / (2 * k.zoom), w / k.zoom, h / k.zoom);
    c.restore();
  };
  if (
    b.camera.length === 1 ||
    ["x", "y", "zoom", "rotation"].every((k) => a[k] === z[k])
  ) {
    c.fillText("HOLD", x + 8, y + 22);
  } else {
    frame(a);
    c.setLineDash([6, 4]);
    frame(z);
    c.setLineDash([]);
    const sx = x + w / 2 + a.x * w,
      sy = y + h / 2 + a.y * h,
      ex = x + w / 2 + z.x * w,
      ey = y + h / 2 + z.y * h;
    const angle = Math.atan2(ey - sy, ex - sx);
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(ex, ey);
    c.lineTo(ex - 12 * Math.cos(angle - 0.5), ey - 12 * Math.sin(angle - 0.5));
    c.moveTo(ex, ey);
    c.lineTo(ex - 12 * Math.cos(angle + 0.5), ey - 12 * Math.sin(angle + 0.5));
    c.stroke();
    c.fillText("START → END", x + 8, y + 22);
  }
  c.restore();
}
export function renderPage(p, rows, o, page, total, images) {
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
    if (o.cut)
      heading.push(
        `CUT ${flatten(p).findIndex((v) => v.panel.id === r.panel.id) + 1}`,
      );
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
    for (const [key, title] of [
      ["dialogue", "台詞"],
      ["sound", "SE / BGM"],
      ["notes", "演出"],
    ])
      if (o[key]) blocks.push(`${title}: ${r.panel[key]}`);
    if (o.camera) {
      const k = r.panel.camera.at(-1);
      blocks.push(
        r.panel.camera.length === 1
          ? "Camera: HOLD"
          : `Camera: X ${k.x} / Y ${k.y} / Zoom ${k.zoom} / Rot ${k.rotation}°`,
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
