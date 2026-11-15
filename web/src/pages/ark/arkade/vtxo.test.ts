import { describe, expect, it } from "vitest";
import { paths } from "../../../lib/network";
import { type Dot, layout } from "./layout";
import { A, answer, B1, C, K, L1, L2, NOW, R } from "./testdata";
import {
  badges,
  describeCounts,
  exitCounts,
  exitSteps,
  lifeShare,
  parseOutpoint,
  readAnswer,
  rough,
  timeLeft,
  type VtxoAnswer,
} from "./vtxo";

/** The one item a test expects to be there. */
function there<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("missing");
  return x;
}

describe("reading the answer", () => {
  it("takes what the server sends", () => {
    expect(readAnswer(structuredClone(answer()))).toBeDefined();
  });

  it("refuses anything that is not what the server sends", () => {
    const cases: ((a: VtxoAnswer) => void)[] = [
      (a) => Object.assign(a.vtxo, { txid: "<img src=x onerror=alert(1)>" }),
      (a) => Object.assign(a.vtxo, { script: "<script>" }),
      (a) => Object.assign(a.vtxo, { amount: -1 }),
      (a) => Object.assign(a.vtxo, { amount: 1.5 }),
      (a) => Object.assign(a.vtxo, { vout: 2 ** 32 }),
      (a) => Object.assign(a.chain[0] ?? {}, { kind: "<b>" }),
      (a) => Object.assign(a.chain[0] ?? {}, { spends: [C.toUpperCase()] }),
      (a) => {
        a.chain = Array.from({ length: 129 }, () => there(a.chain[0]));
        a.onchain = a.chain.map(() => null);
      },
      (a) => {
        a.onchain.pop();
      },
      (a) => {
        a.onchain[0] = { state: "confirmed", height: -1 };
      },
      (a) =>
        Object.assign(a.batches[0] ?? {}, {
          tree: Array.from({ length: 513 }, () => ({ txid: C, children: [] })),
        }),
      (a) => Object.assign(a.server, { signer_pubkey: "zz" }),
      (a) => Reflect.deleteProperty(a, "chain_complete"),
    ];
    for (const change of cases) {
      const a = structuredClone(answer());
      change(a);
      expect(readAnswer(a)).toBeUndefined();
    }
    expect(readAnswer(null)).toBeUndefined();
    expect(readAnswer([])).toBeUndefined();
  });
});

describe("outpoints", () => {
  it("are txid:vout, strictly", () => {
    expect(parseOutpoint(`${A}:0`)).toStrictEqual({ txid: A, vout: 0 });
    expect(parseOutpoint(`${A.toUpperCase()}:4294967295`)).toStrictEqual({
      txid: A,
      vout: 4_294_967_295,
    });
    for (const bad of [
      "",
      A,
      `${A}:`,
      `${A}:01`,
      `${A}:-1`,
      `${A}:4294967296`,
      `${A}:0 `,
      ` ${A}:0`,
      `${A.slice(1)}:0`,
      `${A}:0:0`,
      `${A}%3A0`,
    ]) {
      expect(parseOutpoint(bad)).toBeUndefined();
    }
  });

  it("are what the entry page leads to", () => {
    expect(paths.arkadeVtxo(`${A}:3`)).toBe(`/ark/arkade/vtxo/${A}:3`);
    expect(parseOutpoint(`${A}:3`)).toStrictEqual({ txid: A, vout: 3 });
  });
});

describe("the exit", () => {
  it("goes in broadcast order, each kind in our words and Arkade's", () => {
    const steps = exitSteps(answer());
    expect(steps.map((s) => [s.txid, s.n, s.name, s.term])).toStrictEqual([
      [C, 0, "Commitment", undefined],
      [R, 1, "Branch", "tree"],
      [B1, 2, "Branch", "tree"],
      [L1, 3, "Leaf", "tree"],
      [K, 4, "Checkpoint", undefined],
      [A, 5, "Transfer", "ark"],
    ]);
    expect(steps.filter((s) => s.mine).map((s) => s.txid)).toStrictEqual([A]);
    const counts = exitCounts(steps);
    expect(counts.total).toBe(5);
    expect(describeCounts(counts)).toBe("3 tree, 1 checkpoint, 1 transfer");
  });

  it("holds a chain that spends in a circle without looping", () => {
    const a = answer();
    a.chain[1] = { ...there(a.chain[1]), spends: [A] };
    expect(exitSteps(a)).toHaveLength(6);
  });

  it("finds a leaf from the chain when the tree was too large to send", () => {
    const a = answer();
    there(a.batches[0]).tree = null;
    expect(exitSteps(a).find((s) => s.txid === L1)?.name).toBe("Leaf");
    expect(exitSteps(a).find((s) => s.txid === B1)?.name).toBe("Branch");
  });
});

