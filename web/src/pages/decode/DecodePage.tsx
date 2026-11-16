// The decoder (docs/API.md "Decoding"): one page for every network. The pasted string lives in
// the fragment, which no server sees, and goes to the server in a POST body. Everything decoded is
// the string's claim: drawn as text, and a URL is never a link.
import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { CopyButton } from "../../components/CopyButton";
import { Hash } from "../../components/Hash";
import { More } from "../../components/More";
import { Empty, ErrorState, Loading } from "../../components/States";
import { ApiError, createRequest, postApp } from "../../lib/api";
import { useNow } from "../../lib/clock";
import { TimeUtc } from "../../components/Time";
import { formatBtcShort, formatRelative, groupDigits, truncateMiddle } from "../../lib/format";
import { NETWORK_NAMES, type Network, onNetwork, paths } from "../../lib/network";
import { usePageTitle } from "../../lib/page";
import {
  type Bark,
  type ChannelRef,
  type Decoded,
  type Feature,
  failure,
  type Invoice,
  isDecoded,
  type KeyRef,
  kindName,
  type Lnurl,
  networkName,
  type Offer,
  type PathRef,
  readFragment,
  type Refund,
  sats,
  splitHost,
} from "./decode";
import { type Answer, ask, AskError, plan, read, TAG_NAMES } from "./service";
import "./Decode.css";

export default function DecodePage() {
  usePageTitle(() => "Decode");
  const location = useLocation();
  const navigate = useNavigate();
  const pasted = () => readFragment(location.hash).trim();
  const [text, setText] = createSignal(pasted());
  // Arriving again from search (or Back) puts that string in the box.
  createEffect(pasted, (p) => {
    setText(p);
  });
  const [answer, { refetch }] = createRequest(
    () => pasted() || false,
    async (s, signal) => {
      const v = await postApp<unknown>("mainnet", "/decode", s, { signal });
      if (!isDecoded(v)) throw new ApiError(0, "The answer could not be read.");
      return v;
    },
  );
  const go = () => {
    const s = text().trim();
    if (s === "") return;
    if (s === pasted()) refetch();
    else navigate(paths.decode(s));
  };

  return (
    <div class="wrap dec">
      <h1>Decode</h1>
      <form
        class="panel dec__form"
        novalidate
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <textarea
          class="dec__input mono"
          name="paste"
          rows="3"
          aria-label="Invoice, offer, LNURL or address"
          placeholder="Paste an invoice, offer, LNURL or address"
          autocomplete="off"
          spellcheck={false}
          autocapitalize="off"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              go();
            }
          }}
        />
        <button class="btn btn--accent dec__go" type="submit">
          Decode
        </button>
      </form>
      <Show
        when={pasted() !== ""}
        fallback={
          <p class="dec__line">BOLT 11 and 12, LNURL, Lightning and Ark addresses, any network.</p>
        }
      >
        <Switch>
          <Match when={answer.state === "errored"}>
            <Show
              when={!failure(answer.error).final}
              fallback={<Empty title={failure(answer.error).title} />}
            >
              <ErrorState
                title={failure(answer.error).title}
                error={answer.error}
                retry={refetch}
              />
            </Show>
          </Match>
          <Match when={answer.loading || answer.latest === undefined}>
            <Loading label="Decoding" />
          </Match>
          <Match when={answer.latest}>
            {(d) => <Result d={d()} current={() => text().trim() === pasted()} />}
          </Match>
        </Switch>
      </Show>
    </div>
  );
}

