// An Arkade address's VTXOs (docs/DESIGN.md "Ark"), one page at a time, as the network's Arkade
// server lists them. Nothing here checks the server's claims; the page says only what it reported.
import { useParams, useSearchParams } from "@solidjs/router";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { Amount } from "../../../components/Amount";
import { type Column, DataTable } from "../../../components/DataTable";
import { Hash, HashFull } from "../../../components/Hash";
import { Link } from "../../../components/Link";
import { Pagination } from "../../../components/Pagination";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { ApiError, createRequest, fetchApp } from "../../../lib/api";
import { loadConfig } from "../../../lib/config";
import { formatUtc, groupDigits } from "../../../lib/format";
import { isNetwork, type Network, paths } from "../../../lib/network";
import { useNetwork, usePageTitle } from "../../../lib/page";
import {
  addressKind,
  type Listing,
  MAX_PAGE,
  readListing,
  readPage,
  spendableSats,
  statusOf,
} from "./address";
import { Icon } from "./parts";
import type { Vtxo } from "./vtxo";
import "./VtxoPage.css";
import "./AddressPage.css";

/** The server's words, as `errorMessage` writes them. */
const OFF = "Arkade is not available here.";
const FOREIGN = "Address belongs to another arkade server.";
const BARK = "Bark address.";
const OTHER_NETWORK = "Address is for another network.";
const UNKNOWN_VERSION = "Unknown ark address version.";

export default function AddressPage() {
  const params = useParams<{ address: string }>();
  const [search, setSearch] = useSearchParams<{ page?: string }>();
  const network = useNetwork();
  usePageTitle(() => "Arkade address");
  const address = () => params.address ?? "";
  const kind = () => addressKind(address(), network());
  const page = () => readPage(search.page);
  const [config] = createRequest(() => true, loadConfig);
  const here = () => config()?.ark[network()]?.includes("arkade") === true;
  return (
    <div class="wrap arkade-page">
      <Link class="arkade-page__back tap" href={paths.ark()}>
        ← Ark
      </Link>
      <header class="arkade-head">
        <div class="arkade-head__row">
          <h1>Address</h1>
          <span class="arkade-impl">Arkade</span>
        </div>
        <Show when={kind() !== "invalid"}>
          <span class="arkade-address">
            <HashFull value={address().toLowerCase()} copyLabel="Copy the address" />
          </span>
        </Show>
      </header>
      <Switch>
        <Match when={kind() === "invalid"}>
          <Empty title="Not an Arkade address" />
        </Match>
        <Match when={kind() === "bark"}>
          <Empty title="A Bark address">Its VTXOs cannot be listed.</Empty>
        </Match>
        <Match when={kind() === "unknown-version"}>
          <Empty title="Unknown Ark address version" />
        </Match>
        <Match when={kind() === "other-network"}>
          <Empty title="An address for another network" />
        </Match>
        <Match when={config.loading}>
          <Loading label="Asking Arkade" />
        </Match>
        <Match when={!here()}>
          <Empty title="Arkade is not available on this network" />
        </Match>
        <Match when={true}>
          <List
            network={network()}
            address={address().toLowerCase()}
            page={page()}
            go={(n) => setSearch({ page: n === 1 ? undefined : String(n) })}
          />
        </Match>
      </Switch>
    </div>
  );
}

const unreadable = () => new ApiError(200, "Arkade sent a reply that could not be read.");

