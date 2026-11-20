// The parser against hostile input: random bytes, and real proofs cut, flipped, given huge
// lengths and nested deep. It may only ever throw its own `ProofError`, and never work long.
import { describe, expect, it } from "vitest";
import { cost } from "../../lib/cost";
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

describe("fuzzing the proof reader", () => {
  it("throws only its own errors on random bytes and mutated proofs, and is quick on each", () => {
    const r = random(20_261_120);
    const counts: Record<string, number> = {};
    let slowest = 0;
    const RANDOM = 20_000;
    const MUTATED = 30_000;
    const { ms } = cost(() => {
      for (let i = 0; i < RANDOM + MUTATED; i++) {
        let bytes: Uint8Array;
        if (i < RANDOM) {
          // Random bytes, half of them behind a real header so the reader gets past the magic.
          const body = Uint8Array.from({ length: Math.floor(r() * 400) }, () =>
            Math.floor(r() * 256),
          );
          bytes = r() < 0.5 ? body : new Uint8Array([...MAGIC, 1, 0x08, ...body]);
        } else {
          bytes = mutate(r, SEEDS[i % SEEDS.length] ?? new Uint8Array());
        }
        const t = performance.now();
        const outcome = attempt(bytes);
        slowest = Math.max(slowest, performance.now() - t);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
    });
    // The generator is seeded, so how the 50,000 inputs end is fixed: the record of this run.
    expect(counts).toStrictEqual({
      "not-proof": 10_105,
      "unknown-op": 22_458,
      malformed: 5428,
      ok: 4701,
      "too-large": 657,
      truncated: 6589,
      version: 62,
    });
    expect(slowest).toBeLessThan(250);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(RANDOM + MUTATED);
    expect(counts["truncated"]).toBeGreaterThan(0);
    expect(counts["malformed"]).toBeGreaterThan(0);
    expect(counts["ok"]).toBeGreaterThan(0);
    // Generous: about 2 s of processor time here; a slow machine has room.
    expect(ms).toBeLessThan(30_000);
  });

  it("bounds the worst work a proof can ask for", () => {
    // The most hashing per byte of proof: seven hex steps grow 32 bytes to 4,096, then SHA-256
    // takes all of them back to 32, over and over: ten branches as deep as allowed, which together
    // come near the bound on operations.
    const hex7 = Array.from({ length: 7 }, () => 0xf3);
    const cycles = Math.floor((LIMITS.depth - hex7.length) / 8);
    const branch = (n: number) => [
      ...Array.from({ length: n }, () => [0x08, ...hex7]).flat(),
      0x00,
      ...ATT.bitcoin(1),
    ];
    const tree = (n: number) => [
      ...hex7,
      ...Array.from({ length: 9 }, () => [0xff, ...branch(n)]).flat(),
      ...branch(n),
    ];
    const proof = (n: number) =>
      new Uint8Array([...MAGIC, 1, 0x08, ...new Uint8Array(32), ...tree(n)]);
    const bytes = proof(cycles);
    const { value, ms } = cost(() => attempt(bytes));
    // 9,927 operations hashing 38.75 MiB: about 120 ms of processor time here.
    expect(80 * cycles * 4096).toBe(40_632_320);
    expect(value).toBe("ok");
    expect(ms).toBeLessThan(5000);
    // A little deeper is refused before anything is played.
    expect(attempt(proof(cycles + 1))).toBe("too-large");
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
