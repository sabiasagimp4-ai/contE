import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectRepository, Autosaver } from "../src/repository.js";
import { MemoryStorage } from "../src/storage.js";
import { project, panel, scene, shot, flatten, BRUSH } from "../src/model.js";
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
    ease: "linear",
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
test("save() accepts a pre-serialized json string and skips re-stringifying (E1)", async () => {
  const { repo } = repository();
  const p = project();
  const different = project();
  different.title = "分割シリアライズ側で作った文字列であることの目印";
  const meta = await repo.save(p, {
    kind: "manual",
    json: JSON.stringify(different),
  });
  // メタデータはpから作るが、本体は渡したjsonをそのまま使う。
  assert.equal(meta.title, p.title);
  assert.deepEqual(await repo.load(meta.id), different);
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
test("paper presets round-trip through the meta store and default to empty (D3)", async () => {
  const { repo } = repository();
  assert.deepEqual(await repo.getPaperPresets(), []);
  const presets = [
    {
      name: "自分用",
      size: "A4",
      orientation: "portrait",
      rows: 5,
      margin: 40,
      font: 16,
      columns: [{ key: "cut", width: 10 }],
    },
  ];
  await repo.setPaperPresets(presets);
  assert.deepEqual(await repo.getPaperPresets(), presets);
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
  p.scenes[0].shots[0].panels[0].image = { assetId: "asset-1", opacity: 1, fit: "contain", offset: { x: 0, y: 0 }, scale: 1 };
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
    fit: "contain",
    offset: { x: 0, y: 0 },
    scale: 1,
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
test("withProtection keeps an in-flight import's asset out of pruneAssets (E2/R05)", async () => {
  const { repo } = repository();
  const p = project(); // どのPanelからも参照していない新規素材を想定する。
  const duringPrune = await repo.withProtection("new-asset", async () => {
    await repo.putAsset("new-asset", new Uint8Array([1, 2, 3]));
    // 参照される前にGCが走っても、保護中なので消えない。
    return repo.pruneAssets(p, []);
  });
  assert.equal(duringPrune, 0, "取込中の素材が削除されている");
  assert.deepEqual([...(await repo.getAsset("new-asset"))], [1, 2, 3]);
  // 保護が外れれば、参照されていない素材として次のGCで消える。
  assert.equal(await repo.pruneAssets(p, []), 1);
  assert.equal(await repo.getAsset("new-asset"), undefined);
});
test("save() and pruneAssets() never overlap their storage access (E2/R05)", async () => {
  const { repo, storage } = repository();
  await repo.save(project(), { kind: "manual" });
  let active = 0,
    overlapped = false;
  // batchはput/deleteをそのまま呼ぶので、putは差し替えず二重計上を避ける。
  for (const name of ["batch", "delete", "keys", "values", "get"]) {
    const original = storage[name].bind(storage);
    storage[name] = async (...args) => {
      active++;
      if (active > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await original(...args);
      } finally {
        active--;
      }
    };
  }
  const p2 = project();
  p2.title = "並行呼び出し";
  await Promise.all([repo.save(p2, { kind: "manual" }), repo.pruneAssets(p2, [])]);
  assert.equal(overlapped, false, "save()とpruneAssets()のstorage操作が重なった");
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
// 複数Sceneのプロジェクトでないと、分割シリアライズがyieldするタイミングが
// なくcancel/resolvedのabortが効いたかどうか確かめられない（E1）。
const multiSceneProject = () => {
  const p = project();
  p.scenes = Array.from({ length: 3 }, () => scene(undefined, [shot([panel()])]));
  return p;
};
test("cancel() interrupts an in-flight serialize instead of failing it (E1)", async () => {
  const { repo } = repository();
  const p = multiSceneProject();
  const states = [];
  const saver = new Autosaver(repo, {
    onState: (s) => states.push(s),
    setTimer: () => null,
    clearTimer: () => {},
  });
  saver.schedule(() => p);
  const run = saver.flush();
  saver.cancel();
  const meta = await run;
  assert.equal(meta, null);
  assert.equal(states.at(-1).state, "idle");
  assert.ok(
    !states.some((s) => s.state === "failed"),
    "打ち切りが失敗として報告されている",
  );
  assert.deepEqual(await repo.list(), []);
});
test("resolved() interrupts an in-flight serialize instead of overwriting the manual save (E1)", async () => {
  const { repo } = repository();
  const p = multiSceneProject();
  const states = [];
  const saver = new Autosaver(repo, {
    onState: (s) => states.push(s),
    setTimer: () => null,
    clearTimer: () => {},
  });
  saver.schedule(() => p);
  const run = saver.flush();
  const manual = await repo.save(p, { kind: "manual" });
  saver.resolved(manual);
  const meta = await run;
  assert.equal(meta, null);
  assert.equal(states.at(-1).state, "saved");
  assert.ok(
    !states.some((s) => s.state === "failed"),
    "打ち切りが失敗として報告されている",
  );
  assert.equal((await repo.list()).length, 1, "打ち切ったはずの自動保存も書かれている");
});
// navigator.locksの最小限の模造品。名前ごとにFIFOで直列化する（E4）。
// 「2つのタブ」を1プロセス内で再現するため、2つのProjectRepositoryへ
// 同じインスタンスを渡して共有する。
function fakeLockManager() {
  const queues = new Map();
  return {
    request(name, fn) {
      const prev = queues.get(name) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      queues.set(
        name,
        run.then(
          () => {},
          () => {},
        ),
      );
      return run;
    },
  };
}
test("without navigator.locks, two repositories can still race their storage access (E4 control)", async () => {
  const storage = new MemoryStorage();
  const repoA = new ProjectRepository(storage, { now: clock() });
  const repoB = new ProjectRepository(storage, { now: clock(2000) });
  await repoA.save(project(), { kind: "manual" });
  let active = 0,
    overlapped = false;
  for (const name of ["batch", "delete", "keys", "values", "get"]) {
    const original = storage[name].bind(storage);
    storage[name] = async (...args) => {
      active++;
      if (active > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await original(...args);
      } finally {
        active--;
      }
    };
  }
  await Promise.all([
    repoA.save(project(), { kind: "manual" }),
    repoB.pruneAssets(project(), []),
  ]);
  assert.equal(
    overlapped,
    true,
    "ロックが無いのに2つのRepositoryが重ならなかった（このテスト自体が無意味になっている）",
  );
});
test("navigator.locks serializes save()/pruneAssets() across two repositories sharing one tab lock manager (E4)", async () => {
  const storage = new MemoryStorage();
  const locks = fakeLockManager();
  const repoA = new ProjectRepository(storage, { now: clock(), locks });
  const repoB = new ProjectRepository(storage, { now: clock(2000), locks });
  await repoA.save(project(), { kind: "manual" });
  let active = 0,
    overlapped = false;
  for (const name of ["batch", "delete", "keys", "values", "get"]) {
    const original = storage[name].bind(storage);
    storage[name] = async (...args) => {
      active++;
      if (active > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await original(...args);
      } finally {
        active--;
      }
    };
  }
  await Promise.all([
    repoA.save(project(), { kind: "manual" }),
    repoB.pruneAssets(project(), []),
  ]);
  assert.equal(
    overlapped,
    false,
    "navigator.locksがあるのに2つのRepositoryのstorage操作が重なった",
  );
});
test("onRemoteSave fires in another repository sharing the same BroadcastChannel (E4)", async () => {
  const channelName = `test-e4-${Math.random()}`;
  const { repo: repoA } = repository({
    channel: new BroadcastChannel(channelName),
  });
  const { repo: repoB } = repository({
    channel: new BroadcastChannel(channelName),
  });
  try {
    const events = [];
    const off = repoB.onRemoteSave((data) => events.push(data));
    const meta = await repoA.save(project(), { kind: "manual" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(events.length, 1);
    assert.equal(events[0].savedAt, meta.savedAt);
    assert.equal(events[0].kind, "manual");
    off();
    await repoA.save(project(), { kind: "manual" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(events.length, 1, "unsubscribe後も通知を受け取っている");
  } finally {
    repoA.channel.close();
    repoB.channel.close();
  }
});
test("pruneAssets asks other tabs before deleting, and keeps what they report as live (E4)", async () => {
  const channelName = `test-e4-${Math.random()}`;
  const { repo: repoA, storage } = repository({
    channel: new BroadcastChannel(channelName),
    livenessTimeout: 20,
  });
  const { repo: repoB } = repository({
    channel: new BroadcastChannel(channelName),
    livenessTimeout: 20,
  });
  try {
    // repoBのタブは、まだどのSnapshotにも保存していない新規素材を参照している。
    await repoA.putAsset("live-elsewhere", new Uint8Array([1]));
    repoB.setLiveAssets(() => new Set(["live-elsewhere"]));
    const p = project(); // repoA自身は何も参照していない
    const removed = await repoA.pruneAssets(p, []);
    assert.equal(removed, 0, "他タブが使用中の素材を消してしまっている");
    assert.deepEqual([...(await storage.get("assets", "live-elsewhere"))], [1]);
  } finally {
    repoA.channel.close();
    repoB.channel.close();
  }
});
test("pruneAssets keeps an asset the same tab now references, even if the passed p is stale (E4)", async () => {
  // pruneAssets(p, history)のpは呼び出し前の一瞬を捉えたものでしかない。
  // #askOtherTabsで待っている間（cross-tab環境）に自タブで新しい参照ができる
  // ことがあるので、削除の直前にsetLiveAssetsの「今」も反映されないと、
  // 取込直後の素材を誤って消してしまう（実ブラウザのE2/E4回帰で再現した）。
  const { repo } = repository({ livenessTimeout: 5 });
  await repo.putAsset("just-imported", new Uint8Array([9]));
  // 呼び出し時点のpはまだこの素材を知らない（インポートのCommandがまだ
  // 反映されていないタイミングを模す）。
  const staleP = project();
  repo.setLiveAssets(() => new Set(["just-imported"]));
  const removed = await repo.pruneAssets(staleP, []);
  assert.equal(removed, 0, "取込直後の素材を古いpの情報だけで消してしまった");
  assert.deepEqual([...(await repo.getAsset("just-imported"))], [9]);
});
test("pruneAssets still removes assets nobody (including other tabs) uses (E4)", async () => {
  const channelName = `test-e4-${Math.random()}`;
  const { repo: repoA, storage } = repository({
    channel: new BroadcastChannel(channelName),
    livenessTimeout: 20,
  });
  const { repo: repoB } = repository({
    channel: new BroadcastChannel(channelName),
    livenessTimeout: 20,
  });
  try {
    await repoA.putAsset("truly-orphaned", new Uint8Array([1]));
    repoB.setLiveAssets(() => new Set()); // 他タブも使っていない
    const removed = await repoA.pruneAssets(project(), []);
    assert.equal(removed, 1);
    assert.equal(await storage.get("assets", "truly-orphaned"), undefined);
  } finally {
    repoA.channel.close();
    repoB.channel.close();
  }
});
