import { createBundle } from './bundle.js';
import { createExportSnapshot } from './export-snapshot.js';

// Both directions use the same limit; legacy JSON keeps its separate guard.
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
export const MAX_JSON_BYTES = 50_000_000;
export function checkProjectSize(bytes, bundle = true) {
  if (bytes > (bundle ? MAX_BUNDLE_BYTES : MAX_JSON_BYTES))
    throw Error(bundle ? '素材込みファイルは512MiBまでです。素材を減らして再試行してください。' : '旧形式のJSONは50MBまでです。');
}
export function projectFilename(title) {
  return (title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'contE') + '.contb';
}
export async function prepareProjectDownload(project, token, repo) {
  const snapshot = createExportSnapshot(project, token);
  const release = snapshot.project.assets.map(a => repo.retainAsset(a.id));
  try {
    checkProjectSize(snapshot.project.assets.reduce((n, a) => n + a.bytes, 0));
    const assets = [];
    for (const asset of snapshot.project.assets) {
      const bytes = await repo.getAsset(asset.id);
      if (!bytes) throw Error(`素材が見つかりません：${asset.name}`);
      assets.push({id: asset.id, bytes});
    }
    const blob = await createBundle(snapshot.project, assets);
    checkProjectSize(blob.size);
    return {blob, token, name: projectFilename(snapshot.project.title)};
  } finally { release.forEach(fn => fn()); }
}
