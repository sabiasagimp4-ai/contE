import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetOperationCoordinator } from "../src/asset-flow.js";

test("latest operation for a target wins and all leases release", () => {
  const leases = new Map();
  const coordinator = new AssetOperationCoordinator({
    retain: (id) => {
      leases.set(id, (leases.get(id) ?? 0) + 1);
      return () => leases.set(id, leases.get(id) - 1);
    },
  });
  const first = coordinator.begin({
    sessionId: "session-1",
    targetId: "panel-1",
    assetId: "asset-1",
  });
  const second = coordinator.begin({
    sessionId: "session-1",
    targetId: "panel-1",
    assetId: "asset-2",
  });

  assert.equal(coordinator.isCurrent(first, "session-1"), false);
  assert.equal(coordinator.isCurrent(second, "session-1"), true);
  assert.deepEqual(
    [...coordinator.activeAssetIds()].sort(),
    ["asset-1", "asset-2"],
  );
  assert.equal(coordinator.finish(first), true);
  assert.equal(coordinator.isCurrent(second, "session-1"), true);
  assert.equal(coordinator.finish(second), true);
  assert.deepEqual([...coordinator.activeAssetIds()], []);
  assert.deepEqual([...leases.entries()].sort(), [
    ["asset-1", 0],
    ["asset-2", 0],
  ]);
});

test("a replaced editor session invalidates old operations", () => {
  const coordinator = new AssetOperationCoordinator();
  const operation = coordinator.begin({
    sessionId: "old-session",
    targetId: "panel-1",
    assetId: "asset-1",
  });
  assert.equal(coordinator.isCurrent(operation, "old-session"), true);
  assert.equal(coordinator.isCurrent(operation, "new-session"), false);
  assert.equal(coordinator.finish(operation), true);
  assert.equal(coordinator.finish(operation), false);
});
