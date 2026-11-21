// BIP329 wallet label files: JSON Lines, one record a line. Each record keeps its line as it was
// written, so the fields this site does not use (origin, spendable, height, fmv, keypath and any
// later one) leave on export as they came in. A label is set or carried into a line by editing
// that one member's text, never by writing the line again. Pure: no storage, no DOM.
import { normalRef, recordKey } from "../labels";

export { recordKey } from "../labels";

/** The types BIP329 defines. Records of another type are kept and exported, never shown. */
export const BIP329_TYPES = ["tx", "addr", "pubkey", "input", "output", "xpub", "spscan"] as const;

/** One record. `line` is its JSON text, the one line exported for it. */
export interface LabelRecord {
  /** `recordKey`: type, the reference as compared, and origin. */
  key: string;
  type: string;
  /** As written in the file. */
  ref: string;
  /** Absent when the record carries none (BIP329: an import then leaves the label as it was). */
  label?: string;
  line: string;
}

/** The longest line read, or written by a merge or an edit, in UTF-16 code units. */
export const MAX_LINE = 64 * 1024;
/** The largest file read at all, in bytes. Larger is refused before it is read. */
export const MAX_FILE = 20 * 1024 * 1024;
/** The most lines of a file read, blank ones included, before the file is refused. */
export const MAX_LINES = 500_000;
/** The most records one file may hold, and this browser keeps. */
export const MAX_RECORDS = 250_000;
/** The most text this browser keeps, all records' lines together, in UTF-16 code units. */
export const MAX_BYTES = 40 * 1024 * 1024;
/** The longest label typed in the editor: BIP329's suggested limit. Longer imported ones are kept. */
export const MAX_LABEL = 255;

/** Why a line was not read. */
export type Skip =
  | "json"
  | "object"
  | "type"
  | "ref"
  | "label"
  | "origin"
  | "spendable"
  | "long"
  | "grow";

export const SKIP_WORDS: Record<Skip, string> = {
  json: "not valid JSON",
  object: "not a JSON object",
  type: "no type, or a type that is not a word",
  ref: "no reference, or one that does not fit its type",
  label: "a label that is not text",
  origin: "an origin that is not a key origin descriptor",
  spendable: "an output's spendable that is not true or false",
  long: `longer than ${MAX_LINE / 1024} KiB`,
  grow: `would pass ${MAX_LINE / 1024} KiB with the label kept from before`,
};

/** Why a whole file was refused, partway through reading it. */
export type Refusal = "lines" | "records";

export const REFUSAL_WORDS: Record<Refusal, string> = {
  lines: `This file has more than ${MAX_LINES.toLocaleString("en")} lines. Split it into smaller files and import each.`,
  records: `This file holds more than ${MAX_RECORDS.toLocaleString("en")} labels, the most this browser keeps.`,
};

const UNKNOWN_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
/**
 * BIP329's origin: an abbreviated output descriptor, its key origin and no keys, child path or
 * checksum: `wpkh([d34db33f/84'/0'/0'])`, `sh(wpkh([…]))`, `tr([…])`.
 */
const ORIGIN = /^[a-z]+\((?:[a-z]+\()*\[[0-9a-fA-F]{8}(?:\/\d+['hH]?)*\]\)+$/;

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
  const own = (k: string): unknown => (Object.hasOwn(value, k) ? value[k] : undefined);
  const type = own("type");
  const ref = own("ref");
  if (typeof type !== "string" || !UNKNOWN_TYPE.test(type)) return "type";
  if (typeof ref !== "string" || ref === "" || ref.length > 4096) return "ref";
  const norm = normalRef(type, ref);
  if (norm === null) return "ref";
  // `null` is read as absent: a hand-written file says "no label" that way too.
  const label = own("label") ?? undefined;
  const origin = own("origin") ?? undefined;
  if (label !== undefined && typeof label !== "string") return "label";
  if (origin !== undefined && (typeof origin !== "string" || !ORIGIN.test(origin))) return "origin";
  const spendable = own("spendable");
  if (type === "output" && spendable !== undefined && typeof spendable !== "boolean")
    return "spendable";
  return {
    key: recordKey(type, norm, origin),
    type,
    ref,
    ...(label === undefined ? {} : { label }),
    line,
  };
}

/** A top-level member of a line's object: its name, and where it and its value sit in the text. */
interface Member {
  name: string;
  /** From the name's opening quote to the value's end. */
  start: number;
  end: number;
  valueStart: number;
}

/** The end of the JSON value that starts at `i` in valid JSON `s`. */
function valueEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') {
      for (j++; s[j] !== '"'; j++) if (s[j] === "\\") j++;
      if (depth === 0) return j + 1;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 0) return j;
      depth--;
      if (depth === 0) return j + 1;
    } else if (depth === 0 && (c === "," || c === " " || c === "\t" || c === "\r" || c === "\n"))
      return j;
  }
  return s.length;
}

