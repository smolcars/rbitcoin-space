import { describe, expect, it } from "vitest";
import type { TxStatus } from "../../lib/esplora";
import type { LiveStatus } from "../../lib/live";
import { txTopic, type TxMessage } from "../../lib/track-topics";
import {
  announcement,
  answered,
  EMPTY,
  group,
  heard,
  liveness,
  type Model,
  parseRelatives,
  parseReplacements,
  place,
  placeShort,
  polls,
  recorded,
  duration,
  type Shown,
  shown,
  STRIP_BLOCKS,
  stripPlace,
} from "./state";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const HASH = "0".repeat(64);
const HASH2 = "1".repeat(64);
const topic = txTopic(A);
/** A message as the server sends it, read through the topic's parser. */
const msg = (m: Record<string, unknown>): TxMessage => {
  const parsed = topic.parse({ topic: `tx:${A}`, type: "tx", stale: false, ...m });
  if (!parsed) throw new Error(`unparsed ${JSON.stringify(m)}`);
  return parsed;
};
const position = {
  block: 0,
  blocks: 8,
  effective_rate: 3000,
  ahead_vsize: 412_311,
  ahead_txs: 1022,
};
const mempool = (p: object | null = position, extra = {}) =>
  msg({
    state: "mempool",
    time: 1_794_461_221,
    fee: 381,
    vsize: 127,
    rate: 3000,
    position: p,
    ...extra,
  });
const confirmed = (hash = HASH, height = 975_530) => msg({ state: "confirmed", height, hash });
const link = {
  txid: A,
  by: B,
  seen: 1_794_461_300,
  fee: 381,
  vsize: 127,
  rate: 3000,
  by_fee: 900,
  by_vsize: 127,
  by_rate: 7086,
};
const replaced = (chain: object[] = [link]) =>
  msg({ state: "replaced", by: B, chain, truncated: false });
const evicted = () => msg({ state: "evicted" });
const unknown = (stale = false) => msg({ state: "unknown", stale });
const off: TxMessage = { type: "off" };
const refused: TxMessage = { type: "refused" };

const waiting: TxStatus = { confirmed: false };
const mined: TxStatus = {
  confirmed: true,
  block_height: 975_530,
  block_hash: HASH,
  block_time: 1_794_462_000,
};

/** Applies inputs in order: a TxStatus or "missing" is an HTTP answer, anything else the topic. */
function run(...steps: (TxMessage | TxStatus | "missing")[]): Model {
  return steps.reduce<Model>(
    (m, s) => (s === "missing" || "confirmed" in s ? answered(m, s) : heard(m, s)),
    EMPTY,
  );
}
const kind = (m: Model) => shown(m).kind;
/** Grouped digits use a narrow no-break space; tests write a plain one. */
const sp = (t: string | undefined) => t?.replaceAll("\u202F", " ");

describe("the topic's parser", () => {
  it("reads every state, rates in sat/vB", () => {
    expect(mempool()).toStrictEqual({
      type: "tx",
      stale: false,
      state: "mempool",
      time: 1_794_461_221,
      fee: 381,
      vsize: 127,
      rate: 3,
      position: { block: 0, blocks: 8, effectiveRate: 3, aheadVsize: 412_311, aheadTxs: 1022 },
    });
    expect(mempool(null)).toMatchObject({ position: null });
    expect(replaced()).toMatchObject({
      state: "replaced",
      chain: [{ txid: A, by: B, rate: 3, byRate: 7.086 }],
    });
    expect(confirmed()).toMatchObject({ state: "confirmed", height: 975_530, hash: HASH });
    expect(evicted()).toMatchObject({ state: "evicted" });
    expect(unknown(true)).toMatchObject({ state: "unknown", stale: true });
    expect(topic.parse({ type: "off" })).toStrictEqual({ type: "off" });
    expect(topic.parse({ type: "refused", reason: "server_full" })).toStrictEqual({
      type: "refused",
    });
  });

  it("keeps a link known only by its txids", () => {
    expect(
      replaced([
        { txid: A, by: B },
        { txid: B, by: C, by_fee: null, by_vsize: null, by_rate: null },
      ]),
    ).toMatchObject({
      chain: [
        { txid: A, by: B },
        { txid: B, by: C },
      ],
    });
  });

  it("ignores what it cannot read", () => {
    const bad = [
      { type: "tx", stale: false, state: "mempool", time: 1, fee: 1, vsize: 1 }, // no position key
      { type: "tx", stale: false, state: "confirmed", height: 1, hash: "<b>" },
      { type: "tx", stale: false, state: "replaced", chain: [] },
      { type: "tx", stale: false, state: "replaced", chain: [{ txid: A, by: "not-a-txid" }] },
      { type: "tx", state: "evicted" }, // no stale
      { type: "tx", stale: false, state: "floating" },
      { type: "hello" },
    ];
    for (const m of bad) expect(topic.parse(m)).toBeUndefined();
  });
});

