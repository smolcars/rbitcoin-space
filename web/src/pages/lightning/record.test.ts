// A node's close record (lightning.ts): the shape check, how shares are written, the weeks, the
// kinds shown, fees per close and the peers in one sentence.
import { describe, expect, it } from "vitest";
import {
  CLOSE_WORDS,
  type RecordPeer,
  isNodeCloses,
  kindsIn,
  peersInWords,
  peersShown,
  perClose,
  recordInWords,
  RECORD_WORDS,
  shareText,
  weekRows,
  weeksInWords,
} from "./lightning";
import { closeRecord, recordPeer, tally, WEEK1 } from "./testdata";

const WEEK = 7 * 86_400;

describe("a node's close record", () => {
  it("reads the server's answer, and refuses one that is not that shape", () => {
    expect(
      isNodeCloses(closeRecord(tally({ cooperative: 1, force: 0, penalty: 0, other: 0 }))),
    ).toBe(true);
    // Before the overview's first computation the network is null; before any history, `from`.
    expect(
      isNodeCloses({
        ...closeRecord(tally({ cooperative: 0, force: 0, penalty: 0, other: 0 }), [], null),
        from: null,
      }),
    ).toBe(true);
    const good = closeRecord(tally({ cooperative: 3, force: 1, penalty: 0, other: 0 }), [
      recordPeer(1),
    ]);
    for (const bad of [
      { ...good, node: { ...good.node, force: "1" } },
      { ...good, node: { ...good.node, cooperative: -1 } },
      { ...good, node: { ...good.node, fees: { ...good.node.fees, force: { sum: 1 } } } },
      { ...good, node: { ...good.node, weeks: [{ time: WEEK1 }] } },
      { ...good, peers: { ...good.peers, list: [{ ...recordPeer(1), alias: 7 }] } },
      { ...good, peers: { ...good.peers, list: [{ ...recordPeer(1), open: null }] } },
      { ...good, network: { ...good.network, time: undefined } },
      { ...good, minimum: "20" },
      { ...good, capped: "no" },
      { ...good, cap: undefined },
      { ...good, peers: { ...good.peers, list: [{ ...recordPeer(1), held: 1 }] } },
      null,
      [],
    ]) {
      expect(isNodeCloses(bad)).toBe(false);
    }
  });

  it("writes a share in whole percent, a small one to a decimal, and none as 0%", () => {
    expect(shareText(68.4, 54)).toBe("68%");
    expect(shareText(8.8, 158)).toBe("8.8%");
    expect(shareText(0.3, 6)).toBe("0.3%");
    // A close is never rounded away: one of 2 000 is not none, and 402 of 403 is not all.
    expect(shareText(0, 1)).toBe("under 0.1%");
    expect(shareText(0.05, 1)).toBe("under 0.1%");
    expect(shareText(99.8, 402)).toBe("99.8%");
    expect(shareText(0, 0)).toBe("0%");
    expect(shareText(100, 30)).toBe("100%");
  });

  it("shows cooperative and force always, and penalty and other only where either record has one", () => {
    const node = tally({ cooperative: 2, force: 0, penalty: 0, other: 0 });
    expect(kindsIn(node)).toStrictEqual(["cooperative", "force"]);
    const net = tally({ cooperative: 9, force: 1, penalty: 0, other: 1 });
    expect(kindsIn(node, net)).toStrictEqual(["cooperative", "force", "other"]);
    expect(kindsIn(node, null)).toStrictEqual(["cooperative", "force"]);
    expect(kindsIn(tally({ cooperative: 0, force: 0, penalty: 1, other: 0 }))).toStrictEqual([
      "cooperative",
      "force",
      "penalty",
    ]);
  });

  it("gives a fee per close over the closes whose fee is known, and none when none is", () => {
    expect(perClose({ sum: 16_886, known: 54 })).toBe(313);
    expect(perClose({ sum: 0, known: 0 })).toBeNull();
    expect(perClose({ sum: 0, known: 3 })).toBe(0);
  });

  it("lists weeks newest first, the network's beside each, and sums those past eight", () => {
    const k = (cooperative: number, force: number) => ({
      cooperative,
      force,
      penalty: 0,
      other: 0,
    });
    const weeks = Array.from({ length: 10 }, (_, i) => ({ ...k(i, 1), time: WEEK1 + i * WEEK }));
    const network = weeks.map((w) => ({ ...k(100, 10), penalty: 2, time: w.time }));
    const rows = weekRows(weeks, network);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({ time: WEEK1 + 9 * WEEK, cooperative: 9, force: 1, closed: 10 });
    expect(rows[0]?.network).toStrictEqual({ closed: 112, forced: 12 });
    expect(rows[7]?.time).toBe(WEEK1 + 2 * WEEK);
    // The first two weeks, summed: 0 + 1 cooperative, 2 force; and the network's two.
    expect(rows[8]).toMatchObject({ time: null, cooperative: 1, force: 2, closed: 3 });
    expect(rows[8]?.network).toStrictEqual({ closed: 224, forced: 24 });
    // Every channel's figures lack one of the earlier weeks (worked out before it began, or from a
    // later start): no figure for them, rather than a part of one read as the whole.
    const partial = weekRows(weeks, network.slice(1));
    expect(partial[8]?.network).toBeNull();
    expect(partial[0]?.network).toStrictEqual({ closed: 112, forced: 12 });
    // A week of the node's that every channel's figures do not reach: none, not zero.
    expect(weekRows(weeks, network.slice(0, 9))[0]?.network).toBeNull();
    // No network yet: no figure beside each week. Eight weeks or fewer: no "Earlier" row.
    const two = weekRows(weeks.slice(0, 2), null);
    expect(two.map((w) => [w.time, w.network])).toStrictEqual([
      [WEEK1 + WEEK, null],
      [WEEK1, null],
    ]);
  });

  it("says who its force closes were with, true of its record in every case, and never who closed", () => {
    const peer = (n: number, force: number, penalty: number) =>
      recordPeer(n, { force, penalty, closed: force + penalty });
    const many = (n: number, force: number, penalty: number) =>
      Array.from({ length: n }, (_, i) => peer(i + 1, force, penalty));
    // The node's force closes and penalties, its listed peers, and how many peers were left out.
    const words = (force: number, penalty: number, peers: RecordPeer[], more = 0) => {
      const r = closeRecord(tally({ cooperative: 5, force, penalty, other: 0 }), peers);
      return peersInWords({ ...r, peers: { ...r.peers, forced: peers.length + more, more } });
    };
    const cases: [string, string, string][] = [
      [
        "no force close or penalty",
        words(0, 0, []),
        "None of its channels ended in a force close or a penalty.",
      ],
      // Every peer listed, no close on a channel whose two ends are the node.
      [
        "one force close, one peer",
        words(1, 0, [peer(1, 1, 0)]),
        "The 1 force close was on a channel with one peer.",
      ],
      [
        "one penalty, one peer",
        words(0, 1, [peer(1, 0, 1)]),
        "The 1 penalty was on a channel with one peer.",
      ],
      [
        "ten with one peer",
        words(10, 0, [peer(1, 10, 0)]),
        "The 10 force closes were all on channels with one peer.",
      ],
      [
        "one each with ten",
        words(10, 0, many(10, 1, 0)),
        "The 10 force closes were on channels with 10 different peers, at most 1 with any one.",
      ],
      [
        "both, two peers",
        words(3, 2, [peer(1, 3, 1), peer(2, 0, 1)]),
        "The 3 force closes and 2 penalties were on channels with 2 different peers, at most 4 with any one.",
      ],
      // Every peer listed, and closes on a channel whose two ends are the node, named by kind.
      [
        "one of its own",
        words(2, 0, [peer(1, 1, 0)]),
        "The 1 force close was on a channel with one peer. 1 force close was on a channel whose two ends are this node.",
      ],
      [
        "two of its own",
        words(3, 0, [peer(1, 1, 0)]),
        "The 1 force close was on a channel with one peer. 2 force closes were on channels whose two ends are this node.",
      ],
      [
        "a peer's penalty, its own force close",
        words(1, 1, [peer(1, 0, 1)]),
        "The 1 penalty was on a channel with one peer. 1 force close was on a channel whose two ends are this node.",
      ],
      [
        "both, and both of its own",
        words(4, 2, [peer(1, 2, 1), peer(2, 1, 0)]),
        "The 3 force closes and 1 penalty were on channels with 2 different peers, at most 3 with any one. 1 force close and 1 penalty were on channels whose two ends are this node.",
      ],
      [
        "its own penalties only",
        words(1, 2, [peer(1, 1, 0)]),
        "The 1 force close was on a channel with one peer. 2 penalties were on channels whose two ends are this node.",
      ],
      // No peer: every one on a channel whose two ends are the node.
      [
        "one, all its own",
        words(1, 0, []),
        "The 1 force close was on a channel whose two ends are this node.",
      ],
      [
        "both, all its own",
        words(2, 1, []),
        "The 2 force closes and 1 penalty were on channels whose two ends are this node.",
      ],
      // Peers left out: the record's totals and the listed peers' apart, nothing attributed.
      [
        "51 with 51 peers and one of its own, 50 listed",
        words(51, 1, many(50, 1, 0), 1),
        "The record holds 51 force closes and 1 penalty. The 50 peers with the most had 50 force closes, at most 1 with any one.",
      ],
      [
        "penalties only, cut off",
        words(0, 52, many(50, 0, 1), 2),
        "The record holds 52 penalties. The 50 peers with the most had 50 penalties, at most 1 with any one.",
      ],
      [
        "both, cut off",
        words(60, 12, [peer(1, 5, 2), ...many(49, 1, 0)], 3),
        "The record holds 60 force closes and 12 penalties. The 50 peers with the most had 54 force closes and 2 penalties, at most 7 with any one.",
      ],
    ];
    for (const [name, got, want] of cases) expect({ name, got }).toStrictEqual({ name, got: want });
    for (const w of [
      ...Object.values(RECORD_WORDS),
      ...Object.values(CLOSE_WORDS).map((c) => c.why),
    ]) {
      expect(w).not.toMatch(/\b(it|this node) (forced|closed|cheated|initiated)/i);
      // Neither which end acted nor that a force close was the latest state, which no kind establishes.
      expect(w).not.toMatch(/cheated end|latest state|its commitment/i);
    }
  });

  it("folds the weeks to one sentence: how many, from when, and the most in one", () => {
    const w = (time: number, cooperative: number, force: number) => ({
      time,
      cooperative,
      force,
      penalty: 0,
      other: 0,
    });
    expect(weeksInWords([])).toBe("No week in the record yet.");
    expect(weeksInWords([w(WEEK1, 1, 0)])).toBe("One week, from 9 Nov 2026: 1 close.");
    expect(weeksInWords([w(WEEK1, 20, 20), w(WEEK1 + WEEK, 36, 5)])).toBe(
      "2 weeks from 9 Nov 2026, at most 41 closes in one.",
    );
  });

  it("says a list folded to none hides them all, and one folded to some shows fewer", () => {
    const ones = [recordPeer(1), recordPeer(2), recordPeer(3)];
    expect(peersShown(ones, false)).toStrictEqual({ rows: [], button: "Show the 3 peers" });
    expect(peersShown(ones, true).button).toBe("Hide the 3 peers");
    const some = [recordPeer(1, { force: 2 }), recordPeer(2), recordPeer(3)];
    expect(peersShown(some, false).button).toBe("Show the 2 peers with one each");
    expect(peersShown(some, true).button).toBe("Show fewer peers");
  });

  it("writes a small record in a line: fees not known said so, and no network figure said so", () => {
    const r = closeRecord(tally({ cooperative: 2, force: 1, penalty: 0, other: 0 }), [], null);
    const fees = {
      ...r.node.fees,
      cooperative: { sum: 300, known: 1 },
      force: { sum: 0, known: 0 },
    };
    const w = recordInWords({ ...r, node: { ...r.node, fees } });
    expect(w.node).toStrictEqual([
      { kind: "cooperative", count: 2, fees: "300 sats in fees, 1 not known" },
      { kind: "force", count: 1, fees: "fee not known" },
    ]);
    expect(w.network).toBe("No figure for all channels yet.");
  });
});
