// One Lightning channel, for the operators at its ends: who charges what each way and what a hop
// costs, the two policies side by side, how it ended, and its life from funding to close
// (docs/DESIGN.md "Lightning"). Policies are what gossip advertises: enabled is not routable, and
// a missing policy is not a disabled one.
import { useLocation, useParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { formatDay, formatMoment } from "../../components/chart/scale";
import { CopyButton } from "../../components/CopyButton";
import { Hash } from "../../components/Hash";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../components/States";
import { TimeAgo } from "../../components/Time";
import { type ApiResource, createRequest, isNotFound } from "../../lib/api";
import { useNow } from "../../lib/clock";
import { formatBtcShort, formatUtc, groupDigits, isoTime } from "../../lib/format";
import { type Network, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import {
  changesIn,
  movesIn,
  type ChannelDetail,
  channelTag,
  CLOSE_WORDS,
  type Close,
  closeShown,
  count,
  days,
  type End,
  FEE_HISTORY,
  type FeeHistory,
  hopFee,
  htlcLimit,
  inboundOf,
  isChannelDetail,
  isFeeHistory,
  isChannelId,
  lifeSteps,
  parseSats,
  type Policy,
  plus,
  shortName,
  type Step,
  TERMS,
} from "./lightning";
import {
  Alias,
  ask,
  BlockLink,
  ChannelId,
  ChannelLink,
  Fig,
  Gate,
  Icon,
  InboundFig,
  inboundName,
  KindTag,
  LightningNav,
  Msat,
  MsatFig,
  NodeName,
  PpmFig,
  Tag,
} from "./parts";
import { ChannelFees } from "./ChannelFees";

export default function ChannelPage() {
  const params = useParams<{ id: string }>();
  const network = useNetwork();
  const id = () => params.id ?? "";
  usePageTitle(() => `Lightning channel ${id()}`);
  return (
    <div class="wrap ln ln-channel">
      <LightningNav here="detail" />
      <Show
        when={isChannelId(id())}
        fallback={
          <NotFound title="Not a channel id">
            A channel is named by its funding position, block, transaction and output, as in
            811984x2037x0, or by the same as one decimal number.
          </NotFound>
        }
      >
        <Show when={{ network: network(), id: id() }} keyed>
          {(k) => (
            <Gate>
              <Channel network={k.network} id={k.id} />
            </Gate>
          )}
        </Show>
      </Show>
    </div>
  );
}

function NotFound(props: { title: string; children: string }) {
  return (
    <>
      <h1>Lightning channel</h1>
      <Empty title={props.title}>{props.children}</Empty>
    </>
  );
}

function Channel(props: { network: Network; id: string }) {
  const [channel, { refetch }] = createRequest(
    () => props.id,
    (id, signal) => ask(props.network, `/channels/${id}`, isChannelDetail, signal),
  );
  return (
    <Switch>
      <Match when={channel.latest}>{(c) => <Body channel={c()} network={props.network} />}</Match>
      <Match when={channel.state === "errored" && isNotFound(channel.error)}>
        <NotFound title="This server knows no such channel">
          It lists only public channels whose funding output it found on the chain, from when its
          Lightning peer started. A private channel, one that closed before then, or one announced
          but never funded is not here.
        </NotFound>
      </Match>
      <Match when={channel.state === "errored"}>
        <ErrorState title="Could not load this channel" error={channel.error} retry={refetch} />
      </Match>
      <Match when={true}>
        <Loading label="Loading the channel" />
      </Match>
    </Switch>
  );
}

function Body(props: { channel: ChannelDetail; network: Network }) {
  const c = () => props.channel;
  const tag = () => channelTag(c());
  const now = useNow();
  // The fee history is a second request, after the channel's own: a closed channel has none.
  const [fees, { refetch }] = createRequest(
    // With no policy either way the section is not drawn: nothing to ask.
    () => (c().closed || !(c().node_one.policy ?? c().node_two.policy) ? undefined : c().id),
    (id, signal) => ask(props.network, `/channels/${id}/fees`, isFeeHistory, signal),
  );
  // Read once per answer: the steps run on to it, and the chart is not drawn again on the clock.
  const answered = createMemo(() => {
    void fees.latest;
    return Math.floor(Date.now() / 1000);
  });
  // A link to the history lands on it: the section is there, at its height, from the first draw.
  const location = useLocation();
  createEffect(
    () => location.hash,
    (hash) => {
      if (hash === `#${FEE_HISTORY}`) document.getElementById(FEE_HISTORY)?.scrollIntoView();
    },
  );
  return (
    <>
      <header class="ln-identity ln-chan">
        <div class="ln-chan__title">
          <h1>
            Channel{" "}
            <span class="ln-chan__id">
              <ChannelId id={c().id} />
            </span>
          </h1>
          <Tag icon={tag().icon} tone={tag().tone} class={c().closed ? "ln-tag--pill" : undefined}>
            {tag().word}
          </Tag>
        </div>
        <p class="ln-chan__line">
          <span class="ln-chan__between">
            <span>Between</span>
            <NodeName node={c().node_one} />
            <span>and</span>
            <NodeName node={c().node_two} />
          </span>
        </p>
        <p class="ln-chan__line">
          <strong>
            <Fig exact={count(c().capacity, "sat")} short={`${formatBtcShort(c().capacity)} BTC`} />
          </strong>
          <Show when={c().funding.block}>
            {(b) => (
              <span>
                {c().closed ? "Lived" : "Open for"}{" "}
                <span class="num">{days((c().closed?.block.time ?? now()) - b().time)}</span>,
                funded{" "}
                <time class="num" datetime={isoTime(b().time)} title={formatUtc(b().time)}>
                  {formatDay(b().time)}
                </time>
              </span>
            )}
          </Show>
        </p>
        <dl class="ln-chan__ids">
          <IdForm label="Id" value={c().id} what="" />
          <IdForm label="As one number" value={c().scid} what=" as one number" />
          <IdForm label="lnd's form" value={c().id.replaceAll("x", ":")} what=" in lnd's form" />
        </dl>
      </header>
      <Show
        when={c().closed}
        fallback={
          <>
            <Lanes channel={c()} />
            {/* With no policy either way there is nothing to work out or compare. */}
            <Show when={c().node_one.policy ?? c().node_two.policy}>
              <HopFee channel={c()} />
              <Policies channel={c()} />
              <ChannelFees channel={c()} history={fees} now={answered()} retry={refetch} />
            </Show>
          </>
        }
      >
        {(x) => <Outcome channel={c()} close={x()} />}
      </Show>
      <Life channel={c()} fees={fees} />
    </>
  );
}

function IdForm(props: { label: string; value: string; what: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>
        <span class="mono">{props.value}</span>
        <CopyButton value={props.value} label={`Copy the channel id${props.what}`} />
      </dd>
    </div>
  );
}

/** When something happened on the chain, and in which block. */
function Moment(props: { time: number; block: { height: number; hash: string; time: number } }) {
  return (
    <span>
      <time class="num" datetime={isoTime(props.time)} title={formatUtc(props.time)}>
        {formatMoment(props.time)}
      </time>
      , block <BlockLink block={props.block} />
    </span>
  );
}

/** A closed channel's answer: how it closed, the penalty if one was swept, what came next. */
function Outcome(props: { channel: ChannelDetail; close: Close }) {
  const x = () => props.close;
  // A breach found after the close keeps its kind ("force") with the sweep beside it.
  const words = () => CLOSE_WORDS[props.channel.penalty ? "penalty" : x().kind];
  return (
    <section aria-labelledby="ln-outcome-title">
      <SectionHeader title="How it ended" id="ln-outcome-title" />
      <div class="ln-outcome">
        <div class="ln-outcome__item">
          <p class="ln-outcome__what">
            <KindTag kind={closeShown(x().kind)} long />
            <Moment time={x().block.time} block={x().block} />
          </p>
          <p class="ln-outcome__tx">
            <Hash
              value={x().txid}
              href={paths.tx(x().txid)}
              copyLabel="Copy the closing transaction ID"
            />
            <span class="muted">
              <Show when={x().fee !== null} fallback="fee not known">
                fee <span class="num">{count(x().fee ?? 0, "sat")}</span>
              </Show>
            </span>
          </p>
        </div>
        <Show when={props.channel.penalty}>
          {(p) => (
            <div class="ln-outcome__item">
              <p class="ln-outcome__what">
                <KindTag kind="penalty" />
                <Moment time={p().block.time} block={p().block} />
              </p>
              <p class="ln-outcome__tx">
                <Hash
                  value={p().txid}
                  href={paths.tx(p().txid)}
                  copyLabel="Copy the sweeping transaction ID"
                />
              </p>
            </div>
          )}
        </Show>
        <Show when={props.channel.continued_as}>
          {(n) => (
            <div class="ln-outcome__item">
              <p class="ln-outcome__what">
                <Tag icon="branch" tone="muted">
                  Continued as <ChannelLink id={n().id} />
                </Tag>
                <span class="muted">inferred</span>
              </p>
            </div>
          )}
        </Show>
      </div>
      <More label="What the chain shows">
        <p>
          {words().name} · {words().sure}. {words().why}
        </p>
        <Show when={props.channel.continued_as}>
          <p>
            “Continued as” is inferred: the closing transaction funds a new channel between the same
            two nodes.
          </p>
        </Show>
      </More>
    </section>
  );
}

/**
 * The two lanes, one each way, each saying in words which end charges what. An end's policy is
 * what it charges to forward a payment out over this channel, towards the other end.
 */
function Lanes(props: { channel: ChannelDetail }) {
  const one = () => props.channel.node_one;
  const two = () => props.channel.node_two;
  return (
    <section aria-labelledby="ln-lanes-title">
      <SectionHeader title="Who charges what" id="ln-lanes-title">
        Advertised; balances unknown
      </SectionHeader>
      <div class="ln-lanes">
        <div class="ln-end ln-end--one">
          <span class="ln-end__tag">Node one</span>
          <NodeName node={one()} />
        </div>
        <div class="ln-end ln-end--two">
          <span class="ln-end__tag">Node two</span>
          <NodeName node={two()} />
        </div>
        <ol class="ln-lanes__list">
          <Lane from={one()} to={two()} tone={1} />
          <Lane from={two()} to={one()} tone={2} />
        </ol>
      </div>
      <More label="Whose fee is whose">
        <p>
          Each end sets the fee for forwarding out over the channel: <bdi>{shortName(one())}</bdi>{" "}
          towards <bdi>{shortName(two())}</bdi>, and the other way. An inbound discount or surcharge
          (lnd's inbound fee) is what an end takes off or adds for a payment that reaches it over
          the channel. Enabled is what an end advertises, not proof that a payment gets through.
        </p>
      </More>
    </section>
  );
}

function Lane(props: { from: End; to: End; tone: 1 | 2 }) {
  const p = () => props.from.policy;
  return (
    <li class={["ln-lane", `ln-lane--${props.tone}`, { "ln-lane--shut": p()?.enabled !== true }]}>
      <div class="ln-lane__track" aria-hidden="true">
        <span class="ln-lane__line" />
        <span class="ln-lane__head" />
        <Show when={p()?.enabled === false}>
          <span class="ln-lane__gate">
            <Icon name="pause" />
          </span>
        </Show>
      </div>
      <p class="ln-lane__who">
        <strong>
          <bdi>{shortName(props.from)}</bdi>
        </strong>{" "}
        charges to forward towards <bdi>{shortName(props.to)}</bdi>
      </p>
      <Show when={p()} fallback={<p class="ln-lane__fee">No policy</p>}>
        {(pol) => (
          <>
            <p class="ln-lane__fee">
              <PpmFig rate={pol().fee_rate} />
              <span class="ln-lane__plus"> + </span>
              <MsatFig msat={pol().base_fee_msat} />
            </p>
            <p class="ln-lane__note">
              <Show
                when={pol().enabled}
                fallback={
                  <Tag icon="pause" tone="caution">
                    Disabled
                  </Tag>
                }
              >
                <span>
                  CLTV <span class="num">{groupDigits(pol().cltv_delta)}</span>, max HTLC{" "}
                  <MsatFig msat={pol().max_htlc_msat} />
                </span>
              </Show>
            </p>
            <Show when={inboundOf(pol())}>
              {(f) => (
                <p class="ln-lane__note">
                  {inboundName(f())} <InboundFig fee={f()} />
                </p>
              )}
            </Show>
          </>
        )}
      </Show>
    </li>
  );
}

/** What each end advertises for forwarding an amount over this one channel. */
function HopFee(props: { channel: ChannelDetail }) {
  const [text, setText] = createSignal("100 000");
  const amount = () => parseSats(text());
  const error = () => {
    const a = amount();
    return "error" in a ? a.error : "";
  };
  const sats = () => {
    const a = amount();
    return "sats" in a ? a.sats : null;
  };
  const id = createUniqueId();
  const ways = () => [
    { from: props.channel.node_one, to: props.channel.node_two, tone: 1 },
    { from: props.channel.node_two, to: props.channel.node_one, tone: 2 },
  ];
  return (
    <section aria-labelledby="ln-hop-title">
      <SectionHeader title="Fee for this hop" id="ln-hop-title">
        Advertised, not a quote
      </SectionHeader>
      <div class="ln-hop">
        <label class="ln-hop__field">
          <span>Amount, sats</span>
          <input
            class="ln-input num"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            value={text()}
            aria-describedby={`${id}-error`}
            aria-invalid={error() === "" ? "false" : "true"}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </label>
        <p class="ln-hop__error" id={`${id}-error`} role="status">
          {error()}
        </p>
        {/* Said again as the amount changes, both ways at once, while focus stays in the field. */}
        <ul class="ln-hop__ways" aria-live="polite" aria-atomic="true">
          <For each={ways()}>
            {(w) => (
              <li class={`ln-hop__way ln-lane--${w.tone}`}>
                <span class="ln-hop__dir">
                  <bdi>{shortName(w.from)}</bdi> → <bdi>{shortName(w.to)}</bdi>
                </span>
                <WayFee policy={w.from.policy} sats={sats()} />
              </li>
            )}
          </For>
        </ul>
      </div>
      <More label="How it is worked out">
        <p>
          Fee = base fee + amount × fee rate ÷ 1 000 000, in millisatoshis, rounded down as nodes
          do. An inbound fee is not included. Gossip does not say whether the channel has the
          balance to forward it.
        </p>
      </More>
    </section>
  );
}

function WayFee(props: { policy: Policy | null; sats: number | null }) {
  return (
    <Show when={props.sats} fallback={<span class="muted">–</span>}>
      {(n) => (
        <Show when={props.policy} fallback={<span class="ln-hop__none">No policy</span>}>
          {(p) => {
            const fee = () => hopFee(p(), n());
            const limit = () => htlcLimit(p(), n());
            return (
              <Switch>
                <Match when={!p().enabled}>
                  <Tag icon="pause" tone="caution">
                    Disabled
                  </Tag>
                </Match>
                <Match when={limit()}>
                  {(l) => (
                    <>
                      <Tag icon="warn" tone="caution" class="ln-hop__limit">
                        {l() === "over" ? "Over max HTLC (" : "Under min HTLC ("}
                        <MsatFig msat={l() === "over" ? p().max_htlc_msat : p().min_htlc_msat} />)
                      </Tag>
                      <span class="ln-hop__work">
                        Would be <MsatFig msat={fee().msat} />
                      </span>
                    </>
                  )}
                </Match>
                <Match when={true}>
                  <strong class="ln-hop__fee">
                    <MsatFig msat={fee().msat} />
                  </strong>
                  <span class="ln-hop__work">
                    <MsatFig msat={p().base_fee_msat} /> +{" "}
                    <span class="num">{groupDigits(n())}</span> ×{" "}
                    <span class="num">{groupDigits(p().fee_rate)}</span> ÷{" "}
                    <span class="num">{groupDigits(1_000_000)}</span>
                    {fee().exact ? "" : ", rounded down"}
                  </span>
                </Match>
              </Switch>
            );
          }}
        </Show>
      )}
    </Show>
  );
}

/** One end's term: a figure, an msat term that opens to its exact msat, or a time. */
function term(t: (typeof TERMS)[number], p: Policy | null): JSX.Element {
  if (!p) return "–";
  const k = t.key;
  if (k === "base_fee_msat" || k === "min_htlc_msat" || k === "max_htlc_msat") {
    const what = `${t.label[0]?.toLowerCase() ?? ""}${t.label.slice(1)}`;
    return <Msat msat={p[k]} what={what} />;
  }
  if (k === "last_update") return <TimeAgo time={p.last_update} />;
  if (k === "fee_rate") return <PpmFig rate={p.fee_rate} />;
  if (k === "inbound_rate" || k === "inbound_base") {
    const f = inboundOf(p);
    if (!f) return "None";
    return k === "inbound_rate" ? (
      <PpmFig rate={f.fee_rate} signed />
    ) : (
      <MsatFig msat={f.base_fee_msat} sign={plus(f.base_fee_msat)} />
    );
  }
  return <span class="num">{t.show(p)}</span>;
}

function Policies(props: { channel: ChannelDetail }) {
  const one = () => props.channel.node_one;
  const two = () => props.channel.node_two;
  // An inbound fee's terms only where an end advertises one.
  const terms = () =>
    TERMS.filter(
      (t) =>
        t.inbound !== true || inboundOf(one().policy) !== null || inboundOf(two().policy) !== null,
    );
  const diff = (t: (typeof TERMS)[number]): JSX.Element => {
    const a = one().policy;
    const b = two().policy;
    if (!a || !b) return "–";
    const d = t.diff(a, b);
    if (d.side === null) return d.text;
    return (
      <>
        <bdi>{shortName(d.side === "one" ? one() : two())}</bdi>{" "}
        {d.msat === undefined ? (
          <span class="num">{d.text}</span>
        ) : (
          <MsatFig msat={d.msat} sign="+" />
        )}
      </>
    );
  };
  return (
    <section aria-labelledby="ln-terms-title">
      <SectionHeader title="Policies side by side" id="ln-terms-title" />
      <div class="table-scroll">
        <table class="table ln-terms">
          <caption class="visually-hidden">
            Each end's forwarding policy, and how they differ
          </caption>
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col" class="table__num">
                <Alias alias={one().alias} max={16} />
              </th>
              <th scope="col" class="table__num">
                <Alias alias={two().alias} max={16} />
              </th>
              <th scope="col" class="table__num table__optional">
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={terms()}>
              {(t) => (
                <tr>
                  <th scope="row">
                    {t.label}
                    {/* A phone has no room for the fourth column: the difference sits under the term. */}
                    <span class="ln-terms__under">{diff(t)}</span>
                  </th>
                  {/* data-end names a value where the narrowest layout stacks the two ends. */}
                  <td class="table__num" data-end={shortName(one())}>
                    {term(t, one().policy)}
                  </td>
                  <td class="table__num" data-end={shortName(two())}>
                    {term(t, two().policy)}
                  </td>
                  <td class="table__num table__optional ln-terms__diff">{diff(t)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Life(props: { channel: ChannelDetail; fees: ApiResource<FeeHistory> }) {
  const c = () => props.channel;
  const held = () => {
    const h = props.fees.latest;
    if (!h) return undefined;
    // The latest change, by the same test as the count: a record that charged the same is none.
    return {
      one: changesIn(h.node_one.records),
      two: changesIn(h.node_two.records),
      latest: Math.max(0, ...movesIn(h.node_one.records), ...movesIn(h.node_two.records)),
    };
  };
  const steps = () => lifeSteps(c(), held());
  const now = useNow();
  return (
    <section aria-labelledby="ln-life-title">
      <SectionHeader title="Life of the channel" id="ln-life-title" />
      <ol class="ln-life">
        <For each={steps()}>
          {(s, i) => (
            <li
              class={[
                "ln-step",
                {
                  "ln-step--current": s.key === "open",
                  "ln-step--last": i() === steps().length - 1,
                },
              ]}
            >
              <p class="ln-step__title">
                <strong>
                  <Show when={s.key === "fees" && s} fallback={STEP_TITLES[s.key]}>
                    {(f) => (
                      <a class="tap" href={`#${FEE_HISTORY}`}>
                        {count(f().one + f().two, "fee change")}
                      </a>
                    )}
                  </Show>
                </strong>
                <Show when={s.time}>
                  {(t) => (
                    <time class="num ln-step__time" title={formatUtc(t())}>
                      {formatMoment(t())}
                    </time>
                  )}
                </Show>
              </p>
              {/* The clock goes in as itself: read here, its tick would rebuild every step each second,
                  copy buttons and their "Copied" with them. */}
              <div class="ln-step__body">{stepBody(s, c(), now)}</div>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}

const STEP_TITLES: Record<Step["key"], string> = {
  from: "Continues an earlier channel",
  funded: "Funded",
  fees: "Fee changes",
  open: "Open now",
  closed: "Closed",
  swept: "Revoked state swept",
  continued: "Continued as a new channel",
};

function stepBody(s: Step, c: ChannelDetail, now: () => number): JSX.Element {
  if (s.key === "from" || s.key === "continued") return <ChannelLink id={s.channel.id} />;
  if (s.key === "fees") {
    return (
      <span>
        <bdi>{shortName(c.node_one)}</bdi> <span class="num">{groupDigits(s.one)}</span>,{" "}
        <bdi>{shortName(c.node_two)}</bdi> <span class="num">{groupDigits(s.two)}</span>; the latest{" "}
        <TimeAgo time={s.latest} />
      </span>
    );
  }
  if (s.key === "closed") return <KindTag kind={s.kind} long />;
  if (s.key === "swept") {
    return (
      <span>
        Block <BlockLink block={s.sweep.block} />
      </span>
    );
  }
  if (s.key === "open") {
    return (
      <span>
        <Show when={c.funding.block}>
          {(b) => (
            <>
              <span class="num">{days(now() - b().time)}</span> old;{" "}
            </>
          )}
        </Show>
        {channelTag(c).word.toLowerCase()}
      </span>
    );
  }
  return (
    <>
      <Show when={c.funding.block}>
        {(b) => (
          <span>
            Block <BlockLink block={b()} />
          </span>
        )}
      </Show>
      <Show when={c.funding.txid} fallback={<span>Transaction not looked up yet</span>}>
        {(txid) => (
          <Hash
            value={txid()}
            href={paths.tx(txid())}
            copyLabel="Copy the funding transaction ID"
          />
        )}
      </Show>
    </>
  );
}
