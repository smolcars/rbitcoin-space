// Changing the reader's labels, kept in IndexedDB in this browser only (docs/FRONTEND.md "Your
// labels"); opening the store and reading what pages show is store.ts. Loaded when the reader
// opens the editor or the manager.
//
// Every change is one transaction that decides from what the store holds at that moment, inside
// that transaction, and moves the store's revision. Nothing is kept in memory between calls: the
// manager reads the store whole each time it shows it, and an import's preview is only a preview,
// computed again inside the write and not written if the store changed since.
import { HINT, indexKey, normalRef, type Shown } from "../labels";
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
  better,
  refresh,
  type Failure,
  LabelStoreError,
  META,
  open,
  RECORDS,
  SHOWN,
  type ShownRow,
  type Stored,
  wrap,
} from "./store";

export { LabelStoreError, reset as resetStore, type Stored, VERSION } from "./store";

/** What a reader is told when the store could not do what they asked. */
export const FAILURE_WORDS: Record<Failure, string> = {
  unavailable:
    "This browser is not letting the site keep anything here (a private window, site data blocked, or the store not answering), so labels cannot be kept here.",
  outdated: "This site was updated in another tab. Reload this page to keep labels here.",
  full: "This browser has no room left for the site's data, so the labels were not saved.",
  failed: "The browser could not save the labels. Try again.",
  "too-many": "This browser keeps at most 50 000 labels.",
  "too-big": "This browser keeps at most 16 000 000 characters of labels.",
  stale: "Your labels changed since this was read, in this tab or another. Look again.",
  long: "That would make the record longer than a label file's line may be.",
};

/** An error in words a reader can act on: the store's own, or `fallback` for anything else. */
export function failureWords(e: unknown, fallback: string): string {
  return e instanceof LabelStoreError ? FAILURE_WORDS[e.kind] : fallback;
}

const SHOWN_TYPES = new Set<string>(["tx", "addr", "pubkey", "input", "output"]);

/** A record's origin, read from its key. */
function originOf(key: string): string | undefined {
  try {
    const v: unknown = JSON.parse(key);
    return Array.isArray(v) && typeof v[2] === "string" ? v[2] : undefined;
  } catch {
    return undefined;
  }
}

/** The row pages show for a record, or null when they show none. */
export function shownRow(r: Stored): ShownRow | null {
  if (r.label === undefined || r.label.trim() === "" || !SHOWN_TYPES.has(r.type)) return null;
  const norm = normalRef(r.type, r.ref);
  if (norm === null) return null;
  return {
    key: r.key,
    at: indexKey(r.type as Shown, norm),
    label: r.label,
    plain: originOf(r.key) === undefined,
    seq: r.seq,
  };
}

/** The store's own figures, read in the same transaction as what is read beside them. */
interface Meta {
  rev: number;
  seq: number;
  bytes: number;
}

function readMeta(meta: IDBObjectStore, then: (m: Meta) => void): void {
  const rev = meta.get("rev");
  const seq = meta.get("seq");
  const bytes = meta.get("bytes");
  bytes.addEventListener("success", () =>
    then({
      rev: Number(rev.result ?? 0),
      seq: Number(seq.result ?? 0),
      bytes: Number(bytes.result ?? 0),
    }),
  );
}

/** Every record, in the reader's order, BATCH at a time from `records` in a transaction that is open. */
function readRecords(records: IDBObjectStore, then: (all: Stored[]) => void): void {
  const all: Stored[] = [];
  const bySeq = records.index("seq");
  const ask = (after?: number) => {
    const req = bySeq.getAll(
      after === undefined ? undefined : IDBKeyRange.lowerBound(after, true),
      BATCH,
    );
    req.addEventListener("success", () => {
      const got = req.result as Stored[];
      for (const r of got) all.push(r);
      const last = got.at(-1);
      if (got.length === BATCH && last) ask(last.seq);
      else then(all);
    });
  };
  ask();
}

/** Every record, in the reader's order, and the revision they are of, read in one transaction. */
export async function readAll(): Promise<{ records: Stored[] } & Meta> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECORDS, META], "readonly");
    tx.addEventListener("abort", () => reject(wrap(tx.error)));
    readMeta(tx.objectStore(META), (meta) => {
      readRecords(tx.objectStore(RECORDS), (records) => resolve({ records, ...meta }));
    });
  });
}

interface Ctx extends Meta {
  records: IDBObjectStore;
  shown: IDBObjectStore;
  /** Ends the change, keeping nothing, for this reason. */
  fail: (e: unknown) => void;
}

/** What a change did to the store's figures: the last place given and the text now kept. */
interface Done {
  seq: number;
  bytes: number;
}

/**
 * One change, in one transaction: reads the store's figures, lets `run` decide and do its work
 * from what the store holds now, then writes the next revision and counts what is kept. All of it
 * or none: a refusal or a failure of any part keeps nothing. Afterwards the pages and the reader's
 * other tabs read the store again.
 */