describe("what the page shows", () => {
  it("waits for the first word", () => {
    expect(kind(EMPTY)).toBe("loading");
    expect(kind(run(unknown()))).toBe("loading");
    expect(kind(run(off))).toBe("loading");
  });

  it("takes each topic state, with the position only from the topic", () => {
    expect(shown(run(waiting, mempool()))).toMatchObject({
      kind: "mempool",
      live: true,
      position: { block: 0 },
      time: 1_794_461_221,
    });
    expect(shown(run(waiting, confirmed()))).toMatchObject({ kind: "confirmed", height: 975_530 });
    expect(shown(run(waiting, replaced()))).toMatchObject({ kind: "replaced", chain: [{ by: B }] });
    expect(kind(run(waiting, evicted()))).toBe("evicted");
    expect(shown(run(waiting))).toMatchObject({ kind: "mempool", live: false, position: null });
  });

  it("lets HTTP decide when the topic says unknown, for every HTTP answer", () => {
    // Confirmed long before anyone followed it: the visitor's commonest case.
    expect(shown(run(mined, unknown()))).toMatchObject({
      kind: "confirmed",
      height: 975_530,
      time: 1_794_462_000,
    });
    expect(shown(run(unknown(), mined))).toMatchObject({ kind: "confirmed" });
    // In the node's mempool, but the engine has not seen it yet: no position to vouch for.
    expect(shown(run(waiting, unknown()))).toMatchObject({ kind: "mempool", live: false });
    // Not found anywhere, and nothing remembers why.
    expect(kind(run("missing", unknown()))).toBe("gone");
  });

  it("explains a vanished transaction with the replacement record when the topic cannot", () => {
    const m = recorded(
      run(waiting, unknown(), "missing"),
      parseReplacements({ txid: A, truncated: false, replaced_by: [link], replaces: [] })
        ?.replacedBy ?? [],
      false,
    );
    expect(shown(m)).toMatchObject({ kind: "replaced", chain: [{ txid: A, by: B }] });
    // An empty record says nothing: the server saw no replacement since it started.
    expect(kind(recorded(run("missing"), [], false))).toBe("gone");
  });

  it("keeps the newest word: an older HTTP answer never overrules the topic, nor the reverse", () => {
    // Confirmed live, then the socket drops: the load's "unconfirmed" must not come back.
    expect(kind(run(waiting, mempool(), confirmed()))).toBe("confirmed");
    // A poll after the drop sees a reorganisation the topic could not report.
    expect(kind(run(waiting, mempool(), confirmed(), waiting))).toBe("mempool");
    // ...and the topic, back, says where it is again.
    expect(shown(run(waiting, confirmed(), waiting, mempool()))).toMatchObject({
      kind: "mempool",
      live: true,
    });
  });

  it("never lets an answer to an older question undo what the topic said meanwhile", () => {
    // A poll asks while the socket is down; the socket comes back and says confirmed; the poll's
    // "waiting" lands after. It is older than the confirmation, so it changes nothing.
    const asking = run(waiting, mempool());
    const asked = asking.clock;
    const late = answered(heard(asking, confirmed()), waiting, asked);
    expect(kind(late)).toBe("confirmed");
    // A question asked after the confirmation is news, though: a reorganisation.
    const after = heard(asking, confirmed());
    expect(kind(answered(after, waiting, after.clock))).toBe("mempool");
  });

  it("never lets an answer to an older request undo a newer one", () => {
    // A refetch asked first answers last: the status poll asked after it already said confirmed.
    const m = answered(answered(run("missing"), mined, 0, 3), waiting, 0, 2);
    expect(kind(m)).toBe("confirmed");
    expect(kind(answered(m, waiting, 0, 4))).toBe("mempool");
  });

  it("drops a position the moment the topic stops vouching for it", () => {
    expect(shown(run(waiting, mempool(), unknown()))).toMatchObject({
      kind: "mempool",
      live: false,
      position: null,
    });
  });

  it("keeps what the topic knew about why it left when HTTP says it is gone", () => {
    expect(kind(run(waiting, replaced(), "missing"))).toBe("replaced");
    expect(kind(run(waiting, evicted(), "missing"))).toBe("evicted");
    expect(kind(run(waiting, mempool(), "missing"))).toBe("gone");
  });

  it("keeps the topic's position when a later HTTP answer only agrees that it waits", () => {
    expect(shown(run(waiting, mempool(), waiting))).toMatchObject({
      kind: "mempool",
      live: true,
      position: { block: 0 },
    });
    // ...but not once the topic has stopped vouching for it.
    expect(shown(run(waiting, mempool(), unknown(), waiting))).toMatchObject({
      live: false,
      position: null,
    });
    // Nor while the socket is down.
    expect(shown(run(waiting, mempool()), false)).toMatchObject({
      kind: "mempool",
      live: false,
      position: null,
    });
  });

  it("never takes a stale message as news", () => {
    const stale = mempool(position, { stale: true });
    expect(shown(run(waiting, stale))).toMatchObject({ kind: "mempool", live: false });
    expect(kind(run(mined, mempool({ ...position }, { stale: true })))).toBe("confirmed");
    // The last good word stays while the node is silent, until HTTP knows better.
    expect(kind(run(waiting, confirmed(), unknown(true)))).toBe("confirmed");
  });

  it("follows a confirmation through a reorganisation", () => {
    const m = run(waiting, mempool(), confirmed(HASH), mempool(), confirmed(HASH2, 975_531));
    expect(shown(m)).toMatchObject({ kind: "confirmed", hash: HASH2, height: 975_531 });
    // The block's time comes only from an HTTP answer about the same block.
    expect(shown(m)).toMatchObject({ time: undefined });
    expect(shown(answered(m, { ...mined, block_hash: HASH2, block_time: 7 }))).toMatchObject({
      time: 7,
    });
  });

  it("can see a transaction come back after it was dropped or not found", () => {
    expect(kind(run("missing", unknown(), mempool()))).toBe("mempool");
    expect(kind(run(waiting, evicted(), mempool()))).toBe("mempool");
  });

  it("grows the chain to the newest replacement", () => {
    const second = { ...link, txid: B, by: C, rate: 7086, by_rate: 12_000 };
    expect(shown(run(waiting, replaced(), replaced([link, second])))).toMatchObject({
      kind: "replaced",
      chain: [{ by: B }, { by: C }],
    });
  });
});

