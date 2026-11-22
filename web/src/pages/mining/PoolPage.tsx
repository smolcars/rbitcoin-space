import { useParams } from "@solidjs/router";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Amount } from "../../components/Amount";
import { formatDay, formatHashrate, formatShare } from "../../components/chart/scale";
import { DataTable } from "../../components/DataTable";
import { FeeRate } from "../../components/FeeRate";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import { ApiError, fetchApi, isNotFound } from "../../lib/api";
import { groupDigits, MISSING } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { createMiningData } from "./data";
import {
  competitive,
  fillWeeks,
  isPoolBlocks,
  isPoolStats,
  isPoolWeeks,
  networkNote,
  type PoolBlock,
  parsePeriod,
  safeLink,
} from "./mining";
import {
  bytesText,
  Chart,
  ChartSlot,
  chartHeight,
  CoverageNote,
  Failure,
  percent,
  Section,
  Stat,
} from "./parts";
import "./MiningPage.css";

export default function PoolPage() {
  const params = useParams<{ slug: string }>();
  const network = useNetwork();
  return (
    <Show when={params.slug} keyed>
      {(slug) => <Pool network={network()} slug={slug} />}
    </Show>
  );
}

const ALL = parsePeriod("all");

function Pool(props: { network: Network; slug: string }) {
  const net = () => props.network;
  // The route is relative to the network's API; a slug is one encoded path segment.
  const slug = encodeURIComponent(props.slug);
  const stats = createMiningData(net, () => `/v1/mining/pool/${slug}`, isPoolStats);
  const weeks = createMiningData(net, () => `/v1/mining/pool/${slug}/hashrate`, isPoolWeeks);
  const s = () => stats.answer()?.value;
  usePageTitle(() => s()?.pool.name ?? "Mining pool");
  onSettled(() => void Chart.preload());
  const link = () => safeLink(s()?.pool.link ?? "");
  const series = createMemo(() => {
    const w = fillWeeks(weeks.answer()?.value ?? []);
    return {
      x: w.map((p) => p.timestamp),
      hashrate: w.map((p) => p.avgHashrate),
      share: w.map((p) => p.share),
    };
  });

  return (
    <div class="wrap mining">
      <p class="mining-back">
        <Link class="tap" href={paths.mining()}>
          Mining
        </Link>
      </p>
      <Show
        when={stats.error() === undefined || s()}
        fallback={
          <Show
            when={isNotFound(stats.error())}
            fallback={
              <>
                <h1>Mining pool</h1>
                <Failure what="this pool" error={stats.error()} retry={stats.retry} />
              </>
            }
          >
            <h1>Unknown pool</h1>
            <Empty title="No pool on the list has this name">
              <Link href={paths.mining()}>See every pool that found blocks</Link>
            </Empty>
          </Show>
        }
      >
        <header class="mining-head">
          <h1 class="mining-pool-title">{s()?.pool.name ?? " "}</h1>
          {/* The line is kept whether or not the pool has a site, so the name arriving moves nothing. */}
          <p class="mining-pool-site">
            <Show when={link()}>
              {(l) => (
                <a
                  class="mining-pool-link"
                  href={l().href}
                  rel="noopener noreferrer nofollow external"
                >
                  {l().host}
                </a>
              )}
            </Show>
          </p>
        </header>
        <Show when={networkNote(props.network)}>
          {(text) => <p class="mining-note">{text()}</p>}
        </Show>
        <Show when={s()?.pool.id === 0}>
          <p class="mining-note">
            Unknown gathers the blocks whose payout address and coinbase tag match no pool on the
            list. It is counted and ranked like a pool, though it may be many miners.
          </p>
        </Show>
        <section class="mining-section" aria-labelledby="pool-stats-title">
          <SectionHeader title="Blocks found" id="pool-stats-title" />
          {/* Its height is held, so the figures arriving move nothing. Where the stored blocks begin
              is said once, over the chart below. */}
          <div class="pool-stats">
            <dl class="mining-rewards" aria-busy={s() ? "false" : "true"}>
              <Stat
                label="Last 24 hours"
                sub={s() ? `${formatShare(s()?.blockShare["24h"] ?? 0)} of blocks` : undefined}
              >
                <Show when={s()}>
                  {(a) => <span class="num">{groupDigits(a().blockCount["24h"])}</span>}
                </Show>
              </Stat>
              <Stat
                label="Last week"
                sub={s() ? `${formatShare(s()?.blockShare["1w"] ?? 0)} of blocks` : undefined}
              >
                <Show when={s()}>
                  {(a) => <span class="num">{groupDigits(a().blockCount["1w"])}</span>}
                </Show>
              </Stat>
              <Stat
                label="All stored"
                sub={s() ? `${formatShare(s()?.blockShare.all ?? 0)} of blocks` : undefined}
              >
                <Show when={s()}>
                  {(a) => <span class="num">{groupDigits(a().blockCount.all)}</span>}
                </Show>
              </Stat>
              <Stat
                label="Hashrate, est."
                sub={
                  competitive(props.network)
                    ? "Its share of the last day's blocks"
                    : "Not meaningful on regtest"
                }
              >
                <Show when={s()}>
                  {(a) => (
                    <span class="num">{formatHashrate(a().estimatedHashrate ?? Number.NaN)}</span>
                  )}
                </Show>
              </Stat>
              <Stat label="Rewards earned" sub="In the blocks stored">
                <Show when={s()}>{(a) => <Amount sats={Number(a().totalReward)} short />}</Show>
              </Stat>
            </dl>
            <Show when={(s()?.pool.regexes.length ?? 0) + (s()?.pool.addresses.length ?? 0) > 0}>
              <More label="How its blocks are recognised">
                <p>
                  By {groupDigits(s()?.pool.addresses.length ?? 0)} payout{" "}
                  {s()?.pool.addresses.length === 1 ? "address" : "addresses"} and these coinbase
                  tags:
                </p>
                <ul class="mining-tags">
                  {(s()?.pool.regexes ?? []).map((t) => (
                    <li class="num">{t}</li>
                  ))}
                </ul>
              </More>
            </Show>
          </div>
        </section>
        <section class="mining-section" aria-labelledby="pool-hashrate-title">
          <SectionHeader title="Share and hashrate over time" id="pool-hashrate-title">
            One point a week
          </SectionHeader>
          <Section
            what="the pool's weeks"
            // The chart alone: a pool whose weeks are all stored has no coverage note above it.
            reserve={chartHeight(240)}
            hold={series().x.length > 0}
            ready={weeks.answer() !== undefined}
            error={weeks.error()}
            retry={weeks.retry}
            busy={weeks.loading()}
          >
            <CoverageNote coverage={weeks.answer()?.coverage} period={ALL} />
            <Show
              when={series().x.length > 0}
              fallback={<Empty title="No weeks with a block from this pool are stored" />}
            >
              <ChartSlot
                label={`${s()?.pool.name ?? "This pool"}: share of blocks and hashrate, week by week`}
                x={series().x}
                dataFrom={weeks.answer()?.coverage?.fromTime}
                height={240}
                time={(t) => `Week of ${formatDay(t)}`}
                left={{ format: percent, zero: true }}
                right={{ format: (v) => formatHashrate(v), zero: true }}
                series={[
                  {
                    name: "Share of blocks",
                    draw: "area",
                    values: series().share,
                    format: formatShare,
                    rawUnit: "0-1",
                  },
                  {
                    name: "Hashrate",
                    draw: "line",
                    axis: "right",
                    tone: 2,
                    values: series().hashrate,
                    format: (v) => formatHashrate(v, 4),
                    rawUnit: "H/s",
                  },
                ]}
              />
            </Show>
          </Section>
        </section>
        <PoolBlocks network={props.network} slug={slug} name={s()?.pool.name} />
      </Show>
    </div>
  );
}

