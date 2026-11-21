// A test stand-in for the part of IndexedDB the label store uses: open with an upgrade (its
// transaction included), object stores with or without a key path, an index, transactions over
// several stores that commit whole or not at all, get, getAll over a lower bound with a count,
// count, put, delete, clear and a cursor. Requests answer in order, in tasks after they are made.
// A failure follows the specification's order: the request's error event, the same event at the
// transaction (with `tx.error` still null), then the transaction's error set and its abort event.
// oxlint-disable max-classes-per-file -- the database, its transaction, stores, index, cursor and request are one stand-in

interface Options {
  /** Opening throws, as blocked site data does. */
  throwOnOpen?: boolean;
  /** Opening fails with an error event, as some private windows do. */
  failOpen?: boolean;
  /** Opening fails with a VersionError: the store is newer than the page asking for it. */
  versionError?: boolean;
  /** Opening never answers, as a blocked upgrade or a stuck browser. */
  hangOpen?: boolean;
  /** More rows than this in the records store fail with QuotaExceededError. */
  room?: number;
  /** Where that failure is reported: by the put that passes the room (Firefox), or at commit. */
  quotaAt?: "request" | "commit";
}

type Row = Record<string, unknown>;
type Key = string | number;

/** IDBKeyRange's lower bound, which the store uses; installed where the test runner has none. */
export const KeyRange = {
  lowerBound: (lower: Key, lowerOpen = false) => ({ lower, lowerOpen }),
};
interface Range {
  lower: Key;
  lowerOpen: boolean;
}

/** Whether a key matches a query: none, a lower bound, or one key. */
const above = (k: Key, r: Range | Key | undefined) =>
  r === undefined || (typeof r === "object" ? (r.lowerOpen ? k > r.lower : k >= r.lower) : k === r);

class FakeRequest extends EventTarget {
  result: unknown;
  error: DOMException | null = null;
  transaction: FakeTransaction | null = null;
}

interface Table {
  keyPath: string | undefined;
  rows: Map<Key, unknown>;
  indexes: Map<string, string>;
}

const order = (a: Key, b: Key) => (a < b ? -1 : a > b ? 1 : 0);
const sortedKeys = (rows: Map<Key, unknown>) => {
  const keys = [...rows.keys()];
  keys.sort(order);
  return keys;
};

class FakeIndex {
  readonly store: FakeStore;
  readonly path: string;
  constructor(store: FakeStore, path: string) {
    this.store = store;
    this.path = path;
  }
  getAll(range?: Range | Key, count?: number): FakeRequest {
    return this.store.tx.queue(() => {
      const rows = [...this.store.rows().values()] as Row[];
      const by = (r: Row) => r[this.path] as Key;
      rows.sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0));
      return rows
        .filter((r) => above(by(r), range))
        .slice(0, count)
        .map((r) => structuredClone(r));
    });
  }
}

class FakeCursor {
  readonly store: FakeStore;
  readonly req: FakeRequest;
  key: Key;
  value: unknown;
  constructor(store: FakeStore, req: FakeRequest, key: Key) {
    this.store = store;
    this.req = req;
    this.key = key;
    this.value = structuredClone(store.rows().get(key));
  }
  delete(): FakeRequest {
    const key = this.key;
    return this.store.tx.queue(() => {
      this.store.rows().delete(key);
      return undefined;
    });
  }
  continue(): void {
    const key = this.key;
    this.store.tx.requeue(this.req, () => {
      const next = sortedKeys(this.store.rows()).find((k) => k > key);
      return next === undefined ? null : new FakeCursor(this.store, this.req, next);
    });
  }
}

