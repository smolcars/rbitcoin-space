import { For, Show } from "solid-js";
import { groupDigits } from "../../lib/format";
import type { Lookalike } from "./lookalike";

/** The id of a row's warning, which the page's notice takes the reader to. */
export const lookalikeId = (txid: string) => `lookalike-${txid}`;

/** The longest agreeing end kept on one line: more would not fit a 320 px screen. */
export const KEPT_WHOLE = 12;

/** Pairs shown under one row; a poisoning transaction can name hundreds of addresses. */
export const SHOWN_PAIRS = 2;

/**
 * An address cut where it agrees with the one it looks like: the type prefix, the agreeing head,
 * the middle that differs, the agreeing tail. Text only: the address is chain data.
 */
export function Marked(props: { address: string; prefix: number; head: number; tail: number }) {
  const a = () => props.address;
  const headEnd = () => Math.min(props.prefix + props.head, a().length - props.tail);
  // A short agreeing end stays on one line; one too long for a narrow screen may break.
  const agree = (text: string) => (
    <span
      class={`lookalike__same lookalike__agree${text.length > KEPT_WHOLE ? " lookalike__agree--long" : ""}`}
    >
      {text}
    </span>
  );
  return (
    <span class="lookalike__address">
      <span class="lookalike__same">{a().slice(0, props.prefix)}</span>
      {agree(a().slice(props.prefix, headEnd()))}
      <span class="lookalike__differ">{a().slice(headEnd(), a().length - props.tail)}</span>
      {agree(a().slice(a().length - props.tail))}
    </span>
  );
}

function Pair(props: { l: Lookalike }) {
  const marks = () => ({ prefix: props.l.prefix, head: props.l.head, tail: props.l.tail });
  return (
    <div class="lookalike__pair">
      <span class="lookalike__label">In this transaction</span>
      <Marked address={props.l.here} {...marks()} />
      <span class="lookalike__label">
        {props.l.own ? "This page's address" : "Elsewhere in this history"}
      </span>
      <Marked address={props.l.like} {...marks()} />
      <span class="visually-hidden">
        {`They agree on the first ${props.l.head} and last ${props.l.tail} characters after ${props.l.here.slice(0, props.l.prefix)}, and differ in between.`}
      </span>
    </div>
  );
}

/** The warning under a history row whose transaction names a lookalike address. */
export function LookalikeWarning(props: { txid: string; found: readonly Lookalike[] }) {
  const own = () => props.found.some((l) => l.own);
  const more = () => props.found.length - SHOWN_PAIRS;
  return (
    // The page's notice moves focus here (`lookalikeId`), so it can be focused but is no tab stop.
    <div
      class="lookalike"
      id={lookalikeId(props.txid)}
      tabindex="-1"
      role="note"
      aria-label="Lookalike address"
    >
      <svg class="lookalike__icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.75 14.75 13.75H1.25Z" />
        <path d="M8 6.25v3.5M8 11.75v.25" />
      </svg>
      <div class="lookalike__body">
        <p class="lookalike__title">
          {own()
            ? "An address here looks like this page's address"
            : "An address here looks like another in this history"}
        </p>
        <For each={props.found.slice(0, SHOWN_PAIRS)}>{(l) => <Pair l={l} />}</For>
        <Show when={more() > 0}>
          <p class="lookalike__more">
            {`And ${groupDigits(more())} more lookalike ${more() === 1 ? "address" : "addresses"} in this transaction.`}
          </p>
        </Show>
        <p class="lookalike__text">
          This may be address poisoning: an address made to start and end like one you use, so that
          it gets copied from this list by mistake. Check every character, not just the ends, before
          you copy an address from this history.
        </p>
      </div>
    </div>
  );
}
