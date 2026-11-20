// The four hashes an OpenTimestamps proof can name, written from their specifications: SHA-256 and
// SHA-1 (FIPS 180-4), RIPEMD-160 (Dobbertin, Bosselaers and Preneel, 1996) and Keccak-256 (the
// Keccak team's submission, with its original 0x01 padding, not SHA-3's). Each is incremental, so
// a file of any size is hashed a chunk at a time, and none needs `crypto.subtle`, which has no
// incremental digest and is missing on a plain-HTTP page (docs/FRONTEND.md, rule 8).

export type HashName = "sha256" | "sha1" | "ripemd160" | "keccak256";

export interface Hasher {
  readonly update: (data: Uint8Array) => void;
  /** The digest. The hasher cannot be used after this. */
  readonly digest: () => Uint8Array;
}

/** Digest lengths in bytes. */
export const DIGEST_LENGTH: Record<HashName, number> = {
  sha256: 32,
  sha1: 20,
  ripemd160: 20,
  keccak256: 32,
};

/**
 * The bookkeeping of the three Merkle–Damgård hashes: 64-byte blocks, the length, the padding.
 * `compress` takes a block at an offset; `output` gives the digest; the length is written
 * big-endian (SHA) or little-endian (RIPEMD).
 */
function blocks(
  compress: (data: Uint8Array, at: number) => void,
  output: () => Uint8Array,
  bigEndian: boolean,
): Hasher {
  const block = new Uint8Array(64);
  let fill = 0;
  let length = 0;
  const update = (data: Uint8Array): void => {
    length += data.length;
    let i = 0;
    if (fill > 0) {
      const take = Math.min(64 - fill, data.length);
      block.set(data.subarray(0, take), fill);
      fill += take;
      i = take;
      if (fill < 64) return;
      compress(block, 0);
      fill = 0;
    }
    for (; i + 64 <= data.length; i += 64) compress(data, i);
    if (i < data.length) {
      block.set(data.subarray(i), 0);
      fill = data.length - i;
    }
  };
  const digest = (): Uint8Array => {
    const bits = length * 8;
    const pad = new Uint8Array((fill < 56 ? 64 : 128) - fill);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    const hi = Math.floor(bits / 0x1_0000_0000);
    const lo = bits >>> 0;
    view.setUint32(pad.length - 8, bigEndian ? hi : lo, !bigEndian);
    view.setUint32(pad.length - 4, bigEndian ? lo : hi, !bigEndian);
    update(pad);
    return output();
  };
  return { update, digest };
}

function wordsOut(h: Uint32Array, bigEndian: boolean): Uint8Array {
  const out = new Uint8Array(h.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < h.length; i++) view.setUint32(i * 4, h[i] ?? 0, !bigEndian);
  return out;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(): Hasher {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const compress = (d: Uint8Array, at: number): void => {
    for (let i = 0; i < 16; i++) {
      const j = at + i * 4;
      w[i] =
        ((d[j] ?? 0) << 24) | ((d[j + 1] ?? 0) << 16) | ((d[j + 2] ?? 0) << 8) | (d[j + 3] ?? 0);
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1;
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let e4 = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K256[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (e4 + t1) >>> 0;
      e4 = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] ?? 0) + a;
    h[1] = (h[1] ?? 0) + b;
    h[2] = (h[2] ?? 0) + c;
    h[3] = (h[3] ?? 0) + e4;
    h[4] = (h[4] ?? 0) + e;
    h[5] = (h[5] ?? 0) + f;
    h[6] = (h[6] ?? 0) + g;
    h[7] = (h[7] ?? 0) + hh;
  };
  return blocks(compress, () => wordsOut(h, true), true);
}

function sha1(): Hasher {
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  const compress = (d: Uint8Array, at: number): void => {
    for (let i = 0; i < 16; i++) {
      const j = at + i * 4;
      w[i] =
        ((d[j] ?? 0) << 24) | ((d[j + 1] ?? 0) << 16) | ((d[j + 2] ?? 0) << 8) | (d[j + 3] ?? 0);
    }
    for (let i = 16; i < 80; i++) {
      const x = (w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0);
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let dd = h[3] ?? 0;
    let e = h[4] ?? 0;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & dd);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ dd;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & dd) | (c & dd);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ dd;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] ?? 0)) >>> 0;
      e = dd;
      dd = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h[0] = (h[0] ?? 0) + a;
    h[1] = (h[1] ?? 0) + b;
    h[2] = (h[2] ?? 0) + c;
    h[3] = (h[3] ?? 0) + dd;
    h[4] = (h[4] ?? 0) + e;
  };
  return blocks(compress, () => wordsOut(h, true), true);
}

