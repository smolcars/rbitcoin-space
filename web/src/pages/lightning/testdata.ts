// Answers for the Lightning pages' tests, taken from the mainnet examples in docs/API.md and from
// a mainnet server on 2026-11-12, trimmed. Closes of each kind are those answers' shape.
import type { Closes, FeedEvent, Mover, Movers } from "./feed";
import type {
  ChannelDetail,
  CloseKind,
  ListedChannel,
  NodeCloses,
  RecordPeer,
  RecordTally,
  NodeDetail,
  OpenChannel,
  Overview,
  RankedNode,
  Series,
  Stats,
  Status,
} from "./lightning";

export const ACINQ = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";
export const BFX = "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025";
export const BINANCE = "03a1f3afd646d77bdaf545cceaf079bab6057eae52c6319b63b5803d0989d6a72f";
export const PENUMBRA = "0294cd6f26d81abaada088a6adee7900095fdfa03617950f2f8428f8bebba2475d";
export const LNFI = "02cbdcbf587ad07f5fa938434ad16955239a5dea0b5c5187c7817cafb962a16d0f";
export const FUNDING = "a7f10c2558d1b6c2d0e9a4a3b8f1e2c7d6b5a4f3e2d1c0b9a8f7e6d5c4b3d4f5";
export const CLOSING = "5c1ab2f43e2d9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b";
export const SWEEP = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d";

export const T0 = 1_794_508_200;

export const synced: Status = {
  state: "synced",
  peers_configured: 6,
  peers_connected: 3,
  channels: 36_228,
  nodes: 13_639,
  validation: { verified: 36_228, unchecked: 0, pending: 0, early: 0 },
};

export const syncing: Status = {
  state: "syncing",
  peers_configured: 6,
  peers_connected: 3,
  channels: 26_704,
  nodes: 11_316,
  validation: { verified: 26_704, unchecked: 0, pending: 5000, early: 0 },
};

export const stats: Stats = {
  time: T0,
  samples: 1,
  channels: 36_228,
  nodes: 13_639,
  capacity: 322_085_363_482,
  avg_capacity: 8_890_509,
  med_capacity: 1_000_000,
  tor_nodes: 4553,
  clearnet_nodes: 1345,
  clearnet_tor_nodes: 1050,
  unannounced_nodes: 6691,
  policies: 47_983,
  avg_fee_rate: 974,
  avg_base_fee_msat: 1481,
  med_fee_rate: 130,
  med_base_fee_msat: 484,
};

/** The snapshot above, taken at another time. */
export const at = (time: number): Stats => ({ ...stats, time });

const block = (height: number, time: number) => ({
  height,
  hash: `0000000000000000000${String(height).padStart(6, "0")}${"ab".repeat(19)}c`,
  time,
});

export const opened: ListedChannel = {
  id: "975574x1256x1",
  scid: "1072654956838256641",
  node_one: { id: PENUMBRA, alias: "Penumbra" },
  node_two: { id: LNFI, alias: "lnd.lnfi.network" },
  capacity: 10_000_000,
  opened: block(975_574, 1_794_502_645),
  closed: null,
  penalty: null,
};

/** A closed channel of a kind, closed in block 975 590. */
export function closedOf(kind: "cooperative" | "force" | "penalty" | "other"): ListedChannel {
  return {
    ...opened,
    id: `811984x2037x${["cooperative", "force", "penalty", "other"].indexOf(kind)}`,
    closed: { block: block(975_590, T0 + 600), txid: CLOSING, kind, fee: 1_234 },
    penalty: kind === "penalty" ? { block: block(975_592, T0 + 1800), txid: SWEEP } : null,
  };
}

const bfxNode: RankedNode = {
  id: BFX,
  alias: "bfx-lnd0",
  capacity: 32_461_828_251,
  channels: 544,
  first_seen: 1_574_813_156,
  last_update: 1_794_504_476,
};
const binanceNode: RankedNode = {
  id: BINANCE,
  alias: "Binance",
  capacity: 32_315_912_432,
  channels: 130,
  first_seen: 1_705_383_088,
  last_update: 1_794_504_053,
};
export const top: RankedNode[] = [bfxNode, binanceNode];

