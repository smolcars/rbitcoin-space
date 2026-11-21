// What a search query is, from its form alone. Pure: nothing here fetches, and a pasted link is
// only read for its path, never followed.
import { type Recognised, recognise } from "../lib/address";

/** Longer input is not anything search can find; the field holds no more than this. */
export const MAX_QUERY = 512;

/** What a link's path or a `txid:vout` says a 64-hex id is. */
export type HashKind = "block" | "tx";

export type Query =
  | { kind: "height"; height: number }
  | { kind: "hash"; hash: string; as: HashKind | null }
  | { kind: "address"; address: Recognised }
  /** A Lightning node's public key: 66 hex digits, compressed (02 or 03 first), lowercase. */
  | { kind: "node"; key: string }
  /** A Lightning channel's short id, as `<height>x<index>x<output>`. */
  | { kind: "channel"; id: string }
  /** A payment string the decoder reads, on any network: `text` as pasted, trimmed. */
  | { kind: "payment"; label: PaymentLabel; text: string };

export type PaymentLabel =
  | "Lightning invoice"
  | "Lightning offer"
  | "Lightning refund"
  | "LNURL"
  | "Lightning address"
  | "Ark address";

/** The decoder takes no more than the server reads (crates/server/src/decode.rs `MAX_BODY`). */
export const MAX_PAYMENT = 8192;

const BECH32 = "[02-9ac-hj-np-z]";
const PAYMENT_FORMS: [RegExp, PaymentLabel][] = [
  [new RegExp(`^lnurl1${BECH32}+$`, "i"), "LNURL"],
  [/^(?:lnurl[cpw]|keyauth):\/\/[^\s/?#]+\S*$/i, "LNURL"],
  [new RegExp(`^lno1${BECH32}+$`, "i"), "Lightning offer"],
  [new RegExp(`^lnr1${BECH32}+$`, "i"), "Lightning refund"],
  [new RegExp(`^ln(?:bcrt|bc|tbs|tb|sb)\\d*[munp]?1${BECH32}+$`, "i"), "Lightning invoice"],
  [new RegExp(`^t?ark1${BECH32}+$`, "i"), "Ark address"],
];

/**
 * A payment string by its form alone: a prefix, or for a Lightning address the shape of an email
 * address with a dotted domain. A node URI (`<key>@<host>:<port>`, read as its node) and a name
 * without a dotted domain are not payment strings.
 */
export function payment(input: string): Query | null {
  if (input.length > MAX_PAYMENT) return null;
  const text = input.trim();
  const bare = text.replace(/^lightning:(?:\/\/)?/i, "");
  // BOLT 12 may split a string with `+` and whitespace; the server joins it again.
  const joined = bare.replaceAll(/\+\s*/g, "");
  for (const [form, label] of PAYMENT_FORMS) {
    if (form.test(label === "LNURL" ? bare : joined)) return { kind: "payment", label, text };
  }
  // `@domain` is LUD-16's short form of the domain's default name.
  const address = /^([a-z0-9._+-]*)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})$/i.exec(bare);
  if (address && !/^[0-9a-f]{66}$/i.test(address[1] ?? "")) {
    return { kind: "payment", label: "Lightning address", text };
  }
  return null;
}

type Hint = HashKind | "address" | "node" | "channel" | null;

const U32_MAX = 4_294_967_295;

/** Path words that say what the next segment is, on this and other explorers. */
const PATH_WORDS: Record<string, Hint> = {
  tx: "tx",
  transaction: "tx",
  transactions: "tx",
  block: "block",
  blocks: "block",
  "block-height": "block",
  address: "address",
  addresses: "address",
  node: "node",
  nodes: "node",
  channel: "channel",
  channels: "channel",
};

