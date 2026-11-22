import { For } from "solid-js";
import { FEE_KEY_BOUNDS, formatFeeRate, formatSize, widenBands } from "../lib/format";
import "./Strata.css";

/** One layer: its fee band (1–12), and where it sits as fractions of the frame's height. */
export interface Layer {
  band: number;
  /** Band 1 of a block stored before the lowest band was split: everything under 0.2 sat/vB. */
  unsplit: boolean;
  /** Bottom edge, from the frame's floor. */
  y: number;
  /** Thickness. */
  h: number;
  /** Near the floor: drawn without the seam above it, so its color still shows. */
  thin: boolean;
}

/**
 * The strata of a block (docs/DESIGN.md "Idea"): each fee band with any virtual size becomes a
 * layer, cheapest at the bottom, as thick as its share of the block, the stack as high as `fill`
 * (how full the block is, 0–1), and at least one hairline (`min`) so a block with any paying
 * transaction shows something. Where there is room, a layer is never thinner than `min`, so one
 * transaction in a band still shows, its thickness taken from the thicker layers. Where there is
 * not (a nearly empty block), the stack keeps the block's true height and the layers share it by
 * size: the fill height stays honest, and bands too small to see are deliberately not drawn
 * thicker. Empty bands get no layer.
 */
export function strataLayers(given: readonly number[], fill: number, min: number): Layer[] {
  const { bands, unsplit } = widenBands(given);
  const held = bands
    .map((vsize, i) => ({ band: i + 1, vsize: Number.isFinite(vsize) && vsize > 0 ? vsize : 0 }))
    .filter((b) => b.vsize > 0);
  if (held.length === 0) return [];
  const hairline = Math.min(Math.max(0, min), 1);
  const top = Math.min(1, Math.max(Number.isFinite(fill) ? fill : 0, hairline));
  const floor = held.length * hairline <= top ? hairline : 0;
  // Layers below the floor are raised to it and the rest share what is left, until none is below.
  const thin = new Set<number>();
  let h: number[] = [];
  for (let pass = 0; pass <= held.length; pass++) {
    const rest = top - thin.size * floor;
    const restVsize = held.reduce((sum, b, i) => (thin.has(i) ? sum : sum + b.vsize), 0);
    h = held.map((b, i) => (thin.has(i) ? floor : (b.vsize / restVsize) * rest));
    const below = h.findIndex((x, i) => !thin.has(i) && x < floor);
    if (below === -1) break;
    for (const [i, x] of h.entries()) if (x < floor) thin.add(i);
  }
  let y = 0;
  return held.map((b, i) => {
    const thick = h[i] ?? 0;
    const layer = {
      band: b.band,
      unsplit: unsplit && b.band === 1,
      y,
      h: thick,
      thin: thick < hairline * 2,
    };
    y += layer.h;
    return layer;
  });
}

/** The top of a stack of layers, 0 when there are none. */
export const strataTop = (layers: readonly Layer[]): number => {
  const last = layers.at(-1);
  return last ? last.y + last.h : 0;
};

/**
 * The layers as a CSS gradient from the floor up, for a surface that repeats them without their
 * own elements (a tile's right face, `BlockBox.css`). With no layers, how full the block is, in
 * the neutral gauge's tone; `none` when there is nothing to draw.
 */
export function strataSide(layers: readonly Layer[], fill = 0): string {
  const pct = (x: number) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(2)}%`;
  if (layers.length === 0) {
    if (!(fill > 0)) return "none";
    return `linear-gradient(to top, var(--color-line) 0 ${pct(fill)}, transparent ${pct(fill)})`;
  }
  const stops = layers.map((l) => `var(--fee-${l.band}) ${pct(l.y)} ${pct(l.y + l.h)}`);
  return `linear-gradient(to top, ${stops.join(", ")}, transparent ${pct(strataTop(layers))})`;
}

/**
 * Where a stack of layers tops out, and in its top band's colour, for a tile's fill mark
 * (`HomePage.css`). With no layers, how full the block is in the neutral gauge's tone; nothing
 * when there is nothing to mark.
 */
export function strataMark(layers: readonly Layer[], fill = 0): Record<string, string> {
  const top = layers.at(-1);
  if (top)
    return { "--mark-y": strataTop(layers).toFixed(4), "--mark-c": `var(--fee-${top.band})` };
  if (!(fill > 0)) return {};
  return { "--mark-y": Math.min(1, fill).toFixed(4), "--mark-c": "var(--color-line-strong)" };
}

/** A band's range in words: `under 0.20 sat/vB`, `0.50 to 1.00 sat/vB`, `10.0 sat/vB and up`. */
export function bandRange(band: number, unsplit = false): string {
  if (unsplit && band === 1) return "under 0.20 sat/vB";
  const from = FEE_KEY_BOUNDS[band - 1];
  const to = FEE_KEY_BOUNDS[band];
  if (from === undefined) return "";
  if (to === undefined) return `${formatFeeRate(from)} sat/vB and up`;
  if (band === 1) return `under ${formatFeeRate(to)} sat/vB`;
  return `${formatFeeRate(from)} to ${formatFeeRate(to)} sat/vB`;
}

/** The strata as text, one line per band that holds anything: what a screen reader gets. */
export function describeBands(given: readonly number[]): string[] {
  const { bands, unsplit } = widenBands(given);
  const total = bands.reduce((sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (total === 0) return [];
  return bands.flatMap((vsize, i) => {
    if (!(vsize > 0)) return [];
    const share = vsize / total;
    const pct = share < 0.01 ? "under 1%" : `${Math.round(share * 100)}%`;
    return [`${bandRange(i + 1, unsplit)}: ${formatSize(vsize)}, ${pct}`];
  });
}

/**
 * Fee layers drawn into the box that holds them (give it a height). `settle` drops them in one at
 * a time, cheapest first, like sediment; with reduced motion they fade in. `from` grows each layer
 * out of the same band's layer in another set (a projected block resolving into the mined one);
 * a band it lacks grows from nothing.
 * Decorative: put the figures, or {@link describeBands}, beside it as text.
 */
export function Strata(props: {
  layers: readonly Layer[];
  settle?: boolean;
  from?: readonly Layer[] | undefined;
}) {
  const was = (layer: Layer) => props.from?.find((l) => l.band === layer.band);
  return (
    <span
      class={["strata", { "strata--settle": props.settle === true, "strata--morph": !!props.from }]}

      aria-hidden="true"
    >
      <For each={props.layers}>
        {(layer, i) => (
          <span
            class={["strata__layer", { "strata__layer--thin": layer.thin }]}

            style={{
              "--y": String(layer.y),
              "--h": String(layer.h),
              "--c": `var(--fee-${layer.band})`,
              "--i": String(i()),
              "--y0": String(was(layer)?.y ?? layer.y),
              "--h0": String(was(layer)?.h ?? 0),
            }}
          />
        )}
      </For>
    </span>
  );
}
