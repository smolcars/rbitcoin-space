// What the search field loads on first use: what a query looks like as it is typed, and where it
// leads on Enter. Kept out of the first load (components/SearchField.tsx imports it lazily).
import { TYPE_NAMES } from "../lib/address";
import { fetchApi, fetchApp, isNotFound } from "../lib/api";
import { type AppConfig, loadConfig } from "../lib/config";
import { groupDigits } from "../lib/format";
import { NETWORK_NAMES, type Network, paths } from "../lib/network";
import { cleanAlias, isSearchResult, searchProblem } from "../pages/lightning/lightning";
import { classify, type HashKind, MAX_QUERY, type Query } from "./query";

export type { Query } from "./query";

/** The field's reading of a query as it is typed: a short label, and whether Enter will act. */
export interface Reading {
  label: string;
  ready: boolean;
}

/** Names networks for a sentence: "Signet, Testnet4 or Testnet5". */
export function networkNames(list: readonly Network[]): string {
  const all = list.map((n) => NETWORK_NAMES[n]);
  return all.length > 1 ? `${all.slice(0, -1).join(", ")} or ${all.at(-1)}` : (all[0] ?? "");
}

const HASH_LABELS: Record<HashKind, string> = { block: "Block hash", tx: "Transaction" };

/** `lightning`: the network has Lightning on, so a name or a key's start searches its nodes. */
export function describe(raw: string, network: Network, lightning = false): Reading {
  const q = classify(raw);
  if (q?.kind === "payment") return { label: q.label, ready: true };
  if (q?.kind === "node") return { label: "Lightning node", ready: true };
  if (q?.kind === "channel") return { label: "Lightning channel", ready: true };
  if (q?.kind === "height") return { label: `Block ${groupDigits(q.height)}`, ready: true };
  if (q?.kind === "hash") {
    return { label: q.as ? HASH_LABELS[q.as] : "Transaction or block", ready: true };
  }
  if (q?.kind === "address") {
    const { type, networks } = q.address;
    const theirs = networks.includes(network) ? null : networkNames(networks);
    if (type === "p2pk") return { label: "Public key (P2PK)", ready: true };
    return { label: `${theirs ?? TYPE_NAMES[type].short} address`, ready: true };
  }
  if (raw.length > MAX_QUERY) return { label: "Too long", ready: false };
  const named = lightning && searchProblem(raw) === undefined;
  const hex = /^(?:0x)?([0-9a-f]{1,63})$/i.exec(raw.trim())?.[1];
  if (hex !== undefined) return { label: `${hex.length} of 64 characters`, ready: named };
  return named ? { label: "Node name", ready: true } : { label: "Not recognised", ready: false };
}

export type Outcome =
  | { kind: "go"; path: string }
  | { kind: "missing"; query: Query | null }
  | { kind: "failed"; error: unknown };

/** Asks the network's API for a path; rejects with ApiError (404 is "no such thing"). */
export type Probe = (path: string) => Promise<unknown>;

/**
 * Which kind of thing to ask for first. A link or an outpoint says; otherwise a block hash meets
 * proof of work, so five leading zero digits (2^-20 for a txid) mean a block, and anything else is
 * most likely a transaction, by far the most searched for.
 */
export function probeOrder(hash: string, as: HashKind | null): [HashKind, HashKind] {
  const first = as ?? (hash.startsWith("00000") ? "block" : "tx");
  return first === "block" ? ["block", "tx"] : ["tx", "block"];
}

/**
 * Where a query leads: a page path (network-free), nothing, or a failure. Heights and addresses
 * need no request: the block page says when a height is not mined yet, and the address page
 * offers the right network for another network's address. A 64-hex id is asked for as the likelier
 * kind, then the other: one request when the guess is right, two when it is wrong or nothing
 * matches. The block probe is the block page's own first request (cached in memory, immutable);
 * the transaction probe is its small status, not a reply that can be megabytes.
 */
