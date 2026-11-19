import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../../lib/api";
import { FakeSocket } from "../../lib/fakes";
import { mount } from "../../components/test-utils";
import { Chain, leftWithParent } from "./Live";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const X = "d".repeat(64);
const version = (txid: string) => ({
  txid,
  fee: 500,
  vsize: 200,
  value: 1000,
  rate: 2500,
  inputs: 1,
  outputs: { state: "not_recorded" },
});

let asked: string[] = [];
beforeEach(() => {
  clearApiCache();
  asked = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const [a = "", b = ""] = (url.split("/app/tx/")[1] ?? "").split("/compare/");
    asked.push(`${a.slice(0, 1)}${b.slice(0, 1)}`);
    return Response.json({ a: version(a), b: version(b), shared_inputs: null });
  });
  // The newest version's live state is not this test's.
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const settled = async (check: () => void) => {
  await vi.waitFor(() => {
    flush();
    check();
  });
};

describe("Chain", () => {
  it("compares a version with what replaced it, not with a sibling next in the line", async () => {
    // C spends a coin of A's and one of B's, so it replaced both: the line is A, B, C.
    mount(() => <Chain chain={[{ txid: A, by: C }]} truncated={false} versions={[A, B, C]} />);
    await settled(() => expect(asked).toStrictEqual(["ac"]));
  });

  it("keeps the links' buttons and the pickers on one pair", async () => {
    const el = mount(() => (
      <Chain
        chain={[
          { txid: A, by: B },
          { txid: B, by: C },
        ]}
        truncated={false}
        versions={[A, B, C]}
      />
    ));
    await settled(() => expect(asked).toStrictEqual(["ab"]));
    const [first, second] = [...el.querySelectorAll<HTMLButtonElement>(".tx-chain__compare")];
    expect(first?.getAttribute("aria-pressed")).toBe("true");
    // Pick C as the second version: the A → B button is no longer the pair shown.
    const to = el.querySelectorAll("select")[1];
    if (!(to instanceof HTMLSelectElement)) throw new TypeError("no picker");
    to.value = "2";
    to.dispatchEvent(new Event("change"));
    await settled(() => expect(asked.at(-1)).toBe("ac"));
    expect(first?.getAttribute("aria-pressed")).toBe("false");
    expect(second?.getAttribute("aria-pressed")).toBe("false");
    // Pressing it shows A → B again, and the picker follows.
    first?.click();
    await settled(() => expect(asked.at(-1)).toBe("ab"));
    expect(first?.getAttribute("aria-pressed")).toBe("true");
    expect((el.querySelectorAll("select")[1] as HTMLSelectElement).value).toBe("1");
  });

  it("offers nothing to compare until the route has said which links are versions'", async () => {
    const el = mount(() => <Chain chain={[{ txid: A, by: B }]} truncated={false} />);
    await settled(() => expect(el.querySelector(".tx-chain__list")).not.toBeNull());
    expect(el.querySelector(".tx-compare")).toBeNull();
    expect(el.querySelector(".tx-chain__compare")).toBeNull();
    expect(asked).toStrictEqual([]);
  });

  it("still compares a child with what it bumped, and never with what replaced its parent", async () => {
    // A bumped to B; then Q replaced B's parent and removed B. B's line is A and B.
    const Q = "f".repeat(64);
    const el = mount(() => (
      <Chain
        chain={[{ txid: B, by: Q }]}
        truncated={false}
        later={[{ txid: B, by: Q, shared: 0 }]}
        versions={[A, B]}
      />
    ));
    await settled(() => expect(asked).toStrictEqual(["ab"]));
    expect(el.textContent).toContain("not replaced by a new version");
    expect(el.querySelector(".tx-chain__compare")).toBeNull();
  });

  it("offers no comparison on a child that left with its replaced parent", async () => {
    // X left when B replaced its parent; then C replaced B. X is no version of B or C.
    const el = mount(() => (
      <Chain
        chain={[
          { txid: X, by: B },
          { txid: B, by: C },
        ]}
        truncated={false}
        later={[{ txid: X, by: B, shared: 0 }]}
        versions={[]}
      />
    ));
    await settled(() => expect(el.textContent).toContain("not replaced by a new version"));
    expect(el.querySelector(".tx-compare")).toBeNull();
    expect(el.querySelector(".tx-chain__compare")).toBeNull();
    expect(asked).toStrictEqual([]);
  });

  it("says of each link what that link is, and of a line with a child in it nothing as versions", async () => {
    // C spent from P, which spent from S: Q bumped P (C left with it), then R replaced S (Q left).
    const el = mount(() => (
      <Chain
        chain={[
          { txid: A, by: B },
          { txid: B, by: C },
        ]}
        truncated={false}
        versions={[]}
        later={[
          { txid: A, by: B, shared: 0 },
          { txid: B, by: C, shared: 0 },
        ]}
      />
    ));
    await settled(() => expect(el.textContent).toContain("the newest in this line."));
    const rows = [...el.querySelectorAll(".tx-chain__link")].map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("This transaction");
    expect(rows[0]).toContain("replaced a transaction it depended on");
    expect(rows[1]).toContain("replaced a transaction it depended on");
    expect(rows.join(" ")).not.toContain("replaced by");
    expect(el.textContent).not.toContain("It was replaced 2 times");
    expect(el.textContent).not.toContain("the newest version");
  });
});

describe("leftWithParent", () => {
  it("takes the route's word only for the link it is about", () => {
    const said = [{ txid: A, by: B, shared: 0 }];
    expect(leftWithParent({ txid: A, by: B }, said)).toBe(true);
    // It came back and was replaced again, by a new version of itself: another link.
    expect(leftWithParent({ txid: A, by: C }, said)).toBe(false);
    // Shared inputs not recorded, or shared: a version's link, as before.
    expect(leftWithParent({ txid: A, by: B }, [{ txid: A, by: B }])).toBe(false);
    expect(leftWithParent({ txid: A, by: B }, [{ txid: A, by: B, shared: 1 }])).toBe(false);
    // Nothing asked yet, or no link shown.
    expect(leftWithParent({ txid: A, by: B }, undefined)).toBe(false);
    expect(leftWithParent(undefined, said)).toBe(false);
  });
});
