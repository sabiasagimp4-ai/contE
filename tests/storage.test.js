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

// 接続要求を手で決着させるための最小のIndexedDB模造。実ブラウザの代わりではなく、
// 「どの順で何が届いたか」を固定して寿命の規則だけを検証する。
function fakeFactory() {
  const requests = [];
  const factory = {
    opens: 0,
    open() {
      factory.opens++;
      const db = {
        objectStoreNames: { contains: () => false },
        createObjectStore() {},
        closed: false,
        onversionchange: null,
        close() {
          this.closed = true;
        },
      };
      const request = {
        result: db,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        succeed() {
          this.onupgradeneeded?.();
          this.onsuccess?.();
          return db;
        },
        failWith(error) {
          this.error = error;
          this.onerror?.();
        },
        block() {
          this.onblocked?.();
        },
      };
      requests.push(request);
      return request;
    },
    last: () => requests.at(-1),
    all: requests,
  };
  return factory;
}

test("a failed open can be retried and does not stick to the rejection", async () => {
  const factory = fakeFactory();
  const storage = new IndexedDbStorage("retry", factory);
  const first = storage.open();
  factory.last().failWith(Error("開けません"));
  await assert.rejects(() => first, /開けません/);
  assert.equal(storage.opening, null);
  const second = storage.open();
  assert.equal(factory.opens, 2, "再試行が新しい要求を作っていない");
  factory.last().succeed();
  assert.equal(await second, storage);
  assert.equal(storage.db.closed, false);
});

test("close ends the connection and the next open reconnects", async () => {
  const factory = fakeFactory();
  const storage = new IndexedDbStorage("reopen", factory);
  const opened = storage.open();
  const firstDb = factory.last().succeed();
  await opened;
  storage.close();
  assert.equal(firstDb.closed, true);
  assert.equal(storage.db, null);
  const again = storage.open();
  assert.equal(factory.opens, 2);
  factory.last().succeed();
  assert.equal(await again, storage);
  assert.notEqual(storage.db, null);
  // 接続が戻っていれば通常の操作も「開かれていません」にならない。
  assert.equal(storage.opening, null);
});

test("a connection arriving after close is not published", async () => {
  const factory = fakeFactory();
  const storage = new IndexedDbStorage("late", factory);
  const pending = storage.open();
  storage.close();
  const lateDb = factory.last().succeed();
  await assert.rejects(() => pending, /破棄/);
  assert.equal(storage.db, null);
  assert.equal(lateDb.closed, true, "使わない接続を閉じていない");
});

test("a success after onblocked never becomes the live connection", async () => {
  const factory = fakeFactory();
  const storage = new IndexedDbStorage("blocked", factory);
  const blocked = storage.open();
  factory.last().block();
  await assert.rejects(() => blocked, /他のタブ/);
  const lateDb = factory.last().succeed();
  assert.equal(storage.db, null);
  assert.equal(lateDb.closed, true);
  // 失敗を返した後でも、次の要求は新しい接続を作れる。
  const retry = storage.open();
  assert.equal(factory.opens, 2);
  factory.last().succeed();
  assert.equal(await retry, storage);
});

test("versionchange from another tab drops the connection", async () => {
  const factory = fakeFactory();
  const storage = new IndexedDbStorage("versionchange", factory);
  const opened = storage.open();
  const db = factory.last().succeed();
  await opened;
  db.onversionchange();
  assert.equal(storage.db, null);
  assert.equal(db.closed, true);
  const again = storage.open();
  assert.equal(factory.opens, 2);
  factory.last().succeed();
  assert.equal(await again, storage);
});
