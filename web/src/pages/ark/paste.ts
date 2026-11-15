// What a visitor pasted into the Ark box (docs/ARK.md "The entry page"): read by its form alone,
// never guessed. Nothing here asks a server.
import { type Network, paths } from "../../lib/network";
import { parseOutpoint } from "./arkade/vtxo";

export type Pasted =
  /** `txid:vout`: a Bark VTXO ID and an Arkade outpoint look the same. */
  | { kind: "vtxo"; id: string }
  /** A serialized Bark VTXO, lower-cased. */
  | { kind: "bark-hex"; hex: string }
  /** An Arkade address on this network, lower-cased. */
  | { kind: "arkade-address"; address: string }
  /** A Bark address: nothing can look one up. */
  | { kind: "bark-address" }
  /** An Ark address of a version past BOAT-1's 0 and 1. */
  | { kind: "unknown-version" }
  /** An Ark address of the other kind of network: mainnet's on a test network, or the reverse. */
  | { kind: "other-network"; mainnet: boolean }
  /** 64 hex digits with no output: a transaction, not a VTXO. */
  | { kind: "txid" }
  | { kind: "unknown" };

/** Shorter than any serialized VTXO: a version, a txid and a few fields at the least. */
const MIN_HEX = 100;
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M = 0x2bc8_30a3;

/** BIP-350's checksum over the human-readable part and the data, as 5-bit groups. */
function isBech32m(hrp: string, data: string): boolean {
  // Both parts are ASCII, matched before this is called.
  const codes = hrp.split("").map((c) => c.codePointAt(0) ?? 0);
  const values = [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
  for (const c of data) values.push(CHARSET.indexOf(c));
  let chk = 1;
  const gen = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ff_ffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i] ?? 0;
  }
  return chk >>> 0 === BECH32M;
}

/** Reads what was pasted for a page on `network`. */
export function classify(input: string, network: Network): Pasted {
  const s = input.trim();
  if (s.includes(":")) {
    const o = parseOutpoint(s);
    return o ? { kind: "vtxo", id: `${o.txid}:${o.vout}` } : { kind: "unknown" };
  }
  if (/^[0-9a-fA-F]+$/.test(s)) {
    if (s.length === 64) return { kind: "txid" };
    const hex = s.toLowerCase();
    // A little-endian u16 version, 1 or 2, then whole bytes.
    const versioned = hex.startsWith("0100") || hex.startsWith("0200");
    return versioned && hex.length >= MIN_HEX && hex.length % 2 === 0
      ? { kind: "bark-hex", hex }
      : { kind: "unknown" };
  }
  // An Ark address (BOAT-1): bech32m, `ark` on mainnet and `tark` on any test network, its first
  // 5-bit group the version. Bech32m is all lower or all upper case.
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) return { kind: "unknown" };
  const m = /^(t?ark)1([qpzry9x8gf2tvdw0s3jn54khce6mua7l]{7,})$/.exec(lower);
  const hrp = m?.[1];
  const data = m?.[2];
  if (!hrp || !data || !isBech32m(hrp, data)) return { kind: "unknown" };
  const mainnet = hrp === "ark";
  if (mainnet !== (network === "mainnet")) return { kind: "other-network", mainnet };
  const version = data[0];
  if (version === "p") return { kind: "bark-address" };
  if (version !== "q") return { kind: "unknown-version" };
  return { kind: "arkade-address", address: lower };
}

/** What the box says under itself for a paste that opens no page; `undefined` when one opens. */
export function refusal(p: Pasted): string | undefined {
  if (p.kind === "txid") return "Add :vout to the txid";
  if (p.kind === "bark-address") return "A Bark address cannot be looked up";
  if (p.kind === "unknown-version") return "An Ark address of an unknown version";
  if (p.kind === "other-network") return p.mainnet ? "A mainnet address" : "A test network address";
  if (p.kind === "unknown") return "Not a VTXO or an Ark address";
  return undefined;
}

/** The page a paste opens, network-free, or `undefined` when it opens none. */
export function destination(p: Pasted): string | undefined {
  if (p.kind === "vtxo") return paths.arkVtxo(p.id);
  if (p.kind === "bark-hex") return paths.barkHex(p.hex);
  if (p.kind === "arkade-address") return paths.arkadeAddress(p.address);
  return undefined;
}
