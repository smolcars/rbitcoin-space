// Number, size, hash and time formatting, as specified in docs/DESIGN.md ("Numbers", "Time").
// Pure functions that return strings or string parts; components turn them into text nodes.

/** Narrow no-break space: groups digits so a number never wraps. */
export const NNBSP = " ";
/** Shown where a value is missing or malformed. */
export const MISSING = "–";

const SATS_PER_BTC = 100_000_000;

/** Groups an integer's digits in threes: `975411` → `975 411`. Non-integers are rounded first. */
export function groupDigits(n: number): string {
  if (!Number.isFinite(n)) return MISSING;
  const rounded = Math.round(n);
  const digits = Math.abs(rounded)
    .toString()
    .replaceAll(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  return rounded < 0 ? `−${digits}` : digits;
}

const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/**
 * A number too small or too large to write out, with `digits` significant digits and its power
 * of ten: `4.6566 × 10⁻¹⁰` (regtest's difficulty). Trailing zeros are dropped: `1 × 10³⁰`.
 */
export function formatPowerOfTen(n: number, digits = 3): string {
  if (!Number.isFinite(n) || n === 0) return MISSING;
  const [mantissa = "", exponent = ""] = Math.abs(n)
    .toExponential(digits - 1)
    .split("e");
  const m = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
  const e = Number(exponent);
  const power = Math.abs(e)
    .toString()
    .replaceAll(/\d/g, (d) => SUPERSCRIPTS[Number(d)] ?? "");
  return `${n < 0 ? "−" : ""}${m}${NNBSP}×${NNBSP}10${e < 0 ? "⁻" : ""}${power}`;
}

/** BTC split into parts so the trailing zeros can be dimmed. */
export interface BtcParts {
  /** `"−"` or `""`. */
  sign: string;
  /** Whole bitcoins, grouped in threes. */
  whole: string;
  /** The grouped decimals up to the last non-zero digit: `00 012 5`. */
  significant: string;
  /** The rest of the eight grouped decimals, all zeros and group spaces: `00`. */
  zeros: string;
}

/**
 * Eight decimals grouped as sats read: 2 + 3 + 3 (`00 012 500`), so the last six digits are the
 * sats under a hundred thousand, grouped as `formatSats` groups them.
 */
function groupFraction(eight: string): string {
  return `${eight.slice(0, 2)}${NNBSP}${eight.slice(2, 5)}${NNBSP}${eight.slice(5)}`;
}

/**
 * Splits an amount in sats into BTC parts with all eight decimals, grouped (`1 234.56 789 012`).
 * Integer arithmetic only, so there is never a floating-point error. Returns null for anything
 * that is not a safe integer.
 */
export function btcParts(sats: number): BtcParts | null {
  if (!Number.isSafeInteger(sats)) return null;
  const abs = Math.abs(sats);
  const fraction = groupFraction((abs % SATS_PER_BTC).toString().padStart(8, "0"));
  const significant = fraction.replace(/[0\u202F]+$/, "");
  return {
    sign: sats < 0 ? "−" : "",
    whole: groupDigits(Math.floor(abs / SATS_PER_BTC)),
    significant,
    zeros: fraction.slice(significant.length),
  };
}

/** BTC as text with all eight decimals, grouped: `0.03 500 000`. Never rounded. */
export function formatBtc(sats: number): string {
  const p = btcParts(sats);
  return p ? `${p.sign}${p.whole}.${p.significant}${p.zeros}` : MISSING;
}

/**
 * BTC as a program reads it, for the clipboard: digits and a point, eight decimals, no grouping
 * and no unit (`5954.38071385`). A wallet or a spreadsheet may refuse the page's grouping space.
 */
export function plainBtc(sats: number): string {
  if (!Number.isSafeInteger(sats)) return MISSING;
  const abs = Math.abs(sats);
  const fraction = String(abs % SATS_PER_BTC).padStart(8, "0");
  return `${sats < 0 ? "-" : ""}${Math.floor(abs / SATS_PER_BTC)}.${fraction}`;
}

/**
 * A chart's BTC scale, where a tick is a round step, not an amount: whole bitcoins grouped, the
 * decimals it needs and no more, ungrouped (`0.025`, `1 200`). Never for an amount itself.
 */
export function formatBtcScale(sats: number): string {
  if (!Number.isSafeInteger(sats)) return MISSING;
  const abs = Math.abs(sats);
  const fraction = String(abs % SATS_PER_BTC)
    .padStart(8, "0")
    .replace(/0+$/, "");
  const whole = groupDigits(Math.floor(abs / SATS_PER_BTC));
  return `${sats < 0 ? "−" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * BTC in magnitude, for a chart axis's ticks only (a scale, not an amount): whole bitcoins from
 * 1 000 (`2 799`), two decimals from 1 (`3.15`), three significant digits below (`0.0225`).
 * Every amount a reader is shown is exact ({@link formatBtc}).
 */
export function formatBtcShort(sats: number): string {
  if (!Number.isSafeInteger(sats)) return MISSING;
  const btc = Math.abs(sats) / SATS_PER_BTC;
  const sign = sats < 0 ? "−" : "";
  if (btc === 0) return "0";
  if (btc >= 999.5) return sign + groupDigits(btc);
  if (btc >= 0.9995) return sign + btc.toFixed(2);
  // Three significant digits, never written as a power of ten.
  const decimals = Math.min(8, 2 - Math.floor(Math.log10(btc)));
  return sign + btc.toFixed(decimals);
}

/** sats as a grouped integer: `167`, `1 250 000`. */
export function formatSats(sats: number): string {
  return Number.isSafeInteger(sats) ? groupDigits(sats) : MISSING;
}

/**
 * Rounds to `decimals` places half away from zero, as a person would. The product is first cut to
 * 12 significant digits so float noise (1.005 is stored as 1.00499…) does not round down.
 */
function roundScaled(x: number, decimals: number): number {
  return Math.round(Number((x * 10 ** decimals).toPrecision(12)));
}

/**
 * Fee rate as printed: two decimals under 10, one under 100, none above. Decides on the rounded
 * value, so 9.996 prints as `10.0`, not `10.00`.
 */
export function formatFeeRate(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return MISSING;
  const hundredths = roundScaled(rate, 2);
  if (hundredths < 1000) return (hundredths / 100).toFixed(2);
  const tenths = roundScaled(rate, 1);
  if (tenths < 1000) return (tenths / 10).toFixed(1);
  return groupDigits(rate);
}

/**
 * A recommended fee rate, printed as {@link formatFeeRate} prints but rounded up, never down, so the
 * figure shown is never less than the rate it stands for: `0.133` → `0.14`, `12.51` → `12.6`.
 */
export function formatFeeRateUp(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return MISSING;
  const up = (decimals: number) => Math.ceil(Number((rate * 10 ** decimals).toPrecision(12)));
  const hundredths = up(2);
  if (hundredths < 1000) return (hundredths / 100).toFixed(2);
  const tenths = up(1);
  if (tenths < 1000) return (tenths / 10).toFixed(1);
  return groupDigits(Math.ceil(Number(rate.toPrecision(12))));
}

/** Fee rate in sat/vB from a fee in sats and a size in vB, or null when the size is not positive. */
export function feeRate(feeSats: number, vsize: number): number | null {
  return vsize > 0 && Number.isFinite(feeSats) ? feeSats / vsize : null;
}

/** Virtual size from weight units: weight / 4, rounded up, as Core counts it. */
export function vsizeFromWeight(weight: number): number {
  return Math.ceil(weight / 4);
}

/** Lower bounds (sat/vB) of fee bands 2–12; band 1 is everything below 0.12. docs/DESIGN.md "Fee scale". */
export const FEE_BOUNDS = [0.12, 0.15, 0.2, 0.3, 0.5, 1, 1.5, 2, 3, 5, 10] as const;
/** Lower bound of each of the twelve bands, for the fee key. */
export const FEE_KEY_BOUNDS = [0.1, ...FEE_BOUNDS] as const;
/** How many fee bands there are. */
export const FEE_BANDS = FEE_KEY_BOUNDS.length;
/** A block or minute stored before the lowest band was split in three has ten, all under 0.2 first. */
export const UNSPLIT_BANDS = 10;

/**
 * Twelve bands from a server answer of twelve, or of ten from before the lowest band was split
 * (docs/API.md): then everything under 0.2 sat/vB stays whole, in the first slot, `unsplit`.
 */
export function widenBands(bands: readonly number[]): { bands: number[]; unsplit: boolean } {
  if (bands.length !== UNSPLIT_BANDS) return { bands: [...bands], unsplit: false };
  return { bands: [bands[0] ?? 0, 0, 0, ...bands.slice(1)], unsplit: true };
}

/**
 * The fee band (1–12) of a rate, taken from the rate as printed, so the color always agrees with
 * the number beside it: 0.1996 prints as `0.20` and takes band 2.
 */
export function feeBand(rate: number, print: (rate: number) => string = formatFeeRate): number {
  const printed = Number(print(rate).replaceAll(NNBSP, ""));
  if (!Number.isFinite(printed)) return 1;
  const i = FEE_BOUNDS.findIndex((bound) => printed < bound);
  return i === -1 ? FEE_BANDS : i + 1;
}

/** The CSS color for a rate's band. */
export function feeColor(rate: number, print?: (rate: number) => string): string {
  return `var(--fee-${feeBand(rate, print)})`;
}

/**
 * Size: grouped units under 10 000, then k and M with two decimals: `209 vB`, `14.62 MvB`.
 * `unit` is the base unit (`vB`, `B`, `WU`).
 */
export function formatSize(n: number, unit = "vB"): string {
  if (!Number.isFinite(n) || n < 0) return MISSING;
  if (Math.round(n) < 10_000) return `${groupDigits(n)} ${unit}`;
  const kilo = roundScaled(n / 1000, 2);
  if (kilo < 100_000) return `${(kilo / 100).toFixed(2)} k${unit}`;
  return `${(roundScaled(n / 1_000_000, 2) / 100).toFixed(2)} M${unit}`;
}

/**
 * Shortens a hash or address in the middle: `a3f9c2e1…7b0d44e9`. Values that would barely shrink
 * are returned whole.
 */
export function truncateMiddle(value: string, head = 8, tail = 8): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** Splits a hash into groups of eight characters, for showing it whole. */
export function hashGroups(value: string): string[] {
  return value.match(/.{1,8}/g) ?? [];
}

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * A moment in UTC as every page writes one: `11 Nov 2026, 20:41:07 UTC`, or to the minute
 * (`11 Nov 2026, 20:41 UTC`) where seconds would claim more than the figure knows.
 */
export function formatUtc(unixSeconds: number, seconds = true): string {
  const d = new Date(unixSeconds * 1000);
  if (!Number.isFinite(d.getTime())) return MISSING;
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${seconds ? `:${two(d.getUTCSeconds())}` : ""}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}, ${time} UTC`;
}

/** ISO 8601 for a `<time datetime>` attribute. */
export function isoTime(unixSeconds: number): string | undefined {
  const d = new Date(unixSeconds * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/**
 * Relative time from unix seconds to now (also seconds): `just now`, `42 s ago`, `13 min ago`,
 * `2 h 5 min ago`, `3 days ago`. With `suffix: false` the "ago" is dropped (block tiles), and a
 * time in the future (clock skew) reads as "just now".
 */
export function formatRelative(
  unixSeconds: number,
  nowSeconds: number,
  { suffix = true }: { suffix?: boolean } = {},
): string {
  if (!Number.isFinite(unixSeconds) || !Number.isFinite(nowSeconds)) return MISSING;
  const s = Math.max(0, Math.round(nowSeconds - unixSeconds));
  if (s < 10) return "just now";
  const ago = suffix ? " ago" : "";
  if (s < 60) return `${s} s${ago}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${ago}`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h${ago}` : `${h} h ${m % 60} min${ago}`;
  // From a day on, days lead: "1 day 23 h", and from a week, days alone.
  const d = Math.floor(h / 24);
  // Grouped as every integer on the site is: an old block reads "1 216 days ago".
  const days = `${groupDigits(d)} ${d === 1 ? "day" : "days"}`;
  if (d >= 7 || h % 24 === 0) return `${days}${ago}`;
  return `${days} ${h % 24} h${ago}`;
}

/**
 * The time between two blocks, from seconds: `42 s`, `9 min 12 s`, `2 h 5 min`, `1 day 3 h`. A
 * block's clock may sit before its parent's, so a negative span keeps its sign: `−2 min 5 s`.
 */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds)) return MISSING;
  const t = Math.round(seconds);
  const sign = t < 0 ? "−" : "";
  const s = Math.abs(t);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const parts =
    s < 60
      ? [`${s} s`]
      : m < 60
        ? [`${m} min`, s % 60 === 0 ? "" : `${s % 60} s`]
        : h < 24
          ? [`${h} h`, m % 60 === 0 ? "" : `${m % 60} min`]
          : [`${d} ${d === 1 ? "day" : "days"}`, h % 24 === 0 ? "" : `${h % 24} h`];
  return sign + parts.filter(Boolean).join(" ");
}

/** Why a block can be timed before its parent: the note on such a time (table and strip). */
export const EARLY_NOTE =
  "Each miner sets its block's time from its own clock. The network allows some drift, so a block can be timed before the one it follows.";

/** The note's first line for a block timed `seconds` (negative) before its parent at `parent`. */
export function timedBefore(seconds: number, parent: number): string {
  return `Timed ${formatInterval(-seconds)} before block ${groupDigits(parent)}`;
}
