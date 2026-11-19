import {
  createMemo,
  createSignal,
  lazy,
  Loading as Pending,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Amount } from "../../components/Amount";
import { formatMoment } from "../../components/chart/scale";
import { type Column, DataTable } from "../../components/DataTable";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import type { JSX } from "@solidjs/web";
import type { ApiResource } from "../../lib/api";
import { useNow } from "../../lib/clock";
import type { AddressStats } from "../../lib/esplora";
import { formatBtc, groupDigits } from "../../lib/format";
import { paths } from "../../lib/network";
import type { Ledger, LedgerTx } from "./ledger";
import { UnconfirmedTransactions, useUnconfirmed } from "./Large";
import { Notice } from "./parts";
import { Totals } from "./Totals";
import "../../components/SectionHeader.css";

const Chart = lazy(() => import("../../components/chart/Chart"));

/** Rows shown at first and added by each "more", as the history list's. */
const PAGE = 25;

/** Plot height in px, as the other balance chart's. */
const HEIGHT = 200;

type Tracked = Extract<Ledger, { state: "tracked" }>;

const btcTick = (sats: number) => formatBtc(Math.round(sats)).replace(/\.?0+$/, "");
const btc = (sats: number) => `${formatBtc(sats)} BTC`;
const plural = (n: number, one: string, many: string) =>
  `${groupDigits(n)} ${n === 1 ? one : many}`;
const date = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * An address the server keeps its own running totals for (docs/API.md, "Very large addresses"):
 * its totals from the page's usual request, which the server answers from them, then its
 * transactions (all of them once the server keeps its whole history, `whole`, otherwise the
 * newest it keeps) and its balance since the server began keeping it, and its unconfirmed ones.
 */
export function KeptAddress(props: {
  address: string;
  ledger: Tracked;
  stats: ApiResource<AddressStats>;
  retry: () => void;
  /** Every confirmed transaction, paged, while the server keeps the whole history. */
  whole: JSX.Element;
}) {
  const pool = useUnconfirmed(props.address);
  return (
    <>
      <Totals stats={props.stats} retry={props.retry} />
      <p class="address-kept">
        These totals cover this address's whole history. This server counted them once, at block{" "}
        {groupDigits(props.ledger.seeded.height)} ({date(props.ledger.seeded.time)}), and has
        updated them from each new block since, so it shows them at once. They are exact at block{" "}
        {groupDigits(props.ledger.at.height)}.
      </p>
      <KeptChart ledger={props.ledger} />
      <Show
        when={props.ledger.history === "whole"}
        fallback={<KeptTransactions ledger={props.ledger} />}
      >
        {props.whole}
      </Show>
      <UnconfirmedTransactions address={props.address} pool={pool} />
    </>
  );
}

/** The balance after each block since the server began keeping the address, as a step line. */
function KeptChart(props: { ledger: Tracked }) {
  const now = useNow();
  const pts = () => props.ledger.points;
  return (
    <section class="address-balance" aria-labelledby="address-balance-title">
      <div class="section__head">
        <h2 id="address-balance-title">Balance over time</h2>
        <div class="section__meta">
          Since block {groupDigits(props.ledger.seeded.height)}, when this server began keeping it
        </div>
      </div>
      <div class="address-balance__slot">
        <Show
          when={pts().length > 0 && pts()}
          fallback={<p class="muted">No balance recorded yet.</p>}
        >
          {(p) => (
            <Pending>
              <Chart
                label="Confirmed balance after each block, since this server began keeping it"
                x={p().map((q) => q.time)}
                domain={[p()[0]?.time ?? 0, Math.max(now(), p().at(-1)?.time ?? 0)]}
                gap={Number.POSITIVE_INFINITY}
                height={HEIGHT}
                left={{ format: btcTick, zero: false }}
                series={[
                  {
                    name: "Balance",
                    values: p().map((q) => q.balance),
                    draw: "step",
                    until: Math.max(now(), p().at(-1)?.time ?? 0),
                    format: btc,
                    rawUnit: "sat",
                  },
                ]}
                notes={[{ name: "Block", values: p().map((q) => q.height), format: groupDigits }]}
                time={formatMoment}
              />
            </Pending>
          )}
        </Show>
      </div>
    </section>
  );
}

