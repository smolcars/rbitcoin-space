// The Lightning overview's live data: the `lightning-feed` topic and its HTTP twin (docs/WS.md
// "lightning-feed"), the movers and the closes by day (docs/API.md "The overview"), their shape
// checks, and how the feed's list is kept. Pure but for the topic object.
import { sorted } from "../../components/chart/geometry";
import type { Topic } from "../../lib/live";
import type { CloseKind, Fees, NodeRef } from "./lightning";

interface EventBase {
  time: number;
  id: string;
  scid: string;
  capacity: number;
  node_one: NodeRef;
  node_two: NodeRef;
}

export type FeedEvent = EventBase &
  (
    | { event: "opened"; height: number }
    | { event: "closed"; height: number; kind: CloseKind }
    | { event: "fee"; by: "node_one" | "node_two"; before: Fees; after: Fees }
  );
export type FeedKind = FeedEvent["event"];

export type FeedMessage =
  | { type: "recent"; events: FeedEvent[] }
  | { type: "events"; events: FeedEvent[]; more: number };

export interface Mover {
  id: string;
  alias: string | null;
  capacity_change: number;
  channels_change: number;
  capacity: number;
  channels: number;
  /** `new` and `left` only: the node's first funding, or its last close. */
  time?: number;
}

export interface Movers {
  period: string;
  from: number;
  time: number;
  capacity_up: Mover[];
  capacity_down: Mover[];
  channels_up: Mover[];
  channels_down: Mover[];
  new: Mover[];
  left: Mover[];
}

export interface DayCloses {
  time: number;
  cooperative: number;
  force: number;
  penalty: number;
  other: number;
  capacity: number;
}

export interface Closes {
  time: number;
  days: DayCloses[];
  total: Omit<DayCloses, "time">;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const list = <T>(v: unknown, f: (v: unknown) => v is T): v is T[] =>
  Array.isArray(v) && v.every((x) => f(x));

const isRef = (v: unknown): v is NodeRef =>
  obj(v) && str(v["id"]) && (v["alias"] === null || str(v["alias"]));
const isInbound = (v: unknown) =>
  v === null || (obj(v) && num(v["fee_rate"]) && num(v["base_fee_msat"]));
const isFees = (v: unknown): v is Fees =>
  obj(v) && num(v["fee_rate"]) && num(v["base_fee_msat"]) && isInbound(v["inbound_fee"] ?? null);
const KINDS: ReadonlySet<unknown> = new Set(["cooperative", "force", "penalty", "other"]);

export function isFeedEvent(v: unknown): v is FeedEvent {
  if (!obj(v) || !num(v["time"]) || !str(v["id"]) || !str(v["scid"]) || !num(v["capacity"]))
    return false;
  if (!isRef(v["node_one"]) || !isRef(v["node_two"])) return false;
  const e = v["event"];
  if (e === "opened") return num(v["height"]);
  if (e === "closed") return num(v["height"]) && KINDS.has(v["kind"]);
  return (
    e === "fee" &&
    (v["by"] === "node_one" || v["by"] === "node_two") &&
    isFees(v["before"]) &&
    isFees(v["after"])
  );
}

/** The events of a message or answer that this page can read; one it cannot is left out, not the lot. */
const readable = (v: unknown): FeedEvent[] | undefined =>
  Array.isArray(v) ? v.filter((e) => isFeedEvent(e)) : undefined;

export const isFeed = (v: unknown): v is { events: FeedEvent[] } =>
  obj(v) && Array.isArray(v["events"]);
/** The feed's answer with only the events this page can read. */
export const readFeed = (v: { events: unknown[] }): FeedEvent[] => readable(v.events) ?? [];

export const feedTopic: Topic<FeedMessage> = {
  name: "lightning-feed",
  parse(m) {
    const e = readable(m["events"]);
    if (e === undefined) return undefined;
    if (m["type"] === "recent") return { type: "recent", events: e };
    if (m["type"] === "events")
      return { type: "events", events: e, more: num(m["more"]) ? m["more"] : 0 };
    return undefined;
  },
};

const isMover = (v: unknown): v is Mover =>
  isRef(v) &&
  obj(v) &&
  num(v["capacity_change"]) &&
  num(v["channels_change"]) &&
  num(v["capacity"]) &&
  num(v["channels"]) &&
  (v["time"] === undefined || num(v["time"]));

const MOVER_LISTS = [
  "capacity_up",
  "capacity_down",
  "channels_up",
  "channels_down",
  "new",
  "left",
] as const;
export const isMovers = (v: unknown): v is Movers =>
  obj(v) && num(v["from"]) && num(v["time"]) && MOVER_LISTS.every((k) => list(v[k], isMover));

const COUNTS = ["cooperative", "force", "penalty", "other", "capacity"];
const isDay = (v: unknown): v is DayCloses =>
  obj(v) && num(v["time"]) && COUNTS.every((k) => num(v[k]));
export const isCloses = (v: unknown): v is Closes =>
  obj(v) &&
  num(v["time"]) &&
  list(v["days"], isDay) &&
  obj(v["total"]) &&
  COUNTS.every((k) => num((v["total"] as Obj)[k]));

// The feed's list.

/** Rows the page holds of each kind, and the most it shows at once. */
export const KEEP = 30;

/** An event, or where a burst left some out ("and N more"). `batch` counts arrivals from 0. */
export type Row = { key: string; batch: number } & (
  | { ev: FeedEvent; more?: undefined }
  | { ev?: undefined; more: number }
);

/** What tells two events apart (docs/WS.md "Keeping up"). */
export const eventKey = (e: FeedEvent): string =>
  `${e.event}|${e.scid}|${e.time}|${e.event === "fee" ? e.by : ""}`;

/**
 * The events heard of each kind, newest heard last, so a snapshot after a reconnect adds only what
 * was missed. shortcut: 200 a kind is four snapshots' worth; an event heard longer ago than that
 * and still in a snapshot would come back as new, which needs a quieter kind than any on mainnet.
 */
export class Seen {
  private readonly keys = new Map<FeedKind, Set<string>>();

