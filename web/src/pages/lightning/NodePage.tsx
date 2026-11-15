// One Lightning node, for its operator: its name (a claim) beside its key (its identity), its size
// and rank, then one view at a time (its channels, its closes, its fees, its past) chosen in the
// address, the node at a glance, and what it announces (docs/DESIGN.md "Lightning").
import { useParams, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import { Amount } from "../../components/Amount";
import { formatDay } from "../../components/chart/scale";
import { CopyButton } from "../../components/CopyButton";
import { HashFull } from "../../components/Hash";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { scrollCue } from "../../components/scrollCue";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import { createRequest, isNotFound } from "../../lib/api";
import { formatBtcShort, groupDigits, MISSING, truncateMiddle } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import {
  changeWords,
  cleanAlias,
  CLOSE_KINDS,
  cut,
  days,
  isNodeDetail,
  isNodeHistory,
  isPublicKey,
  KIND_SHORT,
  KIND_TAG,
  NAME_IN_TITLE,
  NODE_VIEWS,
  type NodeDetail,
  type NodeHistory as HistoryAnswer,
  ordinal,
  readView,
  weekAgo,
} from "./lightning";
import { ClosedList, OpenList, SatsFig } from "./NodeChannels";
import { FeeFigures, NodeFees, NodeHistory } from "./NodeCharts";
import { ask, Gate, LightningNav, rememberList, Stat, Tag } from "./parts";

export default function NodePage() {
  const params = useParams<{ key: string }>();
  const network = useNetwork();
  const key = () => (params.key ?? "").toLowerCase();
  return (
    <div class="wrap ln ln-node-page">
      <LightningNav here="detail" />
      <Show
        when={isPublicKey(key())}
        fallback={<NotFound title="Not a node's public key" text={BAD_KEY} />}
      >
        <Show when={{ network: network(), id: key() }} keyed>
          {(k) => (
            <Gate>
              <Node network={k.network} id={k.id} />
            </Gate>
          )}
        </Show>
      </Show>
    </div>
  );
}

const BAD_KEY =
  "A Lightning node is named by its public key: 66 hexadecimal characters, starting with 02 or 03.";

function NotFound(props: { title: string; text: string }) {
  usePageTitle(() => "Lightning node");
  return (
    <>
      <h1>Lightning node</h1>
      <Empty title={props.title}>{props.text}</Empty>
    </>
  );
}

function Node(props: { network: Network; id: string }) {
  const [node, { refetch }] = createRequest(
    () => props.id,
    (id, signal) => ask(props.network, `/nodes/${id}`, isNodeDetail, signal),
  );
  return (
    <Switch>
      <Match when={node.latest}>{(n) => <Body node={n()} network={props.network} />}</Match>
      <Match when={node.state === "errored" && isNotFound(node.error)}>
        <NotFound
          title="This server knows no such node"
          text="It holds a node while the node has an open channel it checked against the chain. A node with only private or closed channels, or one that never announced a channel, is not here."
        />
      </Match>
      <Match when={node.state === "errored"}>
        <ErrorState title="Could not load this node" error={node.error} retry={refetch} />
      </Match>
      <Match when={true}>
        <Loading label="Loading the node" />
      </Match>
    </Switch>
  );
}

function Body(props: { node: NodeDetail; network: Network }) {
  const [search] = useSearchParams();
  const name = () => cleanAlias(props.node.alias);
  const title = () => (name() === null ? null : cut(name() ?? "", NAME_IN_TITLE));
  usePageTitle(() => `Lightning node ${title()?.text ?? props.node.id.slice(0, 20)}`);
  // A channel opened from here leads back here, by the node's name, not to the list before it.
  createEffect(
    () => [props.node.id, title()?.text ?? "Unnamed node"] as const,
    ([id, label]) => rememberList(paths.lightningNode(id), label),
  );
  // Ages are as of the node's answer: the lists hold still while the reader works.
  const now = untrack(() => Math.floor(Date.now() / 1000));
  const [history, { refetch }] = createRequest(
    () => props.node.id,
    (id, signal) => ask(props.network, `/nodes/${id}/history`, isNodeHistory, signal),
  );
  const view = () => readView(search);
  const base = () => paths.lightningNode(props.node.id);
  return (
    <>
      <Header node={props.node} />
      <div class="ln-node-views">
        {/* noscroll: a view change keeps the tabs where they are on screen. */}
        <nav class="ln-picker ln-node-tabs" aria-label="Node views">
          <ul ref={(el) => scrollCue(el)}>
            <For each={NODE_VIEWS}>
              {(v) => (
                <li>
                  <Link
                    class="ln-picker__item"
                    href={v.id === "channels" ? base() : `${base()}?view=${v.id}`}
                    aria-current={view() === v.id ? "page" : "false"}
                    noscroll
                  >
                    {v.label}
                    <Show when={v.id === "channels"}>
                      <span class="ln-node-tabs__n num">
                        {groupDigits(props.node.channels.open)}
                      </span>
                    </Show>
                    <Show when={v.id === "closed"}>
                      <span class="ln-node-tabs__n num">
                        {groupDigits(props.node.channels.closed)}
                      </span>
                    </Show>
                  </Link>
                </li>
              )}
            </For>
          </ul>
        </nav>
        <Switch>
          <Match when={view() === "channels"}>
            <OpenList node={props.node} network={props.network} now={now} />
          </Match>
          <Match when={view() === "closed"}>
            <ClosedList node={props.node} network={props.network} now={now} />
          </Match>
          <Match when={view() === "fees"}>
            <div class="ln-node-fees">
              <FeeFigures node={props.node} />
              <NodeFees node={props.node} />
            </div>
          </Match>
          <Match when={view() === "history"}>
            <NodeHistory history={history} retry={refetch} />
          </Match>
        </Switch>
      </div>
      <Glance node={props.node} history={history.latest} now={now} />
      <Identity node={props.node} />
    </>
  );
}

/** Name and key, and the figures that size a node, on a line or two. */
function Header(props: { node: NodeDetail }) {
  const name = () => cleanAlias(props.node.alias);
  const title = () => (name() === null ? null : cut(name() ?? "", NAME_IN_TITLE));
  const [whole, setWhole] = createSignal(false);
  return (
    <header class="ln-node-head">
      <div class="ln-node-head__title">
        <h1>
          <Show when={title()} fallback={<span class="ln-alias--none">Unnamed node</span>}>
            {(t) => <bdi class="ln-alias">{t().text}</bdi>}
          </Show>
        </h1>
        <span class="ln-key" title={props.node.id}>
          {truncateMiddle(props.node.id, 8, 6)}
        </span>
      </div>
      <Show when={title()?.more}>
        <div>
          <button
            class="btn ln-name-more"
            type="button"
            aria-expanded={whole() ? "true" : "false"}
            onClick={() => setWhole((w) => !w)}
          >
            {whole() ? "Hide the whole name" : "Show the whole name"}
          </button>
          <Show when={whole()}>
            <p class="ln-name-full">
              <bdi>{name()}</bdi>
            </p>
          </Show>
        </div>
      </Show>
      <p class="ln-node-head__line">
        <span>
          <strong>
            <Amount sats={props.node.capacity} short />
          </strong>
          , <span class="muted">{ordinal(props.node.rank.capacity)} by capacity</span>
        </span>
        <span>
          <strong class="num">{groupDigits(props.node.channels.open)}</strong>{" "}
          {props.node.channels.open === 1 ? "open channel" : "open channels"},{" "}
          <span class="muted">{ordinal(props.node.rank.channels)} by channels</span>
        </span>
        {/* When a policy on its channels last changed, either end's: in the node's own answer. */}
        <Show when={props.node.figures.last_policy_update}>
          {(t) => (
            <span class="muted">
              Policies updated <TimeAgo time={t()} />
            </span>
          )}
        </Show>
      </p>
    </header>
  );
}

/** A figure's change over the week, or nothing where the record is younger than a week. */
function Change(props: { now: number; then: number | undefined; format: (n: number) => string }) {
  return (
    <Show when={props.then !== undefined}>
      <span class="ln-node-change">
        {changeWords(props.now, props.then ?? props.now, props.format)}
      </span>
    </Show>
  );
}

const btc = (n: number) => `${formatBtcShort(n)} BTC`;

function Glance(props: { node: NodeDetail; history: HistoryAnswer | undefined; now: number }) {
  const f = () => props.node.figures;
  const c = () => props.node.channels;
  const week = () => (props.history === undefined ? null : weekAgo(props.history, props.now));
  const age = (t: number | null) => (t === null ? MISSING : days(props.now - t));
  const forced = () =>
    c().closed === 0 ? null : Math.round(((c().force + c().penalty) / c().closed) * 100);
  return (
    <section aria-labelledby="ln-node-glance-title">
      <SectionHeader title="At a glance" id="ln-node-glance-title">
        <Show when={week()}>Changes over 7 days</Show>
      </SectionHeader>
      <dl class="ln-stats ln-node-glance">
        <Stat
          label="Capacity"
          sub={<Change now={props.node.capacity} then={week()?.capacity} format={btc} />}
        >
          <Amount sats={props.node.capacity} short />
        </Stat>
        <Stat
          label="Open channels"
          sub={
            <>
              {groupDigits(f().states.active)} enabled
              <Change now={c().open} then={week()?.channels} format={groupDigits} />
            </>
          }
        >
          <span class="num">{groupDigits(c().open)}</span>
        </Stat>
        <Stat
          label="Channel size, median"
          sub={
            <>
              Largest <SatsFig sats={f().capacity.largest} />, smallest{" "}
              <SatsFig sats={f().capacity.smallest} />
            </>
          }
        >
          <SatsFig sats={f().capacity.median} />
        </Stat>
        <Stat
          label="Channel age, median"
          sub={
            <Show when={f().funded.oldest !== null}>
              Oldest <span class="num">{age(f().funded.oldest)}</span>, youngest{" "}
              <span class="num">{age(f().funded.youngest)}</span>
            </Show>
          }
        >
          <span class="num">{age(f().funded.median)}</span>
        </Stat>
        <Stat
          label="Closes seen"
          sub={
            <Show when={forced() !== null} fallback="None seen">
              {forced()}% forced
              <span class="ln-node-kinds">
                <For each={CLOSE_KINDS}>
                  {(k) => (
                    <Show when={c()[k] > 0}>
                      <Tag icon={KIND_TAG[k].icon} tone={KIND_TAG[k].tone}>
                        <span class="num">{groupDigits(c()[k])}</span> {KIND_SHORT[k].toLowerCase()}
                      </Tag>
                    </Show>
                  )}
                </For>
              </span>
            </Show>
          }
        >
          <span class="num">{groupDigits(c().closed)}</span>
        </Stat>
        <Stat label="First seen">
          <span class="num">
            {props.node.first_seen === null ? MISSING : formatDay(props.node.first_seen)}
          </span>
        </Stat>
      </dl>
    </section>
  );
}

/** Who the node says it is: everything it announces, below the working section. */
function Identity(props: { node: NodeDetail }) {
  const addresses = () => (props.node.addresses ?? []).map((a) => cut(cleanAlias(a) ?? "", 128));
  const connect = () => {
    const first = addresses()[0];
    return first === undefined || first.more ? null : `${props.node.id}@${first.text}`;
  };
  // Only a colour in the form it is announced in is drawn: anything else is shown as nothing.
  const colour = () =>
    typeof props.node.color === "string" && /^#[0-9a-f]{6}$/i.test(props.node.color)
      ? props.node.color.toLowerCase()
      : null;
  return (
    <section aria-labelledby="ln-node-identity-title">
      <SectionHeader title="Identity" id="ln-node-identity-title">
        <Show when={props.node.last_update} fallback="It has sent no announcement">
          {(t) => (
            <>
              Announced <TimeAgo time={t()} />
            </>
          )}
        </Show>
      </SectionHeader>
      <dl class="ln-facts ln-node-identity">
        <div class="ln-fact">
          <dt>Public key</dt>
          <dd>
            <HashFull value={props.node.id} copyLabel="Copy public key" />
          </dd>
        </div>
        <div class="ln-fact">
          <dt>Connect</dt>
          <dd>
            <Show when={connect()} fallback={<span class="muted">No address announced</span>}>
              {(s) => (
                <span class="ln-node-connect">
                  <span class="mono ln-node-connect__text">{s()}</span>
                  <CopyButton value={s()} label="Copy the connect string" />
                </span>
              )}
            </Show>
          </dd>
        </div>
        <div class="ln-fact">
          <dt>Addresses</dt>
          <dd>
            <Show when={addresses().length > 0} fallback="None announced">
              <ul class="ln-chips ln-chips--mono">
                <For each={addresses()}>{(a) => <li>{a.text}</li>}</For>
              </ul>
            </Show>
          </dd>
        </div>
        <div class="ln-fact">
          <dt>Features</dt>
          <dd>
            <Show when={props.node.features.length > 0} fallback="None announced">
              <ul class="ln-chips">
                <For each={props.node.features}>
                  {(f) => (
                    <li>
                      {f.name ?? `Bit ${f.bit}`}
                      <span class="ln-chips__req">{f.required ? " (required)" : ""}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </dd>
        </div>
        <div class="ln-fact">
          <dt>Announced colour</dt>
          <dd>
            <Show when={colour()} fallback={<span class="muted">None announced</span>}>
              {(c) => (
                <span class="ln-node-colour">
                  <span class="ln-node-colour__swatch" style={{ "--chip": c() }} />
                  <span class="mono">{c()}</span>
                </span>
              )}
            </Show>
          </dd>
        </div>
      </dl>
      <More label="About names and announcements">
        <p>
          The public key is the node's identity: any node can announce any name or colour, another
          node's included. Addresses are where it says it can be reached; nothing here checks them,
          and they are not links.
        </p>
      </More>
    </section>
  );
}
