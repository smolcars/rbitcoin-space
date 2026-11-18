import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../../lib/api";
import { mount } from "../../components/test-utils";
import { Compare } from "./Compare";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const SHOP = `0014${"11".repeat(20)}`;
const CHANGE = `0014${"22".repeat(20)}`;

const version = (txid: string, fee: number, outputs: unknown) => ({
  txid,
  fee,
  vsize: 200,
  weight: 800,
  value: 150_000,
  rate: fee * 5,
  inputs: 2,
  from: "record",
  outputs,
});

let asked: string[] = [];
let answers: Record<string, unknown> = {};

beforeEach(() => {
  clearApiCache();
  asked = [];
  answers = {
    [`${A}/${B}`]: {
      a: version(A, 500, {
        state: "kept",
        list: [
          { value: 50_000, script: SHOP, address: "bcrt1qshop" },
          { value: 100_000, script: CHANGE, address: "bcrt1qchange" },
        ],
      }),
      b: version(B, 900, {
        state: "kept",
        list: [
          { value: 99_600, script: CHANGE, address: "bcrt1qchange" },
          { value: 0, script_len: 83, script_hash: "ab".repeat(16) },
        ],
      }),
      shared_inputs: 2,
    },
    [`${A}/${C}`]: {
      a: version(A, 500, { state: "not_recorded" }),
      b: version(C, 1200, { state: "too_many", count: 40 }),
      shared_inputs: null,
    },
  };
  vi.stubGlobal("fetch", async (url: string) => {
    const pair = url.split("/app/tx/")[1]?.replace("/compare/", "/") ?? "";
    asked.push(pair);
    const body = answers[pair];
    return body === undefined
      ? Response.json({ error: "not found" }, { status: 404 })
      : Response.json(body);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const text = (el: HTMLElement) => el.textContent?.replaceAll(/\s+/g, " ") ?? "";

describe("Compare", () => {
  it("shows the figures side by side and each output's change in words", async () => {
    const el = mount(() => <Compare versions={[A, B, C]} from={0} to={1} here={A} />);
    await vi.waitFor(() => {
      flush();
      expect(el.querySelector(".tx-compare__outputs")).not.toBeNull();
    });
    expect(asked).toStrictEqual([`${A}/${B}`]);
    const t = text(el);
    expect(t).toContain("Version 1, this page");
    expect(t).toContain("+400 sats");
    // Kept, changed, added and removed each say so in a word, not only a style.
    const rows = [...el.querySelectorAll(".tx-compare__out")].map(
      (r) => r.querySelector(".tx-compare__kind")?.textContent,
    );
    expect(rows).toStrictEqual(["≠Changed", "+Added", "−Removed"]);
    expect(t).toContain("was 0.00100000 BTC");
    expect(t).toContain("Script of 83 bytes");
    expect(t).toContain("2 kept");
    expect(t).not.toContain("dropped");
    // The removed output pays the shop: named by its address, as text.
    const removed = el.querySelector(".tx-compare__out--removed");
    expect(removed?.textContent).toContain("bcrt1qshop");
    expect(removed?.querySelector(".tx-compare__struck")).not.toBeNull();
  });

  it("says which inputs changed even when their number did not", async () => {
    answers[`${A}/${B}`] = { ...(answers[`${A}/${B}`] as object), shared_inputs: 1 };
    const el = mount(() => <Compare versions={[A, B]} from={0} to={1} here={A} />);
    await vi.waitFor(() => {
      flush();
      expect(text(el)).toContain("1 kept, 1 dropped, 1 new");
    });
  });

  it("compares any two, and says when outputs are missing or too many", async () => {
    const el = mount(() => <Compare versions={[A, B, C]} from={0} to={1} here={A} />);
    await vi.waitFor(() => {
      flush();
      expect(el.querySelector(".tx-compare__outputs")).not.toBeNull();
    });
    const to = el.querySelectorAll("select")[1];
    if (!(to instanceof HTMLSelectElement)) throw new TypeError("no picker");
    to.value = "2";
    to.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      flush();
      expect(text(el)).toContain("did not record the outputs of Version 1, this page");
    });
    expect(asked).toContain(`${A}/${C}`);
    expect(text(el)).toContain("Fee");
  });

  it("names a child that left with its parent instead of comparing it", async () => {
    answers[`${A}/${B}`] = { ...(answers[`${A}/${B}`] as object), shared_inputs: 0 };
    const el = mount(() => <Compare versions={[A, B]} from={0} to={1} here={A} />);
    await vi.waitFor(() => {
      flush();
      expect(text(el)).toContain("is not an earlier version");
    });
    expect(el.querySelector("table")).toBeNull();
    // Two versions only: no pickers.
    expect(el.querySelector("select")).toBeNull();
  });

  it("offers to try again when the server cannot compare", async () => {
    const el = mount(() => <Compare versions={[B, C]} from={0} to={1} here={B} />);
    await vi.waitFor(() => {
      flush();
      expect(text(el)).toContain("could not compare");
    });
    expect(el.querySelector("button")?.textContent).toBe("Try again");
  });
});