export const overview = (o: Partial<Overview> = {}): Overview => ({
  statistics: stats,
  top_capacity: top,
  top_channels: [binanceNode, bfxNode],
  opened: [opened],
  closed: [closedOf("force"), closedOf("cooperative")],
  ...o,
});

export const series = (s: Partial<Series> = {}): Series => ({
  interval: "1w",
  from: T0 - 7 * 86_400,
  to: T0 + 60,
  step: 600,
  first: T0,
  slots: 1007,
  sampled: 0,
  complete: false,
  points: [stats],
  ...s,
});

const OWN = {
  fee_rate: 2499,
  base_fee_msat: 1000,
  cltv_delta: 144,
  min_htlc_msat: 1,
  max_htlc_msat: 20_000_000_000,
  enabled: true,
  last_update: 1_794_550_008,
};
const THEIRS = {
  ...OWN,
  fee_rate: 1,
  cltv_delta: 80,
  min_htlc_msat: 1000,
  last_update: 1_794_715_678,
};

/** An open channel of ACINQ's as its list answers it, with bfx-lnd0 at the other end. */
export const openChannel = (n: number, c: Partial<OpenChannel> = {}): OpenChannel => ({
  id: `81${String(n).padStart(4, "0")}x2037x0`,
  scid: "892785849701564416",
  capacity: 500_000_000 - n,
  state: "active",
  op_state: "active",
  peer: { id: BFX, alias: "bfx-lnd0", capacity: 32_461_828_251, channels: 544 },
  with_peer: 10,
  fee_rate: 2499,
  own_policy: OWN,
  peer_policy: THEIRS,
  last_update: 1_794_715_678,
  funded: 1_697_189_564,
  ...c,
});

export const acinq = (n: Partial<NodeDetail> = {}): NodeDetail => ({
  id: ACINQ,
  alias: "ACINQ",
  addresses: [
    "3.33.236.230:9735",
    "of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735",
  ],
  features: [
    { bit: 0, name: "data-loss-protect", required: true },
    { bit: 7, name: "gossip-queries", required: false },
    { bit: 37, name: null, required: false },
  ],
  last_update: 1_794_051_404,
  first_seen: 1_551_152_144,
  capacity: 27_383_219_285,
  color: "#49daaa",
  rank: { capacity: 3, channels: 1, of: 13_639 },
  figures: {
    capacity: { median: 1_956_163, smallest: 100_000, largest: 500_000_000 },
    funded: { median: 1_772_013_542, oldest: 1_551_152_144, youngest: 1_794_694_919 },
    states: { active: 1698, here: 42, peer: 7, inactive: 60 },
    fee_rates: {
      outgoing: { median: 499, weighted: 1522, lowest: 499, highest: 3999, policies: 1747 },
      incoming: { median: 100, weighted: 1810, lowest: 0, highest: 2_000_000, policies: 1729 },
    },
    last_policy_update: 1_794_715_678,
  },
  channels: {
    open: 1807,
    active: 1729,
    closed: 0,
    cooperative: 0,
    force: 0,
    penalty: 0,
    other: 0,
  },
  open_channels: {
    status: "open",
    page: 0,
    per_page: 25,
    total: 1807,
    sort: "capacity",
    dir: "desc",
    states: { active: 1698, here: 42, peer: 7, inactive: 60 },
    channels: Array.from({ length: 25 }, (_, i) => openChannel(i)),
  },
  fees: {
    incoming: [
      { bucket: null, count: 78, capacity: 157_929_566 },
      { bucket: 0, count: 60, capacity: 1_146_048_852 },
      { bucket: 1, count: 581, capacity: 8_287_839_702 },
      { bucket: 2000, count: 1088, capacity: 17_791_401_165 },
    ],
    outgoing: [
      { bucket: null, count: 60, capacity: 91_707_732 },
      { bucket: 400, count: 266, capacity: 6_377_292_455 },
      { bucket: 2000, count: 1481, capacity: 20_914_219_098 },
    ],
  },
  ...n,
});

