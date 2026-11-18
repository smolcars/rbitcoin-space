// How a confirmed transaction's fee rate compares with the low end of its block (docs/FRONTEND.md
// "A confirmed transaction's fee verdict"). Pure, but for `judgeFee`, which takes its fetchers.
import type { Outspend, TxStatus } from "../../lib/esplora";
import { formatFeeRate, groupDigits } from "../../lib/format";
import type { BlockSummary } from "../../lib/summary";

/** Below this many times the block's low end a rate is "near" it, and no multiple is printed. */
export const NEAR = 2;
/** At most this many parents are asked whether they were mined in the same block. */
export const PARENT_CHECKS = 8;

export interface FeeVerdict {
  /** `at`: no more than the low end, as printed; `near`: under {@link NEAR} times it; `above`. */
  kind: "at" | "near" | "above";
  /** The transaction's rate over the low end, unrounded. */
  ratio: number;
  /** The block's low end in sat/vB: its size-weighted 10th percentile rate, `p10`. */
  low: number;
  height: number;
}

/** A rate as {@link formatFeeRate} prints it, read back as a number. */
const printed = (rate: number): number => Number(formatFeeRate(rate).replaceAll(/[^\d.]/g, ""));

const usable = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);

/**
 * The verdict on `rate` against a block's low end, or undefined when it cannot be judged: a
 * missing or malformed figure, or a low end of 0 (a block whose cheapest tenth paid nothing has no
 * low end to be a multiple of).
 */
export function feeVerdict(
  rate: number | undefined,
  low: number | undefined,
  height: number,
): FeeVerdict | undefined {
  if (!usable(rate) || !usable(low) || rate < 0 || low <= 0) return undefined;
  const ratio = rate / low;
  // "At" by the printed figures, so it never contradicts the two numbers a reader sees.
  const kind = printed(rate) <= printed(low) ? "at" : ratio < NEAR ? "near" : "above";
  return { kind, ratio, low, height };
}

/**
 * A multiple, rounded down so it never claims more than it is: `2.49` → `2.4×`, `37.9` → `37×`,
 * `12345.6` → `12 345×`.
 */
export function formatMultiple(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return "–";
  if (ratio < 10) return `${(Math.floor(ratio * 10) / 10).toFixed(1)}×`;
  return `${groupDigits(Math.floor(ratio))}×`;
}

/** The verdict in a few words, for under the rate: short enough for one line on a phone. */
export function verdictText(v: FeeVerdict): string {
  if (v.kind === "at") return "At the low end";
  if (v.kind === "near") return "Near the low end";
  return `${formatMultiple(v.ratio)} the low end`;
}

/** The note's first line: the verdict said in full. */
export function verdictTitle(v: FeeVerdict): string {
  if (v.kind === "at") return "At its block's low end";
  if (v.kind === "near") return `Less than ${NEAR} times its block's low end`;
  return `${formatMultiple(v.ratio).replace("×", "")} times its block's low end`;
}

/** The note's second line: what the low end is, in words that are true of the figure. */
export function verdictDetail(v: FeeVerdict): string {
  return `The cheapest tenth of block ${groupDigits(v.height)}, by size, paid ${formatFeeRate(v.low)} sat/vB or less. Compared with this transaction's own rate.`;
}

/**
 * Whether any output was spent in `block` itself: a child mined with it, which may have paid for
 * it. A spender still unconfirmed is not, as long as the list was answered after `block` held this
 * transaction (the caller's to ensure). `undefined` when it cannot tell: no list, or a spend
 * without a status.
 */
export function childInBlock(
  spends: readonly Outspend[] | null | undefined,
  block: string,
): boolean | undefined {
  if (!spends) return undefined;
  let found = false;
  for (const s of spends) {
    if (!s.spent) continue;
    if (s.status === undefined) return undefined;
    if (!s.status.confirmed) continue;
    if (s.status.block_hash === undefined) return undefined;
    if (s.status.block_hash === block) found = true;
  }
  return found;
}

/** The distinct transactions its inputs spend, coinbase inputs left out. */
export function parentsOf(vin: readonly { txid: string; is_coinbase: boolean }[]): string[] {
  return [...new Set(vin.filter((i) => !i.is_coinbase).map((i) => i.txid))];
}

export interface JudgeInput {
  rate: number | undefined;
  block: string;
  parents: readonly string[];
  summary: () => Promise<BlockSummary | undefined>;
  spends: () => Promise<readonly Outspend[] | null | undefined>;
  status: (txid: string) => Promise<TxStatus>;
}

/**
 * The verdict for a confirmed transaction, or undefined whenever it could mislead. Its own rate is
 * compared, as the block's figures are own rates too; but a transaction mined with a relative in
 * the same block may have been mined for a package's rate, which the page does not know. A child
 * there (it may have paid for this one) hides every verdict; a parent there (this one may have paid
 * for it) hides all but "at", which a package's lower rate would still be. Asks the summary first,
 * then the spends, then the parents, and stops at the first reason to show nothing.
 */
export async function judgeFee(input: JudgeInput): Promise<FeeVerdict | undefined> {
  const summary = await input.summary();
  if (!summary || summary.id !== input.block) return undefined;
  const verdict = feeVerdict(input.rate, summary.fee_rate?.p10, summary.height);
  if (!verdict) return undefined;
  if (childInBlock(await input.spends(), input.block) !== false) return undefined;
  if (verdict.kind === "at") return verdict;
  if (input.parents.length > PARENT_CHECKS) return undefined;
  const statuses = await Promise.all(input.parents.map((p) => input.status(p)));
  const together = statuses.some((s) => !s.confirmed || s.block_hash === input.block);
  return together ? undefined : verdict;
}
