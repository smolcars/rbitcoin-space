// What the block page computes in the browser: subsidy and reward, fullness, the coinbase tag.
import type { Transaction } from "../../lib/esplora";
import { formatPowerOfTen, groupDigits, MISSING } from "../../lib/format";
import type { Network } from "../../lib/network";

/** Blocks between halvings. Regtest halves every 150 blocks so tests can reach late eras. */
export const HALVING_INTERVAL: Record<Network, number> = {
  mainnet: 210_000,
  signet: 210_000,
  testnet4: 210_000,
  testnet5: 210_000,
  regtest: 150,
};

/** Consensus block weight limit, weight units. */
export const MAX_BLOCK_WEIGHT = 4_000_000;

/** The new coins a block at `height` may create, in sats: 50 BTC halved once per interval, 0 after 64 halvings. */
export function subsidy(height: number, interval: number): number {
  if (!Number.isSafeInteger(height) || height < 0 || !(interval > 0)) return 0;
  const halvings = Math.floor(height / interval);
  // Dividing by a power of two is exact in a double, so floor matches Core's right shift.
  return halvings >= 64 ? 0 : Math.floor(5_000_000_000 / 2 ** halvings);
}

export interface Reward {
  /** What the coinbase pays out, sats. */
  reward: number;
  subsidy: number;
}

/**
 * What the block's coinbase claimed, and the subsidy. Null when `tx` is not a coinbase. The fees
 * are not reward − subsidy: a miner may claim less than it could, so they come from the block summary.
 */
export function blockReward(
  tx: Transaction | undefined,
  height: number,
  interval: number,
): Reward | null {
  if (!tx?.vin?.[0]?.is_coinbase) return null;
  let reward = 0;
  for (const out of tx.vout) {
    if (!Number.isSafeInteger(out.value)) return null;
    reward += out.value;
  }
  return { reward, subsidy: subsidy(height, interval) };
}

/** Share of the weight limit used, 0–1 (an over-limit value from a broken node is clamped). */
export function fullness(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? Math.min(1, weight / MAX_BLOCK_WEIGHT) : 0;
}

/** What `/block/:id` names: a block hash, a height, or nothing valid. */
export type BlockId = { kind: "hash"; hash: string } | { kind: "height"; height: number };

const U32_MAX = 4_294_967_295;

export function parseBlockId(id: string): BlockId | null {
  if (/^[0-9a-fA-F]{64}$/.test(id)) return { kind: "hash", hash: id.toLowerCase() };
  if (/^\d{1,10}$/.test(id)) {
    const height = Number(id);
    if (height <= U32_MAX) return { kind: "height", height };
  }
  return null;
}

/** A height for `/blocks/:from`: decimal digits within u32, as the API accepts. */
export function parseHeight(value: string): number | null {
  const id = parseBlockId(value);
  return id?.kind === "height" ? id.height : null;
}

/** A route parameter as the reader typed it, for repeating it back in a message. */
export function shownParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A piece of the coinbase tag: readable text, or `count` characters that are not, shown as dots. */
export type TagPart = { text: string } | { hidden: number };

export interface CoinbaseTag {
  /** True when the script carries something a person can read. */
  readable: boolean;
  parts: TagPart[];
  /** The script bytes shown, as hex, for scripts with no text. */
  hex: string;
  /** True when `parts` holds only the words; false when it is every visible character. */
  words: boolean;
}

/** The scriptSig is at most 100 bytes by consensus; anything longer from the API is cut there. */
export const TAG_MAX_BYTES = 100;

// Characters that would not show, or would reorder or disguise the text around them: controls,
// format characters (bidi overrides, zero-width), private use, unassigned, separators, and the
// replacement character that stands in for bytes that are not UTF-8.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}�]/u;

function hexBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  const out = new Uint8Array(Math.min(hex.length / 2, TAG_MAX_BYTES));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Minimal little-endian script number, as BIP34 puts the height first in the coinbase. */
function scriptNum(n: number): number[] {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.push(v % 256);
  if (out.length > 0 && ((out.at(-1) ?? 0) & 0x80) !== 0) out.push(0);
  return out;
}

/**
 * Splits the script into the data it pushes. An opcode that pushes nothing is a chunk of its own
 * byte; a push that runs past the end takes what is left.
 */
interface Chunk {
  op: number;
  data: Uint8Array;
  /** Where the chunk starts in the script. */
  at: number;
}

