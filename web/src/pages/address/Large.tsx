import { createMemo, Match, onCleanup, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { type Column, DataTable } from "../../components/DataTable";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState } from "../../components/States";
import { createApi, createRequest, fetchApp } from "../../lib/api";
import type { Transaction } from "../../lib/esplora";
import { groupDigits, MISSING } from "../../lib/format";
import { paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { arrivals, netChange, readSize, txFeeRate } from "./address";
import { MEMPOOL_ROWS, POLL_MS } from "./poll";
import { Skeleton, settled, UnconfirmedMark } from "./parts";
import { Stat } from "./Totals";

const plural = (n: number, one: string, many: string) =>
  `${groupDigits(n)} ${n === 1 ? one : many}`;

/**
 * An address paid by more transactions than the node totals: what is known (how many transactions
 * have paid it, the node's cap, its unconfirmed transactions now), then what is not shown and why.
 */
export function LargeAddress(props: { address: string; note?: JSX.Element }) {
  const network = useNetwork();
  const path = `/address/${encodeURIComponent(props.address)}`;
  const [answer] = createRequest(
    () => network(),
    (net, signal) => fetchApp<unknown>(net, `${path}/size`, { signal }),
  );
  // A size the server does not know (it was forgotten, or the node's wording changed) is no error:
  // the page says what it can without it.
  const size = () => readSize(settled(answer));
  const sizeSettled = () => answer.state !== "unresolved" && answer.state !== "pending";
  const pool = useUnconfirmed(props.address);
  const list = () => pool.checked()?.list;
  const change = () =>
    list()?.reduce((sum, tx) => sum + (netChange(tx, props.address) ?? 0), 0) ?? 0;

  return (
    <>
      <Show when={props.note}>{props.note}</Show>
      <section class="address-totals panel" aria-label="What is known">
        <dl class="address-stats address-stats--large">
          <Show when={size() !== undefined || !sizeSettled()}>
            <Stat
              class="address-stat--balance"
              label="Received"
              ready={size() !== undefined}
              value={<span class="num">{groupDigits(size()?.creates ?? 0)}</span>}
              sub="transactions paid to it, as counted by the node"
            />
            <Stat
              label="This server's limit"
              ready={size() !== undefined}
              value={<span class="num">{groupDigits(size()?.cap ?? 0)}</span>}
              sub="paying transactions per address"
            />
          </Show>
          <Stat
            label="Unconfirmed"
            ready={list() !== undefined || pool.failed()}
            value={
              <Show
                when={list()?.length}
                fallback={<span class="muted">{pool.failed() ? MISSING : "None"}</span>}
              >
                <Amount sats={change()} signed />
              </Show>
            }
            sub={
              <Show
                when={list()?.length}
                fallback={pool.failed() ? "Not known just now" : "Nothing waiting"}
              >
                {(n) => <UnconfirmedMark label={plural(n(), "transaction", "transactions")} />}
              </Show>
            }
          />
        </dl>
        <Show
          when={props.note === undefined}
          fallback={
            <p class="address-unshown">
              Its balance, unspent outputs and confirmed transactions are not shown yet.
            </p>
          }
        >
          <p class="address-unshown">
            Its balance, unspent outputs and confirmed transactions are not shown.{" "}
            <Show when={size()} fallback="It has more history than this server's node adds up,">
              {(s) =>
                `The node adds up only addresses paid by at most ${groupDigits(s().cap)} transactions,`
              }
            </Show>{" "}
            and reading even its newest confirmed transactions would keep the node busy for tens of
            seconds or more.
          </p>
        </Show>
      </section>
      <UnconfirmedTransactions address={props.address} pool={pool} />
    </>
  );
}

/** An address's unconfirmed transactions, asked every {@link POLL_MS} while the page is in view. */
export function useUnconfirmed(address: string) {
  const path = `/address/${encodeURIComponent(address)}`;
  const [pool, { refetch }] = createApi<Transaction[]>(() => `${path}/txs/mempool`);
  const ask = () => {
    if (!document.hidden && pool.state !== "pending" && pool.state !== "refreshing") refetch();
  };
  const timer = setInterval(ask, POLL_MS);
  document.addEventListener("visibilitychange", ask);
  onCleanup(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", ask);
  });
  // The last answer kept through a failed check, in the order its transactions reached the page.
  const checked = createMemo((was?: { list: Transaction[]; fresh: Set<string> }) => {
    const a = settled(pool);
    return a ? arrivals(was?.list, a) : was;
  });
  // Holds from a failed check until an answer comes: a retry in flight is no answer yet.
  const failed = createMemo((was?: boolean) =>
    pool.state === "errored" ? true : pool.state === "ready" ? false : (was ?? false),
  );
  return { pool, refetch, checked, failed };
}

