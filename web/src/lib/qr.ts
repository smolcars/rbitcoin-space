// A QR code encoder (ISO/IEC 18004), byte mode only: text in, a square of dark and light modules
// out. Written here rather than taken as a dependency (docs/FRONTEND.md, "QR codes").

/** Error correction: about 7, 15, 25 and 30% of the codewords can be restored. */
export type Level = "L" | "M" | "Q" | "H";

export interface QrCode {
  version: number;
  level: Level;
  /** Modules on a side, without the quiet zone. */
  size: number;
  mask: number;
  /** Row by row, 1 for dark: `dark[y * size + x]`. */
  dark: Uint8Array;
}

/** The two bits each level writes into the format information. */
const FORMAT_BITS: Record<Level, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Per level, per version 1 to 40: error correction codewords in each block, and how many blocks.
// oxfmt-ignore
const EC_PER_BLOCK: Record<Level, readonly number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
// oxfmt-ignore
const BLOCKS: Record<Level, readonly number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Codewords a version holds: every module that is not a function pattern, in bytes. */
function totalCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    modules -= (25 * n - 10) * n - 55;
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function ecInfo(version: number, level: Level): { ec: number; blocks: number } {
  return { ec: EC_PER_BLOCK[level][version - 1] ?? 0, blocks: BLOCKS[level][version - 1] ?? 1 };
}

function dataCodewords(version: number, level: Level): number {
  const { ec, blocks } = ecInfo(version, level);
  return totalCodewords(version) - ec * blocks;
}

/** Centres of the alignment patterns on each axis. */
function alignmentCentres(version: number): number[] {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const last = version * 4 + 10;
  const step = version === 32 ? 26 : Math.ceil((last - 6) / (n - 1) / 2) * 2;
  const out = [6];
  for (let at = last; out.length < n; at -= step) out.splice(1, 0, at);
  return out;
}

// Arithmetic in GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}
const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0);

/** The Reed-Solomon generator of `degree`, highest power first, its leading 1 left out. */
function generator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = EXP[i] ?? 0;
    for (const [j, c] of poly.entries()) {
      next[j] = (next[j] ?? 0) ^ c;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(c, root);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** The error correction codewords for one block of data. */
function remainder(data: Uint8Array, gen: Uint8Array): Uint8Array {
  const rem = new Uint8Array(gen.length);
  for (const byte of data) {
    const factor = byte ^ (rem[0] ?? 0);
    rem.copyWithin(0, 1);
    rem[rem.length - 1] = 0;
    for (const [i, g] of gen.entries()) rem[i] = (rem[i] ?? 0) ^ mul(g, factor);
  }
  return rem;
}

/** The data codewords: mode, count, the bytes, a terminator and padding. */
function dataBits(bytes: Uint8Array, version: number, capacity: number): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    out[i / 8] = byte;
  }
  for (let i = bits.length / 8, pad = 0xec; i < capacity; i++, pad ^= 0xec ^ 0x11) out[i] = pad;
  return out;
}

/** Splits the data into blocks, adds each block's error correction, and interleaves them. */
function codewords(data: Uint8Array, version: number, level: Level): Uint8Array {
  const { ec, blocks } = ecInfo(version, level);
  const total = totalCodewords(version);
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks) - ec;
  const gen = generator(ec);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let at = 0;
  for (let b = 0; b < blocks; b++) {
    const length = shortLength + (b < shortBlocks ? 0 : 1);
    const block = data.slice(at, at + length);
    at += length;
    dataBlocks.push(block);
    ecBlocks.push(remainder(block, gen));
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLength; i++)
    for (const block of dataBlocks) if (i < block.length) out.push(block[i] ?? 0);
  for (let i = 0; i < ec; i++) for (const block of ecBlocks) out.push(block[i] ?? 0);
  return new Uint8Array(out);
}

/** A BCH code: `value` followed by its remainder by `poly` (of degree `degree`). */
function bch(value: number, poly: number, degree: number): number {
  let rem = value << degree;
  for (let i = 31 - Math.clz32(rem); i >= degree; i--)
    if ((rem >>> i) & 1) rem ^= poly << (i - degree);
  return (value << degree) | rem;
}

const MASKS: readonly ((y: number, x: number) => boolean)[] = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

/** A symbol under construction: its modules and which of them are function patterns. */
class Grid {
  readonly size: number;
  readonly dark: Uint8Array;
  readonly fixed: Uint8Array;
  constructor(size: number) {
    this.size = size;
    this.dark = new Uint8Array(size * size);
    this.fixed = new Uint8Array(size * size);
  }
  set(x: number, y: number, on: boolean): void {
    this.dark[y * this.size + x] = on ? 1 : 0;
    this.fixed[y * this.size + x] = 1;
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const { size } = g;
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  // Finders with their separators: rings by distance from the centre.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
  const centres = alignmentCentres(version);
  const last = centres.length - 1;
  for (const [i, cy] of centres.entries())
    for (const [j, cx] of centres.entries()) {
      // The three corners a finder already holds.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          g.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  // Reserve the format areas (drawn for real once the mask is chosen) and the dark module.
  drawFormat(g, 0, "L");
  if (version >= 7) {
    const bits = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, on);
      g.set(b, a, on);
    }
  }
}

function drawFormat(g: Grid, mask: number, level: Level): void {
  const { size } = g;
  const bits = bch((FORMAT_BITS[level] << 3) | mask, 0x537, 10) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, bit(i));
  g.set(8, size - 8, true);
}

