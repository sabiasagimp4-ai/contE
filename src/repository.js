import { load, validate, flatten } from "./model.js";
export const SNAPSHOT_LIMIT = 8;
const isQuota = (e) =>
  e?.name === "QuotaExceededError" ||
  e?.code === 22 ||
  /quota|容量/i.test(e?.message ?? "");
const countPanels = (p) => flatten(p).length;
// 保存・復旧・素材の入出力を一か所に集める。UIはここだけを通して永続化する。
export class ProjectRepository {
  constructor(
    storage,
    { now = () => Date.now(), limit = SNAPSHOT_LIMIT } = {},
  ) {
    this.storage = storage;
    this.now = now;
    this.limit = limit;
  }
  async open() {
    await this.storage.open?.();
    return this;
  }
  async save(p, { kind = "auto" } = {}) {
    // 壊れたデータを保存させない。検証前に既存の保存へ触れない。
    validate(p);
    const savedAt = this.now();
    const data = JSON.stringify(p);
    const meta = {
      id: `${kind}-${savedAt}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      savedAt,
      title: p.title,
      fps: p.fps,
      version: p.version,
      panels: countPanels(p),
      bytes: data.length,
      // 素材GCはスナップショット本体を再パースせずに到達性を判定する。
      assetIds: p.assets.map((asset) => asset.id),
    };
    try {
      await this.#write(meta, data);
    } catch (e) {
      if (!isQuota(e)) throw e;
      // 容量不足のときだけ古い保存を落として一度だけ再試行する。
      await this.#prune(1);
      await this.#write(meta, data);
    }
    await this.#prune();
    return meta;
  }
  async #write(meta, data) {
    if (typeof this.storage.batch === "function") {
      await this.storage.batch([
        { type: "put", store: "payloads", key: meta.id, value: data },
        { type: "put", store: "snapshots", key: meta.id, value: meta },
      ]);
      return;
    }
    // 旧Storage Adapterとの互換経路。現行Storageは上のbatchを実装する。
    await this.storage.put("payloads", meta.id, data);
    try {
      await this.storage.put("snapshots", meta.id, meta);
    } catch (e) {
      await this.storage.delete("payloads", meta.id).catch(() => {});
      throw e;
    }
  }
  async list() {
    const metas = await this.storage.values("snapshots");
    return metas
      .filter((m) => m && typeof m.savedAt === "number")
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  async load(id) {
    const data = await this.storage.get("payloads", id);
    if (typeof data !== "string") throw Error("保存データが見つかりません");
    return load(data);
  }
  // 復旧候補。壊れた保存は消さずに読み飛ばし、直前の正常なデータを返す。
  async latest() {
    const broken = [];
    for (const meta of await this.list()) {
      try {
        return { meta, project: await this.load(meta.id), broken };
      } catch (e) {
        broken.push({ meta, message: e.message });
      }
    }
    return broken.length ? { meta: null, project: null, broken } : null;
  }
  async remove(id) {
    await this.storage.delete("snapshots", id);
    await this.storage.delete("payloads", id);
  }
  async #prune(limit = this.limit) {
    const metas = await this.list();
    const keep = new Set(metas.slice(0, Math.max(1, limit)).map((m) => m.id));
    const manual = metas.find((m) => m.kind === "manual");
    if (manual) keep.add(manual.id);
    for (const m of metas) if (!keep.has(m.id)) await this.remove(m.id);
    for (const id of await this.storage.keys("payloads"))
      if (!keep.has(id)) await this.storage.delete("payloads", id);
    return metas.length - keep.size;
  }
  // 「今回は復旧しない」という判断を覚える。保存データ自体は消さない。
  async dismiss(savedAt) {
    await this.storage.put("meta", "session", { dismissedAt: savedAt });
  }
  async dismissed() {
    return (await this.storage.get("meta", "session"))?.dismissedAt ?? 0;
  }
  // ペイン幅などの画面設定。プロジェクトの内容とは分けて持つ。
  async getLayout() {
    return (await this.storage.get("meta", "layout")) ?? null;
  }
  async setLayout(layout) {
    await this.storage.put("meta", "layout", layout);
  }
  async putAsset(id, blob) {
    await this.storage.put("assets", id, blob);
  }
  async getAsset(id) {
    return this.storage.get("assets", id);
  }
  async assetIds() {
    return this.storage.keys("assets");
  }
  // 現在値、保持中の保存世代、Undo/Redoのどこからも参照されない素材だけを捨てる。
  async pruneAssets(p, history = []) {
    const used = new Set();
    const collect = (project) => {
      for (const asset of project?.assets ?? []) used.add(asset.id);
    };
    collect(p);
    for (const project of history) collect(project);
    for (const meta of await this.list()) {
      if (Array.isArray(meta.assetIds)) {
        for (const id of meta.assetIds) used.add(id);
        continue;
      }
      try {
        collect(await this.load(meta.id));
      } catch {
        // 旧形式または読めない保存は、正常な世代のGCを妨げない。
      }
    }
    let removed = 0;
    for (const id of await this.assetIds())
      if (!used.has(id)) {
        await this.storage.delete("assets", id);
        removed++;
      }
    return removed;
  }
}
// 変更から少し待って保存し、待ち続けないように上限も設ける。
export class Autosaver {
  constructor(
    repo,
    {
      delay = 600,
      maxDelay = 4000,
      onState = () => {},
      now = () => Date.now(),
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (id) => clearTimeout(id),
    } = {},
  ) {
    this.repo = repo;
    this.delay = delay;
    this.maxDelay = maxDelay;
    this.onState = onState;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.source = null;
    this.pendingSince = 0;
    this.timer = null;
    this.running = null;
    this.state = "idle";
  }
  get pending() {
    return !!this.source || this.state === "failed";
  }
  #emit(state, detail = {}) {
    this.state = state;
    this.onState({ state, ...detail });
  }
  schedule(source) {
    this.source = source;
    if (!this.pendingSince) this.pendingSince = this.now();
    this.clearTimer(this.timer);
    const wait = Math.max(
      0,
      Math.min(this.delay, this.pendingSince + this.maxDelay - this.now()),
    );
    this.timer = this.setTimer(() => this.flush(), wait);
    this.#emit("pending");
  }
  async flush() {
    this.clearTimer(this.timer);
    this.timer = null;
    if (!this.source) return null;
    if (this.running) return this.running;
    const source = this.source;
    this.#emit("saving");
    this.running = (async () => {
      try {
        const meta = await this.repo.save(source(), { kind: "auto" });
        // 保存中にさらに編集されていたら未保存のまま残す。
        if (this.source === source) {
          this.source = null;
          this.pendingSince = 0;
        }
        this.#emit("saved", { meta });
        return meta;
      } catch (e) {
        this.#emit("failed", { message: e.message });
        return null;
      } finally {
        this.running = null;
      }
    })();
    const meta = await this.running;
    // 失敗したら自動では叩き続けない。次の編集か手動保存で再試行する。
    if (meta && this.source && !this.timer) this.schedule(this.source);
    return meta;
  }
  // 手動保存などで同じ内容が保存済みになったとき、待機中の自動保存を解除する。
  resolved(meta) {
    this.clearTimer(this.timer);
    this.timer = null;
    this.source = null;
    this.pendingSince = 0;
    this.#emit("saved", { meta });
  }
  cancel() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.source = null;
    this.pendingSince = 0;
    this.#emit("idle");
  }
}
