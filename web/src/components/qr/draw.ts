// How a QR code is drawn: soft modules that join their neighbours, rounded finders, room in the
// middle for the logo, and an ink that always scans (docs/DESIGN.md, "QR codes").
import { damage, encodeQr, type QrCode } from "../../lib/qr";

/** Light modules round the code, as the standard asks. */
export const QUIET = 4;
/** Corner radius of a data module, in modules: half is a dot on its own, a pill in a run. */
const R = 0.5;
/** At most this share of what a block can correct may be lost under the logo; the rest is margin. */
const DAMAGE_BUDGET = 0.5;
/** The clear square's side at most, as a share of the code's: beyond it the logo crowds the code. */
const MAX_CLEAR = 0.3;
/** The logo's units (its viewBox is 64 wide) per module when its block is a 5-module pattern. */
const CRAB_SCALE = 5 / 26;

/**
 * Where the logo goes. `logo`: the whole mark in a clear square, for a code with no alignment
 * pattern in its middle (versions 1 to 6). `crab`: from version 8, the code's middle alignment
 * pattern stays, as decoders look for it there and took the logo for it, and becomes the block the
 * crab lifts: the crab is drawn round and under it, the arriving layer above.
 */
export type Mark =
  | { kind: "logo"; hidden: (x: number, y: number) => boolean; x: number; size: number }
  | { kind: "crab"; hidden: (x: number, y: number) => boolean; x: number; scale: number };

/**
 * The code for `text` at level Q: the smallest one with room for the logo, at most two versions
 * past the smallest that holds it (a version 7 code becomes an 8 or a 9: it has the middle
 * alignment pattern but too few codewords to spare the crab's room). Without room, the smallest.
 */
export function codeFor(text: string): QrCode | null {
  const first = encodeQr(text, "Q");
  if (!first) return null;
  for (let v = first.version; v <= first.version + 2; v++) {
    const code = v === first.version ? first : encodeQr(text, "Q", { minVersion: v });
    if (code && markFor(code)) return code;
  }
  return first;
}

/** Whether the middle module is an alignment pattern's centre (versions 7 to 13, 21 to 27…). */
function middleAlignment(code: QrCode): boolean {
  const v = code.version;
  return v >= 7 && (Math.floor(v / 7) + 2) % 2 === 1;
}

/**
 * Room for the logo that no block pays more than half of what it can correct for, so half is left
 * for the camera; null when there is none (a code too long, or one with alignment patterns around
 * its middle, versions 14 and up, which these pages never reach).
 */
export function markFor(code: QrCode): Mark | null {
  const m = (code.size - 1) / 2;
  if (code.version <= 6) {
    const max = Math.floor(code.size * MAX_CLEAR);
    for (let side = max % 2 === 0 ? max - 1 : max; side >= 5; side -= 2) {
      const from = (code.size - side) / 2;
      const hidden = (x: number, y: number) =>
        x >= from && x < from + side && y >= from && y < from + side;
      if (damage(code, hidden) <= DAMAGE_BUDGET)
        // The logo stays three quarters of a module inside the square.
        return { kind: "logo", hidden, x: from + QUIET + 0.75, size: side - 1.5 };
    }
    return null;
  }
  if (!middleAlignment(code)) return null;
  // Relative to the middle module: the crab's claws and legs, six modules either side and nine
  // below; the arriving layer one row above the pattern, right of its middle.
  const hidden = (x: number, y: number) => {
    const dx = x - m;
    const dy = y - m;
    if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) return false;
    return (Math.abs(dx) <= 6 && dy >= -2 && dy <= 9) || (dy === -3 && dx >= -1 && dx <= 3);
  };
  if (damage(code, hidden) > DAMAGE_BUDGET) return null;
  return { kind: "crab", hidden, x: m + QUIET + 0.5, scale: CRAB_SCALE };
}

