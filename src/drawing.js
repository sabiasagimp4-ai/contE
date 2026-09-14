// 描画Adapter。線・消しゴム・筆圧・画像・表示変換を担当し、データ構造は解釈しない。
const ink = "#252932";
let scratch = null;
function surface(w, h) {
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch;
}
function drawImageInto(ctx, image, bitmap, w, h) {
  const scale = Math.min(w / bitmap.width, h / bitmap.height);
  const iw = bitmap.width * scale,
    ih = bitmap.height * scale;
  ctx.save();
  ctx.globalAlpha = image.opacity;
  // 縦横比を保ったままコマ枠へ収める。切り取らない。
  ctx.drawImage(bitmap, (w - iw) / 2, (h - ih) / 2, iw, ih);
  ctx.restore();
}
function drawStroke(ctx, s, w, h) {
  const pts = s.points,
    base = s.size * w;
  ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  const varying = pts.some((pt) => pt[2] !== pts[0][2]);
  if (!varying) {
    ctx.lineWidth = Math.max(0.2, base * pts[0][2]);
    ctx.beginPath();
    pts.forEach(([x, y], i) =>
      i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h),
    );
    if (pts.length === 1) ctx.lineTo(pts[0][0] * w + 0.1, pts[0][1] * h);
    ctx.stroke();
    return;
  }
  // 筆圧が変化する線は区間ごとに太さを変える。
  for (let i = 1; i < pts.length; i++) {
    ctx.lineWidth = Math.max(0.2, (base * (pts[i - 1][2] + pts[i][2])) / 2);
    ctx.beginPath();
    ctx.moveTo(pts[i - 1][0] * w, pts[i - 1][1] * h);
    ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
    ctx.stroke();
  }
}
function paint(ctx, b, w, h, images) {
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  const bitmap = b.image && images?.get(b.image.assetId);
  if (bitmap) drawImageInto(ctx, b.image, bitmap, w, h);
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of b.strokes) drawStroke(ctx, s, w, h);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}
export function draw(ctx, b, w, h, camera, images, view) {
  ctx.save();
  if (view) {
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(-view.x * w, -view.y * h);
  }
  if (camera) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((camera.rotation * Math.PI) / 180);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-w / 2 - camera.x * w, -h / 2 - camera.y * h);
  }
  if (b.strokes.some((s) => s.erase)) {
    // 消しゴムは別面で合成する。出力先の白紙やページに穴を開けない。
    const z = Math.min(4, Math.max(1, view?.zoom ?? 1));
    const c = surface(
      Math.max(1, Math.round(w * z)),
      Math.max(1, Math.round(h * z)),
    );
    paint(c.getContext("2d"), b, c.width, c.height, images);
    // 消した部分から前のフレームが透けないよう、先に白紙を敷く。
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(c, 0, 0, w, h);
  } else paint(ctx, b, w, h, images);
  ctx.restore();
}
