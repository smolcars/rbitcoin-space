import { createMemo, createSignal, lazy, Loading as Pending, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { ErrorState } from "../../components/States";
import { formatSize, groupDigits } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import type { Feed } from "./feeds";
import {
  depthRows,
  type FeeBandShare,
  type MempoolFigures,
  nextBlockReach,
  sharesOf,
} from "./mempool";

const BLOCK_VSIZE = 1_000_000;

/** How many blocks the mempool would fill: `≈ 31 blocks`, `≈ 1 block`. */
export function blocksOf(vsize: number): string {
  if (vsize <= 0) return "empty";
  const n = Math.ceil(vsize / BLOCK_VSIZE);
  return `≈ ${groupDigits(n)} ${n === 1 ? "block" : "blocks"}`;
}

/** A band's range in sat/vB, as short as a row allows: `10+`, `0.5–1`, `< 0.2`. */
export function rangeLabel(b: FeeBandShare): string {
  if (b.to === null) return `${b.from}+`;
  if (b.band === 1) return `< ${b.to}`;
  return `${b.from}–${b.to}`;
}

/** The pictures' code, one lazy file for both (visuals.tsx). */
const visuals = () => import("./visuals");
const NextBlockMap = lazy(() => visuals().then((m) => ({ default: m.NextBlockMap })));
const IncomingChart = lazy(() => visuals().then((m) => ({ default: m.IncomingChart })));

/** The chart's plot, in px: with the readout above that names it, as tall as the map. */
const CHART_HEIGHT = 168;
const CHART_HEIGHT_PHONE = 160;

/**
 * Mempool: the next projected block's map, headed by the fee rate its worth reaches down to, four
 * figures, and what has been arriving over the last two hours, side by side where they fit, each
 * a fixed height. The pictures load once the panel comes near the view.
 */
export function MempoolPanel(props: { feed: Feed<MempoolFigures>; network: Network }) {
  const m = () => props.feed.data();
  const rows = createMemo(() => depthRows(m()?.bands ?? sharesOf([])));
  const phone = typeof matchMedia === "function" && matchMedia("(max-width: 40em)").matches;
  const [near, setNear] = createSignal(false);
  let pictures: HTMLDivElement | undefined;
  onSettled(() => {
    if (!pictures) return undefined;
    // Without the observer (an old browser, the unit tests' document), the pictures load at once.
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(pictures);
    return () => io.disconnect();
  });

  return (
    <section class="home-mempool" aria-labelledby="mempool-title">
      <SectionHeader title="Mempool" id="mempool-title">
        <Link href={paths.mempool()}>Mempool history</Link>
      </SectionHeader>
      <Show
        when={m() ?? props.feed.error() === undefined}
        fallback={
          <ErrorState
            title="Could not load the mempool"
            error={props.feed.error()}
            retry={props.feed.refresh}
          />
        }
      >
        <dl class="home-stats" aria-busy={m() ? "false" : "true"}>
          <Stat label="Transactions">
            <Show when={m()}>{(s) => <span class="num">{groupDigits(s().count)}</span>}</Show>
          </Stat>
          <Stat label="Size">
            <Show when={m()}>
              {(s) => (
                <>
                  <span class="num">{formatSize(s().vsize)}</span>
                  <span class="home-stat__sub num">{blocksOf(s().vsize)}</span>
                </>
              )}
            </Show>
          </Stat>
          <Stat label="Fees waiting">
            <Show when={m()}>{(s) => <Amount sats={s().fees} short />}</Show>
          </Stat>
          <Stat label="Lowest accepted">
            <Show when={m()}>
              {(s) => (
                <Show when={s().lowest} fallback={<span class="muted">–</span>}>
                  {(r) => (
                    <>
                      <FeeRate rate={r()} />
                      <span class="home-stat__sub">{s().lowestNote}</span>
                    </>
                  )}
                </Show>
              )}
            </Show>
          </Stat>
        </dl>
      </Show>
      <figure class="home-next" ref={pictures}>
        <figcaption class="home-picture__head">
          <Link class="home-picture__title tap" href={paths.projected(1)}>
            Next block
          </Link>
          <span class="home-picture__meta" aria-busy={m() ? "false" : "true"}>
            <Show when={m()} fallback={<span class="home-bone home-bone--short" />}>
              {(s) => (
                <Show
                  when={nextBlockReach(rows())}
                  fallback={s().vsize === 0 ? "Nothing waiting" : "Everything fits"}
                >
                  {(reach) => (
                    <>
                      down to <span class="num">{rangeLabel(reach())}</span> sat/vB
                    </>
                  )}
                </Show>
              )}
            </Show>
          </span>
        </figcaption>
        <div class="home-next__frame">
          <Show when={near()}>
            <Pending>
              <NextBlockMap />
            </Pending>
          </Show>
        </div>
      </figure>
      <div class="home-flow">
        <div class="home-flow__frame">
          <Show when={near()}>
            <Pending>
              <IncomingChart
                network={props.network}
                height={phone ? CHART_HEIGHT_PHONE : CHART_HEIGHT}
              />
            </Pending>
          </Show>
        </div>
      </div>
    </section>
  );
}

export function Stat(props: { label: string; children: JSX.Element }) {
  return (
    <div class="home-stat">
      <dt class="home-stat__label">{props.label}</dt>
      <dd class="home-stat__value">{props.children}</dd>
    </div>
  );
}
