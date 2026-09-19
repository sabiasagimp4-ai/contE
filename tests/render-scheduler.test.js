import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderScheduler } from "../src/render-scheduler.js";

test("multiple timeline invalidations share one scheduled render", () => {
  const callbacks = [];
  const reasons = [];
  const scheduler = new RenderScheduler(
    (nextReasons) => reasons.push(nextReasons),
    {
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: () => {},
    },
  );

  assert.equal(scheduler.request("scroll"), true);
  assert.equal(scheduler.request("zoom"), false);
  assert.equal(scheduler.request("scroll"), false);
  assert.equal(callbacks.length, 1);
  assert.deepEqual(reasons, []);

  callbacks.shift()();
  assert.deepEqual(reasons, [["scroll", "zoom"]]);
  assert.equal(scheduler.pending, false);
});

test("cancel drops stale reasons and a later request can schedule again", () => {
  const callbacks = [];
  let cancelled = 0;
  const reasons = [];
  const scheduler = new RenderScheduler(
    (nextReasons) => reasons.push(nextReasons),
    {
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: () => {
        cancelled += 1;
      },
    },
  );

  scheduler.request("old");
  assert.equal(scheduler.cancel(), true);
  assert.equal(cancelled, 1);
  assert.equal(scheduler.flush(), false);
  scheduler.request("new");
  callbacks.at(-1)();
  assert.deepEqual(reasons, [["new"]]);
});