// RIPEMD-160's word order and rotations for its left and right lines, five rounds of sixteen.
const R_LEFT = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2,
  14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3,
  7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];
const R_RIGHT = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4,
  9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2,
  13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];
const S_LEFT = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9,
  11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9,
  8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];
const S_RIGHT = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7,
  6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6,
  14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];
const K_LEFT = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const K_RIGHT = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

/** RIPEMD-160's five boolean functions, by round. */
function ripemdF(round: number, x: number, y: number, z: number): number {
  if (round === 0) return x ^ y ^ z;
  if (round === 1) return (x & y) | (~x & z);
  if (round === 2) return (x | ~y) ^ z;
  if (round === 3) return (x & z) | (y & ~z);
  return x ^ (y | ~z);
}

const rol = (x: number, n: number): number => (x << n) | (x >>> (32 - n));

function ripemd160(): Hasher {
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const x = new Uint32Array(16);
  const compress = (d: Uint8Array, at: number): void => {
    for (let i = 0; i < 16; i++) {
      const j = at + i * 4;
      x[i] =
        (d[j] ?? 0) | ((d[j + 1] ?? 0) << 8) | ((d[j + 2] ?? 0) << 16) | ((d[j + 3] ?? 0) << 24);
    }
    let al = h[0] ?? 0;
    let bl = h[1] ?? 0;
    let cl = h[2] ?? 0;
    let dl = h[3] ?? 0;
    let el = h[4] ?? 0;
    let ar = al;
    let br = bl;
    let cr = cl;
    let dr = dl;
    let er = el;
    for (let j = 0; j < 80; j++) {
      const round = Math.floor(j / 16);
      let t =
        (rol(
          (al + ripemdF(round, bl, cl, dl) + (x[R_LEFT[j] ?? 0] ?? 0) + (K_LEFT[round] ?? 0)) >>> 0,
          S_LEFT[j] ?? 0,
        ) +
          el) >>>
        0;
      al = el;
      el = dl;
      dl = rol(cl, 10);
      cl = bl;
      bl = t;
      t =
        (rol(
          (ar +
            ripemdF(4 - round, br, cr, dr) +
            (x[R_RIGHT[j] ?? 0] ?? 0) +
            (K_RIGHT[round] ?? 0)) >>>
            0,
          S_RIGHT[j] ?? 0,
        ) +
          er) >>>
        0;
      ar = er;
      er = dr;
      dr = rol(cr, 10);
      cr = br;
      br = t;
    }
    const t = ((h[1] ?? 0) + cl + dr) >>> 0;
    h[1] = (h[2] ?? 0) + dl + er;
    h[2] = (h[3] ?? 0) + el + ar;
    h[3] = (h[4] ?? 0) + al + br;
    h[4] = (h[0] ?? 0) + bl + cr;
    h[0] = t;
  };
  return blocks(compress, () => wordsOut(h, false), false);
}

// Keccak-f[1600]'s round constants, as low and high 32-bit halves.
const RC = [
  [0x00000001, 0x00000000],
  [0x00008082, 0x00000000],
  [0x0000808a, 0x80000000],
  [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000],
  [0x80000001, 0x00000000],
  [0x80008081, 0x80000000],
  [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000],
  [0x00000088, 0x00000000],
  [0x80008009, 0x00000000],
  [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000],
  [0x0000008b, 0x80000000],
  [0x00008089, 0x80000000],
  [0x00008003, 0x80000000],
  [0x00008002, 0x80000000],
  [0x00000080, 0x80000000],
  [0x0000800a, 0x00000000],
  [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000],
  [0x00008080, 0x80000000],
  [0x80000001, 0x00000000],
  [0x80008008, 0x80000000],
] as const;

/** Rotation of the lane at x + 5y. */
const RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

