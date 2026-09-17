import { test } from "node:test";
import assert from "node:assert/strict";
import { project, scene, shot, panel } from "../src/model.js";
import { searchPanels } from "../src/derived/search.js";

test("finds matches across dialogue/sound/notes/scene/shot names", () => {
  const p = project();
  p.scenes[0].name = "オープニング";
  p.scenes[0].shots[0].name = "挨拶";
  p.scenes[0].shots[0].panels = [panel(), panel()];
  const [a, b] = p.scenes[0].shots[0].panels;
  a.dialogue = "おはよう、世界";
  b.notes = "夕方のシーンへ切り替え";

  const hits = searchPanels(p, "世界");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].panelId, a.id);
  assert.equal(hits[0].field, "dialogue");
  assert.equal(hits[0].index, 5);

  const sceneHits = searchPanels(p, "オープニング");
  assert.equal(sceneHits.length, 1);
  assert.equal(sceneHits[0].field, "sceneName");
  assert.equal(sceneHits[0].panelId, a.id, "Sceneの一致は先頭Panelへジャンプする");

  const shotHits = searchPanels(p, "挨拶");
  assert.equal(shotHits[0].field, "shotName");
});

test("normalizes full-width/half-width and case before matching", () => {
  const p = project();
  p.scenes[0].shots[0].panels[0].dialogue = "ＡＢＣ　Hello";

  assert.equal(searchPanels(p, "abc").length, 1, "全角ABCが半角abcで見つかる");
  assert.equal(searchPanels(p, "ＡＢＣ").length, 1, "全角同士でも見つかる");
  assert.equal(searchPanels(p, "HELLO").length, 1, "大文字小文字を無視する");
});

test("returns multiple hits within the same field in left-to-right order", () => {
  const p = project();
  p.scenes[0].shots[0].panels[0].dialogue = "猫、犬、猫、鳥、猫";

  const hits = searchPanels(p, "猫");
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.index), [0, 4, 8]);
});

test("hits are ordered scene -> shot -> panel, matching project order", () => {
  const p = project();
  p.scenes[0].shots[0].panels[0].dialogue = "検索語";
  p.scenes.push(scene("シーン02", [shot([panel()])]));
  p.scenes[1].shots[0].panels[0].dialogue = "検索語";

  const hits = searchPanels(p, "検索語");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].panelId, p.scenes[0].shots[0].panels[0].id);
  assert.equal(hits[1].panelId, p.scenes[1].shots[0].panels[0].id);
});

test("an empty query matches nothing, and fields can be restricted", () => {
  const p = project();
  p.scenes[0].shots[0].panels[0].dialogue = "何か";
  p.scenes[0].shots[0].panels[0].notes = "何か";

  assert.deepEqual(searchPanels(p, ""), []);
  const onlyNotes = searchPanels(p, "何か", { fields: ["notes"] });
  assert.equal(onlyNotes.length, 1);
  assert.equal(onlyNotes[0].field, "notes");
});
