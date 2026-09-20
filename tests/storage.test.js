import { test } from "node:test";
import assert from "node:assert/strict";
import { IndexedDbStorage, MemoryStorage } from "../src/storage.js";

test("MemoryStorage batches multiple stores atomically", async () => {
  const storage = new MemoryStorage();
  await storage.put("meta", "before", { ok: true });
  const put = storage.put.bind(storage);
  let calls = 0;
  storage.put = async (...args) => {
    calls++;
    if (calls === 2) throw Error("書き込み拒否");
    return put(...args);
  };

  await assert.rejects(
    () =>
      storage.batch([
        { type: "put", store: "payloads", key: "save-1", value: "json" },
        {
          type: "put",
          store: "snapshots",
          key: "save-1",
          value: { id: "save-1" },
        },
      ]),
    /書き込み拒否/,
  );
  assert.deepEqual(await storage.keys("payloads"), []);
  assert.deepEqual(await storage.keys("snapshots"), []);
  assert.deepEqual(await storage.get("meta", "before"), { ok: true });
});

test("batch rollback restores each touched key to its own prior value, not just the whole store", async () => {
  const storage = new MemoryStorage();
  await storage.put("payloads", "existing-1", "kept-1");
  await storage.put("payloads", "existing-2", "kept-2");
  let calls = 0;
  const guard = () => {
    calls++;
    // Let the first two operations (and the guard calls around them) through,
    // then fail once the third operation is about to run.
    if (calls === 5) throw Error("書き込み拒否");
  };
  await assert.rejects(
    () =>
      storage.batch(
        [
          // put onto an existing key
          { type: "put", store: "payloads", key: "existing-1", value: "overwritten" },
          // delete an existing key
          { type: "delete", store: "payloads", key: "existing-2" },
          // this third operation never runs; everything above must roll back
          { type: "put", store: "payloads", key: "brand-new", value: "new" },
        ],
        { guard },
      ),
    /書き込み拒否/,
  );
  assert.equal(await storage.get("payloads", "existing-1"), "kept-1");
  assert.equal(await storage.get("payloads", "existing-2"), "kept-2");
  assert.equal(await storage.get("payloads", "brand-new"), undefined);
});

// Regression: MemoryStorage.batch() used to snapshot-clone every store's
// entire contents (via structuredClone) before every batch call, so its cost
// grew with the total bytes ever retained (e.g. all kept autosave
// generations), not with the bytes the batch actually touches. At 5000
// panels with 8 retained snapshots this made a single autosave take over a
// second in Node (~150MB+ cloned per save). The fix records only the prior
// value of each touched key, so an unrelated large entry must not slow a
// small, unrelated write down.
test("batch cost does not scale with unrelated data already in storage", async () => {
  const storage = new MemoryStorage();
  const bigString = "x".repeat(20_000_000);
  for (let i = 0; i < 6; i++)
    await storage.put("payloads", `large-${i}`, bigString);
  const { performance } = await import("node:perf_hooks");
  const t0 = performance.now();
  await storage.batch([
    { type: "put", store: "meta", key: "tiny", value: { ok: true } },
  ]);
  const elapsed = performance.now() - t0;
  assert.ok(
    elapsed < 200,
    `a small batch took ${elapsed.toFixed(1)}ms with ~120MB of unrelated data already stored`,
  );
  assert.deepEqual(await storage.get("meta", "tiny"), { ok: true });
});

test("Storage batch rejects invalid operations before touching data", async () => {
  const storage = new MemoryStorage();
  await storage.put("meta", "before", { ok: true });
  await assert.rejects(() =>
    storage.batch([
      { type: "put", store: "meta", key: "new", value: 1 },
      { type: "put", store: "unknown", key: "bad", value: 2 },
    ]),
  );
  assert.deepEqual(await storage.keys("meta"), ["before"]);
});

test("concurrent IndexedDB opens share one request", async () => {
  let opens = 0;
  const factory = {
    open() {
      opens++;
      const request = {
        result: {
          objectStoreNames: { contains: () => false },
          createObjectStore() {},
          close() {},
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      setTimeout(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  const storage = new IndexedDbStorage("race", factory);
  const [first, second, third] = await Promise.all([
    storage.open(),
    storage.open(),
    storage.open(),
  ]);
  assert.equal(opens, 1);
  assert.equal(first, storage);
  assert.equal(second, storage);
  assert.equal(third, storage);
});


test("IndexedDB can reopen after a completed connection is closed", async () => {
  let opens = 0;
  const factory = {
    open() {
      opens++;
      const request = {
        result: {
          objectStoreNames: { contains: () => false },
          createObjectStore() {},
          close() {},
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      setTimeout(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  const storage = new IndexedDbStorage("reopen", factory);
  await storage.open();
  storage.close();
  await storage.open();
  assert.equal(opens, 2);
});

test("IndexedDB retries after an opening request fails", async () => {
  let opens = 0;
  const factory = {
    open() {
      opens++;
      const request = {
        result: {
          objectStoreNames: { contains: () => false },
          createObjectStore() {},
          close() {},
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        error: Error("一時的なIndexedDBエラー"),
      };
      setTimeout(() => {
        if (opens === 1) request.onerror?.();
        else {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        }
      }, 0);
      return request;
    },
  };
  const storage = new IndexedDbStorage("retry", factory);
  await assert.rejects(() => storage.open(), /IndexedDB/);
  await storage.open();
  assert.equal(opens, 2);
});
