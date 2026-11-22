// Recent replacement trees (`/api/v1/replacements`, docs/API.md "Replacement trees") read as
// stories, and the `replacements` topic that says when to ask again (docs/WS.md). The `/rbf` page
// and the home page's panel share them.
import { createSignal, flush, onSettled, untrack } from "solid-js";
import { ApiError, fetchApi } from "./api";
import { type Topic, useLiveStatus, useTopic } from "./live";
import type { Network } from "./network";

/** One transaction of a tree, as the server held it. Figures are `null` for a root it never held. */
export interface TreeTx {
  txid: string;
  fee: number | null;
  vsize: number | null;
  rate: number | null;
  /** When the node accepted it, unix seconds. */
  time: number;
  /** It signalled replaceability itself (BIP 125). */
  rbf: boolean | null;
}

/** A replacement and what it removed, recursively; the root is the newest. */
export interface Tree {
  tx: TreeTx;
  time: number;
  /** Seconds from this one's arrival to its replacement's; absent on the root. */
  interval?: number;
  /** This one or anything below it was replaced without signalling. */
  fullRbf: boolean;
  replaces: Tree[];
  /** On the root: `true` mined, `null` unknown after a reorg, absent not mined. */
  mined?: boolean | null;
}

export type Mined = "mined" | "waiting" | "unknown";

export interface Version {
  tx: TreeTx;
  /** Seconds it stood before the next version replaced it; absent on the newest. */
  stood?: number;
}

/** A tree as a story: the line of versions, oldest first, and everything else it removed. */
export interface Story {
  /** The newest replacement's txid: names the story. */
  id: string;
  /** When the newest replacement arrived, unix seconds. */
  time: number;
  versions: Version[];
  /** Also replaced on the way (a replaced transaction's children, other conflicts). */
  others: TreeTx[];
  mined: Mined;
  fullRbf: boolean;
  /** The newest version's rate less the oldest's, sat/vB; undefined when either is unknown. */
  rise: number | undefined;
}

const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);

function readTx(v: unknown): TreeTx | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const t = v as Record<string, unknown>;
  const { txid, fee, vsize, rate, time, rbf } = t;
  if (!isHash(txid) || !numOrNull(fee) || !numOrNull(vsize) || !numOrNull(rate) || !isNum(time)) {
    return undefined;
  }
  if (!(rbf === null || typeof rbf === "boolean")) return undefined;
  return { txid, fee, vsize, rate, time, rbf };
}

/** Deepest tree read: the server's trees hold at most 100 transactions (`MAX_TREE`). */
const MAX_DEPTH = 128;

/** A tree as sent, or undefined for a shape this page cannot draw. */
export function readTree(v: unknown, depth = 0): Tree | undefined {
  if (typeof v !== "object" || v === null || depth > MAX_DEPTH) return undefined;
  const t = v as Record<string, unknown>;
  const tx = readTx(t["tx"]);
  const { time, interval, fullRbf, replaces, mined } = t;
  if (!tx || !isNum(time) || typeof fullRbf !== "boolean" || !Array.isArray(replaces)) {
    return undefined;
  }
  const kids: Tree[] = [];
  for (const r of replaces) {
    const k = readTree(r, depth + 1);
    if (!k) return undefined;
    kids.push(k);
  }
  const tree: Tree = { tx, time, fullRbf, replaces: kids };
  if (isNum(interval)) tree.interval = interval;
  if (mined === true || mined === null) tree.mined = mined;
  return tree;
}

const depth = (t: Tree): number => 1 + Math.max(0, ...t.replaces.map(depth));

/**
 * Reads a tree as a story. The line of versions follows, from the newest back, the replaced
 * transaction whose own history runs deepest (the earliest on a tie): a chain of bumps reads as
 * one line, and what left with it (children, other conflicts) is listed apart.
 */
export function storyOf(tree: Tree): Story {
  const line: Tree[] = [tree];
  const others: TreeTx[] = [];
  const collect = (t: Tree) => {
    others.push(t.tx);
    t.replaces.forEach(collect);
  };
  for (let at = tree; at.replaces.length > 0;) {
    const next = at.replaces.reduce((a, b) =>
      depth(b) > depth(a) || (depth(b) === depth(a) && b.time < a.time) ? b : a,
    );
    for (const r of at.replaces) if (r !== next) collect(r);
    line.push(next);
    at = next;
  }
  line.reverse();
  const versions = line.map((t) =>
    t.interval === undefined ? { tx: t.tx } : { tx: t.tx, stood: t.interval },
  );
  const first = line[0]?.tx.rate;
  const last = tree.tx.rate;
  return {
    id: tree.tx.txid,
    time: tree.time,
    versions,
    others,
    mined: tree.mined === true ? "mined" : tree.mined === null ? "unknown" : "waiting",
    fullRbf: tree.fullRbf,
    rise: isNum(first) && isNum(last) && line.length > 1 ? last - first : undefined,
  };
}

