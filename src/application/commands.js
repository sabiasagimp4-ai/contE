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
  pruneImageAssets,
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
  duplicatePanels: define(
    ["structure", "timing", "audio"],
    ({ ids, withAudio = false }) =>
      (p) => {
        const targets = new Set(ids);
        const idMap = new Map();
        for (const h of p.scenes.flatMap((s) => s.shots))
          h.panels = h.panels.flatMap((b) => {
            if (!targets.has(b.id)) return [b];
            const added = { ...structuredClone(b), id: uid() };
            idMap.set(b.id, added.id);
            return [b, added];
          });
        if (withAudio) audio.duplicateClipsFor(p, idMap);
      },
  ),
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
  // 貼り付けはIDを振り直して複製する。参照している素材メタデータが今のProject
  // に無ければ一緒に持ち込む（原本はAsset IDで共有されるので中身は変わらない）。
  pastePanels: define(
    ["structure", "timing", "assets", "audio"],
    ({ afterId, panels, assets = [], clips = [] }) =>
      (p) => {
        const r = rowOf(p, afterId) ?? flatten(p).at(-1);
        if (!r || !panels?.length) return;
        const known = new Set(p.assets.map((a) => a.id));
        const idMap = new Map();
        const added = panels.map((b) => {
          const copy = { ...structuredClone(b), id: uid() };
          idMap.set(b.id, copy.id);
          return copy;
        });
        for (const asset of assets)
          if (!known.has(asset.id)) {
            p.assets.push(structuredClone(asset));
            known.add(asset.id);
          }
        // 持ち込めなかった画像参照は外す。壊れた参照でProjectを止めない。
        for (const b of added)
          if (b.image && !known.has(b.image.assetId)) b.image = null;
        r.shot.panels.splice(r.pi + 1, 0, ...added);
        // 持ち込めなかった音の参照は、画像と同じ規則でクリップごと外す。
        for (const clip of clips) {
          const anchor = idMap.get(clip.anchor);
          if (!anchor || !known.has(clip.assetId)) continue;
          p.audio.push({ ...clip, id: uid(), anchor });
        }
        return { active: added[0].id, ids: added.map((b) => b.id) };
      },
    ({ afterId }) => ({ panelIds: [afterId] }),
  ),
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
  // 合計を指定して等分する（B6）。1f未満は作らないので、対象の本数に満たない
  // 合計は本数まで切り上げる。端数は全体の並び順で先頭から1fずつ配る。
  distributeFrames: define(
    ["timing"],
    ({ ids, total }) =>
      (p) => {
        const chosen = new Set(ids);
        const targets = flatten(p).filter((r) => chosen.has(r.panel.id));
        if (!targets.length) return;
        const sum = Math.max(targets.length, Math.round(total));
        const base = Math.floor(sum / targets.length);
        const extra = sum - base * targets.length;
        targets.forEach((r, i) => {
          r.panel.frames = base + (i < extra ? 1 : 0);
        });
      },
    ({ ids }) => ({ panelIds: ids }),
  ),
  // Timelineの左端ドラッグ：leftIdとrightIdの境界を動かす。2つのPanelの尺の
  // 合計は変えない。どちらも1f未満にはしない（それぞれ最低1fを残す）。
  setBoundary: define(
    ["timing"],
    ({ leftId, rightId, leftFrames }) =>
      (p) => {
        const left = panelOf(p, leftId);
        const right = panelOf(p, rightId);
        if (!left || !right) return;
        const total = left.frames + right.frames;
        const next = Math.max(1, Math.min(total - 1, Math.round(leftFrames)));
        left.frames = next;
        right.frames = total - next;
      },
    ({ leftId, rightId }) => ({ panelIds: [leftId, rightId] }),
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
  // 単体ドラッグ：絶対t位置へ動かす（他のキーと重なれば重なった側を消す）。
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
  // 複数選択ドラッグ：indexは並べ替えで変わるので、動かす前にキーの参照そのものを
  // 控えてtで追跡する（A10）。範囲の端で潰れて重ならないよう、選択全体が0〜1に
  // 収まる分だけdeltaTを詰めてから動かす。
  moveCameraKeys: define(
    ["camera"],
    ({ panelId, indexes, deltaT }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (!b) return;
        const targets = [...new Set(indexes)]
          .map((i) => b.camera[i])
          .filter(Boolean);
        if (!targets.length) return;
        const minT = Math.min(...targets.map((k) => k.t));
        const maxT = Math.max(...targets.map((k) => k.t));
        const clamped = Math.max(-minT, Math.min(1 - maxT, deltaT));
        if (!clamped) return;
        // 進む向きの先頭から動かす。逆順だと、まだ動いていない仲間の位置へ
        // 一時的に重なってしまい、moveCameraKeyの衝突処理に消される。
        const ordered = [...targets].sort((a, c) =>
          clamped > 0 ? c.t - a.t : a.t - c.t,
        );
        for (const key of ordered)
          moveCameraKey(b, b.camera.indexOf(key), key.t + clamped);
        return only(panelId);
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),
  deleteCameraKey: define(
    ["camera"],
    ({ panelId, indexes }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (!b) return;
        // 最低1本は残す。消える本数がキー総数以上なら何もしない。
        const targets = [...new Set(indexes)].sort((a, c) => c - a);
        if (b.camera.length - targets.length < 1) return;
        for (const i of targets) removeCameraKey(b, i);
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),
  setCameraValues: define(
    ["camera"],
    ({ panelId, indexes, values }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (!b) return;
        for (const i of indexes) {
          const key = b.camera[i];
          if (key) Object.assign(key, values);
        }
      },
    ({ panelId }) => ({ panelIds: [panelId] }),
  ),
  // キーはtの比率で持つので、尺が違うPanelへ貼っても動きの形は保たれる（B4）。
  // replaceは既存キーを丸ごと差し替える（0本にはしない）。mergeは同じtの
  // キーだけ上書きし、無ければ足す（setCameraKeyと同じ規則）。
  pasteCameraKeys: define(
    ["camera"],
    ({ panelId, keys, mode }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (!b || !keys?.length) return;
        if (mode === "replace")
          b.camera = keys.map((k) => ({ ease: "linear", ...k }));
        else for (const k of keys) setCameraKey(b, k.t, k);
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
  // 図形ツール用（B7）。矢印は本体+かえし2本の計3Strokeを1回の編集で足す。
  addStrokes: define(
    ["visual"],
    ({ panelId, strokes }) =>
      (p) => {
        const b = panelOf(p, panelId);
        if (!b || !strokes?.length) return;
        b.strokes = [...b.strokes, ...strokes];
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
        b.image = {
          assetId: asset.id,
          opacity,
          fit: "contain",
          offset: { x: 0, y: 0 },
          scale: 1,
        };
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
  // 音声のreplaceClipAssetと同じ形：新しいAsset IDへ参照を付け替え、使われなく
  // なった画像メタデータをclearPanelImageと同じ規則で外す（B5）。原本は
  // 上書きせず、他のPanelが同じ素材をまだ使っていればそのメタデータは残る。
  replacePanelImage: define(
    ["visual", "assets"],
    ({ panelIds, asset, opacity }) =>
      (p) => {
        const targets = panelIds.map((id) => panelOf(p, id)).filter(Boolean);
        if (!targets.length) return;
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
        // 差し替えは絵だけを入れ替える。位置・拡大・収め方は前の画像から引き継ぐ。
        for (const b of targets)
          b.image = {
            assetId: asset.id,
            opacity: opacity ?? b.image?.opacity ?? 1,
            fit: b.image?.fit ?? "contain",
            offset: b.image?.offset ?? { x: 0, y: 0 },
            scale: b.image?.scale ?? 1,
          };
        pruneImageAssets(p);
      },
    ({ panelIds, asset }) => ({ panelIds, assetIds: [asset.id] }),
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
// Command名から状態表示用の日本語名への辞書（A7）。「元に戻す：尺の変更」のように使う。
// EditorController.edit()の直接呼び出しで使う汎用のkind（"edit"等）もここへ足す。
export const commandLabels = {
  addPanel: "Panelの追加",
  duplicatePanels: "Panelの複製",
  deletePanels: "Panelの削除",
  splitShot: "Shotの分割",
  mergeShot: "Shotの結合",
  addScene: "Sceneの追加",
  pastePanels: "貼り付け",
  nudgePanel: "Panelの並べ替え",
  reorderPanels: "Panelの並べ替え",
  setPanelField: "内容の変更",
  setPanelFrames: "尺の変更",
  nudgePanelFrames: "尺の変更",
  distributeFrames: "尺の等分",
  setBoundary: "境界の移動",
  setTitle: "タイトルの変更",
  renameScene: "Scene名の変更",
  renameShot: "Shot名の変更",
  putCameraKey: "Cameraキーの追加",
  moveCameraKey: "Cameraキーの移動",
  moveCameraKeys: "Cameraキーの移動",
  deleteCameraKey: "Cameraキーの削除",
  setCameraValues: "Cameraの値の変更",
  pasteCameraKeys: "Cameraキーの貼り付け",
  addStroke: "描画",
  addStrokes: "描画",
  setPanelImage: "画像の設定",
  clearPanelImage: "画像の削除",
  replacePanelImage: "画像の差し替え",
  setImageOpacity: "画像の不透明度の変更",
  addAudioClip: "音の配置",
  setClipField: "音クリップの変更",
  placeClip: "音クリップの移動",
  trimClip: "音クリップの尺の変更",
  deleteClip: "音クリップの削除",
  replaceClipAsset: "音の差し替え",
  updatePaper: "紙面設定の変更",
};
export function labelOf(kind) {
  return commandLabels[kind] ?? "編集";
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
