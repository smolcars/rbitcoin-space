import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

describe("parseConfig", () => {
  it("keeps known networks and the version", () => {
    expect(
      parseConfig({ networks: ["mainnet", "signet", "liquid", 3], version: "0.5.0" }),
    ).toStrictEqual({
      networks: ["mainnet", "signet"],
      version: "0.5.0",
      ark: {},
      lightning: [],
      broadcast: false,
    });
  });

  it("rejects malformed bodies", () => {
    for (const body of [null, "x", [], {}, { networks: "mainnet" }]) {
      expect(parseConfig(body)).toBeNull();
    }
    expect(parseConfig({ networks: [] })).toStrictEqual({
      networks: [],
      version: "",
      ark: {},
      lightning: [],
      broadcast: false,
    });
  });

  it("reads whether the server broadcasts, only from a true", () => {
    expect(parseConfig({ networks: [], broadcast: true })?.broadcast).toBe(true);
    for (const broadcast of [false, "true", 1, null]) {
      expect(parseConfig({ networks: [], broadcast })?.broadcast).toBe(false);
    }
  });

  it("keeps each network's Ark implementations", () => {
    const ark = {
      signet: ["bark", "<b>", 3, "arkade"],
      liquid: ["bark"],
      mainnet: ["arkade"],
      testnet4: [],
      regtest: "bark",
    };
    expect(parseConfig({ networks: ["signet"], version: "1", ark })?.ark).toStrictEqual({
      signet: ["bark", "arkade"],
      mainnet: ["arkade"],
    });
  });

  it("keeps the known networks with Lightning on", () => {
    const lightning = ["signet", "liquid", 3, "testnet4", null];
    expect(parseConfig({ networks: ["signet"], lightning })?.lightning).toStrictEqual([
      "signet",
      "testnet4",
    ]);
    expect(parseConfig({ networks: ["signet"], lightning: "signet" })?.lightning).toStrictEqual([]);
  });
});