/** How long a version stood: `6 s`, `29 min`, `1 h 2 min`, `3 days`. */
export function formatStood(seconds: number): string {
  if (!isNum(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

/** The record's version, or `off` when the server does not track this network's mempool. */
export type ReplacementsMessage = { type: "version"; version: number } | { type: "off" };

export const replacementsTopic: Topic<ReplacementsMessage> = {
  name: "replacements",
  parse(m) {
    if (m["type"] === "off") return { type: "off" };
    const v = m["version"];
    return m["type"] === "replacements" && isNum(v) ? { type: "version", version: v } : undefined;
  },
};

/**
 * When each list was last asked for or answered, by any feed on the page, so a burst of changes
 * costs one ask per gap. Every ask skips the browser's cache, which can hold the list from before
 * the change (docs/FRONTEND.md "Following live data").
 */
const asked = new Map<string, number>();
/**
 * The last answer to each list, page-wide, so a feed opened again (the reader came back to the
 * home page, or went on to the mempool page) shows it at once while it asks for a newer one.
 */
const answers = new Map<string, Tree[]>();

/** Waits this long for the topic before asking over HTTP anyway. */
export const TOPIC_WAIT_MS = 3000;
/** How often to ask while the live channel is down. */
export const POLL_MS = 30_000;

export interface Replacements {
  /** Newest first; undefined until the first answer. The same object for a story that did not change. */
  stories: () => Story[] | undefined;
  error: () => unknown;
  /** The server does not track this network's mempool. */
  off: () => boolean;
  refresh: () => void;
}

/**
 * The newest stories, kept current: asked for when the `replacements` topic says the record
 * changed (no sooner than `gapMs` after the list was last asked for by any feed: see `asked`),
 * every `POLL_MS` while the
 * live channel is down, and on `refresh` (call it when `fullRbf` changes). `around` runs just
 * before each change is applied and returns what to do just after (the page keeps the reader's
 * place with it).
 */
export function createReplacements(
  network: Network,
  fullRbf: () => boolean,
  options: { gapMs: number; around?: () => (() => void) | undefined },
): Replacements {
  const listKey = (full: boolean) =>
    `${network}${full ? "/v1/fullrbf/replacements" : "/v1/replacements"}`;
  let kept = new Map<string, [string, Story]>();
  let shownFull: boolean | undefined;
  /** The trees as stories, reusing each one that did not change. */
  const read = (trees: Tree[], full: boolean) => {
    const next = new Map<string, [string, Story]>();
    const list = trees.map((t) => {
      const key = JSON.stringify(t);
      const old = full === shownFull ? kept.get(t.tx.txid) : undefined;
      const s = old && old[0] === key ? old[1] : storyOf(t);
      next.set(t.tx.txid, [key, s]);
      return s;
    });
    kept = next;
    shownFull = full;
    return list;
  };
  // A list this page already holds is shown at once and asked for again, within the gap: the
  // topic sends no first message to a feed that joins while another is subscribed.
  const startFull = untrack(fullRbf);
  const held = answers.get(listKey(startFull));
  const [stories, setStories] = createSignal<Story[] | undefined>(held && read(held, startFull));
  const [error, setError] = createSignal<unknown>();
  const [off, setOff] = createSignal(false);
  const status = useLiveStatus();
  let heard: number | undefined;
  let controller: AbortController | undefined;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const apply = (trees: Tree[], full: boolean) => {
    const list = read(trees, full);
    setOff(false);
    const after = options.around?.();
    setStories(list);
    setError(undefined);
    flush();
    after?.();
  };

  const load = () => {
    if (controller) {
      again = true;
      return;
    }
    clearTimeout(timer);
    const full = fullRbf();
    const path = full ? "/v1/fullrbf/replacements" : "/v1/replacements";
    const key = listKey(full);
    const wait = (asked.get(key) ?? 0) + options.gapMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(load, wait);
      return;
    }
    asked.set(key, Date.now());
    const c = new AbortController();
    controller = c;
    void (async () => {
      try {
        const answer = await fetchApi<unknown>(network, path, { signal: c.signal });
        if (!Array.isArray(answer)) {
          throw new ApiError(0, "The server sent a list this page cannot read.");
        }
        const trees = answer.map((t) => readTree(t)).filter((t): t is Tree => t !== undefined);
        answers.set(key, trees);
        apply(trees, full);
      } catch (e: unknown) {
        if (c.signal.aborted) return;
        if (
          e instanceof ApiError &&
          e.status === 503 &&
          e.message.includes("mempool engine is off")
        ) {
          setOff(true);
        } else setError(e);
      } finally {
        // The gap counts from the answer too, which a retry can delay.
        asked.set(key, Date.now());
        if (controller === c) {
          controller = undefined;
          if (again) {
            again = false;
            load();
          }
        }
      }
    })();
  };

  /** Starts over: the filter changed or the reader asked. */
  const refresh = () => {
    controller?.abort();
    controller = undefined;
    again = false;
    load();
  };

  useTopic(replacementsTopic, {
    message: (m) => {
      if (m.type === "off") {
        setOff(true);
        return;
      }
      // A record to read: the engine is on (again, after a restart that turned it on).
      setOff(false);
      if (m.version === heard) return;
      heard = m.version;
      load();
    },
    resync: load,
  });

  onSettled(() => {
    if (held) load();
    // The topic's first message is the record as it stands; without one soon, ask anyway.
    const first = setTimeout(() => {
      if (heard === undefined && !off()) load();
    }, TOPIC_WAIT_MS);
    const poll = setInterval(() => {
      if (status() !== "live" && !off()) load();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      clearTimeout(timer);
      controller?.abort();
    };
  });
  return { stories, error, off, refresh };
}
