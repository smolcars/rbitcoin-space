// How this server's fee recommendations have done: each level's share met within its horizon,
// held against its target, what it cost, and what the figures rest on (docs/FRONTEND.md "Fee
// track record", docs/DESIGN.md "Fee track record").
import { useSearchParams } from "@solidjs/router";
import { For, Match, onSettled, Show, Switch, createMemo } from "solid-js";
import { type Column, DataTable } from "../../components/DataTable";
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
  type LevelView,
  levelViews,
  notOursSentence,
  parseWindow,
  type Score,
  type Standing,
  TARGET,
  TARGET_TEXT,
  WINDOWS,
  readScore,
} from "./score";
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
      const v = await fetchApp<unknown>(props.network, `/fees/score?window=${id}`, { signal });
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
      <div class="fee-score__intro">
        <p>
          How this server's fee recommendations, the numbers behind the home page's{" "}
          <Link href={paths.home()}>Fee to pay now</Link>, fared against the blocks that followed
          them. The home page rounds each one up, so a reader who paid what it showed did no worse.
          Every level is held to {TARGET_TEXT}.
        </p>
        <Show when={props.network !== "mainnet"}>
          <p class="fee-score__caveat">
            On a test network most blocks have room to spare. A block with room is judged by the
            cheapest rates it took, so an answer at the network's minimum, which would have got in
            too, counts as a miss: low shares here say more about the blocks than the answers.
          </p>
        </Show>
      </div>
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
                <Board score={s()} />
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

function Board(props: { score: Score }) {
  const views = createMemo(() => levelViews(props.score));
  const coverage = () => {
    const s = props.score;
    return s.from === null
      ? undefined
      : `The period these figures cover: ${formatUtc(s.from, false)} to ${formatUtc(s.to, false)}.`;
  };
  return (
    <>
      <section class="fee-score__levels" aria-labelledby="fee-score-met">
        <SectionHeader title="Mined in time" id="fee-score-met" />
        <Show when={coverage()}>{(text) => <p class="fee-score__coverage">{text()}</p>}</Show>
        <ul class="fee-levels">
          <For each={views()}>{(v) => <LevelRow view={v} />}</For>
        </ul>
      </section>
      <CostPanel views={views()} />
      <EvidencePanel views={views()} score={props.score} />
      <More label="How the score is kept">
        <p>
          Every 30 seconds the server notes the four rates it is recommending. Each answer is then
          judged against the blocks that came after it: it is <strong>met</strong> when its rate was
          at least 0.001 sat/vB above the clearing rate of one of the blocks it promised, the next
          block for High, the next 3 for Medium, the next 6 for Low and the next 144 for No rush.
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
          Every level is held to {TARGET_TEXT}: met at least that often. A level whose share is
          under it is shown as below target, whatever its interval.
        </p>
        <p>
          A block with room to spare is judged by the cheapest transaction it took, not the cheapest
          it would have taken, so an answer at the network's minimum counts as a miss against it. On
          mainnet, whose blocks are full, this does not arise.
        </p>
      </More>
    </>
  );
}

const VERDICT_ICON: Record<Standing, string> = {
  meets: "M4.5 8.5l2.4 2.4L11.8 5.6",
  below: "M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6",
  "too-few": "",
};

function LevelRow(props: { view: LevelView }) {
  const v = () => props.view;
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
        <svg class="fee-level__icon" viewBox="0 0 16 16" aria-hidden="true">
          <Show
            when={v().standing !== "too-few"}
            fallback={<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.6 2" />}
          >
            <path d={VERDICT_ICON[v().standing]} />
          </Show>
        </svg>
        {v().verdict}
      </p>
      <p class="fee-level__detail">
        <Show when={v().interval}>
          {(range) => (
            <>
              95% interval <span class="num">{range()}</span>.{" "}
            </>
          )}
        </Show>
        {v().detail} {v().evidence.charAt(0).toUpperCase() + v().evidence.slice(1)}.
      </p>
    </li>
  );
}

/** The share on a 0 to 100% line: the interval as a band, the share as a mark, the target. */
function Meter(props: { view: LevelView }) {
  const marks = () => props.view.marks;
  return (
    <div class="fee-meter" aria-hidden="true" style={{ "--target": `${TARGET * 100}%` }}>
      <span class="fee-meter__target-label num">{TARGET_TEXT}</span>
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
      <span class="fee-meter__ends num">
        <span>0%</span>
        <span>100%</span>
      </span>
    </div>
  );
}

function CostPanel(props: { views: LevelView[] }) {
  const cell = (v: LevelView, value: string | undefined, kind: "met" | "missed") => (
    <Show when={value} fallback={<span class="muted">{costGap(v, kind)}</span>}>
      {(text) => <span class="num">{text()}</span>}
    </Show>
  );
  const columns: Column<LevelView>[] = [
    { header: "Level", cell: (v) => v.name },
    {
      header: "Overpaid when met, mean",
      short: "Over, mean",
      sub: "sat/vB",
      numeric: true,
      cell: (v) => cell(v, costView(v).overpayMean, "met"),
    },
    {
      header: "Overpaid when met, median",
      short: "Over, median",
      sub: "sat/vB",
      numeric: true,
      cell: (v) => cell(v, costView(v).overpayMedian, "met"),
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
      <div class="fee-score__prose">
        <p>
          <strong>Overpaid</strong> is how far an answer that was met paid above the lowest rate
          that would have counted as getting in: 0.001 sat/vB over the cheapest clearing rate among
          the blocks it promised.
        </p>
        <p>
          <strong>Short</strong> is how far an answer that missed was below that same lowest rate.
        </p>
      </div>
      <DataTable
        caption="What each level paid above, or fell short of, the rate that sufficed"
        columns={columns}
        rows={props.views}
      />
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
      header: "Left out: not finished",
      short: "Not finished",
      numeric: true,
      cell: (v) => count(v.source.leftOut.unfinished),
    },
    {
      header: "Left out: outage",
      short: "Outage",
      numeric: true,
      drop: 1,
      cell: (v) => count(v.source.leftOut.outage),
    },
    {
      header: "Left out: no clearing rate",
      short: "No rate",
      numeric: true,
      drop: 1,
      cell: (v) => count(v.source.leftOut.noClearing),
    },
  ];
  return (
    <section class="fee-score__evidence" aria-labelledby="fee-score-evidence">
      <SectionHeader title="What the figures rest on" id="fee-score-evidence" />
      <DataTable
        caption="The answers and blocks behind each level's figure, and the answers left out"
        columns={columns}
        rows={props.views}
      />
      <div class="fee-score__prose">
        <p>
          Some answers are left out rather than judged. <strong>Not finished</strong>: the blocks
          they promised have not all come yet; No rush waits 144 blocks, about a day.{" "}
          <strong>Outage</strong>: their blocks reached into a gap of over two hours between
          recorded blocks, which the server takes as an outage, or into the half hour after it,
          while the mempool refills. <strong>No clearing rate</strong>: none of their blocks has a
          rate that got in, because the server had seen none of those blocks' transactions waiting,
          or missed the blocks.
        </p>
        <Show when={notOursSentence(props.score)}>{(text) => <p>{text()}</p>}</Show>
      </div>
    </section>
  );
}