const space = (s: string, i: number) => {
  let j = i;
  while (s[j] === " " || s[j] === "\t" || s[j] === "\r" || s[j] === "\n") j++;
  return j;
};

/** The top-level members of a line that is valid JSON for an object. */
function members(line: string): Member[] {
  const out: Member[] = [];
  let i = space(line, line.indexOf("{") + 1);
  while (line[i] === '"') {
    const nameEnd = valueEnd(line, i);
    const name = JSON.parse(line.slice(i, nameEnd)) as string;
    const valueStart = space(line, space(line, nameEnd) + 1);
    const end = valueEnd(line, valueStart);
    out.push({ name, start: i, end, valueStart });
    i = space(line, end);
    if (line[i] === ",") i = space(line, i + 1);
  }
  return out;
}

/** The last member named `name`, as JSON reads a line with the name twice. */
function lastNamed(list: readonly Member[], name: string): Member | undefined {
  let found: Member | undefined;
  for (const m of list) if (m.name === name) found = m;
  return found;
}

/** The raw text of a member's value, or undefined. */
function rawValue(line: string, name: string): string | undefined {
  const m = lastNamed(members(line), name);
  return m ? line.slice(m.valueStart, m.end) : undefined;
}

/** The line without the first member named `name`, with its comma, or null when it has none. */
function withoutFirst(line: string, name: string): string | null {
  const list = members(line);
  const k = list.findIndex((m) => m.name === name);
  const at = list[k];
  if (!at) return null;
  const prev = list[k - 1];
  const next = list[k + 1];
  if (prev) return `${line.slice(0, prev.end)}${line.slice(at.end)}`;
  if (next) return `${line.slice(0, at.start)}${line.slice(next.start)}`;
  return `${line.slice(0, at.start)}${line.slice(space(line, at.end))}`;
}

/**
 * The line with one member set to `json` (raw JSON text), or taken out for null. Only that
 * member's text changes: every other byte of the line is kept as it was. A name given twice ends
 * as one, so the line says one thing whatever reads it.
 */
export function setMember(line: string, name: string, json: string | null): string {
  let out = line;
  const list = members(out);
  const m = lastNamed(list, name);
  if (json === null) {
    for (let next = withoutFirst(out, name); next !== null; next = withoutFirst(out, name))
      out = next;
    return out;
  }
  if (m) out = `${out.slice(0, m.valueStart)}${json}${out.slice(m.end)}`;
  else {
    const close = out.lastIndexOf("}");
    const sep = list.length > 0 ? "," : "";
    return `${out.slice(0, close)}${sep}${JSON.stringify(name)}:${json}${out.slice(close)}`;
  }
  // Earlier duplicates go; the one just set is the last.
  while (members(out).filter((x) => x.name === name).length > 1)
    out = withoutFirst(out, name) ?? out;
  return out;
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
  /** Set when the file was refused partway: nothing of it is to be imported. */
  refused?: Refusal;
}

/** The longest the reading holds the page before giving it a turn, in milliseconds. */
const SLICE_MS = 8;
const breathe = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Reads a whole file a line at a time, never splitting it whole, giving the page a turn every few
 * milliseconds. A byte order mark, CRLF line ends and blank lines are tolerated; a bad line is
 * skipped and counted. Past MAX_LINES lines or MAX_RECORDS records the file is refused there.
 * `progress` hears how far it is, in UTF-16 code units; `cancelled` stops it between slices.
 */
