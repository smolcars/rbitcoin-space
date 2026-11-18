import { Show } from "solid-js";
import "../../components/Button.css";
import { groupDigits } from "../../lib/format";
import type { LookalikeSummary } from "./lookalike";
import { Marked } from "./LookalikeWarning";

/** The notice's heading, which is also what screen readers hear once when it first appears. */
export const noticeTitle = (s: LookalikeSummary) =>
  s.own === undefined
    ? "Lookalike addresses in this history"
    : "Someone may be imitating this address";

/**
 * How many of the transactions checked name a lookalike, honest about how many were checked: the
 * pages loaded so far, unless they are the whole history.
 */
export function noticeCount(s: LookalikeSummary, loaded: number, total: number | undefined) {
  const verb = s.txs === 1 ? "names" : "name";
  // Between two other addresses neither is known to be the copy, and both rows are counted.
  if (s.own === undefined) {
    return `${which(s, loaded, total)} ${verb} addresses that look like one another: one of each pair may have been made to imitate the other.`;
  }
  const like =
    s.ownTxs === s.txs
      ? "made to start and end like this one"
      : "made to start and end like this one, or like another address in this history";
  return `${which(s, loaded, total)} ${verb} an address ${like}.`;
}

/** Which transactions: those loaded so far, unless they are the whole history. */
function which(s: LookalikeSummary, loaded: number, total: number | undefined) {
  const whole = total !== undefined && loaded >= total;
  if (whole && total === 1) return "This address's only transaction";
  if (whole) return `${groupDigits(s.txs)} of this address's ${groupDigits(total)} transactions`;
  return `${groupDigits(s.txs)} of the ${groupDigits(loaded)} transactions loaded so far`;
}

/**
 * The address page's warning, above its figures and outside its tabs, when the loaded history
 * names a lookalike address (lookalike.ts). The rows' own notes carry the full explanation.
 */
export function LookalikeNotice(props: {
  summary: LookalikeSummary;
  loaded: number;
  total: number | undefined;
  address: string;
  /** Takes the reader to the first transaction that names one. */
  onJump: () => void;
}) {
  const whole = () => props.total !== undefined && props.loaded >= props.total;
  return (
    <section class="address-poison" aria-labelledby="address-poison-title">
      <svg class="lookalike__icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.75 14.75 13.75H1.25Z" />
        <path d="M8 6.25v3.5M8 11.75v.25" />
      </svg>
      <div class="address-poison__body">
        <h2 class="address-poison__title" id="address-poison-title">
          {noticeTitle(props.summary)}
        </h2>
        <p>{noticeCount(props.summary, props.loaded, props.total)}</p>
        {/* Whole, never shortened: a short form shows exactly the ends that agree. */}
        <Show when={props.summary.own}>
          {(l) => (
            <div class="lookalike__pair">
              <span class="lookalike__label">Lookalike</span>
              <Marked address={l().here} prefix={l().prefix} head={l().head} tail={l().tail} />
              <span class="lookalike__label">This address</span>
              <Marked address={props.address} prefix={l().prefix} head={l().head} tail={l().tail} />
            </div>
          )}
        </Show>
        <Show when={props.summary.ownAddresses > 1}>
          <p class="address-poison__more">
            {`And ${groupDigits(props.summary.ownAddresses - 1)} more like it.`}
          </p>
        </Show>
        <p class="address-poison__text">
          It may be address poisoning. Check every character, not just the ends, before you copy an
          address from this history.
          <Show when={!whole()}> Older transactions are checked as you load them.</Show>
        </p>
        <div>
          <button class="btn" type="button" onClick={() => props.onJump()}>
            {props.summary.txs === 1 ? "Go to the transaction" : "Go to the first of them"}
          </button>
        </div>
      </div>
    </section>
  );
}
