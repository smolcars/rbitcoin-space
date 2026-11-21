import { useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import "../../components/Button.css";
import { type Column, DataTable } from "../../components/DataTable";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { Pagination } from "../../components/Pagination";
import "../../components/SectionHeader.css";
import { Empty, ErrorState } from "../../components/States";
import { TimeAgo, TimeUtc } from "../../components/Time";
import { type ApiResource, createApi, fetchApi } from "../../lib/api";
import type { AddressStats, Transaction, Utxo } from "../../lib/esplora";
import { groupDigits, MISSING } from "../../lib/format";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { steady } from "../../lib/steady";
import {
  confirmations,
  isCoinbase,
  keptAfterRefresh,
  mergePages,
  netChange,
  pageIsFull,
  refusal,
  sortUtxos,
  txFeeRate,
} from "./address";
import { handoverState } from "../../lib/lookalike";
import type { Lookalike } from "./lookalike";
import { LookalikeWarning } from "./LookalikeWarning";
import { pinnedPath } from "./asof";
import { Skeleton, settled, UnconfirmedMark } from "./parts";

/** Confirmed transactions per page of address history; the first page adds the unconfirmed ones. */
export const PAGE = 25;
/** Unspent outputs drawn at once, a page at a time. The list arrives whole; this bounds the DOM. */
export const UTXO_STEP = 100;

const VIEWS = [
  { id: "transactions", label: "Transactions" },
  { id: "unspent", label: "Unspent outputs" },
] as const;
type View = (typeof VIEWS)[number]["id"];

/** Rows drawn while a list loads: as many as will arrive, when the count is known. */
const placeholders = (count: number | undefined): null[] =>
  Array.from({ length: Math.max(1, Math.min(count ?? 6, PAGE)) }, () => null);

const plural = (n: number, one: string, many: string) =>
  `${groupDigits(n)} ${n === 1 ? one : many}`;

/**
 * The address's transactions and unspent outputs, as two views of one section. The view is in
 * the URL (`?view=unspent`), so a link or a reload opens the same one. Loaded pages survive a
 * switch between views.
 */
/**
 * The pages after the first, whether the last of them was full, whether one has answered since
 * the first page last changed (an empty answer adds no rows, and still says there are no more),
 * and which rows are new.
 */
interface Later {
  txs: Transaction[];
  full: boolean;
  answered: boolean;
  fresh: ReadonlySet<string>;
}
const NOTHING_LATER: Later = { txs: [], full: true, answered: false, fresh: new Set() };

export function History(props: {
  address: string;
  /** Asks nothing for the unspent outputs yet: the page has not learned whether it keeps them. */
  held?: boolean;
  stats: ApiResource<AddressStats>;
  first: ApiResource<Transaction[]>;
  retryFirst: () => void;
  /** Hands the page a function that refreshes what this section loaded on its own. */
  onRefresh: (refresh: () => void) => void;
  /**
   * An address whose whole history the server keeps (docs/API.md, "Paging a kept history"):
   * `first` is its newest confirmed page from `/txs/chain`, later pages follow it there, and there
   * is no unspent outputs view, which the server does not keep. Its unconfirmed transactions are
   * listed apart.
   */
  kept?: boolean;
  /** Lookalike addresses by txid, worked out by the page from what this section reports loaded. */
  lookalike: ReadonlyMap<string, readonly Lookalike[]>;
  /**
   * The block the page shows the address as of: `first` is its newest confirmed page from
   * `/txs/chain?asof=`, later pages and the unspent outputs are pinned to the same hash, and an
   * output's confirmations are counted at that block.
   */
  asof?: { hash: string; height: number };
  /** Told when a pinned read finds its block no longer on the best chain (a 404). */
  onGone?: () => void;
  /**
   * Hands the page every transaction loaded, first page and later ones, and whether more could be
   * loaded, whenever either changes; and nothing once this section is gone.
   */
  onShown: (txs: Transaction[] | undefined, more: boolean) => void;
}) {
  const network = useNetwork();
  const path = `/address/${encodeURIComponent(props.address)}`;
  const [search, setSearch] = useSearchParams<{ view: string }>();
  const view = (): View =>
    search.view === "unspent" && props.kept !== true ? "unspent" : "transactions";
  const tabs: HTMLButtonElement[] = [];

  const select = (id: View, focus = false) => {
    setSearch({ view: id === "transactions" ? undefined : id }, { replace: true, scroll: false });
    if (focus) tabs[VIEWS.findIndex((v) => v.id === id)]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const i = VIEWS.findIndex((v) => v.id === view());
    const last = VIEWS.length - 1;
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % VIEWS.length
        : e.key === "ArrowLeft"
          ? (i + last) % VIEWS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    const next = VIEWS[to];
    if (!next) return;
    e.preventDefault();
    select(next.id, true);
  };

  // Transactions: the first page comes from the page (it refreshes when the history changes), later pages from here.
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [moreError, setMoreError] = createSignal<unknown>();
  const controller = new AbortController();
  onCleanup(() => controller.abort());

  const first = () => settled(props.first);
  const pin = (p: string) => (props.asof === undefined ? p : pinnedPath(p, props.asof.hash));
  const total = () => {
    const s = settled(props.stats);
    if (!s) return undefined;
    return props.kept === true || props.asof !== undefined
      ? s.chain_stats.tx_count
      : s.chain_stats.tx_count + s.mempool_stats.tx_count;
  };

  // When a refresh brings a new first page, what was loaded after it stays only where it still
  // continues the fresh page, so nothing is skipped and nothing stale stays. New rows flash once.
  let previous: Transaction[] | undefined;
  // Counts first pages; a page request made before the latest one is dropped when it lands.
  let generation = 0;
  let known = new Set<string>();
  // What a first page says, to tell a refresh that changed nothing from one that did. In any
  // order: the node lists unconfirmed transactions in no fixed order (seen on regtest).
  const pageKey = (page: Transaction[]) => {
    const keys = page.map((t) => `${t.txid}:${t.status.block_hash ?? ""}`);
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts the array just made; toSorted is past this lib target
    return keys.sort().join(",");
  };
  // The pages after the first, whether the last of them was full, and the rows that came in with
  // the latest first page: loading more appends to them, and a new first page works them out
  // again before any of them is shown.
  const [after, setAfter] = createSignal<Later>((prev = NOTHING_LATER) => {
    const f = first();
    if (!f) return prev;
    // Nothing changed: pages already loaded, and one on its way, still continue it.
    if (previous && pageKey(f) === pageKey(previous)) return prev;
    generation++;
    const ids = new Set(f.map((t) => t.txid));
    const old = previous;
    const next: Later = {
      txs: old ? keptAfterRefresh(f, mergePages(old, prev.txs), PAGE) : prev.txs,
      full: old && prev.txs.length === 0 ? pageIsFull(old, PAGE) : prev.full,
      // A changed first page may have more after it again.
      answered: false,
      fresh: new Set(old ? [...ids].filter((id) => !known.has(id)) : []),
    };
    known = new Set([...known, ...ids]);
    previous = f;
    return next;
  });
  const later = () => after().txs;
  const fresh = () => after().fresh;
  // The object already held for a transaction whose answer has not changed, so the table, which
  // keeps a row's elements while it is given the same object, rebuilds no row but those that
  // changed: the reader keeps their focus, the row under their finger and a note they were sent
  // to. Compared whole, so a field a later answer changed (a block, a pruned input) is never
  // hidden behind the old object.
  const steadyTxs = steady<Transaction>((t) => t.txid);
  const shown = createMemo(() => {
    const f = first();
    return f ? steadyTxs(mergePages(f, later())) : undefined;
  });
  // The page works out the lookalikes over every loaded page at once (its notice and these rows read
  // the one answer), so a later page's lookalike also marks the earlier rows it imitates.
  const hasNext = () =>
    later().length === 0 && !after().answered ? pageIsFull(first() ?? [], PAGE) : after().full;
  createEffect(
    () => [shown(), hasNext()] as const,
    ([list, more]) => {
      props.onShown(list, more);
    },
  );
  // A notice must not outlive the rows it points at (a kept history the server dropped, say).
  onCleanup(() => props.onShown(undefined, false));

  const loadMore = async () => {
    if (!shown()?.at(-1) || loadingMore()) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      // Asks again when a refresh lands first: the reader still wants the next page.
      for (let last = shown()?.at(-1); last; last = hasNext() ? shown()?.at(-1) : undefined) {
        const asked = generation;
        // oxlint-disable-next-line no-await-in-loop -- one page at a time, after the last row shown
        const page = await fetchApi<Transaction[]>(
          network(),
          props.kept === true || props.asof !== undefined
            ? pin(`${path}/txs/chain/${encodeURIComponent(last.txid)}`)
            : `${path}/txs?after_txid=${encodeURIComponent(last.txid)}`,
          // Past the browser's cache: an empty answer says the history has no more, so one kept
          // from before a reorg must not say it for the chain that followed.
          { signal: controller.signal, fresh: true },
        );
        // A refresh while this was in flight may have changed the history it continues (new
        // transactions, a reorg), so the reply could leave a gap or bring back stale rows: it is
        // dropped, and the next page is asked for after the rows the refresh left.
        if (generation === asked) {
          setAfter((a) => ({
            ...a,
            txs: [...a.txs, ...page],
            full: pageIsFull(page, PAGE),
            answered: true,
          }));
          break;
        }
      }
      setLoadingMore(false);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (props.asof !== undefined && refusal(e) === "gone") props.onGone?.();
      setMoreError(e);
      setLoadingMore(false);
    }
  };

  // Unspent outputs: asked for only once the view is opened, and never when the node has already
  // refused this address's totals, because it refuses its unspent outputs for the same reason.
  const statsFailure = () =>
    props.stats.state === "errored" ? refusal(props.stats.error) : undefined;
  // Once opened, stays open: the memo stops reading the view after it first turns true.
  const opened = createMemo((was?: boolean) => was === true || view() === "unspent");
  const statsKnown = () => props.stats.state !== "unresolved" && props.stats.state !== "pending";
  const wantUtxos = () =>
    props.held !== true &&
    opened() &&
    statsKnown() &&
    statsFailure() !== "too-large" &&
    statsFailure() !== "not-kept";
  const [utxos, { refetch: refetchUtxos }] = createApi<Utxo[]>(
    () => wantUtxos() && pin(`${path}/utxo`),
    {
      fresh: true,
    },
  );
  // As of a block, confirmations are counted at it: the tip is not asked.
  const [tip, { refetch: refetchTip }] = createApi<string>(
    () => wantUtxos() && props.asof === undefined && "/blocks/tip/height",
    { as: "text", fresh: true },
  );
  createEffect(
    () => utxos.state === "errored" && refusal(utxos.error) === "gone",
    (gone) => {
      if (gone && props.asof !== undefined) props.onGone?.();
    },
  );
  // A request still in flight is asked again, so its answer is as new as the change.
  const asked = (state: string) =>
    state === "ready" || state === "refreshing" || state === "pending";
  props.onRefresh(() => {
    if (asked(utxos.state)) refetchUtxos();
    if (asked(tip.state)) refetchTip();
  });

  const meta = () => {
    if (view() === "transactions") {
      const list = shown();
      if (!list || list.length === 0) return "";
      const n = total();
      return n === undefined
        ? `${groupDigits(list.length)} shown`
        : `${groupDigits(list.length)} of ${groupDigits(n)}`;
    }
    const u = settled(utxos);
    return u ? plural(u.length, "output", "outputs") : "";
  };

  return (
    <section class="address-history" aria-label="History">
      <div class="section__head address-history__head">
        <Show
          when={props.kept !== true}
          fallback={<h2 id="address-history-title">Transactions</h2>}
        >
          {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- the tabs inside take focus (roving tabindex); the list only handles their arrow keys */}
          <div class="address-tabs" role="tablist" aria-label="Show" onKeyDown={onKeyDown}>
            <For each={VIEWS}>
              {(v, i) => (
                <button
                  ref={(el) => {
                    tabs[i()] = el;
                  }}
                  type="button"
                  role="tab"
                  class="address-tab tap"
                  id={`address-tab-${v.id}`}
                  aria-controls="address-panel"
                  aria-selected={view() === v.id ? "true" : "false"}
                  tabindex={view() === v.id ? 0 : -1}
                  onClick={() => select(v.id)}
                >
                  {v.label}
                </button>
              )}
            </For>
          </div>
        </Show>
        <span class="section__meta num">{meta()}</span>
      </div>
      <div
        class="address-panel"
        role={props.kept === true ? undefined : "tabpanel"}
        id="address-panel"
        aria-labelledby={props.kept === true ? "address-history-title" : `address-tab-${view()}`}
      >
        <Show
          when={view() === "unspent"}
          fallback={
            <Transactions
              address={props.address}
              tooLarge={
                statsFailure() === "too-large" ||
                (props.first.state === "errored" && refusal(props.first.error) === "too-large")
              }
              notKept={props.first.state === "errored" && refusal(props.first.error) === "not-kept"}
              at={props.asof?.height}
              first={props.first}
              retryFirst={props.retryFirst}
              shown={shown()}
              total={total()}
              rowClass={(tx) => (tx && fresh().has(tx.txid) ? "address-row--new" : undefined)}
              lookalike={props.lookalike}
              more={
                <Show when={shown()}>
                  <div class="address-more">
                    <Show when={moreError()}>
                      {(e) => <ErrorState title="Could not load more transactions" error={e()} />}
                    </Show>
                    <Show when={hasNext() || moreError()}>
                      <button
                        class="btn"
                        type="button"
                        onClick={() => void loadMore()}
                        aria-disabled={loadingMore() ? "true" : "false"}
                      >
                        {loadingMore()
                          ? "Loading…"
                          : moreError() === undefined
                            ? `Show ${PAGE} more`
                            : "Try again"}
                      </button>
                    </Show>
                    {/* Phones have no room for the count in the section head. */}
                    <span class="address-more__count num">{meta()}</span>
                  </div>
                </Show>
              }
            />
          }
        >
          <Switch>
            <Match when={statsFailure() === "not-kept"}>
              <Empty title="Unspent outputs are not available for this address">
                The server keeps only running totals for an address with this much history, not its
                coins.
              </Empty>
            </Match>
            <Match when={statsFailure() === "too-large"}>
              <Empty title="Unspent outputs are not available for this address">
                The node refuses to list them for the same reason it refuses the totals: the address
                has too much history.
              </Empty>
            </Match>
            <Match when={true}>
              <Unspent
                utxos={utxos}
                tip={tip}
                at={props.asof?.height}
                retry={() => {
                  if (utxos.state === "errored") refetchUtxos();
                  if (tip.state === "errored") refetchTip();
                }}
              />
            </Match>
          </Switch>
        </Show>
      </div>
    </section>
  );
}