class FakeStore {
  readonly tx: FakeTransaction;
  readonly name: string;
  constructor(tx: FakeTransaction, name: string) {
    this.tx = tx;
    this.name = name;
  }
  table(): Table {
    const t = this.tx.db.tables.get(this.name);
    if (!t) throw new DOMException("no store", "NotFoundError");
    return t;
  }
  rows(): Map<Key, unknown> {
    return this.tx.staged(this.name);
  }
  createIndex(name: string, path: string): void {
    this.table().indexes.set(name, path);
  }
  index(name: string): FakeIndex {
    const path = this.table().indexes.get(name);
    if (path === undefined) throw new DOMException("no index", "NotFoundError");
    return new FakeIndex(this, path);
  }
  put(value: unknown, key?: Key): FakeRequest {
    const copy = structuredClone(value);
    const path = this.table().keyPath;
    const k = path === undefined ? key : ((copy as Row)[path] as Key);
    if (k === undefined) throw new DOMException("no key", "DataError");
    return this.tx.queue(() => {
      this.rows().set(k, copy);
      const { room, quotaAt } = this.tx.db.options;
      if (
        room !== undefined &&
        quotaAt === "request" &&
        this.name === "records" &&
        this.rows().size > room
      )
        throw new DOMException("full", "QuotaExceededError");
      return k;
    });
  }
  get(key: Key): FakeRequest {
    return this.tx.queue(() => structuredClone(this.rows().get(key)));
  }
  count(): FakeRequest {
    return this.tx.queue(() => this.rows().size);
  }
  delete(key: Key): FakeRequest {
    return this.tx.queue(() => {
      this.rows().delete(key);
      return undefined;
    });
  }
  clear(): FakeRequest {
    return this.tx.queue(() => {
      this.rows().clear();
      return undefined;
    });
  }
  getAll(range?: Range | Key, count?: number): FakeRequest {
    return this.tx.queue(() => {
      const rows = this.rows();
      return sortedKeys(rows)
        .filter((k) => above(k, range))
        .slice(0, count)
        .map((k) => structuredClone(rows.get(k)));
    });
  }
  openCursor(): FakeRequest {
    const req = new FakeRequest();
    this.tx.requeue(req, () => {
      const first = sortedKeys(this.rows())[0];
      return first === undefined ? null : new FakeCursor(this, req, first);
    });
    return req;
  }
}

class FakeTransaction extends EventTarget {
  error: DOMException | null = null;
  readonly db: FakeDatabase;
  private readonly pending: [FakeRequest, () => unknown][] = [];
  private readonly copies = new Map<string, Map<Key, unknown>>();
  private done = false;
  private release: () => void = () => undefined;
  constructor(db: FakeDatabase) {
    super();
    this.db = db;
    // One transaction at a time, in the order they were made, as overlapping read-write
    // transactions are in a browser: each starts on what the one before it committed.
    const before = db.turn;
    db.turn = new Promise((resolve) => {
      this.release = resolve;
    });
    void before.then(() => setTimeout(() => this.step(), 0));
  }
  /** The store's rows as this transaction sees them: a copy, kept only if it completes. */
  staged(name: string): Map<Key, unknown> {
    let rows = this.copies.get(name);
    if (!rows) {
      const table = this.db.tables.get(name);
      rows = table ? new Map(table.rows) : new Map<Key, unknown>();
      this.copies.set(name, rows);
    }
    return rows;
  }
  objectStore(name: string): FakeStore {
    if (!this.db.tables.has(name)) throw new DOMException("no store", "NotFoundError");
    return new FakeStore(this, name);
  }
  queue(run: () => unknown): FakeRequest {
    const req = new FakeRequest();
    this.requeue(req, run);
    return req;
  }
  requeue(req: FakeRequest, run: () => unknown): void {
    if (this.done) throw new DOMException("finished", "TransactionInactiveError");
    req.transaction = this;
    this.pending.push([req, run]);
  }
  abort(): void {
    this.finish(new DOMException("aborted", "AbortError"));
  }
  private finish(error: DOMException | null): void {
    if (this.done) return;
    this.done = true;
    this.release();
    const room = this.db.options.room;
    const rows = this.copies.get("records")?.size ?? 0;
    const full =
      error === null && room !== undefined && this.db.options.quotaAt !== "request" && rows > room;
    const why = error ?? (full ? new DOMException("full", "QuotaExceededError") : null);
    if (why) {
      this.error = why;
      this.dispatchEvent(new Event("abort"));
      return;
    }
    for (const [name, staged] of this.copies) {
      const table = this.db.tables.get(name);
      if (table) table.rows = staged;
    }
    this.dispatchEvent(new Event("complete"));
  }
  /** Answers what is queued, in order, then gives other tasks a turn; done when nothing is left. */
  private step(): void {
    if (this.done) return;
    if (this.pending.length === 0) {
      this.finish(null);
      return;
    }
    for (let next = this.pending.shift(); next; next = this.pending.shift()) {
      const [req, run] = next;
      try {
        req.result = run();
      } catch (error) {
        req.error =
          error instanceof DOMException ? error : new DOMException(String(error), "UnknownError");
        req.dispatchEvent(new Event("error"));
        // The same event reaches the transaction before it aborts: its error is not set yet.
        this.dispatchEvent(new Event("error"));
        this.finish(req.error);
        return;
      }
      req.dispatchEvent(new Event("success"));
      if (this.done) return;
    }
    setTimeout(() => this.step(), 0);
  }
}

