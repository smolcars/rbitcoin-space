import { useParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  Loading,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { DataTable } from "../../components/DataTable";
import { FeeKey, FeeRate } from "../../components/FeeRate";
import { Goggles } from "../../components/Goggles";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { Pagination } from "../../components/Pagination";
import { SectionHeader } from "../../components/SectionHeader";
import { describeBands, Strata, strataLayers, strataTop } from "../../components/Strata";
import { TimeAgo } from "../../components/Time";
import type { GridState } from "../../components/txgrid/TxGrid";
import {
  formatFeeRate,
  formatSats,
  formatSize,
  groupDigits,
  MISSING,
  truncateMiddle,
} from "../../lib/format";
import { litLabel, litOf, pick } from "../../lib/goggles";
import { useLiveStatus, useTopic } from "../../lib/live";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { type ProjectedBlock, projectedTopic } from "../../lib/projected-topic";
import {
  BlockTxs,
  PROJECTED_TXS_TOPICS,
  type ProjectedTx,
  projectedTxsTopic,
} from "../../lib/projected-txs";
import {
  dismissChange,
  FOUND_WAIT_MS,
  initialState,
  movedTo,
  onProjected,
  type PageState,
  parsePosition,
  positionName,
  PROJECTED_BLOCKS,
  type TipChange,
} from "./state";
import "./ProjectedPage.css";

// WebGL and its layout load only when a page draws them.
const TxGrid = lazy(() => import("../../components/txgrid/TxGrid"));

/** Rows in a page of the list. */
const PAGE = 25;
/** The weight a block may hold, and the vB the frame stands for. */
const MAX_WEIGHT = 4_000_000;
/** The thinnest layer in the stand-in strata, as a share of the frame (about 2 px of 400). */
const LAYER_MIN = 0.005;

const percent = (share: number) => {
  const p = share * 100;
  return `${p >= 99.95 ? "100" : p.toFixed(p < 1 ? 2 : 1)}%`;
};

/** `/block/next` and `/block/next/:n`: a block that is not mined yet, by its place in the queue. */
export default function ProjectedPage() {
  const params = useParams<{ n?: string }>();
  const position = createMemo(() => parsePosition(params.n));
  return (
    <Show when={position()} keyed fallback={<NoSuchBlock value={params.n ?? ""} />}>
      {(p) => <ProjectedView index={p - 1} />}
    </Show>
  );
}

function NoSuchBlock(props: { value: string }) {
  usePageTitle(() => "No such projected block");
  return (
    <div class="wrap projected-page projected-message">
      <h1>No such projected block</h1>
      <p class="projected-message__text">
        “{truncateMiddle(props.value, 20, 10)}” is not a place in the queue. Projected blocks are
        numbered 1 to {PROJECTED_BLOCKS} from the next one: start with{" "}
        <Link href={paths.projected(1)}>the next block</Link>.
      </p>
    </div>
  );
}

function ProjectedView(props: { index: number }) {
  const index = props.index;
  const network = useNetwork();
  const status = useLiveStatus();
  const isRest = index === PROJECTED_BLOCKS - 1;
  const hasMap = index < PROJECTED_TXS_TOPICS;
  usePageTitle(() => positionName(index));

  const [state, setState] = createSignal<PageState>(initialState);
  useTopic(projectedTopic, {
    message: (m) => setState((s) => onProjected(s, m, Date.now())),
    // The subscribe that follows a reconnect sends the whole state again.
    resync: () => undefined,
  });
  const projection = () => state().projection;
  const block = (): ProjectedBlock | undefined => projection()?.blocks[index];
  const tip = () => projection()?.tip ?? undefined;
  const paying = () => (block()?.txs ?? 0) > 0;

  // ---- The block's transactions, from its binary topic ----
  const model = new BlockTxs();
  const [txs, setTxs] = createSignal<ProjectedTx[]>();
  const [txsOff, setTxsOff] = createSignal(false);
  const [outdated, setOutdated] = createSignal(false);
  const [fresh, setFresh] = createSignal(new Set<string>());
  const [lastChange, setLastChange] = createSignal<{ in: number; out: number; at: number }>();
  if (hasMap) {
    const restart = useTopic(projectedTxsTopic(index), {
      message(m) {
        if (m.kind === "off") {
          setTxsOff(true);
          return;
        }
        // Data again after `off`: the server's mempool was switched back on.
        setTxsOff(false);
        const first = model.seq === undefined && model.txs.size === 0;
        const r = model.apply(m);
        if (r.result === "lost") restart();
        else if (r.result === "version") setOutdated(true);
        else if (r.result === "changed") {
          setTxs([...model.txs.values()]);
          // The first picture is not news; after it, rows that came in flash once.
          setFresh(new Set(first ? [] : r.added));
          if (!first) setLastChange({ in: r.added.length, out: r.removed.length, at: Date.now() });
          const c = state().change;
          if (r.snapshot && c && model.seq !== undefined && model.seq >= BigInt(c.seq)) {
            setShown(c.at);
          }
        }
      },
      resync: () => model.expectSnapshot(),
    });
    onSettled(() => void TxGrid.preload());
  }

  const off = () => state().status === "off" || txsOff();
  const stale = () => projection()?.stale === true;
  const height = () => {
    const t = tip();
    return t ? t.height + index + 1 : undefined;
  };

  // ---- The list: every transaction, highest rate first, a page at a time ----
  // Ties have no meaningful order (docs/MEMPOOL.md); by txid, so rows never swap between updates.
  const sorted = createMemo(() =>
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array; toSorted is newer than the browsers we build for
    [...(txs() ?? [])].sort((a, b) => b.rate - a.rate || (a.id < b.id ? -1 : 1)),
  );
  const [page, setPage] = createSignal(1);
  const pageCount = () => Math.max(1, Math.ceil(sorted().length / PAGE));
  createEffect(
    () => ({ at: page(), last: pageCount() }),
    ({ at, last }) => {
      if (at > last) setPage(last);
    },
  );
  const rows = () => sorted().slice((page() - 1) * PAGE, page() * PAGE);
  const [highlight, setHighlight] = createSignal<string>();
  const rowAt = (e: Event) => {
    const row = e.target instanceof Element ? e.target.closest("tbody tr") : null;
    const i = row?.parentElement ? [...row.parentElement.children].indexOf(row) : -1;
    setHighlight(i >= 0 ? rows()[i]?.id : undefined);
  };

  // ---- When the chain moves: say so once, politely ----
  const change = () => state().change;
  // The block's new picture follows the projection on it at once (docs/WS.md), but it can be large:
  // on a page with a map the moment waits for it, a snapshot from that projection on, or
  // FOUND_WAIT_MS, so it is never told over the old map.
  const [shown, setShown] = createSignal<number>();
  let wait: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(wait));
  createEffect(
    () => change()?.at,
    (at) => {
      clearTimeout(wait);
      if (at === undefined) return;
      if (!hasMap || model.txs.size === 0) setShown(at);
      else wait = setTimeout(() => setShown(at), FOUND_WAIT_MS);
    },
    { defer: true },
  );
  const told = () => {
    const c = change();
    return c && shown() === c.at ? c : undefined;
  };
  const [announce, setAnnounce] = createSignal("");
  createEffect(
    shown,
    () => {
      const c = told();
      if (c) setAnnounce(sentence(c.change, index));
    },
    { defer: true },
  );

  const expected = () => {
    if (network() === "regtest") return "Whenever someone mines: regtest has no schedule";
    if (isRest) return `Not before about ${PROJECTED_BLOCKS * 10} minutes, on average`;
    if (index === 0) return "Any time: blocks come about every 10 minutes, at random";
    return `In about ${(index + 1) * 10} minutes, on average`;
  };

  return (
    <div class="wrap projected-page">
      <nav class="projected-pager" aria-label="Neighbouring blocks">
        <span>
          <Show
            when={index > 0}
            fallback={
              <Show when={tip()} fallback={<span class="projected-skel" aria-hidden="true" />}>
                {(t) => (
                  <Link class="tap" href={paths.block(t().hash)} rel="prev">
                    ← Newest mined: <span class="num">{groupDigits(t().height)}</span>
                  </Link>
                )}
              </Show>
            }
          >
            <Link class="tap" href={paths.projected(index)} rel="prev">
              ← {positionName(index - 1)}
            </Link>
          </Show>
        </span>
        <Show when={!isRest}>
          <span class="projected-pager__next">
            <Link class="tap" href={paths.projected(index + 2)} rel="next">
              {positionName(index + 1)}
              {" →"}
            </Link>
          </span>
        </Show>
      </nav>

      <header class="projected-head">
        <div class="projected-head__title">
          <h1>{positionName(index)}</h1>
          <span class="projected-badge">
            <svg class="projected-badge__icon" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" />
            </svg>
            Projected
          </span>
          <LiveState status={status()} stale={stale()} off={off()} />
        </div>
        {/* One line says what this is; how it changes is a tap away. */}
        <p class="projected-head__lede">
          <Show when={!isRest} fallback="Everything still waiting beyond the seven blocks ahead.">
            <Show when={height()} fallback="A block that is not mined yet.">
              {(h) => (
                <>
                  What block <span class="num">{groupDigits(h())}</span> would hold if it were mined
                  now.
                </>
              )}
            </Show>
          </Show>
        </p>
        <More label="How this changes">
          <p>
            {isRest
              ? "Transactions that pay too little to fit in the seven blocks ahead for now. It shrinks as blocks are found and grows as transactions arrive."
              : index === 0
                ? "It changes as transactions arrive and outbid each other, and the miner who finds it builds their own, usually much the same."
                : `They pay too little to fit in ${positionName(index - 1, true)}, and will move up as blocks are found.`}
          </p>
        </More>
      </header>

      <p class="visually-hidden" role="status">
        {announce()}
      </p>

      <Show when={told()}>
        {(c) => (
          <ChangeNotice
            change={c().change}
            at={c().at}
            index={index}
            onDismiss={() => setState(dismissChange)}
          />
        )}
      </Show>

      <Switch>
        <Match when={outdated()}>
          <p class="projected-notice projected-notice--caution">
            The server sends this block in a newer format than this page reads. Reload the page to
            update it.
          </p>
        </Match>
        <Match when={stale() && state().staleSince}>
          {(since) => (
            <p class="projected-notice projected-notice--caution">
              <strong>Not current.</strong> The server lost touch with its node{" "}
              <TimeAgo time={since() / 1000} />. This is the last picture it had; it will move again
              when the node answers.
            </p>
          )}
        </Match>
      </Switch>

      <Show when={!off()} fallback={<Off />}>
        <div class="projected-layout">
          <dl class="projected-facts panel">
            <Fact
              label="Transactions"
              value={block() && <span class="num">{groupDigits(block()?.txs ?? 0)}</span>}
            />
            <Fact
              label="Size"
              value={block() && <span class="num">{formatSize(block()?.vsize ?? 0)}</span>}
              sub={block() && sizeNote(block() as ProjectedBlock, isRest)}
            />
            <Fact
              label="Median fee rate"
              value={
                block() && (paying() ? <FeeRate rate={block()?.medianRate ?? 0} approx /> : MISSING)
              }
              sub={paying() ? "Half the block's size pays more" : undefined}
            />
            <Fact
              label="Fee range"
              value={
                block() &&
                (paying() ? (
                  // Two figures: the range may wrap after its dash, never inside a figure or its unit.
                  <span>
                    <span class="num">~{formatFeeRate(block()?.minRate ?? 0)}&nbsp;–</span>{" "}
                    <span class="num">
                      {formatFeeRate(block()?.maxRate ?? 0)}
                      <span class="unit">&nbsp;sat/vB</span>
                    </span>
                  </span>
                ) : (
                  MISSING
                ))
              }
            />
            <Fact
              label="Fees"
              wide
              value={block() && <Amount sats={block()?.fees ?? 0} />}
              sub={block() && `${formatSats(block()?.fees ?? 0)} sats, the miner's subsidy aside`}
            />
            <Fact label="Expected" wide value={expected()} />
          </dl>
          <CoreSample
            index={index}
            block={block()}
            txs={hasMap ? txs() : undefined}
            highlight={highlight()}
            found={told()?.at}
            lastChange={lastChange()}
          />
        </div>

        <Show when={hasMap}>
          <section class="projected-txs" aria-labelledby="projected-txs-title">
            <SectionHeader title="Transactions" id="projected-txs-title">
              <Show when={txs()} fallback={<span class="projected-skel" aria-hidden="true" />}>
                <span class="num">{groupDigits(sorted().length)}, highest fee rate first</span>
              </Show>
            </SectionHeader>
            {/* A row under the pointer or focus rings its rectangle in the map. */}
            <div
              class="projected-txs__table"
              onPointerOver={rowAt}
              onFocusIn={rowAt}
              onPointerLeave={() => setHighlight(undefined)}
              onFocusOut={() => setHighlight(undefined)}
            >
              <DataTable
                caption={`Transactions in ${positionName(index, true)}, highest fee rate first`}
                columns={columns}
                rows={rows()}
                rowHref={(t) => paths.tx(t.id)}
                rowClass={(tx) => (fresh().has(tx.id) ? "projected-txs__row--new" : undefined)}
                empty={
                  <p class="projected-txs__empty">
                    {txs() ? "None: this block is empty for now." : "Waiting for the server…"}
                  </p>
                }
              />
            </div>
            <Show when={pageCount() > 1}>
              <div class="projected-txs__pages">
                <Pagination
                  page={page()}
                  pageCount={pageCount()}
                  onPage={setPage}
                  label="Pages of transactions"
                />
              </div>
            </Show>
          </section>
        </Show>
      </Show>
    </div>
  );

  function Off() {
    return (
      <div class="projected-off">
        <h2 class="projected-off__title">The live mempool is off on {NETWORK_NAMES[network()]}</h2>
        <p class="projected-off__text">
          This server is not following {NETWORK_NAMES[network()]}'s mempool, so it has no projected
          blocks to show. Mined blocks are all still here: start from{" "}
          <Link href={paths.blocks()}>the newest blocks</Link>.
        </p>
      </div>
    );
  }
}

