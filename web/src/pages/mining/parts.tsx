// Pieces the mining page and a pool's page share.
import { lazy, Loading as Pending, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ChartProps } from "../../components/chart/Chart";
import { formatSi, readoutLines } from "../../components/chart/scale";
import { Link } from "../../components/Link";
import { Empty, ErrorState, Loading } from "../../components/States";
import type { Coverage } from "../../lib/api";
import { formatBtc, formatBtcScale, formatSize } from "../../lib/format";
import { paths } from "../../lib/network";
import { NoHistoryError } from "./data";
import { coverageNote, type Period } from "./mining";

/** The chart loads only on pages that draw one. */
export const Chart = lazy(() => import("../../components/chart/Chart"));

/**
 * A chart's whole height, `h` px of plot: what a section holding one reserves. The readout's part
 * (`--readout`, MiningPage.css) grows with its lines on a phone, where each reading has its own.
 */
export const chartHeight = (h: number): string => `calc(${h}px + var(--readout))`;

/** A chart, its space held while its code loads, so nothing below moves. */
export function ChartSlot(props: ChartProps) {
  return (
    <div
      class="mining-chart"
      style={{ "--h": `${props.height ?? 240}px`, "--lines": readoutLines(props) }}
    >
      <Pending>
        <Chart {...props} />
      </Pending>
    </div>
  );
}

/** Where a section's data stops short of the period asked for, said beside it. */
export function CoverageNote(props: { coverage: Coverage | undefined; period: Period }) {
  return (
    <Show when={coverageNote(props.coverage, props.period)}>
      {(text) => (
        <p class="mining-coverage">
          <span class="mining-coverage__swatch" aria-hidden="true" />
          {text()}
        </p>
      )}
    </Show>
  );
}

/** A section's data failed: why, and a retry; or the server keeps no history at all. */
export function Failure(props: { what: string; error: unknown; retry: () => void }) {
  return (
    <Show
      when={!(props.error instanceof NoHistoryError)}
      fallback={
        <Empty title="This server keeps no mining history">
          Mining figures come from a table of every block, which this server was started without.
        </Empty>
      }
    >
      <ErrorState title={`Could not load ${props.what}`} error={props.error} retry={props.retry} />
    </Show>
  );
}

/**
 * A section's state while its data is not here: loading, failed, or here. Children render once
 * there is an answer, and keep the last one while the next loads.
 */
export function Section(props: {
  what: string;
  ready: boolean;
  error: unknown;
  retry: () => void;
  busy: boolean;
  /** The height the content will take (a CSS length), held while it loads so nothing moves. */
  reserve: string;
  /** Keep that height once loaded too, as for a chart, whose height is known. Default true. */
  hold?: boolean;
  children: JSX.Element;
}) {
  return (
    <div
      class={["mining-slot", { "mining-slot--loose": props.hold === false && props.ready }]}

      style={{ "--reserve": props.reserve }}
    >
      <Show
        when={props.error === undefined}
        fallback={<Failure what={props.what} error={props.error} retry={props.retry} />}
      >
        <Show when={props.ready} fallback={<Loading label={`Loading ${props.what}`} />}>
          <div class="mining-busy" aria-busy={props.busy ? "true" : "false"}>
            {props.children}
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** Nothing stored for the period: say so, and offer all of what is stored. */
export function NothingStored(props: { what: string; period: Period }) {
  return (
    <Empty title={`No ${props.what} stored for ${props.period.words}`}>
      <Show when={props.period.id !== "all"}>
        <Link class="tap" href={paths.mining("all")}>
          See all stored history
        </Link>
      </Show>
    </Empty>
  );
}

/** A label over a large figure, and a muted line under it. */
export function Stat(props: { label: string; children: JSX.Element; sub?: JSX.Element }) {
  return (
    <div class="mining-stat">
      <dt class="mining-stat__label">{props.label}</dt>
      <dd class="mining-stat__value">
        {props.children}
        <Show when={props.sub}>
          <span class="mining-stat__sub">{props.sub}</span>
        </Show>
      </dd>
    </div>
  );
}

// Formats for chart axes and readouts.

/** BTC without the zeros a round tick does not need, for axis ticks: `0.025 BTC`, `3 BTC`. */
export const btcShort = (sats: number): string => `${formatBtcScale(Math.round(sats))} BTC`;
/** BTC exact, all eight decimals grouped, for readouts. */
export const btcFull = (sats: number): string => `${formatBtc(Math.round(sats))} BTC`;
export const difficultyShort = (d: number): string => formatSi(d, "");
export const difficultyFull = (d: number): string => formatSi(d, "", 5);
export const bytesText = (b: number): string => formatSize(b, "B");
export const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`;
