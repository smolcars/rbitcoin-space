// The decoder's answer (docs/API.md "Decoding"), checked before it is drawn, and the few words
// the page needs. Everything decoded is the pasted string's claim: text, never markup.
import { ApiError } from "../../lib/api";
import { groupDigits } from "../../lib/format";
import { isNetwork, NETWORK_NAMES, type Network } from "../../lib/network";

export interface KeyRef {
  key: string;
  alias: string | null;
  /** Whether the graph of `names` knows it; null when no graph was asked. */
  known: boolean | null;
}
export interface ChannelRef {
  scid: string;
  known: boolean | null;
}
export interface Feature {
  bit: number;
  name: string | null;
  required: boolean;
}
export interface Hop {
  node: KeyRef;
  channel: ChannelRef;
  base_fee_msat: number;
  fee_ppm: number;
  cltv_delta: number;
}
export interface PathRef {
  node: KeyRef | null;
  channel: ChannelRef | null;
  direction: number | null;
  hops: number;
}
export type Price = { msat: number } | { currency: string; amount: number };

interface Common {
  /** As the string says: a network, `testnet` (3 or 4), `test` (any test network), or null. */
  network: string | null;
  /** The network of this server whose graph named the keys. */
  names: Network | null;
}
export type Invoice = Common & {
  kind: "bolt11";
  amount_msat: number | null;
  description: string | null;
  description_hash: string | null;
  payee: KeyRef;
  payee_named: boolean;
  created: number;
  expiry: number;
  payment_hash: string;
  min_final_cltv: number;
  features: Feature[];
  fallbacks: string[];
  hints: Hop[][];
};
export type Offer = Common & {
  kind: "offer";
  chains: string[];
  description: string | null;
  issuer: string | null;
  amount: Price | null;
  quantity: "one" | "any" | number;
  expires: number | null;
  signing_key: KeyRef | null;
  paths: PathRef[];
  features: Feature[];
};
export type Refund = Common & {
  kind: "refund";
  chains: string[];
  description: string;
  issuer: string | null;
  amount_msat: number;
  quantity: number | null;
  expires: number | null;
  payer_key: string;
  payer_note: string | null;
  paths: PathRef[];
};
export type Lnurl = Common & {
  kind: "lnurl";
  form: string;
  url: string;
  host: string;
  tag: string | null;
  k1: string | null;
};
export type LightningAddress = Common & {
  kind: "lightning_address";
  name: string;
  domain: string;
  url: string;
};
export type Arkade = Common & {
  kind: "ark_address";
  implementation: "arkade";
  server_key: string;
  p2tr_key: string;
  script: string;
};
export type Bark = Common & {
  kind: "ark_address";
  implementation: "bark";
  ark_id: string;
  policy: string;
  user_key: string | null;
  delivery: { kind: string; id?: string; type?: number }[];
};
export type Decoded = Invoice | Offer | Refund | Lnurl | LightningAddress | Arkade | Bark;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const orNull =
  <T>(f: (v: unknown) => v is T) =>
  (v: unknown): v is T | null =>
    v === null || f(v);
const listOf =
  <T>(f: (v: unknown) => v is T) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every((x) => f(x));
const fields = (o: Obj, checks: Record<string, (v: unknown) => boolean>) =>
  Object.entries(checks).every(([k, f]) => f(o[k]));

const isKey = (v: unknown): v is KeyRef =>
  isObj(v) && fields(v, { key: isStr, alias: orNull(isStr), known: orNull(isBool) });
const isChannel = (v: unknown): v is ChannelRef =>
  isObj(v) && fields(v, { scid: isStr, known: orNull(isBool) });
const isFeature = (v: unknown): v is Feature =>
  isObj(v) && fields(v, { bit: isNum, name: orNull(isStr), required: isBool });
const isHop = (v: unknown): v is Hop =>
  isObj(v) &&
  fields(v, {
    node: isKey,
    channel: isChannel,
    base_fee_msat: isNum,
    fee_ppm: isNum,
    cltv_delta: isNum,
  });
const isPath = (v: unknown): v is PathRef =>
  isObj(v) &&
  fields(v, {
    node: orNull(isKey),
    channel: orNull(isChannel),
    direction: orNull(isNum),
    hops: isNum,
  });
const isPrice = (v: unknown): v is Price =>
  isObj(v) && (isNum(v["msat"]) || (isStr(v["currency"]) && isNum(v["amount"])));
const isDelivery = (v: unknown) =>
  isObj(v) &&
  isStr(v["kind"]) &&
  (v["id"] === undefined || isStr(v["id"])) &&
  (v["type"] === undefined || isNum(v["type"]));

