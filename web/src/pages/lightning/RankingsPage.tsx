// The 100 largest, best-connected or oldest Lightning nodes
// (docs/API.md "Nodes, channels, search and rankings").
import { useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { formatDay } from "../../components/chart/scale";
import { type Column, DataTable } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { ErrorState, Loading } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import { createRequest } from "../../lib/api";
import { groupDigits } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { isRankings, parseRanking, RANKINGS, type RankedNode } from "./lightning";
import { ask, Gate, nodeColumns, VERIFIED_NOTE, LightningNav, rememberList } from "./parts";

export default function RankingsPage() {
  const [search] = useSearchParams();
  const network = useNetwork();
  const by = createMemo(() => parseRanking(search["by"]));
  usePageTitle(() => `Lightning nodes ${by().words}`);
  return (
    <div class="wrap ln">
      <LightningNav here="rankings" />
      <header class="ln-head">
        <h1>Lightning nodes</h1>
        <nav class="ln-picker" aria-label="Ranked by">
          <ul>
            <For each={RANKINGS}>
              {(r) => (
                <li>
                  <Link
                    class="ln-picker__item tap"
                    href={paths.lightningRankings(r.id)}
                    aria-current={r.id === by().id ? "page" : "false"}
                  >
                    {r.label}
                  </Link>
                </li>
              )}
            </For>
          </ul>
        </nav>
      </header>
      <Show when={network()} keyed>
        {(n) => (
          <Gate>
            <Ranked network={n} by={by().id} />
          </Gate>
        )}
      </Show>
    </div>
  );
}

function Ranked(props: { network: Network; by: string }) {
  createEffect(
    () => props.by,
    (by) => rememberList(paths.lightningRankings(by), `Nodes ${parseRanking(by).words}`),
  );
  const [ranked, { refetch }] = createRequest(
    () => props.by,
    (by, signal) => ask(props.network, `/rankings/${by}?limit=100`, isRankings, signal),
  );
  // A function, so switching the ranking re-picks which columns a phone keeps.
  const columns = (): Column<RankedNode>[] => [
    { header: "Rank", numeric: true, optional: true, drop: 2, cell: (_, i) => groupDigits(i + 1) },
    ...nodeColumns(props.by === "channels" || props.by === "age" ? props.by : "capacity"),
    {
      header: "First seen",
      optional: props.by !== "age",
      drop: props.by === "age" ? undefined : 3,
      cell: (n) => (typeof n.first_seen === "number" ? formatDay(n.first_seen) : "–"),
    },
    {
      header: "Last announced",
      optional: true,
      drop: 1,
      cell: (n) => (typeof n.last_update === "number" ? <TimeAgo time={n.last_update} /> : "–"),
    },
  ];
  return (
    <Switch>
      <Match when={ranked.state === "errored"}>
        <ErrorState title="Could not load the ranking" error={ranked.error} retry={refetch} />
      </Match>
      <Match when={ranked.latest}>
        {(r) => (
          <section class="panel">
            <div class="ln-busy" aria-busy={r().by === props.by ? "false" : "true"}>
              <DataTable
                caption={`The 100 nodes ${parseRanking(r().by).words}`}
                columns={columns()}
                rows={r().nodes}
                rowHref={(n) => paths.lightningNode(n.id)}
              />
            </div>
            <More>
              <p>
                {VERIFIED_NOTE} First seen is the oldest funding block among a node's channels this
                server has seen.
              </p>
            </More>
          </section>
        )}
      </Match>
      <Match when={true}>
        <Loading label="Loading the ranking" />
      </Match>
    </Switch>
  );
}
