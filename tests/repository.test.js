import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectRepository, Autosaver } from "../src/repository.js";
import { MemoryStorage } from "../src/storage.js";
import { project, panel, flatten, BRUSH } from "../src/model.js";
const clock = (start = 1000) => {
  let t = start;
  return () => (t += 1000);
};
const repository = (options = {}) => {
  const storage = new MemoryStorage();
  return {
    storage,
    repo: new ProjectRepository(storage, { now: clock(), ...options }),
  };
};
test("saved project reopens with identical drawing, timing and text", async () => {
  const { repo } = repository();
  const p = project();
  p.title = "保存の検証";
  p.scenes[0].shots[0].panels[0].frames = 37;
  p.scenes[0].shots[0].panels[0].dialogue = "台詞";
  p.scenes[0].shots[0].panels[0].strokes = [
    {
      size: BRUSH.default,
      erase: false,
      points: [
        [0.1, 0.1, 1],
        [0.9, 0.4, 0.4],
      ],
    },
  ];
  p.scenes[0].shots[0].panels[0].camera.push({
    t: 1,
    x: 0.3,
    y: 0,
    zoom: 2,
    rotation: 15,
  });
  const meta = await repo.save(p, { kind: "manual" });
  assert.equal(meta.panels, 1);
  assert.deepEqual(await repo.load(meta.id), p);
  assert.deepEqual((await repo.latest()).project, p);
});
test("invalid project is refused before any storage write", async () => {
  const { repo, storage } = repository();
  const p = project();
  p.scenes[0].shots[0].panels[0].frames = 0;
  await assert.rejects(() => repo.save(p));
  assert.deepEqual(await storage.keys("snapshots"), []);
  assert.deepEqual(await storage.keys("payloads"), []);
});
test("repository writes payload and metadata through one batch", async () => {
  const { repo, storage } = repository();
  const batches = [];
  const batch = storage.batch.bind(storage);
  storage.batch = async (operations) => {
    batches.push(operations);
    return batch(operations);
  };
  const p = project();
  const meta = await repo.save(p, { kind: "manual" });
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].map(({ type, store, key }) => ({ type, store, key })),
    [
      { type: "put", store: "payloads", key: meta.id },
      { type: "put", store: "snapshots", key: meta.id },
    ],
  );
  assert.deepEqual(await repo.load(meta.id), p);
});
test("repository keeps the previous save when a batch is aborted", async () => {
  const { repo, storage } = repository();
  const first = await repo.save(project(), { kind: "manual" });
  storage.batch = async () => {
    throw Error("transaction aborted");
  };
  await assert.rejects(() => repo.save(project()), /transaction aborted/);
  assert.equal((await repo.latest()).meta.id, first.id);
  assert.deepEqual((await storage.keys("payloads")), [first.id]);
  assert.deepEqual((await storage.keys("snapshots")), [first.id]);
});
test("corrupt snapshot is skipped, kept, and the previous good save is offered", async () => {
  const { repo, storage } = repository();
  const good = await repo.save(project(), { kind: "manual" });
  const broken = await repo.save(project());
  await storage.put("payloads", broken.id, "{ これはJSONではない");
  const candidate = await repo.latest();
  assert.equal(candidate.meta.id, good.id);
  assert.equal(candidate.broken.length, 1);
  assert.equal(candidate.broken[0].meta.id, broken.id);
  assert.ok((await storage.keys("snapshots")).includes(broken.id));
});
test("snapshots beyond the limit are pruned, newest and newest manual survive", async () => {
  const { repo, storage } = repository({ limit: 3 });
  const manual = await repo.save(project(), { kind: "manual" });
  const autos = [];
  for (let i = 0; i < 5; i++) autos.push(await repo.save(project()));
  const kept = (await repo.list()).map((m) => m.id);
  assert.deepEqual(
    kept.slice(0, 3),
    autos
      .slice(-3)
      .map((m) => m.id)
      .reverse(),
  );
  assert.ok(kept.includes(manual.id));
  assert.equal(kept.length, 4);
  // 消えたスナップショットの本体も残さない。
  assert.deepEqual((await storage.keys("payloads")).sort(), [...kept].sort());
});
test("a full quota frees old saves, retries once and keeps the last good data", async () => {
  const { repo, storage } = repository();
  const first = await repo.save(project(), { kind: "manual" });
  const put = storage.put.bind(storage);
  let failures = 1;
  storage.put = async (store, key, value) => {
    if (store === "payloads" && failures-- > 0) {
      const e = Error("容量が足りません");
      e.name = "QuotaExceededError";
      throw e;
    }
    return put(store, key, value);
  };
  const second = await repo.save(project());
  assert.equal((await repo.latest()).meta.id, second.id);
  assert.ok((await repo.list()).some((m) => m.id === first.id));
});
test("a save that keeps failing throws and leaves earlier saves readable", async () => {
  const { repo, storage } = repository();
  const first = await repo.save(project(), { kind: "manual" });
  storage.put = async () => {
    const e = Error("容量が足りません");
    e.name = "QuotaExceededError";
    throw e;
  };
  await assert.rejects(() => repo.save(project()));
  assert.equal((await repo.latest()).meta.id, first.id);
});
test("list() orders snapshots newest-first and keeps broken ones without deleting them", async () => {
  const { repo, storage } = repository();
  const first = await repo.save(project(), { kind: "manual" });
  const second = await repo.save(project());
  const third = await repo.save(project());
  await storage.put("payloads", second.id, "{ これはJSONではない");
  const metas = await repo.list();
  assert.deepEqual(
    metas.map((m) => m.id),
    [third.id, second.id, first.id],
  );
  await assert.rejects(() => repo.load(second.id));
  assert.deepEqual(await repo.load(first.id), await repo.load(first.id));
  assert.deepEqual(await repo.load(third.id), await repo.load(third.id));
  // 読めない世代も一覧からは消えない（B9: 履歴一覧で灰色表示するため）。
  assert.ok((await storage.keys("snapshots")).includes(second.id));
});
test("dismissing a recovery candidate keeps its data", async () => {
  const { repo } = repository();
  const meta = await repo.save(project());
  await repo.dismiss(meta.savedAt);
  assert.equal(await repo.dismissed(), meta.savedAt);
  assert.ok((await repo.latest()).project);
});
test("asset binaries live outside the project and orphans are pruned", async () => {
  const { repo } = repository();
  const p = project();
  p.assets.push({
    id: "asset-1",
    kind: "image",
    name: "bg.png",
    mime: "image/png",
    bytes: 4,
  });
  p.scenes[0].shots[0].panels[0].image = { assetId: "asset-1", opacity: 1 };
  await repo.putAsset("asset-1", new Uint8Array([1, 2, 3, 4]));
  await repo.putAsset("asset-2", new Uint8Array([9]));
  const meta = await repo.save(p);
  // プロジェクト本体に素材のバイナリを含めない。
  assert.ok(meta.bytes < 1500);
  assert.equal(await repo.pruneAssets(p), 1);
  assert.deepEqual(await repo.assetIds(), ["asset-1"]);
  assert.deepEqual([...(await repo.getAsset("asset-1"))], [1, 2, 3, 4]);
  assert.deepEqual((await repo.load(meta.id)).assets, p.assets);
});
test("asset pruning preserves references from snapshots and undo history", async () => {
  const { repo } = repository({ limit: 1 });
  const withImage = project();
  withImage.assets.push({
    id: "old-image",
    kind: "image",
    name: "old.png",
    mime: "image/png",
    bytes: 1,
  });
  withImage.scenes[0].shots[0].panels[0].image = {
    assetId: "old-image",
    opacity: 1,
  };
  await repo.putAsset("old-image", new Uint8Array([7]));
  const old = await repo.save(withImage, { kind: "manual" });

  const current = project();
  await repo.save(current);
  assert.equal(await repo.pruneAssets(current), 0);
  assert.deepEqual([...(await repo.getAsset("old-image"))], [7]);
  assert.equal((await repo.load(old.id)).assets[0].id, "old-image");

  await repo.remove(old.id);
  assert.equal(await repo.pruneAssets(current, [withImage]), 0);
  assert.deepEqual([...(await repo.getAsset("old-image"))], [7]);
  assert.equal(await repo.pruneAssets(current), 1);
  assert.equal(await repo.getAsset("old-image"), undefined);
});
test("asset pruning uses snapshot metadata without reparsing every payload", async () => {
  const { repo } = repository();
  const p = project();
  p.assets.push({
    id: "kept",
    kind: "image",
    name: "kept.png",
    mime: "image/png",
    bytes: 1,
  });
  await repo.putAsset("kept", new Uint8Array([1]));
  await repo.save(p);
  const originalLoad = repo.load.bind(repo);
  let loads = 0;
  repo.load = async (...args) => {
    loads++;
    return originalLoad(...args);
  };
  await repo.pruneAssets(project());
  assert.equal(loads, 0, "new snapshots should carry asset reachability metadata");
  assert.deepEqual([...(await repo.getAsset("kept"))], [1]);
});
test("autosave waits, writes once and reports its state", async () => {
  const { repo } = repository();
  const states = [];
  const timers = new Set();
  const saver = new Autosaver(repo, {
    onState: ({ state }) => states.push(state),
    setTimer: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimer: (fn) => timers.delete(fn),
  });
  const store = { p: project() };
  saver.schedule(() => store.p);
  saver.schedule(() => store.p);
  assert.equal(saver.pending, true);
  assert.equal(timers.size, 1);
  await [...timers][0]();
  assert.equal(saver.pending, false);
  assert.deepEqual(states, ["pending", "pending", "saving", "saved"]);
  assert.equal((await repo.list()).length, 1);
  assert.equal(await saver.flush(), null);
});
test("a failed autosave keeps the change pending instead of reporting success", async () => {
  const { repo, storage } = repository();
  storage.put = async () => {
    throw Error("書き込み拒否");
  };
  const states = [];
  const saver = new Autosaver(repo, {
    onState: (s) => states.push(s),
    setTimer: () => null,
    clearTimer: () => {},
  });
  saver.schedule(() => project());
  assert.equal(await saver.flush(), null);
  assert.equal(saver.pending, true);
  assert.equal(states.at(-1).state, "failed");
  assert.match(states.at(-1).message, /書き込み拒否/);
});
test("edits made while saving stay pending for the next write", async () => {
  const { repo } = repository();
  const saver = new Autosaver(repo, {
    setTimer: () => null,
    clearTimer: () => {},
  });
  const first = project();
  saver.schedule(() => first);
  const run = saver.flush();
  const second = project();
  second.scenes[0].shots[0].panels.push(panel());
  saver.schedule(() => second);
  await run;
  assert.equal(saver.pending, true);
  await saver.flush();
  assert.equal(saver.pending, false);
  assert.equal(flatten((await repo.latest()).project).length, 2);
});
test("a stale autosave does not report the latest revision as saved", async () => {
  const { repo } = repository();
  let current = project();
  let token = "revision-1";
  const source = () => current;
  const states = [];
  const saver = new Autosaver(repo, {
    isCurrent: (candidate) => candidate === token,
    onState: ({ state, stale }) => states.push({ state, stale }),
    setTimer: () => null,
    clearTimer: () => {},
  });
  saver.schedule(source, "revision-1");
  const run = saver.flush();
  current = project();
  current.scenes[0].shots[0].panels.push(panel());
  token = "revision-2";
  saver.schedule(source, "revision-2");
  await run;
  assert.equal(saver.pending, true);
  assert.ok(states.some(({ state, stale }) => state === "pending" && stale));
  await saver.flush();
  assert.equal(saver.pending, false);
  assert.equal(flatten((await repo.latest()).project).length, 2);
});
