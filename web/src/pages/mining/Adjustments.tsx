// Past difficulty adjustments (docs/API.md "Mining", `difficulty-adjustments`), newest first. The
// next one is a figure at the top of the page.
import { createSignal, Show } from "solid-js";
import { DataTable } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { TimeAgo } from "../../components/Time";
import { change, PERIOD, retargets } from "../../lib/difficulty";
import { groupDigits } from "../../lib/format";
import { NETWORK_NAMES, type Network, paths } from "../../lib/network";
import type { MiningData } from "./data";
import { type Adjustment, adjustmentPercent, parsePeriod } from "./mining";
import { CoverageNote, difficultyFull, Section } from "./parts";

/** Rows shown before "Show all": about three months, as tall as the pools beside them. */
const SHOWN = 6;

/** A change as an arrow and words, never by colour: `↑ Up 5.54%`. */
export function Change(props: { percent: number }) {
  const c = () => change(props.percent);
  return (
    <span class="num">
      <span class="mining-arrow" aria-hidden="true">
        {c().arrow}
      </span>
      {c().text}
    </span>
  );
}

export function Adjustments(props: { network: Network; past: MiningData<Adjustment[]> }) {
  const [all, setAll] = createSignal(false);
  const list = () => props.past.answer()?.value ?? [];
  const rows = () => (all() ? list() : list().slice(0, SHOWN));

  return (
    <section class="mining-section" aria-labelledby="mining-adjustments-title">
      <SectionHeader title="Difficulty adjustments" id="mining-adjustments-title">
        Every {groupDigits(PERIOD)} blocks
      </SectionHeader>
      <Section
        what="the past adjustments"
        reserve="18rem"
        hold={false}
        ready={props.past.answer() !== undefined}
        error={props.past.error()}
        retry={props.past.retry}
        busy={props.past.loading()}
      >
        <CoverageNote coverage={props.past.answer()?.coverage} period={parsePeriod("all")} />
        <Show
          when={list().length > 0}
          fallback={
            <p class="mining-aside">
              {retargets(props.network)
                ? "No adjustments are stored yet."
                : `${NETWORK_NAMES[props.network]} never adjusts its difficulty, so there are none to list.`}
            </p>
          }
        >
          <div class="mining-compact">
            <DataTable
              caption="Difficulty adjustments, newest first"
              rows={rows()}
              rowHref={(a: Adjustment) => paths.block(a[1])}
              columns={[
                {
                  header: "Block",
                  cell: (a: Adjustment) => (
                    <span class="mining-retarget">
                      <Link class="num" href={paths.block(a[1])}>
                        {groupDigits(a[1])}
                      </Link>
                      <span class="mining-retarget__age">
                        <TimeAgo time={a[0]} />
                      </span>
                    </span>
                  ),
                },
                {
                  header: "Change",
                  numeric: true,
                  cell: (a: Adjustment) => <Change percent={adjustmentPercent(a[3])} />,
                },
                {
                  header: "Difficulty",
                  numeric: true,
                  cell: (a: Adjustment) => difficultyFull(a[2]),
                },
              ]}
            />
          </div>
          <Show when={list().length > SHOWN}>
            <button class="btn mining-more" type="button" onClick={() => setAll(!all())}>
              {all()
                ? "Show the latest only"
                : `Show all ${groupDigits(list().length)} adjustments`}
            </button>
          </Show>
        </Show>
      </Section>
    </section>
  );
}