/** The unconfirmed transactions section, from {@link useUnconfirmed}. */
export function UnconfirmedTransactions(props: {
  address: string;
  pool: ReturnType<typeof useUnconfirmed>;
}) {
  const { pool: answer, refetch, checked, failed } = props.pool;
  const list = () => checked()?.list;
  const columns: Column<Transaction | null>[] = [
    {
      header: "Transaction",
      cell: (tx) =>
        tx ? (
          <span class="address-txcell">
            <Hash value={tx.txid} href={paths.tx(tx.txid)} copyLabel="Copy transaction ID" fit />
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
        return sats === null ? MISSING : <Amount sats={sats} signed unit={false} />;
      },
    },
    {
      header: "Fee rate, sat/vB",
      numeric: true,
      optional: true,
      cell: (tx) => {
        if (!tx) return <Skeleton width="6ch" />;
        const rate = txFeeRate(tx);
        return rate === null ? MISSING : <FeeRate rate={rate} unit={false} />;
      },
    },
  ];

  return (
    <>
      <section class="address-history" aria-labelledby="address-mempool-title">
        <SectionHeader title="Unconfirmed transactions" id="address-mempool-title">
          <span class={["address-live", { "address-live--on": !failed() }]}>
            <svg class="address-live__icon" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="4" />
            </svg>
            <span class="address-live__label">
              {failed() ? "Not checked" : `Checked every ${POLL_MS / 1000} seconds`}
            </span>
          </span>
        </SectionHeader>
        {/* A failed check after an answer keeps that answer, said to be possibly out of date. */}
        <Show when={failed() && list() !== undefined}>
          <p class="address-busy" role="status">
            The last check failed, so this list may be out of date. The page tries again by itself.
          </p>
        </Show>
        <Switch>
          <Match when={failed() && list() === undefined}>
            <ErrorState
              title="Could not load the unconfirmed transactions"
              error={answer.error}
              retry={refetch}
            />
          </Match>
          <Match when={list()?.length === 0}>
            <Empty title="Nothing waiting to confirm">
              <Show when={!failed()}>
                A payment to or from this address shows here within {POLL_MS / 1000} seconds of
                reaching the node.
              </Show>
            </Empty>
          </Match>
          <Match when={true}>
            <div class="address-pool" aria-busy={list() === undefined ? "true" : "false"}>
              <DataTable
                caption="Unconfirmed transactions of this address, latest arrivals first"
                columns={columns}
                rows={list() ?? [null, null, null]}
                rowHref={(t) => (t ? paths.tx(t.txid) : undefined)}
                rowClass={(t) =>
                  t && checked()?.fresh.has(t.txid) ? "address-row--new" : undefined
                }
              />
              <Show when={list() === undefined}>
                <span class="visually-hidden" role="status">
                  Loading unconfirmed transactions
                </span>
              </Show>
            </div>
            <Show when={(list()?.length ?? 0) >= MEMPOOL_ROWS}>
              <p class="address-unshown">
                The node lists at most {MEMPOOL_ROWS} unconfirmed transactions of one address, so
                there may be more.
              </p>
            </Show>
            <p class="address-unshown">They leave this list once they confirm.</p>
          </Match>
        </Switch>
      </section>
    </>
  );
}