/** The newest confirmed transactions the server keeps, newest first in block order. */
function KeptTransactions(props: { ledger: Tracked }) {
  // In the history table's order, whose widths the page's style sets by position.
  const columns: Column<LedgerTx>[] = [
    {
      header: "Time",
      optional: true,
      cell: (tx) => <TimeAgo time={tx.time} />,
    },
    {
      header: "Transaction",
      cell: (tx) => (
        <span class="address-txcell">
          <Hash value={tx.txid} href={paths.tx(tx.txid)} copyLabel="Copy transaction ID" fit />
          {/* Phones drop the time column, so the time moves under the txid. */}
          <span class="address-txcell__when">
            <TimeAgo time={tx.time} />
          </span>
        </span>
      ),
    },
    {
      header: "This address, BTC",
      numeric: true,
      cell: (tx) => <Amount sats={tx.value} signed unit={false} />,
    },
    {
      header: "Block",
      numeric: true,
      optional: true,
      cell: (tx) => <Link href={paths.block(tx.height)}>{groupDigits(tx.height)}</Link>,
    },
  ];
  const txs = () => props.ledger.txs;
  // A page at a time, as the history list shows them: up to 200 is a long scroll on a phone.
  const [count, setCount] = createSignal(PAGE);
  return (
    <section class="address-history" aria-labelledby="address-kept-title">
      <SectionHeader title="Newest transactions" id="address-kept-title">
        <span class="section__meta">
          {plural(txs().length, "confirmed transaction", "confirmed transactions")}
        </span>
      </SectionHeader>
      <Switch>
        <Match when={txs().length === 0}>
          <Empty title="No confirmed transactions kept yet">
            This server began keeping this address at block{" "}
            {groupDigits(props.ledger.seeded.height)}{" "}
            <Show
              when={props.ledger.filling}
              fallback="and keeps none of its transactions from before it."
            >
              and asks its node once for the transactions before it.
            </Show>{" "}
            New ones show here as blocks confirm them.
          </Empty>
        </Match>
        <Match when={true}>
          <div class="address-txs">
            <DataTable
              caption="Newest confirmed transactions of this address, newest first"
              columns={columns}
              rows={txs().slice(0, count())}
              rowHref={(t) => paths.tx(t.txid)}
            />
          </div>
          <Show when={txs().length > count()}>
            <div class="address-more">
              <button class="btn" type="button" onClick={() => setCount((n) => n + PAGE)}>
                Show {Math.min(PAGE, txs().length - count())} more
              </button>
            </div>
          </Show>
          <p class="address-unshown">
            <Unshown ledger={props.ledger} />
            <Show when={props.ledger.filling}>
              {" "}
              Those from before block {groupDigits(props.ledger.seeded.height)}, when it began
              keeping this address, are added once its node has listed them.
            </Show>
          </p>
        </Match>
      </Switch>
    </section>
  );
}

/** Why the list stops at the newest transactions, by where the address's whole history stands. */
function Unshown(props: { ledger: Tracked }) {
  const newest = () => `its newest ${groupDigits(props.ledger.window)} confirmed transactions`;
  return (
    <Switch>
      <Match when={props.ledger.history === "refused"}>
        Its node declines to list this address's whole history, so this server keeps only {newest()}
        , not its older history or its unspent outputs.
      </Match>
      <Match when={props.ledger.history === "too_large"}>
        This address's whole history is larger than this server keeps, so it keeps only {newest()},
        not its older history or its unspent outputs.
      </Match>
      <Match when={props.ledger.history === "dropped" && props.ledger.historyAgain}>
        {(again) => (
          <>
            This server let this address's whole history go to make room for addresses viewed more
            lately. It takes it again when this page is open after {formatMoment(again())}; until
            then it shows {newest()}. Its unspent outputs are not kept.
          </>
        )}
      </Match>
      <Match when={props.ledger.history === "dropped"}>
        This server let this address's whole history go to make room for addresses viewed more
        lately, and is getting it again. Until then it shows {newest()}. Its unspent outputs are not
        kept.
      </Match>
      <Match when={true}>
        This server is getting this address's whole history from its node, once. Until then it shows{" "}
        {newest()}. Its unspent outputs are not kept.
      </Match>
    </Switch>
  );
}

/**
 * What the server is doing about an address too large for its node to answer at once: adding it up
 * once, with real progress (its place in line, or the seconds since it began), or that it failed.
 * A seed the node refused shows nothing here: the page is then as before the ledger.
 */
export function AddingUp(props: { ledger: Ledger }) {
  const now = useNow();
  // The seconds the server reported, counted on from when the page heard them.
  const heard = createMemo(() => {
    void props.ledger;
    return untrack(now);
  });
  const elapsed = () => Math.max(0, now() - heard());
  return (
    <Switch>
      <Match when={props.ledger.state === "failed"}>
        <Notice title="Adding this address up failed this time" tone="caution">
          The server tries again in a few minutes. Its unconfirmed transactions are below.
        </Notice>
      </Match>
      <Match when={true}>
        <section class="address-adding panel" aria-labelledby="address-adding-title">
          <h2 id="address-adding-title" class="address-adding__title">
            Adding up this address for the first time
          </h2>
          <p>
            Its node takes up to a few minutes over an address with this much history, once. From
            then on this server keeps its totals itself and this page shows them at once.
          </p>
          <p class="address-adding__progress">
            <Switch>
              <Match when={props.ledger.state === "seeding" && props.ledger}>
                {(l) => (
                  <>Being added up now: started {groupDigits(l().seconds + elapsed())} s ago.</>
                )}
              </Match>
              <Match when={props.ledger.state === "queued" && props.ledger}>
                {(l) => (
                  <Show when={l().position > 1} fallback="Next in line.">
                    Waiting its turn: {plural(l().position - 1, "address", "addresses")} ahead of
                    it.
                  </Show>
                )}
              </Match>
              <Match when={true}>
                The server is adding up other addresses first. This page asks again by itself.
              </Match>
            </Switch>
          </p>
        </section>
      </Match>
    </Switch>
  );
}