function sizeNote(b: ProjectedBlock, isRest: boolean): string {
  if (!isRest) return `${percent(Math.min(1, b.weight / MAX_WEIGHT))} of a block's limit`;
  const blocks = b.weight / MAX_WEIGHT;
  if (b.txs === 0) return "";
  return blocks < 1
    ? "Less than a block's worth"
    : `≈ ${groupDigits(Math.ceil(blocks))} blocks' worth`;
}

/** What happened, in one sentence, for the live region. */
function sentence(c: TipChange, index: number): string {
  if (c.kind === "reorg") {
    return `The chain switched branches. ${positionName(index)} is now projected on block ${groupDigits(c.tip.height)}.`;
  }
  const many = c.tip.height > c.first;
  const found = many
    ? `Blocks ${groupDigits(c.first)} to ${groupDigits(c.tip.height)} were found.`
    : `Block ${groupDigits(c.tip.height)} was found.`;
  return `${found} This page now shows ${positionName(index, true)} after ${many ? "them" : "it"}.`;
}

const reorged = (c: TipChange) => (c.kind === "reorg" ? c : undefined);

function title(c: TipChange): JSX.Element {
  if (c.kind === "reorg") return "The chain switched branches";
  if (c.tip.height === c.first) {
    return (
      <>
        Block <span class="num">{groupDigits(c.tip.height)}</span> was found
      </>
    );
  }
  return (
    <>
      Blocks{" "}
      <span class="num">
        {groupDigits(c.first)} to {groupDigits(c.tip.height)}
      </span>{" "}
      were found
    </>
  );
}

