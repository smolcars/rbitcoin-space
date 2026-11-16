// Networks and the paths that carry them. Mainnet has no prefix; the others live under /<name>.

export const NETWORKS = ["mainnet", "signet", "testnet4", "testnet5", "regtest"] as const;
export type Network = (typeof NETWORKS)[number];

export const NETWORK_NAMES: Record<Network, string> = {
  mainnet: "Mainnet",
  signet: "Signet",
  testnet4: "Testnet4",
  testnet5: "Testnet5",
  regtest: "Regtest",
};

/** Whether a Lightning peer can run here: LDK, which runs it, has no Testnet 5. */
export const hasLightning = (network: Network): boolean => network !== "testnet5";

export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

/** The network a page path belongs to. */
export function networkFromPath(pathname: string): Network {
  const first = pathname.split("/")[1];
  return first !== "mainnet" && isNetwork(first) ? first : "mainnet";
}

/** A page path without its network prefix: `/signet/tx/ab` → `/tx/ab`, `/signet` → `/`. */
export function stripNetwork(pathname: string): string {
  const network = networkFromPath(pathname);
  if (network === "mainnet") return pathname || "/";
  return pathname.slice(network.length + 1) || "/";
}

/** Paths that belong to no network: the same page whichever network one comes from. */
const GLOBAL = /^\/decode(?:[?#]|$)/;

/**
 * A network-free path (starting with `/`) placed on a network: (`signet`, `/tx/ab`) → `/signet/tx/ab`.
 * A page that belongs to no network (`/decode`) keeps its path.
 */
export function onNetwork(network: Network, path: string): string {
  if (network === "mainnet" || GLOBAL.test(path)) return path;
  return path === "/" ? `/${network}` : `/${network}${path}`;
}

/** Base URL of a network's public Esplora API. */
export function apiBase(network: Network): string {
  return `${onNetwork(network, "")}/api`;
}

const segment = (value: string | number) => encodeURIComponent(String(value));

/** A VTXO id keeps its colon, which it needs to read as one; anything else in it is encoded. */
const vtxoSegment = (id: string) =>
  id
    .split(":")
    .map((part) => segment(part))
    .join(":");

/**
 * Network-free paths to each page. Chain data only ever lands in a path segment, encoded, so a
 * hostile value cannot change the scheme or the route (SECURITY.md rule 14).
 */
export const paths = {
  home: () => "/",
  block: (hashOrHeight: string | number) => `/block/${segment(hashOrHeight)}`,
  /** Recent blocks, newest first; from a height when paging back. */
  blocks: (from?: number) => (from === undefined ? "/blocks" : `/blocks/${segment(from)}`),
  /** A projected block by its place in the queue, 1 for the next; the last (8) is the rest. */
  projected: (position: number) =>
    position <= 1 ? "/block/next" : `/block/next/${segment(position)}`,
  tx: (txid: string) => `/tx/${segment(txid)}`,
  address: (address: string) => `/address/${segment(address)}`,
  /** The mining page, for a period such as `1m` when given. */
  mining: (period?: string) =>
    period === undefined ? "/mining" : `/mining?period=${encodeURIComponent(period)}`,
  /** A mining pool by its slug from the pool list. */
  pool: (slug: string) => `/mining/pool/${segment(slug)}`,
  /** The Lightning network's overview, its chart over an interval such as `1m` when given. */
  lightning: (interval?: string) =>
    interval === undefined ? "/lightning" : `/lightning?interval=${encodeURIComponent(interval)}`,
  /** A Lightning node by its public key. */
  lightningNode: (key: string) => `/lightning/node/${segment(key)}`,
  /** A Lightning channel by its id (`811984x2037x0`). */
  lightningChannel: (id: string) => `/lightning/channel/${segment(id)}`,
  /** Lightning nodes and channels matching a name, a key or an id. */
  lightningSearch: (q: string) => `/lightning/search?q=${encodeURIComponent(q)}`,
  /** The largest, best-connected or oldest Lightning nodes. */
  lightningRankings: (by?: string) =>
    by === undefined ? "/lightning/rankings" : `/lightning/rankings?by=${encodeURIComponent(by)}`,
  /** The Lightning penalties this server saw, a page from 1. */
  lightningPenalties: (page?: number) =>
    page === undefined || page <= 1 ? "/lightning/penalties" : `/lightning/penalties?page=${page}`,
  /** The mempool's history, for an interval such as `1w` when given. */
  mempool: (interval?: string) =>
    interval === undefined ? "/mempool" : `/mempool?interval=${encodeURIComponent(interval)}`,
  /** Looking up an Ark VTXO. */
  ark: () => "/ark",
  /** An Ark VTXO by its `<txid>:<vout>`, on whichever implementation knows it. */
  arkVtxo: (id: string) => `/ark/vtxo/${vtxoSegment(id)}`,
  /** A Bark VTXO by its id, `<txid>:<vout>`. */
  barkVtxo: (id: string) => `/ark/bark/vtxo/${vtxoSegment(id)}`,
  /** A Bark VTXO from its serialized bytes as hex, carried in the fragment so no server sees it. */
  barkHex: (hex: string) => `/ark/bark/hex#${encodeURIComponent(hex)}`,
  /** An Arkade VTXO by its outpoint, `<txid>:<vout>`. */
  arkadeVtxo: (id: string) => `/ark/arkade/vtxo/${vtxoSegment(id)}`,
  /** An Arkade address's VTXOs, from page 1 (`?page=n` after it). */
  arkadeAddress: (address: string, page = 1) =>
    `/ark/arkade/address/${segment(address)}${page > 1 ? `?page=${segment(page)}` : ""}`,
  /** The decoder, the pasted string in the fragment, which no server sees. On every network. */
  decode: (text?: string) =>
    text === undefined || text === "" ? "/decode" : `/decode#${encodeURIComponent(text)}`,
  /** Recent replacements, newest first; only those that replaced without signalling when asked. */
  rbf: (fullRbf = false) => (fullRbf ? "/rbf?view=full-rbf" : "/rbf"),
};
