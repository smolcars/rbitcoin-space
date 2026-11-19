import { describe, expect, it } from "vitest";
import { fingerprint, steady } from "./steady";

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

describe("fingerprint", () => {
  it("is the same for the same content and differs with any of it", () => {
    expect(fingerprint(row("a"))).toBe(fingerprint(row("a")));
    expect(fingerprint(row("a"))).not.toBe(fingerprint(row("a", { fee: 0 })));
    expect(fingerprint(undefined)).toBe(fingerprint(undefined));
  });
});
