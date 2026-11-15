import { describe, expect, it } from "vitest";
import { paths } from "../../../lib/network";
import {
  addressKind,
  type Listing,
  readListing,
  readPage,
  spendableSats,
  statusOf,
} from "./address";
import { answer } from "./testdata";
import type { Vtxo } from "./vtxo";

/** Signet's server key and a VTXO's script, as an address. */
const TARK =
  "tark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqnrjdp6x";

const vtxo = (over: Partial<Vtxo> = {}): Vtxo => ({ ...answer().vtxo, ...over });
const listing = (vtxos: Vtxo[] = [vtxo()]): Listing => ({ page: 1, pages: 1, vtxos });

describe("reading the answer", () => {
  it("takes what the server sends", () => {
    expect(readListing(structuredClone(listing()))).toBeDefined();
    expect(readListing({ page: 1, pages: 0, vtxos: [] })).toBeDefined();
  });

  it("refuses anything else", () => {
    const bad: unknown[] = [
      null,
      [],
      { ...listing(), page: 0 },
      { ...listing(), pages: -1 },
      { ...listing(), pages: 1.5 },
      { ...listing(), vtxos: "x" },
      listing(Array.from({ length: 26 }, () => vtxo())),
      listing([vtxo({ txid: "<script>" })]),
      listing([vtxo({ amount: -1 })]),
    ];
    for (const b of bad) expect(readListing(b)).toBeUndefined();
  });
});

describe("an address by its shape", () => {
  it("knows Arkade, Bark, another network's and nonsense", () => {
    expect(addressKind(TARK, "signet")).toBe("arkade");
    expect(addressKind(TARK.toUpperCase(), "regtest")).toBe("arkade");
    expect(addressKind(TARK, "mainnet")).toBe("other-network");
    expect(addressKind(`ark1${TARK.slice(5)}`, "mainnet")).toBe("arkade");
    expect(addressKind(`tark1p${TARK.slice(6)}`, "signet")).toBe("bark");
    expect(addressKind(`tark1z${TARK.slice(6)}`, "signet")).toBe("unknown-version");
    expect(addressKind(TARK.slice(0, -1), "signet")).toBe("invalid");
    expect(addressKind(`Tark1${TARK.slice(5)}`, "signet")).toBe("invalid");
    expect(addressKind("tark1qb", "signet")).toBe("invalid");
    expect(addressKind("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "mainnet")).toBe("invalid");
    expect(addressKind("", "signet")).toBe("invalid");
  });
});

describe("the page in the address", () => {
  it("reads as the server takes it, else page 1", () => {
    expect(readPage(undefined)).toBe(1);
    expect(readPage("3")).toBe(3);
    expect(readPage("1000")).toBe(1000);
    expect(readPage("9999")).toBe(1000);
    for (const bad of ["0", "03", "-2", "x", "", "1e3", "99999"]) expect(readPage(bad)).toBe(1);
  });

  it("is in the path only past the first", () => {
    expect(paths.arkadeAddress(TARK)).toBe(`/ark/arkade/address/${TARK}`);
    expect(paths.arkadeAddress(TARK, 2)).toBe(`/ark/arkade/address/${TARK}?page=2`);
    expect(paths.arkadeAddress("a/b?c")).toBe("/ark/arkade/address/a%2Fb%3Fc");
  });
});

describe("states and what is spendable", () => {
  it("words a VTXO as its page does", () => {
    const words = (v: Vtxo) => statusOf(v).map((b) => b.word);
    expect(words(vtxo({ spent: false, swept: false, preconfirmed: false }))).toStrictEqual([
      "Unspent",
    ]);
    expect(words(vtxo({ spent: false, swept: false, preconfirmed: true }))).toStrictEqual([
      "Unspent",
      "Not settled yet",
    ]);
    expect(words(vtxo({ spent: true, swept: true, preconfirmed: true }))).toStrictEqual(["Spent"]);
    expect(words(vtxo({ spent: false, swept: true }))).toStrictEqual(["Swept"]);
  });

  it("adds up only what is neither spent nor swept", () => {
    expect(
      spendableSats([
        vtxo({ amount: 1000, spent: false, swept: false }),
        vtxo({ amount: 500, spent: false, swept: false, preconfirmed: true }),
        vtxo({ amount: 7, spent: true, swept: false }),
        vtxo({ amount: 9, spent: false, swept: true }),
      ]),
    ).toBe(1500);
    expect(spendableSats([])).toBe(0);
  });
});
