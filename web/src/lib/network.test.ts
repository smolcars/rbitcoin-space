import { describe, expect, it } from "vitest";
import {
  apiBase,
  hasLightning,
  NETWORKS,
  networkFromPath,
  onNetwork,
  paths,
  stripNetwork,
} from "./network";

describe("network paths", () => {
  it("reads the network from the first segment", () => {
    expect(networkFromPath("/")).toBe("mainnet");
    expect(networkFromPath("/tx/ab")).toBe("mainnet");
    expect(networkFromPath("/signet")).toBe("signet");
    expect(networkFromPath("/signet/")).toBe("signet");
    expect(networkFromPath("/testnet4/block/1")).toBe("testnet4");
    expect(networkFromPath("/testnet5/address/tb1q")).toBe("testnet5");
    expect(networkFromPath("/regtest/tx/ab")).toBe("regtest");
    // Not prefixes: mainnet has none, and look-alikes stay mainnet.
    expect(networkFromPath("/mainnet/tx/ab")).toBe("mainnet");
    expect(networkFromPath("/signetx/tx")).toBe("mainnet");
    expect(networkFromPath("/address/signet")).toBe("mainnet");
  });

  it("strips and adds the prefix symmetrically", () => {
    for (const path of ["/", "/tx/ab", "/block/12/", "/mining"]) {
      for (const net of NETWORKS) {
        const placed = onNetwork(net, path);
        expect(networkFromPath(placed)).toBe(net);
        expect(stripNetwork(placed)).toBe(path);
      }
    }
    expect(onNetwork("signet", "/")).toBe("/signet");
    expect(stripNetwork("/signet/")).toBe("/");
    expect(stripNetwork("")).toBe("/");
  });

  it("points each network at its own API", () => {
    expect(apiBase("mainnet")).toBe("/api");
    expect(apiBase("testnet4")).toBe("/testnet4/api");
    expect(apiBase("testnet5")).toBe("/testnet5/api");
  });

  it("offers Lightning everywhere but Testnet 5, which LDK does not know", () => {
    expect(NETWORKS.filter((n) => !hasLightning(n))).toStrictEqual(["testnet5"]);
  });

  it("encodes chain data into a single path segment", () => {
    expect(paths.tx("ab")).toBe("/tx/ab");
    expect(paths.block(840000)).toBe("/block/840000");
    // oxlint-disable-next-line eslint/no-script-url -- checks that such a value is escaped
    expect(paths.address("javascript:alert(1)")).toBe("/address/javascript%3Aalert(1)");
    expect(paths.address("../../api/x?y#z")).toBe("/address/..%2F..%2Fapi%2Fx%3Fy%23z");
  });
});

describe("pages on no network", () => {
  it("keeps the decoder's path whatever the network", () => {
    expect(onNetwork("signet", paths.decode("lnbc1x"))).toBe("/decode#lnbc1x");
    expect(onNetwork("regtest", "/decode")).toBe("/decode");
    expect(onNetwork("signet", "/decoder")).toBe("/signet/decoder");
    expect(paths.decode("a b#c")).toBe("/decode#a%20b%23c");
  });
});
