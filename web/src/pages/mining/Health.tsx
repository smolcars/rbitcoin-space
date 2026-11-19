// Block health: how closely each block this server watched arrive matched the block it expected
// (docs/API.md "Block audits", `predictions`), over the page's period. A tab of "Blocks over time".
import { createMemo, Show } from "solid-js";
import { formatMatchRate } from "../../components/audit/model";
import { formatMoment } from "../../components/chart/scale";
import { groupDigits } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { createMiningData, type MiningData } from "./data";
import {
  answeredPeriod,
  healthCoverage,
  healthSeries,
  isPredictions,
  type Period,
  periodBlocks,
  periodDomain,
  type Ranking,
} from "./mining";
import { ChartSlot, chartHeight, NothingStored, Section } from "./parts";

const rate = (v: number) => `${formatMatchRate(v)}%`;

export function HealthChart(props: {
  period: Period;
  network: Network;
  ranking: MiningData<Ranking>;
  height: number;
}) {
  const data = createMiningData(
    () => props.network,
    () => `/v1/mining/blocks/predictions/${props.period.id}`,
    isPredictions,
  );
  const health = createMemo(() => {
    const a = data.answer();
    return a ? healthSeries(a.value) : undefined;
  });
  // While the next period loads the last answer stays, so every word follows the answer shown.
  const period = (): Period => answeredPeriod(data.answer()) ?? props.period;
  const blocks = () => periodBlocks(props.ranking.answer(), period());
  const coverage = () => {
    const h = health();
    return h ? healthCoverage(h, blocks()) : undefined;
  };
  const count = () => health()?.count ?? 0;
  const per = () => health()?.per ?? 1;

  return (
    <Section
      what="the block audits"
      reserve={chartHeight(props.height)}
      hold={count() > 0}
      ready={health() !== undefined}
      error={data.error()}
      retry={data.retry}
      busy={data.loading()}
    >
      <Show when={count() > 0} fallback={<NothingStored what="block audits" period={period()} />}>
        <p class="mining-coverage">
          <Show when={coverage()}>
            <span class="mining-coverage__swatch" aria-hidden="true" />
          </Show>
          {/* No coverage note means every block of the period has an audit. */}
          {coverage() ?? `All ${groupDigits(count())} blocks audited.`}
          {per() > 1 ? ` Each point is the lowest of ${groupDigits(per())} in a row.` : ""}
        </p>
        <ChartSlot
          label={`Match rate of each audited block, ${period().words}`}
          x={health()?.x ?? []}
          domain={periodDomain(period(), health()?.x ?? [], Date.now() / 1000)}
          // Before the first audit nothing is stored, unless the period's every block has one.
          dataFrom={coverage() === undefined ? undefined : health()?.first}
          height={props.height}
          left={{ format: (v) => `${v}%`, domain: [0, 100] }}
          series={[
            {
              name: per() > 1 ? "Lowest match rate" : "Match rate",
              values: health()?.rate ?? [],
              draw: "area",
              format: rate,
              rawUnit: "%",
            },
          ]}
          notes={[
            { name: "Block", values: health()?.height ?? [], format: groupDigits },
            ...(per() > 1
              ? [
                  {
                    name: "Audited",
                    values: health()?.audited ?? [],
                    format: (n: number) => `${groupDigits(n)} of ${groupDigits(per())}`,
                  },
                ]
              : []),
          ]}
          // Only a block with no audit breaks the line, however long miners took between two.
          gap={Number.POSITIVE_INFINITY}
          time={formatMoment}
          href={(i) => {
            const h = health()?.height[i];
            return typeof h === "number" ? paths.block(h) : undefined;
          }}
        />
      </Show>
    </Section>
  );
}
