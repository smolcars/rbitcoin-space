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

/**
 * The coinbase scriptSig as text. Each pushed piece is decoded as UTF-8; anything that would not
 * show or could disguise the text becomes a counted run of dots. Attacker-controlled: the result
 * is plain strings for text nodes, at most {@link TAG_MAX_BYTES} bytes' worth.
 */
export function coinbaseTag(scriptsigHex: string | undefined, height: number): CoinbaseTag | null {
  if (scriptsigHex === undefined) return null;
  const bytes = hexBytes(scriptsigHex);
  if (!bytes) return null;
  const chunks = scriptChunks(bytes);
  if (isHeight(chunks[0], height)) chunks.shift();
  const parts: TagPart[] = [];
  const push = (p: TagPart) => {
    const last = parts.at(-1);
    if (last && "hidden" in last && "hidden" in p) last.hidden += p.hidden;
    else if (last && "text" in last && "text" in p) last.text += p.text;
    else parts.push(p);
  };
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let readable = 0;
  for (const { op, data } of chunks) {
    // An opcode that pushes nothing is script, not text.
    if (op > 0x4e) {
      push({ hidden: 1 });
      continue;
    }
    for (const ch of decoder.decode(data)) {
      if (HIDDEN.test(ch)) push({ hidden: 1 });
      else {
        push({ text: ch });
        if (ch.trim() !== "") readable++;
      }
    }
  }
  // Trailing space is invisible and leading space misaligns; neither carries meaning.
  const first = parts[0];
  if (first && "text" in first) first.text = first.text.trimStart();
  const last = parts.at(-1);
  if (last && "text" in last) last.text = last.text.trimEnd();
  const shown = bytes.subarray(chunks[0]?.at ?? bytes.length);
  return {
    readable: readable >= 3,
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
