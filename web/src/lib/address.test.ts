import { describe, expect, it } from "vitest";
import { keyScript, recognise, scriptKey } from "./address";

const TEST = ["signet", "testnet4", "testnet5", "regtest"];
const TB = ["signet", "testnet4", "testnet5"];
const ALL = ["mainnet", ...TEST];
// A signet key paid in the open, and the curve's generator, compressed.
const KEY =
  "04a8c3fa3dbc022ca7c9a2214c5e673833317b3cff37c0fc170fc347f1a2f6b6e2a53db4d023387f89209de481cd014a44040e1b09c3226d40fed02c0bc8d0f548";
const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

describe("a public key", () => {
  it.each([KEY, G, `03${G.slice(2)}`])("%s stands for its output on every network", (key) => {
    expect(recognise(key)).toStrictEqual({ address: key, type: "p2pk", networks: ALL });
    expect(recognise(key.toUpperCase())?.address).toBe(key);
  });

  it.each([
    // Hybrid keys pay another script; the rest have the wrong length for their first byte.
    `06${KEY.slice(2)}`,
    `04${G.slice(2)}`,
    `02${KEY.slice(2)}`,
    KEY.slice(0, -2),
    `${G}00`,
    G.slice(0, 64),
  ])("%s is not one", (input) => {
    expect(recognise(input)).toBeNull();
    expect(keyScript(input)).toBeUndefined();
  });

  it("is paid by the script that pushes it and checks a signature", () => {
    expect(keyScript(KEY)).toBe(`41${KEY}ac`);
    expect(keyScript(G)).toBe(`21${G}ac`);
    expect(scriptKey(`41${KEY}ac`)).toBe(KEY);
    expect(scriptKey(`21${G}ac`)).toBe(G);
  });

  it.each([
    `21${KEY}ac`,
    `41${G}ac`,
    `41${KEY}ad`,
    `4106${KEY.slice(2)}ac`,
    "76a914000000000000000000000000000000000000000088ac",
    "",
  ])("%j is not a pay-to-pubkey script", (script) => {
    expect(scriptKey(script)).toBeUndefined();
  });
});

describe("recognise", () => {
  it.each([
    // Mainnet
    ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "p2pkh", ["mainnet"]],
    ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "p2sh", ["mainnet"]],
    ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "p2wpkh", ["mainnet"]],
    ["bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", "p2wsh", ["mainnet"]],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "p2tr", ["mainnet"]],
    ["bc1pfeessrawgf", "p2a", ["mainnet"]],
    ["bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "witness", ["mainnet"]],
    // Signet, testnet4 and Testnet 5 share every form; regtest shares the base58 ones
    ["mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "p2pkh", TEST],
    ["n3GNqMveyvaPvUbH469vDRadqpJMPc84JA", "p2pkh", TEST],
    ["2ND8PB9RrfCaAcjfjP1Y6nAgFd9zWHYX4DN", "p2sh", TEST],
    ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "p2wpkh", TB],
    ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "p2wsh", TB],
    ["tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "p2tr", TB],
    ["tb1pfees9rn5nz", "p2a", TB],
    // Regtest
    ["bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s", "p2wpkh", ["regtest"]],
    ["bcrt1qgpsh04whvyp5fvrul6rr8384qt0mf4a7h507m5ed79d72euknpgqpmza40", "p2wsh", ["regtest"]],
    ["bcrt1pz9ml8p3h96z9hlvz0esm3uwdq9pxssmykz209jrg57znrdvx5y0shy3atk", "p2tr", ["regtest"]],
    ["bcrt1pfeesnyr2tx", "p2a", ["regtest"]],
  ])("%s is %s", (address, type, networks) => {
    expect(recognise(address)).toStrictEqual({ address, type, networks });
  });

  it.each([
    [
      "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv",
      ["mainnet"],
    ],
    [
      "tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc3wk4yh",
      TEST,
    ],
  ])("%s is a silent payments address", (address, networks) => {
    expect(recognise(address)).toStrictEqual({ address, type: "sp", networks });
    // Its checksum, version and keys are the address page's to check.
    expect(recognise(`${address.slice(0, -1)}q`)?.type).toBe("sp");
  });

  it("takes silent payments addresses up to 1023 characters, and no shorter than version 0", () => {
    expect(recognise(`sp1${"q".repeat(1020)}`)?.type).toBe("sp");
    expect(recognise(`sp1${"q".repeat(1021)}`)).toBeNull();
    expect(
      recognise(
        "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv".slice(
          0,
          -1,
        ),
      ),
    ).toBeNull();
  });

  it("reads upper-case bech32 as lower case, and keeps base58 as given", () => {
    expect(recognise("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")?.address).toBe(
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    );
    expect(recognise("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")?.address).toBe(
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    );
  });

  it.each([
    "",
    "hello",
    "bc1",
    "bc1q",
    // Mixed case
    "bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    // b, i, o and 1 are not in the bech32 alphabet
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3tb",
    // Version 0 needs a 20- or 32-byte program
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7k",
    // Unknown prefix
    "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    // 0, O, I and l are not base58; 4 starts no address
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfN0",
    "4J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    // Too long for base58, too short
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNaaaaa",
    "1A1zP1eP5Qa",
    "65428488a6202f1d681d053b3ff5d8ea9f5b0e5e1e0dcf7bf2e4c1e5a3f9c2e1",
    '<img src=x onerror="alert(1)">',
    `bc1q${"q".repeat(90)}`,
  ])("%j is not an address", (input) => {
    expect(recognise(input)).toBeNull();
  });
});
