import { describe, expect, it } from "vitest";
import { sameContent, steady } from "./steady";

interface Row {
  id: string;
  fee?: number;
  pruned?: boolean;
  parts: { value: number }[];
}
const row = (id: string, over: Partial<Row> = {}): Row => ({ id, parts: [{ value: 1 }], ...over });

describe("steady", () => {
  it("hands back the object it holds for an item that is the same in every field", () => {
    const keep = steady<Row>((r) => r.id);
    const [a, b] = keep([row("a"), row("b")]);
    // The same content, parsed anew: the objects held come back, in the answer's order.
    const again = keep([row("b"), row("c"), row("a")]);
    expect(again[0]).toBe(b);
    expect(again[2]).toBe(a);
    expect(again[1]).toStrictEqual(row("c"));
  });

  it("takes the new object when anything in it changed, however deep", () => {
    const keep = steady<Row>((r) => r.id);
    const [a] = keep([row("a", { fee: 100 })]);
    // The node no longer has its inputs: the same id, another answer.
    const [pruned] = keep([row("a", { pruned: true })]);
    expect(pruned).not.toBe(a);
    expect(pruned?.pruned).toBe(true);
    const [deep] = keep([row("a", { pruned: true, parts: [{ value: 2 }] })]);
    expect(deep).not.toBe(pruned);
    expect(deep?.parts[0]?.value).toBe(2);
  });

  it("holds only the last answer's items", () => {
    const keep = steady<Row>((r) => r.id);
    const [a] = keep([row("a")]);
    keep([row("b")]);
    // Gone for an answer, it is a new object when it comes back.
    expect(keep([row("a")])[0]).not.toBe(a);
  });
});

describe("sameContent", () => {
  it("is exact: the same in every field, or not the same", () => {
    expect(sameContent(row("a"), row("a"))).toBe(true);
    expect(sameContent(row("a"), row("a", { fee: 0 }))).toBe(false);
    expect(sameContent(row("a", { fee: 0 }), row("a"))).toBe(false);
    expect(sameContent({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(sameContent({ a: [1, { b: null }] }, { a: [1, { b: 0 }] })).toBe(false);
    expect(sameContent([1, 2], [1, 2, 3])).toBe(false);
    expect(sameContent([], {})).toBe(false);
    expect(sameContent(null, {})).toBe(false);
    // The order a server wrote an object's fields in is not content.
    expect(sameContent({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("tells apart two answers a short digest took for one another", () => {
    // Found in review: an output reconfirmed one block later, whose two answers shared a length
    // and a 32-bit hash.
    const at = (height: number, hash: string, time: number) => ({
      txid: "ab".repeat(32),
      vout: 0,
      value: 5000,
      status: { confirmed: true, block_height: height, block_hash: hash, block_time: time },
    });
    const keep = steady<ReturnType<typeof at>>((u) => `${u.txid}:${u.vout}`);
    const [first] = keep([at(900_100, "11".repeat(32), 1_700_000_000)]);
    const [second] = keep([at(900_101, "22".repeat(32), 1_700_000_600)]);
    expect(second).not.toBe(first);
    expect(second?.status.block_height).toBe(900_101);
  });
});

describe("steady, on pages already held", () => {
  it("takes the very object it holds without comparing it", () => {
    const keep = steady<Row>((r) => r.id);
    const old = row("a");
    keep([old]);
    // A getter that would throw if the content were read again.
    let reads = 0;
    Object.defineProperty(old, "fee", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    expect(keep([old])[0]).toBe(old);
    expect(reads).toBe(0);
  });
});
