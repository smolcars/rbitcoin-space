// What the command palette offers and how it ranks it. Pure: nothing here fetches or touches the
// page, so the ranking and the date reading are tested on their own (match.test.ts).
import { MONTHS } from "../lib/format";
import { NETWORK_NAMES, type Network, paths } from "../lib/network";

/** How well a query fits a name: higher is better, 0 is no match. */
export function score(query: string, name: string, words: readonly string[] = []): number {
  const q = fold(query);
  if (q === "") return 1;
  const n = fold(name);
  if (n === q) return 100;
  if (n.startsWith(q)) return 90 - Math.min(n.length - q.length, 20) / 4;
  if (starts(n, q)) return 70;
  const kw = words.map((w) => fold(w));
  if (kw.some((w) => w === q)) return 65;
  if (kw.some((w) => w.startsWith(q) || starts(w, q))) return 55;
  // Inside a word, or letters in order ("lnpen", Lightning penalties): only from three letters,
  // as two are inside half the names.
  if (q.length < 3) return 0;
  if (n.includes(q)) return 45;
  if (kw.some((w) => w.includes(q))) return 35;
  return inOrder(n, q) ? 20 : 0;
}

/** Lower case without accents or punctuation runs, so "Foundry-USA" and "foundry usa" agree. */
function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[\s_.\-/]+/g, " ")
    .trim();
}

/** Whether a word inside `name` (after a space) starts with `q`. */
function starts(name: string, q: string): boolean {
  return name.split(" ").some((w, i) => i > 0 && w.startsWith(q));
}

function inOrder(name: string, q: string): boolean {
  let at = 0;
  for (const ch of q.replaceAll(" ", "")) {
    at = name.indexOf(ch, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/** Keeps what matches with its score, best first; ties keep their given order. */
export function ranked<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => { name: string; words?: readonly string[] },
): { item: T; score: number }[] {
  return (
    items
      .map((item, i) => {
        const k = key(item);
        return { item, i, score: score(query, k.name, k.words) };
      })
      .filter((x) => x.score > 0)
      // oxlint-disable-next-line unicorn/no-array-sort -- sorts the fresh array map made; toSorted is newer than the browsers we build for
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ item, score: s }) => ({ item, score: s }))
  );
}

/** Keeps what matches, best first; ties keep their given order. */
export function rank<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => { name: string; words?: readonly string[] },
): T[] {
  return ranked(query, items, key).map((x) => x.item);
}

/**
 * Groups by their best match, so "ant" shows AntPool before a page that only has the letters in
 * order; groups that match as well keep their given order.
 */
export function orderGroups<G extends { best: number }>(groups: readonly G[]): G[] {
  return (
    groups
      .map((g, i) => ({ g, i }))
      // oxlint-disable-next-line unicorn/no-array-sort -- sorts the fresh array map made; toSorted is newer than the browsers we build for
      .sort((a, b) => b.g.best - a.g.best || a.i - b.i)
      .map((x) => x.g)
  );
}

/** What the server offers, which decides the pages and networks listed. */
export interface Offer {
  network: Network;
  networks: readonly Network[];
  lightning: boolean;
  ark: boolean;
  broadcast: boolean;
}

export interface Page {
  name: string;
  /** Network-free, from `paths`, so it is a route the app has (match.test.ts holds it to them). */
  path: string;
  words: readonly string[];
}

/** The app's pages a reader would go to by name, in the order the header and footer list them. */
export function pages(offer: Offer): Page[] {
  const all: (Page & { when?: boolean })[] = [
    { name: "Home", path: paths.home(), words: ["fees", "dashboard", "start", "strip"] },
    { name: "Blocks", path: paths.blocks(), words: ["recent blocks", "latest", "chain"] },
    { name: "Next block", path: paths.projected(1), words: ["projected", "upcoming", "template"] },
    { name: "Mempool", path: paths.mempool(), words: ["history", "backlog", "unconfirmed"] },
    { name: "Replacements", path: paths.rbf(), words: ["rbf", "replace by fee", "full rbf"] },
    { name: "Mining", path: paths.mining(), words: ["pools", "hashrate", "difficulty"] },
    { name: "Lightning", path: paths.lightning(), words: ["ln", "nodes", "channels"] },
    {
      name: "Lightning rankings",
      path: paths.lightningRankings(),
      words: ["ln", "largest nodes", "top nodes"],
      when: offer.lightning,
    },
    {
      name: "Lightning penalties",
      path: paths.lightningPenalties(),
      words: ["ln", "justice", "breach"],
      when: offer.lightning,
    },
    { name: "Ark", path: paths.ark(), words: ["vtxo", "bark", "arkade"], when: offer.ark },
    {
      name: "Decoder",
      path: paths.decode(),
      words: ["decode", "invoice", "bolt11", "offer", "lnurl", "raw transaction", "hex"],
    },
    {
      name: "Broadcast",
      path: paths.push(),
      words: ["push", "send transaction", "publish"],
      when: offer.broadcast,
    },
  ];
  return all
    .filter((p) => p.when !== false && (p.path !== paths.lightning() || offer.lightning))
    .map(({ name, path, words }) => ({ name, path, words }));
}

