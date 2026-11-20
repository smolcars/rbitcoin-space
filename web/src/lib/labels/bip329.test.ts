import { describe, expect, it } from "vitest";
import { cost } from "../cost";
import {
  fileName,
  holdsMore,
  type LabelRecord,
  MAX_LINE,
  mergeInto,
  readFile,
  readLine,
  withLabel,
  writeFile,
} from "./bip329";

// BIP329's test vectors, as the BIP prints them (bitcoin/bips, bip-0329.mediawiki, "Test Vectors").
const VECTORS = [
  `{ "type": "tx", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd", "label": "Transaction", "origin": "wpkh([d34db33f/84'/0'/0'])" }`,
  `{ "type": "addr", "ref": "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c", "label": "Address" }`,
  `{ "type": "pubkey", "ref": "0283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f448", "label": "Public Key" }`,
  `{ "type": "input", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:0", "label": "Input" }`,
  `{ "type": "output", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:1", "label": "Output", "spendable": false }`,
  `{ "type": "xpub", "ref": "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8", "label": "Extended Public Key" }`,
  `{ "type": "spscan", "ref": "spscan1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zsq9q6qjevn2kmdrnpuxt0v6h2kr2a2epkr0g6nk55ftf0xcxtddazgkrth3e", "label": "Silent Payments Scan Key Expression" }`,
  `{ "type": "tx", "ref": "f546156d9044844e02b181026a1a407abfca62e7ea1159f87bbeaa77b4286c74", "label": "Account #1 Transaction", "origin": "wpkh([d34db33f/84'/0'/1'])" }`,
];

/** Characters by code point, so no invisible one is written into this file. */
const cp = (...points: number[]) => String.fromCodePoint(...points);

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";

const read = (line: string) => {
  const r = readLine(line);
  if (typeof r === "string") throw new TypeError(`skipped: ${r}`);
  return r;
};

describe("readLine", () => {
  it("reads every record type in the BIP's test vectors", () => {
    const records = VECTORS.map((v) => read(v));
    expect(records.map((r) => [r.type, r.label])).toStrictEqual([
      ["tx", "Transaction"],
      ["addr", "Address"],
      ["pubkey", "Public Key"],
      ["input", "Input"],
      ["output", "Output"],
      ["xpub", "Extended Public Key"],
      ["spscan", "Silent Payments Scan Key Expression"],
      ["tx", "Account #1 Transaction"],
    ]);
    // Each line is kept exactly as written, spaces and all.
    expect(records.map((r) => r.line)).toStrictEqual(VECTORS);
  });

  it("keys a record by its type, its reference as compared and its origin", () => {
    const a = read(`{"type":"tx","ref":"${TXID.toUpperCase()}","label":"a"}`);
    const b = read(`{"type":"tx","ref":"${TXID}","label":"b"}`);
    const c = read(
      `{"type":"tx","ref":"${TXID}","label":"c","origin":"wpkh([d34db33f/84'/0'/0'])"}`,
    );
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(b.key);
    // The reference itself stays as written.
    expect(a.ref).toBe(TXID.toUpperCase());
  });

  it("compares bech32 addresses without case and base58 ones with it", () => {
    const lower = read(`{"type":"addr","ref":"bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c"}`);
    const upper = read(`{"type":"addr","ref":"BC1Q34AQ5DRPUWY3WGL9LHUP9892QP6SVR8LDZYY7C"}`);
    expect(lower.key).toBe(upper.key);
    const b58 = read(`{"type":"addr","ref":"1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"}`);
    const b58lower = read(`{"type":"addr","ref":"1bvbmseystwetqtfn5au4m4gfg7xjanvn2"}`);
    expect(b58.key).not.toBe(b58lower.key);
  });

  it("keeps the fields it does not use, including BIP329's additional ones", () => {
    const line = `{"type":"output","ref":"${TXID}:1","label":"rent","spendable":false,"height":800000,"time":"2025-01-23T11:40:35Z","value":12345,"fmv":{"USD":1233.45},"keypath":"/1/123","future":{"x":[1,2,3]}}`;
    const r = read(line);
    expect(r.line).toBe(line);
    expect(writeFile([r])).toBe(`${line}\n`);
  });

  it("keeps a rate's decimals as written, since the line itself is exported", () => {
    const line = `{"type":"tx","ref":"${TXID}","label":"x","rate":{"USD":105620.00}}`;
    expect(writeFile([read(line)])).toBe(`${line}\n`);
  });

  it("reads a record without a label, and a null label, as one that has none", () => {
    expect(read(`{"type":"output","ref":"${TXID}:0","spendable":true}`).label).toBeUndefined();
    expect(read(`{"type":"tx","ref":"${TXID}","label":null}`).label).toBeUndefined();
  });

  it("keeps a record of a type it does not know, never shown", () => {
    const r = read(`{"type":"descriptor","ref":"wpkh([d34db33f/84'/0'/0'])","label":"x"}`);
    expect(r.type).toBe("descriptor");
  });

  it.each([
    ["not JSON", "{type: tx}", "json"],
    ["an array", "[1,2]", "object"],
    ["a string", '"tx"', "object"],
    ["no type", `{"ref":"${TXID}"}`, "type"],
    ["a type that is not a word", `{"type":"<b>","ref":"${TXID}"}`, "type"],
    ["an upper-case type", `{"type":"TX","ref":"${TXID}"}`, "type"],
    ["no ref", `{"type":"tx","label":"x"}`, "ref"],
    ["an empty ref", `{"type":"tx","ref":""}`, "ref"],
    ["a txid too short", `{"type":"tx","ref":"abcd"}`, "ref"],
    ["an output without an index", `{"type":"output","ref":"${TXID}"}`, "ref"],
    ["an output index past 32 bits", `{"type":"output","ref":"${TXID}:4294967296"}`, "ref"],
    ["an address with a space", `{"type":"addr","ref":"bc1q 34aq5drpuwy3wgl9lhup9892"}`, "ref"],
    ["a pubkey of the wrong length", `{"type":"pubkey","ref":"02abcd"}`, "ref"],
    ["a number for a label", `{"type":"tx","ref":"${TXID}","label":5}`, "label"],
    ["an object for an origin", `{"type":"tx","ref":"${TXID}","origin":{}}`, "origin"],
    ["a line too long", `{"type":"tx","ref":"${TXID}","label":"${"x".repeat(MAX_LINE)}"}`, "long"],
  ])("skips %s", (_, line, why) => {
    expect(readLine(line)).toBe(why);
  });

  it("reads a label of any text as data: markup, scripts, bidi and control characters", () => {
    const hostile = `<img src=x onerror=alert(1)>${cp(0x20_2e)}gnp.exe${cp(0, 0x1b)}[31m`;
    const r = read(JSON.stringify({ type: "tx", ref: TXID, label: hostile }));
    expect(r.label).toBe(hostile);
  });
});

