import { describe, expect, it } from "vitest";
import type { AddressType } from "../lib/address";
import type { Network } from "../lib/network";
import { classify, MAX_QUERY } from "./query";

const TXID = "65428488a6202f1d681d053b3ff5d8ea9f5b0e5e1e0dcf7bf2e4c1e5a3f9c2e1";
const BLOCK = "00000000000000000000e13ad5e424f6ba7208b0c1a9a687e9ccc4d62b3b094c";
const TAPROOT = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";

const height = (h: number) => ({ kind: "height", height: h });
const hash = (h: string, as: "block" | "tx" | null = null) => ({ kind: "hash", hash: h, as });
const kindOf = (q: string) => classify(q)?.kind ?? null;

describe("classify: heights", () => {
  it.each([
    ["0", 0],
    ["840000", 840_000],
    ["975411", 975_411],
    ["975,411", 975_411],
    ["975.411", 975_411],
    ["975_411", 975_411],
    ["975'411", 975_411],
    ["975 411", 975_411],
    ["975 411", 975_411],
    ["975 411", 975_411],
    ["#975411", 975_411],
    ["# 975,411", 975_411],
    ["Block 975 411", 975_411],
    ["block #840000", 840_000],
    ["  840000\n", 840_000],
    ["1,234,567", 1_234_567],
    ["4294967295", 4_294_967_295],
    ["000123", 123],
    ["840000.", 840_000],
  ])("%j is height %i", (q, h) => {
    expect(classify(q)).toStrictEqual(height(h));
  });

  it.each([
    "4294967296",
    "99999999999",
    "975,41",
    "97,5411",
    "975,411.000",
    "975,411 000",
    "1.5",
    "-1",
    "+5",
    "1e6",
    "0x10",
    "975411 975411",
    "Block",
    "#",
  ])("%j is not a height", (q) => {
    expect(classify(q)?.kind).not.toBe("height");
  });
});

describe("classify: 64-hex ids", () => {
  it.each([
    [TXID, hash(TXID)],
    [TXID.toUpperCase(), hash(TXID)],
    [`0x${TXID}`, hash(TXID)],
    [`0X${TXID.toUpperCase()}`, hash(TXID)],
    [BLOCK, hash(BLOCK)],
    [`  ${TXID}\t`, hash(TXID)],
    [`"${TXID}"`, hash(TXID)],
    [`“${TXID}”`, hash(TXID)],
    [`(${TXID}).`, hash(TXID)],
    [`​${TXID}﻿`, hash(TXID)],
    // Grouped by eight, as the page subject is shown, or wrapped across lines
    [TXID.replaceAll(/(.{8})/g, "$1 ").trim(), hash(TXID)],
    [`${TXID.slice(0, 30)}\n${TXID.slice(30)}`, hash(TXID)],
    // A 64-digit number is still hex
    ["1".repeat(64), hash("1".repeat(64))],
  ])("%j", (q, expected) => {
    expect(classify(q)).toStrictEqual(expected);
  });

  it.each([
    [`${TXID}:0`, hash(TXID, "tx")],
    [`${TXID}:4294967295`, hash(TXID, "tx")],
    [`${TXID.toUpperCase()}:12`, hash(TXID, "tx")],
  ])("outpoint %j is a transaction", (q, expected) => {
    expect(classify(q)).toStrictEqual(expected);
  });

  it.each([
    TXID.slice(1),
    `${TXID}0`,
    `${TXID.slice(1)}g`,
    `${TXID}:`,
    `${TXID}:x`,
    `${TXID}:12345678901`,
    `${TXID}:0:1`,
    `0x0x${TXID}`,
  ])("%j is not an id", (q) => {
    expect(classify(q)).toBeNull();
  });
});