// Zero-width characters ride along with copied text; quotes, brackets and a sentence's final
// punctuation are not part of any identifier. (Escapes in \u{} form: oxfmt unescapes \uXXXX.)
const INVISIBLE = /[\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu;
const WRAPPING = /^[\s"'`<([{\u{2018}\u{201C}]+|[\s"'`>)\]}\u{2019}\u{201D}.,;]+$/gu;

/** Classifies a query, or null when it has no form search can find. */
export function classify(input: string): Query | null {
  const paid = payment(input.replaceAll(INVISIBLE, "").replaceAll(WRAPPING, ""));
  if (paid) return paid;
  if (input.length > MAX_QUERY) return null;
  const q = input.replaceAll(INVISIBLE, "").replaceAll(WRAPPING, "");
  const uri = /^bitcoin:(?:\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(q);
  if (uri) {
    const path = decode(uri[1] ?? "");
    if (path !== "") return plain(path, "address");
    // BIP321: a URI with no address in its path can carry a silent payments one as `sp`, and only that.
    const sp = plain(param(uri[2] ?? "", "sp") ?? "", "address");
    return sp?.kind === "address" && sp.address.type === "sp" ? sp : null;
  }
  if (q.includes("/")) return fromLink(q);
  return plain(q, null);
}

/** A URI query's parameter, its key matched in any case as BIP321 asks; null when it is absent. */
function param(query: string, key: string): string | null {
  for (const [k, v] of new URLSearchParams(query)) if (k.toLowerCase() === key) return v;
  return null;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/**
 * The identifier in a pasted link's path: the first segment that fits the nearest path word
 * before it (`/tx/<id>`, `/bitcoin/transaction/<id>`, `/explorer/blocks/btc/<height>`). With no
 * path word, a hash, address or node key as the last segment. The host is ignored, so any explorer's link works.
 */
function fromLink(q: string): Query | null {
  let url: URL;
  try {
    // The base only lets a bare path or `host/path` parse; it is never fetched.
    url = new URL(q, "https://search.invalid");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => decode(s));
  let hint: Hint = null;
  for (const segment of segments) {
    const word = PATH_WORDS[segment.toLowerCase()];
    if (word) hint = word;
    else if (hint) {
      const found = plain(segment, hint);
      if (found) return found;
    }
  }
  if (hint) return null;
  const last = plain(segments.at(-1) ?? "", null);
  return last?.kind === "height" || last?.kind === "channel" ? null : last;
}

/** A bare identifier, limited to what `hint` allows. */
function plain(q: string, hint: Hint): Query | null {
  // Hashes and addresses never hold whitespace; a copied one may be grouped or wrapped.
  const compact = q.replaceAll(/\s+/g, "");
  if (hint === null || hint === "tx" || hint === "block") {
    const hex = /^(?:0x)?([0-9a-f]{64})(?::\d{1,10})?$/i.exec(compact);
    const hash = hex?.[1]?.toLowerCase();
    const outpoint = compact.includes(":");
    if (hash !== undefined && !(outpoint && hint === "block")) {
      return { kind: "hash", hash, as: outpoint ? "tx" : hint };
    }
  }
  if (hint === null || hint === "block") {
    const height = parseHeight(q);
    if (height !== null) return { kind: "height", height };
  }
  if (hint === null || hint === "address") {
    const address = recognise(compact);
    // A compressed key on its own is a Lightning node's far more often than an output's: only a
    // link to an address page makes it one. An uncompressed key is never a node's.
    const node = hint === null && address?.type === "p2pk" && compact.length === 66;
    if (address && !node) return { kind: "address", address };
  }
  // A node's connect string (`<key>@<host>:<port>`, what a node's QR code holds) names its key.
  const key = /^(0[23][0-9a-f]{64})(?:@[^@/]+)?$/i.exec(compact)?.[1];
  if ((hint === null || hint === "node") && key !== undefined) {
    return { kind: "node", key: key.toLowerCase() };
  }
  // A plain number that fits a height was taken as one above.
  if (hint === null || hint === "channel") {
    const id = channelId(compact);
    if (id !== null) return { kind: "channel", id };
  }
  return null;
}

const U64_MAX = 2n ** 64n - 1n;

/**
 * A short channel id in the forms the server's search takes (crates/server/src/lightning/nodes.rs
 * `scid`): `811984x2037x0`, or the 64-bit number it packs into. Written back as the first.
 */
function channelId(q: string): string | null {
  const parts = /^(\d{1,8})x(\d{1,8})x(\d{1,5})$/i.exec(q);
  if (parts) {
    const [h, i, o] = parts.slice(1).map(Number);
    if (h === undefined || i === undefined || o === undefined) return null;
    return h <= 0xff_ffff && i <= 0xff_ffff && o <= 0xffff ? `${h}x${i}x${o}` : null;
  }
  if (!/^\d{1,20}$/.test(q)) return null;
  const n = BigInt(q);
  return n <= U64_MAX ? `${n >> 40n}x${(n >> 16n) & 0xff_ffffn}x${n & 0xffffn}` : null;
}

/**
 * A block height as people write it: `975411`, `975,411`, `975 411`, `975.411`, `975_411`,
 * `#975411` or `Block 975 411`. Groups of three after one consistent separator.
 */
function parseHeight(q: string): number | null {
  const m = /^(?:block\s*)?#?\s*(\d{1,10}|\d{1,3}([,.'_\s])\d{3}(?:\2\d{3}){0,2})$/i.exec(q);
  if (!m?.[1]) return null;
  const height = Number(m[1].replaceAll(/\D/g, ""));
  return height <= U32_MAX ? height : null;
}