describe("readFile", () => {
  it("reads the BIP's vectors as a file, in order", async () => {
    const f = await readFile(`${VECTORS.join("\n")}\n`);
    expect(f.records).toHaveLength(8);
    expect(f.lines).toBe(8);
    expect(f.skipped.size).toBe(0);
  });

  it("tolerates a byte order mark, CRLF line ends and blank lines", async () => {
    const f = await readFile(`\u{FEFF}${VECTORS[0]}\r\n\r\n   \n${VECTORS[1]}\r\n`);
    expect(f.records.map((r) => r.type)).toStrictEqual(["tx", "addr"]);
    expect(f.lines).toBe(2);
    expect(f.records[0]?.line).toBe(VECTORS[0]);
  });

  it("skips bad lines, counts them by reason and names the first ones", async () => {
    const f = await readFile(
      [VECTORS[0], "nope", "{}", VECTORS[1], "[]", `{"type":"tx","ref":"zz"}`, "x", "y"].join("\n"),
    );
    expect(f.records).toHaveLength(2);
    expect(Object.fromEntries(f.skipped)).toStrictEqual({ json: 3, type: 1, object: 1, ref: 1 });
    expect(f.firstSkipped).toStrictEqual([2, 3, 5, 6, 7]);
  });

  it("keeps the later of two lines for the same record, at the later line's place", async () => {
    const f = await readFile(
      [
        `{"type":"tx","ref":"${TXID}","label":"first"}`,
        `{"type":"addr","ref":"bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c","label":"a"}`,
        `{"type":"tx","ref":"${TXID.toUpperCase()}","label":"second"}`,
      ].join("\n"),
    );
    expect(f.replaced).toBe(1);
    expect(f.records.map((r) => r.label)).toStrictEqual(["a", "second"]);
  });

  it("keeps a repeated record's label when the later line has none (BIP329)", async () => {
    const f = await readFile(
      [
        `{"type":"output","ref":"${TXID}:1","label":"kept"}`,
        `{"type":"output","ref":"${TXID}:1","spendable":false}`,
      ].join("\n"),
    );
    expect(f.records[0]?.label).toBe("kept");
    expect(JSON.parse(f.records[0]?.line ?? "")).toStrictEqual({
      type: "output",
      ref: `${TXID}:1`,
      spendable: false,
      label: "kept",
    });
  });

  it("round-trips: reading its own export gives the same bytes", async () => {
    const first = writeFile((await readFile(`${VECTORS.join("\r\n")}\r\n\n`)).records);
    const second = writeFile((await readFile(first)).records);
    expect(second).toBe(first);
    expect(first).toBe(`${VECTORS.join("\n")}\n`);
  });

  it("gives the page a turn between slices of a long file, and can be stopped", async () => {
    const lines = Array.from(
      { length: 100_000 },
      (_, i) => `{"type":"output","ref":"${TXID}:${i}","label":"coin ${i}"}`,
    ).join("\n");
    const seen: number[] = [];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const f = await readFile(lines, (done) => seen.push(done));
    clearInterval(timer);
    expect(f.records).toHaveLength(100_000);
    expect(seen.length).toBeGreaterThan(40);
    // Other tasks ran while it read.
    expect(ticks).toBeGreaterThan(10);
    let calls = 0;
    const stopped = await readFile(lines, undefined, () => ++calls > 2);
    expect(stopped.records.length).toBeLessThan(10_000);
  });

  it("reads a slice of 2 000 lines in well under a frame's worth of processor time each", async () => {
    const slice = Array.from(
      { length: 2000 },
      (_, i) => `{"type":"output","ref":"${TXID}:${i}","label":"coin ${i}","value":${i}}`,
    );
    // One slice is what runs between two turns of the page.
    const { ms } = cost(() => slice.map((l) => readLine(l)));
    expect(ms).toBeLessThan(50);
    await Promise.resolve();
  });
});

