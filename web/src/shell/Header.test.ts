import { describe, expect, it } from "vitest";
import { tabs } from "./Header";

const labels = (...args: Parameters<typeof tabs>) => tabs(...args).map((t) => t.label);

describe("tabs", () => {
  it("offers Lightning only on the networks the server has it on", () => {
    expect(labels("testnet4", ["mainnet", "signet"], {})).toStrictEqual([
      "Blocks",
      "Mempool",
      "Mining",
    ]);
    expect(labels("signet", ["mainnet", "signet"], {})).toContain("Lightning");
  });

  it("offers neither Lightning nor Ark before the server answers", () => {
    expect(labels("mainnet", undefined, undefined)).toStrictEqual(["Blocks", "Mempool", "Mining"]);
  });

  it("offers Ark only where the network has an implementation", () => {
    expect(labels("signet", [], { signet: ["bark"] })).toStrictEqual([
      "Blocks",
      "Mempool",
      "Mining",
      "Ark",
    ]);
    expect(labels("signet", [], { signet: [], mainnet: ["bark"] })).not.toContain("Ark");
  });
});
