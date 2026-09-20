// Drafts belong to their original target, not whichever panel is selected later.
export class TextDrafts {
  constructor(commit, {delay = 350, maxDelay = 1200} = {}) {
    this.commit = commit; this.delay = delay; this.maxDelay = maxDelay;
    this.entries = new Map(); this.composing = new Set(); this.timer = null; this.since = 0;
  }
  get pending() { return this.entries.size > 0; }
  stage(key, draft) {
    this.entries.set(key, draft);
    if (!this.since) this.since = Date.now();
    this.schedule();
  }
  composition(key, active) {
    if (active) this.composing.add(key); else this.composing.delete(key);
    this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.pending && !this.composing.size)
      this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.delay, this.maxDelay - (Date.now() - this.since))));
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.pending) return;
    const drafts = [...this.entries.values()];
    this.commit(drafts); // keep pending drafts if commit throws
    this.entries.clear(); this.since = 0;
  }
  clear() {
    clearTimeout(this.timer); this.entries.clear(); this.composing.clear(); this.since = 0;
  }
}
