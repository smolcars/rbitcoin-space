// Where the reader's labels are kept: IndexedDB, in this browser only (docs/FRONTEND.md "Your
// labels"). Loaded only once a reader has labels or opens the editor or the manager. Every write
// tells the pages (`showLabels`) and the reader's other tabs (the hint in `localStorage`).
import { HINT, indexKey, normalRef, type Shown, showLabels } from "../labels";
import {
  holdsMore,
  type LabelRecord,
  MAX_RECORDS,
  mergeInto,
  recordKey,
  withLabel,
  writeFile,
} from "./bip329";

const NAME = "rbitcoin-labels";
/**
 * The database's version. A later change that reshapes what is stored raises it and migrates in
 * `upgrade`, from each older version in turn.
 */
export const VERSION = 1;
const STORE = "records";

/** A record as stored: its place in the reader's order, so an export keeps the order imported. */
export interface Stored extends LabelRecord {
  seq: number;
}

export type Failure = "unavailable" | "full" | "failed" | "too-many";

/** Why the store could not do what it was asked, in words a reader can act on. */
export class LabelStoreError extends Error {
  readonly kind: Failure;
  constructor(kind: Failure, cause?: unknown) {
    super(FAILURE_WORDS[kind], { cause });
    this.kind = kind;
    this.name = "LabelStoreError";
  }
}

export const FAILURE_WORDS: Record<Failure, string> = {
  unavailable:
    "This browser is not letting the site keep anything (a private window, or site data blocked), so labels cannot be kept here.",
  full: "This browser has no room left for the site's data, so the labels were not saved.",
  failed: "The browser could not save the labels. Try again.",
  "too-many": `This browser keeps at most ${MAX_RECORDS.toLocaleString("en")} labels.`,
};

const SHOWN = new Set<string>(["tx", "addr", "pubkey", "input", "output"]);

/**
 * What pages show: each shown type's reference and its label. Where two wallets labelled the same
 * thing (two origins), the label without an origin wins, else the first in the reader's order.
 */
export function buildIndex(list: Iterable<LabelRecord>): Map<string, string> {
  const map = new Map<string, string>();
  const plain = new Set<string>();
  for (const r of list) {
    if (r.label === undefined || r.label.trim() === "" || !SHOWN.has(r.type)) continue;
    const [, norm = "", origin = ""] = r.key.split("\n");
    const k = indexKey(r.type as Shown, norm);
    if (plain.has(k) || (map.has(k) && origin !== "")) continue;
    map.set(k, r.label);
    if (origin === "") plain.add(k);
  }
  return map;
}

function wrap(e: unknown): LabelStoreError {
  if (e instanceof LabelStoreError) return e;
  const name = e instanceof DOMException ? e.name : "";
  return new LabelStoreError(name === "QuotaExceededError" ? "full" : "failed", e);
}

/** Runs each migration from the stored version up to VERSION. */
function upgrade(db: IDBDatabase, from: number): void {
  if (from < 1) db.createObjectStore(STORE, { keyPath: "key" });
}

let opening: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const fail = (e?: unknown) => {
      opening = undefined;
      reject(new LabelStoreError("unavailable", e));
    };
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined") {
        fail();
        return;
      }
      req = indexedDB.open(NAME, VERSION);
    } catch (e) {
      // Firefox's private windows once threw here; blocked site data throws a SecurityError.
      fail(e);
      return;
    }
    req.addEventListener("upgradeneeded", (e) => upgrade(req.result, e.oldVersion));
    req.addEventListener("error", () => fail(req.error));
    req.addEventListener("success", () => {
      const db = req.result;
      // Another tab opening a newer version: step aside so its migration can run.
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    });
  });
  return opening;
}

let cache: Map<string, Stored> | undefined;

function readAll(db: IDBDatabase): Promise<Stored[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.addEventListener("success", () => resolve(req.result as Stored[]));
    req.addEventListener("error", () => reject(wrap(req.error)));
  });
}

/** Every record, in the reader's order, read afresh from the database. */
async function load(): Promise<Map<string, Stored>> {
  const all = await readAll(await open());
  all.sort((a, b) => a.seq - b.seq);
  cache = new Map(all.map((r) => [r.key, r]));
  return cache;
}

/** The records last read or written, in the reader's order: none before the first read. */
export function snapshot(): Stored[] {
  return cache ? [...cache.values()] : [];
}

/** Every record, in the reader's order. */
export async function records(): Promise<ReadonlyMap<string, Stored>> {
  return cache ?? (await load());
}

function hint(count: number): void {
  try {
    if (count === 0) localStorage.removeItem(HINT);
    // A new value each time, so the reader's other tabs hear a `storage` event and read again.
    else localStorage.setItem(HINT, String(Date.now()));
  } catch {
    // Storage blocked: every page opens the database instead (lib/labels.ts).
  }
}

/** Reads the database again and shows what it holds on every page. */
export async function refresh(): Promise<void> {
  const all = await load();
  showLabels(buildIndex(all.values()));
  // A reader whose hint went missing (site data partly cleared) gets it back.
  if (all.size > 0) {
    try {
      if (localStorage.getItem(HINT) === null) hint(all.size);
    } catch {
      // As in `hint`.
    }
  }
}

