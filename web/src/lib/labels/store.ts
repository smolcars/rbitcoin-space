// Reading the reader's labels from IndexedDB, in this browser only (docs/FRONTEND.md "Your
// labels"). In the shell's group, not loaded on demand: a request for this code only from a
// browser that holds labels would tell the server that it does. Writing is in db.ts, loaded when
// the reader opens the editor or the manager, which every reader does alike.
import { HINT, indexKey, type Shown, showLabels } from "../labels";
import type { LabelRecord } from "./bip329";

/** The most records this browser keeps, after an import. */
export const MAX_RECORDS = 250_000;

const NAME = "rbitcoin-labels";
/**
 * The database's version. A later change that reshapes what is stored raises it and migrates in
 * `upgrade`, from each older version in turn.
 */
export const VERSION = 1;
export const STORE = "records";

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

export function wrap(e: unknown): LabelStoreError {
  if (e instanceof LabelStoreError) return e;
  const name = e instanceof DOMException ? e.name : "";
  return new LabelStoreError(name === "QuotaExceededError" ? "full" : "failed", e);
}

/** Runs each migration from the stored version up to VERSION. */
function upgrade(db: IDBDatabase, from: number): void {
  if (from < 1) db.createObjectStore(STORE, { keyPath: "key" });
}

let opening: Promise<IDBDatabase> | undefined;

export function open(): Promise<IDBDatabase> {
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

/** The records as last read or written, for db.ts to change after a write. */
export function cached(): Map<string, Stored> {
  cache ??= new Map();
  return cache;
}

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
export async function records(): Promise<Map<string, Stored>> {
  return cache ?? (await load());
}

export function hint(count: number): void {
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

/** Reads the labels this browser holds, if it holds any, and shows them on every page. Without
 * any it costs one `localStorage` read. Another tab's change arrives as a `storage` event on the
 * hint, and is read again. index.tsx waits for it, as briefly as for the font, before rendering. */
export function startLabels(): Promise<void> {
  addEventListener("storage", (e) => {
    if (e.key === HINT || e.key === null) void refresh().catch(() => undefined);
  });
  let held = true;
  try {
    held = localStorage.getItem(HINT) !== null;
  } catch {
    // Storage blocked: the database may still work, so ask it.
  }
  // No database here: pages show no labels, as before.
  return held ? refresh().catch(() => undefined) : Promise.resolve();
}

/** Forgets the open database and the cache: for tests, which swap the database underneath. */
export function reset(): void {
  cache = undefined;
  opening = undefined;
}
