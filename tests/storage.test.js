import { test } from "node:test";
import assert from "node:assert/strict";
import { IndexedDbStorage } from "../src/storage.js";

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
