import { useSearchParams } from "@solidjs/router";
import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { formatDay, formatHashrate, formatMoment, formatShare } from "../../components/chart/scale";
import { DataTable } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { useNow } from "../../lib/clock";
import {
  type DifficultyAdjustment,
  isDifficultyAdjustment,
  PERIOD,
  retargets,
  until,
} from "../../lib/difficulty";
import { formatFeeRate, formatUtc, groupDigits, isoTime, MISSING } from "../../lib/format";
import { NETWORK_NAMES, type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { createMiningData, type MiningData } from "./data";
import {
  type Adjustment,
  adjustmentPercent,
  answeredPeriod,
  byTime,
  competitive,
  coverageNote,
  hashrateInterval,
  hashrateSeries,
  type Hashrates,
  isAdjustments,
  isHashrates,
  isPoints,
  isPoolWeeks,
  isRanking,
  isRatePoints,
  isRewardStats,
  isSizes,
  networkHashrate,
  networkNote,
  nowWindow,
  OTHER_POOLS,
  parsePeriod,
  type Period,
  periodDomain,
  PERIODS,
  poolColour,
  poolLayers,
  type Ranked,
  type Ranking,
  REWARD_MAX,
  rewardFigures,
  type RewardStats,
  SHARES_DRAWN,
  sharesOverTime,
} from "./mining";
import {
  btcFull,
  btcShort,
  bytesText,
  Chart,
  ChartSlot,
  chartHeight,
  CoverageNote,
  difficultyFull,
  difficultyShort,
  NothingStored,
  percent,
  Section,
} from "./parts";
import { Adjustments, Change } from "./Adjustments";
import { HealthChart } from "./Health";
import { RecentBlocks, tileAge } from "./RecentBlocks";
import "./MiningPage.css";
import { dragScroll } from "../../components/dragScroll";
import { owned } from "../../components/owned";

/** Charts are shorter on a phone, so the hashrate fits whole on its first screen. */
const narrow = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(max-width: 40em)").matches;

export default function MiningPage() {
  usePageTitle(() => "Mining");
  const network = useNetwork();
  // Everything on the page belongs to one network: switching networks starts it afresh.
  return (
    <Show when={network()} keyed>
      {(n) => <Mining network={n} />}
    </Show>
  );
}

function Mining(props: { network: Network }) {
  const [search] = useSearchParams();
  const period = createMemo(() => parsePeriod(search["period"]));
  const net = () => props.network;
  const ranking = createMiningData(net, () => `/v1/mining/pools/${period().id}`, isRanking);
  const hashrates = createMiningData(
    net,
    () => `/v1/mining/hashrate/${hashrateInterval(period())}`,
    isHashrates,
  );
  const rewardCount = () => Math.min(REWARD_MAX, ranking.answer()?.value.blockCount ?? 0);
  const rewards = createMiningData(
    net,
    () => (rewardCount() > 0 ? `/v1/mining/reward-stats/${rewardCount()}` : undefined),
    isRewardStats,
  );
  const past = createMiningData(net, () => "/v1/mining/difficulty-adjustments", isAdjustments);
  const next = createMiningData(
    net,
    () => (retargets(props.network) ? "/v1/difficulty-adjustment" : undefined),
    isDifficultyAdjustment,
  );
  onSettled(() => void Chart.preload());

  return (
    <div class="wrap mining mining--overview">
      <header class="mining-head">
        <h1>Mining</h1>
        <PeriodPicker period={period()} />
      </header>
      <Show when={networkNote(props.network)}>{(text) => <p class="mining-note">{text()}</p>}</Show>
      <Figures
        network={props.network}
        period={period()}
        hashrates={hashrates}
        ranking={ranking}
        rewards={rewards}
        rewardCount={rewardCount()}
        past={past}
        next={next}
      />
      <div class="mining-grid">
        <div class="mining-col">
          <HashrateChart period={period()} hashrates={hashrates} network={props.network} />
          <OverTime period={period()} network={props.network} ranking={ranking} />
        </div>
        <div class="mining-col">
          <Pools
            period={period()}
            ranking={ranking}
            hashrates={hashrates}
            network={props.network}
          />
          <Adjustments network={props.network} past={past} />
        </div>
      </div>
      <RecentBlocks />
    </div>
  );
}

function PeriodPicker(props: { period: Period }) {
  return (
    <nav class="mining-periods" aria-label="Period">
      <ul>
        <For each={PERIODS}>
          {(p) => (
            <li>
              <Link
                class="mining-periods__item tap"
                href={paths.mining(p.id)}
                aria-current={p.id === props.period.id ? "page" : "false"}
              >
                {p.label}
                <span class="visually-hidden">: {p.words}</span>
              </Link>
            </li>
          )}
        </For>
      </ul>
    </nav>
  );
}

/** A figure's line when its load failed: a retry, since nothing else on the page loads it. */
function Retry(props: { data: MiningData<unknown> }) {
  return (
    <button class="mining-retry" type="button" onClick={() => props.data.retry()}>
      Could not load. Try again
    </button>
  );
}

/** A label, a large figure and a muted line under it. */
function Fig(props: { label: string; children?: JSX.Element; sub?: JSX.Element; class?: string }) {
  return (
    <div class={["mining-fig", props.class]}>
      <dt class="mining-fig__label">{props.label}</dt>
      <dd class="mining-fig__value">{props.children}</dd>
      <dd class="mining-fig__sub">{props.sub}</dd>
    </div>
  );
}

/** The network now, then the period's blocks and pay: one band of figures in two groups. */
function Figures(props: {
  network: Network;
  period: Period;
  hashrates: MiningData<Hashrates>;
  ranking: MiningData<Ranking>;
  rewards: MiningData<RewardStats>;
  rewardCount: number;
  past: MiningData<Adjustment[]>;
  next: MiningData<DifficultyAdjustment>;
}) {
  const now = useNow();
  const h = () => props.hashrates.answer()?.value;
  // A failed load keeps the last answer: never show it as the new period's.
  const blocks = () => (props.ranking.error() === undefined ? props.ranking.answer() : undefined);
  const period = (): Period => answeredPeriod(blocks()) ?? props.period;
  const last = () => props.past.answer()?.value[0];
  const n = () => props.next.answer()?.value;
  /** The totals for the blocks counted now: none while another count's answer is all there is. */
  const pay = () => {
    const a = props.rewards.answer();
    const fresh =
      props.rewardCount > 0 &&
      props.ranking.error() === undefined &&
      props.rewards.error() === undefined &&
      a?.path === `/v1/mining/reward-stats/${props.rewardCount}`;
    return fresh ? rewardFigures(a.value) : undefined;
  };
  /** A figure that failed or has nothing to count reads as a dash; one still loading is blank. */
  const dash = (failed: unknown) => (failed === undefined ? "" : MISSING);
  const noPay = () => (props.ranking.answer() && props.rewardCount === 0 ? MISSING : "");
  const target = () => {
    const s = period().seconds;
    return s !== undefined && competitive(props.network)
      ? `Target ${groupDigits(Math.round(s / 600))}`
      : undefined;
  };

  return (
    <section class="panel mining-figures" aria-label="Mining figures">
      <dl
        class="mining-figs"
        aria-busy={props.hashrates.loading() || props.ranking.loading() ? "true" : "false"}
      >
        <Fig
          label="Hashrate"
          sub={competitive(props.network) ? nowWindow(period()).words : "Not meaningful on regtest"}
        >
          <Show when={blocks()} fallback={dash(props.ranking.error())}>
            {(a) => (
              <span class="num">
                {formatHashrate(a().value[nowWindow(period()).field] ?? Number.NaN, 4)}
              </span>
            )}
          </Show>
        </Fig>
        <Fig
          label="Difficulty"
          sub={
            <Show when={last()}>
              {(a) => (
                <>
                  <Change percent={adjustmentPercent(a()[3])} />,{" "}
                  <time datetime={isoTime(a()[0])} title={formatUtc(a()[0])}>
                    {tileAge(a()[0], now())} ago
                  </time>
                </>
              )}
            </Show>
          }
        >
          <Show when={h()} fallback={dash(props.hashrates.error())}>
            {(a) => <span class="num">{difficultyFull(a().currentDifficulty)}</span>}
          </Show>
        </Fig>
        <Show
          when={retargets(props.network)}
          fallback={
            <Fig
              label="Next adjustment"
              sub={`${NETWORK_NAMES[props.network]} never adjusts its difficulty`}
            >
              {MISSING}
            </Fig>
          }
        >
          <Fig
            label="Next adjustment"
            sub={
              <Show
                when={n()}
                fallback={
                  <Show when={props.next.error() !== undefined}>
                    <Retry data={props.next} />
                  </Show>
                }
              >
                {(d) => {
                  const mined = () => Math.min(PERIOD, Math.max(0, PERIOD - d().remainingBlocks));
                  return (
                    <>
                      <span
                        class="mining-epoch"
                        role="img"
                        aria-label={`${groupDigits(mined())} of ${groupDigits(PERIOD)} blocks of this period mined`}
                        style={{
                          "--done": String(mined() / PERIOD),
                          "--pace": String(Math.min(1, Math.max(0, d().expectedBlocks / PERIOD))),
                        }}
                      />
                      {until(d().estimatedRetargetDate, now() * 1000)}, at{" "}
                      <span class="num">{groupDigits(d().nextRetargetHeight)}</span>
                    </>
                  );
                }}
              </Show>
            }
          >
            <Show when={n()} fallback={dash(props.next.error())}>
              {(d) => <Change percent={d().difficultyChange} />}
            </Show>
          </Fig>
        </Show>
        <Fig
          label="Blocks found"
          class="mining-fig--period"
          sub={coverageNote(blocks()?.coverage, period()) ?? target()}
        >
          <Show when={blocks()} fallback={dash(props.ranking.error())}>
            {(r) => <span class="num">{groupDigits(r().value.blockCount)}</span>}
          </Show>
        </Fig>
        <Fig
          label="Paid to miners"
          sub={
            <Show
              when={pay()}
              fallback={
                <Show when={props.rewards.error() !== undefined && props.rewardCount > 0}>
                  <Retry data={props.rewards} />
                </Show>
              }
            >
              {(f) => (
                <Show
                  when={props.rewardCount < REWARD_MAX}
                  fallback={`The last ${groupDigits(REWARD_MAX)} blocks`}
                >
                  <Amount sats={Math.round(f().perBlock)} short /> a block
                </Show>
              )}
            </Show>
          }
        >
          <Show when={pay()} fallback={noPay() || dash(props.rewards.error())}>
            {(f) => <Amount sats={f().reward} short />}
          </Show>
        </Fig>
        <Fig label="Fees" sub={pay() && `${formatShare(pay()?.feeShare ?? 0)} of the reward`}>
          <Show when={pay()} fallback={noPay() || dash(props.rewards.error())}>
            {(f) => <Amount sats={f().fees} short />}
          </Show>
        </Fig>
      </dl>
    </section>
  );
}

function HashrateChart(props: {
  period: Period;
  hashrates: MiningData<Hashrates>;
  network: Network;
}) {
  const height = narrow() ? 170 : 220;
  const series = createMemo(() => {
    const a = props.hashrates.answer();
    return a ? hashrateSeries(a.value) : undefined;
  });
  // Hashrate is estimated over a week of blocks, so a day's view draws the last week.
  const shown = () => (props.period.id === "24h" ? parsePeriod("1w") : props.period);
  return (
    <section class="mining-section" aria-labelledby="mining-hashrate-title">
      <SectionHeader title="Hashrate and difficulty" id="mining-hashrate-title">
        {props.period.id === "all"
          ? "Weekly"
          : props.period.id === "24h"
            ? "Last week, daily 7-day average"
            : "Daily 7-day average"}
      </SectionHeader>
      <Section
        what="the hashrate"
        reserve={chartHeight(height)}
        hold={(series()?.x.length ?? 0) > 0}
        ready={series() !== undefined}
        error={props.hashrates.error()}
        retry={props.hashrates.retry}
        busy={props.hashrates.loading()}
      >
        <CoverageNote coverage={props.hashrates.answer()?.coverage} period={shown()} />
        <Show
          when={(series()?.x.length ?? 0) > 0}
          fallback={<NothingStored what="blocks" period={shown()} />}
        >
          <ChartSlot
            label={`Hashrate and difficulty, ${shown().words}`}
            x={series()?.x ?? []}
            domain={periodDomain(shown(), series()?.x ?? [], Date.now() / 1000)}
            dataFrom={props.hashrates.answer()?.coverage?.fromTime}
            height={height}
            left={{ format: (v) => formatHashrate(v), log: "auto" }}
            right={{ format: difficultyShort, log: "auto" }}
            series={[
              {
                name: competitive(props.network) ? "Hashrate" : "Hashrate (not meaningful)",
                values: series()?.hashrate ?? [],
                draw: "area",
                format: (v) => formatHashrate(v, 4),
                rawUnit: "H/s",
              },
              {
                name: "Difficulty",
                values: series()?.difficulty ?? [],
                draw: "step",
                axis: "right",
                tone: 2,
                format: difficultyFull,
              },
            ]}
          />
        </Show>
      </Section>
    </section>
  );
}

/** Rows shown before "Show all pools". */
const POOLS_SHOWN = 8;

function Pools(props: {
  period: Period;
  ranking: MiningData<Ranking>;
  hashrates: MiningData<Hashrates>;
  network: Network;
}) {
  const [all, setAll] = createSignal(false);
  const r = () => props.ranking.answer()?.value;
  // While the next period loads the last answer stays, so the words follow the answer shown.
  const period = (): Period => answeredPeriod(props.ranking.answer()) ?? props.period;
  const network = () => {
    const a = r();
    return a ? networkHashrate(period(), a, props.hashrates.answer()?.value) : undefined;
  };
  const rows = () => {
    const list = r()?.pools ?? [];
    return all() ? list : list.slice(0, POOLS_SHOWN);
  };
  const share = (p: Ranked) => {
    const total = r()?.blockCount ?? 0;
    return total > 0 ? p.blockCount / total : 0;
  };
  // The bar draws the period's six largest pools that have a colour; each row repeats its own.
  const drawn = createMemo(() =>
    (r()?.pools ?? []).filter((p) => poolColour(p.name) > 0).slice(0, SHARES_DRAWN),
  );
  const swatch = (p: Ranked) => (drawn().includes(p) ? String(poolColour(p.name)) : "other");

  return (
    <section class="mining-section" aria-labelledby="mining-pools-title">
      <SectionHeader title="Pools" id="mining-pools-title">
        {/* An expression, not a Show callback: a callback's string is made once and goes stale. */}
        {r() &&
          `${groupDigits(r()?.blockCount ?? 0)} ${r()?.blockCount === 1 ? "block" : "blocks"} in ${period().words}`}
      </SectionHeader>
      <Section
        what="the pools"
        reserve="26rem"
        hold={false}
        ready={r() !== undefined}
        error={props.ranking.error()}
        retry={props.ranking.retry}
        busy={props.ranking.loading()}
      >
        <CoverageNote coverage={props.ranking.answer()?.coverage} period={period()} />
        <Show
          when={(r()?.blockCount ?? 0) > 0}
          fallback={<NothingStored what="blocks" period={period()} />}
        >
          <ShareBar pools={r()?.pools ?? []} drawn={drawn()} share={share} />
          <div class="mining-compact">
            <DataTable
              caption={`Pools ranked by blocks found in ${period().words}`}
              rows={rows()}
              rowHref={(p) => paths.pool(p.slug)}
              columns={[
                {
                  header: "Pool",
                  cell: (p) => (
                    <span class="mining-pool">
                      <span
                        class={`mining-pool__swatch mining-period-shares__part mining-period-shares__part--${swatch(p)}`}
                        aria-hidden="true"
                      />
                      <span class="mining-pool__text">
                        <Link class="mining-pool__name" href={paths.pool(p.slug)}>
                          {p.name}
                        </Link>
                        <Show when={p.emptyBlocks > 0}>
                          <span class="mining-pool__empty">
                            <span class="mining-pool__count">{groupDigits(p.emptyBlocks)}</span>{" "}
                            <span class="mining-pool__word">empty</span>
                          </span>
                        </Show>
                      </span>
                    </span>
                  ),
                },
                {
                  header: "Share",
                  numeric: true,
                  cell: (p) => formatShare(share(p)),
                },
                { header: "Blocks", numeric: true, cell: (p) => groupDigits(p.blockCount) },
                {
                  header: "Hashrate, est.",
                  short: "Hashrate",
                  numeric: true,
                  optional: true,
                  cell: (p) => {
                    const n = network();
                    return n === undefined || !competitive(props.network)
                      ? MISSING
                      : formatHashrate(n * share(p));
                  },
                },
                {
                  header: "Match rate",
                  short: "Match",
                  numeric: true,
                  drop: 2,
                  cell: (p) =>
                    typeof p.avgMatchRate === "number" ? `${p.avgMatchRate.toFixed(1)}%` : MISSING,
                },
              ]}
            />
          </div>
          <div class="mining-foot">
            <Show when={(r()?.pools.length ?? 0) > POOLS_SHOWN}>
              <button class="btn mining-more" type="button" onClick={() => setAll(!all())}>
                {all() ? "Show the top pools only" : `Show all ${r()?.pools.length ?? 0} pools`}
              </button>
            </Show>
            <More>
              <p>
                Blocks are credited by the coinbase tag first, then by the payout address. Unknown
                counts the blocks named by no tag or address on the list. A pool's hashrate is its
                share of the blocks times the network's hashrate over the same blocks. The match
                rate is the average of the pool's blocks this server audited; "N empty" counts
                blocks with no transaction but the coinbase.
              </p>
            </More>
          </div>
        </Show>
      </Section>
    </section>
  );
}

/**
 * The period's share of blocks as one bar: its six largest pools that have a colour, biggest
 * first, each in its own (`COLOURED_POOLS`), then every other pool as one grey part. The table
 * under it is its key.
 */
function ShareBar(props: {
  pools: readonly Ranked[];
  drawn: readonly Ranked[];
  share: (p: Ranked) => number;
}) {
  const parts = () => {
    const coloured = props.drawn.map((p) => ({
      name: p.name,
      share: props.share(p),
      part: String(poolColour(p.name)),
    }));
    const rest = props.pools
      .filter((p) => !props.drawn.includes(p))
      .reduce((sum, p) => sum + props.share(p), 0);
    return rest > 0 ? [...coloured, { name: OTHER_POOLS, share: rest, part: "other" }] : coloured;
  };
  return (
    <div
      class="mining-period-shares__bar mining-sharebar"
      role="img"
      aria-label={`Share of blocks: ${parts()
        .map((p) => `${p.name} ${formatShare(p.share)}`)
        .join(", ")}`}
    >
      <For each={parts()}>
        {(p) => (
          <span
            class={`mining-period-shares__part mining-period-shares__part--${p.part}`}
            style={{ "--p": String(p.share) }}
            title={`${p.name} ${formatShare(p.share)}`}
            data-pool={p.name}
          />
        )}
      </For>
    </div>
  );
}

/** The weekly shares in words: each layer's average share over the weeks shown. */
function shareSummary(layers: readonly { name: string; values: readonly number[] }[]): string {
  const parts = layers.map((l) => {
    const avg = l.values.reduce((s, v) => s + v, 0) / Math.max(1, l.values.length);
    return `${l.name} ${formatShare(avg)}`;
  });
  return `Average weekly share of blocks: ${parts.join(", ")}.`;
}

const TABS = [
  { id: "fees", label: "Fees" },
  { id: "rates", label: "Fee rates" },
  { id: "sizes", label: "Size" },
  { id: "health", label: "Match rate" },
  { id: "shares", label: "Pool shares" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** The chart last chosen, so coming back from a block a point opened shows the same one. */
let lastTab: TabId = "fees";

interface TabProps {
  period: Period;
  network: Network;
  height: number;
}

/** Every per-block series in one chart slot, chosen by a switch in the panel's head. */
function OverTime(props: { period: Period; network: Network; ranking: MiningData<Ranking> }) {
  const [tab, setTab] = createSignal<TabId>(lastTab);
  // Shares are counted by the week, so that tab is there from a month up.
  const offered = () => TABS.filter((t) => t.id !== "shares" || sharesOverTime(props.period));
  const shown = (): TabId => (tab() === "shares" && !sharesOverTime(props.period) ? "fees" : tab());
  const height = narrow() ? 160 : 200;
  const tabProps = (): TabProps => ({
    period: props.period,
    network: props.network,
    height,
  });

  return (
    <section class="mining-section" aria-labelledby="mining-blocks-title">
      <SectionHeader title="Blocks over time" id="mining-blocks-title">
        <div class="mining-tabs" role="group" aria-label="Show" ref={owned((el) => dragScroll(el))}>
          <For each={offered()}>
            {(t) => (
              <button
                type="button"
                class="mining-tab"
                aria-pressed={shown() === t.id ? "true" : "false"}
                onClick={() => {
                  lastTab = t.id;
                  setTab(t.id);
                }}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
      </SectionHeader>
      <Switch>
        <Match when={shown() === "fees"}>
          <FeesChart {...tabProps()} />
        </Match>
        <Match when={shown() === "rates"}>
          <RatesChart {...tabProps()} />
          <More>
            <p>
              Percentiles are weighted by size: the median is the rate at which half a block's bytes
              paid less. Each point averages a run of blocks. Fee rates are stored for the last year
              of blocks.
            </p>
          </More>
        </Match>
        <Match when={shown() === "sizes"}>
          <SizesChart {...tabProps()} />
        </Match>
        <Match when={shown() === "health"}>
          <HealthChart {...tabProps()} ranking={props.ranking} />
          <More>
            <p>
              The match rate is how much of the block this server expected on a block's parent the
              miner mined, by virtual size, leaving out transactions that arrived too late to count
              or that conflicted with the block. A low one means the miner chose differently, or
              this node's mempool did not hold what the miner's did. Only blocks this server watched
              arrive with its mempool engine on are audited, so the record begins when it first did,
              and a gap is a stretch it did not watch. A point opens its block.
            </p>
          </More>
        </Match>
        <Match when={shown() === "shares"}>
          <SharesChart {...tabProps()} ranking={props.ranking} />
        </Match>
      </Switch>
    </section>
  );
}

/** A tab's chart slot: loading, failed, nothing stored, or the chart, its height held throughout. */
function Slot(props: {
  data: MiningData<unknown>;
  what: string;
  nothing: string;
  period: Period;
  height: number;
  /** Points to draw; undefined until the answer is here. */
  count: number | undefined;
  children: JSX.Element;
}) {
  return (
    <Section
      what={props.what}
      reserve={chartHeight(props.height)}
      hold={(props.count ?? 0) > 0}
      ready={props.count !== undefined}
      error={props.data.error()}
      retry={props.data.retry}
      busy={props.data.loading()}
    >
      <CoverageNote coverage={props.data.answer()?.coverage} period={props.period} />
      <Show
        when={(props.count ?? 0) > 0}
        fallback={<NothingStored what={props.nothing} period={props.period} />}
      >
        {props.children}
      </Show>
    </Section>
  );
}

/** What every block chart shares: its words, its time axis and where its data starts. */
const blockChart = (
  props: TabProps,
  x: readonly number[],
  what: string,
  data: MiningData<unknown>,
) => ({
  label: `${what}, ${props.period.words}`,
  x,
  domain: periodDomain(props.period, x, Date.now() / 1000),
  dataFrom: data.answer()?.coverage?.fromTime,
  time: props.period.id === "24h" ? formatMoment : formatDay,
  height: props.height,
});

function FeesChart(props: TabProps) {
  const data = createMiningData(
    () => props.network,
    () => `/v1/mining/blocks/fees/${props.period.id}`,
    isPoints("avgFees"),
  );
  // Points come in height order, and block times can run backwards: charts need them by time.
  const points = createMemo(() => byTime(data.answer()?.value));
  return (
    <Slot
      data={data}
      what="the block figures"
      nothing="blocks"
      period={props.period}
      height={props.height}
      count={points()?.length}
    >
      <ChartSlot
        {...blockChart(
          props,
          (points() ?? []).map((p) => p.timestamp),
          "Average fees per block",
          data,
        )}
        left={{ format: btcShort, zero: true }}
        series={[
          {
            name: "Fees per block",
            draw: "area",
            values: (points() ?? []).map((p) => Number(p["avgFees"])),
            format: btcFull,
            rawUnit: "sat",
          },
        ]}
      />
    </Slot>
  );
}

function RatesChart(props: TabProps) {
  const data = createMiningData(
    () => props.network,
    () => `/v1/mining/blocks/fee-rates/${props.period.id}/precise`,
    isRatePoints,
  );
  const points = createMemo(() => byTime(data.answer()?.value));
  const a = () => points() ?? [];
  const pos = (v: number) => (v > 0 ? v : null);
  return (
    <Slot
      data={data}
      what="the block figures"
      nothing="fee rates"
      period={props.period}
      height={props.height}
      count={points()?.length}
    >
      <ChartSlot
        {...blockChart(
          props,
          a().map((p) => p.timestamp),
          "Fee rates paid in blocks",
          data,
        )}
        left={{ format: formatFeeAxis, log: true, fee: true }}
        // The unit once, in the readout and the figures' headers: the figures fit a phone.
        bands={[
          {
            name: "10th to 90th percentile",
            narrow: "Middle 80%",
            tone: 1,
            lo: a().map((p) => pos(p.avgFee_10)),
            hi: a().map((p) => pos(p.avgFee_90)),
            format: formatFeeRate,
            unit: "sat/vB",
            rawUnit: "sat/vB",
          },
          {
            name: "25th to 75th percentile",
            narrow: "Middle 50%",
            tone: 2,
            lo: a().map((p) => pos(p.avgFee_25)),
            hi: a().map((p) => pos(p.avgFee_75)),
            format: formatFeeRate,
            unit: "sat/vB",
            rawUnit: "sat/vB",
          },
        ]}
        series={[
          {
            name: "Median",
            draw: "line",
            values: a().map((p) => pos(p.avgFee_50)),
            format: formatFeeRate,
            unit: "sat/vB",
            rawUnit: "sat/vB",
          },
        ]}
      />
    </Slot>
  );
}

function SizesChart(props: TabProps) {
  const data = createMiningData(
    () => props.network,
    () => `/v1/mining/blocks/sizes-weights/${props.period.id}`,
    isSizes,
  );
  const points = createMemo(() => {
    const v = data.answer()?.value;
    return v ? { sizes: byTime(v.sizes) ?? [], weights: byTime(v.weights) ?? [] } : undefined;
  });
  return (
    <Slot
      data={data}
      what="the block figures"
      nothing="blocks"
      period={props.period}
      height={props.height}
      count={points()?.sizes.length}
    >
      <ChartSlot
        {...blockChart(
          props,
          (points()?.sizes ?? []).map((p) => p.timestamp),
          "Average block size and weight",
          data,
        )}
        left={{ format: bytesText, zero: true }}
        right={{ format: percent, domain: [0, 1] }}
        series={[
          {
            name: "Size",
            draw: "area",
            values: (points()?.sizes ?? []).map((p) => p.avgSize),
            format: bytesText,
            rawUnit: "B",
          },
          {
            name: "Weight, of the limit",
            draw: "line",
            axis: "right",
            tone: 2,
            values: (points()?.weights ?? []).map((p) => p.avgWeight / 4_000_000),
            format: percent,
            rawUnit: "0-1",
          },
        ]}
      />
    </Slot>
  );
}

/** Each pool's share of the blocks, week by week, as strata in the pools' own colours. */
function SharesChart(props: TabProps & { ranking: MiningData<Ranking> }) {
  const weeks = createMiningData(
    () => props.network,
    () => `/v1/mining/hashrate/pools/${props.period.id}`,
    isPoolWeeks,
  );
  const period = (): Period => answeredPeriod(weeks.answer()) ?? props.period;
  const layers = createMemo(() => {
    const w = weeks.answer()?.value;
    // The table's own order, when it is of the same period as the weeks.
    const sameTable = answeredPeriod(props.ranking.answer())?.id === period().id;
    return w
      ? poolLayers(
          w,
          sameTable ? props.ranking.answer()?.value.pools.map((p) => p.name) : undefined,
        )
      : undefined;
  });
  return (
    <Slot
      data={weeks}
      what="the weekly shares"
      nothing="weeks"
      period={period()}
      height={props.height}
      count={layers()?.x.length}
    >
      <ChartSlot
        label={`Share of blocks by pool, week by week, ${period().words}`}
        x={layers()?.x ?? []}
        domain={
          weeks.answer()?.coverage?.complete === false
            ? periodDomain(period(), layers()?.x ?? [], Date.now() / 1000)
            : undefined
        }
        dataFrom={weeks.answer()?.coverage?.fromTime}
        height={props.height}
        left={{ format: percent, domain: [0, 1] }}
        layers={layers()?.layers ?? []}
        layerFormat={formatShare}
        layerUnit="0-1"
        time={(t) => `Week of ${formatDay(t)}`}
        summary={shareSummary(layers()?.layers ?? [])}
      />
    </Slot>
  );
}

/** Fee-rate axis ticks, which are powers of ten and their 2s and 5s: `0.2 sat/vB`, `10 sat/vB`. */
const formatFeeAxis = (v: number): string =>
  `${v >= 1 ? String(v) : v.toFixed(v >= 0.1 ? 1 : 2)} sat/vB`;