/** `current`: the box still holds the decoded string; an edit stops asking its service. */
function Result(props: { d: Decoded; current: () => boolean }) {
  return (
    <article class="dec-result" aria-label="Decoded">
      <header class="dec-result__head">
        <h2 class="dec-result__kind">{kindName(props.d)}</h2>
        <span class="dec-net" data-net={props.d.network ?? "any"}>
          {networkName(props.d.network)}
        </span>
      </header>
      <Switch>
        <Match when={props.d.kind === "bolt11" && props.d}>{(d) => <InvoiceBody d={d()} />}</Match>
        <Match when={props.d.kind === "offer" && props.d}>{(d) => <OfferBody d={d()} />}</Match>
        <Match when={props.d.kind === "refund" && props.d}>{(d) => <RefundBody d={d()} />}</Match>
        <Match when={props.d.kind === "lnurl" && props.d}>
          {(d) => <LnurlBody d={d()} current={props.current} />}
        </Match>
        <Match when={props.d.kind === "lightning_address" && props.d}>
          {(d) => (
            <>
              <p class="dec-figure dec-figure--text">
                <bdi>{d().name}</bdi>@<strong>{d().domain}</strong>
              </p>
              <Facts>
                <Fact label="Asks">
                  <Url url={d().url} host={d().domain} />
                </Fact>
              </Facts>
              <Show when={props.current()}>
                <FromService d={d()} />
              </Show>
            </>
          )}
        </Match>
        <Match when={props.d.kind === "ark_address" && props.d}>
          {(d) => {
            const a = d();
            return a.implementation === "bark" ? (
              <BarkBody d={a} />
            ) : (
              <Facts>
                <Fact label="Server key">
                  <Hash value={a.server_key} copyLabel="Copy the server key" />
                </Fact>
                <Fact label="Output key">
                  <Hash value={a.p2tr_key} copyLabel="Copy the output key" />
                </Fact>
                <Fact label="Script">
                  <Hash value={a.script} copyLabel="Copy the script" />
                </Fact>
              </Facts>
            );
          }}
        </Match>
      </Switch>
    </article>
  );
}

function Facts(props: { children: JSX.Element }) {
  return <dl class="dec-facts">{props.children}</dl>;
}