export async function resolve(query: Query | null, probe: Probe): Promise<Outcome> {
  if (query === null) return { kind: "missing", query };
  if (query.kind === "payment") return { kind: "go", path: paths.decode(query.text) };
  if (query.kind === "height") return { kind: "go", path: paths.block(query.height) };
  if (query.kind === "address") return { kind: "go", path: paths.address(query.address.address) };
  if (query.kind === "node") return { kind: "go", path: paths.lightningNode(query.key) };
  if (query.kind === "channel") return { kind: "go", path: paths.lightningChannel(query.id) };
  const { hash } = query;
  for (const kind of probeOrder(hash, query.as)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the second request is only made when the first finds nothing
      await probe(kind === "block" ? `/block/${hash}` : `/tx/${hash}/status`);
      return { kind: "go", path: kind === "block" ? paths.block(hash) : paths.tx(hash) };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { kind: "missing", query };
}

export type Get = (network: Network, path: string, signal: AbortSignal) => Promise<unknown>;

const get: Get = (network, path, signal) => fetchApi(network, path, { signal, cached: true });
const getApp: Get = (network, path, signal) => fetchApp(network, path, { signal, cached: true });

/** A node the Lightning index matched, ready to show: its name is gossip, cleaned, never markup. */
export interface Suggestion {
  key: string;
  name: string | null;
  capacity: number;
  path: string;
}

/** What the index matched, and whether the network has Lightning (unknown when not asked). */
export interface Suggestions {
  lightning: boolean | undefined;
  nodes: Suggestion[];
}

/**
 * One search and one suggestion request at a time: starting either, or cancelling, aborts the one
 * in flight, whose promise then answers undefined so a slow answer can never replace a newer one.
 * Whether a network has Lightning comes from the server's config, which the shell has already read;
 * a network without it is never asked to search.
 */
export function createSearch(
  fetch: Get = get,
  app: Get = getApp,
  config: () => Promise<AppConfig | null> = loadConfig,
) {
  let current: AbortController | undefined;
  const cancel = () => {
    current?.abort();
    current = undefined;
  };
  const start = () => {
    cancel();
    current = new AbortController();
    return current;
  };
  const lightning = async (network: Network) =>
    (await config())?.lightning.includes(network) ?? false;

  /**
   * Where `raw` leads on `network`. Text that is no identifier searches Lightning's node names
   * where the network has Lightning, unless `names` is false: a scanned code is what it holds,
   * never a name to look for.
   */
  const run = async (raw: string, network: Network, names = true): Promise<Outcome | undefined> => {
    const controller = start();
    const { signal } = controller;
    let outcome: Outcome;
    try {
      const query = classify(raw);
      outcome =
        names && query === null && searchProblem(raw) === undefined && (await lightning(network))
          ? { kind: "go", path: paths.lightningSearch(raw.trim()) }
          : await resolve(query, (path) => fetch(network, path, signal));
    } catch (error) {
      outcome = { kind: "failed", error };
    }
    if (signal.aborted) return undefined;
    current = undefined;
    return outcome;
  };

  /** Nodes whose name or key matches what is typed; none for an id, or without Lightning. */
  const suggest = async (raw: string, network: Network): Promise<Suggestions | undefined> => {
    const controller = start();
    const { signal } = controller;
    const none = (on?: boolean) => (signal.aborted ? undefined : { lightning: on, nodes: [] });
    if (classify(raw) !== null || searchProblem(raw) !== undefined) return none();
    if (!(await lightning(network))) return none(false);
    if (signal.aborted) return undefined;
    let found: unknown;
    try {
      found = await app(network, `/lightning/search?q=${encodeURIComponent(raw.trim())}`, signal);
    } catch {
      // Syncing, or unreachable: the field offers nothing, and Enter still opens the results page.
      return none(true);
    }
    if (signal.aborted) return undefined;
    current = undefined;
    if (!isSearchResult(found)) return none(true);
    return {
      lightning: true,
      nodes: found.nodes.map((n) => ({
        key: n.id,
        name: cleanAlias(n.alias),
        capacity: n.capacity,
        path: paths.lightningNode(n.id),
      })),
    };
  };

  return { run, suggest, cancel };
}

/**
 * Someone else's text (what a scanned code holds) fit to show: control and invisible format
 * characters, bidi overrides among them, made visible as U+FFFD, as an alias's are.
 */
export function visible(text: string): string {
  return cleanAlias(text) ?? "\u{FFFD}";
}

/** What the field gets from this module once it loads. */
export interface Logic {
  describe: typeof describe;
  createSearch: typeof createSearch;
  visible: typeof visible;
}
