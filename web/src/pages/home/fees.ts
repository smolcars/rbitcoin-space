// The "Fee to pay now" panel's data: the `fees` topic (docs/WS.md "Mempool topics"), and
// `/v1/fees/precise` (docs/API.md "Fees") only while the topic cannot be heard. Rates are sat/vB
// here: the wire's sat per 1,000 vB ÷ 1,000.
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { fetchStamped, type Stamped } from "../../lib/api";
import { type LiveStatus, type Topic, useTopic } from "../../lib/live";
import type { Network } from "../../lib/network";
import { TOPIC_GRACE_MS } from "./live-mempool";

export type LevelName = "high" | "medium" | "low" | "no_rush";

export interface FeeLevel {
  name: LevelName;
  blocks: number;
  minutes: number;
  rate: number;
}

export interface FeeAnswer {
  /** `projected` is this server's own; `node` the node's estimates, served while ours cannot be. */
  source: "projected" | "node";
  /** Fastest first, as the server sends them. */
  levels: FeeLevel[];
}

/** `unavailable`: the server has no answer it would stand behind, so none is shown. */
export type FeesMessage = { type: "fees"; answer: FeeAnswer } | { type: "unavailable" };

/** The levels in the server's order, with the precise route's name for each. */
const LEVELS = [
  { name: "high", field: "fastestFee", blocks: 1, minutes: 10 },
  { name: "medium", field: "halfHourFee", blocks: 3, minutes: 30 },
  { name: "low", field: "hourFee", blocks: 6, minutes: 60 },
  { name: "no_rush", field: "economyFee", blocks: 144, minutes: 1440 },
] as const;

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export const feesTopic: Topic<FeesMessage> = {
  name: "fees",
  parse(m) {
    if (m["type"] === "unavailable") return { type: "unavailable" };
    const { source, levels } = m;
    if (
      m["type"] !== "fees" ||
      (source !== "projected" && source !== "node") ||
      !Array.isArray(levels) ||
      levels.length !== LEVELS.length
    ) {
      return undefined;
    }
    const read: FeeLevel[] = [];
    for (const [i, want] of LEVELS.entries()) {
      const l: unknown = levels[i];
      if (typeof l !== "object" || l === null) return undefined;
      const { name, blocks, minutes, rate } = l as Record<string, unknown>;
      if (name !== want.name || !isCount(blocks) || !isCount(minutes) || !isCount(rate)) {
        return undefined;
      }
      read.push({ name: want.name, blocks, minutes, rate: rate / 1000 });
    }
    return { type: "fees", answer: { source, levels: read } };
  },
};

/** The precise route's answer. Ours names the tip it was projected on; the node's names none. */
export function fromPrecise(reply: Stamped<unknown>): FeeAnswer | undefined {
  const v = reply.value;
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const levels: FeeLevel[] = [];
  for (const { name, field, blocks, minutes } of LEVELS) {
    const rate = o[field];
    if (!isRate(rate)) return undefined;
    levels.push({ name, blocks, minutes, rate });
  }
  return { source: reply.tip ? "projected" : "node", levels };
}

/**
 * How often the precise route is asked while the topic cannot be heard: as often as the page asked
 * for the node's estimates before, so a page with its socket down asks no more of the server.
 */
export const FEES_POLL_MS = 30_000;
/**
 * How long the last answer stays up while the next ask has not settled. A refusal is retried for
 * up to a minute (`withRetry`), and a withdrawn answer is a 503: it must not stay up meanwhile.
 */
export const FEES_CONFIRM_MS = 2_000;

/**
 * The recommendation to show: undefined until one is known, null when there is none. The topic
 * says so itself when its answer is withdrawn; while the socket is down, or before the topic has
 * said anything 5 s after the page opened, the answer comes from the precise route instead, and
 * the topic's last one is dropped rather than shown as current.
 */