class FakeDatabase extends EventTarget {
  /** Settles when the last transaction made has finished. */
  turn: Promise<void> = Promise.resolve();
  tables = new Map<string, Table>();
  version = 0;
  closed = false;
  readonly options: Options;
  constructor(options: Options) {
    super();
    this.options = options;
  }
  createObjectStore(name: string, opts?: { keyPath: string }): FakeStore {
    this.tables.set(name, { keyPath: opts?.keyPath, rows: new Map(), indexes: new Map() });
    return new FakeStore(this.upgrading as FakeTransaction, name);
  }
  get objectStoreNames(): string[] {
    return [...this.tables.keys()];
  }
  deleteObjectStore(name: string): void {
    this.tables.delete(name);
  }
  upgrading: FakeTransaction | undefined;
  transaction(names: string | string[]): FakeTransaction {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
    for (const n of Array.isArray(names) ? names : [names])
      if (!this.tables.has(n)) throw new DOMException("no store", "NotFoundError");
    return new FakeTransaction(this);
  }
  close(): void {
    this.closed = true;
  }
}

/** A fresh database factory; `databases` exposes what it holds for a test to look at. */
export function fakeIndexedDB(options: Options = {}) {
  const databases = new Map<string, FakeDatabase>();
  const factory = {
    open(name: string, version: number): FakeRequest {
      if (options.throwOnOpen === true) throw new DOMException("blocked", "SecurityError");
      const req = new FakeRequest();
      if (options.hangOpen === true) return req;
      setTimeout(() => {
        if (options.failOpen === true || options.versionError === true) {
          req.error =
            options.versionError === true
              ? new DOMException("newer", "VersionError")
              : new DOMException("no", "InvalidStateError");
          req.dispatchEvent(new Event("error"));
          return;
        }
        let db = databases.get(name);
        if (!db) {
          db = new FakeDatabase(options);
          databases.set(name, db);
        }
        db.closed = false;
        req.result = db;
        if (db.version >= version) {
          req.dispatchEvent(new Event("success"));
          return;
        }
        const tx = new FakeTransaction(db);
        db.upgrading = tx;
        req.transaction = tx;
        const e = new Event("upgradeneeded");
        Object.defineProperty(e, "oldVersion", { value: db.version });
        db.version = version;
        req.dispatchEvent(e);
        tx.addEventListener("complete", () => {
          req.transaction = null;
          db.upgrading = undefined;
          req.dispatchEvent(new Event("success"));
        });
      }, 0);
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, databases };
}