describe("mergeInto", () => {
  const rec = (line: string): LabelRecord => read(line);
  it("takes the incoming record, keeping a label or spendable it leaves out", () => {
    const old = rec(`{"type":"output","ref":"${TXID}:1","label":"mine","spendable":true}`);
    expect(mergeInto(old, rec(`{"type":"output","ref":"${TXID}:1","label":"new"}`)).line).toBe(
      `{"type":"output","ref":"${TXID}:1","label":"new","spendable":true}`,
    );
    const both = rec(`{"type":"output","ref":"${TXID}:1","label":"x","spendable":false}`);
    expect(mergeInto(old, both)).toStrictEqual(both);
  });
});

describe("withLabel", () => {
  it("writes a new record as the BIP writes one", () => {
    expect(withLabel(undefined, "tx", TXID, "rent, March")?.line).toBe(
      `{"type":"tx","ref":"${TXID}","label":"rent, March"}`,
    );
    expect(withLabel(undefined, "tx", TXID, null)).toBeNull();
    expect(withLabel(undefined, "tx", "nope", "x")).toBeNull();
  });

  it("changes the label in place and keeps every other field", () => {
    const r = read(VECTORS[4] ?? "");
    const next = withLabel(r, "output", r.ref, "cold storage");
    expect(next?.line).toBe(
      `{"type":"output","ref":"${TXID}:1","label":"cold storage","spendable":false}`,
    );
    const gone = withLabel(r, "output", r.ref, null);
    expect(gone?.label).toBeUndefined();
    expect(gone?.line).toBe(`{"type":"output","ref":"${TXID}:1","spendable":false}`);
    expect(gone && holdsMore(gone)).toBe(true);
    const plain = withLabel(read(`{"type":"tx","ref":"${TXID}","label":"x"}`), "tx", TXID, null);
    expect(plain && holdsMore(plain)).toBe(false);
  });

  it("writes a hostile label as JSON text, on one line", () => {
    const evil = `a"\n}\n{"type":"tx","ref":"x"${cp(0x20_28, 0)}`;
    const line = withLabel(undefined, "tx", TXID, evil)?.line ?? "";
    expect(line).not.toContain("\n");
    expect((JSON.parse(line) as { label: string }).label).toBe(evil);
  });
});

describe("writeFile and fileName", () => {
  it("ends every line with a line feed, and names the file by the day", () => {
    expect(writeFile([])).toBe("");
    expect(fileName(new Date(Date.UTC(2026, 10, 20, 23)))).toBe("rbitcoin-labels-2026-11-20.jsonl");
    expect(fileName(new Date(Number.NaN))).toBe("rbitcoin-labels.jsonl");
  });
});
