// Opening the reader's label store in IndexedDB, in this browser only, and reading what pages show
// (docs/FRONTEND.md "Your labels"). In the shell's group, not loaded on demand: a request for this
// code only from a browser that holds labels would tell the server that it does. It never holds
// up the page: the router mounts and the page asks its questions as on any visit, and labels are
// read afterwards, a slice at a time. Writing is db.ts, loaded when the reader asks for it.
import { HINT, showLabels } from "../labels";

const NAME = "rbitcoin-labels";
/**
 * The database's version. A change that reshapes what is stored raises it and migrates in
 * `upgrade`, from each older version in turn.
 */
export const VERSION = 2;
/** Every record: its BIP329 line, identity, label and place in the reader's order (`seq`). */
export const RECORDS = "records";
/** What pages show, one row per record with a label of a type a page can show: no raw lines. */
export const SHOWN = "shown";
/** The store's revision (`rev`, one more on every write) and the last place given (`seq`). */
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

/**
 * Runs each migration from the stored version up to VERSION. Version 1 was never released (it was
 * this feature's first draft), so a development browser's is started afresh, not moved.
 */
function upgrade(db: IDBDatabase, from: number): void {
  if (from === 1) db.deleteObjectStore(RECORDS);
  if (from < 2) {
    db.createObjectStore(RECORDS, { keyPath: "key" }).createIndex("seq", "seq");
    db.createObjectStore(SHOWN, { keyPath: "key" });
    const meta = db.createObjectStore(META);
    meta.put(0, "seq");
    meta.put(1, "rev");
  }
}

let opening: Promise<IDBDatabase> | undefined;
let outdated = false;

/**
 * Opens the store, at most OPEN_DEADLINE_MS. A failure is never kept: the next call tries again.
 * Another tab opening a newer version closes this one, which then asks for a reload.
 */
export function open(): Promise<IDBDatabase> {
  if (outdated) return Promise.reject(new LabelStoreError("outdated"));
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    let done = false;
    const fail = (e?: unknown) => {
      if (done) return;
      done = true;
      opening = undefined;
      reject(new LabelStoreError("unavailable", e));
    };
    // A store that never answers (a blocked upgrade, a stuck browser) is the same as none.
    const deadline = setTimeout(() => fail(new Error("no answer")), OPEN_DEADLINE_MS);
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined" || indexedDB === null) {
        clearTimeout(deadline);
        fail();
        return;
      }
      req = indexedDB.open(NAME, VERSION);
    } catch (e) {
      // Firefox's private windows once threw here; blocked site data throws a SecurityError.
      clearTimeout(deadline);
      fail(e);
      return;
    }
    req.addEventListener("upgradeneeded", (e) => upgrade(req.result, e.oldVersion));
    req.addEventListener("error", () => {
      clearTimeout(deadline);
      fail(req.error);
    });
    req.addEventListener("success", () => {
      clearTimeout(deadline);
      const db = req.result;
      db.addEventListener("versionchange", () => {
        db.close();
        opening = undefined;
        outdated = true;
      });
      if (done) {
        db.close();
        return;
      }
      done = true;
      resolve(db);
    });
  });
  return opening;
}

// What pages show, kept so one write changes it without reading everything again: each place's
// candidates by record, and which record wins there.
export const candidates = new Map<string, Map<string, ShownRow>>();
export const placeOf = new Map<string, string>();
export const shown = new Map<string, string>();

export const better = (a: ShownRow, b: ShownRow) => (a.plain === b.plain ? a.seq < b.seq : a.plain);

export function settle(at: string): void {
  let best: ShownRow | undefined;
  for (const row of candidates.get(at)?.values() ?? []) if (!best || better(row, best)) best = row;
  if (best) shown.set(at, best.label);
  else shown.delete(at);
}

export function add(row: ShownRow): void {
  placeOf.set(row.key, row.at);
  let set = candidates.get(row.at);
  if (!set) {
    set = new Map();
    candidates.set(row.at, set);
  }
  set.set(row.key, row);
}

const turn = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Reads every row pages show, BATCH at a time in one read transaction, the page given its turn
 * between batches, and shows them all at once at the end.
 */
async function readShown(db: IDBDatabase): Promise<ShownRow[]> {
  const rows: ShownRow[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SHOWN, "readonly");
    tx.addEventListener("abort", () => reject(wrap(tx.error)));
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
        else resolve();
      });
    };
    ask();
  });
  return rows;
}

const heard = new Set<() => void>();
/** Hears of another tab's change to the labels (db.ts drops what it read). */
export function onElsewhere(fn: () => void): void {
  heard.add(fn);
}

let reading: Promise<void> | undefined;
// Writes noted since a read began: such a read is older than what pages show, and is done again.
let writes = 0;
/** Notes a write made by db.ts, so a read begun before it is done again. */
export function wrote(): void {
  writes++;
}

/** Reads what pages show again, and shows it. */
export function refresh(): Promise<void> {
  reading ??= (async () => {
    let again = false;
    try {
      let rows: ShownRow[];
      let before: number;
      do {
        before = writes;
        // oxlint-disable-next-line no-await-in-loop -- read again only when a write overtook the read
        rows = await readShown(await open());
      } while (before !== writes);
      candidates.clear();
      placeOf.clear();
      shown.clear();
      // Built a batch at a time, as it was read, so no one task holds the page.
      for (let i = 0; i < rows.length; i += BATCH) {
        // oxlint-disable-next-line no-await-in-loop -- one batch after another, the page given a turn between
        if (i > 0) await turn();
        for (const row of rows.slice(i, i + BATCH)) add(row);
      }
      for (const at of candidates.keys()) settle(at);
      showLabels(shown);
      // A write while the rows were laid out may have been laid over: read once more.
      if (before !== writes) again = true;
    } finally {
      reading = undefined;
    }
    if (again) await refresh();
  })();
  return reading;
}

/**
 * Starts reading the labels this browser holds, if it holds any; returns at once. Without any it
 * costs one `localStorage` read. Called after the router has mounted, so the page's own requests
 * go out as on any visit; labels appear when they are read. Another tab's change arrives as a
 * `storage` event on the hint, and is read again.
 */
export function startLabels(): void {
  addEventListener("storage", (e) => {
    if (e.key !== HINT && e.key !== null) return;
    for (const fn of heard) fn();
    void refresh().catch(() => undefined);
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

/** Forgets the open database and what was read: for tests, which swap the database underneath. */
export function reset(): void {
  opening = undefined;
  outdated = false;
  candidates.clear();
  placeOf.clear();
  shown.clear();
  showLabels(shown);
}