describe("how live the page is", () => {
  const cases: [TxMessage[], LiveStatus, ReturnType<typeof liveness>][] = [
    [[], "connecting", "connecting"],
    [[], "live", "connecting"],
    [[mempool()], "live", "live"],
    [[unknown()], "live", "live"],
    [[mempool(position, { stale: true })], "live", "stale"],
    [[off], "live", "off"],
    [[off], "reconnecting", "off"],
    [[refused], "live", "refused"],
    [[mempool()], "reconnecting", "down"],
    [[mempool()], "offline", "down"],
    [[], "reconnecting", "down"],
  ];
  it.each(cases)("%j on a %s socket is %s", (msgs, socket, want) => {
    expect(liveness(run(...msgs), socket)).toBe(want);
  });

  it("stops waiting for a topic that says nothing for a while", () => {
    expect(liveness(EMPTY, "live", true)).toBe("silent");
    expect(polls("silent")).toBe(true);
    expect(liveness(run(mempool()), "live", true)).toBe("live");
  });

  it("polls over HTTP exactly when the topic cannot speak", () => {
    expect(polls("live")).toBe(false);
    expect(polls("connecting")).toBe(false);
    for (const l of ["stale", "off", "refused", "down"] as const) expect(polls(l)).toBe(true);
  });
});

