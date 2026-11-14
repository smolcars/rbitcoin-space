import { describe, expect, it } from "vitest";
import { recognise } from "./address";

const TEST = ["signet", "testnet4", "testnet5", "regtest"];
const TB = ["signet", "testnet4", "testnet5"];

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
