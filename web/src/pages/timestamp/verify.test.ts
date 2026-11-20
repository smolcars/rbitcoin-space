import { describe, expect, it } from "vitest";
import { fromHex, hash, reversed, toHex } from "./hashes";
import { parseProof, type Proof, ProofError } from "./ots";
import {
  ATT,
  BLOCKS,
  chain,
  fixture,
  OP,
  PENDING_DIGEST,
  TWO_BLOCKS_DIGEST,
  writeProof,
} from "./testdata";
import { type Block, type FetchBlock, MAX_CHECKS, readHeader, steps, verify } from "./verify";

const hex = (s: string) => fromHex(s) ?? new Uint8Array();
const signal = new AbortController().signal;

/** A node that has `blocks`, and the heights it was asked for. */
function node(blocks: Map<number, Block> = BLOCKS): { fetchBlock: FetchBlock; asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    fetchBlock: (height) => {
      asked.push(height);
      return Promise.resolve(blocks.get(height) ?? null);
    },
  };
}

const run = (proof: Proof, digest: Uint8Array, n = node(), mainnet = true) =>
  verify(proof, digest, { mainnet, fetchBlock: n.fetchBlock, signal });

describe("verdicts", () => {
  const twoBlocks = parseProof(fixture("two-blocks"));

  it("verifies a real proof by its earliest block, and the later one too", async () => {
    const n = node();
    const v = await run(twoBlocks, hex(TWO_BLOCKS_DIGEST), n);
    expect(v.kind).toBe("verified");
    if (v.kind !== "verified") return;
    expect(v.check.height).toBe(449_397);
    expect(v.check.block.hash).toBe(
      "00000000000000000022410b1522faa06b947dedb0bc9435d46b86d9326893cf",
    );
    expect(v.checks.map((c) => [c.height, c.kind])).toStrictEqual([
      [449_397, "verified"],
      [449_399, "verified"],
    ]);
    expect(v.others.map((l) => l.attestation.kind)).toStrictEqual(["pending", "pending"]);
    expect(n.asked).toStrictEqual([449_397, 449_399]);
  });

  it("says a different file is one, and asks nothing", async () => {
    const n = node();
    const other = hash("sha256", new TextEncoder().encode("another file"));
    const v = await run(twoBlocks, other, n);
    expect(v).toMatchObject({ kind: "wrong-file", fileDigest: other });
    expect(n.asked).toStrictEqual([]);
  });

  it("says a proof whose path is changed does not lead to its block", async () => {
    // One bit flipped in an argument near the end of the path: still a proof, a wrong one.
    const bytes = fixture("two-blocks");
    const at = bytes.length - 40;
    bytes[at] = (bytes[at] ?? 0) ^ 1;
    const p = parseProof(bytes);
    const v = await run(p, hex(TWO_BLOCKS_DIGEST));
    // The other branch still verifies: the earlier block's path was the one changed.
    expect(v).toMatchObject({
      kind: "verified",
      check: { height: 449_399 },
      checks: [
        { height: 449_397, kind: "mismatch" },
        { height: 449_399, kind: "verified" },
      ],
    });
  });

  it("says a proof with no path to its block is broken", async () => {
    const d = new Uint8Array(32).fill(3);
    const p = parseProof(writeProof(d, chain([OP.sha256], ATT.bitcoin(449_397))));
    const v = await run(p, d);
    expect(v).toMatchObject({ kind: "broken", checks: [{ kind: "mismatch" }] });
  });

  it("never verifies a root of the wrong length or order", async () => {
    // The API's order of block 449 397's root, reached by reversing: a path that ends in it is wrong.
    const root = BLOCKS.get(449_397)?.merkleRoot ?? new Uint8Array();
    const reversedRoot = toHex(reversed(root));
    const p = parseProof(writeProof(hex(reversedRoot), { att: [ATT.bitcoin(449_397)] }));
    expect((await run(p, hex(reversedRoot))).kind).toBe("broken");
    // And the header's order, given straight: the root itself as the digest, which is right.
    const q = parseProof(writeProof(root, { att: [ATT.bitcoin(449_397)] }));
    expect((await run(q, root)).kind).toBe("verified");
  });

  it("says when the node has no block at the height", async () => {
    const d = new Uint8Array(32).fill(3);
    const p = parseProof(writeProof(d, { att: [ATT.bitcoin(4_000_000)] }));
    const v = await run(p, d);
    expect(v.kind).toBe("unknown-block");
  });

  it("is pending with only calendars' promises, and asks nothing", async () => {
    const n = node();
    const v = await run(parseProof(fixture("pending")), hex(PENDING_DIGEST), n);
    expect(v).toMatchObject({
      kind: "pending",
      calendars: [
        "https://bob.btc.calendar.opentimestamps.org",
        "https://alice.btc.calendar.opentimestamps.org",
      ],
    });
    expect(n.asked).toStrictEqual([]);
  });

  it("names notaries it does not check, never as failed", async () => {
    const d = new Uint8Array(32).fill(3);
    const p = parseProof(writeProof(d, { att: [ATT.litecoin(5), ATT.unknown([1])] }));
    const v = await run(p, d);
    expect(v.kind).toBe("no-bitcoin");
  });

  it("asks nothing on a server without mainnet", async () => {
    const n = node();
    const v = await run(twoBlocks, hex(TWO_BLOCKS_DIGEST), n, false);
    expect(v).toMatchObject({ kind: "no-mainnet", heights: [449_397, 449_399] });
    expect(n.asked).toStrictEqual([]);
  });

  it("asks about at most a few blocks, lowest first, once each", async () => {
    const d = new Uint8Array(32).fill(3);
    const att = Array.from({ length: 20 }, (_, i) => ATT.bitcoin(100 - i));
    const n = node(new Map());
    await run(parseProof(writeProof(d, { att: [...att, ...att] })), d, n);
    expect(n.asked).toStrictEqual(Array.from({ length: MAX_CHECKS }, (_, i) => 81 + i));
  });

  it("passes a failed request on", async () => {
    const p = parseProof(fixture("two-blocks"));
    const failing: FetchBlock = () => Promise.reject(new Error("offline"));
    await expect(
      verify(p, hex(TWO_BLOCKS_DIGEST), { mainnet: true, fetchBlock: failing, signal }),
    ).rejects.toThrow("offline");
  });

  it("rejects a proof it cannot play forward with its own error", async () => {
    const d = new Uint8Array(32).fill(3);
    const grow = Array.from({ length: 3 }, () => OP.append(new Uint8Array(2000)));
    const p = parseProof(writeProof(d, chain(grow, ATT.bitcoin(1))));
    await expect(run(p, d)).rejects.toBeInstanceOf(ProofError);
  });
});

