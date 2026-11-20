import { describe, expect, it } from "vitest";
import { pageOf } from "./LabelsPage";

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";
const KEY = `02${"ab".repeat(32)}`;

describe("pageOf", () => {
  it("puts a transaction, input or output on the reader's network", () => {
    expect(pageOf({ type: "tx", ref: TXID.toUpperCase() }, "signet")).toBe(`/signet/tx/${TXID}`);
    expect(pageOf({ type: "output", ref: `${TXID}:3` }, "mainnet")).toBe(`/tx/${TXID}`);
    expect(pageOf({ type: "input", ref: `${TXID}:0` }, "regtest")).toBe(`/regtest/tx/${TXID}`);
  });

  it("puts an address on its own network, the reader's when its form fits several", () => {
    const tb = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    expect(pageOf({ type: "addr", ref: tb }, "testnet4")).toBe(`/testnet4/address/${tb}`);
    expect(pageOf({ type: "addr", ref: tb }, "mainnet")).toBe(`/signet/address/${tb}`);
    const bc = "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c";
    expect(pageOf({ type: "addr", ref: bc.toUpperCase() }, "signet")).toBe(`/address/${bc}`);
    expect(pageOf({ type: "pubkey", ref: KEY }, "regtest")).toBe(`/regtest/address/${KEY}`);
  });

  it("never gives a page for an xpub, a scan key or an unknown type: nothing is looked up", () => {
    expect(pageOf({ type: "xpub", ref: "xpub661MyMwAqRbc" }, "mainnet")).toBeUndefined();
    expect(pageOf({ type: "spscan", ref: "spscan1q5zs" }, "mainnet")).toBeUndefined();
    expect(pageOf({ type: "descriptor", ref: TXID }, "mainnet")).toBeUndefined();
    // An address record holding a key, or a key record holding an address, is not mapped.
    expect(pageOf({ type: "addr", ref: KEY }, "mainnet")).toBeUndefined();
  });
});