function List(props: { network: Network; address: string; page: number; go: (n: number) => void }) {
  // A string, so the same address and page asked again keep the page as it is.
  const key = createMemo(() => `${props.network} ${props.address} ${props.page}`);
  const [answer, { refetch }] = createRequest(key, async (k, signal) => {
    const [n, address, page] = k.split(" ");
    const query = page === "1" ? "" : `?page=${page ?? "1"}`;
    const v = await fetchApp<unknown>(
      isNetwork(n) ? n : "mainnet",
      `/ark/arkade/address/${encodeURIComponent(address ?? "")}${query}`,
      { signal },
    );
    const listing = readListing(v);
    if (!listing) throw unreadable();
    return listing;
  });
  const said = (message: string) =>
    answer.state === "errored" &&
    answer.error instanceof ApiError &&
    answer.error.message === message;
  return (
    <Switch>
      <Match when={said(OFF)}>
        <Empty title="Arkade is not available on this network" />
      </Match>
      <Match when={said(FOREIGN)}>
        <Empty title="This address belongs to another Arkade server" />
      </Match>
      <Match when={said(BARK)}>
        <Empty title="A Bark address">Its VTXOs cannot be listed.</Empty>
      </Match>
      <Match when={said(UNKNOWN_VERSION)}>
        <Empty title="Unknown Ark address version" />
      </Match>
      <Match when={said(OTHER_NETWORK)}>
        <Empty title="An address for another network" />
      </Match>
      <Match
        when={
          answer.state === "errored" &&
          answer.error instanceof ApiError &&
          answer.error.status === 400
        }
      >
        <Empty title="Not an Arkade address" />
      </Match>
      <Match when={answer.state === "errored"}>
        <ErrorState
          title="Arkade is not answering"
          error={answer.error}
          message="Try again in a moment."
          retry={refetch}
        />
      </Match>
      <Match when={answer.latest !== undefined}>
        <Body listing={() => answer.latest} busy={answer.loading} page={props.page} go={props.go} />
      </Match>
      <Match when={true}>
        <Loading label="Asking Arkade" />
      </Match>
    </Switch>
  );
}

function Body(props: {
  listing: () => Listing | undefined;
  busy: boolean;
  page: number;
  go: (n: number) => void;
}) {
  const l = (): Listing => props.listing() ?? { page: 1, pages: 0, vtxos: [] };
  const many = () => l().pages > 1;
  const pageCount = () => Math.min(MAX_PAGE, Math.max(l().pages, l().page));
  return (
    <Show when={l().pages > 0} fallback={<Empty title="No VTXOs" />}>
      <div class="panel arkade-figures arkade-figures--two">
        <div class="arkade-fig">
          <span class="arkade-fig__label">VTXOs</span>
          <span class="arkade-fig__value">
            <span class="num">{groupDigits(l().vtxos.length)}</span>
            <Show when={many()}>
              {" "}
              <span class="unit">on this page</span>
            </Show>
          </span>
        </div>
        <div class="arkade-fig">
          <span class="arkade-fig__label">{many() ? "Spendable on this page" : "Spendable"}</span>
          <span class="arkade-fig__value">
            <Amount sats={spendableSats(l().vtxos)} />
          </span>
        </div>
      </div>
      <section class="arkade-list" aria-busy={props.busy ? "true" : "false"}>
        <Show when={l().vtxos.length > 0} fallback={<Empty title="No VTXOs on this page" />}>
          <DataTable
            caption="This address's VTXOs, newest first"
            columns={COLUMNS}
            rows={l().vtxos}
            rowHref={(v) => paths.arkadeVtxo(`${v.txid}:${v.vout}`)}
          />
        </Show>
        <Show when={many() || props.page > 1}>
          <Pagination
            page={props.page}
            pageCount={pageCount()}
            onPage={(n) => props.go(n)}
            label="VTXO pages"
          />
        </Show>
      </section>
    </Show>
  );
}

const COLUMNS: Column<Vtxo>[] = [
  {
    header: "VTXO",
    cell: (v) => (
      <span class="arkade-outpoint-cell">
        <Hash value={v.txid} href={paths.arkadeVtxo(`${v.txid}:${v.vout}`)} copy={false} fit />
        <span class="arkade-outpoint-cell__vout num">:{v.vout}</span>
      </span>
    ),
  },
  {
    header: "Amount, BTC",
    numeric: true,
    cell: (v) => <Amount sats={v.amount} unit={false} />,
  },
  {
    header: "Status",
    cell: (v) => (
      <span class="arkade-status">
        <For each={statusOf(v)}>
          {(b) => (
            <span
              class={[
                "arkade-state",
                { "arkade-state--caution": b.tone === "caution" },
                { "arkade-state--negative": b.tone === "negative" },
              ]}
            >
              <Icon name={b.icon} />
              {b.word}
            </span>
          )}
        </For>
      </span>
    ),
  },
  {
    header: "Expires",
    numeric: true,
    drop: 1,
    cell: (v) => (
      <time class="num" title={formatUtc(v.expires_at)}>
        {formatUtc(v.expires_at, false)}
      </time>
    ),
  },
];
