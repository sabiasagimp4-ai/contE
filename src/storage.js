// 永続化の下層。キー/値だけを扱い、プロジェクトの意味は知らない。
export const STORES = ["snapshots", "payloads", "assets", "meta"];
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
  }
  open() {
    if (this.db) return Promise.resolve(this);
    if (!this.factory) return Promise.reject(Error("IndexedDBが使えません"));
    return new Promise((resolve, reject) => {
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
  close() {
    this.db?.close();
    this.db = null;
  }
}
