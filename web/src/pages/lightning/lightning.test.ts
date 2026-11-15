import { describe, expect, it } from "vitest";
import {
  btcAxis,
  cleanAlias,
  msat,
  plainMsat,
  coverageSentence,
  cut,
  feeRows,
  feeSentence,
  dataFrom,
  isChannelDetail,
  isChannelId,
  isNodeDetail,
  isOverview,
  isSeries,
  parseInterval,
  parseRanking,
  searchProblem,
  channelTag,
  msatAsBtc,
  hopFee,
  htlcLimit,
  lifeSteps,
  msatAsSats,
  parseSats,
  type Policy,
  TERMS,
} from "./lightning";
import {
  acinq,
  channel,
  closedChannel,
  closedOf,
  EARLIER,
  NEXT,
  overview,
  series,
  T0,
} from "./testdata";

describe("cleanAlias", () => {
  it("keeps an ordinary name as it is", () => {
    expect(cleanAlias("ACINQ")).toBe("ACINQ");
    expect(cleanAlias("Kraken 🐙⚡")).toBe("Kraken 🐙⚡");
    // The joiner emoji are built with stays.
    expect(cleanAlias("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  it("shows bidi overrides, isolates and invisible characters as a replacement mark", () => {
    expect(cleanAlias("‮QNICA")).toBe("�QNICA");
    expect(cleanAlias("AC​INQ")).toBe("AC�INQ");
    expect(cleanAlias("a⁦b⁩")).toBe("a�b�");
  });

  it("shows control characters as a replacement mark", () => {
    expect(cleanAlias("a\u0000b\u001B[31mc\u0085")).toBe("a�b�[31mc�");
  });

  it("thins stacked combining marks to two", () => {
    expect(cleanAlias(`Z${"́".repeat(40)}`)).toBe("Ź́");
  });

  it("gives null for no name, a non-string, or nothing visible", () => {
    expect(cleanAlias(null)).toBeNull();
    expect(cleanAlias(42)).toBeNull();
    expect(cleanAlias("   ")).toBeNull();
  });
});

describe("cut", () => {
  it("cuts by characters as read, never halving an emoji", () => {
    expect(cut("abc", 3)).toStrictEqual({ text: "abc", more: false });
    expect(cut("abcd", 3)).toStrictEqual({ text: "abc…", more: true });
    expect(cut("👨‍👩‍👧👨‍👩‍👧", 1)).toStrictEqual({ text: "👨‍👩‍👧…", more: true });
  });
});

describe("shape checks", () => {
  it("accept the server's answers", () => {
    expect(isOverview(overview())).toBe(true);
    expect(isOverview(overview({ statistics: null, closed: [] }))).toBe(true);
    expect(isNodeDetail(acinq())).toBe(true);
    expect(isChannelDetail(channel())).toBe(true);
    expect(isChannelDetail(channel({ closed: closedOf("penalty").closed }))).toBe(true);
    expect(isChannelDetail(channel({ continued_as: NEXT, continued_from: EARLIER }))).toBe(true);
    expect(isChannelDetail(channel({ continued_as: null, continued_from: null }))).toBe(true);
    expect(isSeries(series())).toBe(true);
  });

  it("refuse what a page could not draw", () => {
    expect(isOverview({ ...overview(), opened: "x" })).toBe(false);
    expect(isOverview({ ...overview(), closed: [{ ...closedOf("force"), capacity: "1" }] })).toBe(
      false,
    );
    const odd = { block: { height: 1, hash: "h", time: 1 }, txid: "t", kind: "x", fee: null };
    expect(isOverview({ ...overview(), closed: [{ ...closedOf("force"), closed: odd }] })).toBe(
      false,
    );
    expect(isNodeDetail({ ...acinq(), features: [{ bit: "0" }] })).toBe(false);
    expect(isChannelDetail({ ...channel(), funding: null })).toBe(false);
    expect(isChannelDetail({ ...channel(), continued_as: { id: "1x1x1" } })).toBe(false);
    expect(isSeries({ ...series(), step: 0 })).toBe(false);
  });
});

describe("ids and searches", () => {
  it("knows a channel id in either form", () => {
    expect(isChannelId("811984x2037x0")).toBe(true);
    expect(isChannelId("892785849701564416")).toBe(true);
    expect(isChannelId("0811984x2037x0")).toBe(false);
    expect(isChannelId("<script>")).toBe(false);
  });

  it("says why a search cannot be asked", () => {
    expect(searchProblem("ac")).toMatch(/at least 3/);
    expect(searchProblem("a".repeat(67))).toMatch(/at most 66/);
    expect(searchProblem("ab\u0007c")).toMatch(/control/);
    expect(searchProblem("  acinq  ")).toBeUndefined();
    // A surrogate pair is one character, as the server counts.
    expect(searchProblem("🐙🐙🐙")).toBeUndefined();
  });

  it("reads the interval and the ranking from the address, with defaults", () => {
    expect(parseInterval("1m").id).toBe("1m");
    expect(parseInterval("nonsense").id).toBe("1w");
    expect(parseRanking("age").id).toBe("age");
    expect(parseRanking(undefined).id).toBe("capacity");
  });
});

describe("coverage", () => {
  it("says since when for a history ten minutes old, in one short line, and hatches before it", () => {
    const s = series();
    expect(coverageSentence(s, T0)).toBe("Recorded from 12 Nov, 18:30 UTC.");
    expect(coverageSentence({ ...s, interval: "all" }, T0)).toBe(
      "Recorded since 12 Nov, 18:30 UTC.",
    );
    // The year only when it is not this one.
    expect(coverageSentence(s, T0 + 60 * 86_400)).toBe("Recorded from 12 Nov 2026, 18:30 UTC.");
    expect(dataFrom(s)).toBe(T0);
  });

  it("names gaps inside a period it fully spans as a share", () => {
    const s = series({ first: T0 - 30 * 86_400, sampled: 900, complete: false });
    expect(coverageSentence(s, T0)).toBe("89% recorded, with gaps while this server was off.");
    expect(dataFrom(s)).toBeUndefined();
    expect(coverageSentence({ ...s, complete: true }, T0)).toBeUndefined();
  });
});

describe("plainMsat", () => {
  // What the copy button copies: the digits shown, ungrouped, past 2^53 too.
  it("copies exactly the digits msat shows", () => {
    for (const n of [
      0,
      1,
      1_234_567_890,
      Number("1234567890123456789"),
      2_100_000_000_000_000_000,
    ]) {
      expect(plainMsat(n)).toMatch(/^\d+$/);
      expect(plainMsat(n)).toBe(msat(n).replace(" msat", "").replaceAll("\u202F", ""));
    }
  });
});

describe("a node's fee rates", () => {
  const fees = acinq().fees;

  it("gathers the server's buckets into rows, cheapest first, no policy last", () => {
    const rows = feeRows(fees);
    expect(rows.map((r) => r.label.replaceAll("\u202F", " "))).toStrictEqual([
      "0",
      "1–9",
      "10–49",
      "50–99",
      "100–199",
      "200–499",
      "500–999",
      "1 000–1 999",
      "2 000–4 999",
      "No policy",
    ]);
    const at = (label: string) => rows.find((r) => r.label.replaceAll("\u202F", " ") === label);
    expect(at("200–499")?.outgoing).toStrictEqual({ count: 266, capacity: 6_377_292_455 });
    expect(at("No policy")?.incoming.count).toBe(78);
    // Empty rows between held ones stay, so the scale is even; none past the dearest.
    expect(at("10–49")?.outgoing.count).toBe(0);
    // Every channel is in one row each way.
    const sum = (way: "outgoing" | "incoming") => rows.reduce((n, r) => n + r[way].count, 0);
    expect(sum("outgoing")).toBe(fees.outgoing.reduce((n, b) => n + b.count, 0));
    expect(sum("incoming")).toBe(fees.incoming.reduce((n, b) => n + b.count, 0));
  });

  it("puts the dearest rates in one open row", () => {
    const rows = feeRows({
      outgoing: [{ bucket: 4_294_967_000, count: 1, capacity: 10 }],
      incoming: [{ bucket: 10_000, count: 2, capacity: 20 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label.replaceAll("\u202F", " ")).toBe("10 000+");
    expect(rows[0]?.outgoing.count).toBe(1);
  });

  it("says what the node charges and is charged, by the median channel", () => {
    expect(feeSentence(feeRows(fees)).replaceAll("\u202F", " ")).toBe(
      "It charges a median of 2 000–4 999 ppm to forward; its peers charge a median of 2 000–4 999 ppm towards it.",
    );
  });

  it("drops the median for one channel, and says when a way has no fee set", () => {
    const one = feeRows({
      outgoing: [{ bucket: 100, count: 1, capacity: 10 }],
      incoming: [{ bucket: null, count: 1, capacity: 10 }],
    });
    expect(one.map((r) => r.label)).toStrictEqual(["100–199", "No policy"]);
    expect(feeSentence(one)).toBe(
      "It charges 100–199 ppm to forward; its peer has set none towards it.",
    );
  });
});

describe("btcAxis", () => {
  it("writes ticks as decimals at every size, never as a power of ten", () => {
    expect(btcAxis(0)).toBe("0");
    expect(btcAxis(0.5)).not.toMatch(/e/);
    expect(btcAxis(1)).toBe("0.00000001");
    expect(btcAxis(37_200)).toBe("0.000372");
    expect(btcAxis(5_500_000)).toBe("0.055");
    expect(btcAxis(28_500_000_000).replaceAll("\u202F", " ")).toBe("285");
  });
});

// The tests write grouped figures with a plain space; the page groups with a narrow no-break one.
const plain = (s: string) => s.replaceAll(" ", " ");

describe("msatAsSats", () => {
  it("writes msat as sats, exact to the msat, under a sat in msat", () => {
    expect(msatAsSats(0)).toBe("0 sats");
    expect(msatAsSats(1)).toBe("1 msat");
    expect(msatAsSats(999)).toBe("999 msat");
    expect(msatAsSats(1000)).toBe("1 sat");
    expect(msatAsSats(1100)).toBe("1.1 sats");
    expect(msatAsSats(1001)).toBe("1.001 sats");
    expect(plain(msatAsSats(20_000_000_000))).toBe("20 000 000 sats");
    expect(msatAsSats(-1000)).toBe("−1 sat");
    expect(plain(msatAsSats(99_999_999_999))).toBe("99 999 999.999 sats");
    expect(msatAsSats(Number.NaN)).toBe("–");
  });

  it("reads a bitcoin and more in magnitude, so the longest still fits a phone", () => {
    expect(msatAsSats(100_000_000_000)).toBe("1.00 BTC");
    expect(msatAsSats(523_456_789_000)).toBe("5.23 BTC");
    expect(plain(msatAsSats(2_100_000_000_000_000_000))).toBe("21 000 000 BTC");
    expect(plain(msatAsSats(-150_000_000_000_000))).toBe("−1 500 BTC");
    // The magnitude a long figure carries for the narrowest room.
    expect(msatAsBtc(99_999_999_999)).toBe("1.00 BTC");
    expect(msatAsBtc(999_999_999)).toBe("0.01000 BTC");
    expect(msatAsBtc(4_294_967_295)).toBe("0.0429 BTC");
    expect(msatAsBtc(999)).toBe("999 msat");
    // A fee past 2⁵³, as a bigint.
    expect(plain(msatAsSats(8_400_000_000_000_000_000_123n))).toBe("84 000 000 000 BTC");
  });

  it("never lets a figure break inside its digits", () => {
    // Groups are joined by a narrow no-break space; the only breakable space is before the unit.
    expect(msatAsSats(2_000_000_000).split(" ")).toStrictEqual(["2 000 000", "sats"]);
  });
});

describe("parseSats", () => {
  it("reads whole sats, grouped or not", () => {
    expect(parseSats("100000")).toStrictEqual({ sats: 100_000 });
    expect(parseSats(" 100 000 ")).toStrictEqual({ sats: 100_000 });
    expect(parseSats("100 000")).toStrictEqual({ sats: 100_000 });
    expect(parseSats("1,000,000")).toStrictEqual({ sats: 1_000_000 });
    expect(parseSats("2100000000000000")).toStrictEqual({ sats: 2_100_000_000_000_000 });
  });

  it("says why anything else is not an amount", () => {
    expect(parseSats("")).toStrictEqual({ error: "Type an amount in sats." });
    expect(parseSats("-5")).toStrictEqual({ error: "Not negative: whole sats only." });
    expect(parseSats("1.5")).toStrictEqual({ error: "Whole sats only." });
    expect(parseSats("abc")).toStrictEqual({ error: "Not an amount: whole sats only." });
    expect(parseSats("1e6")).toStrictEqual({ error: "Not an amount: whole sats only." });
    expect(parseSats("0")).toStrictEqual({ error: "Above zero." });
    expect(parseSats("2100000000000001")).toStrictEqual({ error: "More than all bitcoin." });
  });
});

const policy = (p: Partial<Policy> = {}): Policy => ({
  fee_rate: 2499,
  base_fee_msat: 1000,
  cltv_delta: 144,
  min_htlc_msat: 1,
  max_htlc_msat: 20_000_000_000,
  enabled: true,
  last_update: T0,
  ...p,
});

describe("hopFee", () => {
  it("adds the base fee to the proportional part, rounded down to the msat", () => {
    // 100 000 sats at 2 499 ppm: 249 900 msat, exactly.
    expect(hopFee(policy(), 100_000)).toStrictEqual({ msat: 250_900n, exact: true });
    // 1 sat at 2 499 ppm: 2.499 msat, rounded down to 2.
    expect(hopFee(policy(), 1)).toStrictEqual({ msat: 1002n, exact: false });
    expect(hopFee(policy({ fee_rate: 0, base_fee_msat: 0 }), 5)).toStrictEqual({
      msat: 0n,
      exact: true,
    });
  });

  it("stays exact past 2⁵³", () => {
    const all = 2_100_000_000_000_000;
    expect(hopFee(policy({ fee_rate: 4_000_000_000, base_fee_msat: 0 }), all).msat).toBe(
      8_400_000_000_000_000_000_000n,
    );
  });

  it("knows an amount past what the policy forwards", () => {
    expect(htlcLimit(policy(), 100_000)).toBeNull();
    expect(htlcLimit(policy(), 20_000_001)).toBe("over");
    expect(htlcLimit(policy({ min_htlc_msat: 1_000_000 }), 999)).toBe("under");
    expect(htlcLimit(policy({ min_htlc_msat: 1_000_000 }), 1000)).toBeNull();
  });
});

describe("the policies' differences", () => {
  const diff = (key: string, a: Policy, b: Policy) => TERMS.find((t) => t.key === key)?.diff(a, b);
  it("names the higher end and by how much, or says they are the same", () => {
    const one = policy({ fee_rate: 1, min_htlc_msat: 1000, last_update: T0 - 60 });
    const two = policy();
    expect(diff("fee_rate", one, two)).toStrictEqual({ side: "two", text: "+2 498 ppm" });
    expect(diff("base_fee_msat", one, two)).toStrictEqual({ side: null, text: "Same" });
    expect(diff("min_htlc_msat", one, two)).toStrictEqual({
      side: "one",
      text: "+999 msat",
      msat: 999,
    });
    expect(diff("cltv_delta", policy({ cltv_delta: 80 }), two)).toStrictEqual({
      side: "two",
      text: "+64 blocks",
    });
    expect(diff("last_update", one, two)).toStrictEqual({ side: "two", text: "newer" });
  });

  it("says which ways forward", () => {
    const off = policy({ enabled: false });
    expect(diff("enabled", policy(), policy())?.text).toBe("Both");
    expect(diff("enabled", off, off)?.text).toBe("Neither");
    expect(diff("enabled", policy(), off)?.text).toBe("One way only");
  });
});

describe("channelTag", () => {
  const ends = (one: Policy | null, two: Policy | null) =>
    channel({
      node_one: { ...channel().node_one, policy: one },
      node_two: { ...channel().node_two, policy: two },
    });
  it("says what the ends of an open channel advertise, missing apart from disabled", () => {
    expect(channelTag(channel()).word).toBe("Enabled");
    expect(channelTag(channel()).tone).toBe("positive");
    expect(channelTag(ends(policy(), policy({ enabled: false }))).word).toBe("Enabled one way");
    expect(channelTag(ends(policy(), null)).word).toBe("Enabled one way");
    expect(channelTag(ends(policy({ enabled: false }), null)).word).toBe("Disabled");
    expect(channelTag(ends(null, null)).word).toBe("No policy");
  });

  it("says what was seen of a closed channel", () => {
    expect(channelTag(closedChannel("cooperative")).word).toBe("Closed: cooperative close");
    expect(channelTag(closedChannel("force")).word).toBe("Closed: force close");
    expect(channelTag(closedChannel("other")).word).toBe("Closed: other close");
    expect(channelTag(closedChannel("penalty")).word).toBe("Closed: revoked state swept");
    expect(channelTag(closedChannel("other", { continued_as: NEXT })).word).toBe(
      "Closed: continued as a new channel",
    );
  });
});

describe("lifeSteps", () => {
  const keys = (c: Parameters<typeof lifeSteps>[0]) => lifeSteps(c).map((s) => s.key);
  it("runs from funding to open now, or to the close and what followed", () => {
    expect(keys(channel())).toStrictEqual(["funded", "open"]);
    expect(keys(closedChannel("force"))).toStrictEqual(["funded", "closed"]);
    expect(keys(closedChannel("penalty"))).toStrictEqual(["funded", "closed", "swept"]);
    expect(keys(closedChannel("cooperative", { continued_as: NEXT }))).toStrictEqual([
      "funded",
      "closed",
      "continued",
    ]);
    expect(keys(channel({ continued_from: EARLIER }))).toStrictEqual(["from", "funded", "open"]);
  });

  it("shows a penalty's close as the force close it was, and times each step from its block", () => {
    const steps = lifeSteps(closedChannel("penalty"));
    expect(steps[1]).toMatchObject({ key: "closed", kind: "force", time: T0 + 600 });
    expect(steps[2]).toMatchObject({ key: "swept", time: T0 + 1800 });
    expect(lifeSteps(channel({ funding: { txid: null, vout: 0, block: null } }))[0]).toStrictEqual({
      key: "funded",
      time: null,
    });
  });
});
