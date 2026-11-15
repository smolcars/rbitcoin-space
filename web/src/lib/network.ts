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

/** A network-free path (starting with `/`) placed on a network: (`signet`, `/tx/ab`) → `/signet/tx/ab`. */
export function onNetwork(network: Network, path: string): string {
  if (network === "mainnet") return path;
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
  /** The mempool's history, for an interval such as `1w` when given. */
  mempool: (interval?: string) =>
    interval === undefined ? "/mempool" : `/mempool?interval=${encodeURIComponent(interval)}`,
  /** Looking up an Ark VTXO. */
  ark: () => "/ark",
  /** A Bark VTXO by its id, `<txid>:<vout>`. */
  barkVtxo: (id: string) => `/ark/bark/vtxo/${vtxoSegment(id)}`,
  /** Recent replacements, newest first; only those that replaced without signalling when asked. */
  rbf: (fullRbf = false) => (fullRbf ? "/rbf?view=full-rbf" : "/rbf"),
};
