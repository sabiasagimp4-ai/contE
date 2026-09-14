import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Store,
  project,
  panel,
  flatten,
  load,
  validate,
  split,
  merge,
  movePanels,
  setCameraKey,
} from "../src/model.js";
import * as audio from "../src/audio.js";
import { layoutPages } from "../src/paper.js";
import { rowAtFrame } from "../src/playback.js";

// 再現可能な乱数。ランダムテストが失敗したときseedをそのまま再実行できる。
const rng = (seed) => {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
};
const pick = (random, values) => values[Math.floor(random() * values.length)];
const measure = (text, size) => [...text].length * size * 0.6;

function assertProjectHealthy(p) {
  validate(p);
  const rows = flatten(p);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].start, 0);
  assert.ok(rows.every((row, i) => row.end > row.start && (!i || row.start === rows[i - 1].end)));
  assert.equal(rowAtFrame(rows, -1).panel.id, rows[0].panel.id);
  assert.equal(rowAtFrame(rows, rows.at(-1).end + 1).panel.id, rows.at(-1).panel.id);
  const resolved = audio.resolveClips(p, rows);
  assert.ok(resolved.every((clip) => clip.end > clip.start));
  for (const from of [0, rows[Math.floor(rows.length / 2)].start, rows.at(-1).end]) {
    const schedule = audio.scheduleFor(resolved, from, p.fps, rows.at(-1).end);
    assert.ok(schedule.every((item) => item.when >= 0 && item.duration >= 0));
  }
  const pages = layoutPages(p, p.paper, measure, rows);
  assert.ok(pages.length >= 1);
  assert.equal(pages.flat().filter((entry) => !entry.continuation).length, rows.length);
  const roundTrip = load(JSON.stringify(p));
  assert.deepEqual(roundTrip, p);
}

test("randomized edit sequences preserve model, timing, audio and export invariants", () => {
  for (let seed = 1; seed <= 24; seed++) {
    const random = rng(seed);
    const store = new Store();
    for (let step = 0; step < 90; step++) {
      const rows = flatten(store.p);
      const current = rows.find((row) => row.panel.id === store.selection.active) ?? rows[0];
      const operation = Math.floor(random() * 12);
      if (operation === 0) {
        store.edit((p) => {
          const row = flatten(p).find((item) => item.panel.id === current.panel.id);
          const next = panel();
          row.shot.panels.splice(row.pi + 1, 0, next);
          return { active: next.id, ids: [next.id] };
        });
      } else if (operation === 1 && rows.length < 80) {
        store.edit((p) => {
          const row = flatten(p).find((item) => item.panel.id === current.panel.id);
          row.panel.frames = 1 + Math.floor(random() * 240);
        });
      } else if (operation === 2) {
        store.edit((p) => {
          const row = flatten(p).find((item) => item.panel.id === current.panel.id);
          setCameraKey(row.panel, random(), {
            x: random() * 1.6 - 0.8,
            y: random() * 1.6 - 0.8,
            zoom: 0.2 + random() * 4,
            rotation: random() * 180 - 90,
          });
        });
      } else if (operation === 3) {
        store.edit((p) => {
          const row = flatten(p).find((item) => item.panel.id === current.panel.id);
          row.panel.dialogue = `seed-${seed}-${step}\n台詞`;
          row.panel.notes = "note".repeat(Math.floor(random() * 15));
        });
      } else if (operation === 4 && rows.length < 80) {
        store.edit((p) => {
          const row = flatten(p).find((item) => item.panel.id === current.panel.id);
          row.scene.shots.push({ id: crypto.randomUUID(), name: "", panels: [panel()] });
        });
      } else if (operation === 5 && current.pi > 0) {
        store.edit((p) => split(p, current.panel.id));
      } else if (operation === 6 && current.hi > 0) {
        store.edit((p) => merge(p, current.panel.id));
      } else if (operation === 7 && rows.length > 1) {
        store.edit((p) => {
          const all = flatten(p);
          const moving = pick(random, all).panel.id;
          const anchor = pick(random, all.filter((row) => row.panel.id !== moving)).panel.id;
          movePanels(p, [moving], anchor, random() < 0.5 ? "before" : "after");
        });
      } else if (operation === 8) {
        store.select({
          active: pick(random, rows).panel.id,
          ids: rows.filter(() => random() < 0.35).map((row) => row.panel.id),
        });
      } else if (operation === 9) {
        store.undo();
      } else if (operation === 10) {
        store.redo();
      } else {
        store.edit((p) => {
          p.paper.rows = 1 + Math.floor(random() * 8);
          p.paper.margin = 10 + Math.floor(random() * 80);
          p.paper.font = 8 + Math.floor(random() * 24);
        });
      }
      assertProjectHealthy(store.p);
    }
  }
});

test("audio and image asset kinds remain independent under repeated cleanup", () => {
  const p = project();
  const first = flatten(p)[0].panel;
  const second = panel();
  p.scenes[0].shots[0].panels.push(second);
  p.assets.push(
    { id: "image-a", kind: "image", name: "a", mime: "image/png", bytes: 1 },
    { id: "image-b", kind: "image", name: "b", mime: "image/png", bytes: 1 },
    { id: "audio-a", kind: "audio", name: "a", mime: "audio/wav", bytes: 1 },
  );
  first.image = { assetId: "image-a", opacity: 1 };
  second.image = { assetId: "image-b", opacity: 1 };
  audio.addClip(p, {
    assetId: "audio-a",
    track: "se",
    anchor: first.id,
    at: 0,
    frames: 12,
  });
  audio.pruneAudioAssets(p);
  assert.deepEqual(p.assets.map((asset) => asset.id).sort(), ["audio-a", "image-a", "image-b"]);
  first.image = null;
  p.assets = p.assets.filter((asset) => asset.kind !== "image" || asset.id === "image-b");
  validate(p);
  assert.deepEqual(p.assets.map((asset) => asset.id).sort(), ["audio-a", "image-b"]);
});
