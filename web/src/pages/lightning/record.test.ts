// A node's close record (lightning.ts): the shape check, how shares are written, the weeks, the
// kinds shown, fees per close and the peers in one sentence.
import { describe, expect, it } from "vitest";
import {
  CLOSE_WORDS,
  isNodeCloses,
  kindsIn,
  peersInWords,
  perClose,
  RECORD_WORDS,
  shareText,
  weekRows,
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

  it("says who its force closes were with, and never who closed", () => {
    const words = (force: number, penalty: number, peers: ReturnType<typeof recordPeer>[]) =>
      peersInWords(closeRecord(tally({ cooperative: 5, force, penalty, other: 0 }), peers));
    expect(words(0, 0, [])).toBe("None of its channels ended in a force close or a penalty.");
    expect(words(1, 0, [recordPeer(1)])).toBe(
      "The 1 force close was on a channel with the peer below.",
    );
    // A close whose two ends are the node lists no peer: nothing is said of one.
    expect(words(1, 0, [])).toBe("The record holds 1 force close.");
    expect(words(0, 1, [recordPeer(1, { force: 0, penalty: 1 })])).toBe(
      "The 1 penalty was on a channel with the peer below.",
    );
    // Ten with one flaky peer reads apart from one each with ten.
    expect(words(10, 0, [recordPeer(1, { force: 10, closed: 10 })])).toBe(
      "The 10 force closes were all on channels with one peer.",
    );
    const ten = Array.from({ length: 10 }, (_, i) => recordPeer(i));
    expect(words(10, 0, ten)).toBe(
      "The 10 force closes were on channels with 10 different peers, at most 1 with any one.",
    );
    expect(
      words(3, 2, [
        recordPeer(1, { force: 3, penalty: 1 }),
        recordPeer(2, { penalty: 1, force: 0 }),
      ]),
    ).toBe(
      "The 3 force closes and 2 penalties were on channels with 2 different peers, at most 4 with any one.",
    );
    for (const w of [
      ...Object.values(RECORD_WORDS),
      ...Object.values(CLOSE_WORDS).map((c) => c.why),
    ]) {
      expect(w).not.toMatch(/\b(it|this node) (forced|closed|cheated|initiated)/i);
      // Neither which end acted nor that a force close was the latest state, which no kind establishes.
      expect(w).not.toMatch(/cheated end|latest state|its commitment/i);
    }
  });
});
