// How this server's fee recommendations have done: each level's share met within its horizon,
// held against its target, what it cost, and what the figures rest on (docs/FRONTEND.md "Fee
// track record", docs/DESIGN.md "Fee track record").
import { useSearchParams } from "@solidjs/router";
import { For, Match, onSettled, Show, Switch, createMemo } from "solid-js";
import type { Column } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { Periods } from "../../components/Periods";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { ApiError, createRequest, fetchApp } from "../../lib/api";
import { formatUtc, groupDigits } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import {
  costGap,
  costView,
  hasSamples,
  leftOutView,
  type LevelView,
  levelViews,
  notOursSentence,
  parseWindow,
  type Score,
  TARGET,
  TARGET_TEXT,
  WINDOWS,
  readScore,
} from "./score";
import { LevelTable } from "./LevelTable";
import "./FeeScorePage.css";

/** The server rebuilds the score after every 30 s sample; a minute is fresh enough to read. */
const REFRESH_MS = 60_000;

export const TITLE = "Fee track record";

/** The mempool engine is off: the server keeps no score, and no retry changes that. */
const isEngineOff = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 503 && /engine is off/i.test(e.message);
/** The server has just started and has not built its first answer. */
const isNotReady = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 503 && /not ready/i.test(e.message);

export default function FeeScorePage() {
  usePageTitle(() => TITLE);
  const network = useNetwork();
  // Everything on the page belongs to one network: switching networks starts it afresh.
  return (
    <Show when={network()} keyed>
      {(n) => <FeeScore network={n} />}
    </Show>
  );
}

