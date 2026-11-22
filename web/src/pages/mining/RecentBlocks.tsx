// The latest mined blocks as tiles in a wrapping grid, as the home page's strip draws them.
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { FeeRate } from "../../components/FeeRate";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { ErrorState } from "../../components/States";
import { Strata, strataLayers, strataSide } from "../../components/Strata";
import "../../components/BlockBox.css";
import { createApi } from "../../lib/api";
import type { Block } from "../../lib/esplora";
import { useNow } from "../../lib/clock";
import { formatRelative, formatUtc, groupDigits, isoTime } from "../../lib/format";
import { paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { type BlockSummary, fetchSummaries } from "../../lib/summary";
import { dragScroll } from "../../components/dragScroll";
import { owned } from "../../components/owned";

const MAX_WEIGHT = 4_000_000;
/** The thinnest layer, as a share of the tile's strata box: about 2 px. */
const LAYER_MIN = 0.045;

export function RecentBlocks() {
  const network = useNetwork();
  const [blocks, { refetch }] = createApi<Block[]>(() => "/blocks");
  /** The blocks, once here and a list; a reply of another shape shows as not loaded. */
  const list = () => {
    const v: unknown = blocks.state === "ready" ? blocks() : undefined;
    return Array.isArray(v) ? (v as Block[]) : undefined;
  };
  const [facts, setFacts] = createSignal<ReadonlyMap<string, BlockSummary>>(new Map());
  let controller: AbortController | undefined;
  createEffect(list, (shown) => {
    if (!shown || shown.length === 0) return;
    controller?.abort();
    const c = new AbortController();
    controller = c;
    // The tiles keep their neutral fill if the facts never come.
    fetchSummaries(
      network(),
      shown.map((b) => b.id),
      c.signal,
    ).then(
      (found) => setFacts(new Map(found)),
      () => undefined,
    );
  });
  onCleanup(() => controller?.abort());

  return (
    <section class="mining-section" aria-labelledby="mining-recent-title">
      <SectionHeader title="Recent blocks" id="mining-recent-title">
        <Link href={paths.blocks()}>All blocks</Link>
      </SectionHeader>
      <Show
        when={blocks.state !== "errored"}
        fallback={
          <ErrorState
            title="Could not load the latest blocks"
            error={blocks.error}
            retry={() => refetch()}
          />
        }
      >
        <ol
          class="mining-tiles"
          ref={owned((el) => dragScroll(el))}
          aria-label="Latest blocks, newest first"
          aria-busy={blocks.state === "ready" ? "false" : "true"}
        >
          <Show
            when={list()}
            fallback={
              <For each={Array.from({ length: 10 })}>
                {() => <li class="mining-tile mining-tile--empty" aria-hidden="true" />}
              </For>
            }
          >
            {(shown) => (
              <For each={shown()}>{(b) => <Tile block={b} facts={facts().get(b.id)} />}</For>
            )}
          </Show>
        </ol>
      </Show>
    </section>
  );
}

/** A tile's age, short enough for its foot: `13 min`, then whole hours and days. */
export function tileAge(time: number, now: number): string {
  const s = now - time;
  if (s < 3600) return formatRelative(time, now, { suffix: false });
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

function Tile(props: { block: Block; facts: BlockSummary | undefined }) {
  const now = useNow();
  const b = () => props.block;
  const full = () => Math.min(1, Math.max(0, b().weight / MAX_WEIGHT));
  const layers = () => (props.facts ? strataLayers(props.facts.fee_bands, full(), LAYER_MIN) : []);
  const rate = () => props.facts?.fee_rate ?? undefined;
  const miner = () => props.facts?.miner?.name;
  return (
    <li class="mining-tile">
      <Link class="mining-tile__body block-box" href={paths.block(b().id)}>
        <span class="mining-tile__height num">
          <span class="visually-hidden">Block </span>
          {groupDigits(b().height)}
          <Show when={miner()}>{(m) => <span class="visually-hidden">, mined by {m()}</span>}</Show>
        </span>
        <span class="mining-tile__fee num">
          <Show when={rate()} fallback={props.facts ? "No fees" : ""}>
            {(r) => <FeeRate rate={r().median} />}
          </Show>
        </span>
        <span
          class="mining-tile__strata block-box__core"
          style={{ "--core-side": strataSide(layers(), full()) }}
          aria-hidden="true"
        >
          <Show
            when={layers().length > 0}
            fallback={<span class="mining-tile__fill" style={{ "--fill": String(full()) }} />}
          >
            <Strata layers={layers()} />
          </Show>
        </span>
        <span class="mining-tile__foot">
          <span class="num">{groupDigits(b().tx_count)} tx</span>
          <time class="num" datetime={isoTime(b().timestamp)} title={formatUtc(b().timestamp)}>
            {tileAge(b().timestamp, now())}
          </time>
        </span>
      </Link>
      {/* Its line is always there, so the name lands without moving anything; the link says it. */}
      <span class="mining-tile__pool" aria-hidden="true" title={miner()}>
        {miner()}
      </span>
    </li>
  );
}
