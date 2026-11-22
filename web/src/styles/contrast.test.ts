// WCAG AA contrast, computed from the design tokens in both themes (docs/DESIGN.md "Color").
import { describe, expect, it } from "vitest";
import tokens from "../../../design/tokens.css?raw";

/** The six-digit colours declared in the block that opens with `opening`. */
function block(opening: string): Map<string, string> {
  const start = tokens.indexOf(opening);
  if (start === -1) throw new Error(`tokens.css has no ${opening}`);
  const body = tokens.slice(start, tokens.indexOf("}", start));
  return new Map(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

const linear = (c: number) => (c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
type Rgb = [number, number, number];
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `color-mix(in srgb, a share, b)`, as the network band mixes its tint. */
const mix = (a: Rgb, share: number, b: Rgb): Rgb =>
  a.map((v, i) => v * share + (b[i] ?? 0) * (1 - share)) as Rgb;

const light = block(":root {");
const dark = new Map([...light, ...block(':root[data-theme="dark"] {')]);
const SURFACES = ["color-bg", "color-surface", "color-surface-raised", "color-surface-sunken"];
const TEXT = [
  "color-text",
  "color-text-muted",
  "color-positive",
  "color-caution",
  "color-negative",
  "color-accent",
  "color-live",
];
const range = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}-${i + 1}`);
/** Marks that carry meaning: control borders, the focus ring, fee bands, series, pools, networks. */
const MARKS = [
  "color-line-strong",
  "color-focus",
  ...range("fee", 12),
  ...range("series", 3),
  "ln-caution",
  "ln-age",
  ...range("pool", 12),
  "pool-other",
  "network-signet",
  "network-testnet4",
  "network-testnet5",
  "network-regtest",
];

/** Every pair below `least`, as "fg on bg 4.21". */
function short(theme: Map<string, string>, fg: string[], bg: string[], least: number): string[] {
  const hex = (n: string) => {
    const v = theme.get(n);
    if (!v) throw new Error(`no token --${n}`);
    return rgb(v);
  };
  return fg.flatMap((f) =>
    bg
      .map((b) => ({ b, r: ratio(hex(f), hex(b)) }))
      .filter(({ r }) => r < least)
      .map(({ b, r }) => `${f} on ${b} ${r.toFixed(2)}`),
  );
}

describe("contrast from the tokens", () => {
  it("keeps the two copies of the dark theme identical", () => {
    const os = block('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
    expect(os).toStrictEqual(block(':root[data-theme="dark"] {'));
    // The tile tint is a number, not a colour, so block() leaves it out.
    const tint = (opening: string) => {
      const start = tokens.indexOf(opening);
      return /--tile-tint: ([\d.]+)/.exec(tokens.slice(start, tokens.indexOf("}", start)))?.[1];
    };
    expect(tint('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {')).toBe(
      tint(':root[data-theme="dark"] {'),
    );
  });

  describe.each([
    ["light", light],
    ["dark", dark],
  ] as const)("%s", (name, theme) => {
    it(`reaches 4.5:1 for text and 3:1 for meaningful marks on every surface, ${name}`, () => {
      expect(short(theme, TEXT, SURFACES, 4.5)).toStrictEqual([]);
      // A new row's highlight sits under ordinary text, never under the live dot.
      expect(short(theme, TEXT.slice(0, 6), ["color-accent-soft"], 4.5)).toStrictEqual([]);
      expect(short(theme, ["color-on-accent"], ["color-accent"], 4.5)).toStrictEqual([]);
      expect(short(theme, MARKS, SURFACES, 3)).toStrictEqual([]);
      // A QR code's card stays light in both themes (components/qr/draw.ts holds a node's ink to this).
      expect(short(theme, ["qr-ink"], ["qr-paper"], 4.5)).toStrictEqual([]);
    });

    it(`keeps a block tile's figures readable over its tinted layers, ${name}`, () => {
      const scope = name === "light" ? ":root {" : ':root[data-theme="dark"] {';
      const start = tokens.indexOf(scope);
      const body = tokens.slice(start, tokens.indexOf("}", start));
      const tint = Number(/--tile-tint: ([\d.]+)/.exec(body)?.[1]);
      expect(tint).toBeGreaterThan(0);
      const hex = (n: string) => rgb(theme.get(n) ?? "");
      // Mined tiles are the surface, projected ones the strip's sunken band; the neutral gauge is
      // the line tone, under the figures until the layers arrive.
      const faint: string[] = [];
      for (const text of ["color-text", "color-text-muted"]) {
        const under = [
          ...["color-surface", "color-surface-sunken"].flatMap((s) =>
            range("fee", 12).map((f) => [`${f} on ${s}`, mix(hex(f), tint, hex(s))] as const),
          ),
          ["color-line", hex("color-line")] as const,
        ];
        for (const [what, bg] of under) {
          const r = ratio(hex(text), bg);
          if (r < 4.5) faint.push(`${text} over ${what} ${r.toFixed(2)}`);
        }
      }
      expect(faint).toStrictEqual([]);
    });

    it(`steps the forwarding-rate ramp in lightness, away from the surface, ${name}`, () => {
      const lum = range("ln-ppm", 6).map((n) => luminance(rgb(theme.get(n) ?? "")));
      // Darker step by step on a light page, lighter on a dark one: each step apart from the last.
      const steps = lum.slice(1).map((l, i) => {
        const prev = lum[i] ?? 0;
        return name === "light" ? (prev + 0.05) / (l + 0.05) : (l + 0.05) / (prev + 0.05);
      });
      expect(steps.filter((r) => r < 1.15)).toStrictEqual([]);
      expect(short(theme, ["ln-ppm-6"], SURFACES, 3)).toStrictEqual([]);
    });

    it(`fades the age ramp into the surface in even steps, ${name}`, () => {
      const surface = rgb(theme.get("color-surface") ?? "");
      const age = rgb(theme.get("ln-age") ?? "");
      // tokens.css mixes --ln-age into the surface at these shares, youngest first.
      const lum = [1, 0.74, 0.52, 0.34, 0.2].map((k) => ratio(mix(age, k, surface), surface));
      const steps = lum.slice(1).map((l, i) => (lum[i] ?? 0) / l);
      expect(steps.filter((r) => r < 1.15)).toStrictEqual([]);
      expect(tokens).toContain(
        "--ln-age-5: color-mix(in srgb, var(--ln-age) 20%, var(--color-surface));",
      );
    });

    it(`keeps a test network's band readable, ${name}`, () => {
      const surface = rgb(theme.get("color-surface") ?? "");
      for (const net of ["signet", "testnet4", "testnet5", "regtest"]) {
        const colour = rgb(theme.get(`network-${net}`) ?? "");
        const band = mix(colour, 0.12, surface);
        expect(ratio(rgb(theme.get("color-text") ?? ""), band), `text on ${net}`).toBeGreaterThan(
          4.5,
        );
        expect(ratio(colour, band), `${net}'s edge on its band`).toBeGreaterThan(3);
      }
    });

    it(`keeps the palette's glass readable over any page, ${name}`, () => {
      // The page under the panel is veiled, blurred, then seen through the glass, and the selected
      // row's tint lies over that: the page's darkest and lightest pixels bound every mix the blur
      // can make of it. (The blur's saturation is left out: it keeps a grey grey.)
      const css = (token: string): [Rgb, number] => {
        const scope = name === "light" ? ":root {" : ':root[data-theme="dark"] {';
        const start = tokens.indexOf(scope);
        const body = tokens.slice(start, tokens.indexOf("}", start));
        const m = new RegExp(`--${token}: rgb\\((\\d+) (\\d+) (\\d+) / ([\\d.]+)\\)`).exec(body);
        if (!m) throw new Error(`no --${token} in ${name}`);
        return [[Number(m[1]), Number(m[2]), Number(m[3])], Number(m[4])];
      };
      const [veil, dim] = css("color-veil");
      const [glass, alpha] = css("color-glass");
      const [lit, glow] = css("color-glass-lit");
      const faint: string[] = [];
      for (const page of [
        [0, 0, 0],
        [255, 255, 255],
      ] as Rgb[]) {
        const pane = mix(glass, alpha, mix(veil, dim, page));
        for (const [where, under] of [
          ["pane", pane],
          ["selected row", mix(lit, glow, pane)],
        ] as const) {
          for (const text of ["color-text", "color-text-muted", "color-accent"]) {
            const r = ratio(rgb(theme.get(text) ?? ""), under);
            if (r < 4.5)
              faint.push(`${text} on the ${where} over ${page.join(" ")}: ${r.toFixed(2)}`);
          }
        }
      }
      expect(faint).toStrictEqual([]);
    });
  });
});
