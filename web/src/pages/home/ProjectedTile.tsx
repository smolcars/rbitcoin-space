import { type Accessor, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import { Amount } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { type Layer, Strata, strataLayers, strataMark, strataSide } from "../../components/Strata";
import "../../components/BlockBox.css";
import { formatFeeRate, groupDigits } from "../../lib/format";
import { Link } from "../../components/Link";
import { type Network, paths } from "../../lib/network";
import type { ProjectedTile as Tile } from "./projection";

const MAX_WEIGHT = 4_000_000;
/** The thinnest layer, as a share of a tile's box (about 160 px): 2 px, so one transaction shows. */
export const TILE_LAYER_MIN = 0.0125;
const ORDINALS = ["Next block", "Second block", "Third block", "Fourth block"];

/** A tile's heading: when its block is expected. Regtest has no block interval to count in. */
export function projectedTitle(t: Pick<Tile, "slot" | "blocks">, network: Network): string {
  if (t.blocks > 1) return `+${groupDigits(t.blocks)} blocks`;
  if (t.slot === 0) return "Next block";
  return network === "regtest" ? (ORDINALS[t.slot] ?? "Later") : `In ~${(t.slot + 1) * 10} min`;
}

/** What a screen reader hears for a tile. */
export function projectedLabel(t: Tile, network: Network): string {
  const title = projectedTitle(t, network);
  if (t.txs === 0) return `${title}, projected: nothing waiting`;
  const txs = `${groupDigits(t.txs)} ${t.txs === 1 ? "transaction" : "transactions"}`;
  return `${title}, projected: ${txs}, median fee about ${formatFeeRate(t.medianRate)} sat/vB, fee range ${formatFeeRate(t.minRate)} to ${formatFeeRate(t.maxRate)} sat/vB`;
}

/** Whether two sets of layers draw the same, so their elements (and any settling) can stay. */
export const sameLayers = (a: readonly Layer[], b: readonly Layer[]) =>
  a.length === b.length &&
  a.every((l, i) => {
    const m = b[i];
    return !!m && m.band === l.band && Math.abs(m.y - l.y) < 1e-4 && Math.abs(m.h - l.h) < 1e-4;
  });

/** A projected block's layers, as tall as it is full. */
export const projectedLayers = (t: Pick<Tile, "bands" | "weight">): Layer[] =>
  strataLayers(t.bands, Math.min(1, t.weight / MAX_WEIGHT), TILE_LAYER_MIN);

/**
 * A projected block: dashed and open, its figures approximate. It opens that block's page; the
 * last tile opens the first block it holds. Its figures change in place as the mempool does; only
 * a tile that forms after the strip is drawn lets its layers settle in.
 */
export function ProjectedTile(props: {
  tile: Accessor<Tile | undefined>;
  network: Network;
  settle: boolean;
}) {
  const t = () => props.tile();
  // Figures change every couple of seconds; layers that did not move keep their elements.
  const layers = createMemo<Layer[]>(
    () => {
      const tile = t();
      return tile ? projectedLayers(tile) : [];
    },
    { equals: sameLayers },
  );
  // Whether this tile formed after the strip was drawn is decided once, when it mounts.
  const [settling, setSettling] = createSignal(untrack(() => props.settle));
  // Only the first drawing settles: the layers are redrawn when the mempool changes.
  const done = setTimeout(() => setSettling(false), 2_000);
  onCleanup(() => clearTimeout(done));
  return (
    <Show when={t()}>
      {(tile) => (
        <li
          class={["home-tile home-tile--projected", { "home-tile--empty": tile().txs === 0 }]}

          data-key={tile().key}
        >
          <Link
            class="home-tile__body block-box"
            href={paths.projected(tile().slot + 1)}
            aria-label={projectedLabel(tile(), props.network)}
          >
            {/* First, so the figures paint over the layers it fills the box with. */}
            <span
              class="home-tile__strata block-box__core"
              style={{ "--core-side": strataSide(layers()), ...strataMark(layers()) }}
            >
              <Show
                when={layers().length > 0}
                fallback={<span class="home-tile__fill home-tile__fill--floor" />}
              >
                <span class="home-tile__tint">
                  <span class="home-tile__layers">
                    <Strata layers={layers()} settle={settling()} />
                  </span>
                </span>
              </Show>
            </span>
            <span class="home-tile__title">{projectedTitle(tile(), props.network)}</span>
            <span class="home-tile__fee num">
              <Show when={tile().txs > 0} fallback="Nothing waiting">
                <FeeRate rate={tile().medianRate} approx />
              </Show>
            </span>
            <Show when={tile().txs > 0}>
              <span class="home-tile__range num">
                {`${formatFeeRate(tile().minRate)} – ${formatFeeRate(tile().maxRate)}`}
              </span>
              <span class="home-tile__fees">
                <Amount sats={tile().fees} short approx />
              </span>
            </Show>
            <span class="home-tile__foot">
              <span class="num">{groupDigits(tile().txs)} tx</span>
              <span>{tile().slot === 0 && props.network !== "regtest" ? "~10 min" : ""}</span>
            </span>
          </Link>
          <span class="home-tile__pool" />
        </li>
      )}
    </Show>
  );
}