function ChangeNotice(props: {
  change: TipChange;
  at: number;
  index: number;
  onDismiss: () => void;
}) {
  const c = () => props.change;
  const moved = () => movedTo(c(), props.index);
  const newest = () => (
    <Link href={paths.block(c().tip.hash)}>
      Open block <span class="num">{groupDigits(c().tip.height)}</span>
    </Link>
  );
  return (
    <div class="projected-found">
      <span class="projected-found__mark" aria-hidden="true" />
      <div class="projected-found__body">
        <p class="projected-found__title">
          {title(c())}{" "}
          <span class="projected-found__ago">
            <TimeAgo time={props.at / 1000} />
          </span>
        </p>
        <p class="projected-found__text">
          <Switch>
            <Match when={reorged(c())}>
              {(r) => (
                <>
                  Block <span class="num">{groupDigits(r().replaced.height)}</span> left the best
                  chain, and the projection was made again on block{" "}
                  <span class="num">{groupDigits(r().tip.height)}</span>.
                </>
              )}
            </Match>
            <Match when={props.index === 0}>
              This page now shows the next block after it, from what is still waiting.
            </Match>
            <Match when={props.index === PROJECTED_BLOCKS - 1}>
              Every projected block moved up: some of what waited here now fills{" "}
              <Link href={paths.projected(PROJECTED_BLOCKS - 1)}>
                {positionName(PROJECTED_BLOCKS - 2, true)}
              </Link>
              , and the rest still waits here.
            </Match>
            <Match when={moved() === "mined"}>
              Every projected block moved up. What this page showed was the guess at one of them; it
              now shows the block that has taken this place.
            </Match>
            {/* Compared with undefined: a block that moved up to the next place is at index 0. */}
            <Match when={moved() !== undefined}>
              Every projected block moved up. What this page showed is now{" "}
              <Link href={paths.projected(Number(moved()) + 1)}>
                {positionName(Number(moved()), true)}
              </Link>
              ; this page shows the block that has taken this place.
            </Match>
          </Switch>
        </p>
        <p class="projected-found__actions">
          {newest()}
          <button type="button" class="projected-found__dismiss" onClick={() => props.onDismiss()}>
            Dismiss
          </button>
        </p>
      </div>
    </div>
  );
}