/** Keccak-f[1600] on 25 lanes, each a low and a high 32-bit half; lane (x, y) is x + 5y. */
function permute(lo: Uint32Array, hi: Uint32Array): void {
  const bLo = new Uint32Array(25);
  const bHi = new Uint32Array(25);
  const cLo = new Uint32Array(5);
  const cHi = new Uint32Array(5);
  for (const [rcLo, rcHi] of RC) {
    // θ
    for (let x = 0; x < 5; x++) {
      cLo[x] =
        (lo[x] ?? 0) ^ (lo[x + 5] ?? 0) ^ (lo[x + 10] ?? 0) ^ (lo[x + 15] ?? 0) ^ (lo[x + 20] ?? 0);
      cHi[x] =
        (hi[x] ?? 0) ^ (hi[x + 5] ?? 0) ^ (hi[x + 10] ?? 0) ^ (hi[x + 15] ?? 0) ^ (hi[x + 20] ?? 0);
    }
    for (let x = 0; x < 5; x++) {
      const nLo = cLo[(x + 1) % 5] ?? 0;
      const nHi = cHi[(x + 1) % 5] ?? 0;
      const dLo = (cLo[(x + 4) % 5] ?? 0) ^ ((nLo << 1) | (nHi >>> 31));
      const dHi = (cHi[(x + 4) % 5] ?? 0) ^ ((nHi << 1) | (nLo >>> 31));
      for (let y = 0; y < 25; y += 5) {
        lo[x + y] = (lo[x + y] ?? 0) ^ dLo;
        hi[x + y] = (hi[x + y] ?? 0) ^ dHi;
      }
    }
    // ρ and π: B[y, 2x + 3y] = rot(A[x, y], r[x, y])
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const r = RHO[i] ?? 0;
        const swap = r >= 32;
        const l = (swap ? hi[i] : lo[i]) ?? 0;
        const hh = (swap ? lo[i] : hi[i]) ?? 0;
        const n = r % 32;
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        bLo[j] = n === 0 ? l : (l << n) | (hh >>> (32 - n));
        bHi[j] = n === 0 ? hh : (hh << n) | (l >>> (32 - n));
      }
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const b1 = ((x + 1) % 5) + y;
        const b2 = ((x + 2) % 5) + y;
        lo[x + y] = (bLo[x + y] ?? 0) ^ (~(bLo[b1] ?? 0) & (bLo[b2] ?? 0));
        hi[x + y] = (bHi[x + y] ?? 0) ^ (~(bHi[b1] ?? 0) & (bHi[b2] ?? 0));
      }
    }
    // ι
    lo[0] = (lo[0] ?? 0) ^ rcLo;
    hi[0] = (hi[0] ?? 0) ^ rcHi;
  }
}

/** Keccak-256: rate 136 bytes, capacity 512 bits, the original padding (0x01 … 0x80). */
function keccak256(): Hasher {
  const lo = new Uint32Array(25);
  const hi = new Uint32Array(25);
  const block = new Uint8Array(136);
  const view = new DataView(block.buffer);
  let fill = 0;
  const absorb = (): void => {
    for (let i = 0; i < 17; i++) {
      lo[i] = (lo[i] ?? 0) ^ view.getUint32(i * 8, true);
      hi[i] = (hi[i] ?? 0) ^ view.getUint32(i * 8 + 4, true);
    }
    permute(lo, hi);
  };
  return {
    update: (data) => {
      for (let i = 0; i < data.length;) {
        const take = Math.min(136 - fill, data.length - i);
        block.set(data.subarray(i, i + take), fill);
        fill += take;
        i += take;
        if (fill === 136) {
          absorb();
          fill = 0;
        }
      }
    },
    digest: () => {
      block.fill(0, fill);
      block[fill] = (block[fill] ?? 0) ^ 0x01;
      block[135] = (block[135] ?? 0) ^ 0x80;
      absorb();
      const out = new Uint8Array(32);
      const o = new DataView(out.buffer);
      for (let i = 0; i < 4; i++) {
        o.setUint32(i * 8, lo[i] ?? 0, true);
        o.setUint32(i * 8 + 4, hi[i] ?? 0, true);
      }
      return out;
    },
  };
}

const HASHERS: Record<HashName, () => Hasher> = { sha256, sha1, ripemd160, keccak256 };

export function createHasher(name: HashName): Hasher {
  return HASHERS[name]();
}

/** The bytes in reverse order, as a new array. */
export function reversed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i] ?? 0;
  return out;
}

/** One message's digest. */
export function hash(name: HashName, data: Uint8Array): Uint8Array {
  const h = createHasher(name);
  h.update(data);
  return h.digest();
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Bytes from hex of even length; null for anything else. */
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
