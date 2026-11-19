// How a QR code is drawn: soft modules that join their neighbours, rounded finders, room in the
// middle for the logo, and an ink that always scans (docs/DESIGN.md, "QR codes").
import { damage, encodeQr, type QrCode } from "../../lib/qr";

/** Light modules round the code, as the standard asks. */
export const QUIET = 4;
/**
 * Corner radius of a soft data module, in modules: a soft square on its own, a rounded run or blob
 * with its neighbours. Half a module (round dots) cost OpenCV's detector a code now and then at
 * about 4 px a module; 0.4 read every one tried (docs/FRONTEND.md, "QR codes").
 */
const R = 0.4;
/**
 * The drawing follows from the px a module gets on the card as it is drawn: the logo from
 * `LOGO_MIN_PX`, soft modules and finder pupils from `SOFT_MIN_PX`, and below that a plain code
 * (square modules and finders, no logo), as a dense code on a small card must scan before it looks
 * good. Both bounds are measured against a plain control (docs/FRONTEND.md, "QR codes").
 */
export const LOGO_MIN_PX = 4.75;
export const SOFT_MIN_PX = 4.62;
/** At most this share of what a block can correct may be lost under the logo; the rest is margin. */
const DAMAGE_BUDGET = 0.5;
/** The clear square's side at most, as a share of the code's: beyond it the logo crowds the code. */
const MAX_CLEAR = 0.3;
/**
 * Modules per unit of the logo's 64-unit box for the crab round the middle pattern: 85% of the
 * scale at which its block would be the 5-module pattern, which leaves white between the crab and
 * the modules round it. Drawn at full scale, OpenCV's detector lost the longest connect string.
 */
const CRAB_SCALE = (5 / 26) * 0.85;

/**
 * Where the logo goes. `logo`: the whole mark in a clear square, for a code with no alignment
 * pattern in its middle (versions 1 to 6). `crab`: from version 8, the code's middle alignment
 * pattern stays, as decoders look for it there and took the logo for it, and becomes the block the
 * crab lifts: the crab is drawn round and under it, the arriving layer above.
 */
export type Mark =
  | { kind: "logo"; hidden: (x: number, y: number) => boolean; x: number; size: number }
  | { kind: "crab"; hidden: (x: number, y: number) => boolean; x: number; scale: number };

/** The px a module of `code` gets on a card `px` wide, quiet zone included. */
export const pxPerModule = (code: QrCode, px: number): number => px / (code.size + 2 * QUIET);

/** How a code is drawn: its modules, the logo's room if it has one, and whether it is soft. */
export interface Drawing {
  code: QrCode;
  mark: Mark | null;
  soft: boolean;
}

/**
 * The drawing of `text` at level Q on a card `px` wide. The code is the smallest that holds it, or
 * at most two versions past it where that one has room for the logo and the px for it (a version 7
 * code becomes an 8 or a 9: it has the middle alignment pattern but too few codewords to spare the
 * crab's room).
 */
export function drawingFor(text: string, px: number): Drawing | null {
  const first = encodeQr(text, "Q");
  if (!first) return null;
  let code = first;
  let mark = markFor(first, px);
  for (let v = first.version + 1; !mark && v <= first.version + 2; v++) {
    const next = encodeQr(text, "Q", { minVersion: v });
    const room = next && markFor(next, px);
    if (next && room) {
      code = next;
      mark = room;
    }
  }
  return { code, mark, soft: pxPerModule(code, px) >= SOFT_MIN_PX };
}

/** Whether the middle module is an alignment pattern's centre: versions 7 to 13, 21 to 27, 35 to 40. */
function middleAlignment(code: QrCode): boolean {
  const v = code.version;
  return v >= 7 && (Math.floor(v / 7) + 2) % 2 === 1;
}

/**
 * Room for the logo on a card `px` wide that no block pays more than half of what it can correct
 * for, so half is left for the camera; null when there is none: a code too dense for the card (under
 * `LOGO_MIN_PX` a module), one whose blocks cannot spare the room, or version 14 and up.
 */
export function markFor(code: QrCode, px: number): Mark | null {
  // From 14 the middle has no pattern of its own (14 to 20) or the room crosses others (21 and up).
  if (code.version >= 14) return null;
  if (pxPerModule(code, px) < LOGO_MIN_PX) return null;
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
 * The data modules as one path, in modules with the quiet zone's offset. Soft: each dark module a
 * square whose corners round where both its neighbours on that corner are light, so runs read as
 * pills and clumps as blobs, with a small fillet in each inside corner so the joins are smooth too.
 * Not soft: plain squares.
 */
export function modulesPath(code: QrCode, mark: Mark | null, soft = true): string {
  const r = soft ? R : 0;
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
        const tl = up || left ? 0 : r;
        const tr = up || right ? 0 : r;
        const br = down || right ? 0 : r;
        const bl = down || left ? 0 : r;
        let d = `M${n(X + tl)} ${n(Y)}H${n(X + 1 - tr)}`;
        if (tr) d += `a${r} ${r} 0 0 1 ${r} ${r}`;
        d += `V${n(Y + 1 - br)}`;
        if (br) d += `a${r} ${r} 0 0 1 -${r} ${r}`;
        d += `H${n(X + bl)}`;
        if (bl) d += `a${r} ${r} 0 0 1 -${r} -${r}`;
        d += `V${n(Y + tl)}`;
        if (tl) d += `a${r} ${r} 0 0 1 ${r} -${r}`;
        parts.push(`${d}Z`);
        continue;
      }
      if (!soft) continue;
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

/** A rounded rectangle as a path, `r` its corner radius (0 for square corners). */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  if (r === 0) return `M${n(x)} ${n(y)}h${w}v${h}h${-w}Z`;
  return (
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}a${r} ${r} 0 0 1 ${r} ${r}V${n(y + h - r)}` +
    `a${r} ${r} 0 0 1 -${r} ${r}H${n(x + r)}a${r} ${r} 0 0 1 -${r} -${r}V${n(y + r)}` +
    `a${r} ${r} 0 0 1 ${r} -${r}Z`
  );
}

/**
 * The three finders: soft, a nearly square ring round a soft pupil; or square. OpenCV's detector
 * misread codes whose rings were rounded by a quarter of a module or more, at the sizes the pop-up
 * draws them, and read every one with these (docs/FRONTEND.md, "QR codes"). The ring is two
 * outlines, filled even-odd; a finder keeps its 1:1:3:1:1 proportions across its middle, which
 * decoders look for.
 */
export function findersPath(size: number, soft = true): string {
  const [ring, pupil] = soft ? [0.1, 0.75] : [0, 0];
  return [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]
    .map(([fx = 0, fy = 0]) => {
      const x = fx + QUIET;
      const y = fy + QUIET;
      return (
        roundRect(x, y, 7, 7, ring) +
        roundRect(x + 1, y + 1, 5, 5, ring) +
        roundRect(x + 2, y + 2, 3, 3, pupil)
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
