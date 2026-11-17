// MOCKUP, never merged: a denser /mining for the owner to compare with the live page. Recorded
// sample data, no server. Charts, tiles and share colours are the live page's own.
import { useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { formatHashrate, formatMoment, formatShare, formatDay } from "../../components/chart/scale";
import { FeeRate } from "../../components/FeeRate";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { Strata, strataLayers } from "../../components/Strata";
import { formatFeeRate, formatRelative, formatUtc, groupDigits, isoTime } from "../../lib/format";
import { paths } from "../../lib/network";
import { usePageTitle } from "../../lib/page";
import {
  adjustmentPercent,
  healthCoverage,
  healthSeries,
  hashrateSeries,
  networkHashrate,
  OTHER_POOLS,
  type Period,
  periodById,
  periodDomain,
  poolColour,
  poolLayers,
  rewardFigures,
  SHARES_DRAWN,
} from "../mining/mining";
import {
  btcFull,
  btcShort,
  bytesText,
  ChartSlot,
  Chart,
  difficultyFull,
  percent,
} from "../mining/parts";
import { tileAge } from "../mining/RecentBlocks";
import {
  COMMON,
  loadPeriod,
  MOCK_PERIODS,
  type MockPeriod,
  type MockPool,
  type PeriodSample,
} from "./sample";
import "../mining/MiningPage.css";
import "./MockMining.css";

const NOW = COMMON.recordedAt;
// Copies of lib/difficulty's helpers: importing it here splits it into a chunk of its own on the
// home page's first load, over the size check's file count.
const PERIOD = 2016;
function change(pct: number): { text: string; arrow: string } {
  const size = Math.abs(pct);
  if (size < 0.005) return { text: "No change", arrow: "→" };
  return pct > 0
    ? { text: `Up ${size.toFixed(2)}%`, arrow: "↑" }
    : { text: `Down ${size.toFixed(2)}%`, arrow: "↓" };
}
function until(at: number, now: number): string {
  const h = Math.floor((at - now) / 3_600_000);
  return h < 48 ? `in ${h} h` : `in ${Math.floor(h / 24)} days`;
}
/** Rows of the pool list before "Show all". */
const POOLS_SHOWN = 8;
/** Past adjustments before "Show older". */
const ADJ_SHOWN = 6;

const phone = () => window.matchMedia("(max-width: 40em)").matches;

export default function MockMining() {
  usePageTitle(() => "Mining (mockup)");
  const [search] = useSearchParams();
  const period = createMemo((): Period => {
    const id = search["period"];
    return periodById(MOCK_PERIODS.includes(id as MockPeriod) ? (id as MockPeriod) : "1w");
  });
  const [sample, setSample] = createSignal<PeriodSample>();
  createEffect(
    () => period().id as MockPeriod,
    (id) => void loadPeriod(id).then(setSample),
  );
  onSettled(() => void Chart.preload());

  return (
    <div class="wrap mm">
      <header class="mm-head">
        <h1>Mining</h1>
        <nav class="mining-periods" aria-label="Period">
          <ul>
            <For each={MOCK_PERIODS}>
              {(id) => (
                <li>
                  <Link
                    class="mining-periods__item mm-period"
                    href={`/mock/mining?period=${id}`}
                    aria-current={id === period().id ? "page" : "false"}
                  >
                    {periodById(id).label}
                    <span class="visually-hidden">: {periodById(id).words}</span>
                  </Link>
                </li>
              )}
            </For>
          </ul>
        </nav>
      </header>
      <Show when={sample()} fallback={<div class="mm-reserve" />}>
        {(s) => (
          <>
            <Figures s={s()} period={period()} />
            <div class="mm-grid">
              <div class="mm-col">
                <HashrateChart s={s()} period={period()} />
                <OverTime s={s()} period={period()} />
              </div>
              <div class="mm-col">
                <Pools s={s()} period={period()} />
                <Adjustments />
              </div>
            </div>
          </>
        )}
      </Show>
      <LatestBlocks />
    </div>
  );
}

function Fig(props: { label: string; children: JSX.Element; sub?: JSX.Element; class?: string }) {
  return (
    <div class={["mm-fig", props.class]}>
      <dt class="mm-fig__label">{props.label}</dt>
      <dd class="mm-fig__value">{props.children}</dd>
      <Show when={props.sub}>
        <dd class="mm-fig__sub">{props.sub}</dd>
      </Show>
    </div>
  );
}

/** The network now, then the period's blocks and pay: one band of figures, two groups. */
function Figures(props: { s: PeriodSample; period: Period }) {
  const h = () => props.s.hashrate.value;
  const next = COMMON.next;
  const last = COMMON.adjustments[0];
  const expected = change(next.difficultyChange);
  const mined = PERIOD - next.remainingBlocks;
  const r = () => rewardFigures(props.s.reward.value);
  const blocks = () => props.s.pools.value.blockCount;
  const target = () => Math.round((props.period.seconds ?? 0) / 600);
  return (
    <div class="panel mm-figures">
      <dl class="mm-figs">
        <Fig label="Hashrate" sub="Over the last 1 008 blocks">
          <span class="num">{formatHashrate(h().currentHashrate ?? Number.NaN, 4)}</span>
        </Fig>
        <Fig
          label="Difficulty"
          sub={
            last && (
              <>
                {change(adjustmentPercent(last[3])).arrow} {change(adjustmentPercent(last[3])).text}{" "}
                at <span class="num">{groupDigits(last[1])}</span>
              </>
            )
          }
        >
          <span class="num">{difficultyFull(h().currentDifficulty)}</span>
        </Fig>
        <Fig
          label="Next adjustment"
          class="mm-fig--next"
          sub={
            <>
              <span
                class="mm-epoch"
                role="img"
                aria-label={`${groupDigits(mined)} of ${groupDigits(PERIOD)} blocks of this period mined`}
                title={`${groupDigits(mined)} of ${groupDigits(PERIOD)} blocks`}
                style={{
                  "--done": String(mined / PERIOD),
                  "--pace": String(Math.min(1, next.expectedBlocks / PERIOD)),
                }}
              />
              {until(next.estimatedRetargetDate, NOW * 1000)}, at{" "}
              <span class="num">{groupDigits(next.nextRetargetHeight)}</span>
            </>
          }
        >
          <span class="num">
            <span aria-hidden="true">{expected.arrow} </span>
            {expected.text}
          </span>
        </Fig>
        <Fig
          label="Blocks found"
          class="mm-fig--period"
          sub={target() > 0 ? `Target ${groupDigits(target())}` : undefined}
        >
          <span class="num">{groupDigits(blocks())}</span>
        </Fig>
        <Fig
          label="Paid to miners"
          sub={
            <>
              <Amount sats={Math.round(r().perBlock)} short /> a block
            </>
          }
        >
          <Amount sats={r().reward} short />
        </Fig>
        <Fig label="Fees" sub={`${formatShare(r().feeShare)} of the reward`}>
          <Amount sats={r().fees} short />
        </Fig>
      </dl>
    </div>
  );
}

function HashrateChart(props: { s: PeriodSample; period: Period }) {
  const series = createMemo(() => hashrateSeries(props.s.hashrate.value));
  const shown = () => (props.period.id === "24h" ? periodById("1w") : props.period);
  return (
    <section class="mm-section" aria-labelledby="mm-hashrate">
      <SectionHeader title="Hashrate and difficulty" id="mm-hashrate">
        {props.period.id === "24h" ? "Last week: a daily 7-day average" : "Daily 7-day average"}
      </SectionHeader>
      <ChartSlot
        label={`Hashrate and difficulty, ${shown().words}`}
        x={series().x}
        domain={periodDomain(shown(), series().x, NOW)}
        dataFrom={props.s.hashrate.coverage?.fromTime}
        height={phone() ? 170 : 220}
        left={{ format: (v) => formatHashrate(v), log: "auto" }}
        right={{ format: (d) => difficultyFull(d).replace(/\.\d+/, ""), log: "auto" }}
        series={[
          {
            name: "Hashrate",
            values: series().hashrate,
            draw: "area",
            format: (v) => formatHashrate(v, 4),
          },
          {
            name: "Difficulty",
            values: series().difficulty,
            draw: "step",
            axis: "right",
            tone: 2,
            format: difficultyFull,
          },
        ]}
      />
    </section>
  );
}

/** The pools: the period's share as one bar (it is the list's key), then the list. */
function Pools(props: { s: PeriodSample; period: Period }) {
  const [all, setAll] = createSignal(false);
  const r = () => props.s.pools.value;
  const share = (p: MockPool) => (r().blockCount > 0 ? p.blockCount / r().blockCount : 0);
  const net = () => networkHashrate(props.period, r(), props.s.hashrate.value) ?? null;
  const rows = () => (all() ? r().pools : r().pools.slice(0, POOLS_SHOWN));
  const drawn = createMemo(() =>
    r()
      .pools.filter((p) => poolColour(p.name) > 0)
      .slice(0, SHARES_DRAWN),
  );
  const swatch = (p: MockPool) => (drawn().includes(p) ? String(poolColour(p.name)) : "other");
  const parts = () => {
    const rest = r()
      .pools.filter((p) => !drawn().includes(p))
      .reduce((s, p) => s + share(p), 0);
    return [
      ...drawn().map((p) => ({ name: p.name, share: share(p), part: String(poolColour(p.name)) })),
      ...(rest > 0 ? [{ name: OTHER_POOLS, share: rest, part: "other" }] : []),
    ];
  };
  return (
    <section class="mm-section" aria-labelledby="mm-pools">
      <SectionHeader title="Pools" id="mm-pools">
        {`${groupDigits(r().blockCount)} blocks`}
      </SectionHeader>
      <div
        class="mining-period-shares__bar mm-sharebar"
        role="img"
        aria-label={parts()
          .map((p) => `${p.name} ${formatShare(p.share)}`)
          .join(", ")}
      >
        <For each={parts()}>
          {(p) => (
            <span
              class={`mining-period-shares__part mining-period-shares__part--${p.part}`}
              style={{ "--p": String(p.share) }}
              title={`${p.name} ${formatShare(p.share)}`}
            />
          )}
        </For>
      </div>
      <table class="mm-pools">
        <caption class="visually-hidden">
          Pools ranked by blocks found in {props.period.words}
        </caption>
        <thead>
          <tr>
            <th scope="col">Pool</th>
            <th scope="col" class="mm-num">
              Share
            </th>
            <th scope="col" class="mm-num">
              Blocks
            </th>
            <th scope="col" class="mm-num mm-opt">
              Hashrate
            </th>
            <th scope="col" class="mm-num" title="Average match rate of its audited blocks">
              Match
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(p) => (
              <tr>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- a table cell, not a control: the pool's link inside it is named */}
                <td class="mm-pool-cell">
                  <span class="mm-pool">
                    <span
                      class={`mm-swatch mining-period-shares__part mining-period-shares__part--${swatch(p)}`}
                      aria-hidden="true"
                    />
                    <Link class="mm-pool__name" href={paths.pool(p.slug)}>
                      {p.name}
                    </Link>
                    <Show when={p.emptyBlocks > 0}>
                      <span class="mm-pool__empty">{groupDigits(p.emptyBlocks)} empty</span>
                    </Show>
                  </span>
                </td>
                <td class="mm-num">{formatShare(share(p))}</td>
                <td class="mm-num">{groupDigits(p.blockCount)}</td>
                <td class="mm-num mm-opt">
                  {(() => {
                    const n = net();
                    return n === null ? "–" : formatHashrate(n * share(p));
                  })()}
                </td>
                <td class="mm-num">
                  {p.avgMatchRate === null ? "–" : `${p.avgMatchRate.toFixed(1)}%`}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="mm-foot">
        <Show when={r().pools.length > POOLS_SHOWN}>
          <button class="btn mm-btn" type="button" onClick={() => setAll(!all())}>
            {all() ? "Top pools only" : `All ${r().pools.length} pools`}
          </button>
        </Show>
        <More>
          <p>
            Blocks are credited by coinbase tag, then payout address; Unknown names none on the
            list. Hashrate is the share times the network's. Match is the average match rate of the
            pool's blocks this server audited.
          </p>
        </More>
      </div>
    </section>
  );
}

const TABS = [
  { id: "fees", label: "Fees" },
  { id: "rates", label: "Fee rates" },
  { id: "sizes", label: "Size" },
  { id: "health", label: "Match rate" },
  { id: "shares", label: "Pool shares" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Every per-block series in one slot, chosen by a tab in the panel's head. */
function OverTime(props: { s: PeriodSample; period: Period }) {
  const [tab, setTab] = createSignal<TabId>("fees");
  const weekly = () => props.s.weeks !== undefined;
  const shown = (): TabId => (tab() === "shares" && !weekly() ? "fees" : tab());
  const time = () => (props.period.id === "24h" ? formatMoment : formatDay);
  const h = phone() ? 160 : 200;
  const common = (x: readonly number[], what: string, dataFrom: number | undefined) => ({
    label: `${what}, ${props.period.words}`,
    x,
    domain: periodDomain(props.period, x, NOW),
    dataFrom,
    time: time(),
    height: h,
  });
  const pos = (v: number) => (v > 0 ? v : null);
  const health = createMemo(() => healthSeries(props.s.predictions.value));
  const healthNote = () =>
    healthCoverage(
      health(),
      props.s.pools.coverage?.complete ? props.s.pools.value.blockCount : undefined,
      NOW,
    );
  const layers = createMemo(() => {
    const w = props.s.weeks?.value;
    return w
      ? poolLayers(
          w.map(([timestamp, poolName, share]) => ({ timestamp, poolName, share, avgHashrate: 0 })),
          props.s.pools.value.pools.map((p) => p.name),
        )
      : undefined;
  });

  return (
    <section class="mm-section" aria-labelledby="mm-blocks">
      <SectionHeader title="Blocks over time" id="mm-blocks">
        <div class="mm-tabs" role="group" aria-label="Show">
          <For each={TABS.filter((t) => t.id !== "shares" || weekly())}>
            {(t) => (
              <button
                type="button"
                class="mm-tab"
                aria-pressed={shown() === t.id ? "true" : "false"}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
      </SectionHeader>
      <Show when={shown() === "fees"}>
        <ChartSlot
          {...common(
            props.s.fees.value.map((p) => p[0]),
            "Average fees per block",
            props.s.fees.coverage?.fromTime,
          )}
          left={{ format: btcShort, zero: true }}
          series={[
            {
              name: "Fees per block",
              draw: "area",
              values: props.s.fees.value.map((p) => p[1]),
              format: btcFull,
            },
          ]}
        />
      </Show>
      <Show when={shown() === "rates"}>
        <ChartSlot
          {...common(
            props.s.rates.value.map((p) => p[0]),
            "Fee rates paid in blocks",
            props.s.rates.coverage?.fromTime,
          )}
          left={{
            format: (v) => `${v >= 1 ? String(v) : v.toFixed(v >= 0.1 ? 1 : 2)} sat/vB`,
            log: true,
            fee: true,
          }}
          bands={[
            {
              name: "10th to 90th percentile",
              narrow: "Middle 80%",
              tone: 1,
              lo: props.s.rates.value.map((p) => pos(p[1])),
              hi: props.s.rates.value.map((p) => pos(p[5])),
              format: formatFeeRate,
              unit: "sat/vB",
            },
            {
              name: "25th to 75th percentile",
              narrow: "Middle 50%",
              tone: 2,
              lo: props.s.rates.value.map((p) => pos(p[2])),
              hi: props.s.rates.value.map((p) => pos(p[4])),
              format: formatFeeRate,
              unit: "sat/vB",
            },
          ]}
          series={[
            {
              name: "Median",
              draw: "line",
              values: props.s.rates.value.map((p) => pos(p[3])),
              format: formatFeeRate,
              unit: "sat/vB",
            },
          ]}
        />
      </Show>
      <Show when={shown() === "sizes"}>
        <ChartSlot
          {...common(
            props.s.sizes.value.map((p) => p[0]),
            "Average block size and weight",
            props.s.sizes.coverage?.fromTime,
          )}
          left={{ format: bytesText, zero: true }}
          right={{ format: percent, domain: [0, 1] }}
          series={[
            {
              name: "Size",
              draw: "area",
              values: props.s.sizes.value.map((p) => p[1]),
              format: bytesText,
            },
            {
              name: "Weight, of the limit",
              draw: "line",
              axis: "right",
              tone: 2,
              values: props.s.sizes.value.map((p) => p[2] / 4_000_000),
              format: percent,
            },
          ]}
        />
      </Show>
      <Show when={shown() === "health"}>
        <Show when={healthNote()}>
          {(text) => (
            <p class="mining-coverage mm-coverage">
              <span class="mining-coverage__swatch" aria-hidden="true" />
              {text()}
            </p>
          )}
        </Show>
        <ChartSlot
          {...common(
            health().x,
            "Match rate of each audited block",
            healthNote() === undefined ? undefined : health().first,
          )}
          time={formatMoment}
          left={{ format: (v) => `${v}%`, domain: [0, 100] }}
          series={[
            {
              name: health().per > 1 ? "Lowest match rate" : "Match rate",
              values: health().rate,
              draw: "area",
              format: (v) => `${v.toFixed(2)}%`,
            },
          ]}
          notes={[{ name: "Block", values: health().height, format: groupDigits }]}
          gap={Number.POSITIVE_INFINITY}
          href={(i) => {
            const b = health().height[i];
            return typeof b === "number" ? paths.block(b) : undefined;
          }}
        />
      </Show>
      <Show when={shown() === "shares" && layers()}>
        {(l) => (
          <ChartSlot
            {...common(
              l().x,
              "Share of blocks by pool, week by week",
              props.s.weeks?.coverage?.fromTime,
            )}
            domain={undefined}
            left={{ format: percent, domain: [0, 1] }}
            layers={l().layers}
            layerFormat={formatShare}
            time={(t) => `Week of ${formatDay(t)}`}
          />
        )}
      </Show>
    </section>
  );
}

function Adjustments() {
  const [all, setAll] = createSignal(false);
  const rows = () => (all() ? COMMON.adjustments : COMMON.adjustments.slice(0, ADJ_SHOWN));
  return (
    <section class="mm-section" aria-labelledby="mm-adj">
      <SectionHeader title="Difficulty adjustments" id="mm-adj">
        Every 2 016 blocks
      </SectionHeader>
      <table class="mm-adj">
        <caption class="visually-hidden">Difficulty adjustments, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Block</th>
            <th scope="col" class="mm-num">
              Change
            </th>
            <th scope="col" class="mm-num">
              Difficulty
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(a) => {
              const c = change(adjustmentPercent(a[3]));
              return (
                <tr>
                  <th scope="row">
                    <Link class="num mm-adj__block" href={paths.block(a[1])}>
                      {groupDigits(a[1])}
                    </Link>
                    <time class="mm-adj__when" datetime={isoTime(a[0])} title={formatUtc(a[0])}>
                      {formatRelative(a[0], NOW)}
                    </time>
                  </th>
                  <td class="mm-num">
                    <span aria-hidden="true">{c.arrow} </span>
                    {c.text}
                  </td>
                  <td class="mm-num">{difficultyFull(a[2])}</td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
      <div class="mm-foot">
        <button class="btn mm-btn" type="button" onClick={() => setAll(!all())}>
          {all() ? "Latest only" : "Older adjustments"}
        </button>
      </div>
    </section>
  );
}

const MAX_WEIGHT = 4_000_000;

/** The live page's tiles, one row: a phone scrolls it sideways instead of stacking five rows. */
function LatestBlocks() {
  const facts = new Map(COMMON.summaries.map((s) => [s.id, s]));
  return (
    <section class="mm-section" aria-labelledby="mm-latest">
      <SectionHeader title="Latest blocks" id="mm-latest">
        <Link href={paths.blocks()}>All blocks</Link>
      </SectionHeader>
      <ol class="mining-tiles mm-tiles" aria-label="Latest blocks, newest first">
        <For each={COMMON.blocks}>
          {(b) => {
            const f = facts.get(b.id);
            const full = Math.min(1, b.weight / MAX_WEIGHT);
            const layers = f ? strataLayers(f.fee_bands, full, 0.045) : [];
            return (
              <li class="mining-tile">
                <Link class="mining-tile__body" href={paths.block(b.id)}>
                  <span class="mining-tile__height num">
                    <span class="visually-hidden">Block </span>
                    {groupDigits(b.height)}
                    <Show when={f?.miner}>
                      {(m) => <span class="visually-hidden">, mined by {m().name}</span>}
                    </Show>
                  </span>
                  <span class="mining-tile__fee num">
                    <Show when={f?.fee_rate}>{(r) => <FeeRate rate={r().median} />}</Show>
                  </span>
                  <span class="mining-tile__strata" aria-hidden="true">
                    <Strata layers={layers} />
                  </span>
                  <span class="mining-tile__foot">
                    <span class="num">{groupDigits(b.tx_count)} tx</span>
                    <time
                      class="num"
                      datetime={isoTime(b.timestamp)}
                      title={formatUtc(b.timestamp)}
                    >
                      {tileAge(b.timestamp, NOW)}
                    </time>
                  </span>
                </Link>
                <span class="mining-tile__pool" aria-hidden="true">
                  {f?.miner?.name}
                </span>
              </li>
            );
          }}
        </For>
      </ol>
    </section>
  );
}
