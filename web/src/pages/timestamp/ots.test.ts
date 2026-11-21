import { describe, expect, it } from "vitest";
import { fromHex, hash, reversed, toHex } from "./hashes";
import { apply, LIMITS, MAGIC, parseProof, ProofError, type ProofErrorKind, walk } from "./ots";
import {
  ATT,
  BLOCKS,
  chain,
  fixture,
  OP,
  PENDING_DIGEST,
  TWO_BLOCKS_DIGEST,
  varbytes,
  varuint,
  writeProof,
  writeStamp,
} from "./testdata";

const D = new Uint8Array(32).fill(7);

/** The kind of `ProofError` reading `bytes` throws, or "ok". Anything else thrown fails the test. */
function kind(bytes: Uint8Array): ProofErrorKind | "ok" {
  try {
    walk(parseProof(bytes));
    return "ok";
  } catch (e) {
    if (e instanceof ProofError) return e.kind;
    throw e;
  }
}

describe("real proofs", () => {
  it("reads a proof with two Bitcoin attestations and two calendars", () => {
    const p = parseProof(fixture("two-blocks"));
    expect(p.fileHash).toBe("sha256");
    expect(toHex(p.digest)).toBe(TWO_BLOCKS_DIGEST);
    const leaves = walk(p);
    expect(leaves.map((l) => l.attestation)).toStrictEqual([
      { kind: "pending", uri: "https://bob.btc.calendar.opentimestamps.org" },
      { kind: "bitcoin", height: 449_399 },
      { kind: "pending", uri: "https://alice.btc.calendar.opentimestamps.org" },
      { kind: "bitcoin", height: 449_397 },
    ]);
    expect(leaves.map((l) => l.path.length)).toStrictEqual([22, 51, 22, 67]);
  });

  it("ends each Bitcoin path in its block's merkle root, as the header stores it", () => {
    for (const l of walk(parseProof(fixture("two-blocks")))) {
      if (l.attestation.kind !== "bitcoin") continue;
      const block = BLOCKS.get(l.attestation.height);
      expect(block).toBeDefined();
      expect(toHex(l.message)).toBe(toHex(block?.merkleRoot ?? new Uint8Array()));
    }
    // The node's API prints the same root the other way round.
    expect(toHex(BLOCKS.get(449_397)?.merkleRoot ?? new Uint8Array())).toBe(
      "7c17a8a0d6bc1da3604ecd442fc38869983290dcbc4876bdf0fcf133791ff218",
    );
  });

  it("reads a pending proof", () => {
    const p = parseProof(fixture("pending"));
    expect(toHex(p.digest)).toBe(PENDING_DIGEST);
    expect(walk(p).map((l) => l.attestation.kind)).toStrictEqual(["pending", "pending"]);
  });

  it("fails every cut-short copy as truncated", () => {
    const bytes = fixture("two-blocks");
    for (let n = MAGIC.length; n < bytes.length; n++)
      expect({ n, kind: kind(bytes.subarray(0, n)) }).toStrictEqual({ n, kind: "truncated" });
    for (let n = 0; n < MAGIC.length; n++) expect(kind(bytes.subarray(0, n))).toBe("not-proof");
  });
});

describe("each operation", () => {
  const m = new TextEncoder().encode("ab");
  it("does what the format says", () => {
    expect(toHex(apply({ kind: "append", arg: new Uint8Array([1]) }, m))).toBe("616201");
    expect(toHex(apply({ kind: "prepend", arg: new Uint8Array([1]) }, m))).toBe("016162");
    expect(toHex(apply({ kind: "reverse" }, m))).toBe("6261");
    expect(new TextDecoder().decode(apply({ kind: "hexlify" }, new Uint8Array([0xab, 1])))).toBe(
      "ab01",
    );
    for (const name of ["sha256", "sha1", "ripemd160", "keccak256"] as const)
      expect(toHex(apply({ kind: name }, m))).toBe(toHex(hash(name, m)));
  });

  it("plays a path of every kind forward", () => {
    const tree = chain(
      [
        OP.append([1, 2]),
        OP.sha1,
        OP.ripemd160,
        OP.reverse,
        OP.hexlify,
        OP.keccak256,
        OP.prepend([9]),
        OP.sha256,
      ],
      ATT.bitcoin(1),
    );
    const leaves = walk(parseProof(writeProof(D, tree)));
    let want: Uint8Array = new Uint8Array([...D, 1, 2]);
    want = hash("sha1", want);
    want = hash("ripemd160", want);
    want = reversed(want);
    want = new TextEncoder().encode(toHex(want));
    want = hash("keccak256", want);
    want = hash("sha256", new Uint8Array([9, ...want]));
    expect(toHex(leaves[0]?.message ?? new Uint8Array())).toBe(toHex(want));
  });

  it("reads a file hashed with another hash", () => {
    const digest = new Uint8Array(20).fill(1);
    const p = parseProof(writeProof(digest, { att: [ATT.bitcoin(5)] }, 1, 0x02));
    expect(p.fileHash).toBe("sha1");
    expect(p.digest).toStrictEqual(digest);
  });

  it("forks into branches, each reaching its own attestations", () => {
    const tree = {
      att: [ATT.pending("https://a.example")],
      ops: [
        [OP.sha256, { att: [ATT.bitcoin(10), ATT.litecoin(20)] }],
        [OP.append([1]), chain([OP.sha256], ATT.unknown([1, 2, 3]))],
      ] as [number[], { att: number[][] }][],
    };
    const leaves = walk(parseProof(writeProof(D, tree)));
    expect(leaves.map((l) => [l.attestation.kind, l.path.length])).toStrictEqual([
      ["pending", 0],
      ["bitcoin", 1],
      ["litecoin", 1],
      ["unknown", 2],
    ]);
    expect(leaves[3]?.attestation).toStrictEqual({
      kind: "unknown",
      tag: "0102030405060708",
      size: 3,
    });
  });
});