/** The server pages a pool's blocks 100 at a time; the table shows them 25 at a time. */
const PAGE = 100;
const STEP = 25;

function PoolBlocks(props: { network: Network; slug: string; name: string | undefined }) {
  const first = createMiningData(
    () => props.network,
    () => `/v1/mining/pool/${props.slug}/blocks`,
    isPoolBlocks,
  );
  const [older, setOlder] = createSignal<PoolBlock[]>([]);
  const [more, setMore] = createSignal<"idle" | "loading" | "done" | "failed">("idle");
  const [moreError, setMoreError] = createSignal<unknown>();
  const loaded = () => [...(first.answer()?.value ?? []), ...older()];
  // Counted here as well: a write reaches shown() only when the update is applied.
  let count = STEP;
  const [shown, setShown] = createSignal(count);
  const rows = () => loaded().slice(0, shown());
  const showMore = () => {
    count += STEP;
    setShown(count);
    if (count > loaded().length && !exhausted()) loadMore();
  };
  const loadMore = () => {
    const last = loaded().at(-1);
    if (!last) return;
    setMore("loading");
    const fail = (e: unknown) => {
      setMoreError(e);
      setMore("failed");
    };
    fetchApi<unknown>(props.network, `/v1/mining/pool/${props.slug}/blocks/${last.height}`, {
      cached: true,
    }).then((v) => {
      if (!isPoolBlocks(v)) {
        fail(new ApiError(200, "The server sent a reply that could not be read."));
        return;
      }
      setOlder((o) => [...o, ...v]);
      setMore(v.length < PAGE ? "done" : "idle");
    }, fail);
  };
  const exhausted = () => more() === "done" || (first.answer()?.value.length ?? 0) < PAGE;
  return (
    <section class="mining-section" aria-labelledby="pool-blocks-title">
      <SectionHeader title="Blocks" id="pool-blocks-title">
        <Show when={first.answer()}>{`${groupDigits(rows().length)} shown, newest first`}</Show>
      </SectionHeader>
      <Section
        what="the pool's blocks"
        reserve="40rem"
        ready={first.answer() !== undefined}
        error={first.error()}
        retry={first.retry}
        busy={first.loading()}
      >
        <DataTable
          caption={`Blocks found by ${props.name ?? "this pool"}, newest first`}
          rows={rows()}
          rowHref={(b) => paths.block(b.id)}
          empty={<Empty title="No blocks from this pool are stored" />}
          columns={[
            {
              header: "Height",
              cell: (b) => (
                <Link class="num" href={paths.block(b.id)}>
                  {groupDigits(b.height)}
                </Link>
              ),
            },
            { header: "Mined", cell: (b) => <TimeAgo time={b.timestamp} /> },
            {
              header: "Transactions",
              short: "Txs",
              numeric: true,
              drop: 2,
              cell: (b) => groupDigits(b.tx_count),
            },
            {
              header: "Median fee rate, sat/vB",
              short: "Median, sat/vB",
              numeric: true,
              cell: (b) =>
                typeof b.extras.medianFee === "number" ? (
                  <FeeRate rate={b.extras.medianFee} unit={false} />
                ) : (
                  MISSING
                ),
            },
            {
              header: "Fees, BTC",
              numeric: true,
              optional: true,
              cell: (b) => <Amount sats={b.extras.totalFees} unit={false} />,
            },
            {
              header: "Reward, BTC",
              numeric: true,
              drop: 3,
              cell: (b) => <Amount sats={b.extras.reward} unit={false} />,
            },
            { header: "Size", numeric: true, optional: true, cell: (b) => bytesText(b.size) },
          ]}
        />
        <Show when={shown() < loaded().length || !exhausted()}>
          <Show
            when={more() !== "failed"}
            fallback={
              <ErrorState
                title="Could not load older blocks"
                error={moreError()}
                retry={loadMore}
              />
            }
          >
            <button
              class="btn mining-more"
              type="button"
              disabled={more() === "loading"}
              onClick={showMore}
            >
              {more() === "loading" ? "Loading older blocks" : `Show ${STEP} older blocks`}
            </button>
          </Show>
        </Show>
      </Section>
    </section>
  );
}