export function createFees(
  network: Network,
  status: Accessor<LiveStatus>,
): Accessor<FeeAnswer | null | undefined> {
  const [answer, setAnswer] = createSignal<FeeAnswer | null>();
  const [heard, setHeard] = createSignal(false);
  const [silent, setSilent] = createSignal(false);
  const grace = setTimeout(() => setSilent(true), TOPIC_GRACE_MS);
  onCleanup(() => clearTimeout(grace));

  // Where the answer on screen came from: the socket's last word stands until a reply replaces it;
  // an HTTP answer the next ask cannot confirm in time is taken down (`doubt`).
  let fromTopic = false;
  useTopic(feesTopic, {
    message: (m) => {
      fromTopic = true;
      setHeard(true);
      setAnswer(m.type === "fees" ? m.answer : null);
    },
    resync: () => {
      // Each message is the whole state: the snapshot after a reconnect replaces what was missed.
    },
  });

  const down = () => status() === "reconnecting" || status() === "offline";
  createEffect(
    () => down() || (!heard() && silent()),
    (polling) => {
      if (!polling) return undefined;
      // The last answer heard stays while the page reconnects (a tab back from the background):
      // the snapshot after reconnecting replaces it, and an ask that cannot confirm it in time
      // takes it down (`doubt`).
      const controller = new AbortController();
      let asking = false;
      let doubt: ReturnType<typeof setTimeout> | undefined;
      const ask = () => {
        // One ask at a time: aborting a retrying one would keep its refusal from ever landing.
        if (asking) return;
        asking = true;
        // Only a number is taken down: "no answer" stays until there is one.
        doubt = setTimeout(
          () => setAnswer((now) => (now && !fromTopic ? undefined : now)),
          FEES_CONFIRM_MS,
        );
        const settle = (a: FeeAnswer | null) => {
          clearTimeout(doubt);
          asking = false;
          if (controller.signal.aborted) return;
          fromTopic = false;
          setAnswer(a);
        };
        fetchStamped<unknown>(network, "/v1/fees/precise", {
          signal: controller.signal,
          cached: true,
        }).then(
          (r) => settle(fromPrecise(r) ?? null),
          () => settle(null),
        );
      };
      ask();
      const timer = setInterval(() => {
        if (!document.hidden) ask();
      }, FEES_POLL_MS);
      return () => {
        clearInterval(timer);
        clearTimeout(doubt);
        controller.abort();
      };
    },
  );
  return answer;
}

/** The four levels as the panel shows them, slowest first. */
export const PRIORITIES: readonly { level: LevelName; name: string; when: string }[] = [
  { level: "no_rush", name: "No rush", when: "within a day" },
  { level: "low", name: "Low", when: "within an hour" },
  { level: "medium", name: "Medium", when: "within 30 min" },
  { level: "high", name: "High", when: "next block" },
];

/** One answer the panel shows: levels next to each other that print the same rate read as one. */
export interface FeeGroup {
  /** "No rush", "No rush or low", "Any wait". */
  name: string;
  /** The fastest wait among them: paying the rate buys that. */
  when: string;
  /** How many of the four levels it stands for. */
  span: number;
  /** sat/vB; undefined when the answer has no rate for these levels. */
  rate: number | undefined;
}

/**
 * Groups the four levels, slowest first, merging neighbours whose rates print the same. The panel
 * lays them out two by two in the same two rows whatever the grouping, so a live update never moves
 * what follows it: Low and Medium alone are never merged, as that pair is not a row.
 */
export function groupLevels(
  answer: FeeAnswer | undefined,
  print: (rate: number) => string,
): FeeGroup[] {
  const groups: { members: (typeof PRIORITIES)[number][]; rate: number | undefined }[] = [];
  for (const p of PRIORITIES) {
    const rate = answer?.levels.find((l) => l.name === p.level)?.rate;
    const last = groups.at(-1);
    if (last && rate !== undefined && last.rate !== undefined && print(last.rate) === print(rate))
      last.members.push(p);
    else groups.push({ members: [p], rate });
  }
  // Low and Medium merged with neither neighbour would straddle the two rows: keep them apart.
  if (groups.length === 3 && groups[1]?.members.length === 2) {
    const [first, pair, last] = groups;
    if (first !== undefined && pair !== undefined && last !== undefined) {
      groups.splice(
        0,
        3,
        first,
        ...pair.members.map((m) => ({
          members: [m],
          rate: answer?.levels.find((l) => l.name === m.level)?.rate,
        })),
        last,
      );
    }
  }
  return groups.map(({ members, rate }) => {
    const names = members.map((m, i) => (i === 0 ? m.name : m.name.toLowerCase()));
    const name =
      members.length === PRIORITIES.length
        ? "Any wait"
        : names.length === 1
          ? (names[0] ?? "")
          : `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;
    return { name, when: members.at(-1)?.when ?? "", span: members.length, rate };
  });
}