function Fact(props: { label: string; children: JSX.Element; wide?: boolean }) {
  return (
    <div class={props.wide === true ? "dec-fact dec-fact--wide" : "dec-fact"}>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** Free text from the string: isolated, wrapping anywhere. */
function Said(props: { text: string }) {
  return <bdi class="dec-said">{props.text}</bdi>;
}

/** From 1 BTC an amount reads in BTC, its sats in the title: 21 million BTC still fits a phone. */
const BTC_FROM_MSAT = 100_000_000_000;

/** An amount in sats, the figure the result leads with. */
function Figure(props: { msat: number | null }) {
  return (
    <Show when={props.msat !== null} fallback={<p class="dec-figure">Any amount</p>}>
      <Show
        when={(props.msat ?? 0) < BTC_FROM_MSAT}
        fallback={
          <p class="dec-figure num" title={`${sats(props.msat ?? 0)} sats`}>
            {formatBtcShort(Math.floor((props.msat ?? 0) / 1000))}{" "}
            <span class="dec-figure__unit">BTC</span>
          </p>
        }
      >
        <p class="dec-figure num">
          {sats(props.msat ?? 0)} <span class="dec-figure__unit">sats</span>
        </p>
      </Show>
    </Show>
  );
}

/** "Expires in 42 min" or "Expired 3 days ago": only this text follows the clock. */
function Expiry(props: { at: number }) {
  const now = useNow();
  return (
    <span class={now() < props.at ? "dec-expiry" : "dec-expiry dec-expiry--past"}>
      {now() < props.at
        ? `Expires in ${formatRelative(now(), props.at, { suffix: false })}`
        : `Expired ${formatRelative(props.at, now())}`}
    </span>
  );
}

/** A node key: a link to this site's node page when the matching graph knows it, else the key. */
function Key(props: { k: KeyRef; names: Network | null; label: string }) {
  // The server's index cleaned it (docs/LIGHTNING.md "Search"): isolated and cut by CSS here.
  const name = () => (props.k.alias?.trim() ? props.k.alias : null);
  return (
    <Show
      when={props.k.known === true && props.names}
      fallback={<Hash value={props.k.key} copyLabel={`Copy the ${props.label}`} />}
    >
      {(n) => (
        <span class="dec-node">
          <a class="dec-node__name" href={onNetwork(n(), paths.lightningNode(props.k.key))}>
            <Show when={name()} fallback={<span class="dec-none">No name</span>}>
              {(a) => (
                <bdi class="dec-node__alias" title={a()}>
                  {a()}
                </bdi>
              )}
            </Show>
          </a>
          <span class="dec-node__key mono" title={props.k.key}>
            {truncateMiddle(props.k.key, 8, 6)}
          </span>
        </span>
      )}
    </Show>
  );
}

/** A short channel id, linked when the matching graph holds it as public. */
function Channel(props: { c: ChannelRef; names: Network | null }) {
  return (
    <Show
      when={props.c.known === true && props.names}
      fallback={
        <span class="dec-chan">
          <span class="dec-chan__id mono">
            <Scid id={props.c.scid} />
          </span>
          <CopyButton value={props.c.scid} label="Copy the channel ID" />
        </span>
      }
    >
      {(n) => (
        <a
          class="dec-chan__id mono"
          // The id whole: the line-break points would read as spaces.
          aria-label={props.c.scid}
          href={onNetwork(n(), paths.lightningChannel(props.c.scid))}
        >
          <Scid id={props.c.scid} />
        </a>
      )}
    </Show>
  );
}

/** A channel id that wraps after an "x", never inside one of its numbers. */
function Scid(props: { id: string }) {
  return (
    <For each={props.id.split("x")}>
      {(part, i) => (
        <>
          {i() > 0 ? "x" : ""}
          {i() > 0 ? <wbr /> : null}
          {part}
        </>
      )}
    </For>
  );
}

/** A URL as text, never a link, its host set apart, with a copy button. */
function Url(props: { url: string; host: string }) {
  const parts = () => splitHost(props.url, props.host);
  return (
    <span class="dec-url">
      <span class="dec-url__text mono">
        {parts()[0]}
        <strong class="dec-url__host">{parts()[1]}</strong>
        {parts()[2]}
      </span>
      <CopyButton value={props.url} label="Copy the URL" />
    </span>
  );
}

function Features(props: { list: Feature[] }) {
  return (
    <ul class="dec-chips">
      <For each={props.list}>
        {(f) => (
          <li class={f.name === null && f.required ? "dec-chip dec-chip--warn" : "dec-chip"}>
            {f.name ?? `Bit ${f.bit}`}
            {f.required ? "" : " (optional)"}
          </li>
        )}
      </For>
    </ul>
  );
}

function Paths(props: { paths: PathRef[]; names: Network | null }) {
  return (
    <ol class="dec-list">
      <For each={props.paths}>
        {(p) => (
          <li class="dec-hop">
            <Show when={p.node}>
              {(k) => <Key k={k()} names={props.names} label="entry node key" />}
            </Show>
            <Show when={p.channel}>
              {(c) => (
                <>
                  <Channel c={c()} names={props.names} />
                  <span class="dec-muted">end {(p.direction ?? 0) + 1}</span>
                </>
              )}
            </Show>
            <span class="dec-muted">
              blinded, <span class="num">{groupDigits(p.hops)} hops</span>
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

function Named(props: { names: Network | null }) {
  return (
    <Show when={props.names}>
      {(n) => <p class="dec-line">Names from this server's {NETWORK_NAMES[n()]} graph.</p>}
    </Show>
  );
}

function InvoiceBody(props: { d: Invoice }) {
  const d = () => props.d;
  return (
    <>
      <div class="dec-top">
        <Figure msat={d().amount_msat} />
        <Expiry at={d().created + d().expiry} />
      </div>
      <Facts>
        <Show
          when={d().description !== null}
          fallback={
            <Fact label="Description hash">
              <Hash value={d().description_hash ?? ""} copyLabel="Copy the description hash" />
            </Fact>
          }
        >
          <Fact label="Description" wide>
            <Said text={d().description ?? ""} />
          </Fact>
        </Show>
        <Fact label={d().payee_named ? "Payee" : "Payee, from the signature"}>
          <Key k={d().payee} names={d().names} label="payee key" />
        </Fact>
        <Fact label="Created">
          <TimeUtc time={d().created} />
        </Fact>
        <Fact label="Expires">
          <TimeUtc time={d().created + d().expiry} />
        </Fact>
        <Fact label="Payment hash">
          <Hash value={d().payment_hash} copyLabel="Copy the payment hash" />
        </Fact>
        <Fact label="Final time lock">
          <span class="num">{groupDigits(d().min_final_cltv)} blocks</span>
        </Fact>
        <Show when={d().fallbacks.length > 0}>
          <Fact label="On-chain fallback">
            <For each={d().fallbacks}>
              {(a) => <Hash value={a} copyLabel="Copy the fallback address" />}
            </For>
          </Fact>
        </Show>
        <Show when={d().features.length > 0}>
          <Fact label="Features" wide>
            <Features list={d().features} />
          </Fact>
        </Show>
      </Facts>
      <Show when={d().hints.length > 0}>
        <section class="dec-section" aria-label="Route hints">
          <h3>Route hints</h3>
          <Named names={d().names} />
          <For each={d().hints}>
            {(hint) => (
              <ol class="dec-list dec-hops">
                <For each={hint}>
                  {(h) => (
                    <li class="dec-hop">
                      <Key k={h.node} names={d().names} label="hop's node key" />
                      <Channel c={h.channel} names={d().names} />
                      <span class="dec-muted">
                        <span class="num">{groupDigits(h.fee_ppm)} ppm</span> +{" "}
                        <span class="num">{groupDigits(h.base_fee_msat)} msat</span>,{" "}
                        <span class="num">{groupDigits(h.cltv_delta)} blocks</span>
                      </span>
                    </li>
                  )}
                </For>
              </ol>
            )}
          </For>
        </section>
      </Show>
    </>
  );
}

function quantity(q: "one" | "any" | number | null): string {
  if (q === null || q === "one") return "One";
  if (q === "any") return "Any number";
  return `Up to ${groupDigits(q)}`;
}

const isCurrency = (p: Offer["amount"]) => p !== null && "currency" in p;

function OfferBody(props: { d: Offer }) {
  const d = () => props.d;
  const amount = () => d().amount;
  return (
    <>
      <div class="dec-top">
        <Show when={amount()} fallback={<p class="dec-figure">Any amount</p>}>
          {(a) => {
            const p = a();
            return "msat" in p ? (
              <Figure msat={p.msat} />
            ) : (
              <p class="dec-figure num">
                {groupDigits(p.amount)} <span class="dec-figure__unit">{p.currency}</span>
              </p>
            );
          }}
        </Show>
        <Show when={d().expires}>{(at) => <Expiry at={at()} />}</Show>
      </div>
      <Facts>
        <Show when={d().description}>
          {(t) => (
            <Fact label="Description" wide>
              <Said text={t()} />
            </Fact>
          )}
        </Show>
        <Show when={d().issuer}>
          {(t) => (
            <Fact label="Issuer" wide>
              <Said text={t()} />
            </Fact>
          )}
        </Show>
        <Fact label="Items">{quantity(d().quantity)}</Fact>
        <Show when={d().signing_key}>
          {(k) => (
            <Fact label="Signing key">
              <Key k={k()} names={d().names} label="signing key" />
            </Fact>
          )}
        </Show>
        <Show when={d().expires}>
          {(at) => (
            <Fact label="Expires">
              <TimeUtc time={at()} />
            </Fact>
          )}
        </Show>
        <Show when={d().chains.length > 1 || d().network === null}>
          <Fact label="Chains" wide>
            <For each={d().chains}>{(c) => <Hash value={c} copy={false} />}</For>
          </Fact>
        </Show>
        <Show when={d().features.length > 0}>
          <Fact label="Features" wide>
            <Features list={d().features} />
          </Fact>
        </Show>
      </Facts>
      <Show when={d().paths.length > 0}>
        <section class="dec-section" aria-label="Blinded paths">
          <h3>Blinded paths</h3>
          <Named names={d().names} />
          <Paths paths={d().paths} names={d().names} />
        </section>
      </Show>
      <Show when={isCurrency(amount())}>
        <More label="About the amount">
          <p>A currency amount is in its smallest unit: cents for USD.</p>
        </More>
      </Show>
    </>
  );
}

function RefundBody(props: { d: Refund }) {
  const d = () => props.d;
  return (
    <>
      <div class="dec-top">
        <Figure msat={d().amount_msat} />
        <Show when={d().expires}>{(at) => <Expiry at={at()} />}</Show>
      </div>
      <Facts>
        <Fact label="Description" wide>
          <Said text={d().description} />
        </Fact>
        <Show when={d().issuer}>
          {(t) => (
            <Fact label="Issuer" wide>
              <Said text={t()} />
            </Fact>
          )}
        </Show>
        <Show when={d().payer_note}>
          {(t) => (
            <Fact label="Payer's note" wide>
              <Said text={t()} />
            </Fact>
          )}
        </Show>
        <Fact label="Items">{groupDigits(d().quantity ?? 1)}</Fact>
        <Fact label="Payer key">
          <Hash value={d().payer_key} copyLabel="Copy the payer key" />
        </Fact>
      </Facts>
      <Show when={d().paths.length > 0}>
        <section class="dec-section" aria-label="Blinded paths">
          <h3>Blinded paths</h3>
          <Paths paths={d().paths} names={d().names} />
        </section>
      </Show>
    </>
  );
}

function LnurlBody(props: { d: Lnurl; current: () => boolean }) {
  const d = () => props.d;
  return (
    <>
      <p class="dec-figure dec-figure--text">
        <strong>{d().host}</strong>
      </p>
      <Facts>
        <Fact label="URL" wide>
          <Url url={d().url} host={d().host} />
        </Fact>
        <Show when={d().k1}>
          {(k) => (
            <Fact label="k1">
              <Hash value={k()} copyLabel="Copy k1" />
            </Fact>
          )}
        </Show>
      </Facts>
      <Show when={props.current()}>
        <FromService d={d()} />
      </Show>
    </>
  );
}

/**
 * What the service a decoded LNURL or Lightning address names says of itself: one GET from this
 * browser (`service.ts`), never for a login link and never its callback.
 */
function FromService(props: { d: Decoded }) {
  const p = () => plan(props.d);
  const host = () => {
    const x = p();
    return x !== null && "ask" in x ? x.host : "";
  };
  const [answer] = createRequest(
    () => {
      const x = p();
      return x !== null && "ask" in x ? x.ask : false;
    },
    (url, signal) => ask(url, signal),
  );
  return (
    <Show when={p()}>
      {(x) => (
        <section class="dec-section" aria-label="From the service">
          <h3>From the service</h3>
          <Switch>
            <Match when={"skip" in x()}>
              <p class="dec-line">Not asked: only public HTTPS services are.</p>
            </Match>
            <Match when={answer.state === "errored"}>
              <Show
                when={answer.error instanceof AskError && answer.error.why === "timeout"}
                fallback={
                  <>
                    <p class="dec-line">Could not ask {host()}</p>
                    <More label="Why">
                      <p>
                        A service that does not let other websites ask it looks the same here as one
                        that is down.
                      </p>
                    </More>
                  </>
                }
              >
                <p class="dec-line">No answer from {host()} in time</p>
              </Show>
            </Match>
            <Match when={answer.loading || answer.latest === undefined}>
              <p class="dec-line" role="status">
                Asking {host()}
              </p>
            </Match>
            <Match when={answer.latest !== undefined}>
              <ServiceFacts a={read(answer.latest, host())} />
            </Match>
          </Switch>
        </section>
      )}
    </Show>
  );
}

/** The service's answer, each figure only when it gave it. Its words are text, never markup. */
function ServiceFacts(props: { a: Answer }) {
  const a = () => props.a;
  const range = () => {
    const { min, max } = a();
    if (min === undefined || max === undefined) return undefined;
    return min === max ? [max] : [min, max];
  };
  return (
    <Switch>
      <Match when={a().error !== undefined}>
        <p class="dec-line">
          Refused: <bdi class="dec-said dec-said--inline">{a().error}</bdi>
        </p>
      </Match>
      <Match when={a().tag === undefined}>
        <p class="dec-line">Not an answer this page reads.</p>
      </Match>
      <Match when={a().tag}>
        {(tag) => (
          <Facts>
            <Fact label="Kind">{TAG_NAMES[tag()]}</Fact>
            <Show when={range()}>
              {(r) => (
                <Fact label={tag() === "withdrawRequest" ? "Gives" : "Takes"}>
                  <For each={r()}>
                    {(m, i) => (
                      <>
                        {i() > 0 ? " – " : ""}
                        <span class="num">
                          {sats(m)}
                          {i() === r().length - 1 ? " sats" : ""}
                        </span>
                      </>
                    )}
                  </For>
                </Fact>
              )}
            </Show>
            <Show when={a().description}>
              {(t) => (
                <Fact label="Description" wide>
                  <Said text={t()} />
                </Fact>
              )}
            </Show>
            <Show when={a().longDescription}>
              {(t) => (
                <Fact label="Long description" wide>
                  <Said text={t()} />
                </Fact>
              )}
            </Show>
            <Show when={a().identifier}>
              {(t) => (
                <Fact label="Identifier">
                  <Said text={t()} />
                </Fact>
              )}
            </Show>
            <Show when={a().comment}>
              {(c) => (
                <Fact label="Comment">
                  <span class="num">up to {groupDigits(c())} characters</span>
                </Fact>
              )}
            </Show>
            <Show when={a().callbackHost}>
              {(h) => (
                <Fact label="Next step goes to">
                  <strong class="dec-url__host">{h()}</strong>
                  <Show when={a().otherHost}>
                    {" "}
                    <span class="dec-chip dec-chip--warn">Other host</span>
                  </Show>
                </Fact>
              )}
            </Show>
            <Show when={a().uri}>
              {(u) => (
                <Fact label="Node" wide>
                  <span class="dec-url">
                    <span class="dec-url__text mono">{u()}</span>
                    <CopyButton value={u()} label="Copy the node URI" />
                  </span>
                </Fact>
              )}
            </Show>
          </Facts>
        )}
      </Match>
    </Switch>
  );
}

function BarkBody(props: { d: Bark }) {
  const d = () => props.d;
  return (
    <Facts>
      <Fact label="Server">
        <Hash value={d().ark_id} copyLabel="Copy the server ID" />
      </Fact>
      <Fact label="Policy">{d().policy}</Fact>
      <Show when={d().user_key}>
        {(k) => (
          <Fact label="Owner key">
            <Hash value={k()} copyLabel="Copy the owner key" />
          </Fact>
        )}
      </Show>
      <Fact label="Delivery" wide>
        <ul class="dec-chips">
          <For each={d().delivery}>
            {(x) => (
              <li class="dec-chip">
                {x.kind === "mailbox"
                  ? "Mailbox"
                  : x.kind === "server"
                    ? "Server"
                    : `Type ${x.type ?? "?"}`}
              </li>
            )}
          </For>
        </ul>
      </Fact>
    </Facts>
  );
}
