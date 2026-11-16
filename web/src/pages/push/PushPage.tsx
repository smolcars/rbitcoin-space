// Broadcast a transaction (docs/FRONTEND.md "Broadcast"). The pasted hex stays in this page: in no
// URL, sent in a POST body to be checked, and broadcast only when the reader presses the button.
import { createEffect, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount, Sats } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { ErrorState, Loading } from "../../components/States";
import { ApiError, createApi, createRequest, postApp } from "../../lib/api";
import { loadConfig } from "../../lib/config";
import type { Outspend } from "../../lib/esplora";
import { formatSize, groupDigits, MISSING } from "../../lib/format";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { Flow, type Selection } from "../tx/Flow";
import { Inspector } from "../tx/Inspector";
import { isCoinbase, totalOut, vsize } from "../tx/tx";
import {
  broadcast,
  type Checked,
  needsSecondThought,
  rateOf,
  readChecked,
  readPasted,
  refusal,
  warnings,
} from "./push";
import "../tx/TransactionPage.css";
import "./Push.css";

/** Typing waits for a pause before the check; a paste is checked at once. */
const TYPING_MS = 400;

export default function PushPage() {
  usePageTitle(() => "Broadcast");
  const network = useNetwork();
  const [text, setText] = createSignal("");
  const [asked, setAsked] = createSignal("");
  let pasting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const pasted = () => readPasted(asked());
  const bad = () => {
    const p = pasted();
    return p.kind === "bad" ? p.why : undefined;
  };
  const current = () => {
    const p = readPasted(text());
    return p.kind === "hex" ? p.hex : undefined;
  };

  const [enabled, setEnabled] = createSignal<boolean | undefined>(undefined);
  void loadConfig().then((c) => setEnabled(c?.broadcast ?? false));

  const [checked, { refetch }] = createRequest(
    () => {
      const p = pasted();
      return p.kind === "hex" ? `${network()}:${p.hex}` : false;
    },
    async (key, signal) => {
      const hex = key.slice(key.indexOf(":") + 1);
      const v = await postApp<unknown>(network(), "/tx/check", hex, { signal });
      const c = readChecked(v);
      if (c === null) throw new ApiError(0, "The answer could not be read.");
      return { hex, ...c };
    },
  );

  const onInput = (value: string) => {
    setText(value);
    clearTimeout(timer);
    timer = setTimeout(() => setAsked(value), pasting ? 0 : TYPING_MS);
    pasting = false;
  };

  return (
    <div class="wrap push">
      <h1>Broadcast a transaction</h1>
      <textarea
        class="push__input mono"
        name="hex"
        rows="4"
        aria-label="Signed transaction in hex"
        placeholder="Paste a signed transaction in hex"
        autocomplete="off"
        spellcheck={false}
        autocapitalize="off"
        value={text()}
        onPaste={() => {
          pasting = true;
        }}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <Show when={enabled() === false}>
        <p class="push__line">This server does not broadcast. It can still read a transaction.</p>
      </Show>
      <Switch>
        <Match when={bad()}>{(why) => <p class="push__line">{why()}</p>}</Match>
        <Match when={pasted().kind === "empty"}>{null}</Match>
        <Match when={checked.state === "errored"}>
          <ErrorState title="Could not read it" error={checked.error} retry={refetch} />
        </Match>
        {/* Never the last answer beside a box that holds another transaction. */}
        <Match when={checked.loading || checked.latest?.hex !== current()}>
          <Loading label="Reading" />
        </Match>
        <Match when={checked.latest}>
          {(c) => <Result c={c()} hex={c().hex} enabled={enabled() === true} />}
        </Match>
      </Switch>
    </div>
  );
}