describe("classify: addresses", () => {
  const TEST: Network[] = ["signet", "testnet4", "testnet5", "regtest"];
  const TB: Network[] = ["signet", "testnet4", "testnet5"];
  it.each<[string, AddressType, Network[]]>([
    ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "p2pkh", ["mainnet"]],
    ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "p2sh", ["mainnet"]],
    ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "p2wpkh", ["mainnet"]],
    ["bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", "p2wsh", ["mainnet"]],
    [TAPROOT, "p2tr", ["mainnet"]],
    ["bc1pfeessrawgf", "p2a", ["mainnet"]],
    ["bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "witness", ["mainnet"]],
    ["mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "p2pkh", TEST],
    ["2ND8PB9RrfCaAcjfjP1Y6nAgFd9zWHYX4DN", "p2sh", TEST],
    ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "p2wpkh", TB],
    ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "p2wsh", TB],
    ["tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "p2tr", TB],
    ["tb1pfees9rn5nz", "p2a", TB],
    ["bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s", "p2wpkh", ["regtest"]],
    ["bcrt1qgpsh04whvyp5fvrul6rr8384qt0mf4a7h507m5ed79d72euknpgqpmza40", "p2wsh", ["regtest"]],
    ["bcrt1pz9ml8p3h96z9hlvz0esm3uwdq9pxssmykz209jrg57znrdvx5y0shy3atk", "p2tr", ["regtest"]],
    ["bcrt1pfeesnyr2tx", "p2a", ["regtest"]],
  ])("%s is %s", (address, type, networks) => {
    expect(classify(` ${address} `)).toStrictEqual({
      kind: "address",
      address: { address, type, networks },
    });
  });

  it("reads upper-case bech32, as a QR code holds it", () => {
    expect(classify(TAPROOT.toUpperCase())).toMatchObject({ address: { address: TAPROOT } });
  });
});

describe("classify: bitcoin: URIs", () => {
  it.each([
    `bitcoin:${TAPROOT}`,
    `BITCOIN:${TAPROOT.toUpperCase()}`,
    `bitcoin:${TAPROOT}?amount=0.0005`,
    `bitcoin:${TAPROOT}?amount=1.5&label=Coffee%20shop&message=Thanks`,
    `bitcoin://${TAPROOT}?amount=1`,
    `bitcoin:${TAPROOT}#ignored`,
    `<bitcoin:${TAPROOT}?amount=1>`,
  ])("%s", (q) => {
    expect(classify(q)).toMatchObject({ kind: "address", address: { address: TAPROOT } });
  });

  it.each([
    "bitcoin:",
    "bitcoin:?lightning=lnbc1",
    `bitcoin:${TXID}`,
    "bitcoin:840000",
    "bitcoin:notanaddress?amount=1",
  ])("%s holds no address", (q) => {
    expect(classify(q)).toBeNull();
  });
});

describe("classify: pasted links", () => {
  it.each([
    // This explorer, on any network
    [`https://explorer.example/tx/${TXID}`, hash(TXID, "tx")],
    [`https://explorer.example/signet/block/${BLOCK}`, hash(BLOCK, "block")],
    ["https://explorer.example/block/840000", height(840_000)],
    ["https://explorer.example/blocks/840000", height(840_000)],
    [`/testnet4/tx/${TXID}`, hash(TXID, "tx")],
    [`/testnet5/tx/${TXID}`, hash(TXID, "tx")],
    // mempool.space style, with a fragment and query
    [`https://mempool.space/tx/${TXID}#vin=0`, hash(TXID, "tx")],
    [`https://mempool.space/testnet4/tx/${TXID}?mode=details`, hash(TXID, "tx")],
    [`mempool.space/block/${BLOCK}`, hash(BLOCK, "block")],
    // blockstream.info style
    ["https://blockstream.info/block-height/840000", height(840_000)],
    [`https://blockstream.info/testnet/tx/${TXID}`, hash(TXID, "tx")],
    // blockchair style
    [`https://blockchair.com/bitcoin/transaction/${TXID}`, hash(TXID, "tx")],
    ["https://blockchair.com/bitcoin/block/840000", height(840_000)],
    // blockchain.com style: the path word comes before the coin
    [`https://www.blockchain.com/explorer/transactions/btc/${TXID}`, hash(TXID, "tx")],
    ["https://www.blockchain.com/explorer/blocks/btc/840000", height(840_000)],
    // No path word: the last segment, when it is a hash
    [`https://btc.example/${TXID}`, hash(TXID)],
    [`HTTP://EXAMPLE.COM/TX/${TXID.toUpperCase()}`, hash(TXID, "tx")],
    // Encoded characters decode in the path
    [
      `https://mempool.space/tx/${encodeURIComponent(TXID).replaceAll("a", "%61")}`,
      hash(TXID, "tx"),
    ],
    // Credentials and ports in the link are ignored with the rest of the host
    [`https://user:pass@mempool.space:8443/tx/${TXID}`, hash(TXID, "tx")],
    [`//mempool.space/tx/${TXID}`, hash(TXID, "tx")],
  ])("%s", (q, expected) => {
    expect(classify(q)).toStrictEqual(expected);
  });

  it.each([
    [`https://mempool.space/address/${TAPROOT}`],
    [`https://blockchair.com/bitcoin/address/${TAPROOT}`],
    [`https://www.blockchain.com/explorer/addresses/btc/${TAPROOT}`],
    [`https://mempool.space/address/${TAPROOT.toUpperCase()}`],
  ])("%s is an address", (q) => {
    expect(classify(q)).toMatchObject({ kind: "address", address: { address: TAPROOT } });
  });

  it.each([
    // Other schemes are not links to an explorer page
    `javascript:alert(1)//tx/${TXID}`,
    `data:text/html,<a href="/tx/${TXID}">`,
    `file:///tx/${TXID}`,
    `ftp://mempool.space/tx/${TXID}`,
    `blob:https://mempool.space/tx/${TXID}`,
    // A link to a page with no identifier, or the wrong kind of one
    "https://mempool.space/",
    "https://mempool.space/tx/",
    "https://mempool.space/tx/840000",
    `https://mempool.space/block/${TXID}:0`,
    "https://mempool.space/address/840000",
    "https://example.com/2024/05/840000",
    // Encoded slashes and broken escapes never become a path
    `https://mempool.space/tx%2F${TXID}`,
    "https://mempool.space/tx/%E0%A4%A",
    // Markup is text, and fits nothing
    `<img src=x onerror="alert(1)">/tx/`,
    "https://[::1/tx/",
  ])("%s finds nothing", (q) => {
    expect(classify(q)).toBeNull();
  });
});

