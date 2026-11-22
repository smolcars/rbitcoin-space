// The parser against hostile input: random bytes, and real proofs cut, flipped, given huge
// lengths and nested deep. It may only ever throw its own `ProofError`, and never work long.
import { describe, expect, it } from "vitest";
import { BENCH, budget } from "../../lib/budget";
import { LIMITS, MAGIC, parseProof, ProofError, walk } from "./ots";
import { ATT, fixture, varuint } from "./testdata";

/** A small seeded generator (mulberry32), so a failure can be run again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Outcome = "ok" | ProofError["kind"];

/** Reads and plays one input; anything thrown but a `ProofError` fails the test. */
function attempt(bytes: Uint8Array): Outcome {
  try {
    walk(parseProof(bytes));
    return "ok";
  } catch (e) {
    if (e instanceof ProofError) return e.kind;
    throw new Error(`threw on ${[...bytes.subarray(0, 64)].join(",")}`, { cause: e });
  }
}

const SEEDS = [fixture("two-blocks"), fixture("pending")];

/** One mutation of a real proof, chosen by `r`. */
function mutate(r: () => number, base: Uint8Array): Uint8Array {
  const pick = Math.floor(r() * 6);
  const at = MAGIC.length + Math.floor(r() * (base.length - MAGIC.length));
  const b = new Uint8Array(base);
  switch (pick) {
    case 0: {
      return b.subarray(0, at);
    }
    case 1: {
      for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++) {
        const j = MAGIC.length + Math.floor(r() * (b.length - MAGIC.length));
        b[j] = (b[j] ?? 0) ^ (1 << Math.floor(r() * 8));
      }
      return b;
    }
    case 2: {
      // A huge length where one may be read: the largest varuint, then the rest.
      return new Uint8Array([
        ...b.subarray(0, at),
        0xff,
        0xff,
        0xff,
        0xff,
        0x0f,
        ...b.subarray(at),
      ]);
    }
    case 3: {
      // A random byte in, or one out.
      return r() < 0.5
        ? new Uint8Array([...b.subarray(0, at), Math.floor(r() * 256), ...b.subarray(at)])
        : new Uint8Array([...b.subarray(0, at), ...b.subarray(at + 1)]);
    }
    case 4: {
      // A run of fork bytes and operations, as deep nesting would be.
      const run = Array.from({ length: Math.floor(r() * 3000) }, () => (r() < 0.5 ? 0xff : 0x08));
      return new Uint8Array([...b.subarray(0, at), ...run, ...b.subarray(at)]);
    }
    default: {
      // A block of the proof repeated.
      const len = Math.floor(r() * 64);
      const piece = b.subarray(at, at + len);
      return new Uint8Array([...b.subarray(0, at), ...piece, ...piece, ...b.subarray(at)]);
    }
  }
}

/*
 * The suite plays a tenth as many inputs (its own 5,000, not a part of the long form's), and holds
 * how each one ends. The long form plays 50,000, and every input is held to its speed budget
 * (lib/budget.ts) only on request, since a speed budget is a benchmark and 50,000 inputs take
 * longer than a unit test may on a slow machine (docs/CI.md "Rules for tests"):
 * `BENCH=1 bunx vitest run src/pages/timestamp/fuzz.test.ts`
 */