async function transact(
  run: (c: Ctx, done: (d: Done) => void) => void,
): Promise<{ shown: boolean }> {
  const db = await open();
  const out = await new Promise<{ rev: number; count: number }>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([RECORDS, SHOWN, META], "readwrite");
    } catch (e) {
      reject(wrap(e));
      return;
    }
    let failure: LabelStoreError | undefined;
    let result: { rev: number; count: number } | undefined;
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
    const records = tx.objectStore(RECORDS);
    const shown = tx.objectStore(SHOWN);
    const meta = tx.objectStore(META);
    readMeta(meta, (m) => {
      try {
        run({ ...m, records, shown, fail: stop }, (d) => {
          meta.put(m.rev + 1, "rev");
          meta.put(d.seq, "seq");
          meta.put(d.bytes, "bytes");
          const count = records.count();
          count.addEventListener("success", () => {
            result = { rev: m.rev + 1, count: count.result };
          });
        });
      } catch (e) {
        stop(e);
      }
    });
  });
  try {
    // The revision, new on every write, so the reader's other tabs always hear a `storage` event.
    // Never removed once set, even when nothing is left: a removal landing late (one tab's
    // delete-all finishing after another tab's new label) would hide that label from new pages.
    // An empty store just reads as empty.
    localStorage.setItem(HINT, String(out.rev));
  } catch {
    // Storage blocked: every page opens the database instead.
  }
  // One read after this write, which the change waits for, and nothing more: what other tabs do
  // meanwhile is read in the background (`changed` in store.ts). Whether it could be shown is
  // said, so a reader is never told a label shows when it does not.
  try {
    await refresh();
    return { shown: true };
  } catch {
    return { shown: false };
  }
}

/** Writes a record and what pages show for it; returns the record's request. */
function putBoth(c: Ctx, r: Stored): IDBRequest {
  const req = c.records.put(r);
  const row = shownRow(r);
  if (row) c.shown.put(row);
  else c.shown.delete(r.key);
  return req;
}

/**
 * Sets a label, or removes it for `null` or blank: the record a page shows for the reference, or
 * the record `key` names (the manager edits any). The record is found, read and written in one
 * transaction, so an edit never undoes another tab's. A record that holds more than its label (an
 * origin, `spendable`, a wallet's other fields) keeps the rest when its label is removed.
 */
export async function setLabel(
  type: string,
  ref: string,
  text: string | null,
  key?: string,
): Promise<{ shown: boolean }> {
  const label = text === null || text.trim() === "" ? null : text;
  const norm = normalRef(type, ref);
  if (key === undefined && norm === null) return { shown: true };
  return transact((c, done) => {
    const write = (target: string) => {
      const got = c.records.get(target);
      got.addEventListener("success", () => {
        const existing = got.result as Stored | undefined;
        const next = withLabel(existing, type, ref, label);
        if (next === null) {
          done({ seq: c.seq, bytes: c.bytes });
          return;
        }
        if (existing && label === null && !holdsMore(next)) {
          c.records.delete(existing.key);
          c.shown.delete(existing.key);
          done({ seq: c.seq, bytes: c.bytes - existing.line.length });
          return;
        }
        if (next.line.length > MAX_LINE) {
          c.fail(new LabelStoreError("long"));
          return;
        }
        const bytes = c.bytes + next.line.length - (existing?.line.length ?? 0);
        if (bytes > MAX_BYTES) {
          c.fail(new LabelStoreError("too-big"));
          return;
        }
        if (existing) {
          putBoth(c, { ...next, seq: existing.seq });
          done({ seq: c.seq, bytes });
          return;
        }
        const n = c.records.count();
        n.addEventListener("success", () => {
          if (n.result >= MAX_RECORDS) {
            c.fail(new LabelStoreError("too-many"));
            return;
          }
          putBoth(c, { ...next, seq: c.seq + 1 });
          done({ seq: c.seq + 1, bytes });
        });
      });
    };
    if (key !== undefined || !SHOWN_TYPES.has(type)) {
      write(key ?? recordKey(type, norm ?? ref, undefined));
      return;
    }
    // The record whose label a page shows for this thing, as pages choose it.
    const at = c.shown.index("at").getAll(indexKey(type as Shown, norm ?? ""));
    at.addEventListener("success", () => {
      let best: ShownRow | undefined;
      for (const row of at.result as ShownRow[]) if (!best || better(row, best)) best = row;
      write(best?.key ?? recordKey(type, norm ?? ref, undefined));
    });
  });
}

/**
 * What an import would do, and the revision of the store it was worked out against: counts only.
 * The records it would write are worked out again inside the write, never kept from a preview.
 */
export interface ImportPlan {
  added: number;
  replaced: number;
  /** Lines whose record would pass MAX_LINE with the reader's label carried into it: left out. */
  grown: number;
  rev: number;
}

/** The records an import would write, and the store's figures after it. */
interface Work {
  puts: Stored[];
  added: number;
  replaced: number;
  grown: number;
  seq: number;
  bytes: number;
}

/** Records worked through between two turns of the page, at most. */
const PLAN_SLICE = 2000;
/**
 * And the most time one slice may take, in milliseconds: a slice of long records (a wallet's
 * fields near the line limit) stops early, well inside a frame, and goes on at the next turn.
 */
