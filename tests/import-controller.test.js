import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSession } from "../src/editor-session.js";
import { EditorController } from "../src/application/editor-controller.js";
import { ImportController } from "../src/application/import-controller.js";
import { Store, flatten, project, panel } from "../src/model.js";

const setup = () => {
  const store = new Store();
  store.edit((p) => p.scenes[0].shots[0].panels.push(panel()));
  const editor = new EditorController(new EditorSession(store));
  return {
    editor,
    imports: new ImportController(editor),
    ids: flatten(editor.project).map((r) => r.panel.id),
  };
};
// 完了の順序を試験から決めるための、手で解決できる読み込み。
const deferred = () => {
  let settle;
  const promise = new Promise((resolve) => (settle = resolve));
  return { promise, settle };
};
const imageOf = (id) => ({
  id,
  kind: "image",
  name: `${id}.png`,
  mime: "image/png",
  bytes: 16,
});

test("an import applies to the panel it started on, not the selected one", async () => {
  const { editor, imports, ids } = setup();
  const [first, second] = ids;
  const load = deferred();

  const running = imports.run({
    key: `image:${first}`,
    targetExists: () => true,
    load: () => load.promise,
    apply: (asset) =>
      editor.execute("setPanelImage", {
        panelId: first,
        asset,
        opacity: 1,
      }),
  });
  // 読み込み中に別のPanelを選び、無関係な編集もしておく。
  editor.select({ active: second, ids: [second] });
  editor.execute("setPanelField", {
    ids: [second],
    field: "dialogue",
    value: "別の作業",
  });
  load.settle(imageOf("image-1"));
  const outcome = await running;

  assert.equal(outcome.applied, true, "無関係な編集で取り込みを捨てている");
  const rows = flatten(editor.project);
  assert.equal(rows[0].panel.image.assetId, "image-1");
  assert.equal(rows[1].panel.image, null);
});

test("a later import for the same panel supersedes the earlier one", async () => {
  const { editor, imports, ids } = setup();
  const [first] = ids;
  const slow = deferred();
  const quick = deferred();
  const released = [];
  const request = (load) =>
    imports.run({
      key: `image:${first}`,
      load: () => load.promise,
      apply: (asset) =>
        editor.execute("setPanelImage", { panelId: first, asset, opacity: 1 }),
      release: (asset) => released.push(asset.id),
    });

  const firstRequest = request(slow);
  const secondRequest = request(quick);
  quick.settle(imageOf("image-new"));
  assert.equal((await secondRequest).applied, true);
  slow.settle(imageOf("image-old"));
  const stale = await firstRequest;

  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "superseded");
  assert.deepEqual(released, ["image-old"], "使わない結果を解放していない");
  assert.equal(flatten(editor.project)[0].panel.image.assetId, "image-new");
});

test("imports for different panels do not cancel each other", async () => {
  const { editor, imports, ids } = setup();
  const [first, second] = ids;
  const a = deferred();
  const b = deferred();
  const request = (panelId, load) =>
    imports.run({
      key: `image:${panelId}`,
      load: () => load.promise,
      apply: (asset) =>
        editor.execute("setPanelImage", { panelId, asset, opacity: 1 }),
    });

  const one = request(first, a);
  const two = request(second, b);
  b.settle(imageOf("image-b"));
  a.settle(imageOf("image-a"));
  assert.equal((await one).applied, true);
  assert.equal((await two).applied, true);

  const rows = flatten(editor.project);
  assert.equal(rows[0].panel.image.assetId, "image-a");
  assert.equal(rows[1].panel.image.assetId, "image-b");
});

test("an import finishing after a project switch is dropped and released", async () => {
  const { editor, imports, ids } = setup();
  const [first] = ids;
  const load = deferred();
  const released = [];

  const running = imports.run({
    key: `image:${first}`,
    load: () => load.promise,
    apply: () => {
      throw Error("古いSessionの結果を適用してはいけない");
    },
    release: (asset) => released.push(asset.id),
  });
  editor.replace(project());
  load.settle(imageOf("image-1"));
  const outcome = await running;

  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "session");
  assert.deepEqual(released, ["image-1"]);
  assert.equal(flatten(editor.project)[0].panel.image, null);
});

test("an import whose target was deleted is dropped and released", async () => {
  const { editor, imports, ids } = setup();
  const [first, second] = ids;
  const load = deferred();
  const released = [];

  const running = imports.run({
    key: `image:${second}`,
    targetExists: () =>
      flatten(editor.project).some((r) => r.panel.id === second),
    load: () => load.promise,
    apply: () => {
      throw Error("消えた対象へ適用してはいけない");
    },
    release: (asset) => released.push(asset.id),
  });
  editor.execute("deletePanels", { ids: [second] });
  load.settle(imageOf("image-1"));
  const outcome = await running;

  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "missing");
  assert.deepEqual(released, ["image-1"]);
  assert.equal(flatten(editor.project).length, 1);
  assert.equal(editor.activeId, first);
});

test("a failed load reports the error and frees the request slot", async () => {
  const { editor, imports, ids } = setup();
  const [first] = ids;

  await assert.rejects(
    () =>
      imports.run({
        key: `image:${first}`,
        load: async () => {
          throw Error("素材を保存できません");
        },
        apply: () => {
          throw Error("失敗した取り込みを適用してはいけない");
        },
      }),
    /素材を保存できません/,
  );
  assert.equal(imports.pending, 0);

  // 失敗の後でも同じ対象へやり直せる。
  const retry = await imports.run({
    key: `image:${first}`,
    load: async () => imageOf("image-2"),
    apply: (asset) =>
      editor.execute("setPanelImage", { panelId: first, asset, opacity: 1 }),
  });
  assert.equal(retry.applied, true);
  assert.equal(flatten(editor.project)[0].panel.image.assetId, "image-2");
});

test("imports without a key never supersede each other", async () => {
  const { editor, imports, ids } = setup();
  const [first] = ids;
  const a = deferred();
  const b = deferred();
  const place = (load, clipId, name) =>
    imports.run({
      load: () => load.promise,
      apply: (asset) =>
        editor.execute("addAudioClip", {
          clipId,
          asset,
          track: "se",
          anchor: first,
          at: 0,
          frames: 12,
        }),
    });

  const one = place(a, "clip-1");
  const two = place(b, "clip-2");
  b.settle({
    id: "sound-2",
    kind: "audio",
    name: "b.wav",
    mime: "audio/wav",
    bytes: 8,
  });
  a.settle({
    id: "sound-1",
    kind: "audio",
    name: "a.wav",
    mime: "audio/wav",
    bytes: 8,
  });
  assert.equal((await one).applied, true);
  assert.equal((await two).applied, true);
  assert.equal(editor.project.audio.length, 2);
  assert.equal(imports.pending, 0);
});
