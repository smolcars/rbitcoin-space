// The Lightning penalties this server saw: force closes whose commitment was a revoked state, swept
// with the revocation key, newest sweep first (docs/API.md "/app/lightning/…"). A table on a wide
// screen, cards on a phone. Most servers have seen none, so the empty state is one line.
import { useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { formatDay } from "../../components/chart/scale";
import { type Column, DataTable } from "../../components/DataTable";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { Pagination } from "../../components/Pagination";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { createRequest } from "../../lib/api";
import { groupDigits } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { count, isPenalties, type Penalty, readPage } from "./lightning";
import {
  ask,
  BlockLink,
  ChannelLink,
  Ends,
  Gate,
  LightningNav,
  rememberList,
  SatsFig,
  usePhone,
} from "./parts";
import "./Penalties.css";

export default function PenaltiesPage() {
  usePageTitle(() => "Lightning penalties");
  const network = useNetwork();
  return (
    <div class="wrap ln">
      <LightningNav here="penalties" />
      <header class="ln-head">
        <h1>Penalties</h1>
      </header>
      <Show when={network()} keyed>
        {(n) => (
          <Gate>
            <Swept network={n} />
          </Gate>
        )}
      </Show>
    </div>
  );
}

/** Blocks from the close to its sweep. */
const after = (p: Penalty) => Math.max(0, p.penalty.block.height - p.closed.block.height);

const columns: Column<Penalty>[] = [
  {
    header: "Channel",
    cell: (p) => (
      // Its id on one line, then both ends: one cell, so the id never wraps for want of room.
      <span class="ln-node-row2">
        <span class="ln-node-row2__line">
          <ChannelLink id={p.id} />
        </span>
        <Ends one={p.node_one} two={p.node_two} />
      </span>
    ),
  },
  { header: "Capacity", sub: "sats", numeric: true, cell: (p) => groupDigits(p.capacity) },
  {
    header: "Close and sweep",
    drop: 2,
    cell: (p) => (
      <span class="ln-node-row2">
        <Hash
          value={p.closed.txid}
          href={paths.tx(p.closed.txid)}
          copyLabel="Copy closing transaction ID"
        />
        <Hash
          value={p.penalty.txid}
          href={paths.tx(p.penalty.txid)}
          copyLabel="Copy sweep transaction ID"
        />
      </span>
    ),
  },
  {
    header: "Swept after",
    sub: "blocks",
    numeric: true,
    drop: 1,
    cell: (p) => groupDigits(after(p)),
  },
  {
    header: "Swept",
    numeric: true,
    cell: (p) => (
      <span class="ln-node-row2 ln-node-row2--end">
        <span class="num">{formatDay(p.penalty.block.time)}</span>
        <span class="ln-row-when">
          Block <BlockLink block={p.penalty.block} />
        </span>
      </span>
    ),
  },
];

function Swept(props: { network: Network }) {
  const [search, setSearch] = useSearchParams();
  const page = createMemo(() => readPage(search["page"]));
  rememberList(paths.lightningPenalties(), "Penalties");
  const phone = usePhone();
  const [answer, { refetch }] = createRequest(
    () => (page() === 1 ? "/penalties" : `/penalties?page=${page() - 1}`),
    (path, signal) => ask(props.network, path, isPenalties, signal),
  );
  // A new page starts at the top of the list, not where "Next" was.
  let top: HTMLElement | undefined;
  createEffect(
    () => page(),
    (_, previous) => {
      if (previous !== undefined && top && top.getBoundingClientRect().top < 0)
        top.scrollIntoView({ block: "start" });
    },
  );
  const pages = (total: number, per: number) => Math.max(1, Math.ceil(total / per));
  return (
    <section aria-labelledby="ln-pen-title" ref={(el) => (top = el)}>
      <SectionHeader title="Revoked states swept" id="ln-pen-title">
        {(answer.latest?.total ?? 0) > 0 ? "Newest first" : undefined}
      </SectionHeader>
      <Switch>
        <Match when={answer.state === "errored"}>
          <ErrorState title="Could not load the penalties" error={answer.error} retry={refetch} />
        </Match>
        <Match when={answer.latest}>
          {(a) => (
            <Show
              when={a().total > 0}
              fallback={
                <p class="ln-aside">
                  {a().from === null
                    ? "None seen yet."
                    : `None seen since ${formatDay(a().from ?? 0)}, when this server began watching.`}
                </p>
              }
            >
              <p class="ln-aside">
                <span class="num">{groupDigits(a().total)}</span> seen on chain; who broadcast them
                is unknown.
              </p>
              <div class="ln-busy" aria-busy={a().page === page() - 1 ? "false" : "true"}>
                <Show
                  when={a().channels.length > 0}
                  fallback={<Empty title="No penalty on this page" />}
                >
                  <Show
                    when={!phone()}
                    fallback={
                      <ol class="ln-node-cards">
                        <For each={a().channels}>{(p) => <Card p={p} />}</For>
                      </ol>
                    }
                  >
                    <DataTable
                      caption="Revoked states swept, newest first"
                      columns={columns}
                      rows={a().channels}
                      rowHref={(p) => paths.lightningChannel(p.id)}
                    />
                  </Show>
                </Show>
              </div>
              <Show when={pages(a().total, a().per_page) > 1}>
                <Pagination
                  page={page()}
                  pageCount={pages(a().total, a().per_page)}
                  onPage={(n) =>
                    setSearch({ page: n === 1 ? undefined : String(n) }, { scroll: false })
                  }
                  label="Penalty pages"
                />
              </Show>
            </Show>
          )}
        </Match>
        <Match when={true}>
          <Loading label="Loading the penalties" />
        </Match>
      </Switch>
      <More label="How penalties are identified">
        <p>
          Each is a force close whose commitment was a revoked state: an output of it was later
          spent with the revocation key. The chain cannot tell which node broadcast it, or why; the
          keys in a commitment are made for it, not the nodes' own. A sweep is recognised only if it
          confirms within {groupDigits(2_016)} blocks of the close while this server watches.
        </p>
      </More>
    </section>
  );
}

/** A penalty on a phone: the channel and its day, both ends, then what it held and when. */
function Card(props: { p: Penalty }) {
  const p = () => props.p;
  return (
    <li class="ln-node-card">
      <p class="ln-node-card__id">
        <ChannelLink id={p().id} />
        <span class="ln-node-card__chan num">{formatDay(p().penalty.block.time)}</span>
      </p>
      <Ends one={p().node_one} two={p().node_two} />
      <p class="ln-node-card__state">
        <SatsFig sats={p().capacity} />
        <span>
          swept after {/* The figure and its unit on one line. */}
          <span class="num">{count(after(p()), "block").replace(" ", "\u00A0")}</span>
        </span>
      </p>
      <p class="ln-node-card__state ln-pen-go">
        <Link class="tap" href={paths.tx(p().closed.txid)}>
          Closing transaction
        </Link>
        <Link class="tap" href={paths.tx(p().penalty.txid)}>
          Sweep
        </Link>
        <span>
          Block <BlockLink block={p().penalty.block} />
        </span>
      </p>
    </li>
  );
}