describe("classify: bounds and garbage", () => {
  it.each([
    "",
    "   ",
    "hello",
    "satoshi",
    "bc1",
    "bc1qw508d6",
    TXID.slice(0, 20),
    "<script>alert(1)</script>",
    '"><svg onload=alert(1)>',
    "../../etc/passwd",
    "%00",
    "\u{0000}\u{0001}",
    "‮840000",
    "🙂",
    "SELECT * FROM blocks",
  ])("%j is nothing", (q) => {
    expect(classify(q)).toBeNull();
  });

  it("refuses anything longer than MAX_QUERY, whatever it holds", () => {
    expect(kindOf(`${TXID}${" ".repeat(MAX_QUERY)}`)).toBeNull();
    expect(kindOf(`https://mempool.space/tx/${TXID}?${"a".repeat(MAX_QUERY)}`)).toBeNull();
    expect(kindOf("9".repeat(100_000))).toBeNull();
    expect(kindOf(`https://mempool.space/tx/${TXID}?${"a".repeat(400)}`)).toBe("hash");
  });
});

describe("classify: Lightning", () => {
  const KEY = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";

  it.each([
    [KEY, KEY],
    [KEY.toUpperCase(), KEY],
    [` ${KEY} `, KEY],
    [`https://mempool.space/lightning/node/${KEY}`, KEY],
    [`https://example.com/${KEY}`, KEY],
  ])("%s is a node", (q, key) => {
    expect(classify(q)).toStrictEqual({ kind: "node", key });
  });

  it.each([
    ["811984x2037x0", "811984x2037x0"],
    ["811984X2037X0", "811984x2037x0"],
    ["0811984x02037x00", "811984x2037x0"],
    ["16777215x16777215x65535", "16777215x16777215x65535"],
    // 811984 << 40 | 2037 << 16: the same channel as the 64-bit number the reference uses.
    ["892785849701564416", "811984x2037x0"],
    ["18446744073709551615", "16777215x16777215x65535"],
    ["4294967296", "0x65536x0"],
    ["https://mempool.space/lightning/channel/811984x2037x0", "811984x2037x0"],
    ["https://mempool.space/lightning/channel/123", "0x0x123"],
  ])("%s is channel %s", (q, id) => {
    expect(classify(q)).toStrictEqual({ kind: "channel", id });
  });

  it.each([
    `04${KEY.slice(2)}`,
    KEY.slice(0, 65),
    `${KEY}0`,
    "16777216x0x0",
    "1x16777216x0",
    "1x2x65536",
    "1x2",
    "1x2x3x4",
    "18446744073709551616",
    "https://example.com/892785849701564416",
  ])("%s is not a Lightning id", (q) => {
    expect(["node", "channel"]).not.toContain(classify(q)?.kind);
  });

  it("keeps a number that fits a height a height", () => {
    expect(classify("4294967295")).toStrictEqual(height(4_294_967_295));
  });
});
