import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Amount } from "../../components/Amount";
import { type Column, DataTable } from "../../components/DataTable";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState } from "../../components/States";
import type { RecentTx } from "../../lib/esplora";
import { feeRate, formatSize } from "../../lib/format";
import { paths } from "../../lib/network";
import type { Feed } from "./feeds";
import { enqueueTxs } from "./mempool";

/**
 * Rows shown, and while the first answer is on its way, so the section keeps its height: as many
 * as the replacements beside it show, so the two panels end together.
 */
const ROWS = 6;
/** New rows enter one at a time, at most this often, so each can be read on a busy day. */
export const PACE_MS = 700;

const COLUMNS: Column<RecentTx | null>[] = [
  {
    header: "Transaction",
    cell: (t) =>
      t ? (
        <Hash value={t.txid} href={paths.tx(t.txid)} copy={false} fit />
      ) : (
        <span class="home-bone" />
      ),
  },
  {
    header: "Fee rate, sat/vB",
    short: "sat/vB",
    cell: (t) =>
      t ? (
        <FeeRate rate={feeRate(t.fee, t.vsize) ?? Number.NaN} unit={false} />
      ) : (
        <span class="home-bone home-bone--short" />
      ),
  },
  {
    // The topic and /mempool/recent give no serialized size: this is the virtual size, in vB units.
    header: "Virtual size",
    numeric: true,
    optional: true,
    cell: (t) => (t ? formatSize(t.vsize) : ""),
  },
  {
    header: "Value, BTC",
    numeric: true,
    cell: (t) => (t ? <Amount sats={t.value} unit={false} /> : ""),
  },
];

/**
 * The newest transactions to enter the mempool. Rows already on screen keep their element, so only
 * the ones that are new flash.
 */
export function RecentTxs(props: { feed: Feed<RecentTx[]> }) {
  const [list, setList] = createSignal<RecentTx[]>();
  let queue: RecentTx[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    const [next, ...rest] = queue;
    queue = rest;
    timer = next ? setTimeout(step, PACE_MS) : undefined;
    if (next)
      setList((l) => [next, ...(l ?? []).filter((t) => t.txid !== next.txid)].slice(0, ROWS));
  };
  createEffect(
    () => props.feed.data(),
    (incoming) => {
      if (!incoming) return;
      const shown = list();
      // The first list, or one nobody is watching arrive, is shown as it is.
      if (!shown || document.hidden) {
        clearTimeout(timer);
        timer = undefined;
        queue = [];
        setList(incoming.slice(0, ROWS));
        return;
      }
      queue = enqueueTxs(shown, queue, incoming, ROWS);
      if (timer === undefined) step();
    },
  );
  onCleanup(() => clearTimeout(timer));
  let known = new Map<string, RecentTx>();
  const fresh = new WeakSet<RecentTx>();
  let first = true;
  const rows = createMemo(() => {
    const l = list();
    if (!l) return undefined;
    const next = new Map<string, RecentTx>();
    const out = l.map((t) => {
      const kept = known.get(t.txid);
      if (kept) return kept;
      if (!first) fresh.add(t);
      return t;
    });
    for (const t of out) next.set(t.txid, t);
    known = next;
    first = false;
    return out;
  });

  return (
    <section class="home-recent" aria-labelledby="recent-title">
      <SectionHeader title="Latest transactions" id="recent-title" />
      <Show
        when={rows() ?? props.feed.error() === undefined}
        fallback={
          <ErrorState
            title="Could not load the latest transactions"
            error={props.feed.error()}
            retry={props.feed.refresh}
          />
        }
      >
        <DataTable<RecentTx | null>
          caption="The newest transactions waiting in the mempool"
          columns={COLUMNS}
          rows={rows() ?? Array.from({ length: ROWS }, () => null)}
          rowHref={(t) => (t ? paths.tx(t.txid) : undefined)}
          rowClass={(t) => (t && fresh.has(t) ? "home-recent__new" : undefined)}
          empty={
            <Empty title="No transactions are waiting">
              New transactions appear here as the node accepts them.
            </Empty>
          }
        />
      </Show>
    </section>
  );
}