export async function readFile(
  text: string,
  progress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<ReadFile> {
  const byKey = new Map<string, LabelRecord>();
  const skipped = new Map<Skip, number>();
  const firstSkipped: number[] = [];
  const skip = (why: Skip, n: number) => {
    skipped.set(why, (skipped.get(why) ?? 0) + 1);
    if (firstSkipped.length < 5) firstSkipped.push(n);
  };
  const result = (refused?: Refusal): ReadFile => ({
    records: refused ? [] : [...byKey.values()],
    skipped,
    firstSkipped,
    replaced,
    lines: count,
    ...(refused ? { refused } : {}),
  });
  let replaced = 0;
  let count = 0;
  let number = 0;
  let at = text.startsWith("\u{FEFF}") ? 1 : 0;
  let sliceStart = performance.now();
  while (at <= text.length) {
    if ((number & 255) === 0 && performance.now() - sliceStart > SLICE_MS) {
      progress?.(at, text.length);
      // oxlint-disable-next-line no-await-in-loop -- one slice after another, the page given a turn between
      await breathe();
      if (cancelled?.() === true) return result();
      sliceStart = performance.now();
    }
    let end = text.indexOf("\n", at);
    if (end === -1) end = text.length;
    number++;
    if (number > MAX_LINES) return result("lines");
    // Only a line short enough to read is cut out of the file; the rest are measured in place.
    const line = end - at > MAX_LINE + 2 ? null : text.slice(at, end).trim();
    at = end + 1;
    if (line === "") continue;
    count++;
    const r = line === null ? "long" : readLine(line);
    if (typeof r === "string") {
      skip(r, number);
      continue;
    }
    const before = byKey.get(r.key);
    const merged = before ? mergeInto(before, r) : r;
    if (merged === null) {
      skip("grow", number);
      continue;
    }
    if (before) {
      replaced++;
      // Re-inserted, so the record takes the place of its last line in the file's order.
      byKey.delete(r.key);
    }
    byKey.set(r.key, merged);
    if (byKey.size > MAX_RECORDS) return result("records");
  }
  progress?.(text.length, text.length);
  return result();
}

/**
 * `incoming` over `existing` for the same record. BIP329: where the incoming record leaves out
 * `label` or (on an output) `spendable`, the value already held is kept; every other field is the
 * incoming one's. The kept value is written into the incoming line as it was written before, the
 * rest of the line untouched. Null when that would make the line longer than MAX_LINE.
 */
export function mergeInto(existing: LabelRecord, incoming: LabelRecord): LabelRecord | null {
  const has = (line: string, name: string) => {
    const raw = rawValue(line, name);
    return raw !== undefined && raw !== "null";
  };
  const carry = ["label", ...(incoming.type === "output" ? ["spendable"] : [])].filter(
    (f) => !has(incoming.line, f) && has(existing.line, f),
  );
  if (carry.length === 0) return incoming;
  let line = incoming.line;
  for (const f of carry) line = setMember(line, f, rawValue(existing.line, f) ?? "null");
  if (line.length > MAX_LINE) return null;
  return {
    ...incoming,
    ...(existing.label === undefined || incoming.label !== undefined
      ? {}
      : { label: existing.label }),
    line,
  };
}

/**
 * The record with its label set, or taken away for `null`. Only the label's text in the line
 * changes; a new record is written as BIP329's example writes one. Null when there is nothing to
 * write (no record and no label, or a reference that does not fit its type).
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
  return {
    key: existing.key,
    type: existing.type,
    ref: existing.ref,
    ...(label === null ? {} : { label }),
    line: setMember(existing.line, "label", label === null ? null : JSON.stringify(label)),
  };
}

/** Whether a record holds anything once its label is gone: a field besides its type and ref. */
export function holdsMore(r: LabelRecord): boolean {
  return members(r.line).some((m) => m.name !== "type" && m.name !== "ref" && m.name !== "label");
}

/** The file: each record's line, in order, each ended by `\n` as BIP329 separates them. */
export function writeFile(records: Iterable<LabelRecord>): string {
  const parts: string[] = [];
  for (const r of records) parts.push(r.line);
  return parts.length === 0 ? "" : `${parts.join("\n")}\n`;
}

/** `rbitcoin-labels-YYYY-MM-DD.jsonl`, the day in UTC. */
export function fileName(date: Date): string {
  const day = Number.isFinite(date.getTime()) ? `-${date.toISOString().slice(0, 10)}` : "";
  return `rbitcoin-labels${day}.jsonl`;
}