describe("badges", () => {
  const words = (a = answer(), now = NOW) => badges(a, exitSteps(a), now).map((b) => b.word);

  it("say what arkd reports, in a word each", () => {
    expect(words()).toStrictEqual(["Unspent", "Not settled yet"]);
    const settled = answer();
    settled.vtxo.preconfirmed = false;
    expect(words(settled)).toStrictEqual(["Unspent"]);
    const swept = answer();
    swept.vtxo.swept = true;
    expect(words(swept)).toStrictEqual(["Swept"]);
    const spent = answer();
    spent.vtxo.spent = true;
    expect(words(spent)).toStrictEqual(["Spent"]);
  });

  it("warn near expiry, and say when the exit is on our chain", () => {
    expect(words(answer(), answer().vtxo.expires_at - 3600)).toContain("Expires soon");
    const out = answer();
    out.onchain[4] = { state: "mempool" };
    expect(words(out)).toContain("Exiting");
    const unrolled = answer();
    unrolled.vtxo.unrolled = true;
    expect(words(unrolled)).toContain("Exiting");
  });
});

describe("times", () => {
  it("read roughly", () => {
    expect(rough(172_544)).toBe("~2 days");
    expect(rough(605_184)).toBe("~7 days");
    expect(rough(86_400)).toBe("~1 day");
    expect(rough(3600)).toBe("~1 h");
    expect(rough(600)).toBe("~10 min");
    expect(timeLeft(22 * 86_400 + 5)).toStrictEqual([22, "days"]);
    expect(timeLeft(90_000)).toStrictEqual([1, "day"]);
    expect(timeLeft(7200)).toStrictEqual([2, "h"]);
  });

  it("place now on the lifetime", () => {
    const a = answer();
    expect(lifeShare(a, NOW)).toBeCloseTo(8 / 30, 5);
    expect(lifeShare(a, NOW + 100 * 86_400)).toBe(1);
    expect(lifeShare(a, 0)).toBe(0);
  });
});

describe("the picture", () => {
  it("grows the whole tree from its commitment, this VTXO above it", () => {
    const a = answer();
    const s = layout(a, exitSteps(a), 1000, NOW);
    const at = (id: string): Dot => there(s.dots.find((d) => d.id === id));
    // Every tree transaction drawn, and the anchor on the line under the root.
    expect(s.dots.filter((d) => d.kind !== "anchor")).toHaveLength(9);
    const anchor = s.dots.find((d) => d.kind === "anchor");
    expect(anchor?.y).toBe(s.lineY);
    expect(anchor?.x).toBeCloseTo(at(R).x, 5);
    expect(at(R).y).toBeGreaterThan(at(B1).y);
    expect(at(B1).y).toBeGreaterThan(at(L1).y);
    expect(at(L1).y).toBeGreaterThan(at(K).y);
    expect(at(K).y).toBeGreaterThan(at(A).y);
    expect(s.me?.id).toBe(A);
    expect(at(L2).kind).toBe("leaf");
    // Lit: anchor to root, root to B1, B1 to L1, L1 to K, K to A.
    expect(s.links.filter((l) => l.mine)).toHaveLength(5);
    for (const d of s.dots) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(1000);
      expect(d.y).toBeGreaterThan(0);
      expect(d.y).toBeLessThanOrEqual(s.height);
    }
    expect(s.axis.now).toBeGreaterThan(s.axis.commitment);
    expect(s.axis.now).toBeLessThan(s.axis.end);
  });

  it("draws only this VTXO's branch when the tree was too large to send", () => {
    const a = answer();
    there(a.batches[0]).tree = null;
    const s = layout(a, exitSteps(a), 360, NOW);
    expect(s.compact).toBe(true);
    expect(s.dots.filter((d) => d.kind === "leaf" || d.kind === "other")).toHaveLength(0);
    expect(s.dots.filter((d) => d.kind === "mine")).toHaveLength(5);
  });
});
