// Opening the reader's label store in IndexedDB, in this browser only, and reading what pages show
// (docs/FRONTEND.md "Your labels"). In the shell's group, not loaded on demand: a request for this
// code only from a browser that holds labels would tell the server that it does. It never holds
// up the page: the router mounts and the page asks its questions as on any visit, and labels are
// read afterwards, a slice at a time. Writing is db.ts, loaded when the reader asks for it.
import { HINT, indexKey, normalRef, recordKey, type Shown, showLabels } from "../labels";

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

export const FAILURE_WORDS: Record<Failure, string> = {
  unavailable:
    "This browser is not letting the site keep anything here (a private window, site data blocked, or the store not answering), so labels cannot be kept here.",
  outdated: "This site was updated in another tab. Reload this page to keep labels here.",
  full: "This browser has no room left for the site's data, so the labels were not saved.",
  failed: "The browser could not save the labels. Try again.",
  "too-many": "This browser keeps at most 250 000 labels.",
  "too-big": "This browser keeps at most 40 MB of labels.",
  stale: "Your labels changed since this was read, in this tab or another. Look again.",
  long: "That would make the record longer than a label file's line may be.",
};

/** Why the store could not do what it was asked, in words a reader can act on. */
export class LabelStoreError extends Error {
  readonly kind: Failure;
  constructor(kind: Failure, cause?: unknown) {
    super(FAILURE_WORDS[kind], { cause });
    this.kind = kind;
    this.name = "LabelStoreError";
  }
}

export function wrap(e: unknown): LabelStoreError {
  if (e instanceof LabelStoreError) return e;
  const name = e instanceof DOMException ? e.name : "";
  return new LabelStoreError(name === "QuotaExceededError" ? "full" : "failed", e);
}

const SHOWN_TYPES = new Set<string>(["tx", "addr", "pubkey", "input", "output"]);

/** The row pages show for a record, or null when they show none. */
export function shownRow(r: Stored, origin: string | undefined): ShownRow | null {
  if (r.label === undefined || r.label.trim() === "" || !SHOWN_TYPES.has(r.type)) return null;
  const norm = normalRef(r.type, r.ref);
  if (norm === null) return null;
  return {
    key: r.key,
    at: indexKey(r.type as Shown, norm),
    label: r.label,
    plain: origin === undefined,
    seq: r.seq,
  };
}

/** A record's origin, read from its key. */
export function originOf(key: string): string | undefined {
  try {
    const v: unknown = JSON.parse(key);
    return Array.isArray(v) && typeof v[2] === "string" ? v[2] : undefined;
  } catch {
    return undefined;
  }
}

/** Runs each migration from the stored version up to VERSION, inside the upgrade's transaction. */
function upgrade(db: IDBDatabase, tx: IDBTransaction | null, from: number): void {
  if (from < 1) db.createObjectStore(RECORDS, { keyPath: "key" });
  if (from < 2 && tx) {
    const records = tx.objectStore(RECORDS);
    records.createIndex("seq", "seq");
    const shown = db.createObjectStore(SHOWN, { keyPath: "key" });
    const meta = db.createObjectStore(META);
    // Version 1 joined type, reference and origin with line feeds, which two triples could
    // share: each record is keyed again, and what pages show is written beside it.
    let seq = 0;
    if (from === 1) {
      const req = records.openCursor();
      req.addEventListener("success", () => {
        const cursor = req.result;
        if (!cursor) {
          meta.put(seq, "seq");
          return;
        }
        const r = cursor.value as Stored;
        let origin: string | undefined;
        try {
          const v = JSON.parse(r.line) as { origin?: unknown };
          origin = typeof v.origin === "string" ? v.origin : undefined;
        } catch {
          origin = undefined;
        }
        const next = { ...r, key: recordKey(r.type, normalRef(r.type, r.ref) ?? r.ref, origin) };
        if (next.key !== r.key) {
          cursor.delete();
          records.put(next);
        }
        const row = shownRow(next, origin);
        if (row) shown.put(row);
        seq = Math.max(seq, r.seq);
        cursor.continue();
      });
    } else meta.put(0, "seq");
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
    req.addEventListener("upgradeneeded", (e) =>
      upgrade(req.result, req.transaction, e.oldVersion),
    );
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
const candidates = new Map<string, Map<string, ShownRow>>();
const placeOf = new Map<string, string>();
const shown = new Map<string, string>();

const better = (a: ShownRow, b: ShownRow) => (a.plain === b.plain ? a.seq < b.seq : a.plain);

function settle(at: string): void {
  let best: ShownRow | undefined;
  for (const row of candidates.get(at)?.values() ?? []) if (!best || better(row, best)) best = row;
  if (best) shown.set(at, best.label);
  else shown.delete(at);
}

function add(row: ShownRow): void {
  placeOf.set(row.key, row.at);
  let set = candidates.get(row.at);
  if (!set) {
    set = new Map();
    candidates.set(row.at, set);
  }
  set.set(row.key, row);
}

function drop(key: string): string | undefined {
  const at = placeOf.get(key);
  if (at === undefined) return undefined;
  placeOf.delete(key);
  const set = candidates.get(at);
  set?.delete(key);
  if (set?.size === 0) candidates.delete(at);
  return at;
}

/** Changes what pages show after a write: rows put, records gone, or everything cleared first. */
export function noteWrite(puts: readonly ShownRow[], gone: readonly string[], clear = false): void {
  writes++;
  const touched = new Set<string>();
  if (clear) {
    candidates.clear();
    placeOf.clear();
    shown.clear();
  }
  for (const k of gone) {
    const at = drop(k);
    if (at !== undefined) touched.add(at);
  }
  for (const row of puts) {
    const at = drop(row.key);
    if (at !== undefined) touched.add(at);
    add(row);
    touched.add(row.at);
  }
  for (const at of touched) settle(at);
  showLabels(shown);
}

/** The record a page's label at `at` comes from, if one does. */
export function shownFrom(at: string): string | undefined {
  let best: ShownRow | undefined;
  for (const row of candidates.get(at)?.values() ?? []) if (!best || better(row, best)) best = row;
  return best?.key;
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

/** Sets the hint to the store's revision after a write, or takes it away when nothing is kept. */
export function hint(rev: number, count: number): void {
  try {
    if (count === 0) localStorage.removeItem(HINT);
    else localStorage.setItem(HINT, String(rev));
  } catch {
    // Storage blocked: every page opens the database instead.
  }
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
