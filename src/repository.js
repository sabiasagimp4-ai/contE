import { load, validate, flatten } from "./model.js";
import { serializeProject } from "./serialize.js";
export const SNAPSHOT_LIMIT = 8;
const isQuota = (e) =>
  e?.name === "QuotaExceededError" ||
  e?.code === 22 ||
  /quota|容量/i.test(e?.message ?? "");
const countPanels = (p) => flatten(p).length;
// 複数タブの排他（E4）。navigator.locksが無い環境ではこれまでどおり
// タブ内の直列化（#serial）だけで動く。BroadcastChannelも無ければ
// 保存通知・素材の生存確認はしない（単一タブとして動く）。
// windowの有無も見るのは、Node（テスト実行環境）がBroadcastChannelだけを
// グローバルに持つため。ブラウザらしい環境でなければ既定では作らない。
const browserLike = typeof window !== "undefined";
const defaultLocks = () =>
  (browserLike && typeof navigator !== "undefined" ? navigator.locks : null) ??
  null;
const defaultChannel = () =>
  browserLike && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("conte-repository")
    : null;
// 保存・復旧・素材の入出力を一か所に集める。UIはここだけを通して永続化する。
export class ProjectRepository {
  // 保存とGCの直列キュー（E2/R05）。save()とpruneAssets()を同じ列に並べ、
  // 互いの途中状態を踏まないようにする。1件の失敗で列全体を止めない。
  #queue = Promise.resolve();
  // Import中の原本を指す資産IDの保護カウント（E2/R05）。プロジェクトへ
  // まだ参照されていない新規素材を、その間だけGCの対象から外す。
  #protected = new Map();
  // このタブを他タブと区別するための印（E4）。保存通知や生存確認の
  // メッセージが自分自身のものかを見分けるためだけに使う。
  #tabId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // このタブが今参照している素材IDを答える関数。appが起動時に差し替える。
  #liveAssets = () => new Set();
  constructor(
    storage,
    {
      now = () => Date.now(),
      limit = SNAPSHOT_LIMIT,
      locks = defaultLocks(),
      channel = defaultChannel(),
      livenessTimeout = 60,
    } = {},
  ) {
    this.storage = storage;
    this.now = now;
    this.limit = limit;
    this.locks = locks;
    this.channel = channel;
    this.livenessTimeout = livenessTimeout;
    this.channel?.addEventListener("message", (e) => {
      const msg = e.data;
      if (msg?.type === "liveness-query" && msg.from !== this.#tabId)
        this.channel.postMessage({
          type: "liveness-reply",
          queryId: msg.queryId,
          assetIds: [...this.#liveAssets()],
        });
    });
  }
  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  // 現在このタブが参照している素材IDを答えられるようにする（E4）。
  // 他タブのpruneAssetsが、保存前の参照まで壊さないための問い合わせに使う。
  setLiveAssets(getIds) {
    this.#liveAssets = getIds;
  }
  // navigator.locksが使える環境だけ、名前つきロックでタブ間の実行を排他する。
  // 無い環境では今までどおりタブ内の直列化（#serial）だけで動く（E4）。
  async #withLocks(names, fn) {
    if (!this.locks?.request) return fn();
    const [name, ...rest] = names;
    return this.locks.request(name, () =>
      rest.length ? this.#withLocks(rest, fn) : fn(),
    );
  }
  // 他タブに今使っている素材IDを尋ね、短い猶予だけ返事を待つ（E4）。
  // BroadcastChannelが無ければ何も待たずに空集合を返す。
  async #askOtherTabs(timeoutMs = this.livenessTimeout) {
    if (!this.channel) return new Set();
    const queryId = `${this.#tabId}-${this.now()}-${Math.random()}`;
    const used = new Set();
    const handler = (e) => {
      if (e.data?.type === "liveness-reply" && e.data.queryId === queryId)
        for (const id of e.data.assetIds) used.add(id);
    };
    this.channel.addEventListener("message", handler);
    this.channel.postMessage({
      type: "liveness-query",
      queryId,
      from: this.#tabId,
    });
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    this.channel.removeEventListener("message", handler);
    return used;
  }
  // 保存が起きたことを他タブへ知らせる。復旧候補の提示を重複させないために使う。
  onRemoteSave(callback) {
    if (!this.channel) return () => {};
    const handler = (e) => {
      if (e.data?.type === "saved") callback(e.data);
    };
    this.channel.addEventListener("message", handler);
    return () => this.channel.removeEventListener("message", handler);
  }
  #retain(id) {
    this.#protected.set(id, (this.#protected.get(id) ?? 0) + 1);
  }
  #release(id) {
    const count = this.#protected.get(id) - 1;
    if (count <= 0) this.#protected.delete(id);
    else this.#protected.set(id, count);
  }
  // 呼び出し中は該当IDをpruneAssetsの削除対象から外す。取込のload〜apply全体を
  // 包むことで、Projectへ参照される前の新規素材をGCから守る。
  async withProtection(id, fn) {
    return this.withProtectionAll([id], fn);
  }
  // 複数IDをまとめて保護する（D1）。Bundle取込のように、Projectへ公開する前に
  // 何件も書く場合に使う。入れ子の再帰にすると素材の件数だけスタックを積むので、
  // 参照カウントをまとめて上げ下げする。
  async withProtectionAll(ids, fn) {
    for (const id of ids) this.#retain(id);
    try {
      return await fn();
    } finally {
      for (const id of ids) this.#release(id);
    }
  }
  async open() {
    await this.storage.open?.();
    return this;
  }
  // jsonを渡すと二重にJSON化しない（E1）。分割シリアライズした結果を
  // そのまま使う経路で、Autosaverがここを通る。
  async save(p, { kind = "auto", json } = {}) {
    // 壊れたデータを保存させない。検証前に既存の保存へ触れない。
    validate(p);
    return this.#serial(() =>
      this.#withLocks(["conte-write"], () => this.#saveNow(p, kind, json)),
    );
  }
  async #saveNow(p, kind, json) {
    const savedAt = this.now();
    const data = json ?? JSON.stringify(p);
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
    // 他タブへ保存の発生を知らせる。復旧候補の提示を重複させないために使う。
    this.channel?.postMessage({ type: "saved", savedAt, kind, from: this.#tabId });
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
  // 紙面プリセット（D3）。組み込み分はコード側の定数が持つので、ここではユーザーが
  // 保存した分だけを持つ。Projectには入れず、layoutと同じmetaストアに置く。
  async getPaperPresets() {
    return (await this.storage.get("meta", "paperPresets")) ?? [];
  }
  async setPaperPresets(presets) {
    await this.storage.put("meta", "paperPresets", presets);
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
  // 取込中でwithProtectionに登録されているIDは、まだ参照が無くても対象にしない。
  // navigator.locksが使える環境では、削除の前に他タブが今使っている素材も
  // 尋ねて保護する（E4）。無い環境ではこれまでどおりタブ内の情報だけで判断する。
  async pruneAssets(p, history = []) {
    return this.#serial(() =>
      this.#withLocks(["conte-write", "conte-gc"], () =>
        this.#pruneAssetsNow(p, history),
      ),
    );
  }
  async #pruneAssetsNow(p, history) {
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
    for (const id of await this.#askOtherTabs()) used.add(id);
    // 呼び出し時に渡されたp/historyは呼び出し前の一瞬を捉えたものでしかない。
    // #askOtherTabsで待っている間に自タブで新しい参照ができることもあるので、
    // 削除の直前に自タブの「今」をもう一度反映する（E4）。
    for (const id of this.#liveAssets()) used.add(id);
    let removed = 0;
    for (const id of await this.assetIds())
      if (!used.has(id) && !this.#protected.has(id)) {
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
      isCurrent = () => true,
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
    this.sourceToken = null;
    this.isCurrent = isCurrent;
    // 直列化（E1）を打ち切れるようにする。resolved/cancelで使う。
    this.controller = null;
  }
  get pending() {
    return !!this.source || this.state === "failed";
  }
  #emit(state, detail = {}) {
    this.state = state;
    this.onState({ state, ...detail });
  }
  schedule(source, token = null) {
    this.source = source;
    this.sourceToken = token;
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
    const token = this.sourceToken;
    this.#emit("saving");
    // Scene単位で分割シリアライズする間、resolved/cancelから打ち切れるようにする。
    const controller = new AbortController();
    this.controller = controller;
    this.running = (async () => {
      try {
        const project = source();
        const json = await serializeProject(project, {
          signal: controller.signal,
        });
        const meta = await this.repo.save(project, { kind: "auto", json });
        const current =
          this.source === source &&
          (!token || this.isCurrent(token));
        // 保存中にさらに編集されていたら未保存のまま残す。
        if (current) {
          this.source = null;
          this.sourceToken = null;
          this.pendingSince = 0;
          this.#emit("saved", { meta });
        } else {
          // 古いrevisionの保存成功は、最新状態の成功表示にしない。
          this.#emit("pending", { meta, stale: true });
        }
        return meta;
      } catch (e) {
        // resolved/cancelによる打ち切り。状態は呼び出し側が既に確定させている。
        if (e.name === "AbortError") return null;
        this.#emit("failed", { message: e.message });
        return null;
      } finally {
        this.running = null;
        if (this.controller === controller) this.controller = null;
      }
    })();
    const meta = await this.running;
    // 失敗したら自動では叩き続けない。次の編集か手動保存で再試行する。
    if (meta && this.source && !this.timer)
      this.schedule(this.source, this.sourceToken);
    return meta;
  }
  // 手動保存などで同じ内容が保存済みになったとき、待機中の自動保存を解除する。
  resolved(meta) {
    // 進行中の直列化があっても、もう使わないので打ち切る。
    this.controller?.abort();
    this.clearTimer(this.timer);
    this.timer = null;
    this.source = null;
    this.sourceToken = null;
    this.pendingSince = 0;
    this.#emit("saved", { meta });
  }
  cancel() {
    this.controller?.abort();
    this.clearTimer(this.timer);
    this.timer = null;
    this.source = null;
    this.sourceToken = null;
    this.pendingSince = 0;
    this.#emit("idle");
  }
}
