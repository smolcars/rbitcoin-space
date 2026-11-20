// The reader's own labels, as the pages read them: a map from a BIP329 reference to its label,
// kept in this browser only (docs/FRONTEND.md "Your labels"). This is the part every page loads;
// the store (labels/db.ts), the file format (labels/bip329.ts), the editor and the manager load
// only when a reader has labels or asks for them. Nothing here ever reaches the network.
import { createSignal } from "solid-js";

/** The record types a page can show a label for. */
export type Shown = "tx" | "addr" | "pubkey" | "input" | "output";

/**
 * Set in `localStorage` while this browser holds any label, so a reader without labels never
 * opens the database. Its value changes on every write, which tells the reader's other tabs.
 */
export const HINT = "labels";

const EMPTY: ReadonlyMap<string, string> = new Map();
const [index, setIndex] = createSignal<ReadonlyMap<string, string>>(EMPTY);

const BECH32 = /^(?:bc|tb|bcrt|sp|tsp|sprt)1[02-9ac-hj-np-z]+$/;

/**
 * A reference as it is compared, or null when it is not one of its type's form: hex in lower case,
 * a bech32 address in lower case (its checksum ignores case), anything else as written.
 */
export function normalRef(type: string, ref: string): string | null {
  switch (type) {
    case "tx": {
      return /^[0-9a-f]{64}$/i.test(ref) ? ref.toLowerCase() : null;
    }
    case "input":
    case "output": {
      const m = /^([0-9a-f]{64}):(\d{1,10})$/i.exec(ref);
      const n = Number(m?.[2]);
      return m?.[1] !== undefined && n <= 0xffff_ffff ? `${m[1].toLowerCase()}:${n}` : null;
    }
    case "pubkey": {
      return /^(?:[0-9a-f]{64}|[0-9a-f]{66}|[0-9a-f]{130})$/i.test(ref) ? ref.toLowerCase() : null;
    }
    case "addr": {
      if (!/^[0-9a-z]{14,128}$/i.test(ref)) return null;
      const lower = ref.toLowerCase();
      // Mixed case is not bech32; base58 is case-sensitive and kept as written.
      return BECH32.test(lower) && (ref === lower || ref === ref.toUpperCase()) ? lower : ref;
    }
    default: {
      return ref;
    }
  }
}

/** The key a shown label is found by. */
export const indexKey = (type: Shown, ref: string): string => `${type}:${ref}`;

/** The reader's label for a transaction, address, key, input or output, if they gave it one. */
export function labelOf(type: Shown, ref: string): string | undefined {
  const map = index();
  if (map.size === 0) return undefined;
  const norm = normalRef(type, ref);
  return norm === null ? undefined : map.get(indexKey(type, norm));
}

/** Every label a page can show, by `indexKey`: read it to follow every change. */
export const shownLabels = index;

/** Whether this browser holds any label to show. */
export const hasLabels = (): boolean => index().size > 0;

/** Replaces what pages show. Called by the store after it reads or writes. */
export function showLabels(map: ReadonlyMap<string, string>): void {
  setIndex(map);
}

function hinted(): boolean {
  try {
    return localStorage.getItem(HINT) !== null;
  } catch {
    // Storage blocked: the database may still work, so ask it.
    return true;
  }
}

async function load(): Promise<void> {
  try {
    const db = await import("./labels/db");
    await db.refresh();
  } catch {
    // No database here, or its code failed to download: pages show no labels, as before.
  }
}

/**
 * Loads the labels this browser holds, before the first render where it can (index.tsx waits for
 * it as briefly as for the font). Without any it costs one `localStorage` read. Another tab's
 * change arrives as a `storage` event on the hint, and is read again.
 */
export function startLabels(): Promise<void> {
  addEventListener("storage", (e) => {
    if (e.key === HINT || e.key === null) void load();
  });
  return hinted() ? load() : Promise.resolve();
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
// Format characters, bidi overrides and isolates among them; a joiner inside an emoji stays.
const FORMAT = /(?!\u{200D})\p{Cf}/gu;
// Stacked combining marks draw over the lines around them: keep at most two on a letter.
const MARKS = /(\p{M}{2})\p{M}+/gu;

/**
 * A label fit to show as text: control, line-breaking and invisible format characters become
 * U+FFFD, so a reader sees something is there, stacked marks are thinned, and at most `max`
 * characters are kept, an ellipsis after them. The label is still only ever a text node.
 */
export function shownLabel(label: string, max: number): string {
  const clean = label
    .replaceAll(CONTROL, "\u{FFFD}")
    .replaceAll(FORMAT, "\u{FFFD}")
    .replaceAll(MARKS, "$1");
  // Fewer code units than `max` is fewer characters too; only a long label is counted.
  if (clean.length <= max) return clean;
  const chars = Array.from(graphemes().segment(clean), (g) => g.segment);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : clean;
}

let segmenter: Intl.Segmenter | undefined;
/** Characters as a reader counts them, so no emoji is cut in half. */
const graphemes = () => (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));
