import { flatten, uid } from "./model.js";
// マーカーは音声Clipと同じ「anchor（PanelのID）+at（相対フレーム）」で位置を持つ。
// 尺を変えてもそのPanelに付いて動き、Panelを消せば一緒に消える（C1）。
// 音声Clipと違い長さ（frames）を持たない、一点だけの注記。
export function resolveMarkers(p, rows = flatten(p)) {
  const starts = new Map(rows.map((r) => [r.panel.id, r.start]));
  return p.markers
    .map((marker) => {
      const base = starts.get(marker.anchor);
      if (base === undefined) return null;
      return { marker, start: base + marker.at };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.marker.id.localeCompare(b.marker.id));
}
export const markersInRange = (resolved, from, to) =>
  resolved.filter((r) => r.start >= from && r.start < to);
export function addMarker(p, { id = uid(), anchor, at, text = "", color }) {
  const marker = { id, anchor, at: Math.round(at), text, color };
  p.markers.push(marker);
  return marker;
}
// 移動先のPanelを基準に付け替える。どのPanelに属するかは絶対位置で決まる（placeClipと同じ）。
export function moveMarker(p, rows, id, startFrame) {
  const marker = p.markers.find((m) => m.id === id);
  if (!marker) return false;
  const start = Math.max(0, Math.round(startFrame));
  const host = rows.find((r) => start >= r.start && start < r.end) ?? rows.at(-1);
  const next = { anchor: host.panel.id, at: start - host.start };
  if (marker.anchor === next.anchor && marker.at === next.at) return false;
  Object.assign(marker, next);
  return true;
}
export function removeMarkers(p, ids) {
  const drop = new Set(ids);
  const before = p.markers.length;
  p.markers = p.markers.filter((m) => !drop.has(m.id));
  return p.markers.length !== before;
}
// idMapはPanel複製が作った旧ID→新IDの対応表。旧Panelに付いていたマーカーだけを
// 新しいAnchorへ複製する（音声のduplicateClipsForと同じ規則）。
export function duplicateMarkersFor(p, idMap) {
  const added = [];
  for (const marker of [...p.markers]) {
    const anchor = idMap.get(marker.anchor);
    if (!anchor) continue;
    const copy = { ...marker, id: uid(), anchor };
    p.markers.push(copy);
    added.push(copy);
  }
  return added;
}
// Panelが消えたときは、そのPanelに付いたマーカーも一緒に消す。孤児を残さない。
export function pruneMarkers(p) {
  const panels = new Set(flatten(p).map((r) => r.panel.id));
  const before = p.markers.length;
  p.markers = p.markers.filter((m) => panels.has(m.anchor));
  return p.markers.length !== before;
}
// 紙コンテの注記：Panelの区間に立つマーカーを1行ずつ文字列にする。
export function markerNotes(p, rows, row, resolved = resolveMarkers(p, rows)) {
  return markersInRange(resolved, row.start, row.end).map((r) => r.marker);
}
export const markerText = (markers) =>
  markers.map((m) => `▶ ${m.text}`).join("\n");
