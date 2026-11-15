// A transaction's flags (docs/API.md "Transaction flags") as a number. The server's highest bit is
// 44, so a number holds them exactly, but bitwise operators work on 32 bits: every test splits the
// field into its two 32-bit words, with no BigInt.

export const WORD = 2 ** 32;
/** Bits 53 and up: beyond what a number holds exactly, and unused. */
const HIGH_BITS = 2 ** 21 - 1;

/** The low and high 32-bit words of a flags field below 2^53. */
export function words(flags: number): [number, number] {
  const lo = flags % WORD;
  return [lo, (flags - lo) / WORD];
}

/** Whether bit `bit` (0 to 52) is set. */
export function has(flags: number, bit: number): boolean {
  const [lo, hi] = words(flags);
  return bit < 32 ? ((lo >>> bit) & 1) === 1 : ((hi >>> (bit - 32)) & 1) === 1;
}

/**
 * The little-endian u64 at `at` as a number. Bits from 53 up are dropped rather than refused, so a
 * server that sets a new one still draws: only bits this page names are ever read.
 */
export function readFlags(view: DataView, at: number): number {
  return (view.getUint32(at + 4, true) & HIGH_BITS) * WORD + view.getUint32(at, true);
}