function scriptChunks(b: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < b.length) {
    const at = i;
    const op = b[i++] ?? 0;
    let n = -1;
    if (op <= 0x4b) n = op;
    else if (op === 0x4c) n = b[i++] ?? 0;
    else if (op === 0x4d) {
      n = (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
      i += 2;
    } else if (op === 0x4e) {
      n =
        ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)) +
        (b[i + 3] ?? 0) * 2 ** 24;
      i += 4;
    }
    if (n < 0) chunks.push({ op, data: Uint8Array.of(op), at });
    else {
      chunks.push({ op, data: b.subarray(i, i + n), at });
      i += n;
    }
  }
  return chunks;
}

/** True when the first chunk is the BIP34 height, which is a number, not part of the tag. */
function isHeight(chunk: Chunk | undefined, height: number): boolean {
  if (!chunk) return false;
  if (height >= 1 && height <= 16) return chunk.op === 0x50 + height;
  const want = scriptNum(height);
  return (
    chunk.op <= 0x4b &&
    chunk.data.length === want.length &&
    want.every((v, i) => chunk.data[i] === v)
  );
}

// Merged mining's magic, which opens a commitment of hash bytes; its "mm" would join a word.
const MERGED_MINING = [0xfa, 0xbe, 0x6d, 0x6d];

/** A run of characters that are not text: shown as one counted run of dots. */
const isHidden = (p: TagPart | undefined): p is { hidden: number } =>
  p !== undefined && "hidden" in p;

/** Appends to `parts`, joining a part to the one before it when they are of the same kind. */
function append(parts: TagPart[], p: TagPart) {
  const last = parts.at(-1);
  if (isHidden(last) && "hidden" in p) last.hidden += p.hidden;
  else if (last && "text" in last && "text" in p) last.text += p.text;
  else parts.push({ ...p });
}

/**
 * One pushed piece decoded as UTF-8: visible characters as text, anything else hidden; with
 * `merged`, merged mining's magic is hidden whole, so its "mm" is never the start of a word.
 */
function decodeChunk(data: Uint8Array, decoder: TextDecoder, merged: boolean): TagPart[] {
  const parts: TagPart[] = [];
  let from = 0;
  const decode = (bytes: Uint8Array) => {
    for (const ch of decoder.decode(bytes))
      append(parts, HIDDEN.test(ch) ? { hidden: 1 } : { text: ch });
  };
  if (merged)
    for (let i = 0; i + MERGED_MINING.length <= data.length; i++) {
      if (MERGED_MINING.some((b, k) => data[i + k] !== b)) continue;
      decode(data.subarray(from, i));
      append(parts, { hidden: MERGED_MINING.length });
      from = i + MERGED_MINING.length;
      i = from - 1;
    }
  decode(data.subarray(from));
  return parts;
}

const utf8 = new TextEncoder();

/** Characters in a string as a person counts them: code points, not UTF-16 units. */
const chars = (s: string): number => s.match(/./gsu)?.length ?? 0;