/**
 * When a transaction confirmed, or that it has not. As of a block (`utc`), the date and time: an
 * age counted from today would read oddly under a block itself days old.
 */
function When(props: { tx: Transaction; utc: boolean }) {
  return (
    <Show when={props.tx.status.confirmed} fallback={<UnconfirmedMark />}>
      <Show when={props.tx.status.block_time} fallback={MISSING}>
        {(t) => (props.utc ? <TimeUtc time={t()} seconds={false} /> : <TimeAgo time={t()} />)}
      </Show>
    </Show>
  );
}

function Transactions(props: {
  address: string;
  tooLarge: boolean;
  /** As of a block the server keeps no history for, for an address this large. */
  notKept: boolean;
  /** The height the page is as of. */
  at: number | undefined;
  first: ApiResource<Transaction[]>;
  retryFirst: () => void;
  shown: Transaction[] | undefined;
  total: number | undefined;
  rowClass: (tx: Transaction | null) => string | undefined;
  /** Lookalike addresses by txid (lookalike.ts); a row in it carries a warning. */
  lookalike: ReadonlyMap<string, readonly Lookalike[]>;
  more: JSX.Element;
}) {
  const network = useNetwork();
  // A row that names a lookalike hands its findings to the transaction page in history state.
  const handover = (tx: Transaction | null) => {
    const found = tx && props.lookalike.get(tx.txid);
    return found ? handoverState(props.address, found, tx.txid, network()) : undefined;
  };
  const columns: Column<Transaction | null>[] = [
    {
      header: "Time",
      optional: true,
      cell: (tx) => (tx ? <When tx={tx} utc={props.at !== undefined} /> : <Skeleton width="8ch" />),
    },
    {
      header: "Transaction",
      cell: (tx) =>
        tx ? (
          <span class="address-txcell">
            <Hash
              value={tx.txid}
              href={paths.tx(tx.txid)}
              linkState={handover(tx)}
              copyLabel="Copy transaction ID"
              fit
            />
            {/* Phones drop the time column, so the time moves under the txid. */}
            <span class="address-txcell__when">
              <When tx={tx} utc={props.at !== undefined} />
            </span>
          </span>
        ) : (
          <Skeleton width="19ch" />
        ),
    },
    {
      header: "This address, BTC",
      numeric: true,
      cell: (tx) => {
        if (!tx) return <Skeleton width="11ch" />;
        const sats = netChange(tx, props.address);
        return sats === null ? (
          <span title="The node no longer keeps this transaction's inputs">{MISSING}</span>
        ) : (
          <Amount sats={sats} signed unit={false} />
        );
      },
    },
    {
      header: "Fee rate, sat/vB",
      numeric: true,
      optional: true,
      cell: (tx) => {
        if (!tx) return <Skeleton width="6ch" />;
        if (isCoinbase(tx)) return <span class="muted">Coinbase</span>;
        const rate = txFeeRate(tx);
        return rate === null ? MISSING : <FeeRate rate={rate} unit={false} />;
      },
    },
  ];

  return (
    <Switch>
      <Match when={props.tooLarge}>
        {/* A refusal that is no failure: said as the other empty states inside a panel are. */}
        <Empty title="Transactions are not available for this address">
          The server does not list them for the same reason the node refuses the totals: the address
          has too much history.
        </Empty>
      </Match>
      <Match when={props.notKept}>
        <Empty title="Transactions at this block are not kept for this address">
          For an address with this much history, the server keeps transactions as of a past block
          only for its last 100 blocks.
        </Empty>
      </Match>
      <Match when={props.first.state === "errored"}>
        <ErrorState
          title="Could not load this address's transactions"
          error={props.first.error}
          retry={props.retryFirst}
        />
      </Match>
      <Match when={props.shown?.length === 0 && props.at !== undefined}>
        <Empty title={`No transactions by block ${groupDigits(props.at ?? 0)}`}>
          No transaction paying or spending this address had confirmed by block{" "}
          {groupDigits(props.at ?? 0)}.
        </Empty>
      </Match>
      <Match when={props.shown?.length === 0}>
        <Empty title="This address has never been used">
          No transaction on {NETWORK_NAMES[network()]} has paid to it or spent from it. A payment to
          it will show here once it reaches the mempool.
        </Empty>
      </Match>
      <Match when={true}>
        <div
          class={["address-txs", { "address-txs--asof": props.at !== undefined }]}
          aria-busy={props.shown === undefined ? "true" : "false"}
        >
          <DataTable
            caption={
              props.at === undefined
                ? "Transactions of this address, newest first"
                : `Transactions of this address up to block ${groupDigits(props.at)}, newest first`
            }
            columns={columns}
            rows={props.shown ?? placeholders(props.total)}
            rowHref={(t) => (t ? paths.tx(t.txid) : undefined)}
            rowState={handover}
            rowClass={props.rowClass}
            rowNote={{
              when: (t) => t !== null && props.lookalike.has(t.txid),
              render: (t) => (
                <LookalikeWarning
                  txid={t?.txid ?? ""}
                  found={(t && props.lookalike.get(t.txid)) ?? []}
                />
              ),
            }}
          />
          <Show when={props.shown === undefined}>
            <span class="visually-hidden" role="status">
              Loading transactions
            </span>
          </Show>
        </div>
        {props.more}
      </Match>
    </Switch>
  );
}

