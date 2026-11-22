import { useParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { Amount } from "../../components/Amount";
import { formatMatchRate, readAudit } from "../../components/audit/model";
import { DataTable } from "../../components/DataTable";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { Note } from "../../components/Note";
import { ErrorState } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import { createApi, createRequest, fetchApi } from "../../lib/api";
import type { Block } from "../../lib/esplora";
import {
  EARLY_NOTE,
  formatInterval,
  formatSize,
  groupDigits,
  MISSING,
  NNBSP,
  timedBefore,
  truncateMiddle,
} from "../../lib/format";
import { paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { type BlockSummary, fetchSummaries, knownSummary } from "../../lib/summary";
import { parseHeight, shownParam } from "../block/chain";
import { failed, ready, Skel } from "../block/parts";
import "./BlocksPage.css";

/** Blocks on a page: the API answers ten at a time, so a page is three of its answers, cut. */
const PAGE = 25;
const API_PAGE = 10;
/** Summary requests in flight at once on this page. */
const IN_FLIGHT = 2;

/** A time to mine from which its bar is amber, and the time that fills the bar, in seconds. */
const SLOW = 20 * 60;
const FULL = 30 * 60;

/**
 * A block's time to mine, with a bar under it as long as the time (full at 30 min, a tick at the
 * 10-minute average) that turns amber from 20 min. A time before the parent's, and a slow one,
 * explain themselves on hover and focus.
 */
function TimeToMine(props: { seconds: number; parent: number }) {
  const s = props.seconds;
  const text = formatInterval(s);
  return (
    <>
      {s < 0 ? (
        <Note focusable title={timedBefore(s, props.parent)} figure={text}>
          {EARLY_NOTE}
        </Note>
      ) : s >= SLOW ? (
        <Note focusable title="Slow: 20 min or more" figure={text}>
          Blocks come every 10 min on average.
        </Note>
      ) : (
        text
      )}
      <span
        class={["blocks-pace", { "blocks-pace--slow": s >= SLOW }]}
        style={{ "--pace": String(Math.min(1, Math.max(0, s / FULL))) }}
        aria-hidden="true"
      />
    </>
  );
}

/** A row's fee facts: here, still loading, or given up on. */
type RowFacts = BlockSummary | "failed" | undefined;

/** `parentOf(b, i)`: the block mined before row `i`, when the page has it. */
const columns = (
  factsOf: (id: string) => RowFacts,
  parentOf: (b: Block, i: number) => Block | undefined,
) => [
  {
    header: "Height",
    cell: (b: Block | null) =>
      b ? (
        <span class="blocks-heightcell">
          <Link class="blocks-height num" href={paths.block(b.id)}>
            {groupDigits(b.height)}
          </Link>
          {/* Phones drop the Mined column, so the age moves under the height; each is hidden
              with display, so a screen reader hears whichever is shown. */}
          <span class="blocks-heightcell__age">
            <TimeAgo time={b.timestamp} suffix={false} />
          </span>
        </span>
      ) : (
        <Skel size="s" />
      ),
  },
  {
    header: "Mined",
    optional: true,
    // When a block was found reads before what it paid: the fee total goes first (step 6).
    drop: 7,
    cell: (b: Block | null) => (b ? <TimeAgo time={b.timestamp} /> : <Skel size="s" />),
  },
  // Header times, so a miner's clock can put a block before its parent: shown with its sign.
  {
    header: "Time to mine",
    numeric: true,
    optional: true,
    drop: 3,
    cell: (b: Block | null, i: number) => {
      if (!b) return <Skel size="s" />;
      const p = parentOf(b, i);
      return p ? <TimeToMine seconds={b.timestamp - p.timestamp} parent={p.height} /> : MISSING;
    },
  },
  {
    header: "Miner",
    cell: (b: Block | null) => {
      const f = b ? factsOf(b.id) : undefined;
      if (f === undefined) return <Skel size="s" />;
      const m = f === "failed" ? undefined : f.miner;
      return m ? (
        <span class="blocks-minercell">
          <Link class="blocks-miner tap-line" href={paths.pool(m.slug)} title={m.name}>
            {m.name}
          </Link>
          {/* Not a control: it opens nothing of its own, and the block's page explains it. */}
          {f !== "failed" && f.sv2 === true && (
            <span class="block-sv2">
              <span aria-hidden="true">Sv2</span>
              <span class="visually-hidden">Stratum V2</span>
            </span>
          )}
        </span>
      ) : (
        MISSING
      );
    },
  },
  {
    header: "Transactions",
    short: "Txs",
    numeric: true,
    // The last to go, and only where even the phone's columns are too wide (320 px, wide faces).
    drop: 8,
    cell: (b: Block | null) => (b ? groupDigits(b.tx_count) : <Skel size="s" />),
  },
  {
    header: "Median fee rate, sat/vB",
    short: "Median, sat/vB",
    numeric: true,
    cell: (b: Block | null) => {
      const f = b ? factsOf(b.id) : undefined;
      if (f === undefined) return <Skel size="s" />;
      if (f === "failed") return MISSING;
      return f.fee_rate ? <FeeRate rate={f.fee_rate.median} unit={false} /> : "None";
    },
  },
  // A dash for a block without an audit: most old blocks, and never an error.
  {
    header: "Match rate, %",
    numeric: true,
    optional: true,
    drop: 5,
    cell: (b: Block | null) => {
      const f = b ? factsOf(b.id) : undefined;
      if (f === undefined) return <Skel size="s" />;
      const a = f === "failed" ? null : readAudit(f.audit);
      return a ? (
        <>
          {formatMatchRate(a.match_rate)}
          <span class="visually-hidden">%</span>
        </>
      ) : (
        <>
          {MISSING}
          <span class="visually-hidden">no audit</span>
        </>
      );
    },
  },
  {
    header: "Total fees, BTC",
    numeric: true,
    optional: true,
    drop: 6,
    cell: (b: Block | null) => {
      const f = b ? factsOf(b.id) : undefined;
      if (f === undefined) return <Skel size="s" />;
      return f === "failed" ? MISSING : <Amount sats={f.fees} unit={false} />;
    },
  },
  // Sizes carry their unit in the cell, as on the block page: they span B to MB (docs/DESIGN.md).
  {
    header: "Size",
    numeric: true,
    optional: true,
    drop: 4,
    cell: (b: Block | null) => (b ? formatSize(b.size, "B") : <Skel size="s" />),
  },
  {
    header: "Weight",
    numeric: true,
    optional: true,
    drop: 2,
    cell: (b: Block | null) => (b ? formatSize(b.weight, "WU") : <Skel size="s" />),
  },
  {
    header: "Hash",
    optional: true,
    drop: 1,
    cell: (b: Block | null) =>
      b ? (
        <Hash value={b.id} href={paths.block(b.id)} copyLabel="Copy block hash" />
      ) : (
        <span class="blocks-hash-skel">
          <Skel />
        </span>
      ),
  },
];

/** `/blocks` and `/blocks/:from`: recent blocks, newest first, 25 to a page. */
export default function BlocksPage() {
  const params = useParams<{ from?: string }>();
  const from = createMemo(() => (params.from === undefined ? undefined : parseHeight(params.from)));
  const network0 = useNetwork();
  const [blocks, blocksCtl] = createRequest(
    () => {
      const f = from();
      return f !== null && { from: f, network: network0() };
    },
    async ({ from: f, network: n }, signal) => {
      // Ten at a time, each answer continuing below the last, until a page's worth or the genesis.
      const out: Block[] = [];
      let path = f === undefined ? "/blocks" : `/blocks/${f}`;
      while (out.length < PAGE) {
        // oxlint-disable-next-line no-await-in-loop -- each answer says where the next starts
        const part = await fetchApi<Block[]>(n, path, { signal, cached: true });
        out.push(...part);
        const last = part.at(-1);
        if (part.length < API_PAGE || last === undefined || last.height === 0) break;
        path = `/blocks/${last.height - 1}`;
      }
      // One past the page, so its oldest row has its parent for the time to mine.
      return out.slice(0, PAGE + 1);
    },
  );
  const [tip] = createApi<string>(() => "/blocks/tip/height", { as: "text", cached: true });
  usePageTitle(() => "Blocks");
  const network = useNetwork();

  // Each row's fee facts on its own request, two at a time, so an old page, whose blocks the server
  // must compute one by one, fills in row by row without spending the client's whole allowance at
  // once; busy replies (503, 429) are retried as they say.
  const [facts, setFacts] = createSignal<ReadonlyMap<string, BlockSummary | "failed">>(new Map());
  const put = (id: string, f: BlockSummary | "failed") => setFacts((m) => new Map([...m, [id, f]]));
  const factsOf = (id: string): RowFacts => facts().get(id) ?? knownSummary(network(), id);
  const fetched = () => {
    const l = ready(blocks);
    return Array.isArray(l) ? l : undefined;
  };
  const list = createMemo(() => fetched()?.slice(0, PAGE));
  const parentOf = (b: Block, i: number) => {
    const p = fetched()?.[i + 1];
    return p?.id === b.previousblockhash ? p : undefined;
  };
  const table = columns(factsOf, parentOf);

  createEffect(list, (rows) => {
    const c = new AbortController();
    const n = network();
    const queue = (rows ?? [])
      .map((b) => b.id)
      .filter((id) => !knownSummary(n, id) && !(facts().get(id) instanceof Object));
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined && !c.signal.aborted; id = queue.shift()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one request at a time per worker
          const found = await fetchSummaries(n, [id], c.signal);
          put(id, found.get(id) ?? "failed");
        } catch {
          if (!c.signal.aborted) put(id, "failed");
        }
      }
    };
    for (let i = 0; i < IN_FLIGHT; i++) void worker();
    return () => c.abort();
  });
  const tipHeight = () => {
    const t = Number(ready(tip));
    return Number.isSafeInteger(t) ? t : undefined;
  };
  const newest = () => list()?.[0]?.height;
  const oldest = () => list()?.at(-1)?.height;
  const atTip = () => {
    const n = newest();
    const t = tipHeight();
    return from() === undefined || n === undefined || (t !== undefined && n >= t);
  };
  const newerHref = () => {
    const n = newest();
    const t = tipHeight();
    if (n === undefined || t === undefined || n + PAGE >= t) return paths.blocks();
    return paths.blocks(n + PAGE);
  };

  return (
    <div class="wrap blocks-page">
      <header class="blocks-head">
        <h1>Blocks</h1>
        <p class="blocks-head__range num" aria-live="polite">
          <Show when={list()?.length} fallback={<Skel size="l" />}>
            Newest first: {groupDigits(newest() ?? 0)} to {groupDigits(oldest() ?? 0)}
          </Show>
        </p>
      </header>
      <Show
        when={from() !== null}
        fallback={
          <p class="blocks-message">
            “{truncateMiddle(shownParam(params.from ?? ""), 40, 20)}” is not a block height. Show
            the <Link href={paths.blocks()}>newest blocks</Link>.
          </p>
        }
      >
        <Show
          when={failed(blocks) === undefined}
          fallback={
            <ErrorState
              title="Could not load the blocks"
              error={failed(blocks)}
              retry={() => blocksCtl.refetch()}
            />
          }
        >
          <div class="panel">
            <DataTable
              caption="Recent blocks, newest first"
              columns={table}
              rows={list() ?? Array.from({ length: PAGE }, () => null)}
              rowHref={(b) => (b ? paths.block(b.id) : undefined)}
            />
          </div>
          <nav class="blocks-pager" aria-label="Block pages">
            <Show
              when={!atTip()}
              fallback={
                <span class="btn blocks-pager__off" aria-disabled="true">
                  ← Newer
                </span>
              }
            >
              <Link class="btn" href={newerHref()} rel="prev">
                ← Newer
              </Link>
            </Show>
            <Show when={!atTip()}>
              <Link class="blocks-pager__latest" href={paths.blocks()}>
                Newest blocks
              </Link>
            </Show>
            <Show
              when={(oldest() ?? 0) > 0}
              fallback={
                <span class="btn blocks-pager__off" aria-disabled="true">
                  Older →
                </span>
              }
            >
              <Link class="btn" href={paths.blocks((oldest() ?? 1) - 1)} rel="next">
                Older{NNBSP}→
              </Link>
            </Show>
          </nav>
        </Show>
      </Show>
    </div>
  );
}
