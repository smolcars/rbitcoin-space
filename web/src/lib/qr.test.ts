import { describe, expect, it } from "vitest";
import { encodeQr, fitVersion, type Level } from "./qr";

// Reference codes from an independent encoder, python-qrcode (fixtures/qr).
interface Reference {
  name: string;
  text: string;
  level: Level;
  mask: number;
  version: number;
  rows: string[];
}
const references =
  Object.values(
    import.meta.glob<{ codes: Reference[] }>("../../../fixtures/qr/reference.json", {
      eager: true,
      import: "default",
    }),
  )[0]?.codes ?? [];

/** The code's rows in the fixture's form: hex, padded with light modules to a whole digit. */
function hexRows(dark: Uint8Array, size: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let bits = "";
    for (let x = 0; x < size; x++) bits += String(dark[y * size + x]);
    bits += "0".repeat((4 - (size % 4)) % 4);
    let hex = "";
    for (let i = 0; i < bits.length; i += 4)
      hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
    rows.push(hex);
  }
  return rows;
}

describe("encodeQr", () => {
  it("has the reference codes", () => {
    expect(references).toHaveLength(8);
  });

  it.each(references.map((r) => [r.name, r] as const))("matches python-qrcode: %s", (_, r) => {
    const code = encodeQr(r.text, r.level, { mask: r.mask });
    expect(code?.version).toBe(r.version);
    expect(code?.size).toBe(r.version * 4 + 17);
    expect(code && hexRows(code.dark, code.size)).toStrictEqual(r.rows);
  });

  it("picks one of the eight masks by itself, and the same version", () => {
    for (const r of references) {
      const code = encodeQr(r.text, r.level);
      expect(code?.version).toBe(r.version);
      expect(code?.mask).toBeGreaterThanOrEqual(0);
      expect(code?.mask).toBeLessThan(8);
    }
  });

  it("starts at the version asked for", () => {
    expect(encodeQr("hello", "Q", { minVersion: 3 })?.version).toBe(3);
  });

  it("refuses what no version holds", () => {
    expect(encodeQr("x".repeat(2953), "L")?.version).toBe(40);
    expect(encodeQr("x".repeat(2954), "L")).toBeNull();
  });
});

describe("fitVersion", () => {
  it("holds the longest connect string the node page can show at level Q", () => {
    // 66 hex, "@", and an address cut at 128 characters (NodePage.tsx).
    expect(fitVersion(66 + 1 + 128, "Q")).toBe(12);
    expect(fitVersion(134, "Q")).toBe(10);
  });
});
