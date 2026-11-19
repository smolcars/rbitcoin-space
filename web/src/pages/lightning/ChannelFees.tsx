// A channel's fee rate each way over time, as this server recorded it: a step that holds each rate
// until the next, broken where the server was not recording (docs/API.md "Fee history").
import { For, lazy, Loading as Pending, Match, Show, Switch } from "solid-js";
import { formatMoment } from "../../components/chart/scale";
import "../../components/chart/Chart.css";
import { type Column, DataTable } from "../../components/DataTable";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { ErrorState, Loading } from "../../components/States";
import type { ApiResource } from "../../lib/api";
import { formatPowerOfTen, formatUtc, groupDigits, isoTime } from "../../lib/format";
import {
  type ChannelDetail,
  type End,
  type FeeHistory,
  type FeeRecord,
  changesIn,
  FEE_HISTORY,
  feeSteps,
  inboundOf,
  inboundParts,
  LONG_FIGURE,
  msatAsSats,
  ppm,
  shortName,
} from "./lightning";
import { Fig, InboundFig, MsatFig, PpmFig } from "./parts";

const Chart = lazy(() => import("../../components/chart/Chart"));

/** How many records the server keeps each way (docs/LIGHTNING.md "Fee history"). */
const KEPT = 50;

/** The plot's height; the panel holds it and the readout's while the history loads. */
const HEIGHT = 160;

/** A rate in the readout: past 10 million ppm (a fee over ten times the amount, a way of refusing
 *  to route) in magnitude, which fits a phone at any text size; the figures keep it exact. */
const reading = (v: number) => (v < 1e7 ? ppm(v) : `${formatPowerOfTen(v)} ppm`);

/** An axis tick in ppm: whole numbers only. */
const tick = (v: number) => (Number.isInteger(v) ? groupDigits(v) : "");

