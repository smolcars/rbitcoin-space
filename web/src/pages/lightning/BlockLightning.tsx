// The block page's one Lightning addition: the public channels a block opened and closed, in a
// closed panel under the block's facts. Asked together with the block itself (once the page knows
// the hash), only on a network whose config lists Lightning. The summary line is drawn from the
// answer here, so the panel appears with the answer; the lazy part, loaded only when the block has
// channels, draws the list inside. A block with none, a refusal, a graph still syncing or a reply
// that cannot be read shows nothing, and leaves no space.
import { lazy, Loading, Show } from "solid-js";
import { createRequest, fetchApp } from "../../lib/api";
import { loadConfig } from "../../lib/config";
import { formatBtcShort, groupDigits, NNBSP } from "../../lib/format";
import type { Network } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import type { CloseKind, NodeRef } from "./lightning";
import "./BlockLightning.css";

const ChannelList = lazy(() => import("./BlockChannels"));

/** A channel a block opened: its id, size and two ends. */
export interface BlockChannel {
  id: string;
  scid: string;
  capacity: number;
  node_one: NodeRef;
  node_two: NodeRef;
}

/** The channels a block opened and closed: some of each, and the counts over all of them. */
export interface BlockChannels {
  opened: { count: number; capacity: number; channels: BlockChannel[] };
  closed: { count: number; forced: number; channels: (BlockChannel & { kind: CloseKind })[] };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const isNode = (v: unknown): boolean =>
  obj(v) && str(v["id"]) && (v["alias"] === null || str(v["alias"]));
const isChannel = (v: unknown): v is BlockChannel =>
  obj(v) && str(v["id"]) && num(v["capacity"]) && isNode(v["node_one"]) && isNode(v["node_two"]);
const KINDS: ReadonlySet<unknown> = new Set(["cooperative", "force", "penalty", "other"]);
const isClosed = (v: unknown): boolean => isChannel(v) && KINDS.has((v as unknown as Obj)["kind"]);
const list = (v: unknown, f: (x: unknown) => boolean): boolean =>
  Array.isArray(v) && v.every((x) => f(x));

/** The answer's shape, checked whole before anything of it is drawn. */
export const isBlockChannels = (v: unknown): v is BlockChannels => {
  if (!obj(v) || !obj(v["opened"]) || !obj(v["closed"])) return false;
  const o = v["opened"];
  const c = v["closed"];
  return (
    num(o["count"]) &&
    num(o["capacity"]) &&
    list(o["channels"], isChannel) &&
    num(c["count"]) &&
    num(c["forced"]) &&
    list(c["channels"], isClosed)
  );
};

const channels = (n: number): string => `${groupDigits(n)} ${n === 1 ? "channel" : "channels"}`;

/** What a block did, in a line: `12 channels opened (3.40 BTC), 5 closed (2 forced)`. */
export function blockWords(b: BlockChannels): string {
  const said: string[] = [];
  if (b.opened.count > 0) {
    said.push(
      `${channels(b.opened.count)} opened (${formatBtcShort(b.opened.capacity)}${NNBSP}BTC)`,
    );
  }
  if (b.closed.count > 0) {
    // A count and its word stay on one line: "(2 forced)", never "(2" then "forced)".
    const forced = b.closed.forced > 0 ? ` (${groupDigits(b.closed.forced)} forced)` : "";
    const n = b.opened.count > 0 ? groupDigits(b.closed.count) : channels(b.closed.count);
    said.push(`${n} closed${forced}`);
  }
  return said.join(", ");
}

export function BlockLightning(props: { hash: string | undefined }) {
  const network = useNetwork();
  const [found] = createRequest(
    () => props.hash !== undefined && ([network(), props.hash] as const),
    async ([n, hash]: readonly [Network, string], signal) => {
      const config = await loadConfig();
      if (config?.lightning.includes(n) !== true) return null;
      const v = await fetchApp<unknown>(n, `/lightning/block/${hash}`, { signal, cached: true });
      return isBlockChannels(v) && (v.opened.count > 0 || v.closed.count > 0) ? v : null;
    },
  );
  return (
    <Show when={found.state === "ready" && found.latest}>
      {(b) => (
        <details class="panel blk-ln">
          <summary class="blk-ln__summary">
            <svg class="blk-ln__icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5" />
            </svg>
            <span>
              <strong>Lightning in this block:</strong> {blockWords(b())}
            </span>
          </summary>
          <Loading>
            <ChannelList found={b()} />
          </Loading>
        </details>
      )}
    </Show>
  );
}
