export function draw(ctx, b, w, h, camera) {
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  if (camera) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((camera.rotation * Math.PI) / 180);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-w / 2 - camera.x * w, -h / 2 - camera.y * h);
  }
  ctx.strokeStyle = "#252932";
  ctx.lineWidth = w / 500;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of b.strokes) {
    ctx.beginPath();
    s.forEach(([x, y], i) =>
      i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h),
    );
    if (s.length === 1) ctx.lineTo(s[0][0] * w + 0.1, s[0][1] * h);
    ctx.stroke();
  }
  ctx.restore();
}
