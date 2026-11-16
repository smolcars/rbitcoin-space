// What a block did to public Lightning channels: one line, closed, that says it; inside, each
// channel it opened and closed, largest first. A table on a wide screen, cards on a phone.
import { For, Show } from "solid-js";
import { type Column, DataTable } from "../../components/DataTable";
import { Link } from "../../components/Link";
import { formatBtcShort, groupDigits } from "../../lib/format";
import { paths } from "../../lib/network";
import { type BlockChannel, blockWords, type CloseKind, isBlockChannels } from "./lightning";
import { ChannelId, Ends, Fig, Icon, KindTag, Tag, usePhone } from "./parts";
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

export default function BlockChannels(props: { found: unknown }) {
  const phone = usePhone();
  const found = () => (isBlockChannels(props.found) ? props.found : undefined);
  return (
    <Show when={found()}>
      {(b) => {
        const rows = (): Row[] => [...b().opened.channels, ...b().closed.channels];
        const left = () => b().opened.count + b().closed.count - rows().length;
        return (
          <details class="panel blk-ln">
            <summary class="blk-ln__summary">
              <Icon name="swap" />
              <span>
                <strong>Lightning in this block:</strong> {blockWords(b())}
              </span>
            </summary>
            <Show
              when={!phone()}
              fallback={
                <ol class="blk-ln__cards">
                  <For each={rows()}>
                    {(r) => (
                      <li class="blk-ln__card">
                        <p class="blk-ln__head">
                          <What row={r} />
                          <Fig
                            exact={groupDigits(r.capacity)}
                            unit={r.capacity === 1 ? "sat" : "sats"}
                            short={`${formatBtcShort(r.capacity)} BTC`}
                          />
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
          </details>
        );
      }}
    </Show>
  );
}