const KINDS: Record<string, Record<string, (v: unknown) => boolean>> = {
  bolt11: {
    amount_msat: orNull(isNum),
    description: orNull(isStr),
    description_hash: orNull(isStr),
    payee: isKey,
    payee_named: isBool,
    created: isNum,
    expiry: isNum,
    payment_hash: isStr,
    min_final_cltv: isNum,
    features: listOf(isFeature),
    fallbacks: listOf(isStr),
    hints: listOf(listOf(isHop)),
  },
  offer: {
    chains: listOf(isStr),
    description: orNull(isStr),
    issuer: orNull(isStr),
    amount: orNull(isPrice),
    quantity: (v) => v === "one" || v === "any" || isNum(v),
    expires: orNull(isNum),
    signing_key: orNull(isKey),
    paths: listOf(isPath),
    features: listOf(isFeature),
  },
  refund: {
    chains: listOf(isStr),
    description: isStr,
    issuer: orNull(isStr),
    amount_msat: isNum,
    quantity: orNull(isNum),
    expires: orNull(isNum),
    payer_key: isStr,
    payer_note: orNull(isStr),
    paths: listOf(isPath),
  },
  lnurl: { form: isStr, url: isStr, host: isStr, tag: orNull(isStr), k1: orNull(isStr) },
  lightning_address: { name: isStr, domain: isStr, url: isStr },
  arkade: { server_key: isStr, p2tr_key: isStr, script: isStr },
  bark: {
    ark_id: isStr,
    policy: isStr,
    user_key: orNull(isStr),
    delivery: (v) => Array.isArray(v) && v.every((x) => isDelivery(x)),
  },
};

/** The answer, if it is one this page can draw. */
export function isDecoded(v: unknown): v is Decoded {
  if (!isObj(v) || !isStr(v["kind"])) return false;
  if (!(v["network"] === null || isStr(v["network"]))) return false;
  if (!(v["names"] === null || isNetwork(v["names"]))) return false;
  const kind = v["kind"] === "ark_address" ? v["implementation"] : v["kind"];
  const checks = isStr(kind) ? KINDS[kind] : undefined;
  return checks !== undefined && fields(v, checks);
}

/** What it is, in a few words. */
export function kindName(d: Decoded): string {
  if (d.kind === "bolt11") return "Lightning invoice";
  if (d.kind === "offer") return "Lightning offer";
  if (d.kind === "refund") return "Lightning refund";
  if (d.kind === "lnurl") return LNURL_TAGS[d.tag ?? ""] ?? "LNURL";
  if (d.kind === "lightning_address") return "Lightning address";
  return d.implementation === "bark" ? "Bark address" : "Arkade address";
}

const LNURL_TAGS: Record<string, string> = {
  login: "LNURL login",
  payRequest: "LNURL pay",
  withdrawRequest: "LNURL withdraw",
  channelRequest: "LNURL channel",
};

/** The network as the string names it; the site's own networks in their own words. */
export function networkName(network: string | null): string {
  if (network === null) return "Any network";
  if (isNetwork(network)) return NETWORK_NAMES[network];
  return EXTRA_NETWORKS[network] ?? network;
}

const EXTRA_NETWORKS: Record<string, string> = {
  testnet: "Testnet",
  testnet3: "Testnet 3",
  test: "Test network",
  simnet: "Simnet",
};

/** The pasted string carried in the fragment, which no server sees. */
export function readFragment(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** The server's typed refusal in a line, and whether trying again could help. */
export function failure(e: unknown): { title: string; final: boolean } {
  if (e instanceof ApiError) {
    const said = FAILURES[e.message.toLowerCase().replace(/\.$/, "")];
    if (said !== undefined && (e.status === 400 || e.status === 413))
      return { title: said, final: true };
    if (e.status === 429) return { title: "Too many decodes. Try again in a moment", final: false };
  }
  return { title: "Could not decode", final: false };
}

const FAILURES: Record<string, string> = {
  "not recognised": "Not an invoice, offer, LNURL or address this page reads",
  "bad checksum": "The checksum fails: a character is wrong or missing",
  "bad signature": "The signature does not verify",
  malformed: "It does not follow its format's rules",
  "too long": "Too long to be a payment string",
};

/** A URL in three parts, the host set apart so a look-alike can be seen. */
export function splitHost(url: string, host: string): [string, string, string] {
  const start = url.indexOf("://");
  if (start === -1 || host === "") return [url, "", ""];
  const authorityEnd = url.slice(start + 3).search(/[/?#]/);
  const end = authorityEnd === -1 ? url.length : start + 3 + authorityEnd;
  const authority = url.slice(start + 3, end).toLowerCase();
  const at = authority.lastIndexOf(host);
  if (at === -1) return [url, "", ""];
  const from = start + 3 + at;
  return [url.slice(0, from), url.slice(from, from + host.length), url.slice(from + host.length)];
}

/** Milli-satoshis as sats, the remainder kept: `21 sats`, `0.5 sats`. */
export function sats(msat: number): string {
  const whole = Math.floor(msat / 1000);
  const rest = msat % 1000;
  const grouped = groupDigits(whole);
  return rest === 0 ? grouped : `${grouped}.${String(rest).padStart(3, "0").replace(/0+$/, "")}`;
}
