import { Show } from "solid-js";
import { type Column, DataTable } from "../../components/DataTable";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import { formatFeeRate } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { createReplacements, type Story } from "../../lib/replacements";
import { MinedStatus } from "./Status";
import "./RecentReplacements.css";

/** Rows shown, and held while the first answer is on its way: as many as the latest transactions. */
const ROWS = 6;
/** The panel is a glance, not the page: it asks again at most this often. */
const GAP_MS = 10_000;

const rateText = (r: number | null | undefined) =>
  r === null || r === undefined ? "–" : formatFeeRate(r);

const COLUMNS: Column<Story | null>[] = [
  {
    header: "Replacement",
    // On a phone its header, not its id, would set the column's width and push the status out.
    short: "Tx",
    cell: (s) =>
      s ? (
        <Hash value={s.id} href={paths.tx(s.id)} copy={false} fit />
      ) : (
        <span class="rbf-recent__bone" />
      ),
  },
  {
    header: "Fee rate, sat/vB",
    short: "sat/vB",
    numeric: true,
    cell: (s) =>
      s ? (
        <span class="rbf-recent__rates">
          <span class="rbf-recent__rate">
            <span class="num">{rateText(s.versions[0]?.tx.rate)}</span>
            <span aria-hidden="true"> →</span>
            <span class="visually-hidden"> to</span>
          </span>{" "}
          <span class="num">{rateText(s.versions.at(-1)?.tx.rate)}</span>
        </span>
      ) : (
        ""
      ),
  },
  {
    header: "When",
    optional: true,
    cell: (s) => (s ? <TimeAgo time={s.time} /> : ""),
  },
  {
    header: "Status",
    cell: (s) => (s ? <MinedStatus mined={s.mined} /> : ""),
  },
];

/**
 * The newest few replacements, each opening its newest version; the rest are on `/rbf`. The home
 * page and the mempool's history end with it.
 */
export default function RecentReplacements(props: { network: Network; class?: string }) {
  const feed = createReplacements(props.network, () => false, { gapMs: GAP_MS });
  const rows = () => feed.stories()?.slice(0, ROWS);
  return (
    <section class={["rbf-recent", props.class]} aria-labelledby="rbf-recent-title">
      <SectionHeader title="Recent replacements" id="rbf-recent-title">
        <Link href={paths.rbf()}>All replacements</Link>
      </SectionHeader>
      <Show
        when={!feed.off()}
        fallback={
          <Empty title="Replacements are not recorded here">
            This server does not follow this network's mempool.
          </Empty>
        }
      >
        <Show
          when={rows() ?? feed.error() === undefined}
          fallback={
            <ErrorState
              title="Could not load the replacements"
              error={feed.error()}
              retry={feed.refresh}
            />
          }
        >
          <DataTable<Story | null>
            caption="The newest replacements, newest first"
            columns={COLUMNS}
            rows={rows() ?? Array.from({ length: ROWS }, () => null)}
            rowHref={(s) => (s ? paths.tx(s.id) : undefined)}
            empty={
              <Empty title="No replacements yet">
                A transaction replaced in the mempool appears here as the server sees it.
              </Empty>
            }
          />
        </Show>
      </Show>
    </section>
  );
}
