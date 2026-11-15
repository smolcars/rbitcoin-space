import { describe, expect, it } from "vitest";
import { classify, destination, refusal } from "./paste";

const TXID = "d922b2c3811ec22ae6c7b0bea4eaef16c33250bf4e717950f1898095e79773fc";
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** A bech32m string, built here so the tests do not trust the code they test. */
function bech32m(hrp: string, data: number[]): string {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: number[]) => {
    let chk = 1;
    for (const v of values) {
      const b = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= gen[i] ?? 0;
    }
    return chk >>> 0;
  };
  const codes = hrp.split("").map((c) => c.codePointAt(0) ?? 0);
  const expanded = [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
  const mod = polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const sum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...sum].map((v) => CHARSET[v]).join("")}`;
}

/** An address of `version` (0 is q, 1 is p) and 104 groups of payload, as Ark's 65 bytes take. */
const address = (hrp: string, version: number) =>
  bech32m(
    hrp,
    Array.from({ length: 104 }, (_, i) => (i === 0 ? version : (i * 7) % 32)),
  );

const ARKADE_SIGNET = address("tark", 0);
const ARKADE_MAINNET = address("ark", 0);
const BARK_SIGNET = address("tark", 1);
const HEX = `0100${"ab".repeat(80)}`;

describe("classify", () => {
  it("txid:vout is a VTXO, trimmed and lower-cased", () => {
    expect(classify(` ${TXID.toUpperCase()}:0 \n`, "signet")).toStrictEqual({
      kind: "vtxo",
      id: `${TXID}:0`,
    });
    expect(classify(`${TXID}:4294967295`, "mainnet")).toStrictEqual({
      kind: "vtxo",
      id: `${TXID}:4294967295`,
    });
  });

  it("a vout out of range, padded or signed is nothing", () => {
    for (const s of [`${TXID}:4294967296`, `${TXID}:01`, `${TXID}:-1`, `${TXID}:`, `${TXID}: 0`]) {
      expect(classify(s, "signet")).toStrictEqual({ kind: "unknown" });
    }
  });

  it("a bare txid is a txid, never hex", () => {
    expect(classify(TXID, "signet")).toStrictEqual({ kind: "txid" });
    expect(classify(`0100${"ab".repeat(30)}`, "signet")).toStrictEqual({ kind: "txid" });
  });

  it("long hex with a version is a Bark VTXO, in either case", () => {
    expect(classify(HEX.toUpperCase(), "signet")).toStrictEqual({ kind: "bark-hex", hex: HEX });
    expect(classify(`0200${"00".repeat(60)}`, "mainnet").kind).toBe("bark-hex");
  });

  it("hex without a version, of odd length or short is nothing", () => {
    expect(classify(`0300${"ab".repeat(80)}`, "signet").kind).toBe("unknown");
    expect(classify(`${HEX}a`, "signet").kind).toBe("unknown");
    expect(classify(`0100${"ab".repeat(20)}`, "signet").kind).toBe("unknown");
    expect(classify(`${HEX}g`, "signet").kind).toBe("unknown");
  });

  it("an Arkade address on its own network, in either case", () => {
    expect(classify(ARKADE_SIGNET, "signet")).toStrictEqual({
      kind: "arkade-address",
      address: ARKADE_SIGNET,
    });
    expect(classify(ARKADE_SIGNET.toUpperCase(), "regtest").kind).toBe("arkade-address");
    expect(classify(ARKADE_MAINNET, "mainnet").kind).toBe("arkade-address");
  });

  it("an address on the other kind of network says which", () => {
    expect(classify(ARKADE_MAINNET, "signet")).toStrictEqual({
      kind: "other-network",
      mainnet: true,
    });
    expect(classify(ARKADE_SIGNET, "mainnet")).toStrictEqual({
      kind: "other-network",
      mainnet: false,
    });
    // Before its version: a Bark address on the wrong network is still on the wrong network.
    expect(classify(BARK_SIGNET, "mainnet")).toStrictEqual({
      kind: "other-network",
      mainnet: false,
    });
  });

  it("a Bark address is recognised, and goes nowhere", () => {
    expect(classify(BARK_SIGNET, "signet")).toStrictEqual({ kind: "bark-address" });
    expect(destination(classify(BARK_SIGNET, "signet"))).toBeUndefined();
  });

  it("an Ark address of a version BOAT-1 does not define says so", () => {
    expect(classify(address("tark", 2), "signet")).toStrictEqual({ kind: "unknown-version" });
    expect(refusal(classify(address("ark", 31), "mainnet"))).toBe(
      "An Ark address of an unknown version",
    );
  });

  it("mixed case, a bad checksum or another prefix is nothing", () => {
    const mixed = `${ARKADE_SIGNET.slice(0, 10)}${ARKADE_SIGNET.slice(10).toUpperCase()}`;
    const typo = `${ARKADE_SIGNET.slice(0, -1)}${ARKADE_SIGNET.endsWith("q") ? "p" : "q"}`;
    for (const s of [mixed, typo, address("bc", 0), "tark1qqqq", ""]) {
      expect(classify(s, "signet")).toStrictEqual({ kind: "unknown" });
    }
  });

  it("text, markup and a URL are nothing", () => {
    for (const s of ["hello", "<img src=x>", "data:text/html,x", "https://example.com/x:0"]) {
      expect(classify(s, "signet")).toStrictEqual({ kind: "unknown" });
    }
  });
});

describe("where a paste goes", () => {
  it("a VTXO to the lookup, hex to its fragment, an Arkade address to its page", () => {
    expect(destination(classify(`${TXID}:3`, "signet"))).toBe(`/ark/vtxo/${TXID}:3`);
    expect(destination(classify(HEX, "signet"))).toBe(`/ark/bark/hex#${HEX}`);
    expect(destination(classify(ARKADE_SIGNET, "signet"))).toBe(
      `/ark/arkade/address/${ARKADE_SIGNET}`,
    );
  });

  it("everything else says why in a few words, and only that has words", () => {
    expect(refusal(classify(TXID, "signet"))).toBe("Add :vout to the txid");
    expect(refusal(classify(BARK_SIGNET, "signet"))).toBe("A Bark address cannot be looked up");
    expect(refusal(classify(ARKADE_MAINNET, "signet"))).toBe("A mainnet address");
    expect(refusal(classify(ARKADE_SIGNET, "mainnet"))).toBe("A test network address");
    expect(refusal(classify("x", "signet"))).toBe("Not a VTXO or an Ark address");
    expect(refusal(classify(`${TXID}:0`, "signet"))).toBeUndefined();
  });
});
