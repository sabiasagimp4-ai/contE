// 永続化の下層。キー/値だけを扱い、プロジェクトの意味は知らない。
export const STORES = ["snapshots", "payloads", "assets", "meta"];
const STORE_SET = new Set(STORES);
const copy = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};
export class MemoryStorage {
  #data = new Map();
  #bucket(store) {
    if (!this.#data.has(store)) this.#data.set(store, new Map());
    return this.#data.get(store);
  }
  async open() {
    return this;
  }
  async get(store, key) {
    return copy(this.#bucket(store).get(key));
  }
  async put(store, key, value) {
    this.#bucket(store).set(key, copy(value));
  }
  async batch(operations, {guard = () => {}} = {}) {
    validateBatch(operations);
    guard();
    // MemoryStorageのテスト/フォールバックでも、複数Storeの確定を一単位にする。
    // put/deleteを差し替えたテスト doubles も同じ失敗経路を通れるようにする。
    // ロールバックは操作対象のKeyだけを退避する。無関係な既存データ（他のSnapshotの
    // payloadなど）を毎回まるごと複製すると、保持世代が増えるほどbatch1回のコストが
    // 際限なく重くなるため、触れた分だけを戻す。
    const undo = [];
    try {
      for (const operation of operations) {
        guard();
        const bucket = this.#bucket(operation.store);
        const had = bucket.has(operation.key);
        undo.push({
          store: operation.store,
          key: operation.key,
          had,
          value: had ? bucket.get(operation.key) : undefined,
        });
        if (operation.type === "put")
          await this.put(operation.store, operation.key, operation.value);
        else await this.delete(operation.store, operation.key);
        guard();
      }
    } catch (e) {
      // 触れた順の逆から戻す。同じKeyを複数回操作していても最初の値へ戻る。
      for (const entry of undo.reverse()) {
        const bucket = this.#bucket(entry.store);
        if (entry.had) bucket.set(entry.key, entry.value);
        else bucket.delete(entry.key);
      }
      throw e;
    }
  }
  async delete(store, key) {
    this.#bucket(store).delete(key);
  }
  async keys(store) {
    return [...this.#bucket(store).keys()];
  }
  async values(store) {
    return [...this.#bucket(store).values()].map(copy);
  }
  close() {}
}
export class IndexedDbStorage {
  static available(factory = globalThis.indexedDB) {
    return !!factory;
  }
  constructor(name = "contE", factory = globalThis.indexedDB, version = 1) {
    this.name = name;
    this.factory = factory;
    this.version = version;
    this.db = null;
    this.opening = null;
  }
  open() {
    if (this.db) return Promise.resolve(this);
    if (!this.factory) return Promise.reject(Error("IndexedDBが使えません"));
    if (this.opening) return this.opening;
    const opening = new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, this.version);
      request.onupgradeneeded = () => {
        for (const store of STORES)
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
      };
      request.onsuccess = () => {
        this.db = request.result;
        // 別タブが新しい形式へ上げた場合は握ったままにしない。
        this.db.onversionchange = () => this.close();
        resolve(this);
      };
      request.onerror = () =>
        reject(request.error ?? Error("IndexedDBを開けません"));
      request.onblocked = () =>
        reject(Error("IndexedDBが他のタブで使用中です"));
    });
    const tracked = opening.finally(() => {
      if (this.opening === tracked) this.opening = null;
    });
    this.opening = tracked;
    return tracked;
  }
  #run(store, mode, body) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(Error("IndexedDBが開かれていません"));
      let tx;
      try {
        tx = this.db.transaction(store, mode);
      } catch (e) {
        return reject(e);
      }
      const request = body(tx.objectStore(store));
      // 書き込みはトランザクション完了まで成功と見なさない。
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () =>
        reject(tx.error ?? request?.error ?? Error("保存失敗"));
      tx.onabort = () =>
        reject(tx.error ?? request?.error ?? Error("保存中断"));
    });
  }
  get(store, key) {
    return this.#run(store, "readonly", (s) => s.get(key));
  }
  put(store, key, value) {
    return this.#run(store, "readwrite", (s) => s.put(value, key));
  }
  delete(store, key) {
    return this.#run(store, "readwrite", (s) => s.delete(key));
  }
  keys(store) {
    return this.#run(store, "readonly", (s) => s.getAllKeys());
  }
  values(store) {
    return this.#run(store, "readonly", (s) => s.getAll());
  }
  batch(operations, {guard = () => {}} = {}) {
    validateBatch(operations);
    guard();
    if (!operations.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(Error("IndexedDBが開かれていません"));
      const stores = [...new Set(operations.map((operation) => operation.store))];
      let tx, guardError;
      try {
        tx = this.db.transaction(stores, "readwrite");
        for (const operation of operations) {
          const objectStore = tx.objectStore(operation.store);
          const request = operation.type === "put"
            ? objectStore.put(operation.value, operation.key)
            : objectStore.delete(operation.key);
          request.onsuccess = () => {
            try { guard(); } catch (e) { guardError = e; tx.abort(); }
          };
        }
      } catch (e) {
        try {
          tx?.abort();
        } catch {}
        reject(e);
        return;
      }
      // requestの成功ではなくtransactionの完了だけを保存成功とする。
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? Error("保存失敗"));
      tx.onabort = () =>
        reject(guardError ?? tx.error ?? Error("保存中断"));
    });
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}

function validateBatch(operations) {
  if (!Array.isArray(operations)) throw Error("保存操作が不正です");
  for (const operation of operations) {
    if (
      !operation ||
      !["put", "delete"].includes(operation.type) ||
      !STORE_SET.has(operation.store) ||
      operation.key === undefined
    )
      throw Error("保存操作が不正です");
    if (operation.type === "put" && !Object.hasOwn(operation, "value"))
      throw Error("保存値がありません");
  }
}