function FeeScore(props: { network: Network }) {
  const [search] = useSearchParams();
  const win = createMemo(() => parseWindow(search["window"]));
  const [request, { refetch }] = createRequest(
    () => win().id,
    async (id, signal) => {
      const v = await fetchApp<unknown>(props.network, `/fees/score?window=${id}`, {
        signal,
        cached: true,
      });
      const score = readScore(v);
      // An answer for another window than the one asked would be drawn under the wrong tab.
      if (!score || score.window !== id)
        throw new ApiError(200, "The server sent a reply that could not be read.");
      return score;
    },
  );
  // The last answer stays while the next loads, so a new window never empties the page.
  const answer = () => request.latest;
  const current = () => answer()?.window === win().id;

  onSettled(() => {
    const timer = setInterval(() => {
      // Never cut short an ask still in flight (or retrying a busy server): it would never finish.
      if (!document.hidden && request.state !== "errored" && !request.loading) refetch();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  });

  return (
    <div class="wrap fee-score">
      <header class="fee-score__head">
        <h1>{TITLE}</h1>
        <Periods choices={WINDOWS} current={win().id} href={paths.feeScore} fitted={false} />
      </header>
      <p class="fee-score__intro">
        How often this server's recommended fees, behind the home page's{" "}
        <Link href={paths.home()}>Fee to pay now</Link>, were mined in time, against an{" "}
        {TARGET_TEXT} target.
      </p>
      <Show
        when={request.state !== "errored"}
        fallback={<Failure error={request.error} retry={refetch} />}
      >
        <Show
          when={answer()}
          fallback={
            <div class="fee-score__slot">
              <Loading label="Loading the fee track record" />
            </div>
          }
        >
          {(s) => (
            <div
              class="fee-score__busy"
              aria-busy={current() && !request.loading ? "false" : "true"}
            >
              <Show when={hasSamples(s())} fallback={<NothingRecorded score={s()} />}>
                <Board score={s()} testNet={props.network !== "mainnet"} />
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

function Failure(props: { error: unknown; retry: () => void }) {
  return (
    <Switch
      fallback={
        <ErrorState
          title="Could not load the fee track record"
          error={props.error}
          retry={props.retry}
        />
      }
    >
      <Match when={isEngineOff(props.error)}>
        <Empty title="This server keeps no fee track record">
          It scores its fee recommendations only while it follows the mempool, and this one was
          started with that switched off, so it makes no recommendations of its own to score.
        </Empty>
      </Match>
      <Match when={isNotReady(props.error)}>
        <div class="state state--empty">
          <p class="state__title">The track record is not ready yet</p>
          <p class="state__text">
            The server has only just started. It builds the record from its first sample, within 30
            seconds.
          </p>
          <button class="btn" type="button" onClick={() => props.retry()}>
            Try again
          </button>
        </div>
      </Match>
    </Switch>
  );
}

/** Nothing in the window: say whether anything was ever recorded, and offer all of it. */
function NothingRecorded(props: { score: Score }) {
  return (
    <Show
      when={props.score.window !== "all"}
      fallback={
        <Empty title="Nothing recorded yet">
          This server notes the fee it recommends every 30 seconds and judges each answer once the
          blocks it was meant for have come. The first next-block answer is judged after the next
          block.
        </Empty>
      }
    >
      <Empty title="Nothing recorded in this period">
        The server was not recording its answers then.{" "}
        <Link href={paths.feeScore("all")}>See everything recorded</Link>
      </Empty>
    </Show>
  );
}

function Board(props: { score: Score; testNet: boolean }) {
  const views = createMemo(() => levelViews(props.score, props.testNet));
  const coverage = () => {
    const s = props.score;
    return s.from === null
      ? undefined
      : `${formatUtc(s.from, false).replace(/ UTC$/, "")} to ${formatUtc(s.to, false)}`;
  };
  return (
    <>
      <section class="fee-score__levels" aria-labelledby="fee-score-met">
        <SectionHeader title="Mined in time" id="fee-score-met">
          <span class="fee-score__key" aria-hidden="true">
            <span class="fee-score__scale">Lines 0–100%</span>
            <span class="fee-key-item">
              <span class="fee-key fee-key--target" />
              {TARGET_TEXT} target
            </span>
            <span class="fee-key-item">
              <span class="fee-key fee-key--band" />
              95% interval
            </span>
          </span>
        </SectionHeader>
        <ul class="fee-levels">
          <For each={views()}>{(v) => <LevelRow view={v} />}</For>
        </ul>
        <Show when={props.testNet}>
          <p class="fee-score__caveat">
            <DashedCircle />
            <span>
              On a test network most blocks have room to spare, and a block with room is judged by
              the cheapest rate it took: an answer at the network's minimum, which would have got in
              too, counts as a miss. So a share under {TARGET_TEXT} here is not called a failure.
            </span>
          </p>
        </Show>
        <Show when={coverage()}>
          {(text) => <p class="fee-score__coverage">These figures cover {text()}.</p>}
        </Show>
      </section>
      <div class="fee-score__tables">
        <CostPanel views={views()} />
        <EvidencePanel views={views()} score={props.score} />
      </div>
      <More label="How the score is kept">
        <p>
          Every 30 seconds the server notes the four rates it is recommending. Each answer is then
          judged against the blocks that came after it: it is <strong>met</strong> when its rate was
          at least 0.001 sat/vB above the clearing rate of one of the blocks it promised, the next
          block for High, the next 3 for Medium, the next 6 for Low and the next 144 for No rush.
          The home page rounds each rate up, so a reader who paid what it showed did no worse.
        </p>
        <p>
          A block's clearing rate comes from the effective rates the server's last projection before
          the block gave the block's transactions: the rate of the group each was to be mined with,
          which can differ from what a single transaction paid on its own. It is the rate at the
          cheapest 1% of them by size, which limits the effect of a few small transactions a miner
          let in for its own reasons; a cheap one larger than that 1% still sets it.
        </p>
        <p>
          Answers given just before the same block share its fate, so the evidence is the number of
          blocks that decided them, not the number of answers. The 95% interval is the range the
          true share most likely lies in, given that evidence. Under {props.score.minBlocks} blocks
          no share is given: the interval would be too wide to say anything.
        </p>
        <p>
          Every level is held to {TARGET_TEXT}: met at least that often. On mainnet a level whose
          share is under it is shown as below target, whatever its interval.
        </p>
        <p>
          Some answers are left out rather than judged. <strong>Not finished</strong>: the blocks
          they promised have not all come yet; No rush waits 144 blocks, about a day.{" "}
          <strong>Outage</strong>: their blocks reached into a gap of over two hours between
          recorded blocks, which the server takes as an outage, or into the half hour after it,
          while the mempool refills. <strong>No clearing rate</strong>: none of their blocks has a
          rate that got in, because the server had seen none of those blocks' transactions waiting,
          or missed the blocks.
        </p>
        <p>
          A block with room to spare is judged by the cheapest transaction it took, not the cheapest
          it would have taken, so an answer at the network's minimum counts as a miss against it. On
          mainnet, whose blocks are full, this does not arise; on a test network a share under the
          target is therefore marked "Not a fair test here" rather than below target.
        </p>
      </More>
    </>
  );
}

const VERDICT_ICON: Record<"meets" | "below", string> = {
  meets: "M4.5 8.5l2.4 2.4L11.8 5.6",
  below: "M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6",
};

/** The mark of a verdict that is not one: too few blocks, or a test the blocks did not allow. */
function DashedCircle() {
  return (
    <svg class="fee-level__icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke-dasharray="2.6 2" />
    </svg>
  );
}

function LevelRow(props: { view: LevelView }) {
  const v = () => props.view;
  const icon = () => {
    const s = v().standing;
    return s === "meets" || s === "below" ? VERDICT_ICON[s] : undefined;
  };
  return (
    <li class={["fee-level", `fee-level--${v().standing}`]}>
      <div class="fee-level__name">
        <h3>{v().name}</h3>
        <span class="fee-level__when">{v().when}</span>
      </div>
      <div class="fee-level__figure">
        <Show
          when={v().met}
          fallback={
            <span class="fee-level__met fee-level__met--none" aria-hidden="true">
              –
            </span>
          }
        >
          {(met) => <span class="fee-level__met num">{met()}</span>}
        </Show>
        <span class="fee-level__said">
          <Show when={v().met} fallback={<span class="visually-hidden">No share yet</span>}>
            mined within {v().horizon}
          </Show>
        </span>
      </div>
      <Meter view={v()} />
      <p class="fee-level__verdict">
        <Show when={icon()} fallback={<DashedCircle />}>
          {(d) => (
            <svg class="fee-level__icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d={d()} />
            </svg>
          )}
        </Show>
        {v().verdict}
      </p>
      {/* The drawing shows the interval; the words are read aloud always, and shown when they
          add to it: the interval reaches across the target, or there is no share yet. */}
      <p class={["fee-level__detail", { "visually-hidden": !v().unsure }]}>
        <Show when={v().interval}>
          {(range) => (
            <span class="visually-hidden">
              95% interval <span class="num">{range()}</span>.{" "}
            </span>
          )}
        </Show>
        {v().detail}
      </p>
    </li>
  );
}

/**
 * The share on a 0 to 100% line: the interval as a band with its ends written under it, the share
 * as a mark, the target as a dashed line. The ends' label is centred on the band and slides to stay
 * inside the line: moved left by the band's own share of its width.
 */
function Meter(props: { view: LevelView }) {
  const marks = () => props.view.marks;
  return (
    <div class="fee-meter" aria-hidden="true" style={{ "--target": `${TARGET * 100}%` }}>
      <span class="fee-meter__end num">0%</span>
      <div
        class="fee-meter__track"
        style={
          marks()
            ? {
                "--lo": `${marks()?.lo ?? 0}%`,
                "--hi": `${marks()?.hi ?? 0}%`,
                "--met": `${marks()?.met ?? 0}%`,
              }
            : {}
        }
      >
        <Show when={marks()}>
          <span class="fee-meter__band" />
          <span class="fee-meter__mark" />
        </Show>
        <span class="fee-meter__target" />
      </div>
      <span class="fee-meter__end num">100%</span>
      <Show when={marks() && props.view.interval}>
        {(range) => (
          <span
            class="fee-meter__range num"
            style={{ "--mid": `${((marks()?.lo ?? 0) + (marks()?.hi ?? 0)) / 2}%` }}
          >
            {range()}
          </span>
        )}
      </Show>
    </div>
  );
}

function CostPanel(props: { views: LevelView[] }) {
  const cell = (v: LevelView, value: string | undefined, kind: "met" | "missed") => (
    <Show when={value} fallback={<span class="fee-score__gap">{costGap(v, kind)}</span>}>
      {(text) => <span class="num">{text()}</span>}
    </Show>
  );
  const columns: Column<LevelView>[] = [
    { header: "Level", cell: (v) => v.name },
    {
      header: "Recommended, median",
      short: "Median rate",
      sub: "sat/vB",
      numeric: true,
      cell: (v) => (
        <Show
          when={costView(v).recommended}
          fallback={
            <span class="fee-score__gap">{v.standing === "too-few" ? "too few blocks" : "–"}</span>
          }
        >
          {(text) => <span class="num">{text()}</span>}
        </Show>
      ),
    },
    {
      header: "Overpaid when met, mean · median",
      short: "Overpaid, mean over median",
      sub: "sat/vB",
      numeric: true,
      cell: (v) => {
        const c = costView(v);
        return (
          <Show
            when={c.overpayMean !== undefined && c.overpayMedian !== undefined}
            fallback={<span class="fee-score__gap">{costGap(v, "met")}</span>}
          >
            <span class="fee-score__pair">
              <span class="num">{c.overpayMean}</span>
              <span class="fee-score__sep"> · </span>
              <span class="num">{c.overpayMedian}</span>
            </span>
          </Show>
        );
      },
    },
    {
      header: "Short when missed, mean",
      short: "Short, mean",
      sub: "sat/vB",
      numeric: true,
      cell: (v) => cell(v, costView(v).shortfall, "missed"),
    },
  ];
  return (
    <section class="fee-score__cost" aria-labelledby="fee-score-cost">
      <SectionHeader title="What it cost" id="fee-score-cost" />
      <LevelTable
        caption="What each level recommended, and paid above or fell short of the rate that sufficed"
        columns={columns}
        rows={props.views}
        name={(v) => v.name}
      />
      <div class="fee-score__prose">
        <p>
          Measured from the lowest rate that would have got in, 0.001 sat/vB over the cheapest
          clearing rate among the blocks an answer promised: <strong>overpaid</strong> is how far a
          met answer paid above it, <strong>short</strong> how far a missed one fell below it.
        </p>
      </div>
    </section>
  );
}

function EvidencePanel(props: { views: LevelView[]; score: Score }) {
  const count = (n: number) => <span class="num">{groupDigits(n)}</span>;
  const columns: Column<LevelView>[] = [
    { header: "Level", cell: (v) => v.name },
    {
      header: "Answers judged",
      short: "Judged",
      numeric: true,
      cell: (v) => count(v.source.scored),
    },
    {
      header: "Blocks that decided them",
      short: "Blocks",
      numeric: true,
      cell: (v) => count(v.source.outcomes),
    },
    {
      header: "Left out",
      numeric: true,
      cell: (v) => {
        const left = leftOutView(v.source);
        return (
          <>
            <span class="num">{left.total}</span>
            <Show when={left.kinds}>
              {/* A space, so the words read "38 34 not finished", not "3834 not finished". */}
              {(kinds) => (
                <>
                  {" "}
                  <span class="fee-score__kinds">{kinds()}</span>
                </>
              )}
            </Show>
          </>
        );
      },
    },
  ];
  return (
    <section class="fee-score__evidence" aria-labelledby="fee-score-evidence">
      <SectionHeader title="What the figures rest on" id="fee-score-evidence" />
      <LevelTable
        caption="The answers and blocks behind each level's figure, and the answers left out"
        columns={columns}
        rows={props.views}
        name={(v) => v.name}
      />
      <div class="fee-score__prose">
        <p>
          An answer is left out, not judged, while its blocks have not all come, when they fell in
          an outage, or when none of them has a clearing rate.
        </p>
        <Show when={notOursSentence(props.score)}>{(text) => <p>{text()}</p>}</Show>
      </div>
    </section>
  );
}