// ASCII punctuation rare in a tag, but as likely as any other byte in random data.
const ODD = /["$%*+;<=>?[\\\]^`{|}~]/g;
const ODD_END = /^["$%*+;<=>?[\\\]^`{|}~]|["$%*+;<=>?[\\\]^`{|}~]$/u;

/**
 * Whether a run of visible characters reads as something a person wrote rather than random bytes
 * that happened to decode: 7 bytes or more, at most one rare punctuation mark in 8 bytes, and five
 * letters or digits in a row (or two groups of three around `.`, `/` or `-`, or of two around a
 * space), or three letters outside ASCII in a row, which random bytes almost never form.
 */
function isWords(text: string): boolean {
  const bytes = utf8.encode(text).length;
  return (
    bytes >= 7 &&
    (text.match(ODD)?.length ?? 0) <= Math.floor(bytes / 8) &&
    (/[A-Za-z0-9]{5}|[A-Za-z0-9]{3}[./-][A-Za-z0-9]{3}|[A-Za-z0-9]{2} [A-Za-z0-9]{2}/.test(text) ||
      /\p{L}{3}/u.test(text.replaceAll(/\p{ASCII}/gu, " ")))
  );
}

/**
 * A run with its stray ends dropped: a lone rare punctuation mark at either end ("AntPool965>"),
 * and a letter or two outside a tag in slashes ("c/BTC.COM/", "/F2Pool/d"), which are a push's
 * length byte or an extranonce's. Markup keeps its brackets: it has more than one such mark.
 */
function tidy(text: string): string {
  const t = text.trim();
  const odd = t.match(ODD)?.length ?? 0;
  return (odd === 1 ? t.replace(ODD_END, "") : t)
    .replace(/^[^/\s]{1,2}(?=\/.*\/)/u, "")
    .replace(/(\/[^/]*\/)[^/\s]{1,2}$/u, "$1")
    .replace(/^([^/]{4,}\/)[^/\s]{1,2}$/u, "$1");
}

/**
 * The words in a coinbase, push by push: runs that do not read as words become hidden, hidden runs
 * at either end are dropped, and it stops at the first long hidden run after the words, since what
 * follows an extranonce is chance. Empty when nothing reads as words.
 * Its limit: random bytes read as words about once in 700 runs of 20 (the test measures it), and a
 * stray character beside a tag that is not in slashes stays ("Mined by AntPool616 Z").
 */
function wordsOf(chunks: TagPart[][]): TagPart[] {
  const out: TagPart[] = [];
  for (const parts of chunks)
    for (const p of parts) {
      const words = "text" in p ? tidy(p.text) : "";
      append(out, "text" in p ? (isWords(words) ? { text: words } : { hidden: chars(p.text) }) : p);
    }
  let a = 0;
  while (isHidden(out[a])) a++;
  const cut = out.findIndex((p, k) => k > a && isHidden(p) && p.hidden >= 8);
  const words = out.slice(a, cut === -1 ? out.length : cut);
  if (isHidden(words.at(-1))) words.pop();
  return words;
}

/**
 * The coinbase scriptSig as text. Each pushed piece is decoded as UTF-8; anything that would not
 * show or could disguise the text becomes a counted run of dots. When some of it reads as words
 * (a pool's name, a message), only the words are kept, so "Mined by Luxor" reads alone; otherwise
 * every visible character is shown. Attacker-controlled: the result is plain strings for text
 * nodes, at most {@link TAG_MAX_BYTES} bytes' worth.
 */
export function coinbaseTag(scriptsigHex: string | undefined, height: number): CoinbaseTag | null {
  if (scriptsigHex === undefined) return null;
  const bytes = hexBytes(scriptsigHex);
  if (!bytes) return null;
  const chunks = scriptChunks(bytes);
  if (isHeight(chunks[0], height)) chunks.shift();
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  // Every visible character, push by push: what is shown when nothing reads as words.
  const all: TagPart[] = [];
  for (const { op, data } of chunks)
    for (const p of op > 0x4e ? [{ hidden: 1 }] : decodeChunk(data, decoder, false)) append(all, p);
  // Pushes are read one by one, so their length bytes never show. A coinbase need not be a valid
  // script, though: from the first byte that pushes nothing, the rest is read as it is.
  const raw = chunks.findIndex((c) => c.op > 0x4e);
  const decoded = (raw === -1 ? chunks : chunks.slice(0, raw)).map((c) =>
    decodeChunk(c.data, decoder, true),
  );
  const rest = chunks[raw];
  if (rest) decoded.push(decodeChunk(bytes.subarray(rest.at), decoder, true));
  const readable = all.reduce(
    (n, p) => n + ("text" in p ? chars(p.text.replaceAll(/\s/gu, "")) : 0),
    0,
  );
  const words = wordsOf(decoded);
  const parts = words.length > 0 ? words : all;
  // Trailing space is invisible and leading space misaligns; neither carries meaning.
  const first = parts[0];
  if (first && "text" in first) first.text = first.text.trimStart();
  const last = parts.at(-1);
  if (last && "text" in last) last.text = last.text.trimEnd();
  const shown = bytes.subarray(chunks[0]?.at ?? bytes.length);
  return {
    // Words found in the raw reading count even when the push-by-push reading saw none.
    readable: words.length > 0 || readable >= 3,
    words: words.length > 0,
    parts: parts.filter((p) => !("text" in p) || p.text !== ""),
    hex: Array.from(shown, (v) => v.toString(16).padStart(2, "0")).join(""),
  };
}

/**
 * Difficulty, compact: `148.36 T` above a million, grouped below, three significant digits under
 * 1, and a power of ten where writing it out would not fit: `4.66 × 10⁻¹⁰` (regtest).
 */
export function formatDifficulty(d: number): { short: string; full: string } {
  if (!Number.isFinite(d) || d < 0) return { short: MISSING, full: MISSING };
  if (d >= 1e21 || (d > 0 && d < 0.001)) {
    return { short: formatPowerOfTen(d, 3), full: formatPowerOfTen(d, 6) };
  }
  const full = d >= 1 ? groupDigits(d) : d.toPrecision(3);
  const units: [number, string][] = [
    [1e18, "E"],
    [1e15, "P"],
    [1e12, "T"],
    [1e9, "G"],
    [1e6, "M"],
  ];
  for (const [scale, unit] of units)
    if (d >= scale) return { short: `${(d / scale).toFixed(2)} ${unit}`, full };
  return { short: full, full };
}

/** A 32-bit header field as `0x` and eight hex digits. */
export function hex32(n: number): string {
  // Signed in some replies (version is an int32); >>> 0 shows the same 32 bits.
  return Number.isInteger(n) ? `0x${(n >>> 0).toString(16).padStart(8, "0")}` : MISSING;
}
