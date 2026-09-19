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
