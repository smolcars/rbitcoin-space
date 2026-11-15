import { describe, expect, it } from "vitest";
import {
  drawnDays,
  feedTopic,
  isCloses,
  MIN_DAYS,
  isFeedEvent,
  KEEP,
  moversFor,
  place,
  type Row,
  Seen,
  shown,
} from "./feed";
import { closeEvent, closes, feeEvent, movers, openEvent } from "./testdata";

const keys = (rows: Row[]) => rows.map((r) => (r.ev ? r.ev.id : `more ${r.more ?? 0}`));

describe("the feed's messages", () => {
  it("reads each kind and leaves out an event it cannot read, not the message", () => {
    const m = feedTopic.parse({
      type: "events",
      more: 3,
      events: [openEvent(1), { ...feeEvent(1), by: "node_three" }, closeEvent(2, "penalty")],
    });
    expect(m).toStrictEqual({
      type: "events",
      more: 3,
      events: [openEvent(1), closeEvent(2, "penalty")],
    });
    expect(feedTopic.parse({ type: "recent", events: [] })).toStrictEqual({
      type: "recent",
      events: [],
    });
    expect(feedTopic.parse({ type: "other", events: [] })).toBeUndefined();
    expect(feedTopic.parse({ type: "recent" })).toBeUndefined();
  });

  it("refuses closes whose totals it cannot read", () => {
    expect(isCloses(closes())).toBe(true);
    expect(isCloses({ ...closes(), total: {} })).toBe(false);
    expect(isCloses({ ...closes(), total: { ...closes().total, force: "1" } })).toBe(false);
  });

  it("refuses an event of an unknown kind or with a field missing", () => {
    expect(isFeedEvent({ ...openEvent(1), event: "spliced" })).toBe(false);
    expect(isFeedEvent({ ...closeEvent(1, "force"), kind: "breach" })).toBe(false);
    expect(isFeedEvent({ ...openEvent(1), node_one: { id: 1, alias: null } })).toBe(false);
    expect(isFeedEvent({ ...feeEvent(1), after: null })).toBe(false);
    expect(isFeedEvent(feeEvent(1, 0, 5, true))).toBe(true);
  });
});

describe("the feed's list", () => {
  it("passes each event once, by kind, channel, time and end, newest first", () => {
    const seen = new Seen();
    expect(seen.fresh([feeEvent(1), feeEvent(3)]).map((e) => e.id)).toStrictEqual([
      feeEvent(3).id,
      feeEvent(1).id,
    ]);
    // A reconnect's snapshot holds the same events and one missed.
    const other = { ...feeEvent(1), by: "node_one" as const };
    expect(seen.fresh([feeEvent(3), feeEvent(1), feeEvent(2), other])).toStrictEqual([
      feeEvent(2),
      other,
    ]);
  });

  it("puts a batch on top, keeps 30 of each kind and leaves room to say how many were left out", () => {
    let rows = place([], [openEvent(1), closeEvent(2, "force")], 0, 0);
    const burst = Array.from({ length: 50 }, (_, i) => feeEvent(i));
    rows = place(rows, burst, 23, 1);
    const all = shown(rows, "all");
    expect(all).toHaveLength(KEEP);
    // 29 of the burst, then the line for the 21 it cut and the 23 the server left out.
    expect(keys(all).at(-1)).toBe("more 44");
    expect(shown(rows, "opened").map((r) => r.ev?.id)).toStrictEqual([openEvent(1).id]);
    expect(shown(rows, "closed")).toHaveLength(1);
    expect(shown(rows, "fee").every((r) => r.ev?.event === "fee")).toBe(true);
    // Another burst: the fee changes kept never pass 30, the opens and closes stay.
    rows = place(
      rows,
      Array.from({ length: 20 }, (_, i) => feeEvent(100 + i)),
      0,
      2,
    );
    expect(rows.filter((r) => r.ev?.event === "fee")).toHaveLength(KEEP);
    expect(shown(rows, "opened")).toHaveLength(1);
  });

  it("keeps a batch's opens and closes when a burst of newer fee changes fills it", () => {
    const burst = Array.from({ length: 40 }, (_, i) => feeEvent(100 + i));
    // An open is dated by its block, an hour or more before it arrives: older than the burst.
    const rows = place([], [...burst, openEvent(-60), closeEvent(-61, "force")], 0, 1);
    expect(shown(rows, "opened")).toHaveLength(1);
    expect(shown(rows, "closed")).toHaveLength(1);
    const all = shown(rows, "all");
    expect(keys(all).slice(0, 2)).toStrictEqual([openEvent(-60).id, closeEvent(-61, "force").id]);
    expect(keys(all).at(-1)).toBe("more 13");
  });

  it("keeps a row that is already there the same object, so its element stays", () => {
    const rows = place([], [openEvent(1)], 0, 0);
    const next = place(rows, [openEvent(2)], 0, 1);
    expect(next[1]).toBe(rows[0]);
  });
});

describe("closes by day", () => {
  it("draws from the first recorded day when the record is shorter, a week at least", () => {
    const days = closes().days;
    const at = (i: number) => (days[i]?.time ?? 0) + 3600;
    expect(drawnDays(days, null)).toHaveLength(30);
    expect(drawnDays(days, (days[0]?.time ?? 0) - 86_400)).toHaveLength(30);
    expect(drawnDays(days, at(10))).toHaveLength(20);
    expect(drawnDays(days, at(10))[0]).toBe(days[10]);
    expect(drawnDays(days, at(25))).toHaveLength(MIN_DAYS);
    expect(drawnDays(days, at(29))).toHaveLength(MIN_DAYS);
  });
});

describe("movers", () => {
  it("switches between the lists, and the largest either way are sorted by size", () => {
    const m = movers();
    expect(moversFor(m, "capacity", "gained")).toBe(m.capacity_up);
    expect(moversFor(m, "channels", "lost")).toBe(m.channels_down);
    expect(moversFor(m, "capacity", "either").map((r) => r.alias)).toStrictEqual([
      "Binance",
      "ACINQ",
      "bfx-lnd0",
    ]);
    expect(
      moversFor(movers({ capacity_up: [], capacity_down: [] }), "capacity", "either"),
    ).toStrictEqual([]);
  });
});