/** Plays random bytes and mutated proofs from one seed: how many inputs ended each way. */
function fuzz(randomInputs: number, mutatedInputs: number) {
  const r = random(20_261_120);
  const counts: Record<string, number> = {};
  for (let i = 0; i < randomInputs + mutatedInputs; i++) {
    let bytes: Uint8Array;
    if (i < randomInputs) {
      // Random bytes, half of them behind a real header so the reader gets past the magic.
      const body = Uint8Array.from({ length: Math.floor(r() * 400) }, () => Math.floor(r() * 256));
      bytes = r() < 0.5 ? body : new Uint8Array([...MAGIC, 1, 0x08, ...body]);
    } else {
      bytes = mutate(r, SEEDS[i % SEEDS.length] ?? new Uint8Array());
    }
    // Generous: under 2 ms of processor time each here.
    const outcome = budget(250, () => attempt(bytes));
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

describe("fuzzing the proof reader", () => {
  it("throws only its own errors on random bytes and mutated proofs", () => {
    const counts = fuzz(2_000, 3_000);
    // The generator is seeded, so how the 5,000 inputs end is fixed: the record of this run.
    expect(counts).toStrictEqual({
      "not-proof": 1022,
      "unknown-op": 2298,
      malformed: 559,
      ok: 472,
      "too-large": 40,
      truncated: 605,
      version: 4,
    });
    expect(counts["truncated"]).toBeGreaterThan(0);
    expect(counts["malformed"]).toBeGreaterThan(0);
    expect(counts["ok"]).toBeGreaterThan(0);
  });

  it.skipIf(!BENCH)(
    "the long form: 50,000 inputs, each quick",
    () => {
      // About 2 s in all here.
      const counts = budget(30_000, () => fuzz(20_000, 30_000));
      expect(counts).toStrictEqual({
        "not-proof": 10_105,
        "unknown-op": 22_425,
        malformed: 5461,
        ok: 4701,
        "too-large": 657,
        truncated: 6589,
        version: 62,
      });
    },
    120_000,
  );

  it("bounds the worst work a proof can ask for", () => {
    // The most hashing per byte of proof: seven hex steps grow 32 bytes to 4,096, then SHA-256
    // takes all of them back to 32, over and over, in ten branches. `n` rounds a branch hash
    // 10 × n × 4,096 bytes.
    const hex7 = Array.from({ length: 7 }, () => 0xf3);
    const branch = (n: number) => [
      ...Array.from({ length: n }, () => [0x08, ...hex7]).flat(),
      0x00,
      ...ATT.bitcoin(1),
    ];
    const proof = (n: number) =>
      new Uint8Array([
        ...MAGIC,
        1,
        0x08,
        ...new Uint8Array(32),
        ...hex7,
        ...Array.from({ length: 9 }, () => [0xff, ...branch(n)]).flat(),
        ...branch(n),
      ]);
    // The most rounds the work bound allows: 4,177,920 bytes, 99.6% of it.
    const most = Math.floor(LIMITS.work / (10 * 4096));
    const stats = { hashed: 0 };
    // A quarter to a third of a second of processor time on the dev machine.
    const value = budget(2000, () => walk(parseProof(proof(most)), undefined, stats).length);
    expect({ rounds: most, hashed: stats.hashed, leaves: value }).toStrictEqual({
      rounds: 102,
      hashed: 4_177_920,
      leaves: 10,
    });
    // One round more in every branch is refused by the work bound, partway through.
    let refused: unknown;
    try {
      walk(parseProof(proof(most + 1)));
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(ProofError);
    expect((refused as ProofError).kind).toBe("too-large");
    expect((refused as ProofError).message).toMatch(/hashing/);
    // With the depth allowed, rounds that would hash 4.84 MiB are refused the same way.
    expect(attempt(proof(124))).toBe("too-large");
  });

  it("follows the deepest path it allows and refuses one deeper, without recursing", () => {
    // Written out flat: n SHA-256 steps, then the attestation.
    const deep = (n: number) =>
      new Uint8Array([
        ...MAGIC,
        1,
        0x08,
        ...new Uint8Array(32),
        ...new Uint8Array(n).fill(0x08),
        0x00,
        ...ATT.bitcoin(1),
      ]);
    expect(attempt(deep(LIMITS.depth))).toBe("ok");
    expect(attempt(deep(LIMITS.depth + 1))).toBe("too-large");
    // Far past any stack: refused by the bound, never a stack overflow.
    expect(attempt(deep(200_000))).toBe("too-large");
    // A run of fork bytes: a fork byte where an item's tag belongs is no operation.
    expect(
      attempt(
        new Uint8Array([
          ...MAGIC,
          1,
          0x08,
          ...new Uint8Array(32),
          ...new Uint8Array(LIMITS.proofBytes - 100).fill(0xff),
        ]),
      ),
    ).toBe("unknown-op");
    expect(varuint(300)).toStrictEqual([0xac, 0x02]);
  });
});

describe("the work bound, exactly (review round 2, T15)", () => {
  // Rounds of a hash of 4,096 bytes then seven hex steps, in branches of at most 124 rounds (the
  // depth bound), the rounds split as given.
  const hex7 = Array.from({ length: 7 }, () => 0xf3);
  const branch = (op: number, n: number) => [
    ...Array.from({ length: n }, () => [op, ...hex7]).flat(),
    0x00,
    ...ATT.bitcoin(1),
  ];
  /** The branches in the file's form: a fork byte before each but the last. */
  const forks = (op: number, rounds: number[]): number[] => {
    const out: number[] = [];
    rounds.forEach((n, i) => {
      if (i < rounds.length - 1) out.push(0xff);
      out.push(...branch(op, n));
    });
    return out;
  };
  const proof = (op: number, rounds: number[]) =>
    new Uint8Array([...MAGIC, 1, 0x08, ...new Uint8Array(32), ...hex7, ...forks(op, rounds)]);
  // 1,024 hashes of 4,096 bytes is the bound itself: 8 branches of 124 and one of 32.
  const exact = [...Array.from({ length: 8 }, () => 124), 32];

  it("accepts the bound itself and refuses one hash more, counting only what was hashed", () => {
    const stats = { hashed: 0 };
    walk(parseProof(proof(0x08, exact)), undefined, stats);
    expect(stats.hashed).toBe(LIMITS.work);
    const over = { hashed: 0 };
    expect(() =>
      walk(parseProof(proof(0x08, [...exact.slice(0, -1), 33])), undefined, over),
    ).toThrow(ProofError);
    expect(over.hashed).toBe(LIMITS.work);
  });

  it("plays the bound in Keccak-256, the slowest hash, within its budget", () => {
    const stats = { hashed: 0 };
    // About 0.3 s on the dev machine (docs/FRONTEND.md "Timestamp proofs").
    budget(2000, () => walk(parseProof(proof(0x67, exact)), undefined, stats));
    expect(stats.hashed).toBe(LIMITS.work);
  });
});
