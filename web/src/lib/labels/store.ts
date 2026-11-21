// Opening the reader's label store in IndexedDB, in this browser only, and reading what pages show
// (docs/FRONTEND.md "Your labels"). In the shell's group, not loaded on demand: a request for this
// code only from a browser that holds labels would tell the server that it does. It never holds
// up the page: it starts after the router has mounted, and reads a slice at a time.
//
// The database is the only truth. Nothing read from it is ever changed in memory: after any write,
// this tab's or another's, what pages show is thrown away and read again, and a read that a write
// overlapped is discarded and done again. Writing is db.ts, loaded when the reader asks for it.
import { HINT, showLabels } from "../labels";

const NAME = "rbitcoin-labels";
/**
 * The database's version. A change that reshapes what is stored raises it and migrates in
 * `upgrade`, from each older version in turn.
 */
export const VERSION = 3;
/** Every record: its BIP329 line, identity, label and place in the reader's order (`seq`). */
export const RECORDS = "records";
/** What pages show, one row per record with a label of a type a page can show: no raw lines. */
export const SHOWN = "shown";
/** The store's revision (`rev`), the last place given (`seq`) and the text kept (`bytes`). */
export const META = "meta";
/** The longest a page waits for the database to open before saying labels cannot be kept. */
const OPEN_DEADLINE_MS = 4000;
/** Rows read in one request, between which the page has its turn. */
export const BATCH = 2000;

/** A record as stored. `key` is `recordKey`, `seq` its place in the reader's order. */
export interface Stored {
  key: string;
  type: string;
  ref: string;
  label?: string;
  line: string;
  seq: number;
}

/** A page's view of a record: where it shows, its label, and how it ranks against others there. */
export interface ShownRow {
  key: string;
  /** `indexKey` of the thing it labels. */
  at: string;
  label: string;
  /** No origin: such a label wins over one a wallet's origin names. */
  plain: boolean;
  seq: number;
}

export type Failure =
  | "unavailable"
  | "outdated"
  | "full"
  | "failed"
  | "too-many"
  | "too-big"
  | "stale"
  | "long";

/** Why the store could not do what it was asked; db.ts has the words a reader is shown. */
export class LabelStoreError extends Error {
  readonly kind: Failure;
  constructor(kind: Failure, cause?: unknown) {
    super(kind, { cause });
    this.kind = kind;
    this.name = "LabelStoreError";
  }
}

export function wrap(e: unknown): LabelStoreError {
  if (e instanceof LabelStoreError) return e;
  const name = e instanceof DOMException ? e.name : "";
  return new LabelStoreError(name === "QuotaExceededError" ? "full" : "failed", e);
}

/** The label at a place that wins: one without an origin, else the first in the reader's order. */
export const better = (a: ShownRow, b: ShownRow): boolean =>
  a.plain === b.plain ? a.seq < b.seq : a.plain;

/**
 * Runs each migration from the stored version up to VERSION. Versions 1 and 2 were never released
 * (this feature's drafts), so a development browser's store is started afresh, not moved.
 */
function upgrade(db: IDBDatabase, from: number): void {
  if (from >= 3) return;
  // oxlint-disable-next-line unicorn/no-useless-spread -- a copy: deleting a store changes the live list being walked
  for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
  db.createObjectStore(RECORDS, { keyPath: "key" }).createIndex("seq", "seq");
  db.createObjectStore(SHOWN, { keyPath: "key" }).createIndex("at", "at");
  const meta = db.createObjectStore(META);
  meta.put(0, "seq");
  meta.put(1, "rev");
  meta.put(0, "bytes");
}

let conn: Promise<IDBDatabase> | undefined;
let outdated = false;

/** One attempt to open the store, at most OPEN_DEADLINE_MS. */
function connect(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      // Reading `indexedDB` itself throws where site data is blocked.
      if (typeof indexedDB === "undefined" || indexedDB === null) {
        reject(new LabelStoreError("unavailable"));
        return;
      }
      req = indexedDB.open(NAME, VERSION);
    } catch (e) {
      // Firefox's private windows once threw here; blocked site data throws a SecurityError.
      reject(new LabelStoreError("unavailable", e));
      return;
    }
    let late = false;
    // A store that never answers (a blocked upgrade, a stuck browser) is the same as none.
    const deadline = setTimeout(() => {
      late = true;
      reject(new LabelStoreError("unavailable", new Error("no answer")));
    }, OPEN_DEADLINE_MS);
    req.addEventListener("upgradeneeded", (e) => upgrade(req.result, e.oldVersion));
    req.addEventListener("error", () => {
      clearTimeout(deadline);
      // A newer version than this page knows: another tab runs a newer build of the site.
      const newer = req.error?.name === "VersionError";
      reject(new LabelStoreError(newer ? "outdated" : "unavailable", req.error));
    });
    req.addEventListener("success", () => {
      clearTimeout(deadline);
      const db = req.result;
      // It answered after this attempt was given up: the next attempt opens it afresh.
      if (late) {
        db.close();
        return;
      }
      db.addEventListener("versionchange", () => {
        db.close();
        conn = undefined;
        outdated = true;
      });
      resolve(db);
    });
  });
}