export type Action =
  | { kind: "network"; network: Network }
  | { kind: "theme"; to: "light" | "dark" };

export interface ActionItem {
  name: string;
  words: readonly string[];
  action: Action;
}

/** Switching to each other network this server has on, and to the other theme. */
export function actions(offer: Offer, shown: "light" | "dark"): ActionItem[] {
  const to = shown === "dark" ? "light" : "dark";
  return [
    ...offer.networks
      .filter((n) => n !== offer.network)
      .map((n) => ({
        name: `Switch to ${NETWORK_NAMES[n]}`,
        words: ["network", NETWORK_NAMES[n], n === "mainnet" ? "bitcoin" : "test network"],
        action: { kind: "network" as const, network: n },
      })),
    {
      name: `Switch to ${to} theme`,
      words: ["theme", "appearance", to === "dark" ? "dark mode night" : "light mode day"],
      action: { kind: "theme", to },
    },
  ];
}

/** A pool from `/api/v1/mining/pools`, its name cleaned: the list is read as untrusted text. */
export interface Pool {
  name: string;
  slug: string;
}

/** Keeps the entries with a usable name and slug; anything else in the answer is dropped. */
export function readPools(body: unknown, clean: (name: unknown) => string | null): Pool[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((p: unknown) => {
    if (typeof p !== "object" || p === null) return [];
    const name = "name" in p ? clean(p.name) : null;
    const slug = "slug" in p && typeof p.slug === "string" ? p.slug : "";
    return name !== null && /^[a-z0-9-]{1,64}$/.test(slug) ? [{ name, slug }] : [];
  });
}

/** A typed date or moment, read in UTC as every time on the site is written. */
export interface Moment {
  /** Unix seconds: the end of the day for a date, the end of the minute or second given. */
  at: number;
  /** How the row says it: `20 Apr 2024` or `20 Apr 2024, 14:30`. */
  label: string;
  /** Whether a time of day was given. */
  timed: boolean;
  /** Before Bitcoin's first block: no block can be at or before it. */
  early: boolean;
  /** Its cutoff is still to come, so `at` is now and its answer may change until it passes. */
  open: boolean;
}

/** Bitcoin's first block, 3 Jan 2009 18:15:05 UTC: nothing before it has a block. */
export const GENESIS_TIME = 1_231_006_505;

const MONTH_WORDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function month(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return null;
  const i = MONTH_WORDS.findIndex(
    (m) => m.startsWith(w) && (w.length === 3 || m === w || w === "sept"),
  );
  return i === -1 ? null : i + 1;
}

/**
 * A date in a form that cannot be misread: `2024-04-20` (or with `/` or `.`), with an optional
 * `14:30` or `14:30:05` after a space or `T` and an optional `Z` or `UTC`; or with the month in
 * words, `20 Apr 2024`, `20 April 2024`, `April 20, 2024`. No `04/05/2024`, which is two dates.
 * Null for anything else, an impossible day, or more than a year ahead; a time before the first
 * block is read, and marked `early`.
 */
export function readDate(input: string, now: number): Moment | null {
  const q = input.trim().replace(/\s*(?:z|utc)$/i, "");
  let y: number;
  let mo: number;
  let d: number;
  let time: string | undefined;
  const iso = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[\sT]+(\d{1,2}:\d{2}(?::\d{2})?))?$/i.exec(q);
  const dmy = /^(\d{1,2})\s+([a-z]+\.?)\s+(\d{4})(?:,?\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/i.exec(q);
  const mdy =
    /^([a-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/i.exec(
      q,
    );
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[3]), Number(iso[4])];
    time = iso[5];
  } else if (dmy) {
    const m = month(dmy[2] ?? "");
    if (m === null) return null;
    [y, mo, d] = [Number(dmy[3]), m, Number(dmy[1])];
    time = dmy[4];
  } else if (mdy) {
    const m = month(mdy[1] ?? "");
    if (m === null) return null;
    [y, mo, d] = [Number(mdy[3]), m, Number(mdy[2])];
    time = mdy[4];
  } else {
    return null;
  }
  const [h = 23, mi = 59, s] = (time ?? "").split(":").filter(Boolean).map(Number);
  const sec = s ?? 59;
  if (h > 23 || mi > 59 || sec > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec);
  const back = new Date(ms);
  // Date.UTC rolls 30 February over into March: a day that does not exist is not a date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  const at = Math.floor(ms / 1000);
  if (at > now + 86_400 * 366) return null;
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${d} ${MONTHS[mo - 1] ?? ""} ${y}`;
  const clock =
    time === undefined ? "" : `, ${two(h)}:${two(mi)}${s === undefined ? "" : `:${two(s)}`}`;
  // Whole seconds: the timestamp route takes digits only.
  return {
    at: Math.floor(Math.min(at, now)),
    label: day + clock,
    timed: time !== undefined,
    early: at < GENESIS_TIME,
    open: at > now,
  };
}
