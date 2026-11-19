import { Show } from "solid-js";
import "../../components/Button.css";
import { groupDigits } from "../../lib/format";
import type { LookalikeSummary } from "./lookalike";
import { CautionIcon, Marked } from "../../components/Lookalike";

/** The notice's heading, which is also what screen readers hear once when it first appears. */
export const noticeTitle = (s: LookalikeSummary) =>
  s.own === undefined
    ? "Lookalike addresses in this history"
    : "Someone may be imitating this address";

/** What the notice needs to know of the list it counts in. */
export interface Checked {
  /** Transactions loaded. */
  loaded: number;
  /** Whether the history could load more: it says so itself. */
  more: boolean;
  /**
   * Every transaction counted is confirmed, in a history that lists only those (a kept address's;
   * its unconfirmed ones are apart).
   */
  confirmedOnly: boolean;
}

/**
 * How many of the transactions checked name a lookalike, honest about how many were checked: the
 * pages loaded so far, unless the history has no more to load. It says what the addresses do
 * (start and end alike), never why: a chance match looks the same.
 */
export function noticeCount(s: LookalikeSummary, c: Checked) {
  const verb = s.txs === 1 ? "names" : "name";
  // Between two other addresses neither is known to be the copy, and both rows are counted.
  if (s.own === undefined) {
    return `${which(s, c)} ${verb} addresses that look like one another: one of each pair may have been made to imitate the other.`;
  }
  const like =
    s.ownTxs === s.txs
      ? "that starts and ends like this one"
      : "that starts and ends like this one, or like another address in this history";
  return `${which(s, c)} ${verb} an address ${like}.`;
}

/**
 * Which transactions: those loaded so far, or, once the history has no more to load, those in it.
 * Said of the history, whichever of its views is showing, not of the address: its totals are
 * another answer.
 */
function which(s: LookalikeSummary, c: Checked) {
  const kind = c.confirmedOnly ? "confirmed transaction" : "transaction";
  if (c.more) return `${groupDigits(s.txs)} of the ${groupDigits(c.loaded)} ${kind}s loaded so far`;
  if (c.loaded === 1) return `The only ${kind} in the history`;
  return `${groupDigits(s.txs)} of the ${groupDigits(c.loaded)} ${kind}s in the history`;
}

/**
 * The address page's warning, above its figures and outside its tabs, when the loaded history
 * names a lookalike address (lookalike.ts). The rows' own notes carry the full explanation.
 */
export function LookalikeNotice(props: {
  summary: LookalikeSummary;
  loaded: number;
  more: boolean;
  confirmedOnly: boolean;
  address: string;
  /** Takes the reader to the first transaction that names one. */
  onJump: () => void;
}) {
  return (
    <section class="address-poison" aria-labelledby="address-poison-title">
      <CautionIcon />
      <div class="address-poison__body">
        <h2 class="address-poison__title" id="address-poison-title">
          {noticeTitle(props.summary)}
        </h2>
        <p>{noticeCount(props.summary, props)}</p>
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
          <Show when={props.more}> Older transactions are checked as you load them.</Show>
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