/** Lays the codewords' bits up and down the two-module columns, right to left. */
function drawCodewords(g: Grid, data: Uint8Array): void {
  const { size } = g;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (g.fixed[y * size + x] === 1) continue;
        const byte = data[i >>> 3] ?? 0;
        g.dark[y * size + x] = (byte >>> (7 - (i & 7))) & 1;
        i++;
      }
    }
  }
}

function applyMask(g: Grid, mask: number): void {
  const test = MASKS[mask];
  if (!test) return;
  const { size } = g;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = y * size + x;
      if (g.fixed[at] === 0 && test(y, x)) g.dark[at] = (g.dark[at] ?? 0) ^ 1;
    }
}

/** Penalty for runs of five or more modules of one colour in a line: 3, and 1 for each beyond. */
function runs(size: number, get: (x: number) => number): number {
  let score = 0;
  let run = 1;
  for (let x = 1; x <= size; x++) {
    if (x < size && get(x) === get(x - 1)) run++;
    else {
      if (run >= 5) score += run - 2;
      run = 1;
    }
  }
  return score;
}

/** The standard's penalty for a masked symbol: runs, boxes, finder lookalikes and balance. */
function penalty(dark: Uint8Array, size: number): number {
  let score = 0;
  const at = (x: number, y: number) => dark[y * size + x] ?? 0;
  const finder = [1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    const get = pass === 0 ? at : (x: number, y: number) => at(y, x);
    for (let y = 0; y < size; y++) {
      score += runs(size, (x) => get(x, y));
      // 1:1:3:1:1 with four light modules on one side; the quiet zone counts as light.
      const light = (x: number) => x < 0 || x >= size || get(x, y) === 0;
      for (let x = 0; x + 7 <= size; x++) {
        if (!finder.every((v, k) => get(x + k, y) === v)) continue;
        const lightBefore = [1, 2, 3, 4].every((k) => light(x - k));
        const lightAfter = [7, 8, 9, 10].every((k) => light(x + k));
        if (lightBefore) score += 40;
        if (lightAfter) score += 40;
      }
    }
  }
  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
  let darkCount = 0;
  for (const d of dark) darkCount += d;
  const total = size * size;
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return score;
}

/** The smallest version from `minVersion` up that holds `length` bytes at `level`, or null. */
export function fitVersion(length: number, level: Level, minVersion = 1): number | null {
  for (let v = Math.max(1, minVersion); v <= 40; v++) {
    const bits = 4 + (v <= 9 ? 8 : 16) + length * 8;
    if (bits <= dataCodewords(v, level) * 8) return v;
  }
  return null;
}

/**
 * Encodes text in byte mode as its UTF-8 bytes, with no ECI header to declare that character set
 * (readers that assume ISO 8859-1 show anything past ASCII wrongly; the pages pass ASCII only), in
 * the smallest version from `minVersion` that holds it. Null when it is too long for any version. `mask` forces one of the eight masks; otherwise the
 * one with the least penalty is chosen.
 */
export function encodeQr(
  text: string,
  level: Level = "Q",
  options: { minVersion?: number; mask?: number } = {},
): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  const version = fitVersion(bytes.length, level, options.minVersion);
  if (version === null) return null;
  const data = codewords(dataBits(bytes, version, dataCodewords(version, level)), version, level);
  const size = version * 4 + 17;
  const base = new Grid(size);
  drawFunctionPatterns(base, version);
  drawCodewords(base, data);
  const candidates =
    options.mask !== undefined && options.mask >= 0 && options.mask < 8
      ? [options.mask]
      : [0, 1, 2, 3, 4, 5, 6, 7];
  let best: { mask: number; dark: Uint8Array; score: number } | undefined;
  for (const mask of candidates) {
    const g = new Grid(size);
    g.dark.set(base.dark);
    g.fixed.set(base.fixed);
    applyMask(g, mask);
    drawFormat(g, mask, level);
    const score = candidates.length === 1 ? 0 : penalty(g.dark, size);
    if (!best || score < best.score) best = { mask, dark: g.dark, score };
  }
  if (!best) return null;
  return { version, level, size, mask: best.mask, dark: best.dark };
}

/** Which block each codeword belongs to, in the order they are laid in the symbol. */
function blockOfCodeword(version: number, level: Level): Uint16Array {
  const { ec, blocks } = ecInfo(version, level);
  const total = totalCodewords(version);
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks) - ec;
  const out: number[] = [];
  for (let i = 0; i <= shortLength; i++)
    for (let b = 0; b < blocks; b++) if (i < shortLength || b >= shortBlocks) out.push(b);
  for (let i = 0; i < ec; i++) for (let b = 0; b < blocks; b++) out.push(b);
  return new Uint16Array(out);
}

/**
 * How badly hiding the modules `inside` hurts a code: the most codewords any one block loses, as a
 * share of the errors that block can correct (half its error correction codewords). Above 1 it
 * cannot be read; the lower, the more room is left for a camera's own misreadings.
 */
export function damage(code: QrCode, inside: (x: number, y: number) => boolean): number {
  const { version, level, size } = code;
  const g = new Grid(size);
  drawFunctionPatterns(g, version);
  const owner = blockOfCodeword(version, level);
  const { ec, blocks } = ecInfo(version, level);
  const lost = new Set<number>();
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (g.fixed[y * size + x] === 1) continue;
        if (inside(x, y) && i >>> 3 < owner.length) lost.add(i >>> 3);
        i++;
      }
    }
  }
  const perBlock = Array.from({ length: blocks }, () => 0);
  for (const c of lost) perBlock[owner[c] ?? 0] = (perBlock[owner[c] ?? 0] ?? 0) + 1;
  return Math.max(...perBlock) / Math.floor(ec / 2);
}
