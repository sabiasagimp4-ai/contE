// UI操作を「Storeの一回の編集」として表すコマンド集。
// - 内部でawaitしない。非同期の準備はControllerが終えてから呼ぶ。
// - DOMもIndexedDBも触らない。必要な値は引数で受け取る。
// - 戻り値は選択（またはundefined）。Store.edit と同じ規約で確定する。
// UIとテストが同じ経路を実行できるよう、編集の計算はここだけに置く。
import {
  flatten,
  panel,
  scene,
  sceneName,
  split,
  merge,
  movePanels,
  setCameraKey,
  moveCameraKey,
  removeCameraKey,
  clearPanelImage,
  uid,
} from "../model.js";
import * as audio from "../audio.js";

const rowOf = (p, id) => flatten(p).find((r) => r.panel.id === id);
const panelOf = (p, id) => rowOf(p, id)?.panel;
const only = (id) => ({ active: id, ids: [id] });
const clampFrames = (value) =>
  Math.max(1, Math.min(864000, Math.round(Number(value) || 1)));

// kindsは§18.6の更新範囲表に対応する。panelIds/assetIdsは分かる範囲で添える。
const define = (kinds, run, targets = () => ({})) => ({ kinds, run, targets });

export const commands = {
  // --- 構成 ---------------------------------------------------------------
  addPanel: define(["structure", "timing"], ({ activeId }) => (p) => {
    const r = rowOf(p, activeId);
    if (!r) return;
    const added = panel();
    r.shot.panels.splice(r.pi + 1, 0, added);
    return only(added.id);
  }),
  duplicatePanels: define(["structure", "timing"], ({ ids }) => (p) => {
    const targets = new Set(ids);
    for (const h of p.scenes.flatMap((s) => s.shots))
      h.panels = h.panels.flatMap((b) =>
        targets.has(b.id) ? [b, { ...structuredClone(b), id: uid() }] : [b],
      );
  }),
  deletePanels: define(
    ["structure", "timing", "audio"],
    ({ ids }) =>
      (p) => {
        const targets = new Set(ids);
        if (targets.size === flatten(p).length)
          throw Error("最低1つのPanelを残してください");
        for (const s of p.scenes) {
          for (const h of s.shots)
            h.panels = h.panels.filter((b) => !targets.has(b.id));
          s.shots = s.shots.filter((h) => h.panels.length);
        }
        p.scenes = p.scenes.filter((s) => s.shots.length);
        // 消えたPanelに付いていた音も一緒に消す。孤児のクリップを残さない。
        audio.pruneClips(p);
        audio.pruneAudioAssets(p);
      },
    ({ ids }) => ({ panelIds: ids }),
  ),
  splitShot: define(["structure"], ({ activeId }) => (p) => split(p, activeId)),
  mergeShot: define(["structure"], ({ activeId }) => (p) => merge(p, activeId)),
  addScene: define(["structure", "timing"], () => (p) => {
    const added = scene(sceneName(p.scenes.length + 1));
    p.scenes.push(added);
    return only(added.shots[0].panels[0].id);
  }),
  nudgePanel: define(["structure", "timing"], ({ activeId, delta }) => (p) => {
    const r = rowOf(p, activeId);
    if (!r) return;
    const to = r.pi + delta;
    if (to < 0 || to >= r.shot.panels.length) return;
    const [b] = r.shot.panels.splice(r.pi, 1);
    r.shot.panels.splice(to, 0, b);
  }),
  reorderPanels: define(
    ["structure", "timing"],
    ({ ids, anchorId, place }) =>
      (p) =>
        movePanels(p, ids, anchorId, place),
    ({ ids }) => ({ panelIds: ids }),
  ),

  // --- テキストと尺 -------------------------------------------------------
  setPanelField: define(
    ["text"],
    ({ ids, field, value }) =>
      (p) => {
        const targets = new Set(ids);
        for (const r of flatten(p))
          if (targets.has(r.panel.id)) r.panel[field] = value;
      },
    ({ ids, field }) => ({
      panelIds: ids,
      kinds: field === "frames" ? ["timing"] : ["text"],
    }),
  ),
  setPanelFrames: define(
    ["timing"],
    ({ ids, frames }) =>
      (p) => {
        const targets = new Set(ids);
        const next = clampFrames(frames);
        for (const r of flatten(p))
          if (targets.has(r.panel.id)) r.panel.frames = next;
      },
    ({ ids }) => ({ panelIds: ids }),
  ),
  nudgePanelFrames: define(
    ["timing"],
    ({ ids, delta }) =>
      (p) => {
        const targets = new Set(ids);
        for (const r of flatten(p))
          if (targets.has(r.panel.id))
            r.panel.frames = clampFrames(r.panel.frames + delta);
      },
    ({ ids }) => ({ panelIds: ids }),
  ),
  setTitle: define(["projectMeta"], ({ title }) => (p) => (p.title = title)),
  renameScene: define(["projectMeta"], ({ sceneId, name }) => (p) => {
    const target = p.scenes.find((s) => s.id === sceneId);
    if (target) target.name = name;
  }),
  renameShot: define(["projectMeta"], ({ shotId, name }) => (p) => {
    for (const s of p.scenes)
      for (const h of s.shots) if (h.id === shotId) h.name = name;
  }),

  // --- Camera -------------------------------------------------------------
  putCameraKey: define(
    ["camera"],
    ({ panelId, t, values }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (!b) return;
        setCameraKey(b, t, values);
        return only(panelId);
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),
  moveCameraKey: define(
    ["camera"],
    ({ panelId, index, t }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (b) moveCameraKey(b, index, t);
        return only(panelId);
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),
  deleteCameraKey: define(
    ["camera"],
    ({ panelId, index }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (b) removeCameraKey(b, index);
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),
  setCameraValues: define(
    ["camera"],
    ({ panelId, index, values }) =>
      (p) => {
        const key = panelOf(p, panelId)?.camera[index];
        if (key) Object.assign(key, values);
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),

  // --- 描画 ---------------------------------------------------------------
  addStroke: define(
    ["visual"],
    ({ panelId, stroke }) =>
      (p) => {
        const b = panelOf(p, panelId);
        // 確定済みStrokeは履歴間で共有する不変配列。差し替えて追加する。
        if (b) b.strokes = [...b.strokes, stroke];
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),

  // --- 画像 ---------------------------------------------------------------
  setPanelImage: define(
    ["visual", "assets"],
    ({ panelId, asset, opacity }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (!b) return;
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
        b.image = { assetId: asset.id, opacity };
      },
    ({ panelId, asset }) => ({ panelIds: [panelId], assetIds: [asset.id] }),
  ),
  clearPanelImage: define(
    ["visual", "assets"],
    ({ panelId }) =>
      (p) =>
        clearPanelImage(p, panelId),
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),
  setImageOpacity: define(
    ["visual"],
    ({ panelId, opacity }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (b?.image) b.image.opacity = opacity;
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),

  // --- 音声 ---------------------------------------------------------------
  addAudioClip: define(
    ["audio", "assets"],
    ({ clipId, asset, track, anchor, at, frames }) =>
      (p) => {
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
        audio.addClip(p, {
          id: clipId,
          assetId: asset.id,
          track,
          anchor,
          at,
          frames,
        });
        return only(anchor);
      },
    ({ asset, anchor }) => ({ panelIds: [anchor], assetIds: [asset.id] }),
  ),
  setClipField: define(["audio"], ({ clipId, field, value }) => (p) => {
    const clip = p.audio.find((c) => c.id === clipId);
    if (clip) clip[field] = value;
  }),
  placeClip: define(["audio"], ({ clipId, startFrame }) => (p) => {
    audio.placeClip(p, flatten(p), clipId, startFrame);
  }),
  trimClip: define(["audio"], ({ clipId, frames }) => (p) => {
    audio.trimClip(p, clipId, frames);
  }),
  deleteClip: define(["audio", "assets"], ({ clipId }) => (p) => {
    audio.removeClips(p, [clipId]);
    audio.pruneAudioAssets(p);
  }),
  // 素材の差し替えは原本を上書きせず、新しいAsset IDへ付け替える（R07）。
  replaceClipAsset: define(
    ["audio", "assets"],
    ({ clipId, asset }) =>
      (p) => {
        const clip = p.audio.find((c) => c.id === clipId);
        if (!clip) return;
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
        clip.assetId = asset.id;
        audio.pruneAudioAssets(p);
      },
    ({ asset }) => ({ assetIds: [asset.id] }),
  ),

  // --- 紙面 ---------------------------------------------------------------
  updatePaper: define(["paper"], ({ change }) => (p) => change(p.paper)),
};

export function commandOf(name) {
  const spec = commands[name];
  if (!spec) throw Error(`不明なコマンド: ${name}`);
  return spec;
}
// 変更範囲は宣言したkindsと、引数から分かる対象IDで作る。
export function changeSetOf(name, args = {}) {
  const spec = commandOf(name);
  const extra = spec.targets(args) ?? {};
  return {
    kinds: extra.kinds ?? spec.kinds,
    panelIds: extra.panelIds ?? [],
    assetIds: extra.assetIds ?? [],
  };
}
