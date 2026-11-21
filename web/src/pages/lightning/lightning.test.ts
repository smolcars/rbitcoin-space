import { describe, expect, it } from "vitest";
import {
  changeShown,
  changesIn,
  feeSteps,
  feesMoved,
  type Fees,
  inboundOf,
  inboundWord,
  isFeeChanges,
  isFeeHistory,
  movedText,
  btcAxis,
  cleanAlias,
  coverageSentence,
  cut,
  feeRows,
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
  ageShort,
  changeWords,
  cleanFilter,
  isOpenPage,
  listRequest,
  ordinal,
  readList,
  readView,
  rowBuckets,
  rowState,
  shownDir,
  sortName,
  viewHref,
  weekAgo,
} from "./lightning";
import {
  acinq,
  channel,
  closedChannel,
  closedOf,
  EARLIER,
  NEXT,
  openChannel,
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

  it("keeps a one-channel node's two rows, its policy and its peer's none", () => {
    const one = feeRows({
      outgoing: [{ bucket: 100, count: 1, capacity: 10 }],
      incoming: [{ bucket: null, count: 1, capacity: 10 }],
    });
    expect(one.map((r) => r.label)).toStrictEqual(["100–199", "No policy"]);
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

  it("stays exact in sats past a bitcoin, never rounded", () => {
    expect(plain(msatAsSats(100_000_000_000))).toBe("100 000 000 sats");
    expect(plain(msatAsSats(523_456_789_001))).toBe("523 456 789.001 sats");
    expect(plain(msatAsSats(2_100_000_000_000_000_000))).toBe("2 100 000 000 000 000 sats");
    expect(plain(msatAsSats(-150_000_000_000_000))).toBe("−150 000 000 000 sats");
    // A fee past 2⁵³, as a bigint, to the msat.
    expect(plain(msatAsSats(8_400_000_000_000_000_000_123n))).toBe(
      "8 400 000 000 000 000 000.123 sats",
    );
  });

  it("gives a list's narrowest room the magnitude from a sat", () => {
    expect(msatAsBtc(99_999_999_999)).toBe("1.00 BTC");
    expect(msatAsBtc(999_999_999)).toBe("0.01000 BTC");
    expect(msatAsBtc(4_294_967_295)).toBe("0.0429 BTC");
    expect(msatAsBtc(999)).toBe("999 msat");
    expect(plain(msatAsBtc(2_100_000_000_000_000_000))).toBe("21 000 000 BTC");
    expect(plain(msatAsBtc(-150_000_000_000_000))).toBe("−1 500 BTC");
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

// The node page for its operator.

const KEY = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";
const PEER = "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025";

describe("a node's list in the address and as a request", () => {
  const ask = (search: Record<string, string>, closed = false) =>
    listRequest(KEY, readList(search, closed), closed).replace(`/nodes/${KEY}/channels`, "");

  it("asks the server's defaults with nothing at all", () => {
    expect(ask({})).toBe("");
    expect(ask({}, true)).toBe("?status=closed");
    expect(readList({}, false)).toMatchObject({ sort: "capacity", dir: "desc", page: 0 });
    expect(readList({ sort: "out" }, false).dir).toBe("asc");
  });

  it("carries every parameter the server takes, the page from 1 in the address, 0 to the server", () => {
    expect(
      ask({
        sort: "cltv",
        dir: "desc",
        q: " bfx ",
        peer: PEER.toUpperCase(),
        state: "here",
        page: "3",
      }),
    ).toBe(`?sort=cltv&dir=desc&q=bfx&peer=${PEER}&state=here&page=2`);
    expect(ask({ sort: "lived", dir: "asc", kind: "penalty", page: "2" }, true)).toBe(
      "?status=closed&sort=lived&dir=asc&kind=penalty&page=1",
    );
  });

  it("asks for a fee row as its run of the server's buckets", () => {
    expect(ask({ fee: "out:10" })).toBe("?fee=out%3A10-40");
    expect(ask({ fee: "in:1" })).toBe("?fee=in%3A1-9");
    expect(ask({ fee: "out:0" })).toBe("?fee=out%3A0");
    expect(ask({ fee: "out:100" })).toBe("?fee=out%3A100");
    expect(ask({ fee: "out:200" })).toBe("?fee=out%3A200-400");
    expect(ask({ fee: "in:none" })).toBe("?fee=in%3Anone");
    expect(ask({ fee: "out:10000" })).toBe("?fee=out%3A10000-4294967000");
    expect(rowBuckets(5000)).toBe("5000-9000");
  });

  it("reads what the server would refuse as unset, so an edited link still shows a list", () => {
    const bad = [
      { sort: "fee" },
      { dir: "up" },
      { state: "Active" },
      { fee: "out:15" },
      { fee: "up:10" },
      { peer: "03" },
      { page: "0" },
      { page: "4002" },
      { page: "2.5" },
      { kind: "force" },
      { q: "x".repeat(67) },
      { q: "\u0007" },
    ];
    expect(bad.map((b) => ask(b))).toStrictEqual(bad.map(() => ""));
    // A closed list takes no state or fee, an open one no kind.
    expect(ask({ state: "here", fee: "out:0", sort: "out" }, true)).toBe("?status=closed");
  });

  it("strips control characters from the filter and counts code points as the server does", () => {
    expect(cleanFilter(" a\u0000b ")).toBe("ab");
    expect(cleanFilter("⚡".repeat(66))).toBe("⚡".repeat(66));
    expect(cleanFilter("⚡".repeat(67))).toBe("");
  });

  it("reads the view, Channels by default", () => {
    expect(readView({})).toBe("channels");
    expect(readView({ view: "fees" })).toBe("fees");
    expect(readView({ view: ["closed", "fees"] })).toBe("closed");
    expect(readView({ view: "map" })).toBe("channels");
  });

  it("writes a view's address with a change, leaving out what is unset", () => {
    expect(viewHref("/n", { sort: "out", page: "3" }, { peer: PEER, page: undefined })).toBe(
      `/n?sort=out&peer=${PEER}`,
    );
    expect(viewHref("/n", { state: "here" }, { state: undefined })).toBe("/n");
  });
});

describe("a node's week", () => {
  const now = 1_800_000_000;
  const h = (from: number | null, times: number[]) => ({
    from,
    points: times.map((t, i) => ({ time: t, channels: 10 + i, capacity: 1000 + i })),
  });

  it("takes the last point a week before now", () => {
    expect(
      weekAgo(h(now - 30 * 86_400, [now - 9 * 86_400, now - 7 * 86_400, now - 86_400]), now),
    ).toStrictEqual({
      time: now - 7 * 86_400,
      channels: 11,
      capacity: 1001,
    });
  });

  it("gives nothing where the record is younger than a week, rather than a wrong change", () => {
    expect(weekAgo(h(now - 6 * 86_400, [now - 5 * 86_400]), now)).toBeNull();
    expect(weekAgo(h(null, [now]), now)).toBeNull();
    // The record began in time, but its first point came after the week's start.
    expect(weekAgo(h(now - 7.5 * 86_400, [now - 6 * 86_400]), now)).toBeNull();
  });

  it("says a change in words and by how much, never by colour", () => {
    expect(changeWords(110, 100, String)).toBe("↑ Up 10 (10.0%)");
    expect(changeWords(99, 100, String)).toBe("↓ Down 1 (1.0%)");
    expect(changeWords(100, 100, String)).toBe("No change");
    expect(changeWords(10_001, 10_000, String)).toBe("↑ Up 1 (<0.1%)");
    expect(changeWords(5, 0, String)).toBe("↑ Up 5");
  });
});

describe("a node's words", () => {
  it("words each sort for what it sorts, and says how its column runs on screen", () => {
    expect(sortName("capacity", "desc")).toBe("Capacity, largest first");
    expect(sortName("age", "desc")).toBe("Age, oldest first");
    expect(sortName("age", "asc")).toBe("Age, youngest first");
    expect(sortName("cltv", "asc")).toBe("CLTV delta, this node, lowest first");
    expect(sortName("update", "desc")).toBe("Last policy update, newest first");
    expect(sortName("closed", "desc")).toBe("Closed, newest first");
    expect(sortName("fee", "asc")).toBe("Closing fee, lowest first");
    expect(sortName("lived", "desc")).toBe("Lived, longest first");
    // The update column shows how long ago: newest first is its smallest first.
    expect(shownDir("update", "desc")).toBe("asc");
    expect(shownDir("age", "desc")).toBe("desc");
  });

  it("writes ranks as ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 1234].map((n) => ordinal(n))).toStrictEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "101st",
      "111th",
      "1\u202F234th",
    ]);
  });

  it("writes an age in hours up to two days, then in days", () => {
    expect(ageShort(5 * 3600 + 59)).toBe("5 h");
    expect(ageShort(48 * 3600)).toBe("48 h");
    expect(ageShort(49 * 3600)).toBe("2 d");
    expect(ageShort(-10)).toBe("0 h");
  });

  it("names a row's state from its policies: a missing one says whose, never disabled", () => {
    const p = openChannel(0).own_policy as Policy;
    const off = { ...p, enabled: false };
    const word = (own: Policy | null, peer: Policy | null) =>
      rowState({ own_policy: own, peer_policy: peer }).word;
    expect(word(p, p)).toBe("Enabled");
    expect(word(off, p)).toBe("Disabled by this node");
    expect(word(p, off)).toBe("Disabled by the peer");
    expect(word(off, off)).toBe("Disabled both ways");
    expect(word(p, null)).toBe("Peer policy missing");
    expect(word(null, p)).toBe("Own policy missing");
    expect(word(off, null)).toBe("Peer policy missing");
    expect(word(null, null)).toBe("No policy");
    expect(rowState({ own_policy: p, peer_policy: null }).tone).toBe("muted");
    expect(rowState({ own_policy: off, peer_policy: p }).short).toBe("Off here");
  });

  it("reads a node with no policy one way, and one whose every rate refuses to route", () => {
    const none = { median: null, weighted: null, lowest: null, highest: null, policies: 0 };
    const node = acinq();
    const out = node.figures.fee_rates.outgoing;
    const figures = (outgoing: unknown, incoming: unknown) => ({
      ...node,
      figures: { ...node.figures, fee_rates: { outgoing, incoming } },
    });
    // The server's own answer for a way with no policy (crates/server lightning tests).
    expect(isNodeDetail(figures(none, none))).toBe(true);
    expect(isNodeDetail(figures({ ...out, weighted: null }, none))).toBe(true);
    expect(isNodeDetail(figures({ ...out, median: "1" }, none))).toBe(false);
    // When its policies last changed: a time, or none with no policy.
    const updated = (t: unknown) => ({
      ...node,
      figures: { ...node.figures, last_policy_update: t },
    });
    expect(isNodeDetail(updated(null))).toBe(true);
    expect(isNodeDetail(updated("1794715678"))).toBe(false);
  });

  it("reads a page of open channels, and refuses one whose rows are not its shape", () => {
    const page = acinq().open_channels;
    expect(isOpenPage(page)).toBe(true);
    expect(isOpenPage({ ...page, channels: [{ ...page.channels[0], op_state: "on" }] })).toBe(
      false,
    );
    expect(isOpenPage({ ...page, per_page: 0 })).toBe(false);
  });
});

describe("fee history", () => {
  const rec = (time: number, fee_rate: number, f: Partial<Fees> = {}) => ({
    time,
    fee_rate,
    base_fee_msat: 0,
    inbound_fee: null,
    ...f,
  });

  it("steps from each record, holding the rate set before a stretch began, on to now", () => {
    const records = [rec(100, 500), rec(1100, 400), rec(1500, 450)];
    expect(feeSteps(records, [{ from: 1000, to: 1800 }], 2000)).toStrictEqual({
      x: [1000, 1100, 1500, 2000],
      y: [500, 400, 450, 450],
    });
  });

  it("leaves a gap where the server was not recording, and picks up with the rate then", () => {
    // 3000 is the last change made while it was down, recorded at its own time.
    const records = [rec(1000, 500), rec(1200, 600), rec(3000, 700), rec(4500, 650)];
    const watched = [
      { from: 1000, to: 2000 },
      { from: 4000, to: 5000 },
    ];
    expect(feeSteps(records, watched, 5000)).toStrictEqual({
      x: [1000, 1200, 2000, 3000, 4000, 4500, 5000],
      y: [500, 600, 600, null, 700, 650, 650],
    });
  });

  it("draws nothing for an end with no record, and runs a lone record from where watching began", () => {
    expect(feeSteps([], [{ from: 1000, to: 2000 }], 2000)).toStrictEqual({ x: [], y: [] });
    expect(feeSteps([rec(10, 5)], [{ from: 1000, to: 2000 }], 2500)).toStrictEqual({
      x: [1000, 2500],
      y: [5, 5],
    });
    // A stretch before an end's first record draws nothing for it.
    expect(
      feeSteps(
        [rec(3000, 5)],
        [
          { from: 1000, to: 2000 },
          { from: 2500, to: 3500 },
        ],
        3500,
      ),
    ).toStrictEqual({ x: [3000, 3500], y: [5, 5] });
  });

  it("draws no line without a stretch the server was recording, and runs overlapping ones as one", () => {
    expect(feeSteps([rec(1000, 5), rec(1100, 6)], [], 500)).toStrictEqual({ x: [], y: [] });
    // A clock set back between two runs: time still runs forward, with no false gap.
    const steps = feeSteps(
      [rec(90, 1), rec(160, 2)],
      [
        { from: 100, to: 200 },
        { from: 150, to: 250 },
      ],
      260,
    );
    expect(steps).toStrictEqual({ x: [100, 160, 260], y: [1, 2, 2] });
  });

  it("counts changes, not the first record, which is where watching began", () => {
    expect(changesIn([])).toBe(0);
    expect(changesIn([rec(1, 1)])).toBe(0);
    expect(changesIn([rec(1, 1), rec(2, 2), rec(3, 3)])).toBe(2);
    // None to zero both ways charges the same: kept by the server, not a change here.
    expect(
      changesIn([rec(1, 1), rec(2, 1, { inbound_fee: { base_fee_msat: 0, fee_rate: 0 } })]),
    ).toBe(0);
  });

  it("shows the fee that moved, so a row never reads from 500 to 500", () => {
    const fees = (f: Partial<Fees> = {}): Fees => ({
      fee_rate: 500,
      base_fee_msat: 1000,
      inbound_fee: null,
      ...f,
    });
    const shown = (before: Partial<Fees>, after: Partial<Fees>) =>
      changeShown({ before: fees(before), after: fees(after) });
    expect(shown({}, { fee_rate: 400, base_fee_msat: 0 })).toBe("rate");
    expect(shown({}, { base_fee_msat: 0 })).toBe("base");
    expect(shown({}, { inbound_fee: { base_fee_msat: 0, fee_rate: -200 } })).toBe("inbound");
    expect(
      shown(
        { inbound_fee: { base_fee_msat: 0, fee_rate: -200 } },
        { inbound_fee: { base_fee_msat: -1000, fee_rate: -200 } },
      ),
    ).toBe("inbound");
    // None and zero both ways are the same fee: no move, so no row shows it.
    expect(feesMoved(fees(), fees({ inbound_fee: { base_fee_msat: 0, fee_rate: 0 } }))).toBe(false);
    expect(feesMoved(fees(), fees({ base_fee_msat: 0 }))).toBe(true);
  });

  it("writes each side of a change as its row does, for the room it needs", () => {
    const fees = (f: Partial<Fees> = {}): Fees => ({
      fee_rate: 500,
      base_fee_msat: 1000,
      inbound_fee: null,
      ...f,
    });
    const both = (before: Partial<Fees>, after: Partial<Fees>) => {
      const c = { before: fees(before), after: fees(after) };
      return [movedText(c, c.before), movedText(c, c.after)].map((t) =>
        t.replaceAll("\u202F", " "),
      );
    };
    expect(both({ fee_rate: 3391 }, { fee_rate: 2999 })).toStrictEqual(["3 391", "2 999"]);
    expect(both({}, { base_fee_msat: 2000 })).toStrictEqual(["1 sat", "2 sats"]);
    expect(both({}, { inbound_fee: { base_fee_msat: -1000, fee_rate: -200 } })).toStrictEqual([
      "none",
      "−200 ppm −1 sat",
    ]);
    expect(both({ inbound_fee: { base_fee_msat: 0, fee_rate: 5 } }, {})).toStrictEqual([
      "+5 ppm",
      "none",
    ]);
  });

  it("names an inbound fee by its sign, and shows none when it is zero both ways", () => {
    const f = (fee_rate: number, base_fee_msat = 0) => ({ fee_rate, base_fee_msat });
    expect(inboundWord(f(-200))).toBe("discount");
    expect(inboundWord(f(0, -1000))).toBe("discount");
    expect(inboundWord(f(200))).toBe("surcharge");
    expect(inboundWord(f(0, 1))).toBe("surcharge");
    expect(inboundWord(f(-200, 1000))).toBe("fee");
    expect(inboundOf({ inbound_fee: f(0) })).toBeNull();
    expect(inboundOf({ inbound_fee: null })).toBeNull();
    expect(inboundOf({})).toBeNull();
    expect(inboundOf(null)).toBeNull();
    expect(inboundOf({ inbound_fee: f(-2_147_483_648, -2_147_483_648) })).toStrictEqual(
      f(-2_147_483_648, -2_147_483_648),
    );
  });

  it("compares the ends' inbound fees, none as zero", () => {
    const diff = (key: string, a: Policy, b: Policy) =>
      TERMS.find((t) => t.key === key)?.diff(a, b);
    const one = policy({ inbound_fee: { base_fee_msat: 0, fee_rate: -200 } });
    expect(diff("inbound_rate", one, policy())).toStrictEqual({ side: "two", text: "+200 ppm" });
    expect(diff("inbound_base", one, policy())).toStrictEqual({ side: null, text: "Same" });
    const show = (key: string, p: Policy) => TERMS.find((t) => t.key === key)?.show(p);
    expect(show("inbound_rate", one)).toBe("−200 ppm");
    expect(show("inbound_rate", policy({ inbound_fee: { base_fee_msat: 0, fee_rate: 5 } }))).toBe(
      "+5 ppm",
    );
  });

  it("reads the history and the changes as the server sends them, and refuses others", () => {
    const history = {
      id: "868675x206x2",
      scid: "955118263271817218",
      node_one: {
        from: 1,
        records: [rec(1, 638, { inbound_fee: { base_fee_msat: 0, fee_rate: -465 } })],
      },
      node_two: { from: null, records: [] },
      watched: [{ from: 1, to: 2 }],
    };
    expect(isFeeHistory(history)).toBe(true);
    expect(isFeeHistory({ ...history, watched: [{ from: 1 }] })).toBe(false);
    expect(isFeeHistory({ ...history, node_two: { from: null, records: [{ time: 1 }] } })).toBe(
      false,
    );
    const change = {
      id: "913755x2933x0",
      scid: "1004684247630675968",
      peer: { id: PEER, alias: "hashposition.com" },
      whose: "peer",
      time: 1_794_758_519,
      before: { fee_rate: 1000, base_fee_msat: 0, inbound_fee: null },
      after: { fee_rate: 50, base_fee_msat: 0, inbound_fee: null },
    };
    expect(isFeeChanges({ changes: [change] })).toBe(true);
    expect(isFeeChanges({ changes: [] })).toBe(true);
    expect(isFeeChanges({ changes: [{ ...change, whose: "theirs" }] })).toBe(false);
    expect(isFeeChanges({ changes: [{ ...change, before: null }] })).toBe(false);
  });
});