const PLAN_SLICE_MS = 8;

/**
 * Works out an import against what the store holds, a slice at a time: BIP329's rule for each
 * record (`mergeInto`), then the limits on how many records and how much text this browser keeps.
 * `step` does one slice and says whether more are left; `result` checks the limits.
 */
function planner(incoming: readonly LabelRecord[], held: readonly Stored[], meta: Meta) {
  let byKey: Map<string, Stored> | undefined;
  let i = 0;
  const work: Work = {
    puts: [],
    added: 0,
    replaced: 0,
    grown: 0,
    seq: meta.seq,
    bytes: meta.bytes,
  };
  const step = (): boolean => {
    if (!byKey) {
      byKey = new Map(held.map((r) => [r.key, r]));
      return true;
    }
    const end = Math.min(incoming.length, i + PLAN_SLICE);
    const until = performance.now() + PLAN_SLICE_MS;
    for (; i < end && performance.now() < until; i++) {
      const r = incoming[i] as LabelRecord;
      const old = byKey.get(r.key);
      if (old) {
        const merged = mergeInto(old, r);
        if (merged === null) {
          work.grown++;
          continue;
        }
        work.bytes += merged.line.length - old.line.length;
        work.replaced++;
        work.puts.push({ ...merged, seq: old.seq });
      } else {
        work.seq++;
        work.bytes += r.line.length;
        work.added++;
        work.puts.push({ ...r, seq: work.seq });
      }
    }
    return i < incoming.length;
  };
  const result = (): Work => {
    if (held.length + work.added > MAX_RECORDS) throw new LabelStoreError("too-many");
    if (work.bytes > MAX_BYTES) throw new LabelStoreError("too-big");
    return work;
  };
  return { step, result };
}

const turn = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** A preview of an import, worked out from one read of the store, a slice at a time. Nothing is written. */
export async function previewImport(incoming: readonly LabelRecord[]): Promise<ImportPlan> {
  const { records, ...meta } = await readAll();
  const p = planner(incoming, records, meta);
  // oxlint-disable-next-line no-await-in-loop -- a slice, then the page's turn
  while (p.step()) await turn();
  const w = p.result();
  return { added: w.added, replaced: w.replaced, grown: w.grown, rev: meta.rev };
}

/** The import's preview was of an older store: the new one, worked out in the refused write. */
export class StaleImportError extends LabelStoreError {
  readonly fresh: ImportPlan;
  constructor(fresh: ImportPlan) {
    super("stale");
    this.fresh = fresh;
    this.name = "StaleImportError";
  }
}

/**
 * Writes an import: worked out again inside the write transaction from what the store holds then,
 * a slice at a time (each slice in the answer to a small request, which keeps the transaction
 * open while the page draws), and written only if that is the store the preview was worked out
 * from (the same revision). If it is not, nothing is written and the error carries the new
 * preview. Then a slice of puts at a time.
 */
export async function runImport(
  incoming: readonly LabelRecord[],
  preview: ImportPlan,
  progress?: (done: number, total: number) => void,
): Promise<{ shown: boolean }> {
  return transact((c, done) => {
    readRecords(c.records, (held) => {
      const p = planner(incoming, held, c);
      const work = () => {
        if (p.step()) {
          c.records.count().addEventListener("success", work);
          return;
        }
        let now: Work;
        try {
          now = p.result();
        } catch (e) {
          c.fail(e);
          return;
        }
        if (c.rev !== preview.rev) {
          c.fail(
            new StaleImportError({
              added: now.added,
              replaced: now.replaced,
              grown: now.grown,
              rev: c.rev,
            }),
          );
          return;
        }
        const puts = now.puts;
        let i = 0;
        // Each slice's last put answers in a task of its own, where the next slice is queued.
        const next = () => {
          const end = Math.min(puts.length, i + 1000);
          let last: IDBRequest | undefined;
          for (; i < end; i++) last = putBoth(c, puts[i] as Stored);
          progress?.(i, puts.length);
          if (last && i < puts.length) last.addEventListener("success", next);
          else done({ seq: now.seq, bytes: now.bytes });
        };
        next();
      };
      work();
    });
  });
}

/** Deletes records by key, one after another in one transaction. */
export async function remove(keys: readonly string[]): Promise<void> {
  await transact((c, done) => {
    const next = (i: number, bytes: number) => {
      const k = keys[i];
      if (k === undefined) {
        done({ seq: c.seq, bytes });
        return;
      }
      const got = c.records.get(k);
      got.addEventListener("success", () => {
        c.records.delete(k);
        c.shown.delete(k);
        next(i + 1, bytes - ((got.result as Stored | undefined)?.line.length ?? 0));
      });
    };
    next(0, c.bytes);
  });
}

/** Deletes every record. */
export async function removeAll(): Promise<void> {
  await transact((c, done) => {
    c.records.clear();
    c.shown.clear();
    done({ seq: c.seq, bytes: 0 });
  });
}

/** The BIP329 file of every record, in the reader's order. */
export async function exportFile(): Promise<{ text: string; count: number }> {
  const { records } = await readAll();
  return { text: writeFile(records), count: records.length };
}