describe("the header", () => {
  const { hash: h, header } = {
    hash: "00000000000000000022410b1522faa06b947dedb0bc9435d46b86d9326893cf",
    header:
      "0000002003c0fc517c1aef657a9671783d736fa2d9f35477b3a9d40200000000000000007c17a8a0d6bc1da3604ecd442fc38869983290dcbc4876bdf0fcf133791ff218fbf2835879430318d3e4b283",
  };
  it("gives the root as stored and the miner's time", () => {
    const b = readHeader(449_397, h, header);
    expect(b?.time).toBe(1_485_042_427);
    expect(toHex(b?.merkleRoot ?? new Uint8Array())).toBe(header.slice(72, 136));
  });
  it("refuses a header that is not the block named", () => {
    expect(readHeader(449_397, h, `${header.slice(0, -2)}00`)).toBeNull();
    expect(readHeader(449_397, h.replace("cf", "ce"), header)).toBeNull();
    expect(readHeader(449_397, h, header.slice(2))).toBeNull();
    expect(readHeader(449_397, h, header.toUpperCase())).toBeNull();
  });
});

describe("steps", () => {
  it("marks the transaction and the merkle branch on a real path", async () => {
    const v = await run(parseProof(fixture("two-blocks")), hex(TWO_BLOCKS_DIGEST));
    if (v.kind !== "verified") throw new Error(v.kind);
    const s = steps(hex(TWO_BLOCKS_DIGEST), v.check.leaf);
    expect(toHex(s.at(-1)?.result ?? new Uint8Array())).toBe(toHex(v.check.block.merkleRoot));
    const tx = s.findIndex((x) => x.txid !== undefined);
    const branch = s.findIndex((x) => x.branch !== undefined);
    expect(branch).toBe(tx + 1);
    // 67 operations: the 10 levels of the branch, 3 each, are one step apiece.
    expect(s[branch]?.branch).toBe(10);
    expect(s).toHaveLength(67 - 20);
    expect(s.slice(branch).every((x) => x.level === true)).toBe(true);
    // The transaction that carried it is in block 449 397 (checked on mainnet's node).
    expect(s[tx]?.txid).toBe("763fbb1e21c36ebc656a58dae1e04ab76b9529843aeba8642916d6ac493577d9");
  });

  it("marks nothing on a path without that shape", () => {
    const d = new Uint8Array(32).fill(3);
    const p = parseProof(writeProof(d, chain([OP.sha256, OP.sha256], ATT.bitcoin(1))));
    const leaf = { attestation: { kind: "bitcoin" as const, height: 1 }, message: d, path: [] };
    expect(steps(d, leaf)).toStrictEqual([]);
    expect(p.stamp.branches).toHaveLength(1);
  });
});
