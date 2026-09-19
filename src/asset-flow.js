// Asset import lifecycle: request generations and GC leases live outside the UI.
// A late result is valid only when its editor session is still current and it is
// the latest request for the same session/target pair.
const targetKey = (sessionId, targetId) => `${sessionId}\\0${targetId}`;

export class AssetOperationCoordinator {
  constructor({ retain = () => () => {} } = {}) {
    this.retain = retain;
    this.sequence = 0;
    this.active = new Map();
    this.latest = new Map();
  }

  begin({ sessionId, targetId, assetId }) {
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      typeof targetId !== "string" ||
      !targetId ||
      typeof assetId !== "string" ||
      !assetId
    )
      throw Error("Asset操作の識別子が不正です");
    const operation = Object.freeze({
      requestId: ++this.sequence,
      sessionId,
      targetId,
      assetId,
    });
    const release = this.retain(assetId);
    this.active.set(operation.requestId, { operation, release });
    this.latest.set(
      targetKey(operation.sessionId, operation.targetId),
      operation.requestId,
    );
    return operation;
  }

  isCurrent(operation, sessionId) {
    if (!operation || typeof sessionId !== "string") return false;
    const entry = this.active.get(operation.requestId);
    return (
      !!entry &&
      operation.sessionId === sessionId &&
      this.latest.get(targetKey(operation.sessionId, operation.targetId)) ===
        operation.requestId
    );
  }

  finish(operation) {
    const entry = this.active.get(operation?.requestId);
    if (!entry) return false;
    this.active.delete(operation.requestId);
    const key = targetKey(
      entry.operation.sessionId,
      entry.operation.targetId,
    );
    if (this.latest.get(key) === operation.requestId) this.latest.delete(key);
    entry.release();
    return true;
  }

  activeAssetIds() {
    return new Set(
      [...this.active.values()].map(({ operation }) => operation.assetId),
    );
  }
}
