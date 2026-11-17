// The flow's cards and the inspector on recorded transactions: where chain text shows, and that it
// is only ever text.
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { mount } from "../../components/test-utils";
import { groupDigits } from "../../lib/format";
import { Flow, type Side } from "./Flow";
import { Inspector } from "./Inspector";
import { type Sample, sample } from "./testdata";

const pool = sample("coinbase-pool");
const genesis = sample("genesis");
const image = sample("inscription-image");
const inscription = sample("inscription-text");
const binary = sample("opreturn-binary");
const long = sample("opreturn-long");
const short = sample("opreturn-short");

/** The card at `index` on `side`, and the inspector opened on it. */
function show(s: Sample, side: Side, index: number) {
  const { tx, outspends } = s;
  const selected = { side, index };
  const el = mount(() => (
    <div>
      <Flow tx={tx} outspends={() => outspends} selected={selected} onSelect={() => {}} />
      <Inspector
        tx={tx}
        selected={selected}
        outspends={() => outspends}
        onClose={() => {}}
        ref={() => {}}
      />
    </div>
  ));
  flush();
  const col = el.querySelector(`.tx-flow__col--${side}`);
  const card = col?.querySelectorAll(".tx-flow__item")[index];
  const inspector = el.querySelector("#tx-inspector");
  if (!card || !inspector) throw new Error("not drawn");
  // No image, frame or link from the data: text nodes only.
  expect(el.querySelectorAll("img, svg image, iframe, object, embed, script")).toHaveLength(0);
  return {
    card: card.textContent,
    memo: card.querySelector(".tx-flow__memo")?.textContent ?? null,
    inspector: inspector.textContent,
    well: (label: string) =>
      [...inspector.querySelectorAll(".tx-code")]
        .find((c) => c.querySelector(".tx-code__label")?.textContent === label)
        ?.querySelector(".tx-text")?.textContent ?? null,
  };
}

/** A copy of `s` whose first input reveals an inscription of `type` holding `body`. */
function inscribed(s: Sample, type: string, body: string): Sample {
  const t = s.tx;
  const bytes = (v: string) => [...new TextEncoder().encode(v)];
  const push = (d: number[]) => [d.length, ...d];
  const script = [
    0x00,
    0x63,
    ...push(bytes("ord")),
    ...push([1]),
    ...push(bytes(type)),
    0x00,
    ...push(bytes(body)),
    0x68,
    0x51,
  ];
  const hex = script.map((b) => b.toString(16).padStart(2, "0")).join("");
  const [first, ...rest] = t.vin ?? [];
  if (!first) throw new Error("no input");
  const vin = [{ ...first, witness: ["11".repeat(64), hex, `c1${"02".repeat(32)}`] }, ...rest];
  return { ...s, tx: { ...t, vin } };
}

describe("chain text on the cards and in the inspector", () => {
  it("genesis coinbase: the headline, and no block height in its script", () => {
    const v = show(genesis, "in", 0);
    expect(v.memo).toBe("“The Times 03/Jan/2009 Chancellor on brink of second bailout for banks”");
    expect(v.card).toContain("Coinbase");
    expect(v.well("Coinbase text")).toBe(
      "The Times 03/Jan/2009 Chancellor on brink of second bailout for banks",
    );
    expect(v.inspector).not.toContain("Block height in script");
  });

  it("pool coinbase: the pool's words and its height", () => {
    const v = show(pool, "in", 0);
    expect(v.memo).toBe("“Mined by Luxor”");
    expect(v.well("Coinbase text")).toBe("Mined by Luxor");
    expect(v.inspector).toContain(`Block height in script${groupDigits(976_294)}`);
  });

  it("short and long OP_RETURN text: quoted under the card, whole in the inspector", () => {
    const s = show(short, "out", 1);
    expect(s.card).toMatch(/^OP_RETURN/);
    expect(s.memo).toBe("“consolidate”");
    expect(s.well("OP_RETURN text")).toBe("consolidate");
    const l = show(long, "out", 1);
    const whole = "=:TRON.USDT:TB16WVMyk93X1MbjAni4kMxcsvLdsuoVQQ:1518979383542/1/0";
    expect(l.memo).toBe(`“${whole}”`);
    expect(l.well("OP_RETURN text")).toBe(whole);
  });

  it("binary OP_RETURN: named by its size, shown as hex only", () => {
    const v = show(binary, "out", 0);
    expect(v.card).toMatch(/^OP_RETURN, 42 bytes/);
    expect(v.memo).toBeNull();
    expect(v.well("OP_RETURN text")).toBeNull();
    expect(v.inspector).toContain("Data42 B");
  });

  it("text inscription: under the input that reveals it, whole in the inspector", () => {
    const v = show(inscription, "in", 0);
    expect(v.memo).toMatch(/^Inscription “\{"p":"brc-20"/);
    expect(v.inspector).toContain("Inscriptiontext/plain;charset=utf-8");
    expect(v.well("Inscription text")).toContain('"p":"brc-20"');
    expect(v.inspector).not.toContain("not shown");
  });

  it("JSON inscription: shown as text", () => {
    const json = '{"name":"<b>bold</b>","rtl":"‮"}';
    const v = show(inscribed(inscription, "application/json", json), "in", 0);
    expect(v.memo).toBe('Inscription “{"name":"<b>bold</b>","rtl":"\\u{202e}"}”');
    expect(v.well("Inscription text")).toBe('{"name":"<b>bold</b>","rtl":"\\u{202e}"}');
    expect(v.inspector).toContain("Inscriptionapplication/json");
  });

  it("image inscription: its type and size only, never the image", () => {
    const v = show(image, "in", 0);
    expect(v.memo).toBe("Inscription, image/png, 793 B");
    expect(v.inspector).toContain("Inscriptionimage/png793 B, not shown");
    expect(v.well("Inscription text")).toBeNull();
  });

  it("hostile text inscription: markup and bidi characters stay text", () => {
    const html = "<script>alert(1)</script><img src=x onerror=alert(2)>‮";
    const v = show(inscribed(inscription, "text/html", html), "in", 0);
    const shown = "<script>alert(1)</script><img src=x onerror=alert(2)>\\u{202e}";
    expect(v.memo).toBe(`Inscription “${shown}”`);
    expect(v.well("Inscription text")).toBe(shown);
    // An SVG is an image: never drawn, whatever it holds.
    const svg = show(inscribed(inscription, "image/svg+xml", "<svg onload=alert(3)/>"), "in", 0);
    expect(svg.memo).toBe("Inscription, image/svg+xml, 22 B");
  });
});