describe("what is announced", () => {
  const s = (m: Model): Shown => shown(m);
  const at = (block: number) => s(run(waiting, mempool({ ...position, block })));
  it("says each change of state once, in words", () => {
    expect(sp(announcement(at(1), s(run(waiting, confirmed()))))).toBe(
      "Confirmed in block 975 530.",
    );
    expect(sp(announcement(s(run(mined)), at(0)))).toMatch(
      /^Unconfirmed again: block 975 530 left the chain/,
    );
    expect(announcement(at(0), s(run(waiting, replaced())))).toBe(
      "Replaced by another transaction spending the same coins, at 7.09 sat/vB.",
    );
    expect(announcement(at(0), s(run(waiting, evicted())))).toBe(
      "Dropped from the mempool without being mined.",
    );
    expect(announcement(at(0), s(run(waiting, "missing")))).toBe("No longer in the mempool.");
    expect(announcement(s(run(waiting, evicted())), at(2))).toBe(
      "Back in the mempool, waiting for a block.",
    );
  });

  it("says entering or leaving the next block, and nothing for a position that only moves", () => {
    expect(announcement(at(2), at(0))).toBe("Now projected for the next block.");
    expect(announcement(at(0), at(1))).toBe("No longer projected for the next block.");
    expect(announcement(at(2), at(3))).toBeUndefined();
    expect(announcement(at(0), at(0))).toBeUndefined();
    expect(announcement(s(EMPTY), at(0))).toBeUndefined();
    expect(announcement(s(run(waiting)), at(0))).toBeUndefined();
  });
});

