// A test stand-in for the part of IndexedDB the label store uses: open with an upgrade, one
// object store with a key path, read-write transactions that commit whole or not at all, put,
// delete, clear and getAll. Requests answer in a task after they are made, as a browser's do. It
// can refuse to open, and run out of room after a number of records, as a full disk does.
// oxlint-disable max-classes-per-file -- the database, its transaction, store and request are one stand-in

interface Options {
  /** Opening throws, as blocked site data does. */
  throwOnOpen?: boolean;
  /** Opening fails with an error event, as some private windows do. */
  failOpen?: boolean;
  /** Writes past this many records fail with QuotaExceededError. */
  room?: number;
}

type Row = Record<string, unknown>;

class FakeRequest extends EventTarget {
  result: unknown;
  error: DOMException | null = null;
}

class FakeStore {
  readonly tx: FakeTransaction;
  readonly rows: Map<string, Row>;
  readonly keyPath: string;
  constructor(tx: FakeTransaction, rows: Map<string, Row>, keyPath: string) {
    this.tx = tx;
    this.rows = rows;
    this.keyPath = keyPath;
  }
  put(value: Row): FakeRequest {
    const copy = structuredClone(value);
    return this.tx.queue(() => {
      this.rows.set(String(copy[this.keyPath]), copy);
      const room = this.tx.db.options.room;
      if (room !== undefined && this.rows.size > room)
        throw new DOMException("full", "QuotaExceededError");
      return copy[this.keyPath];
    });
  }
  delete(key: string): FakeRequest {
    return this.tx.queue(() => {
      this.rows.delete(key);
      return undefined;
    });
  }
  clear(): FakeRequest {
    return this.tx.queue(() => {
      this.rows.clear();
      return undefined;
    });
  }
  getAll(): FakeRequest {
    return this.tx.queue(() => [...this.rows.values()].map((r) => structuredClone(r)));
  }
}

class FakeTransaction extends EventTarget {
  error: DOMException | null = null;
  readonly db: FakeDatabase;
  private readonly pending: [FakeRequest, () => unknown][] = [];
  private readonly staged: Map<string, Map<string, Row>>;
  private done = false;
  constructor(db: FakeDatabase) {
    super();
    this.db = db;
    // Changes apply to a copy, kept only if the transaction completes.
    this.staged = new Map([...db.stores].map(([n, s]) => [n, new Map(s.rows)]));
    setTimeout(() => this.step(), 0);
  }
  objectStore(name: string): FakeStore {
    const rows = this.staged.get(name);
    const keyPath = this.db.stores.get(name)?.keyPath;
    if (!rows || keyPath === undefined) throw new DOMException("no store", "NotFoundError");
    return new FakeStore(this, rows, keyPath);
  }
  queue(run: () => unknown): FakeRequest {
    if (this.done) throw new DOMException("finished", "TransactionInactiveError");
    const req = new FakeRequest();
    this.pending.push([req, run]);
    return req;
  }
  abort(): void {
    this.finish(new DOMException("aborted", "AbortError"));
  }
  private finish(error: DOMException | null): void {
    if (this.done) return;
    this.done = true;
    if (error) {
      this.error = error;
      this.dispatchEvent(new Event("error"));
      this.dispatchEvent(new Event("abort"));
      return;
    }
    for (const [name, rows] of this.staged) {
      const store = this.db.stores.get(name);
      if (store) store.rows = rows;
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
        req.dispatchEvent(new Event("success"));
      } catch (error) {
        req.error =
          error instanceof DOMException ? error : new DOMException(String(error), "UnknownError");
        req.dispatchEvent(new Event("error"));
        this.finish(req.error);
        return;
      }
    }
    setTimeout(() => this.step(), 0);
  }
}

class FakeDatabase {
  stores = new Map<string, { keyPath: string; rows: Map<string, Row> }>();
  version = 0;
  closed = false;
  onversionchange: (() => void) | null = null;
  readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  createObjectStore(name: string, opts: { keyPath: string }): void {
    this.stores.set(name, { keyPath: opts.keyPath, rows: new Map() });
  }
  transaction(name: string): FakeTransaction {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
    if (!this.stores.has(name)) throw new DOMException("no store", "NotFoundError");
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
      setTimeout(() => {
        if (options.failOpen === true) {
          req.error = new DOMException("no", "InvalidStateError");
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
        if (db.version < version) {
          const e = new Event("upgradeneeded");
          Object.defineProperty(e, "oldVersion", { value: db.version });
          db.version = version;
          req.dispatchEvent(e);
        }
        req.dispatchEvent(new Event("success"));
      }, 0);
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, databases };
}
