// BIP329 wallet label files: JSON Lines, one record a line. Reading keeps each record's line as
// written, so every field this site does not use (origin, spendable, height, fmv, keypath and any
// later one) leaves on export exactly as it came in. Pure: no storage, no DOM.
import { normalRef } from "../labels";

/** The types BIP329 defines. Records of another type are kept and exported, never shown. */
export const BIP329_TYPES = ["tx", "addr", "pubkey", "input", "output", "xpub", "spscan"] as const;

/** One record. `line` is its JSON text, the one line exported for it. */
export interface LabelRecord {
  /** Identity: the type, the reference as compared, and the origin (labels of two wallets differ). */
  key: string;
  type: string;
  /** As written in the file. */
  ref: string;
  /** Absent when the record carries none (BIP329: an import then leaves the label as it was). */
  label?: string;
  line: string;
}

/** The longest line read, in UTF-16 code units: an address's `heights` can be long, a label not. */
export const MAX_LINE = 64 * 1024;
/** The largest file read at all, in bytes. Larger is refused before it is read. */
export const MAX_FILE = 20 * 1024 * 1024;
/** The longest label typed in the editor: BIP329's suggested limit. Longer imported ones are kept. */
export const MAX_LABEL = 255;

/** Why a line was not read. */
export type Skip = "json" | "object" | "type" | "ref" | "label" | "origin" | "long";

export const SKIP_WORDS: Record<Skip, string> = {
  json: "not valid JSON",
  object: "not a JSON object",
  type: "no type, or a type that is not a word",
  ref: "no reference, or one that does not fit its type",
  label: "a label that is not text",
  origin: "an origin that is not text",
  long: `longer than ${MAX_LINE / 1024} KiB`,
};

const UNKNOWN_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;

export const recordKey = (type: string, ref: string, origin: string | undefined): string =>
  `${type}\n${ref}\n${origin ?? ""}`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One line read into a record, or why it cannot be. `line` has no line ending. */
export function readLine(line: string): LabelRecord | Skip {
  if (line.length > MAX_LINE) return "long";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "json";
  }
  if (!isObject(value)) return "object";
  const { type, ref } = value;
  if (typeof type !== "string" || !UNKNOWN_TYPE.test(type)) return "type";
  if (typeof ref !== "string" || ref === "" || ref.length > 4096) return "ref";
  const norm = normalRef(type, ref);
  if (norm === null) return "ref";
  // `null` is read as absent: a hand-written file says "no label" that way too.
  const label = value["label"] ?? undefined;
  const origin = value["origin"] ?? undefined;
  if (label !== undefined && typeof label !== "string") return "label";
  if (origin !== undefined && typeof origin !== "string") return "origin";
  return {
    key: recordKey(type, norm, origin),
    type,
    ref,
    ...(label === undefined ? {} : { label }),
    line: line.trim(),
  };
}

export interface ReadFile {
  /** The records, one per key: a later line for the same key replaced an earlier one. */
  records: LabelRecord[];
  /** Lines not read, by reason. */
  skipped: Map<Skip, number>;
  /** The first few lines not read, by number from 1, for the reader to find them. */
  firstSkipped: number[];
  /** Lines that a later line for the same record replaced. */
  replaced: number;
  /** Lines with something on them. */
  lines: number;
}

/** Lines read between two yields to the page, so a long file never holds the page still. */
const SLICE = 2000;
const breathe = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Reads a whole file, a slice of lines at a time with the page given a turn between them. Blank
 * lines, a byte order mark and CRLF line ends are tolerated; a bad line is skipped and counted.
 * `progress` hears how many lines are done; `cancelled` stops it between slices.
 */
export async function readFile(
  text: string,
  progress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<ReadFile> {
  const lines = text.replace(/^\u{FEFF}/u, "").split("\n");
  const byKey = new Map<string, LabelRecord>();
  const skipped = new Map<Skip, number>();
  const firstSkipped: number[] = [];
  let replaced = 0;
  let count = 0;
  for (let start = 0; start < lines.length; start += SLICE) {
    if (start > 0) {
      progress?.(start, lines.length);
      // oxlint-disable-next-line no-await-in-loop -- one slice after another, the page given a turn between
      await breathe();
      if (cancelled?.() === true) break;
    }
    const end = Math.min(lines.length, start + SLICE);
    for (let i = start; i < end; i++) {
      const line = (lines[i] ?? "").trim();
      if (line === "") continue;
      count++;
      const r = readLine(line);
      if (typeof r === "string") {
        skipped.set(r, (skipped.get(r) ?? 0) + 1);
        if (firstSkipped.length < 5) firstSkipped.push(i + 1);
        continue;
      }
      const before = byKey.get(r.key);
      if (before) {
        replaced++;
        // Re-inserted, so the record takes the place of its last line in the file's order.
        byKey.delete(r.key);
        byKey.set(r.key, mergeInto(before, r));
      } else byKey.set(r.key, r);
    }
  }
  progress?.(lines.length, lines.length);
  return { records: [...byKey.values()], skipped, firstSkipped, replaced, lines: count };
}

/**
 * `incoming` over `existing` for the same record. BIP329: where the incoming record leaves out
 * `label` or `spendable`, the value already held is kept; every other field is the incoming one's.
 */
export function mergeInto(existing: LabelRecord, incoming: LabelRecord): LabelRecord {
  const old = parsed(existing);
  const next = parsed(incoming);
  // Absent and `null` alike: readLine reads a `null` label as none.
  const has = (o: Record<string, unknown>, f: string) => o[f] !== undefined && o[f] !== null;
  const keep = ["label", "spendable"].filter((f) => !has(next, f) && has(old, f));
  if (keep.length === 0) return incoming;
  for (const f of keep) next[f] = old[f];
  return {
    ...incoming,
    ...(typeof next["label"] === "string" ? { label: next["label"] } : {}),
    line: JSON.stringify(next),
  };
}

function parsed(r: LabelRecord): Record<string, unknown> {
  const v: unknown = JSON.parse(r.line);
  return isObject(v) ? v : {};
}

/**
 * The record with its label set, or taken away for `null`. The field keeps its place in the line
 * and every other field is kept as it was; a new record is written as BIP329's example writes one.
 */
export function withLabel(
  existing: LabelRecord | undefined,
  type: string,
  ref: string,
  label: string | null,
): LabelRecord | null {
  if (!existing) {
    const norm = normalRef(type, ref);
    if (label === null || norm === null) return null;
    return {
      key: recordKey(type, norm, undefined),
      type,
      ref,
      label,
      line: JSON.stringify({ type, ref, label }),
    };
  }
  const value = parsed(existing);
  if (label === null) delete value["label"];
  else value["label"] = label;
  return {
    key: existing.key,
    type: existing.type,
    ref: existing.ref,
    ...(label === null ? {} : { label }),
    line: JSON.stringify(value),
  };
}

/** Whether a record holds anything once its label is gone: a field besides its type and ref. */
export function holdsMore(r: LabelRecord): boolean {
  return Object.keys(parsed(r)).some((k) => k !== "type" && k !== "ref" && k !== "label");
}

/** The file: each record's line, in order, each ended by `\n` as BIP329 separates them. */
export function writeFile(records: Iterable<LabelRecord>): string {
  let out = "";
  for (const r of records) out += `${r.line}\n`;
  return out;
}

/** `rbitcoin-labels-YYYY-MM-DD.jsonl`, the day in UTC. */
export function fileName(date: Date): string {
  const day = Number.isFinite(date.getTime()) ? `-${date.toISOString().slice(0, 10)}` : "";
  return `rbitcoin-labels${day}.jsonl`;
}