/** The live connection, as an icon and a word. */
function LiveState(props: { status: string; stale: boolean; off: boolean }) {
  const shown = () =>
    props.off ? "off" : props.status === "live" && props.stale ? "stale" : props.status;
  const label = () =>
    ({
      live: "Live",
      connecting: "Connecting",
      reconnecting: "Reconnecting",
      offline: "Offline",
      stale: "Node not answering",
      off: "Not available",
    })[shown()] ?? "";
  return (
    <span class={`projected-live projected-live--${shown()}`}>
      <svg class="projected-live__icon" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4" />
      </svg>
      {label()}
    </span>
  );
}

function Fact(props: {
  label: string;
  value: JSX.Element | undefined;
  sub?: JSX.Element | undefined;
  wide?: boolean;
}) {
  return (
    <div class={["projected-fact", { "projected-fact--wide": props.wide === true }]}>
      <dt>{props.label}</dt>
      <dd>
        <span class="projected-fact__value">
          {props.value ?? <span class="projected-skel" aria-hidden="true" />}
        </span>
        <span class="projected-fact__sub">{props.sub}</span>
      </dd>
    </div>
  );
}

const ownRate = (tx: ProjectedTx) => (tx.vsize > 0 ? tx.fee / tx.vsize : 0);

const columns = [
  {
    header: "Transaction",
    // In a grid, so the column may be narrower than the whole ID and the ID is cut to fit it.
    cell: (tx: ProjectedTx) => (
      <span class="projected-txcell">
        <Hash value={tx.id} href={paths.tx(tx.id)} copyLabel="Copy transaction ID" fit />
      </span>
    ),
  },
  {
    header: "Fee rate, sat/vB",
    cell: (tx: ProjectedTx) => (
      <span class="projected-rate">
        <FeeRate rate={tx.rate} unit={false} />
        {/* A parent lifted by its child, or a child paying for its parent: mined at their chunk's rate. */}
        <Show when={formatFeeRate(ownRate(tx)) !== formatFeeRate(tx.rate)}>
          <span class="projected-rate__own num">own {formatFeeRate(ownRate(tx))}</span>
        </Show>
      </span>
    ),
  },
  {
    header: "Fee, sats",
    numeric: true,
    optional: true,
    cell: (tx: ProjectedTx) => formatSats(tx.fee),
  },
  {
    // Sizes keep their unit in the cell, as one column can span vB to kvB (docs/DESIGN.md).
    header: "Virtual size",
    numeric: true,
    drop: 2,
    cell: (tx: ProjectedTx) => formatSize(tx.vsize),
  },
];