function Result(props: { c: Checked; hex: string; enabled: boolean }) {
  const network = useNetwork();
  const tx = () => props.c.tx;
  // The next block's rate, to tell a fee rate that is far too high. Absent with the engine off.
  const [fees] = createApi<{ fastestFee?: unknown }>(() => "/v1/fees/recommended");
  const next = () => {
    const f = fees.state === "errored" ? undefined : fees.latest?.fastestFee;
    return typeof f === "number" && f > 0 ? f : undefined;
  };
  const warn = () => warnings(tx(), next());
  const rate = () => rateOf(tx());
  const v = () => vsize(tx());
  const [sending, setSending] = createSignal(false);
  /** The txid the node accepted. */
  const [sent, setSent] = createSignal<string>();
  // Nothing can spend a transaction the node does not have; one it has may be spent already.
  const [spends] = createApi<Outspend[]>(() =>
    props.c.known ? `/tx/${tx().txid}/outspends` : false,
  );
  const outspends = (): Outspend[] | null | undefined => {
    if (!props.c.known) return tx().vout.map(() => ({ spent: false }));
    return spends.state === "errored" ? null : spends.latest;
  };
  /** Why the last press did not send it. */
  const [why, setWhy] = createSignal<string>();
  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  // A new transaction in the box starts afresh.
  createEffect(
    () => props.hex,
    () => {
      controller?.abort();
      setSending(false);
      setSent(undefined);
      setWhy(undefined);
    },
  );
  const send = () => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    setSending(true);
    setWhy(undefined);
    broadcast(network(), props.hex, signal).then(
      (txid) => {
        setSending(false);
        setSent(txid);
      },
      (e: unknown) => {
        if (signal.aborted) return;
        setSending(false);
        setWhy(refusal(e));
      },
    );
  };

  const [selected, setSelected] = createSignal<Selection | null>(null);
  let inspectorHeading: HTMLHeadingElement | undefined;
  const select = (s: Selection) => {
    const cur = selected();
    if (cur && cur.side === s.side && cur.index === s.index) {
      setSelected(null);
      return;
    }
    setSelected(s);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      inspectorHeading?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      inspectorHeading?.focus({ preventScroll: true });
    });
  };

  return (
    <article class="push-result" aria-label="Transaction">
      <div class="push-result__id">
        <Hash value={tx().txid} copyLabel="Copy the transaction ID" />
      </div>
      <dl class="tx-summary panel" aria-label="Summary">
        <div class="tx-summary__item">
          <dt>Fee</dt>
          <dd>
            {/* A fee of zero is a fee: only an unknown one falls back. */}
            <Show
              when={rate() !== undefined}
              fallback={
                <>
                  <span class="tx-summary__value">{MISSING}</span>
                  <span class="tx-summary__sub">
                    {isCoinbase(tx())
                      ? "A coinbase pays no fee"
                      : warn().missing > 0
                        ? "Inputs not found"
                        : warn().unchecked > 0
                          ? "Inputs not all looked up"
                          : "Pays out more than it spends"}
                  </span>
                </>
              }
            >
              <>
                <span class="tx-summary__value">
                  <FeeRate rate={rate() ?? 0} />
                </span>
                <span class="tx-summary__sub">
                  <Sats sats={tx().fee ?? 0} />
                </span>
              </>
            </Show>
          </dd>
        </div>
        <div class="tx-summary__item tx-summary__item--amount">
          <dt>Amount</dt>
          <dd>
            <span class="tx-summary__value">
              <Amount sats={totalOut(tx())} />
            </span>
            <span class="tx-summary__sub">
              {`To ${groupDigits(tx().vout.length)} output${tx().vout.length === 1 ? "" : "s"}`}
            </span>
          </dd>
        </div>
        <div class="tx-summary__item">
          <dt>Size</dt>
          <dd>
            <span class="tx-summary__value num">
              {v() === undefined ? MISSING : formatSize(v() ?? 0)}
            </span>
            <span class="tx-summary__sub num">{formatSize(tx().weight ?? 0, "WU")}</span>
          </dd>
        </div>
      </dl>

      <Show when={props.c.known}>
        {(k) => (
          <Notice
            tone="positive"
            title={k().confirmed ? "Already confirmed" : "Already in the mempool"}
          >
            <p>
              <Show
                when={k().confirmed && k().block_height !== undefined}
                fallback={`The ${NETWORK_NAMES[network()]} node has it. `}
              >
                In block {groupDigits(k().block_height ?? 0)}.{" "}
              </Show>
              <Link href={paths.tx(tx().txid)}>Open its page</Link>
            </p>
          </Notice>
        )}
      </Show>
      <Show
        when={!props.c.known && (warn().rate !== null || warn().burn > 0 || warn().missing > 0)}
      >
        <Notice tone="caution" title="Check before you send">
          <div class="push-warnings">
            <Show when={warn().rate}>
              {(r) => (
                <p>
                  It pays <FeeRate rate={r()} />
                  <Show when={next()} fallback=", far more than any block needs">
                    {(n) => (
                      <>
                        , {groupDigits(Math.floor(r() / n()))} times the next block's{" "}
                        <FeeRate rate={n()} />
                      </>
                    )}
                  </Show>
                  .
                </p>
              )}
            </Show>
            <Show when={warn().burn > 0}>
              <p>
                It burns <Sats sats={warn().burn} /> in outputs nobody can spend.
              </p>
            </Show>
            <Show when={warn().missing > 0}>
              <p>
                {warn().missing === 1
                  ? "One input spends"
                  : `${groupDigits(warn().missing)} inputs spend`}{" "}
                coins the {NETWORK_NAMES[network()]} node does not have: already spent, or on
                another network.
              </p>
            </Show>
          </div>
        </Notice>
      </Show>

      <Show when={props.enabled && !props.c.known}>
        <div class="push-send" aria-live="polite">
          <Show
            when={sent()}
            fallback={
              <>
                <button
                  class={
                    needsSecondThought(warn())
                      ? "btn push-send__go"
                      : "btn btn--accent push-send__go"
                  }
                  type="button"
                  disabled={sending()}
                  onClick={send}
                >
                  {sending()
                    ? "Sending"
                    : needsSecondThought(warn())
                      ? "Broadcast anyway"
                      : "Broadcast"}
                </button>
                <Show when={why()}>{(w) => <p class="push-send__why">{w()}</p>}</Show>
              </>
            }
          >
            {(txid) => (
              <Notice tone="positive" title="Sent">
                <p>
                  <Link href={paths.tx(txid())}>Follow it on its page</Link>
                </p>
              </Notice>
            )}
          </Show>
        </div>
      </Show>

      <section class="push-flow" aria-labelledby="push-flow-title">
        <SectionHeader title="Inputs and outputs" id="push-flow-title">
          <span class="num">
            {groupDigits(tx().vin?.length ?? 0)} input{tx().vin?.length === 1 ? "" : "s"},{" "}
            {groupDigits(tx().vout.length)} output{tx().vout.length === 1 ? "" : "s"}
          </span>
        </SectionHeader>
        <Flow tx={tx()} outspends={outspends} selected={selected()} onSelect={select} />
        <Show when={selected()} keyed>
          {(s) => (
            <Inspector
              tx={tx()}
              selected={s}
              outspends={outspends}
              onClose={() => setSelected(null)}
              ref={(el) => {
                inspectorHeading = el;
              }}
            />
          )}
        </Show>
      </section>
    </article>
  );
}

function Notice(props: { tone: "positive" | "caution"; title: string; children: JSX.Element }) {
  return (
    <div
      class={`tx-notice push-notice--${props.tone}`}
      role={props.tone === "caution" ? "note" : undefined}
    >
      <svg class="tx-icon" viewBox="0 0 16 16" aria-hidden="true">
        {props.tone === "positive" ? (
          <path d="M4.5 8.5l2.4 2.4L11.8 5.6" />
        ) : (
          <circle cx="8" cy="8" r="5.5" stroke-dasharray="2.6 2" />
        )}
      </svg>
      <div class="tx-notice__body">
        <p class="tx-notice__title">{props.title}</p>
        {props.children}
      </div>
    </div>
  );
}