describe("refusals", () => {
  const ok = writeProof(D, { att: [ATT.bitcoin(1)] });
  it("knows a good small proof", () => {
    expect(kind(ok)).toBe("ok");
  });

  it("is not a proof", () => {
    expect(kind(new Uint8Array())).toBe("not-proof");
    expect(kind(new TextEncoder().encode("Hello World!\n"))).toBe("not-proof");
    expect(kind(new Uint8Array([...MAGIC.subarray(0, 30), 0]))).toBe("not-proof");
  });

  it("names a version it does not read", () => {
    expect(kind(writeProof(D, { att: [ATT.bitcoin(1)] }, 2))).toBe("version");
    expect(kind(writeProof(D, { att: [ATT.bitcoin(1)] }, 0))).toBe("version");
  });

  it("names an operation it does not know", () => {
    expect(kind(writeProof(D, { ops: [[[0x55], { att: [ATT.bitcoin(1)] }]] }))).toBe("unknown-op");
    expect(kind(writeProof(D, { att: [ATT.bitcoin(1)] }, 1, 0x09))).toBe("unknown-op");
  });

  it("refuses what is past its bounds", () => {
    // An argument longer than the format allows, and a length that runs past the end.
    expect(kind(writeProof(D, chain([OP.append(new Uint8Array(4097))], ATT.bitcoin(1))))).toBe(
      "too-large",
    );
    const huge = new Uint8Array([...MAGIC, 1, 0x08, ...D, 0xf0, ...varuint(4000), 1, 2]);
    expect(kind(huge)).toBe("truncated");
    // A number of more than 32 bits.
    expect(kind(new Uint8Array([...MAGIC, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))).toBe("too-large");
    // A message grown past 4,096 bytes by appends that are each allowed.
    const grow = Array.from({ length: 3 }, () => OP.append(new Uint8Array(2000)));
    expect(kind(writeProof(D, chain(grow, ATT.bitcoin(1))))).toBe("too-large");
    expect(
      kind(
        writeProof(
          new Uint8Array(32),
          chain([OP.append(new Uint8Array(2017)), OP.hexlify], ATT.bitcoin(1)),
        ),
      ),
    ).toBe("too-large");
    // Deeper than the bound.
    const deep = Array.from({ length: LIMITS.depth + 1 }, () => OP.sha256);
    expect(kind(writeProof(D, chain(deep, ATT.bitcoin(1))))).toBe("too-large");
    // A file larger than any proof.
    expect(kind(new Uint8Array(LIMITS.proofBytes + 1))).toBe("too-large");
    // More attestations than the bound.
    const many = { att: Array.from({ length: LIMITS.attestations + 1 }, (_, i) => ATT.bitcoin(i)) };
    expect(kind(writeProof(D, many))).toBe("too-large");
  });

  it("refuses broken pieces", () => {
    expect(kind(new Uint8Array([...ok, 0]))).toBe("malformed");
    expect(kind(writeProof(D, { att: [ATT.pending("https://a.example/<script>")] }))).toBe(
      "malformed",
    );
    const extra = [...(fromHex("0588960d73d71901") ?? []), ...varbytes([1, 2])];
    expect(kind(writeProof(D, { att: [extra] }))).toBe("malformed");
  });

  it("keeps a stamp's forks in order and needs an item after a fork byte", () => {
    const bytes = new Uint8Array([...MAGIC, 1, 0x08, ...D, 0xff]);
    expect(kind(bytes)).toBe("truncated");
    expect(writeStamp({ att: [[1], [2]] })).toStrictEqual([0xff, 0, 1, 0, 2]);
  });
});

describe("empty arguments (review round 1, T5)", () => {
  // The real proof with an append or a prepend of nothing put in front of its tree.
  const withEmpty = (tag: number) => {
    const b = fixture("two-blocks");
    const at = MAGIC.length + 2 + 32;
    return new Uint8Array([...b.subarray(0, at), tag, 0x00, ...b.subarray(at)]);
  };
  it("refuses an empty append or prepend as a damaged proof", () => {
    expect(kind(withEmpty(0xf0))).toBe("malformed");
    expect(kind(withEmpty(0xf1))).toBe("malformed");
    // One byte is enough.
    expect(kind(writeProof(D, chain([OP.append([0])], ATT.bitcoin(1))))).toBe("ok");
  });
});