/**
 * The open store. A failed attempt is never kept: the next call tries again. Another tab opening
 * a newer version closes this one, which from then on asks for a reload.
 */
export function open(): Promise<IDBDatabase> {
  if (outdated) return Promise.reject(new LabelStoreError("outdated"));
  if (!conn) {
    const attempt = connect();
    conn = attempt;
    attempt.catch(() => {
      if (conn === attempt) conn = undefined;
    });
  }
  return conn;
}

const turn = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** Every row pages show, BATCH at a time in one read transaction, the page given its turn between. */
function readShown(db: IDBDatabase): Promise<ShownRow[]> {
  return new Promise((resolve, reject) => {
    const rows: ShownRow[] = [];
    const tx = db.transaction(SHOWN, "readonly");
    tx.addEventListener("abort", () => reject(wrap(tx.error)));
    tx.addEventListener("complete", () => resolve(rows));
    const store = tx.objectStore(SHOWN);
    const ask = (after?: string) => {
      const req = store.getAll(
        after === undefined ? undefined : IDBKeyRange.lowerBound(after, true),
        BATCH,
      );
      req.addEventListener("success", () => {
        const got = req.result as ShownRow[];
        for (const r of got) rows.push(r);
        const last = got.at(-1);
        if (got.length === BATCH && last) ask(last.key);
      });
    };
    ask();
  });
}

/** What pages show, from the rows read: each place's winning label, built a batch at a time. */
async function build(rows: readonly ShownRow[]): Promise<Map<string, string>> {
  const best = new Map<string, ShownRow>();
  for (let i = 0; i < rows.length; i += BATCH) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after another, the page given a turn between
    if (i > 0) await turn();
    for (const row of rows.slice(i, i + BATCH)) {
      const held = best.get(row.at);
      if (!held || better(row, held)) best.set(row.at, row);
    }
  }
  const view = new Map<string, string>();
  for (const [at, row] of best) view.set(at, row.label);
  return view;
}

// One more each time the store may have changed: a read begun before it is out of date.
let changes = 0;
let reading: Promise<void> | undefined;

/**
 * Reads what pages show and shows it. A read that a change overlapped, this tab's or another's,
 * is thrown away and done again, so what is shown is always one whole read of the store.
 */
export function refresh(): Promise<void> {
  reading ??= (async () => {
    try {
      for (;;) {
        const before = changes;
        // oxlint-disable-next-line no-await-in-loop -- read again only when a change overlapped the read
        const view = await build(await readShown(await open()));
        if (before === changes) {
          showLabels(view);
          return;
        }
      }
    } finally {
      reading = undefined;
    }
  })();
  return reading;
}

/** The store may have changed (a write here, or another tab's): read again. */
export function changed(): Promise<void> {
  changes++;
  return refresh();
}

/**
 * Starts reading the labels this browser holds, if it holds any; returns at once. Without any it
 * costs one `localStorage` read. Called once the router has mounted, so nothing the page asks
 * waits for it; labels appear when they are read. Another tab's change arrives as a `storage`
 * event on the hint, and is read again.
 */
export function startLabels(): void {
  addEventListener("storage", (e) => {
    if (e.key === HINT || e.key === null) void changed().catch(() => undefined);
  });
  let held = true;
  try {
    held = localStorage.getItem(HINT) !== null;
  } catch {
    // Storage blocked: the database may still work, so ask it.
  }
  // A stale hint, a missing or refusing store: pages show no labels, as before.
  if (held) void refresh().catch(() => undefined);
}

/** Forgets the open database and what was shown: for tests, which swap the database underneath. */
export function reset(): void {
  conn = undefined;
  outdated = false;
  changes++;
  showLabels(new Map());
}