  /** The events not heard before, each once, newest first; marks them heard. */
  fresh(events: readonly FeedEvent[]): FeedEvent[] {
    const out: FeedEvent[] = [];
    for (const e of events) {
      let set = this.keys.get(e.event);
      if (!set) this.keys.set(e.event, (set = new Set()));
      const k = eventKey(e);
      if (set.has(k)) continue;
      set.add(k);
      if (set.size > 200) set.delete(set.values().next().value as string);
      out.push(e);
    }
    return sorted(out, (a, b) => b.time - a.time);
  }
}

/**
 * The list after a batch arrives: its events on top, then where it left some out, then what was
 * there; at most `KEEP` of each kind, and only the newest three "more" rows. A batch lists its
 * opens and closes first, each kind newest first: a burst is fee changes, and an open is dated an
 * hour or more before it arrives, so by time alone a burst would cut it.
 */
export function place(
  rows: readonly Row[],
  fresh: readonly FeedEvent[],
  more: number,
  batch: number,
): Row[] {
  // A burst that would fill the list leaves a place for its "and N more", so it is seen.
  const room = more > 0 || fresh.length > KEEP ? KEEP - 1 : KEEP;
  const ordered = sorted(
    fresh,
    (a, b) => Number(a.event === "fee") - Number(b.event === "fee") || b.time - a.time,
  );
  const top: Row[] = ordered.slice(0, room).map((ev) => ({ key: eventKey(ev), batch, ev }));
  const left = more + Math.max(0, fresh.length - room);
  if (left > 0) top.push({ key: `more|${batch}`, batch, more: left });
  const counts = new Map<string, number>();
  return [...top, ...rows].filter((r) => {
    const kind = r.ev?.event ?? "more";
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    return n <= (kind === "more" ? 3 : KEEP);
  });
}

/** The fewest days the closes chart draws, so one day's bar is never a panel wide. */
export const MIN_DAYS = 7;

/**
 * The days the closes chart draws: from the first day this server recorded when its record is
 * shorter than the span, so the bars use the width rather than hatching most of it; at least
 * `MIN_DAYS` all the same, the days among them before the record still unknown.
 */
export function drawnDays(days: readonly DayCloses[], first: number | null): DayCloses[] {
  if (first === null) return [...days];
  const known = days.findIndex((d) => d.time + 86_400 > first);
  const start = Math.min(known === -1 ? days.length : known, days.length - MIN_DAYS);
  return days.slice(Math.max(0, start));
}

export type FeedFilter = "all" | "opened" | "closed" | "fee";

/** The rows shown for a filter: at most `KEEP`; "and N more" only in the whole list, since a
 *  burst's count is not by kind. */
export const shown = (rows: readonly Row[], filter: FeedFilter): Row[] =>
  rows.filter((r) => (filter === "all" ? true : r.ev?.event === filter)).slice(0, KEEP);

/** Movers in the order a reader asks for: one measure, gained, lost or the largest either way. */
export function moversFor(
  m: Movers,
  measure: "capacity" | "channels",
  way: "gained" | "lost" | "either",
): Mover[] {
  const up = measure === "capacity" ? m.capacity_up : m.channels_up;
  const down = measure === "capacity" ? m.capacity_down : m.channels_down;
  if (way === "gained") return up;
  if (way === "lost") return down;
  const change = (r: Mover) =>
    Math.abs(measure === "capacity" ? r.capacity_change : r.channels_change);
  // The ten largest either way are among the ten largest each way.
  return sorted([...up, ...down], (a, b) => change(b) - change(a)).slice(0, 10);
}
