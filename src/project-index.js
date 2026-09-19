import { flatten } from "./model.js";

function group(map, key, row) {
  const rows = map.get(key);
  if (rows) rows.push(row);
  else map.set(key, [row]);
}

export function buildProjectIndex(project) {
  const rows = flatten(project);
  const panelById = new Map();
  const rowsByShotId = new Map();
  const rowsBySceneId = new Map();

  for (const row of rows) {
    if (panelById.has(row.panel.id))
      throw Error("重複したPanel IDを索引化できません");
    panelById.set(row.panel.id, row);
    group(rowsByShotId, row.shot.id, row);
    group(rowsBySceneId, row.scene.id, row);
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    panelById,
    rowsByShotId,
    rowsBySceneId,
    panelIds: Object.freeze(rows.map((row) => row.panel.id)),
    totalFrames: rows.at(-1)?.end ?? 0,
  });
}

export function rowOf(index, panelId) {
  return index?.panelById.get(panelId) ?? null;
}
