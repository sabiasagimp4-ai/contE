// 台詞・注記・Scene名・Shot名の検索。Store・DOMを知らない純粋関数だけを置く（B2）。
// 全角/半角・大文字小文字は同じ表記として扱う（NFKCで正規化してから比較する）。
const norm = (s) => s.normalize("NFKC").toLowerCase();

function allIndexesOf(haystack, needle) {
  const indexes = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return indexes;
    indexes.push(at);
    from = at + needle.length;
  }
}

const PANEL_FIELDS = ["dialogue", "sound", "notes"];
const DEFAULT_FIELDS = [...PANEL_FIELDS, "sceneName", "shotName"];

// 一致はScene→Shot→Panelの順、同じ文字列の中では出現順に並ぶ。
// jumpTo先が要るので、Scene名/Shot名の一致もその中の最初のPanelを添える。
export function searchPanels(p, query, { fields = DEFAULT_FIELDS } = {}) {
  const q = norm(query);
  if (!q) return [];
  const hits = [];
  for (const s of p.scenes) {
    const firstOfScene = s.shots[0].panels[0];
    if (fields.includes("sceneName"))
      for (const index of allIndexesOf(norm(s.name), q))
        hits.push({
          panelId: firstOfScene.id,
          sceneId: s.id,
          shotId: s.shots[0].id,
          field: "sceneName",
          text: s.name,
          index,
        });
    for (const h of s.shots) {
      const firstOfShot = h.panels[0];
      if (fields.includes("shotName"))
        for (const index of allIndexesOf(norm(h.name), q))
          hits.push({
            panelId: firstOfShot.id,
            sceneId: s.id,
            shotId: h.id,
            field: "shotName",
            text: h.name,
            index,
          });
      for (const b of h.panels)
        for (const field of PANEL_FIELDS) {
          if (!fields.includes(field)) continue;
          for (const index of allIndexesOf(norm(b[field]), q))
            hits.push({
              panelId: b.id,
              sceneId: s.id,
              shotId: h.id,
              field,
              text: b[field],
              index,
            });
        }
    }
  }
  return hits;
}
