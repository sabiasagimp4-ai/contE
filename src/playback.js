// Frame time comes from one monotonic clock, never an accumulating timer.
export function frameAtTime(baseFrame, startMs, nowMs, fps, endFrame) {
  return Math.min(
    endFrame,
    baseFrame + (Math.max(0, nowMs - startMs) * fps) / 1000,
  );
}
export function rowAtFrame(rows, frame) {
  let lo = 0,
    hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].end <= frame) lo = mid + 1;
    else hi = mid;
  }
  return rows[lo];
}
