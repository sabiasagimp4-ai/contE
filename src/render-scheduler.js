const defaultSchedule = (callback) => {
  if (typeof globalThis.requestAnimationFrame === "function")
    return globalThis.requestAnimationFrame(callback);
  return globalThis.queueMicrotask(callback);
};

const defaultCancel = (handle) => {
  if (typeof globalThis.cancelAnimationFrame === "function")
    globalThis.cancelAnimationFrame(handle);
};

export class RenderScheduler {
  constructor(render, { schedule = defaultSchedule, cancel = defaultCancel } = {}) {
    if (typeof render !== "function") throw Error("描画関数が必要です");
    if (typeof schedule !== "function") throw Error("schedule関数が必要です");
    this.render = render;
    this.schedule = schedule;
    this.cancelScheduled = cancel;
    this.pending = false;
    this.handle = null;
    this.reasons = new Set();
  }

  request(reason = "update") {
    this.reasons.add(reason);
    if (this.pending) return false;
    this.pending = true;
    this.handle = this.schedule(() => this.flush());
    return true;
  }

  flush() {
    if (!this.pending) return false;
    this.pending = false;
    this.handle = null;
    const reasons = [...this.reasons];
    this.reasons.clear();
    this.render(reasons);
    return true;
  }

  cancel() {
    if (!this.pending) return false;
    this.cancelScheduled?.(this.handle);
    this.pending = false;
    this.handle = null;
    this.reasons.clear();
    return true;
  }
}
