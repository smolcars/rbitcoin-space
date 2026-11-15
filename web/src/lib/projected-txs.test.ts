import { describe, expect, it } from "vitest";
import { deltaFrame, type FakeRecord, fakeTxid, snapshotFrame } from "./fakes";
import { BlockTxs, decodeFrame, projectedTxsTopic } from "./projected-txs";

const rec = (n: number, rate = 1000 + n, vsize = 100 + n, fee = 200 + n): FakeRecord => ({
  txid: fakeTxid(n),
  rate,
  vsize,
  fee,
});

/** Deterministic random numbers, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("decodeFrame", () => {
  it("reads a snapshot: txids as hex, rates in sat/vB", () => {
    const f = decodeFrame(snapshotFrame(3, 812, [rec(1, 1234, 141, 174), rec(2)]));
    expect(f).toStrictEqual({
      kind: "snapshot",
      block: 3,
      seq: 812n,
      txs: [
        { id: fakeTxid(1), rate: 1.234, vsize: 141, fee: 174 },
        { id: fakeTxid(2), rate: 1.002, vsize: 102, fee: 202 },
      ],
    });
  });

  it("reads a delta: removed txids, then set records", () => {
    const f = decodeFrame(deltaFrame(0, 9, 8, [fakeTxid(7)], [rec(5)]));
    expect(f).toStrictEqual({
      kind: "delta",
      block: 0,
      seq: 9n,
      prev: 8n,
      removed: [fakeTxid(7)],
      set: [{ id: fakeTxid(5), rate: 1.005, vsize: 105, fee: 205 }],
    });
  });

  it("keeps full 64-bit sequence numbers", () => {
    const buf = snapshotFrame(0, 0, []);
    new DataView(buf).setBigUint64(8, 2n ** 64n - 1n, true);
    expect(decodeFrame(buf)).toMatchObject({ kind: "snapshot", seq: 2n ** 64n - 1n });
  });

  it("ignores kinds it does not know and frames too short to name their block", () => {
    expect(decodeFrame(new ArrayBuffer(0))).toStrictEqual({ kind: "unknown" });
    expect(decodeFrame(Uint8Array.of(1, 1).buffer)).toStrictEqual({ kind: "unknown" });
    expect(decodeFrame(Uint8Array.of(9, 1, 0, 0).buffer)).toStrictEqual({ kind: "unknown" });
  });

  it("names another format by its version", () => {
    const buf = snapshotFrame(2, 1, [rec(1)]);
    new Uint8Array(buf)[1] = 3;
    expect(decodeFrame(buf)).toStrictEqual({ kind: "version", block: 2 });
    new Uint8Array(buf)[1] = 1; // the 48-byte records before flags
    expect(decodeFrame(buf)).toStrictEqual({ kind: "version", block: 2 });
  });

  it("steps over each record's flags", () => {
    const flagged = (n: number) => ({ ...rec(n), flags: 2n ** 63n + 0x1a_0000_1000n });
    expect(decodeFrame(snapshotFrame(0, 1, [flagged(1), flagged(2)]))).toStrictEqual(
      decodeFrame(snapshotFrame(0, 1, [rec(1), rec(2)])),
    );
    expect(decodeFrame(deltaFrame(0, 2, 1, [fakeTxid(1)], [flagged(3)]))).toStrictEqual(
      decodeFrame(deltaFrame(0, 2, 1, [fakeTxid(1)], [rec(3)])),
    );
  });

  it("refuses truncated, overlong and padded frames, and counts that do not match the length", () => {
    const malformed = (buf: ArrayBuffer) =>
      expect(decodeFrame(buf)).toMatchObject({ kind: "malformed" });
    const snap = snapshotFrame(1, 5, [rec(1), rec(2)]);
    malformed(snap.slice(0, 15)); // inside the header
    malformed(snap.slice(0, snap.byteLength - 1)); // a record cut short
    const long = new Uint8Array(snap.byteLength + 1);
    long.set(new Uint8Array(snap));
    malformed(long.buffer); // a byte too many
    const huge = structuredClone(snap);
    new DataView(huge).setUint32(4, 0xffff_ffff, true); // a count far beyond the bytes
    malformed(huge);
    const padded = structuredClone(snap);
    new Uint8Array(padded)[3] = 1;
    malformed(padded);

    const delta = deltaFrame(1, 6, 5, [fakeTxid(1)], [rec(3)]);
    malformed(delta.slice(0, 31));
    malformed(delta.slice(0, delta.byteLength - 56)); // the set record is missing
    const moreRemoved = structuredClone(delta);
    new DataView(moreRemoved).setUint32(4, 2, true);
    malformed(moreRemoved);
    const padded2 = structuredClone(delta);
    new DataView(padded2).setUint32(28, 1, true);
    malformed(padded2);
  });

  it("refuses a fee a number cannot hold exactly", () => {
    const buf = snapshotFrame(0, 1, [rec(1)]);
    new DataView(buf).setBigUint64(16 + 40, 2n ** 53n, true);
    expect(decodeFrame(buf)).toStrictEqual({ kind: "malformed", block: 0 });
  });

  it("never throws on random or mutated bytes", () => {
    const random = rng(42);
    const valid = [
      snapshotFrame(0, 3, [rec(1), rec(2), rec(3)]),
      deltaFrame(0, 4, 3, [fakeTxid(1)], [rec(4)]),
    ];
    for (let i = 0; i < 5000; i++) {
      const base = valid[i % 2] ?? new ArrayBuffer(0);
      const cut = Math.floor(random() * (base.byteLength + 8));
      const bytes = new Uint8Array(cut);
      bytes.set(new Uint8Array(base).subarray(0, Math.min(cut, base.byteLength)));
      for (let k = 0; k < 3; k++) {
        if (bytes.length > 0)
          bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      }
      // Keep the kind and version readable half the time, so the deep paths are reached too.
      if (i % 4 < 2 && bytes.length > 1) bytes.set([1 + (i % 2), 2]);
      expect(() => decodeFrame(bytes.buffer)).not.toThrow();
    }
  });
});

const apply = (m: BlockTxs, buf: ArrayBuffer) => m.apply(decodeFrame(buf));
// oxlint-disable-next-line unicorn/no-array-sort -- sorts a copy; toSorted is newer than the browsers we build for
const sortedIds = (keys: Iterable<string>) => [...keys].sort();
const ids = (m: BlockTxs) => sortedIds(m.txs.keys());

describe("BlockTxs", () => {
  it("takes a snapshot whole, whenever it comes", () => {
    const m = new BlockTxs();
    expect(apply(m, snapshotFrame(0, 1, [rec(1), rec(2)]))).toStrictEqual({
      result: "changed",
      added: [fakeTxid(1), fakeTxid(2)],
      removed: [],
      snapshot: true,
    });
    expect(apply(m, snapshotFrame(0, 7, [rec(2), rec(3)]))).toStrictEqual({
      result: "changed",
      added: [fakeTxid(3)],
      removed: [fakeTxid(1)],
      snapshot: true,
    });
    expect(ids(m)).toStrictEqual([fakeTxid(2), fakeTxid(3)]);
    expect(m.seq).toBe(7n);
  });

  it("keeps an unchanged transaction the same object, and replaces a changed one", () => {
    const m = new BlockTxs();
    apply(m, snapshotFrame(0, 1, [rec(1), rec(2)]));
    const one = m.txs.get(fakeTxid(1));
    const two = m.txs.get(fakeTxid(2));
    apply(m, deltaFrame(0, 2, 1, [], [rec(1), rec(2, 9999)]));
    expect(m.txs.get(fakeTxid(1))).toBe(one);
    expect(m.txs.get(fakeTxid(2))).not.toBe(two);
    expect(m.txs.get(fakeTxid(2))?.rate).toBe(9.999);
    apply(m, snapshotFrame(0, 3, [rec(1), rec(2, 9999)]));
    expect(m.txs.get(fakeTxid(1))).toBe(one);
  });

  it("matches the server's block after a snapshot and a long random run of deltas", () => {
    const random = rng(7);
    const m = new BlockTxs();
    // The server's side: the block it holds, and the frames it sends.
    const server = new Map<string, FakeRecord>();
    let next = 0;
    for (; next < 300; next++) server.set(fakeTxid(next), rec(next));
    apply(m, snapshotFrame(4, 1, [...server.values()]));
    let seq = 1;
    for (let step = 0; step < 2000; step++) {
      const held = [...server.keys()];
      const removed = held.filter(() => random() < 0.05);
      for (const id of removed) server.delete(id);
      const set: FakeRecord[] = [];
      for (let k = Math.floor(random() * 12); k > 0; k--) {
        // New transactions, and some still held whose rate changes (outbid, or lifted by a child).
        const pick = random() < 0.3 ? held[Math.floor(random() * held.length)] : undefined;
        const r =
          pick && server.has(pick)
            ? { ...(server.get(pick) as FakeRecord), rate: Math.floor(random() * 50_000) }
            : rec(next++, Math.floor(random() * 50_000));
        server.set(r.txid, r);
        set.push(r);
      }
      // Now and then the server sends a snapshot instead, as it does at a new block.
      const frame =
        step % 250 === 249
          ? snapshotFrame(4, seq + 1, [...server.values()])
          : deltaFrame(4, seq + 1, seq, removed, set);
      seq++;
      const r = apply(m, frame);
      expect(r.result).not.toBe("lost");
    }
    expect(m.seq).toBe(BigInt(seq));
    expect(ids(m)).toStrictEqual(sortedIds(server.keys()));
    for (const [id, r] of server) {
      expect(m.txs.get(id)).toStrictEqual({ id, rate: r.rate / 1000, vsize: r.vsize, fee: r.fee });
    }
  });

  it("loses its place on a gap, keeps the last picture, and waits for the snapshot a restart brings", () => {
    const m = new BlockTxs();
    apply(m, snapshotFrame(0, 10, [rec(1), rec(2)]));
    expect(apply(m, deltaFrame(0, 12, 11, [], [rec(3)]))).toStrictEqual({ result: "lost" });
    expect(ids(m)).toStrictEqual([fakeTxid(1), fakeTxid(2)]);
    // The old subscription's frames still in flight are not a second loss.
    expect(apply(m, deltaFrame(0, 13, 12, [], [rec(4)]))).toStrictEqual({ result: "ignored" });
    expect(apply(m, snapshotFrame(0, 20, [rec(5)])).result).toBe("changed");
    expect(apply(m, deltaFrame(0, 21, 20, [fakeTxid(5)], [])).result).toBe("changed");
    expect(m.txs.size).toBe(0);
  });

  it("loses its place on a delta before any snapshot", () => {
    const m = new BlockTxs();
    expect(apply(m, deltaFrame(0, 2, 1, [], [rec(1)]))).toStrictEqual({ result: "lost" });
    expect(m.txs.size).toBe(0);
  });

  it("loses its place when a delta removes a transaction it does not hold, changing nothing", () => {
    const m = new BlockTxs();
    apply(m, snapshotFrame(0, 1, [rec(1), rec(2)]));
    expect(apply(m, deltaFrame(0, 2, 1, [fakeTxid(1), fakeTxid(9)], [rec(3)]))).toStrictEqual({
      result: "lost",
    });
    expect(ids(m)).toStrictEqual([fakeTxid(1), fakeTxid(2)]);
  });

  it("loses its place on a malformed frame, and reports a newer format", () => {
    const m = new BlockTxs();
    apply(m, snapshotFrame(0, 1, [rec(1)]));
    expect(m.apply({ kind: "malformed", block: 0 })).toStrictEqual({ result: "lost" });
    expect(m.apply({ kind: "version", block: 0 })).toStrictEqual({ result: "version" });
    expect(m.apply({ kind: "unknown" })).toStrictEqual({ result: "ignored" });
  });

  it("after a reconnect, waits for the new subscription's snapshot without asking again", () => {
    const m = new BlockTxs();
    apply(m, snapshotFrame(0, 1, [rec(1)]));
    m.expectSnapshot();
    expect(apply(m, deltaFrame(0, 3, 2, [], [rec(2)]))).toStrictEqual({ result: "ignored" });
    expect(apply(m, snapshotFrame(0, 9, [rec(2)])).result).toBe("changed");
  });
});

describe("projectedTxsTopic", () => {
  it("takes its own block's frames and `off`, and leaves the rest", () => {
    const t = projectedTxsTopic(2);
    expect(t.name).toBe("projected-txs:2");
    expect(t.binary?.(snapshotFrame(1, 1, []))).toBeUndefined();
    expect(t.binary?.(new ArrayBuffer(2))).toBeUndefined();
    expect(t.binary?.(snapshotFrame(2, 1, []))).toMatchObject({ kind: "snapshot" });
    expect(t.parse({ topic: "projected-txs:2", type: "off" })).toStrictEqual({ kind: "off" });
    expect(t.parse({ topic: "projected-txs:2", type: "other" })).toBeUndefined();
  });
});
