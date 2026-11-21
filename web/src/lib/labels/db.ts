// Changing the reader's labels, kept in IndexedDB in this browser only (docs/FRONTEND.md "Your
// labels"); opening the store and reading what pages show is store.ts. Loaded when the reader
// opens the editor or the manager. Each change is one transaction that also moves the store's
// revision, so a change planned against an older revision is refused rather than laid over a
// newer one. Every write tells the pages (`noteWrite`) and the reader's other tabs (the hint).
import { indexKey, normalRef, type Shown } from "../labels";
import {
  holdsMore,
  type LabelRecord,
  MAX_BYTES,
  MAX_LINE,
  MAX_RECORDS,
  mergeInto,
  recordKey,
  withLabel,
  writeFile,
} from "./bip329";
import {
  BATCH,
  hint,
  LabelStoreError,
  META,
  noteWrite,
  onElsewhere,
  open,
  originOf,
  RECORDS,
  SHOWN,
  type ShownRow,
  shownFrom,
  shownRow,
  type Stored,
  wrap,
} from "./store";

export { FAILURE_WORDS, LabelStoreError, reset as resetStore, type Stored, VERSION } from "./store";

/** Every record as last read or written here, in the reader's order, with the revision it is of. */
let cache: Map<string, Stored> | undefined;
let cacheRev = 0;
let cacheSeq = 0;
let cacheBytes = 0;

// Another tab changed the labels: what was read here is older than the store.
onElsewhere(() => {
  cache = undefined;
});

/** Reads every record, BATCH at a time in one read transaction, in the reader's order. */
function readAll(db: IDBDatabase): Promise<{ all: Map<string, Stored>; rev: number; seq: number }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECORDS, META], "readonly");
    tx.addEventListener("abort", () => reject(wrap(tx.error)));
    const all = new Map<string, Stored>();
    let rev = 0;
    let seq = 0;
    const meta = tx.objectStore(META);
    const r = meta.get("rev");
    r.addEventListener("success", () => {
      rev = Number(r.result ?? 0);
    });
    const s = meta.get("seq");
    s.addEventListener("success", () => {
      seq = Number(s.result ?? 0);
    });
    const bySeq = tx.objectStore(RECORDS).index("seq");
    const ask = (after?: number) => {
      const req = bySeq.getAll(
        after === undefined ? undefined : IDBKeyRange.lowerBound(after, true),
        BATCH,
      );
      req.addEventListener("success", () => {
        const got = req.result as Stored[];
        for (const x of got) all.set(x.key, x);
        const last = got.at(-1);
        if (got.length === BATCH && last) ask(last.seq);
      });
    };
    ask();
    tx.addEventListener("complete", () => resolve({ all, rev, seq }));
  });
}

/** Every record, in the reader's order: read once, then kept current by this tab's writes. */
export async function records(): Promise<ReadonlyMap<string, Stored>> {
  if (cache) return cache;
  const { all, rev, seq } = await readAll(await open());
  cache = all;
  cacheRev = rev;
  cacheSeq = seq;
  cacheBytes = 0;
  for (const r of all.values()) cacheBytes += r.line.length;
  return all;
}

/** The records last read or written, in the reader's order: none before the first read. */
export function snapshot(): Stored[] {
  return cache ? [...cache.values()] : [];
}

interface Ctx {
  records: IDBObjectStore;
  shown: IDBObjectStore;
  rev: number;
  seq: number;
  /** Ends the change, keeping nothing, for this reason. For use in a request's handler. */
  fail: (e: unknown) => void;
}

interface Change {
  puts: Stored[];
  gone: string[];
  clear: boolean;
  seq: number;
}

/**
 * One change, in one transaction: reads the revision, refuses when it is not `expect` (when
 * given), lets `run` do its work and call `done` with what it did, then writes the next revision
 * and counts what is kept. All of it or none: a refusal or a failure of any part keeps nothing.
 */