/** Puts and deletes in one transaction, a slice of puts at a time so a big import never holds the page. */
function write(
  db: IDBDatabase,
  puts: readonly Stored[],
  deletes: readonly string[],
  clear = false,
  progress?: (done: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch (e) {
      reject(wrap(e));
      return;
    }
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(wrap(tx.error)));
    tx.addEventListener("abort", () => reject(wrap(tx.error)));
    const store = tx.objectStore(STORE);
    if (clear) store.clear();
    for (const k of deletes) store.delete(k);
    let i = 0;
    // Each slice's last put answers in a task of its own, where the next slice is queued: the
    // transaction stays open and the page draws between them.
    const next = () => {
      const end = Math.min(puts.length, i + 1000);
      let last: IDBRequest | undefined;
      for (; i < end; i++) last = store.put(puts[i]);
      progress?.(i, puts.length);
      if (last && i < puts.length) last.addEventListener("success", next);
    };
    try {
      next();
    } catch (e) {
      tx.abort();
      reject(wrap(e));
    }
  });
}

/** Applies a change to the database, then to the cache, the pages and the other tabs. */
async function commit(
  puts: Stored[],
  deletes: string[],
  clear = false,
  progress?: (done: number, total: number) => void,
): Promise<void> {
  const db = await open();
  await write(db, puts, deletes, clear, progress);
  const all = cache ?? new Map<string, Stored>();
  if (clear) all.clear();
  for (const k of deletes) all.delete(k);
  for (const r of puts) {
    // A replaced record keeps its place: `set` on an existing key leaves the order as it was.
    all.set(r.key, r);
  }
  cache = all;
  showLabels(buildIndex(all.values()));
  hint(all.size);
}

const nextSeq = (all: ReadonlyMap<string, Stored>) => {
  let max = 0;
  for (const r of all.values()) if (r.seq > max) max = r.seq;
  return max + 1;
};

/** The record a page's label belongs to: the one without an origin, else the first. */
export function primary(
  all: ReadonlyMap<string, Stored>,
  type: string,
  ref: string,
): Stored | undefined {
  const norm = normalRef(type, ref);
  if (norm === null) return undefined;
  const plain = all.get(recordKey(type, norm, undefined));
  if (plain?.label !== undefined) return plain;
  const prefix = `${type}\n${norm}\n`;
  for (const [k, r] of all) if (k.startsWith(prefix) && r.label !== undefined) return r;
  return plain;
}

/**
 * Sets a page's label, or removes it for `null` or blank. A record that holds more than its label
 * (an origin, `spendable`, a wallet's other fields) keeps the rest when its label is removed.
 */
export async function setLabel(
  type: string,
  ref: string,
  text: string | null,
  /** The record to change, when it is not the one a page shows (the manager edits any). */
  key?: string,
): Promise<void> {
  const all = await records();
  const label = text === null || text.trim() === "" ? null : text;
  const existing = key === undefined ? primary(all, type, ref) : all.get(key);
  const next = withLabel(existing, type, ref, label);
  if (next === null) return;
  if (existing && label === null && !holdsMore(next)) {
    await commit([], [existing.key]);
    return;
  }
  if (!existing && all.size >= MAX_RECORDS) throw new LabelStoreError("too-many");
  await commit([{ ...next, seq: existing?.seq ?? nextSeq(all) }], []);
}

/** What an import would do: records new to this browser, and records it would replace. */
export interface ImportPlan {
  added: Stored[];
  replaced: Stored[];
}

/** Plans an import against what is kept: BIP329's rule for each record (`mergeInto`). */
export async function planImport(incoming: readonly LabelRecord[]): Promise<ImportPlan> {
  const all = await records();
  let seq = nextSeq(all);
  const added: Stored[] = [];
  const replaced: Stored[] = [];
  for (const r of incoming) {
    const old = all.get(r.key);
    if (old) replaced.push({ ...mergeInto(old, r), seq: old.seq });
    else added.push({ ...r, seq: seq++ });
  }
  if (all.size + added.length > MAX_RECORDS) throw new LabelStoreError("too-many");
  return { added, replaced };
}

/** Writes a planned import, all of it or none. */
export async function runImport(
  plan: ImportPlan,
  progress?: (done: number, total: number) => void,
): Promise<void> {
  await commit([...plan.replaced, ...plan.added], [], false, progress);
}

/** Deletes records by key. */
export async function remove(keys: readonly string[]): Promise<void> {
  await records();
  await commit([], [...keys]);
}

/** Deletes every record. */
export async function removeAll(): Promise<void> {
  await records();
  await commit([], [], true);
}

/** The BIP329 file of every record, in the reader's order. */
export async function exportFile(): Promise<{ text: string; count: number }> {
  const all = await records();
  return { text: writeFile(all.values()), count: all.size };
}

/** Forgets the open database and the cache: for tests, which swap the database underneath. */
export function reset(): void {
  cache = undefined;
  opening = undefined;
}
