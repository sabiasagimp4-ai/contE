// 尺の集計。Store・DOMを知らない純粋関数だけを置く（B1）。
// rowsはmodel.jsのflatten(p)の戻り値をそのまま渡す想定。

// Project全体の尺。
export function summary(p, rows) {
  const frames = rows.reduce((sum, r) => sum + r.panel.frames, 0);
  return {
    frames,
    seconds: frames / p.fps,
    panels: rows.length,
    shots: new Set(rows.map((r) => r.shot.id)).size,
    scenes: p.scenes.length,
  };
}

// Shotごとの内訳。Project全体の並び順のまま返す。
export function byShot(p, rows) {
  const order = [];
  const byId = new Map();
  for (const r of rows) {
    let entry = byId.get(r.shot.id);
    if (!entry) {
      entry = { sceneId: r.scene.id, shotId: r.shot.id, frames: 0, panels: 0 };
      byId.set(r.shot.id, entry);
      order.push(entry);
    }
    entry.frames += r.panel.frames;
    entry.panels += 1;
  }
  return order.map((entry) => ({ ...entry, seconds: entry.frames / p.fps }));
}

// 選んだPanelだけの尺の合計。並びや連続性は問わない。
export function selectionTotal(rows, ids) {
  const chosen = new Set(ids);
  return rows.reduce(
    (sum, r) => (chosen.has(r.panel.id) ? sum + r.panel.frames : sum),
    0,
  );
}

// 目標尺（秒）との差。+なら超過、-なら不足。
export function gapTo(target, frames, fps) {
  const diffFrames = Math.round(frames - target * fps);
  return { frames: diffFrames, seconds: diffFrames / fps };
}