function transact(
  run: (c: Ctx, done: (change: Change) => void) => void,
  expect?: number,
): Promise<{ rev: number; count: number; change: Change }> {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction([RECORDS, SHOWN, META], "readwrite");
        } catch (e) {
          reject(wrap(e));
          return;
        }
        let failure: LabelStoreError | undefined;
        let result: { rev: number; count: number; change: Change } | undefined;
        const stop = (e: unknown) => {
          failure ??= wrap(e);
          try {
            tx.abort();
          } catch {
            // Already ending: its abort event carries the reason.
          }
        };
        // A request's error reaches the transaction first, before it aborts and names the reason
        // (QuotaExceededError among them): only the abort is answered.
        tx.addEventListener("abort", () => reject(failure ?? wrap(tx.error)));
        tx.addEventListener("complete", () => {
          if (result) resolve(result);
          else reject(failure ?? new LabelStoreError("failed"));
        });
        const recordStore = tx.objectStore(RECORDS);
        const shown = tx.objectStore(SHOWN);
        const meta = tx.objectStore(META);
        const revReq = meta.get("rev");
        const seqReq = meta.get("seq");
        seqReq.addEventListener("success", () => {
          const rev = Number(revReq.result ?? 0);
          if (expect !== undefined && rev !== expect) {
            stop(new LabelStoreError("stale"));
            return;
          }
          try {
            run(
              { records: recordStore, shown, rev, seq: Number(seqReq.result ?? 0), fail: stop },
              (change) => {
                meta.put(rev + 1, "rev");
                meta.put(change.seq, "seq");
                const count = recordStore.count();
                count.addEventListener("success", () => {
                  result = { rev: rev + 1, count: count.result, change };
                });
              },
            );
          } catch (e) {
            stop(e);
          }
        });
      }),
  );
}

/** Writes a record and what pages show for it; returns the record's request. */
function putBoth(c: Ctx, r: Stored): IDBRequest {
  const req = c.records.put(r);
  const row = shownRow(r, originOf(r.key));
  if (row) c.shown.put(row);
  else c.shown.delete(r.key);
  return req;
}

/** After a write: the pages, the other tabs, and what this tab read, if it was of the revision before. */
function settleWrite(before: number, out: { rev: number; count: number; change: Change }): void {
  const { change } = out;
  const rows: ShownRow[] = [];
  // A record put without a row (its label gone) leaves the pages too.
  const gone = [...change.gone];
  for (const r of change.puts) {
    const row = shownRow(r, originOf(r.key));
    if (row) rows.push(row);
    else gone.push(r.key);
  }
  noteWrite(rows, gone, change.clear);
  hint(out.rev, out.count);
  if (cache && cacheRev === before) {
    if (change.clear) {
      cache.clear();
      cacheBytes = 0;
    }
    for (const k of change.gone) {
      cacheBytes -= cache.get(k)?.line.length ?? 0;
      cache.delete(k);
    }
    for (const r of change.puts) {
      cacheBytes += r.line.length - (cache.get(r.key)?.line.length ?? 0);
      // A replaced record keeps its place: `set` on an existing key leaves the order as it was.
      cache.set(r.key, r);
    }
    cacheRev = out.rev;
    cacheSeq = change.seq;
  } else cache = undefined;
}

/**
 * Sets a label, or removes it for `null` or blank: the record a page shows for the reference, or
 * the record `key` names (the manager edits any). The record is read and written in one
 * transaction, so an edit never undoes another tab's. A record that holds more than its label (an
 * origin, `spendable`, a wallet's other fields) keeps the rest when its label is removed.
 */
export async function setLabel(
  type: string,
  ref: string,
  text: string | null,
  key?: string,
): Promise<void> {
  const label = text === null || text.trim() === "" ? null : text;
  const norm = normalRef(type, ref);
  if (key === undefined && norm === null) return;
  const target =
    key ??
    shownFrom(indexKey(type as Shown, norm ?? "")) ??
    recordKey(type, norm ?? ref, undefined);
  const before = cacheRev;
  const out = await transact((c, done) => {
    const got = c.records.get(target);
    got.addEventListener("success", () => {
      const existing = got.result as Stored | undefined;
      const next = withLabel(existing, type, ref, label);
      if (next === null) {
        done({ puts: [], gone: [], clear: false, seq: c.seq });
        return;
      }
      if (next.line.length > MAX_LINE) {
        c.fail(new LabelStoreError("long"));
        return;
      }
      if (existing && label === null && !holdsMore(next)) {
        c.records.delete(existing.key);
        c.shown.delete(existing.key);
        done({ puts: [], gone: [existing.key], clear: false, seq: c.seq });
        return;
      }
      if (existing) {
        const r = { ...next, seq: existing.seq };
        putBoth(c, r);
        done({ puts: [r], gone: [], clear: false, seq: c.seq });
        return;
      }
      const n = c.records.count();
      n.addEventListener("success", () => {
        if (n.result >= MAX_RECORDS) {
          c.fail(new LabelStoreError("too-many"));
          return;
        }
        const r = { ...next, seq: c.seq + 1 };
        putBoth(c, r);
        done({ puts: [r], gone: [], clear: false, seq: c.seq + 1 });
      });
    });
  });
  settleWrite(before, out);
}

