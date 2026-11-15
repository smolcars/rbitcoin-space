// A silent payments address (BIP352) read from its text alone: the node has nothing to say about
// one, since no payment to it names it on chain. Pure functions.

/** What a valid address carries. Keys are compressed public keys in lower-case hex. */
export interface SilentPayment {
  ok: true;
  /** 0 today; 1 to 30 are later versions read the way BIP352 asks, by their first 66 bytes. */
  version: number;
  scanKey: string;
  spendKey: string;
  /** Bytes past the two keys, which a later version may add and this one ignores. */
  extraBytes: number;
}

/** Why an address that has the form of one is not valid. */
export type SilentPaymentProblem = "checksum" | "version" | "length" | "key";

export type Decoded = SilentPayment | { ok: false; problem: SilentPaymentProblem };

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M = 0x2b_c8_30_a3;
const GENERATORS = [0x3b_6a_57_b2, 0x26_50_8e_6d, 0x1e_a1_19_fa, 0x3d_42_33_dd, 0x2a_14_62_b3];
/** Version 31 is kept for a format later versions cannot be read as. */
const INCOMPATIBLE_VERSION = 31;
const KEY_BYTES = 33;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1_ff_ff_ff) << 5) ^ v;
    for (const [i, g] of GENERATORS.entries()) if ((top >>> i) & 1) chk ^= g;
  }
  return chk >>> 0;
}

/** The checksum's view of the human-readable part: high bits, a zero, then low bits. */
function expandHrp(hrp: string): number[] {
  const codes = Array.from(hrp, (c) => c.codePointAt(0) ?? 0);
  return [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
}

/** 5-bit groups to bytes. Null when the padding left over is more than 4 bits or not all zero. */
function toBytes(groups: readonly number[]): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const g of groups) {
    acc = ((acc << 5) | g) & 0xf_ff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits > 4 || (acc & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

const P = 2n ** 256n - 2n ** 32n - 977n;

function powMod(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Whether 33 bytes are a compressed point on secp256k1: an 02 or 03 prefix and an x for which
 * x³ + 7 has a square root. Euler's criterion answers that without finding the root.
 */
export function isPublicKey(key: Uint8Array): boolean {
  if (key.length !== KEY_BYTES || (key[0] !== 2 && key[0] !== 3)) return false;
  const x = BigInt(`0x${hex(key.subarray(1))}`);
  if (x >= P) return false;
  const y2 = (x ** 3n + 7n) % P;
  return powMod(y2, (P - 1n) / 2n, P) === 1n;
}

/**
 * Decodes an address `recognise` called silent payments (lower case, `sp1` or `tsp1`). Checks the
 * bech32m checksum, the version, the length its version needs, and both keys.
 */
export function decodeSilentPayment(address: string): Decoded {
  const split = address.lastIndexOf("1");
  const hrp = address.slice(0, split);
  const values = Array.from(address.slice(split + 1), (c) => CHARSET.indexOf(c));
  if (split < 1 || values.includes(-1)) return { ok: false, problem: "checksum" };
  if (polymod([...expandHrp(hrp), ...values]) !== BECH32M) {
    return { ok: false, problem: "checksum" };
  }
  const version = values[0] ?? INCOMPATIBLE_VERSION;
  if (version === INCOMPATIBLE_VERSION) return { ok: false, problem: "version" };
  const bytes = toBytes(values.slice(1, -6));
  const keyBytes = KEY_BYTES * 2;
  if (bytes === null || bytes.length < keyBytes || (version === 0 && bytes.length !== keyBytes)) {
    return { ok: false, problem: "length" };
  }
  const scan = bytes.subarray(0, KEY_BYTES);
  const spend = bytes.subarray(KEY_BYTES, keyBytes);
  if (!isPublicKey(scan) || !isPublicKey(spend)) return { ok: false, problem: "key" };
  return {
    ok: true,
    version,
    scanKey: hex(scan),
    spendKey: hex(spend),
    extraBytes: bytes.length - keyBytes,
  };
}
