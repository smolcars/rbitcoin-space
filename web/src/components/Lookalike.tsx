// A lookalike address's pieces, shared by the address page, which finds them, and the transaction
// page, which marks one the reader arrived with (docs/FRONTEND.md "Lookalike addresses").
import type { Lookalike } from "../lib/lookalike";
import "./Lookalike.css";

/** The longest agreeing end kept on one line: more would not fit a 320 px screen. */
export const KEPT_WHOLE = 12;

/** The caution triangle. Decorative: the words beside it say what it means. */
export function CautionIcon() {
  return (
    <svg class="lookalike__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.75 14.75 13.75H1.25Z" />
      <path d="M8 6.25v3.5M8 11.75v.25" />
    </svg>
  );
}

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

/** Where two addresses agree, said for screen readers, which do not hear the marks. */
export const agreement = (l: Lookalike) =>
  `They agree on the first ${l.head} and last ${l.tail} characters after ${l.here.slice(0, l.prefix)}, and differ in between.`;

/** The two addresses one above the other, labelled, whole, their agreeing ends marked. */
export function LookalikePair(props: { l: Lookalike; here: string; like: string }) {
  const marks = () => ({ prefix: props.l.prefix, head: props.l.head, tail: props.l.tail });
  return (
    <div class="lookalike__pair">
      <span class="lookalike__label">{props.here}</span>
      <Marked address={props.l.here} {...marks()} />
      <span class="lookalike__label">{props.like}</span>
      <Marked address={props.l.like} {...marks()} />
      <span class="visually-hidden">{agreement(props.l)}</span>
    </div>
  );
}