/** What an import would do, against the revision it was planned on. */
export interface ImportPlan {
  added: Stored[];
  replaced: Stored[];
  /** Lines whose record would pass MAX_LINE with the reader's label carried into it: left out. */
  grown: number;
  rev: number;
  seq: number;
}

/**
 * Plans an import against what is kept: BIP329's rule for each record (`mergeInto`), and the
 * limits on how many records and how much text this browser keeps.
 */
export async function planImport(incoming: readonly LabelRecord[]): Promise<ImportPlan> {
  const all = await records();
  let seq = cacheSeq;
  let bytes = cacheBytes;
  let grown = 0;
  const added: Stored[] = [];
  const replaced: Stored[] = [];
  for (const r of incoming) {
    const old = all.get(r.key);
    if (old) {
      const merged = mergeInto(old, r);
      if (merged === null) {
        grown++;
        continue;
      }
      bytes += merged.line.length - old.line.length;
      replaced.push({ ...merged, seq: old.seq });
    } else {
      seq++;
      bytes += r.line.length;
      added.push({ ...r, seq });
    }
  }
  if (all.size + added.length > MAX_RECORDS) throw new LabelStoreError("too-many");
  if (bytes > MAX_BYTES) throw new LabelStoreError("too-big");
  return { added, replaced, grown, rev: cacheRev, seq };
}

/**
 * Writes a planned import, all of it or none, a slice at a time so the page draws between them.
 * Refused ("stale") when the labels changed since the plan was made: plan again.
 */
export async function runImport(
  plan: ImportPlan,
  progress?: (done: number, total: number) => void,
): Promise<void> {
  const puts = [...plan.replaced, ...plan.added];
  const before = cacheRev;
  try {
    const out = await transact((c, done) => {
      let i = 0;
      // Each slice's last put answers in a task of its own, where the next slice is queued: the
      // transaction stays open and the page draws between them.
      const next = () => {
        const end = Math.min(puts.length, i + 1000);
        let last: IDBRequest | undefined;
        for (; i < end; i++) last = putBoth(c, puts[i] as Stored);
        progress?.(i, puts.length);
        if (last && i < puts.length) last.addEventListener("success", next);
        else done({ puts, gone: [], clear: false, seq: Math.max(c.seq, plan.seq) });
      };
      next();
    }, plan.rev);
    settleWrite(before, out);
  } catch (e) {
    // What was read here is not the store's any more: read it again before the next plan.
    if (e instanceof LabelStoreError && e.kind === "stale") cache = undefined;
    throw e;
  }
}

/** Deletes records by key. */
export async function remove(keys: readonly string[]): Promise<void> {
  const before = cacheRev;
  const out = await transact((c, done) => {
    for (const k of keys) {
      c.records.delete(k);
      c.shown.delete(k);
    }
    done({ puts: [], gone: [...keys], clear: false, seq: c.seq });
  });
  settleWrite(before, out);
}

/** Deletes every record. */
export async function removeAll(): Promise<void> {
  const before = cacheRev;
  const out = await transact((c, done) => {
    c.records.clear();
    c.shown.clear();
    done({ puts: [], gone: [], clear: true, seq: c.seq });
  });
  settleWrite(before, out);
}

/** The BIP329 file of every record, in the reader's order. */
export async function exportFile(): Promise<{ text: string; count: number }> {
  const all = await records();
  return { text: writeFile(all.values()), count: all.size };
}

/** Forgets what was read and the open store: for tests, which swap the database underneath. */
export function reset(): void {
  cache = undefined;
  cacheRev = 0;
  cacheSeq = 0;
  cacheBytes = 0;
}
