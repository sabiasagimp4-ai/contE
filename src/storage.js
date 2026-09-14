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
  async batch(operations) {
    validateBatch(operations);
    // MemoryStorageのテスト/フォールバックでも、複数Storeの確定を一単位にする。
    // put/deleteを差し替えたテスト doubles も同じ失敗経路を通れるようにする。
    const before = new Map(
      [...this.#data].map(([store, values]) => [
        store,
        new Map([...values].map(([key, value]) => [key, copy(value)])),
      ]),
    );
    try {
      for (const operation of operations) {
        if (operation.type === "put")
          await this.put(operation.store, operation.key, operation.value);
        else await this.delete(operation.store, operation.key);
      }
    } catch (e) {
      this.#data = before;
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
    this.generation = 0;
  }
  // 接続要求は1つだけ生かす。決着した要求は必ず片付け、失敗した後も再試行できる。
  // 世代は「この要求の接続を今も公開してよいか」の判定に使い、closeで進める。
  open() {
    if (this.db) return Promise.resolve(this);
    if (!this.factory) return Promise.reject(Error("IndexedDBが使えません"));
    if (this.opening) return this.opening;
    const generation = ++this.generation;
    let abandoned = false;
    const opening = new Promise((resolve, reject) => {
      const fail = (error) => {
        abandoned = true;
        reject(error);
      };
      let request;
      try {
        request = this.factory.open(this.name, this.version);
      } catch (e) {
        fail(e);
        return;
      }
      request.onupgradeneeded = () => {
        for (const store of STORES)
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
      };
      request.onsuccess = () => {
        const db = request.result;
        // onblocked/errorで失敗を返した後、close後、別の要求へ進んだ後に届いた
        // 接続は呼び出し元のものではない。黙って公開せず閉じる。
        if (abandoned || generation !== this.generation) {
          db.close?.();
          fail(Error("IndexedDBの接続は破棄されました"));
          return;
        }
        this.db = db;
        // 別タブが新しい形式へ上げた場合は握ったままにしない。
        db.onversionchange = () => this.close();
        resolve(this);
      };
      request.onerror = () =>
        fail(request.error ?? Error("IndexedDBを開けません"));
      request.onblocked = () => fail(Error("IndexedDBが他のタブで使用中です"));
    });
    const done = () => {
      if (this.opening === opening) this.opening = null;
    };
    // 同じ参照を保持したまま決着を待つ。ここで失敗も受け取るので、呼び出し元が
    // 握り潰しても未処理のrejectionにならない。
    opening.then(done, done);
    this.opening = opening;
    return opening;
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
  batch(operations) {
    validateBatch(operations);
    if (!operations.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(Error("IndexedDBが開かれていません"));
      const stores = [...new Set(operations.map((operation) => operation.store))];
      let tx;
      try {
        tx = this.db.transaction(stores, "readwrite");
        for (const operation of operations) {
          const objectStore = tx.objectStore(operation.store);
          if (operation.type === "put")
            objectStore.put(operation.value, operation.key);
          else objectStore.delete(operation.key);
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
        reject(tx.error ?? Error("保存中断"));
    });
  }
  close() {
    // 進行中の要求が後から接続を公開しないよう世代を進める。次のopenは新しい要求。
    this.generation++;
    this.db?.close();
    this.db = null;
    this.opening = null;
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