export const channel = (c: Partial<ChannelDetail> = {}): ChannelDetail => ({
  id: "811984x2037x0",
  scid: "892785849701564416",
  capacity: 500_000_000,
  state: "active",
  last_update: 1_794_496_008,
  node_one: {
    id: BFX,
    alias: "bfx-lnd0",
    policy: {
      fee_rate: 1,
      base_fee_msat: 1000,
      cltv_delta: 80,
      min_htlc_msat: 1000,
      max_htlc_msat: 20_000_000_000,
      enabled: true,
      last_update: 1_794_456_478,
    },
  },
  node_two: {
    id: ACINQ,
    alias: "ACINQ",
    policy: {
      fee_rate: 2499,
      base_fee_msat: 1000,
      cltv_delta: 144,
      min_htlc_msat: 1,
      max_htlc_msat: 20_000_000_000,
      enabled: true,
      last_update: 1_794_496_008,
    },
  },
  funding: { txid: FUNDING, vout: 0, block: block(811_984, 1_697_189_564) },
  closed: null,
  penalty: null,
  ...c,
});

/** The channel a close funds, or the one this channel's funding closed: the lineage fields. */
export const NEXT = {
  id: "975402x1310x1",
  scid: "1072528709001609217",
  capacity: 4_000_000,
  state: "active" as const,
};
export const EARLIER = {
  ...NEXT,
  id: "948730x2215x0",
  scid: "1043139666765086720",
  state: "closed" as const,
};

/** A closed channel of a kind, as the channel route answers it. */
export const closedChannel = (
  kind: "cooperative" | "force" | "penalty" | "other",
  c: Partial<ChannelDetail> = {},
): ChannelDetail => {
  const l = closedOf(kind);
  return channel({
    id: l.id,
    state: "closed",
    node_one: { ...channel().node_one, policy: null },
    node_two: { ...channel().node_two, policy: null },
    closed: l.closed,
    penalty: l.penalty,
    ...c,
  });
};

// The overview's feed, movers and closes (docs/API.md "The overview"), in the server's shapes.

const ends = { node_one: { id: ACINQ, alias: "ACINQ" }, node_two: { id: BFX, alias: "bfx-lnd0" } };
const fees = (fee_rate: number, inbound: number | null = null) => ({
  fee_rate,
  base_fee_msat: 1000,
  inbound_fee: inbound === null ? null : { base_fee_msat: 0, fee_rate: inbound },
});

/** An open, `n` blocks after 975 000: its id and time follow from `n`. */
export const openEvent = (n: number): FeedEvent => ({
  event: "opened",
  time: T0 + n * 600,
  id: `${975_000 + n}x1x0`,
  scid: String(1_072_000_000 + n),
  capacity: 5_000_000,
  ...ends,
  height: 975_000 + n,
});
export const closeEvent = (n: number, kind: CloseKind): FeedEvent => {
  const { height, ...rest } = openEvent(n) as Extract<FeedEvent, { event: "opened" }>;
  return { ...rest, event: "closed", height, kind };
};
/** A fee change on channel `n`, its rate from `from` to `to`; or its inbound fee when `inbound`. */
export const feeEvent = (n: number, from = 100, to = 200, inbound = false): FeedEvent => ({
  event: "fee",
  time: T0 + n * 60,
  id: `${900_000 + n}x2x1`,
  scid: String(990_000_000 + n),
  capacity: 2_000_000,
  ...ends,
  by: "node_two",
  before: inbound ? fees(100, from) : fees(from),
  after: inbound ? fees(100, to) : fees(to),
});

export const mover = (
  id: string,
  alias: string | null,
  capacity: number,
  channels: number,
): Mover => ({
  id,
  alias,
  capacity_change: capacity,
  channels_change: channels,
  capacity: 10_000_000_000 + capacity,
  channels: 100 + channels,
});