/** Whether (x, y) is in one of the three finders, which are drawn as shapes of their own. */
const inFinder = (size: number, x: number, y: number) =>
  (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * The data modules as one path, in modules with the quiet zone's offset: each dark module a square
 * whose corners round where both its neighbours on that corner are light, so runs read as pills and
 * clumps as blobs, with a small fillet in each inside corner so the joins are smooth too.
 */
export function modulesPath(code: QrCode, mark: Mark | null): string {
  const { size } = code;
  const dark = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < size &&
    y < size &&
    code.dark[y * size + x] === 1 &&
    !inFinder(size, x, y) &&
    !(mark?.hidden(x, y) ?? false);
  const parts: string[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const X = x + QUIET;
      const Y = y + QUIET;
      if (dark(x, y)) {
        const up = dark(x, y - 1);
        const down = dark(x, y + 1);
        const left = dark(x - 1, y);
        const right = dark(x + 1, y);
        const tl = up || left ? 0 : R;
        const tr = up || right ? 0 : R;
        const br = down || right ? 0 : R;
        const bl = down || left ? 0 : R;
        let d = `M${n(X + tl)} ${n(Y)}H${n(X + 1 - tr)}`;
        if (tr) d += `a${R} ${R} 0 0 1 ${R} ${R}`;
        d += `V${n(Y + 1 - br)}`;
        if (br) d += `a${R} ${R} 0 0 1 -${R} ${R}`;
        d += `H${n(X + bl)}`;
        if (bl) d += `a${R} ${R} 0 0 1 -${R} -${R}`;
        d += `V${n(Y + tl)}`;
        if (tl) d += `a${R} ${R} 0 0 1 ${R} -${R}`;
        parts.push(`${d}Z`);
        continue;
      }
      // A light module between two dark ones that meet round a dark corner: fill that corner.
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        if (!dark(x + dx, y) || !dark(x, y + dy) || !dark(x + dx, y + dy)) continue;
        const cx = X + (dx > 0 ? 1 : 0);
        const cy = Y + (dy > 0 ? 1 : 0);
        // From the corner along the row, round the arc's centre (inside this module), back to the
        // corner along the column.
        const sweep = dx * dy > 0 ? 0 : 1;
        parts.push(
          `M${n(cx)} ${n(cy)}h${n(-dx * R)}a${R} ${R} 0 0 ${sweep} ${n(dx * R)} ${n(-dy * R)}Z`,
        );
      }
    }
  return parts.join("");
}

/** A rounded rectangle as a path, `r` its corner radius. */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}a${r} ${r} 0 0 1 ${r} ${r}V${n(y + h - r)}` +
    `a${r} ${r} 0 0 1 -${r} ${r}H${n(x + r)}a${r} ${r} 0 0 1 -${r} -${r}V${n(y + r)}` +
    `a${r} ${r} 0 0 1 ${r} -${r}Z`
  );
}

/**
 * The three finders: a ring and a pupil each, their corners rounded by three quarters of a module
 * at most, as rounder ones lost OpenCV's detector. The ring is two outlines, filled even-odd; a
 * finder keeps its 1:1:3:1:1 proportions across its middle, which decoders look for.
 */
export function findersPath(size: number): string {
  return [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]
    .map(([fx = 0, fy = 0]) => {
      const x = fx + QUIET;
      const y = fy + QUIET;
      return (
        roundRect(x, y, 7, 7, 0.75) +
        roundRect(x + 1, y + 1, 5, 5, 0.5) +
        roundRect(x + 2, y + 2, 3, 3, 0.4)
      );
    })
    .join("");
}

// Colour: WCAG's relative luminance, as src/styles/contrast.test.ts measures the tokens.

/** The least contrast between ink and paper. 4.5:1 is the site's own bar for text. */
export const MIN_CONTRAST = 4.5;

type Rgb = readonly [number, number, number];
const toLinear = (c: number) => (c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.003_130_8 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** `#rgb` or `#rrggbb`, and nothing else; null otherwise. */
export function parseHex(text: string): Rgb | null {
  const s = text.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s))
    return [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as unknown as Rgb;
  if (/^#[0-9a-f]{3}$/.test(s))
    return [1, 2, 3].map((i) => Number.parseInt(s.charAt(i).repeat(2), 16)) as unknown as Rgb;
  return null;
}

const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((v) => toLinear(v / 255));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};
export const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The colour with its light (linear RGB) multiplied by `k`. */
const scale = (c: Rgb, k: number): Rgb =>
  c.map((v) => Math.round(toSrgb(toLinear(v / 255) * k) * 255)) as unknown as Rgb;

export interface Ink {
  /** `#rrggbb`, to draw with. */
  colour: string;
  /** What became of the colour asked for. */
  from: "colour" | "darkened" | "fallback";
}

/**
 * The ink for a code on `paper`: `wanted` as it is when it reaches `MIN_CONTRAST`, darkened just
 * enough when it does not (its light scaled down evenly, so its hue and saturation stay), and
 * `fallback` when it is not a colour at all or the paper is not light enough to darken against.
 */
export function inkFor(wanted: string | null, paper: string, fallback: string): Ink {
  const p = parseHex(paper);
  const w = wanted === null ? null : parseHex(wanted);
  if (!p || !w || !/^#[0-9a-f]{6}$/i.test(wanted ?? ""))
    return { colour: fallback, from: "fallback" };
  if (contrast(w, p) >= MIN_CONTRAST) return { colour: hex(w), from: "colour" };
  // The luminance that just reaches the bar against this paper.
  const target = (luminance(p) + 0.05) / MIN_CONTRAST - 0.05;
  if (target <= 0) return { colour: fallback, from: "fallback" };
  // Scaling all three linear channels scales luminance by the same factor.
  const first = target / luminance(w);
  // Rounding to whole steps can land a hair short: then a little darker, a few times.
  for (const k of [1, 0.98, 0.96, 0.94, 0.92].map((f) => first * f)) {
    const c = scale(w, k);
    if (contrast(c, p) >= MIN_CONTRAST) return { colour: hex(c), from: "darkened" };
  }
  return { colour: fallback, from: "fallback" };
}
