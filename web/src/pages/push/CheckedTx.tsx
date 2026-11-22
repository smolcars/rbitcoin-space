// A checked transaction as the broadcast page and the decoder show it (docs/FRONTEND.md "Broadcast").
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount, Sats } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { createApi } from "../../lib/api";
import type { Outspend } from "../../lib/esplora";
import { formatSize, groupDigits, MISSING } from "../../lib/format";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { returnFocus } from "../tx/flash";
import { Flow, type Selection } from "../tx/Flow";
import { Inspector } from "../tx/Inspector";
import { isCoinbase, totalOut, vsize } from "../tx/tx";
import { checkPrivacy } from "../../lib/privacy";
import { UnsentPrivacy } from "../tx/Privacy";
import { cardMarks, shownFindings } from "../tx/privacytext";
import { markAttempted, wasAttempted } from "./attempted";
import {
  broadcast,
  type Checked,
  needsSecondThought,
  rateOf,
  refusal,
  UNREADABLE,
  warnings,
} from "./push";
import "../tx/TransactionPage.css";
import "./Push.css";

/**
 * What a checked transaction does: summary, warnings, inputs and outputs, and with `enabled` the
 * broadcast button. The broadcast page and the decoder both draw it.
 */
export function CheckedTx(props: {
  c: Checked;
  hex: string;
  enabled: boolean;
  /** Where the page's own action goes when it has no button here (the decoder's link): after the
   * notices, so a reader reaches what sending would show before the way to send it. */
  action?: JSX.Element;
}) {
  const network = useNetwork();
  const tx = () => props.c.tx;
  // The next block's rate, to tell a fee rate that is far too high. Absent with the engine off.
  const [fees] = createApi<{ fastestFee?: unknown }>(() => "/v1/fees/recommended", {
    cached: true,
  });
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
  // Pressed on this page at any time, in this view or one before it (attempted.ts): then it is
  // never again said to be unsent. Read again for each transaction and after each press.
  const [presses, setPresses] = createSignal(0);
  const attempted = () => presses() >= 0 && wasAttempted(network(), tx().txid);
  const state = () => (sent() === undefined ? (attempted() ? "attempted" : "unsent") : "sent");
  // What sending it would show an observer: said while it can still change, so not for one the
  // node already has, nor for a coinbase, which has no sender.
  const privacy = createMemo(() => checkPrivacy(tx()));
  const shown = () => !props.c.known && !privacy().coinbase;
  // Sent from this page, it is what the transaction page shows: nothing for an unsent one.
  const privacyMarks = createMemo(() =>
    shown() ? cardMarks(shownFindings(privacy(), state() === "unsent")) : undefined,
  );
  // The node has it: it said so when checked, or it took it from this page just now. A press that
  // got no answer, or a refusal, says nothing of the kind.
  const known = () => props.c.known !== null || sent() !== undefined;
  // Nothing can spend a transaction the node does not have; one it has may be spent already.
  const [spends] = createApi<Outspend[]>(() => (known() ? `/tx/${tx().txid}/outspends` : false), {
    cached: true,
  });
  const outspends = (): Outspend[] | null | undefined => {
    if (!known()) return undefined;
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
    markAttempted(network(), tx().txid);
    setPresses((n) => n + 1);
    setWhy(undefined);
    broadcast(network(), props.hex, signal).then(
      (txid) => {
        if (signal.aborted) return;
        setSending(false);
        // Sent means the node took this transaction: a reply naming another is not that.
        if (txid === tx().txid) setSent(txid);
        else setWhy(UNREADABLE);
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
      // Its own button pressed again: closed like Close, the focus to that button (flash.ts).
      // At once, not a frame later: the button is here now, and a later opener is never taken.
      setSelected(null);
      returnFocus(s.side, s.index);
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

      <Show when={shown()}>
        <UnsentPrivacy report={privacy()} state={state()} />
      </Show>

      <Show when={props.action}>
        <div class="push-action">{props.action}</div>
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
        <Flow
          tx={tx()}
          outspends={outspends}
          selected={selected()}
          onSelect={select}
          marks={privacyMarks()}
          known={known()}
        />
        <Show when={selected()} keyed>
          {(s) => (
            <Inspector
              tx={tx()}
              selected={s}
              outspends={outspends}
              known={known()}
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