/** An output's confirmations, or that it has none yet. `words` adds the noun, for phones. */
function Confirmations(props: { utxo: Utxo; tip: number | undefined; words?: boolean }) {
  return (
    <Show when={props.utxo.status.confirmed} fallback={<UnconfirmedMark />}>
      <Show when={props.tip} fallback={<Skeleton width="4ch" />}>
        {(tip) => {
          const n = () => confirmations(props.utxo, tip());
          return (
            <span class="num">
              {props.words ? plural(n(), "confirmation", "confirmations") : groupDigits(n())}
            </span>
          );
        }}
      </Show>
    </Show>
  );
}

function Unspent(props: {
  utxos: ApiResource<Utxo[]>;
  tip: ApiResource<string>;
  retry: () => void;
  /** The height the page is as of: confirmations are counted at it. */
  at?: number | undefined;
}) {
  const [page, setPage] = createSignal(1);
  // As for the transactions: an output the answer still lists, unchanged, keeps its row.
  const steadyUtxos = steady<Utxo>((u) => `${u.txid}:${u.vout}`);
  const sorted = createMemo(() => {
    const u = settled(props.utxos);
    return u ? sortUtxos(steadyUtxos(u)) : undefined;
  });
  const tipHeight = () => {
    if (props.at !== undefined) return props.at;
    const t = Number(settled(props.tip));
    return Number.isSafeInteger(t) ? t : undefined;
  };
  const columns: Column<Utxo | null>[] = [
    {
      header: "Output",
      cell: (u) =>
        u ? (
          <span class="address-txcell">
            <span class="address-outpoint">
              <Hash value={u.txid} href={paths.tx(u.txid)} copy={false} />
              <span class="address-outpoint__vout num">:{u.vout}</span>
            </span>
            {/* Phones drop the confirmations column, so the count moves under the output. */}
            <span class="address-txcell__when">
              <Confirmations utxo={u} tip={tipHeight()} words />
            </span>
          </span>
        ) : (
          <Skeleton width="22ch" />
        ),
    },
    {
      header: "Amount, BTC",
      numeric: true,
      cell: (u) => (u ? <Amount sats={u.value} unit={false} /> : <Skeleton width="10ch" />),
    },
    {
      // As of a block, counted at that block. Fixed for the section's life: the page is made
      // afresh for each block.
      header: untrack(() => props.at) === undefined ? "Confirmations" : "Confirmations then",
      numeric: true,
      optional: true,
      cell: (u) => (u ? <Confirmations utxo={u} tip={tipHeight()} /> : <Skeleton width="4ch" />),
    },
  ];
  const pageCount = () => Math.max(1, Math.ceil((sorted()?.length ?? 0) / UTXO_STEP));
  // A refresh can shorten the list under the page on screen.
  const current = () => Math.min(page(), pageCount());
  const failed = (): unknown =>
    props.utxos.state === "errored"
      ? props.utxos.error
      : props.at === undefined && props.tip.state === "errored"
        ? props.tip.error
        : undefined;

  return (
    <Switch>
      <Match when={failed()}>
        <ErrorState
          title="Could not load the unspent outputs"
          error={failed()}
          retry={props.retry}
        />
      </Match>
      <Match when={sorted()?.length === 0}>
        <Show
          when={props.at === undefined}
          fallback={
            <Empty title="No unspent outputs at this block">
              Everything paid to this address by then had already been spent.
            </Empty>
          }
        >
          <Empty title="No unspent outputs">
            This address holds no coins: everything paid to it has been spent, or nothing has been
            paid to it yet.
          </Empty>
        </Show>
      </Match>
      <Match when={true}>
        <div class="address-utxos" aria-busy={sorted() === undefined ? "true" : "false"}>
          <DataTable
            caption={
              props.at === undefined
                ? "Unspent outputs of this address, newest first"
                : `Unspent outputs of this address at block ${groupDigits(props.at)}, newest first`
            }
            columns={columns}
            rows={
              sorted()?.slice((current() - 1) * UTXO_STEP, current() * UTXO_STEP) ??
              placeholders(undefined)
            }
            rowHref={(u) => (u ? paths.tx(u.txid) : undefined)}
          />
        </div>
        <Show when={pageCount() > 1}>
          <div class="address-more">
            <Pagination
              page={current()}
              pageCount={pageCount()}
              onPage={setPage}
              label="Unspent output pages"
            />
          </div>
        </Show>
      </Match>
    </Switch>
  );
}