export function ChannelFees(props: {
  channel: ChannelDetail;
  history: ApiResource<FeeHistory>;
  /** When the history answered: its steps run on to then, and the clock is read nowhere else. */
  now: number;
  retry: () => void;
}) {
  const ways = () => [
    { from: props.channel.node_one, to: props.channel.node_two, tone: 1 as const, key: "node_one" },
    { from: props.channel.node_two, to: props.channel.node_one, tone: 2 as const, key: "node_two" },
  ];
  return (
    <section id={FEE_HISTORY} aria-labelledby="ln-feehist-title">
      <SectionHeader title="Fee rate over time" id="ln-feehist-title">
        Last {KEPT} changes each way
      </SectionHeader>
      <Show
        when={props.history.state !== "errored"}
        fallback={
          <ErrorState
            title="Could not load its fee history"
            error={props.history.error}
            retry={() => props.retry()}
          />
        }
      >
        <div class="ln-feehist">
          <For each={ways()}>
            {(w) => (
              <div class={`ln-feehist__way ln-lane--${w.tone}`}>
                <h3 class="ln-feehist__title">
                  <span>
                    <bdi>{shortName(w.from)}</bdi> → <bdi>{shortName(w.to)}</bdi>
                  </span>
                  <Show when={w.from.policy}>
                    {(p) => (
                      <span class="ln-feehist__now">
                        <PpmFig rate={p().fee_rate} />
                      </span>
                    )}
                  </Show>
                </h3>
                <Show
                  when={props.history.latest}
                  fallback={
                    <div class="ln-feehist__plot">
                      <Loading label="Loading its fee history" />
                    </div>
                  }
                >
                  {(h) => (
                    <Way
                      from={w.from}
                      to={w.to}
                      tone={w.tone}
                      records={w.key === "node_one" ? h().node_one.records : h().node_two.records}
                      history={h()}
                      now={props.now}
                    />
                  )}
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <More>
        <p>
          What each end advertised, as gossip showed it to this server, not what payments paid. A
          step holds a rate until the next change; a gap is time the server was not recording, and
          changes made then are missing, but the last. Of two changes under 30 seconds apart, the
          first can be missed.
        </p>
      </More>
    </section>
  );
}

function Way(props: {
  from: End;
  to: End;
  tone: 1 | 2;
  records: FeeRecord[];
  history: FeeHistory;
  now: number;
}) {
  const steps = () => feeSteps(props.records, props.history.watched, props.now);
  // A record that charged the same as the one before (an inbound fee from none to zero) is no
  // change: with no other, the way says since when its fee has held.
  const moved = () => changesIn(props.records) > 0;
  const start = () => props.history.watched[0]?.from ?? props.records[0]?.time ?? props.now;
  const label = () => `${shortName(props.from)}'s fee rate towards ${shortName(props.to)}`;
  return (
    <Switch>
      <Match when={moved() && steps().x.length > 0}>
        <div class="ln-chart ln-feehist__plot">
          <Pending>
            <Chart
              label={label()}
              x={steps().x}
              domain={[start(), steps().x.at(-1) ?? props.now]}
              // The steps carry their own gaps (a null where the server was not recording): no
              // spacing between records is one.
              gap={Number.POSITIVE_INFINITY}
              height={HEIGHT}
              left={{ format: tick }}
              series={[
                {
                  // The panel's title names the end: a name here could not wrap at 320 px.
                  name: "Charges",
                  values: steps().y,
                  draw: "step",
                  tone: props.tone,
                  format: reading,
                  rawUnit: "ppm",
                },
              ]}
              time={formatMoment}
              table={() => <Records records={props.records} label={label()} />}
            />
          </Pending>
        </div>
      </Match>
      {/* Records with no stretch the server says it was recording: their figures, no line. */}
      <Match when={moved()}>
        <Records records={props.records} label={label()} />
      </Match>
      <Match when={props.records[0]}>
        {(r) => (
          <p class="ln-feehist__still">
            No change seen since{" "}
            <time class="num" datetime={isoTime(r().time)} title={formatUtc(r().time)}>
              {formatMoment(r().time)}
            </time>
          </p>
        )}
      </Match>
      <Match when={true}>
        <p class="ln-feehist__still muted">
          {props.from.policy ? "Nothing recorded yet" : "No policy"}
        </p>
      </Match>
    </Switch>
  );
}

/** The records behind a chart, newest first: base and inbound fees where any record has one. */
function Records(props: { records: FeeRecord[]; label: string }) {
  const columns = (): Column<FeeRecord>[] => [
    {
      header: "Time",
      cell: (r) => (
        <time class="num" datetime={isoTime(r.time)} title={formatUtc(r.time)}>
          {formatMoment(r.time)}
        </time>
      ),
    },
    {
      header: "Fee rate, ppm",
      numeric: true,
      cell: (r) => <Fig exact={groupDigits(r.fee_rate)} short={groupDigits(r.fee_rate)} />,
    },
    ...(props.records.some((r) => r.base_fee_msat !== 0)
      ? [
          {
            header: "Base fee",
            numeric: true,
            cell: (r: FeeRecord) => <MsatFig msat={r.base_fee_msat} />,
          },
        ]
      : []),
    ...(props.records.some((r) => inboundOf(r) !== null)
      ? [
          {
            header: "Inbound fee",
            numeric: true,
            cell: (r: FeeRecord) => (
              <Show when={inboundOf(r)} fallback="None">
                {(f) => <InboundFig fee={f()} />}
              </Show>
            ),
          },
        ]
      : []),
  ];
  // A figure past 12 characters (a 32-bit rate, a base fee of thousands of sats) leaves no room
  // for columns: the records read as a labelled list.
  const long = () =>
    props.records.some((r) => {
      const f = inboundOf(r);
      return [
        groupDigits(r.fee_rate),
        msatAsSats(r.base_fee_msat),
        ...(f ? inboundParts(f) : []),
      ].some((t) => t.length > LONG_FIGURE);
    });
  return (
    <div class={{ "ln-feehist--long": long() }}>
      <DataTable
        caption={props.label}
        columns={columns()}
        rows={props.records
          .map((_, i, all) => all[all.length - 1 - i])
          .filter((r) => r !== undefined)}
      />
    </div>
  );
}
