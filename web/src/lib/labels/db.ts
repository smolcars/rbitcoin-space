// Changing the reader's labels, kept in IndexedDB in this browser only (docs/FRONTEND.md "Your
// labels"); reading them is store.ts. Loaded when the reader opens the editor or the manager.
// Every write tells the pages (`showLabels`) and the reader's other tabs (the hint).
import { normalRef, showLabels } from "../labels";
import { holdsMore, type LabelRecord, mergeInto, recordKey, withLabel, writeFile } from "./bip329";
import {
  buildIndex,
  cached,
  hint,
  LabelStoreError,
  MAX_RECORDS,
  open,
  records,
  STORE,
  type Stored,
  wrap,
} from "./store";

export {
  buildIndex,
  FAILURE_WORDS,
  LabelStoreError,
  records,
  refresh,
  reset,
  snapshot,
  type Stored,
  VERSION,
} from "./store";

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
  const all = cached();
  if (clear) all.clear();
  for (const k of deletes) all.delete(k);
  for (const r of puts) {
    // A replaced record keeps its place: `set` on an existing key leaves the order as it was.
    all.set(r.key, r);
  }
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
