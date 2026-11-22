import { createMemo, createSignal, For, Show } from "solid-js";
import { DataTable } from "../DataTable";
import { FeeRate } from "../FeeRate";
import { Hash } from "../Hash";
import { Empty, ErrorState, Loading } from "../States";
import { createRequest, fetchApp, isNotFound } from "../../lib/api";
import { groupDigits, MISSING } from "../../lib/format";
import { paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import {
  type AuditTotals,
  type AuditTx,
  categoryName,
  LIST_CAP,
  type ListedKind,
  readAuditDetail,
} from "./model";
import "./AuditList.css";

const TELLING: readonly ListedKind[] = [
  "missing",
  "unseen",
  "added",
  "displaced",
  "conflicted",
  "fresh",
];

/** How long before the block our node first saw a transaction: `12 min`, `40 s`. */
function before(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}

/** The transactions behind each category but `matched`, from `/app/block/:hash/audit`. */
/** Rows shown at first, and added by each "Show more", as the block's own list does. */
const PAGE = 25;

export default function AuditList(props: { hash: string; audit: AuditTotals }) {
  const network = useNetwork();
  const [detail, detailCtl] = createRequest(
    () => ({ hash: props.hash, network: network() }),
    async ({ hash, network: n }, signal) => {
      const d = readAuditDetail(
        await fetchApp<unknown>(n, `/block/${hash}/audit`, { signal, cached: true }),
      );
      if (!d) throw new Error("The server's answer could not be read.");
      return d;
    },
  );
  // The server's order: the most telling first.
  const kinds = createMemo(() => TELLING.filter((k) => props.audit[k].txs > 0));
  const [chosen, setChosen] = createSignal<ListedKind>();
  const kind = () => {
    const c = chosen();
    return c && kinds().includes(c) ? c : kinds()[0];
  };
  const d = () => (detail.state === "ready" ? detail() : undefined);
  const rows = () => d()?.txs.filter((t) => t.kind === kind()) ?? [];
  // A recent block can differ by thousands of transactions: a page at a time, not 9,000 px.
  const [shown, setShown] = createSignal(PAGE);
  const choose = (k: ListedKind) => {
    setChosen(k);
    setShown(PAGE);
  };
  const seenAt = () => d()?.seen_at ?? 0;
  const columns = [
    {
      header: "Transaction",
      cell: (t: AuditTx) => (
        <Hash value={t.txid} href={paths.tx(t.txid)} copyLabel="Copy transaction ID" fit />
      ),
    },
    {
      header: "Fee rate, sat/vB",
      short: "sat/vB",
      numeric: true,
      cell: (t: AuditTx) => <FeeRate rate={t.rate / 1000} unit={false} />,
    },
    {
      header: "Size, vB",
      numeric: true,
      optional: true,
      cell: (t: AuditTx) => (
        <>
          {groupDigits(t.vsize)}
          <span class="visually-hidden"> vB</span>
        </>
      ),
    },
    {
      header: "First seen, before the block",
      numeric: true,
      optional: true,
      cell: (t: AuditTx) =>
        t.first_seen === undefined ? MISSING : before(seenAt() - t.first_seen),
    },
  ];

  return (
    <div class="audit-list">
      <Show
        when={detail.state !== "errored"}
        fallback={
          <Show
            when={!isNotFound(detail.error)}
            fallback={
              <Empty title="No list for this block">
                This server holds no audit for this block any more, so it cannot list its
                transactions.
              </Empty>
            }
          >
            <ErrorState
              title="Could not load the list"
              error={detail.error}
              retry={() => detailCtl.refetch()}
            />
          </Show>
        }
      >
        <Show when={d()} fallback={<Loading label="Loading the list" />}>
          {(found) => (
            <>
              <div class="audit-list__kinds" role="group" aria-label="Category">
                <For each={kinds()}>
                  {(k) => (
                    <button
                      type="button"
                      class="btn audit-list__kind"
                      aria-pressed={kind() === k ? "true" : "false"}
                      onClick={() => choose(k)}
                    >
                      <span class={`audit-list__swatch audit-kind--${k}`} aria-hidden="true" />
                      {categoryName(k)}{" "}
                      <span class="num muted">{groupDigits(props.audit[k].txs)}</span>
                    </button>
                  )}
                </For>
              </div>
              <Show when={!found().complete}>
                <p class="audit-list__cut">
                  The server lists at most {groupDigits(LIST_CAP)} transactions, the most telling
                  first, so this list is cut short. The counts above include every one.
                </p>
              </Show>
              <Show
                when={rows().length > 0 && rows().length < props.audit[kind() ?? "missing"].txs}
              >
                <p class="audit-list__shown num" aria-live="polite">
                  {groupDigits(rows().length)} of{" "}
                  {groupDigits(props.audit[kind() ?? "missing"].txs)}{" "}
                  {categoryName(kind() ?? "missing").toLowerCase()} transactions listed
                </p>
              </Show>
              <DataTable
                caption={`${categoryName(kind() ?? "missing")} transactions, highest fee rate first`}
                columns={columns}
                rows={rows().slice(0, shown())}
                rowHref={(t) => paths.tx(t.txid)}
                empty={
                  <p class="audit-list__cut">
                    None of these made the list: it stopped at {groupDigits(LIST_CAP)}.
                  </p>
                }
              />
              <Show when={rows().length > shown()}>
                <div class="audit-list__more">
                  <button class="btn" type="button" onClick={() => setShown(shown() + PAGE)}>
                    Show {Math.min(PAGE, rows().length - shown())} more
                  </button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