/**
 * The block as a core sample in a dashed frame: provisional. Its fee layers stand in until the
 * map is drawn into the same box; the rest of the mempool keeps only its layers.
 */
function CoreSample(props: {
  index: number;
  block: ProjectedBlock | undefined;
  txs: ProjectedTx[] | undefined;
  highlight: string | undefined;
  found: number | undefined;
  lastChange: { in: number; out: number; at: number } | undefined;
}) {
  const isRest = props.index === PROJECTED_BLOCKS - 1;
  const fill = () => {
    const b = props.block;
    if (!b) return undefined;
    return Math.min(1, b.weight / MAX_WEIGHT);
  };
  const layers = createMemo(() => {
    const b = props.block;
    const f = fill();
    return b && f !== undefined ? strataLayers(b.bands, f, LAYER_MIN) : [];
  });
  const [grid, setGrid] = createSignal<GridState>();
  const lit = createMemo(() => litOf(pick()));
  let frame: HTMLDivElement | undefined;
  const empty = () => props.block?.txs === 0;
  const drawn = () => grid() === "drawn" && (props.txs?.length ?? 0) > 0;
  // The frame sets once when the chain moves: the moment a guess became, or lost to, a block.
  const [setAt, setSetAt] = createSignal<number>();
  createEffect(
    () => props.found,
    (at) => {
      setSetAt(at);
    },
    { defer: true },
  );
  const where = positionName(props.index, true);
  const label = () => {
    const n = props.txs?.length ?? 0;
    return `Map of ${where}'s ${groupDigits(n)} ${n === 1 ? "transaction" : "transactions"}, one rectangle each, the highest fee rate at the top left.${litLabel(pick())} It changes as the mempool does; the list below has every one.`;
  };
  return (
    <figure class={["projected-core panel", { "projected-core--grid": drawn() }]}>
      <div
        class={["projected-core__frame", { "projected-core__frame--empty": empty() }]}
        ref={frame}
      >
        <span class="projected-core__limit" aria-hidden="true">
          {isRest ? "One block's limit" : "Weight limit"}
        </span>
        <Show when={layers().length > 0}>
          <div class="projected-core__strata">
            <Strata layers={layers()} />
          </div>
          <div
            class={[
              "projected-core__level",
              { "projected-core__level--high": (fill() ?? 0) > 0.85 },
            ]}

            style={{ "--fill": String(Math.max(fill() ?? 0, strataTop(layers()))) }}
          >
            <span class="num">
              {isRest && (props.block?.weight ?? 0) > MAX_WEIGHT
                ? "Over a block: squeezed into one frame"
                : `~${percent(fill() ?? 0)} full`}
            </span>
          </div>
        </Show>
        {/* Kept once drawn, even when the block empties, so what leaves fades where it stood. */}
        <Show
          when={
            props.txs &&
            (props.txs.length > 0 || grid() === "drawn" || grid() === "lost") &&
            grid() !== "unsupported"
          }
        >
          <div class="projected-core__grid">
            <Loading>
              <TxGrid
                txs={props.txs ?? []}
                capacity={MAX_WEIGHT / 4}
                label={label()}
                txid={(tx) => Promise.resolve(String(tx.id))}
                lit={lit()}
                highlight={props.highlight}
                onState={setGrid}
              />
            </Loading>
          </div>
        </Show>
        <Show when={empty()}>
          <div class="projected-core__empty">
            <p class="projected-core__empty-title">Nothing waiting here</p>
            <p class="projected-core__empty-text">
              {props.index === 0
                ? "The mempool is empty: the next block would hold only the miner's own coinbase. Anything sent now would land here."
                : "Everything waiting fits in the blocks before this one."}
            </p>
          </div>
        </Show>
        <Show when={!props.block}>
          <p class="projected-core__wait">Waiting for the server’s projection…</p>
        </Show>
        <Show when={setAt()} keyed>
          <span
            class="projected-core__set"
            aria-hidden="true"
            onAnimationEnd={() => setSetAt(undefined)}
          />
        </Show>
      </div>
      <Show when={!isRest && grid() !== "unsupported"}>
        <Goggles txs={props.txs} frame={() => frame} />
      </Show>
      <figcaption class="projected-core__caption">
        <Show
          when={!isRest}
          fallback={
            <>
              No map here: this is the rest of the mempool, with no size limit, so drawing it would
              mean sending every waiting transaction to your browser. Its layers show how much waits
              at each fee rate, the cheapest at the bottom.
            </>
          }
        >
          <Show when={fill() !== undefined && !empty()}>
            It would fill ~{percent(fill() ?? 0)} of the weight limit.{" "}
          </Show>
          One rectangle a transaction, by size and the rate it would be mined at.{" "}
          {/* rel="external" keeps the router out: it would mark this in-page link as the current page. */}
          <a href="#projected-txs-title" rel="external">
            Every transaction is in the list below.
          </a>
        </Show>
        <Show when={props.block && props.block.txs > 0}>
          <span class="visually-hidden">
            {" "}
            Layers, cheapest first: {describeBands(props.block?.bands ?? []).join("; ")}.
          </span>
        </Show>
      </figcaption>
      <Show when={!isRest}>
        <p class="projected-core__change">
          <Show when={props.lastChange} fallback="Changes show here as they arrive.">
            {(c) => (
              <>
                Last change <TimeAgo time={c().at / 1000} />:{" "}
                <span class="num">{groupDigits(c().in)}</span> came in,{" "}
                <span class="num">{groupDigits(c().out)}</span> left.
              </>
            )}
          </Show>
        </p>
      </Show>
      <FeeKey />
    </figure>
  );
}
