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
// fit: "contain"は全体を収め、"cover"は枠を埋めて超過分を切る（C4）。
// offsetはPanel枠に対する比率（Camera/Strokeと同じ0〜1系）で、拡大縮小の
// 基準点はコマ中央のまま。scaleはfitで決めた基準サイズに掛ける倍率。
function drawImageInto(ctx, image, bitmap, w, h) {
  const { fit = "contain", offset = { x: 0, y: 0 }, scale = 1 } = image;
  const base =
    fit === "cover"
      ? Math.max(w / bitmap.width, h / bitmap.height)
      : Math.min(w / bitmap.width, h / bitmap.height);
  const s = base * scale;
  const iw = bitmap.width * s,
    ih = bitmap.height * s;
  ctx.save();
  ctx.globalAlpha = image.opacity;
  // coverや拡大でコマ枠からはみ出した分は切り取る。containの既定表示は
  // 枠にちょうど収まるので、この節はそこでは何もしない。
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.drawImage(
    bitmap,
    (w - iw) / 2 + offset.x * w,
    (h - ih) / 2 + offset.y * h,
    iw,
    ih,
  );
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
// backgroundを落とすと紙を敷かずに描く。下の絵が透ける層として重ねられる。
function paint(ctx, b, w, h, images, background = true) {
  ctx.save();
  if (background) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  const bitmap = b.image && images?.get(b.image.assetId);
  if (bitmap) drawImageInto(ctx, b.image, bitmap, w, h);
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of b.strokes) drawStroke(ctx, s, w, h);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}
/**
 * @param {object} [options]
 * @param {boolean} [options.background] 紙を敷くか。falseなら透ける層になる
 * @param {number} [options.alpha] 重ねるときの濃さ
 * @param {string} [options.tint] 単色へ置き換える色（オニオンスキンの前後の区別）
 */
export function draw(ctx, b, w, h, camera, images, view, options = {}) {
  const { background = true, alpha = 1, tint = null } = options;
  ctx.save();
  ctx.globalAlpha = alpha;
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
  if (!background) {
    // 紙を敷かない層は透明な作業面へ描いてから重ねる。消しゴムもその中で閉じる。
    const c = surface(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    paint(g, b, c.width, c.height, images, false);
    if (tint) {
      // 形はそのままに色だけ置き換える。前後どちらのコマか一目で分かる。
      g.globalCompositeOperation = "source-in";
      g.fillStyle = tint;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(c, 0, 0, w, h);
  } else if (b.strokes.some((s) => s.erase)) {
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

// Cameraの数値を編集している間、その値が実際にどこを写すかを枠で示す。
// paper.jsのcameraNotation()と同じ考え方だが、単一のCamera値だけを描く軽量版。
// 実際の画を変形させず、上から枠を重ねるだけなのでStrokeやImageを壊さない。
export function cameraFrame(ctx, camera, w, h) {
  ctx.save();
  ctx.translate(w / 2 + camera.x * w, h / 2 + camera.y * h);
  ctx.rotate((camera.rotation * Math.PI) / 180);
  ctx.strokeStyle = "#e0a06a";
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.strokeRect(
    -w / (2 * camera.zoom),
    -h / (2 * camera.zoom),
    w / camera.zoom,
    h / camera.zoom,
  );
  ctx.restore();
}
