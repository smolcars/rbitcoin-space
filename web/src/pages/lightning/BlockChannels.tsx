// Inside the block page's Lightning panel (BlockLightning.tsx draws its summary): each channel the
// block opened and closed, largest first. A table on a wide screen, cards on a phone.
import { For, Show } from "solid-js";
import { type Column, DataTable } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { groupDigits } from "../../lib/format";
import { paths } from "../../lib/network";
import type { BlockChannel, BlockChannels as Found } from "./BlockLightning";
import type { CloseKind } from "./lightning";
import { ChannelId, Ends, KindTag, SatsFig, Tag, usePhone } from "./parts";
import "./BlockChannels.css";

type Row = BlockChannel & { kind?: CloseKind };

function What(props: { row: Row }) {
  return (
    <Show
      when={props.row.kind}
      fallback={
        <Tag icon="plus" tone="muted">
          Opened
        </Tag>
      }
    >
      {(k) => <KindTag kind={k()} />}
    </Show>
  );
}

function Channel(props: { row: Row }) {
  return (
    <Link class="ln-id num tap" href={paths.lightningChannel(props.row.id)}>
      <ChannelId id={props.row.id} />
    </Link>
  );
}

const COLUMNS: Column<Row>[] = [
  { header: "What", cell: (r) => <What row={r} /> },
  {
    header: "Channel and ends",
    cell: (r) => (
      <span class="blk-ln__chan">
        <Channel row={r} />
        <Ends one={r.node_one} two={r.node_two} />
      </span>
    ),
  },
  { header: "Capacity", sub: "sats", numeric: true, cell: (r) => groupDigits(r.capacity) },
];

export default function BlockChannels(props: { found: Found }) {
  const phone = usePhone();
  const rows = (): Row[] => [...props.found.opened.channels, ...props.found.closed.channels];
  const left = () => props.found.opened.count + props.found.closed.count - rows().length;
  return (
    <>
      <Show
        when={!phone()}
        fallback={
          <ol class="blk-ln__cards">
            <For each={rows()}>
              {(r) => (
                <li class="blk-ln__card">
                  <p class="blk-ln__head">
                    <What row={r} />
                    <SatsFig sats={r.capacity} />
                  </p>
                  <Channel row={r} />
                  <Ends one={r.node_one} two={r.node_two} />
                </li>
              )}
            </For>
          </ol>
        }
      >
        <DataTable
          caption="Channels this block opened and closed"
          columns={COLUMNS}
          rows={rows()}
          rowHref={(r) => paths.lightningChannel(r.id)}
        />
      </Show>
      <p class="ln-aside">
        Public channels only.
        {left() > 0 ? ` ${groupDigits(left())} smaller not listed.` : ""}
      </p>
    </>
  );
}
