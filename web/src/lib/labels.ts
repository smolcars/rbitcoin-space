// The reader's own labels, as the pages read them: a map from a BIP329 reference to its label,
// kept in this browser only (docs/FRONTEND.md "Your labels"). This is the part every page loads,
// with labels/store.ts that fills it; writing (labels/db.ts), the file format (labels/bip329.ts),
// the editor and the manager load when the reader asks for them. Nothing here reaches the network.
import { createSignal } from "solid-js";

/** The record types a page can show a label for. */
export type Shown = "tx" | "addr" | "pubkey" | "input" | "output";

/**
 * Set in `localStorage` while this browser holds any label, so a reader without labels never
 * opens the database. Its value is the store's revision, new on every write, which tells the
 * reader's other tabs.
 */
export const HINT = "labels";

/**
 * Which record an editor opened on: its key and its place (`seq`). A record deleted and made again
 * under the same key gets a new place, so the pair names one record, never its replacement.
 */
export interface Opened {
  key: string;
  seq: number;
}

/**
 * What an editor has shown the reader: the record (`null` for none) and its label text (undefined
 * for none). A save replaces only this: it is checked inside the write.
 */
export interface Showed {
  record: Opened | null;
  label: string | undefined;
}

// The map is changed in place by the store; the version says that it changed.
let index: ReadonlyMap<string, string> = new Map();
// The record behind each label shown, by the same key.
let records: ReadonlyMap<string, Opened> = new Map();
const [version, setVersion] = createSignal(0);

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

/**
 * A record's identity: its type, its reference as compared, and its origin (two wallets' labels of
 * one thing differ). Written as a JSON array, so no two different triples can share it.
 */
export const recordKey = (type: string, ref: string, origin: string | undefined): string =>
  JSON.stringify([type, ref, origin ?? null]);

/** The key a shown label is found by. */
export const indexKey = (type: Shown, ref: string): string => `${type}:${ref}`;

/** The reader's label for a transaction, address, key, input or output, if they gave it one. */
export function labelOf(type: Shown, ref: string): string | undefined {
  version();
  if (index.size === 0) return undefined;
  const norm = normalRef(type, ref);
  return norm === null ? undefined : index.get(indexKey(type, norm));
}

/** The record whose label pages show for a thing, if there is one: what a page's editor opens on. */
export function shownRecord(type: Shown, ref: string): Opened | undefined {
  version();
  const norm = normalRef(type, ref);
  return norm === null ? undefined : records.get(indexKey(type, norm));
}

/** A number that moves on every change to the labels, from this tab or another: read it to follow them. */
export const labelsVersion = version;

/**
 * Shows `map` on every page, with the record behind each label (`from`); the store calls it again
 * after it changes the same map.
 */
export function showLabels(
  map: ReadonlyMap<string, string>,
  from: ReadonlyMap<string, Opened> = new Map(),
): void {
  index = map;
  records = from;
  setVersion((v) => v + 1);
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
// Format characters, bidi overrides and isolates among them; a joiner inside an emoji stays.
const FORMAT = /(?!\u{200D})\p{Cf}/gu;
// Stacked combining marks draw over the lines around them: keep at most two on a letter.
const MARKS = /(\p{M}{2})\p{M}+/gu;

/**
 * A label fit to show as text: control, line-breaking and invisible format characters become
 * U+FFFD, so a reader sees something is there, stacked marks are thinned, and at most `max`
 * characters are kept, an ellipsis after them. A character here is what a reader counts (an emoji
 * is one), and none may stand for more than four code units of text, so one cluster of joined
 * emoji cannot carry a long label past the limit. The label is still only ever a text node.
 */
export function shownLabel(label: string, max: number): string {
  // Only the start is ever shown, so only the start is cleaned and counted.
  const units = max * 4;
  const clean = label
    .slice(0, units + 1)
    .replaceAll(CONTROL, "\u{FFFD}")
    .replaceAll(FORMAT, "\u{FFFD}")
    .replaceAll(MARKS, "$1");
  const cut = label.length > units + 1 || clean.length > units;
  // Fewer code units than `max` is fewer characters too; only a long label is counted.
  if (!cut && clean.length <= max) return clean;
  let out = "";
  let count = 0;
  for (const { segment } of graphemes().segment(clean)) {
    if (count === max || out.length + segment.length > units) return `${out}…`;
    out += segment;
    count++;
  }
  return cut ? `${out}…` : out;
}

let segmenter: Intl.Segmenter | undefined;
/** Characters as a reader counts them, so no emoji is cut in half. */
const graphemes = () => (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));
