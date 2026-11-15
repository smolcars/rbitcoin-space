// An address's type and networks from its form alone. Shared by the address page and search.
import type { Network } from "./network";

export type AddressType = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | "p2a" | "witness" | "sp";

export interface Recognised {
  /** The form the API and the node use: bech32 in lower case, base58 as given. */
  address: string;
  type: AddressType;
  /** The networks an address of this form belongs to. Signet, testnet4 and Testnet 5 share their forms. */
  networks: readonly Network[];
}

export const TYPE_NAMES: Record<AddressType, { short: string; long: string }> = {
  p2pkh: { short: "P2PKH", long: "Pay to public key hash" },
  p2sh: { short: "P2SH", long: "Pay to script hash" },
  p2wpkh: { short: "P2WPKH", long: "Pay to witness public key hash (SegWit v0)" },
  p2wsh: { short: "P2WSH", long: "Pay to witness script hash (SegWit v0)" },
  p2tr: { short: "P2TR", long: "Pay to Taproot (SegWit v1)" },
  p2a: { short: "P2A", long: "Pay to anchor" },
  witness: { short: "SegWit", long: "A SegWit version not yet in use" },
  sp: { short: "Silent payments", long: "Silent payments (BIP352): each payment is a new output" },
};

const TEST_NETWORKS: readonly Network[] = ["signet", "testnet4", "testnet5", "regtest"];
const BECH32_NETWORKS: Record<string, readonly Network[]> = {
  bc: ["mainnet"],
  tb: ["signet", "testnet4", "testnet5"],
  bcrt: ["regtest"],
};
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Recognises an address's type and networks from its form alone, or null when it has no address's
 * form. The checksum is left to the server, which validates every address it is asked for.
 */
export function recognise(input: string): Recognised | null {
  const base58 = /^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(input);
  if (base58) {
    const first = input[0];
    if (first === "1") return { address: input, type: "p2pkh", networks: ["mainnet"] };
    if (first === "3") return { address: input, type: "p2sh", networks: ["mainnet"] };
    if (first === "m" || first === "n") {
      return { address: input, type: "p2pkh", networks: TEST_NETWORKS };
    }
    if (first === "2") return { address: input, type: "p2sh", networks: TEST_NETWORKS };
    return null;
  }
  // Bech32 is all lower or all upper case.
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) return null;
  // Silent payments (BIP352) are bech32m of up to 1023 characters, and at least the 116 of version
  // 0. The address page decodes them itself, since the node has nothing to say about one.
  const sp = /^(t?sp)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{113,}$/.exec(lower);
  if (sp && lower.length <= 1023) {
    return { address: lower, type: "sp", networks: sp[1] === "sp" ? ["mainnet"] : TEST_NETWORKS };
  }
  // Every other bech32 address is at most 90 characters.
  if (input.length > 90) return null;
  const m = /^(bc|tb|bcrt)1([qpzry9x8gf2tvdw0s3jn54khce6mua7l]{7,})$/.exec(lower);
  const hrp = m?.[1];
  const data = m?.[2];
  if (!hrp || !data) return null;
  const networks = BECH32_NETWORKS[hrp] ?? [];
  const version = BECH32_CHARSET.indexOf(data[0] ?? "");
  // Witness version, then the program in 5-bit groups, then a 6-character checksum.
  const bytes = Math.floor(((data.length - 7) * 5) / 8);
  const found = (type: AddressType): Recognised => ({ address: lower, type, networks });
  if (version === 0) {
    if (bytes === 20) return found("p2wpkh");
    if (bytes === 32) return found("p2wsh");
    return null;
  }
  if (version === 1 && bytes === 32) return found("p2tr");
  // Pay to anchor is the 2-byte v1 program 0x4e73, which always encodes as "pfees".
  if (version === 1 && bytes === 2 && data.startsWith("pfees")) return found("p2a");
  if (version >= 1 && version <= 16 && bytes >= 2 && bytes <= 40) return found("witness");
  return null;
}