describe("the position in words", () => {
  const p = (block: number, aheadTxs = 1022) => ({
    block,
    blocks: 8,
    effectiveRate: 3,
    aheadVsize: 412_311,
    aheadTxs,
  });
  it("names the block without false precision", () => {
    expect(place(p(0), "mainnet")).toMatchObject({ where: "In the next block", page: 1 });
    expect(place(p(2), "mainnet")).toMatchObject({ where: "In about 3 blocks", page: 3 });
    expect(place(p(7), "mainnet")).toMatchObject({ where: "In more than 7 blocks", page: 8 });
    expect(sp(place(p(0), "mainnet").ahead)).toBe(
      "1 022 transactions (412.31 kvB) would be mined before it.",
    );
    expect(place(p(0, 0), "mainnet").ahead).toMatch(/^Nothing is ahead of it/);
    expect(place(p(0, 1), "mainnet").ahead).toMatch(/^1 transaction \(/);
  });

  it("says what that means in time, coarsely, and nothing on regtest", () => {
    expect(place(p(0), "mainnet").when).toMatch(
      /on average 10 minutes away whenever you look, though about one in seven takes more than 20/,
    );
    expect(place(p(2), "signet").when).toBe(
      "Roughly 30 minutes at the usual pace of a block every 10 minutes, if nothing that pays more arrives.",
    );
    expect(place(p(7), "mainnet").when).toMatch(/^Not soon: more than 1 hour 10 minutes/);
    expect(place(p(2), "regtest").when).toMatch(/^Regtest has no block schedule/);
    expect(duration(40)).toBe("40 minutes");
    expect(duration(120)).toBe("2 hours");
    expect(duration(60)).toBe("1 hour");
  });
});

describe("the routes", () => {
  const relatives = {
    txid: A,
    stale: false,
    chunk: 0,
    parents: [],
    children: [B],
    chunks: [
      { fee: 3314, vsize: 265, rate: 12_505, txs: [A, B] },
      { fee: 10, vsize: 100, rate: 100, txs: [C] },
    ],
    txs: [
      { txid: A, chunk: 0, time: 1, fee: 139, vsize: 139, block: 0, parents: [] },
      { txid: B, chunk: 0, time: 1, fee: 3175, vsize: 126, block: 0, parents: [A] },
      { txid: C, chunk: 1, time: 1, fee: null, vsize: null, block: null, parents: [B] },
    ],
  };
  it("reads a parent lifted by its child", () => {
    const r = parseRelatives(relatives);
    if (!r) throw new Error("unparsed");
    const g = group(r, A);
    expect(g.rate).toBeCloseTo(12.505);
    expect(g.together.map((m) => [m.txid, m.relation])).toStrictEqual([
      [A, "this"],
      [B, "child"],
    ]);
    expect(g.together[1]?.rate).toBeCloseTo(3175 / 126);
    expect(g.before).toStrictEqual([]);
    expect(g.after).toStrictEqual([]);
    // From the child's side, the parent is in its group; a member that left has no rate.
    expect(group({ ...r, chunk: 1, parents: [B], children: [] }, C)).toMatchObject({
      together: [{ txid: C, rate: undefined }],
      before: [B],
    });
  });

  it("refuses malformed replies", () => {
    expect(parseRelatives({ ...relatives, children: ["x"] })).toBeUndefined();
    expect(parseRelatives({ ...relatives, chunks: [{ fee: 1 }] })).toBeUndefined();
    expect(parseReplacements({ replaced_by: [], replaces: [{ txid: A }] })).toBeUndefined();
    expect(parseReplacements({ replaced_by: [link], replaces: [], truncated: true })).toMatchObject(
      { truncated: true },
    );
  });
});

describe("the summary's block strip", () => {
  const at = (block: number, blocks = 8) => ({
    block,
    blocks,
    effectiveRate: 1,
    aheadVsize: 0,
    aheadTxs: 0,
  });

  it("puts a waiting transaction in its projected block, the next one beside the line", () => {
    expect(stripPlace({ position: at(0) })).toStrictEqual({ projected: 8, mined: 0, here: 7 });
    expect(stripPlace({ position: at(2) })).toStrictEqual({ projected: 8, mined: 0, here: 5 });
    expect(placeShort(at(0))).toBe("Next block");
    expect(placeShort(at(2))).toBe("~3 blocks");
    // A projection of one block has only the next.
    expect(stripPlace({ position: at(0, 1) })).toStrictEqual({ projected: 1, mined: 0, here: 0 });
  });

  it("puts one deep in the queue in the farthest slot, which holds everything after it", () => {
    expect(stripPlace({ position: at(7) })).toStrictEqual({ projected: 8, mined: 0, here: 0 });
    // A position past the projection's last block still lands in it, never off the strip.
    expect(stripPlace({ position: at(12) })).toStrictEqual({ projected: 8, mined: 0, here: 0 });
    expect(placeShort(at(7))).toBe("7+ blocks");
  });

  it("puts a mined one past the line, the blocks found since between, six in all", () => {
    expect(stripPlace({ confirmations: 1 })).toStrictEqual({ projected: 5, mined: 1, here: 5 });
    expect(stripPlace({ confirmations: 3 })).toStrictEqual({ projected: 3, mined: 3, here: 5 });
    // Settled: six solid blocks, its own the farthest; nothing left to come.
    expect(stripPlace({ confirmations: 400 })).toStrictEqual({
      projected: 0,
      mined: STRIP_BLOCKS,
      here: STRIP_BLOCKS - 1,
    });
    // The tip not known yet: its own block, at least.
    expect(stripPlace({ confirmations: undefined })).toStrictEqual({
      projected: 5,
      mined: 1,
      here: 5,
    });
  });
});