export const movers = (m: Partial<Movers> = {}): Movers => ({
  period: "1w",
  from: T0 - 7 * 86_400,
  time: T0,
  capacity_up: [mover(ACINQ, "ACINQ", 556_000_000, 3), mover(BFX, "bfx-lnd0", 100_000_000, 68)],
  capacity_down: [mover(BINANCE, "Binance", -900_000_000, -1)],
  channels_up: [mover(BFX, "bfx-lnd0", 100_000_000, 68)],
  channels_down: [mover(BINANCE, "Binance", -900_000_000, -1)],
  new: [{ ...mover(PENUMBRA, "penumbra", 200_000, 1), time: T0 - 3600 }],
  left: [{ ...mover(LNFI, null, -1_022_000, -2), capacity: 0, channels: 0, time: T0 - 7200 }],
  ...m,
});

const DAY = 86_400;
/** Thirty UTC days to T0's, oldest first: a few closes on the last three. */
export const closes = (): Closes => {
  const last = Math.floor(T0 / DAY) * DAY;
  const days = Array.from({ length: 30 }, (_, i) => ({
    time: last - (29 - i) * DAY,
    cooperative: i >= 27 ? 3 : 0,
    force: i === 29 ? 1 : 0,
    penalty: i === 28 ? 1 : 0,
    other: 0,
    capacity: i >= 27 ? 9_000_000 : 0,
  }));
  return {
    time: T0,
    days,
    total: { cooperative: 9, force: 1, penalty: 1, other: 0, capacity: 27_000_000 },
  };
};

/** Monday 9 November 2026, 00:00 UTC: the first week of the records below. */
export const WEEK1 = 1_794_182_400;

/** A tally as `/nodes/:key/closes` sends one: counts, shares from `minimum`, fees, weeks. */
export function tally(
  counts: { cooperative: number; force: number; penalty: number; other: number },
  weeks: { cooperative: number; force: number; penalty: number; other: number }[] = [counts],
  minimum = 20,
): RecordTally {
  const closed = counts.cooperative + counts.force + counts.penalty + counts.other;
  const share = (n: number) => Math.round((n * 1000) / closed) / 10;
  return {
    ...counts,
    closed,
    shares:
      closed < minimum
        ? null
        : {
            cooperative: share(counts.cooperative),
            force: share(counts.force),
            penalty: share(counts.penalty),
            other: share(counts.other),
          },
    fees: {
      cooperative: { sum: counts.cooperative * 300, known: counts.cooperative },
      force: { sum: counts.force * 1_000, known: counts.force },
      penalty: { sum: counts.penalty * 2_000, known: counts.penalty },
      other: { sum: 0, known: 0 },
    },
    weeks: weeks.map((w, i) => ({ ...w, time: WEEK1 + i * 7 * 86_400 })),
  };
}

/** A node's close record: `peers` those it had a force close or penalty with. */
export function closeRecord(
  node: RecordTally,
  peers: RecordPeer[] = [],
  network: RecordTally | null = tally({ cooperative: 1_638, force: 158, penalty: 0, other: 6 }),
): NodeCloses {
  return {
    id: ACINQ,
    from: 1_794_502_800,
    time: 1_795_215_000,
    minimum: 20,
    cap: 10_000,
    capped: false,
    node,
    peers: { count: peers.length + 3, forced: peers.length, list: peers, more: 0 },
    network: network === null ? null : { ...network, time: 1_795_214_000 },
  };
}

export function recordPeer(n: number, more: Partial<RecordPeer> = {}): RecordPeer {
  return {
    id: `03${n.toString(16).padStart(2, "0").repeat(32)}`,
    alias: `peer ${n}`,
    cooperative: 0,
    force: 1,
    penalty: 0,
    other: 0,
    closed: 1,
    shares: null,
    open: 0,
    held: true,
    ...more,
  };
}
