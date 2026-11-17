import { describe, expect, it } from "vitest";
import type { Transaction, Vin, Vout } from "../../lib/esplora";
import {
  BODY_KEPT,
  ENVELOPE_MAX_OPS,
  coinbaseText,
  envelope,
  inputText,
  inscriptionOf,
  outputText,
  tapscript,
} from "./chaintext";
import { sample } from "./testdata";

const genesis = sample("genesis");
const image = sample("inscription-image");
const text = sample("inscription-text");

const tx = (s: { tx: Transaction }) => s.tx;
const hex = (b: Uint8Array | number[]) =>
  [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
/** A push of `data`, as a script writes it. */
const push = (data: number[]): number[] =>
  data.length <= 75
    ? [data.length, ...data]
    : data.length <= 255
      ? [0x4c, data.length, ...data]
      : [0x4d, data.length & 0xff, data.length >> 8, ...data];
const ENV = [0x00, 0x63, ...push(utf8("ord"))];
const ENDIF = 0x68;
/** An envelope: content type, then the body in pushes of up to 520 bytes. */
const inscribe = (type: string | null, body: number[], extra: number[] = []): number[] => {
  const pieces: number[] = [];
  for (let i = 0; i < body.length; i += 520) pieces.push(...push(body.slice(i, i + 520)));
  return [
    ...ENV,
    ...(type === null ? [] : [...push([1]), ...push(utf8(type))]),
    ...extra,
    0x00,
    ...pieces,
    ENDIF,
  ];
};
const P2TR = `5120${"ab".repeat(32)}`;
const vout = (scriptpubkey: string, value = 0): Vout => ({
  scriptpubkey,
  scriptpubkey_asm: "",
  scriptpubkey_type: "unknown",
  value,
});
const CONTROL = `c0${"02".repeat(32)}`;
/** An input that spends a taproot output by revealing `script`. */
const reveal = (script: number[], more: Partial<Vin> = {}): Vin => ({
  txid: "00".repeat(32),
  vout: 0,
  is_coinbase: false,
  prevout: vout(P2TR, 546),
  witness: ["11".repeat(64), hex(script), CONTROL],
  ...more,
});

describe("envelope", () => {
  it("reads the content type and joins a body in several pushes", () => {
    const body = utf8("x".repeat(1200));
    const ins = envelope(hex(inscribe("text/plain;charset=utf-8", body)));
    expect(ins?.contentType).toBe("text/plain;charset=utf-8");
    expect(ins?.size).toBe(1200);
    expect(new TextDecoder().decode(ins?.head)).toBe("x".repeat(1200));
  });

  it("takes OP_1 as tag 1, skips unknown tags and reads only the first envelope", () => {
    // Tag 2 (pointer), tag 7 (metaprotocol) and an unknown even tag, before tag 1 as OP_1.
    const fields = [
      ...push([2]),
      ...push([1, 0]),
      ...push([7]),
      ...push(utf8("brc-20")),
      ...push([66]),
      ...push([9, 9]),
    ];
    const first = [
      ...ENV,
      ...fields,
      0x51,
      ...push(utf8("text/plain")),
      0x00,
      ...push(utf8("one")),
      ENDIF,
    ];
    const second = inscribe("image/png", [1, 2, 3]);
    const ins = envelope(
      hex([0x20, ...Array.from({ length: 32 }, () => 7), 0xac, ...first, ...second, 0x51]),
    );
    expect(ins?.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(ins?.head)).toBe("one");
  });

  it("reads an envelope with no content type or an empty body", () => {
    expect(envelope(hex(inscribe(null, utf8("hi"))))).toMatchObject({ contentType: "", size: 2 });
    expect(envelope(hex(inscribe("text/plain", [])))).toMatchObject({
      contentType: "text/plain",
      size: 0,
    });
    expect(inputText(reveal(inscribe("text/plain", [])))).toStrictEqual({
      label: "Inscription",
      parts: null,
      about: "text/plain, 0 B",
    });
    expect(inputText(reveal(inscribe(null, utf8("hello"))))?.about).toBe("No content type, 5 B");
  });

  it("finds nothing in a broken envelope, and never throws", () => {
    const good = inscribe("text/plain", utf8("hello"));
    // No OP_ENDIF.
    expect(envelope(hex(good.slice(0, -1)))).toBeNull();
    // A push that runs past the end.
    expect(envelope(hex([...ENV, ...push([1]), 0x20, 1, 2]))).toBeNull();
    // An opcode that pushes nothing, inside the envelope.
    expect(envelope(hex([...ENV, 0xac, 0x00, ...push([1]), ENDIF]))).toBeNull();
    // "ord" spelled otherwise, or not after OP_FALSE OP_IF.
    expect(envelope(hex([0x00, 0x63, ...push(utf8("orc")), 0x00, ENDIF]))).toBeNull();
    expect(envelope(hex([0x63, ...push(utf8("ord")), 0x00, ENDIF]))).toBeNull();
    for (const bad of ["", "zz", "0063", "00630", "4dffff", "0063036f7264"])
      expect(() => envelope(bad)).not.toThrow();
  });

  it("bounds its work and what it keeps", () => {
    const nops = Array.from({ length: ENVELOPE_MAX_OPS }, () => 0x61);
    expect(envelope(hex([...nops, ...inscribe("text/plain", utf8("late"))]))).toBeNull();
    const big = inscribe(
      "image/png",
      Array.from({ length: BODY_KEPT + 4000 }, () => 0x41),
    );
    const ins = envelope(hex(big));
    expect(ins?.size).toBe(BODY_KEPT + 4000);
    expect(ins?.head.length).toBe(BODY_KEPT);
  });
});

describe("tapscript", () => {
  const script = inscribe("text/plain", utf8("hello"));
  it("is the item before the control block, past an annex", () => {
    expect(tapscript(reveal(script))).toBe(hex(script));
    const vin = reveal(script);
    vin.witness = [...(vin.witness ?? []), "50aa"];
    expect(tapscript(vin)).toBe(hex(script));
  });

  it("is nothing for a key-path spend, another script type or a malformed control block", () => {
    expect(tapscript(reveal(script, { witness: ["11".repeat(64)] }))).toBeNull();
    expect(tapscript(reveal(script, { prevout: vout(`0014${"ab".repeat(20)}`, 1) }))).toBeNull();
    expect(
      tapscript(reveal(script, { witness: [hex(script), `c0${"02".repeat(31)}`] })),
    ).toBeNull();
    expect(
      tapscript(reveal(script, { witness: [hex(script), `a0${"02".repeat(32)}`] })),
    ).toBeNull();
    expect(inscriptionOf(reveal(script, { witness: [] }))).toBeNull();
  });
});

describe("chain text", () => {
  it("shows text and JSON inscriptions as text, hostile characters made visible", () => {
    const hostile = "<img src=x onerror=alert(1)>‮";
    expect(inputText(reveal(inscribe("text/html", utf8(hostile))))?.parts).toStrictEqual([
      { text: "<img src=x onerror=alert(1)>\\u{202e}" },
    ]);
    const json = '{"p":"brc-20","op":"mint"}';
    expect(inputText(reveal(inscribe("application/json", utf8(json))))?.parts).toStrictEqual([
      { text: json },
    ]);
    // The content type is attacker text too.
    expect(inscriptionOf(reveal(inscribe("image/png‮<b>", [1])))?.contentType).toBe(
      "image/png\\u{202e}<b>",
    );
  });

  it("names anything else by type and size: images, other types, compressed or binary text", () => {
    const about = (type: string, body: number[], extra: number[] = []) =>
      inputText(reveal(inscribe(type, body, extra)));
    expect(about("image/svg+xml", utf8("<svg onload=alert(1)/>"))).toStrictEqual({
      label: "Inscription",
      parts: null,
      about: "image/svg+xml, 22 B",
    });
    expect(about("application/javascript", utf8("alert(1)"))?.parts).toBeNull();
    expect(about("text/plain", [0xff, 0xfe, 0x00, 0x01, 0x02])?.parts).toBeNull();
    // Tag 9: the body is brotli, never read as text here.
    expect(
      about("text/plain", utf8("hello"), [...push([9]), ...push(utf8("br"))])?.parts,
    ).toBeNull();
  });

  it("cuts a card's text and marks the cut", () => {
    const parts = inputText(reveal(inscribe("text/plain", utf8("y".repeat(500)))), 10)?.parts;
    expect(parts).toStrictEqual([{ text: `${"y".repeat(10)}…` }]);
  });

  it("reads the recorded inscriptions", () => {
    const t = tx(text).vin?.[0];
    const i = tx(image).vin?.[0];
    if (!t || !i) throw new Error("no input");
    expect(inscriptionOf(t)?.contentType).toBe("text/plain;charset=utf-8");
    const first = inputText(t)?.parts?.[0];
    expect(first && "text" in first ? first.text : "").toContain('"p":"brc-20"');
    expect(inputText(i)).toStrictEqual({
      label: "Inscription",
      parts: null,
      about: "image/png, 793 B",
    });
  });

  it("reads the genesis headline without the push bytes", () => {
    expect(coinbaseText(tx(genesis))?.parts).toStrictEqual([
      { text: "The Times 03/Jan/2009 Chancellor on brink of second bailout for banks" },
    ]);
  });

  it("reads OP_RETURN text, and names binary data by its size", () => {
    const op = (data: number[]) => vout(hex([0x6a, ...push(data)]));
    expect(outputText(op(utf8("consolidate")))).toStrictEqual({
      label: "OP_RETURN",
      parts: [{ text: "consolidate" }],
      about: null,
    });
    expect(outputText(op(Array.from({ length: 44 }, (_, k) => k)))?.about).toBe("44 bytes");
    expect(outputText(vout(P2TR, 1))).toBeNull();
  });
});
