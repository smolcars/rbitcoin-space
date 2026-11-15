import { describe, expect, it } from "vitest";
import { decodeSilentPayment, isPublicKey } from "./silent-payment";

// BIP352's test vectors, the first receiving case: its address and the public keys of its scan and
// spend private keys.
const ADDRESS =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv";
const SCAN = "0220bcfac5b99e04ad1a06ddfb016ee13582609d60b6291e98d01a9bc9a16c96d4";
const SPEND = "025cc9856d6f8375350e123978daac200c260cb5b5ae83106cab90484dcd8fcf36";

// The same keys under other prefixes and versions, encoded for these tests by an independent
// bech32m encoder (after BIP350's reference code), not by the decoder under test.
const TESTNET =
  "tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc3wk4yh";
/** Version 1 with ten more bytes after the keys. */
const LATER =
  "sp1pqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xcqqzqsrqszsvpcgpy5fhdn0";
const VERSION_31 =
  "sp1lqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc4wndsd";
/** Version 0 with one byte too many. */
const LONG =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xcqqvv86g7";
/** A scan key of x = 5, where x³ + 7 has no square root. */
const OFF_CURVE =
  "sp1qqgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2qjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9q2e28";
/** A scan key with the 04 prefix of an uncompressed key. */
const BAD_PREFIX =
  "sp1qqsste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xcuskmf6";
/** The BIP352 vector's keys with one of the two padding bits set. */
const NONZERO_PADDING =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xechz4n7";
/** The same with one more 5-bit group: seven bits of padding. */
const EXTRA_PADDING =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xcqam5lls";
/** The BIP352 vector under a bech32 checksum, not bech32m. */
const BECH32 =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xcsaxvtw";
/** A valid scan key and a spend key of x = 5. */
const BAD_SPEND =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5e8lggq";
/** Version 0 with 65 bytes, a byte short. */
const SHORT =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70kll9qy";
/** Version 30, the last a version 0 reader may read. */
const VERSION_30 =
  "sp17qgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xcnff57z";

describe("decodeSilentPayment", () => {
  it("reads BIP352's test vector address", () => {
    expect(decodeSilentPayment(ADDRESS)).toStrictEqual({
      ok: true,
      version: 0,
      scanKey: SCAN,
      spendKey: SPEND,
      extraBytes: 0,
    });
  });

  it("reads a test network address", () => {
    expect(decodeSilentPayment(TESTNET)).toMatchObject({ ok: true, scanKey: SCAN });
  });

  it("reads a later version by its first 66 bytes", () => {
    expect(decodeSilentPayment(LATER)).toStrictEqual({
      ok: true,
      version: 1,
      scanKey: SCAN,
      spendKey: SPEND,
      extraBytes: 10,
    });
  });

  it("reads version 30", () => {
    expect(decodeSilentPayment(VERSION_30)).toStrictEqual({
      ok: true,
      version: 30,
      scanKey: SCAN,
      spendKey: SPEND,
      extraBytes: 0,
    });
  });

  it.each([
    ["a bech32 checksum", BECH32, "checksum"],
    ["non-zero padding", NONZERO_PADDING, "length"],
    ["more than four bits of padding", EXTRA_PADDING, "length"],
    ["version 0 a byte short", SHORT, "length"],
    ["a spend key off the curve", BAD_SPEND, "key"],
    ["a changed character", `${ADDRESS.slice(0, 20)}x${ADDRESS.slice(21)}`, "checksum"],
    ["a missing character", ADDRESS.slice(0, -1), "checksum"],
    ["another network's prefix", `t${ADDRESS}`, "checksum"],
    ["version 31", VERSION_31, "version"],
    ["version 0 with a byte too many", LONG, "length"],
    ["a key off the curve", OFF_CURVE, "key"],
    ["a key that is not compressed", BAD_PREFIX, "key"],
  ])("refuses %s", (_, address, problem) => {
    expect(decodeSilentPayment(address)).toStrictEqual({ ok: false, problem });
  });
});

describe("isPublicKey", () => {
  const key = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
  it("takes the generator point", () => {
    expect(
      isPublicKey(key("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")),
    ).toBe(true);
  });
  it("refuses an x past the field", () => {
    expect(isPublicKey(key(`02${"f".repeat(64)}`))).toBe(false);
  });
  it("refuses the wrong length", () => {
    expect(isPublicKey(key(SCAN.slice(0, -2)))).toBe(false);
  });
});
