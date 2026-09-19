import { flatten, validate } from "./model.js";

function cloneProject(project) {
  if (typeof globalThis.structuredClone === "function")
    return globalThis.structuredClone(project);
  return JSON.parse(JSON.stringify(project));
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

export function createExportSnapshot(
  project,
  { sessionId = null, revision = null } = {},
) {
  const copy = cloneProject(project);
  validate(copy);
  const rows = flatten(copy).map((row) =>
    Object.freeze({
      panel: row.panel,
      scene: row.scene,
      shot: row.shot,
      si: row.si,
      hi: row.hi,
      pi: row.pi,
      start: row.start,
      end: row.end,
    }),
  );
  freezeDeep(copy);
  return Object.freeze({
    project: copy,
    rows: Object.freeze(rows),
    endFrame: rows.at(-1)?.end ?? 0,
    assetIds: Object.freeze(copy.assets.map((asset) => asset.id)),
    sessionId,
    revision,
  });
}

export function snapshotAssetIds(snapshot) {
  if (!snapshot?.project?.assets) throw Error("ExportSnapshotが不正です");
  return new Set(snapshot.project.assets.map((asset) => asset.id));
}
