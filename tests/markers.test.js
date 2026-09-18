import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMarkers,
  markersInRange,
  addMarker,
  moveMarker,
  removeMarkers,
  duplicateMarkersFor,
  pruneMarkers,
  markerNotes,
  markerText,
} from "../src/markers.js";
import { project, panel, flatten, Store, validate } from "../src/model.js";

const withPanels = (panels = 3) => {
  const p = project();
  p.scenes[0].shots[0].panels = Array.from({ length: panels }, panel);
  return p;
};

test("markers resolve to absolute frames through their anchor panel", () => {
  const p = withPanels();
  const rows = flatten(p);
  addMarker(p, { anchor: rows[1].panel.id, at: 12, text: "作画注意", color: "#ff0000" });
  assert.equal(validate(p), p);
  const [resolved] = resolveMarkers(p, rows);
  assert.equal(resolved.start, 60);
  assert.equal(resolved.marker.text, "作画注意");
});

test("a marker follows its panel when earlier durations change", () => {
  const s = new Store(withPanels());
  const anchor = flatten(s.p)[1].panel.id;
  s.edit((p) => addMarker(p, { anchor, at: 0, text: "note", color: "#0000ff" }));
  assert.equal(resolveMarkers(s.p)[0].start, 48);
  s.edit((p) => (flatten(p)[0].panel.frames = 72));
  assert.equal(resolveMarkers(s.p)[0].start, 72);
  s.edit((p) => (flatten(p)[1].panel.frames = 12));
  assert.equal(resolveMarkers(s.p)[0].start, 72);
  s.undo();
  s.undo();
  assert.equal(resolveMarkers(s.p)[0].start, 48);
});

test("moving a marker re-anchors it to the panel it lands on", () => {
  const p = withPanels();
  const rows = flatten(p);
  const marker = addMarker(p, { anchor: rows[0].panel.id, at: 0, text: "x", color: "#00ff00" });
  assert.equal(moveMarker(p, rows, marker.id, 100), true);
  assert.equal(marker.anchor, rows[2].panel.id);
  assert.equal(marker.at, 4);
  assert.equal(resolveMarkers(p, rows)[0].start, 100);
  // 同じ位置へ置き直しても履歴を消費しない。
  assert.equal(moveMarker(p, rows, marker.id, 100), false);
});

test("markersInRange finds only markers landing inside [from, to)", () => {
  const p = withPanels();
  const rows = flatten(p);
  addMarker(p, { anchor: rows[0].panel.id, at: 0, text: "a", color: "#000000" });
  addMarker(p, { anchor: rows[1].panel.id, at: 0, text: "b", color: "#000000" });
  const resolved = resolveMarkers(p, rows);
  assert.equal(markersInRange(resolved, 0, 48).length, 1);
  assert.equal(markersInRange(resolved, 48, 96).length, 1);
  assert.equal(markersInRange(resolved, 96, 144).length, 0);
});

test("removeMarkers drops only the requested ids", () => {
  const p = withPanels();
  const rows = flatten(p);
  const a = addMarker(p, { anchor: rows[0].panel.id, at: 0, text: "a", color: "#000000" });
  const b = addMarker(p, { anchor: rows[0].panel.id, at: 1, text: "b", color: "#000000" });
  assert.equal(removeMarkers(p, [a.id]), true);
  assert.deepEqual(p.markers.map((m) => m.id), [b.id]);
  assert.equal(removeMarkers(p, [a.id]), false, "既に無いidでは変化しない");
});

test("duplicateMarkersFor copies only markers anchored to duplicated panels", () => {
  const p = withPanels();
  const rows = flatten(p);
  addMarker(p, { anchor: rows[0].panel.id, at: 0, text: "kept", color: "#000000" });
  addMarker(p, { anchor: rows[1].panel.id, at: 0, text: "also", color: "#000000" });
  const idMap = new Map([[rows[0].panel.id, "new-panel"]]);
  const added = duplicateMarkersFor(p, idMap);
  assert.equal(added.length, 1);
  assert.equal(added[0].anchor, "new-panel");
  assert.notEqual(added[0].id, p.markers[0].id);
  assert.equal(p.markers.length, 3);
});

test("pruneMarkers removes markers whose anchor panel no longer exists", () => {
  const p = withPanels();
  const rows = flatten(p);
  addMarker(p, { anchor: rows[0].panel.id, at: 0, text: "gone", color: "#000000" });
  p.scenes[0].shots[0].panels = p.scenes[0].shots[0].panels.slice(1);
  assert.equal(pruneMarkers(p), true);
  assert.deepEqual(p.markers, []);
  assert.equal(pruneMarkers(p), false);
});

test("markerNotes and markerText build the paper annotation for a row", () => {
  const p = withPanels();
  const rows = flatten(p);
  addMarker(p, { anchor: rows[0].panel.id, at: 0, text: "作画注意", color: "#000000" });
  const notes = markerNotes(p, rows, rows[0]);
  assert.equal(notes.length, 1);
  assert.equal(markerText(notes), "▶ 作画注意");
  assert.equal(markerNotes(p, rows, rows[1]).length, 0);
});

// マーカーの色はInspectorの<input type="color">が出す#rrggbbだけを受ける。
// 3桁短縮や色名を通すと、開き直したときに色欄が黙って黒へ倒れる。
test("validate accepts only 6-digit hex marker colors", () => {
  const p = withPanels(1);
  const anchor = flatten(p)[0].panel.id;
  addMarker(p, { anchor, at: 0, text: "ok", color: "#ffcc00" });
  assert.equal(validate(p), p);
  for (const color of ["#fc0", "red", "rgb(255,0,0)", "#ffcc0", ""]) {
    p.markers[0].color = color;
    assert.throws(() => validate(p), /不正なマーカー/, `${color}が通ってしまう`);
  }
});
