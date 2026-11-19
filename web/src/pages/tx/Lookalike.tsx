// A lookalike address the reader arrived with from an address page's flagged row (docs/FRONTEND.md
// "Lookalike addresses"). This page runs no rule of its own: it shows only what it was handed and
// could check against this transaction (lib/lookalike.ts, `readHandover`).
import { For, Show } from "solid-js";
import { CopyButton } from "../../components/CopyButton";
import { Link } from "../../components/Link";
import { agreement, CautionIcon, LookalikePair, Marked } from "../../components/Lookalike";
import { groupDigits } from "../../lib/format";
import type { Handover, Lookalike } from "../../lib/lookalike";
import { paths } from "../../lib/network";

/** Pairs shown whole in the notice; the rest are counted, and marked where they appear. */
const SHOWN_PAIRS = 2;

/** The lookalikes by the address in this transaction, for marking it where it appears. */
export const marksOf = (h: Handover | undefined): ReadonlyMap<string, Lookalike> | undefined =>
  h === undefined ? undefined : new Map(h.found.map((l) => [l.here, l]));

/** The notice's heading, which screen readers also hear once, politely. */
export const lookalikeTitle = (h: Handover) =>
  h.found.some((l) => l.own)
    ? "Someone may be imitating the address you came from"
    : "This transaction names a lookalike address";

/** What the addresses do, never why: a chance match looks the same. */
export function lookalikeCount(h: Handover) {
  const n = h.found.length;
  const own = h.found.some((l) => l.own);
  const others = h.found.some((l) => !l.own);
  const what =
    n === 1 ? "an address that starts and ends" : `${groupDigits(n)} addresses that start and end`;
  const like = own
    ? others
      ? "like the address you came from, or like another address in its history"
      : "like the address you came from"
    : "like another address in the history you came from";
  return `This transaction names ${what} ${like}.`;
}

/** Said of the address the lookalike resembles, in a pair's label and the inspector. */
const likeLabel = (l: Lookalike) =>
  l.own ? "The address you came from" : "Elsewhere in its history";

/** The caution at the top of the page, in the address page's words and look. */
export function LookalikeNotice(props: { h: Handover }) {
  const more = () => props.h.found.length - SHOWN_PAIRS;
  return (
    <section class="tx-lookalike" aria-labelledby="tx-lookalike-title">
      <CautionIcon />
      <div class="tx-lookalike__body">
        <h2 class="tx-lookalike__title" id="tx-lookalike-title">
          {lookalikeTitle(props.h)}
        </h2>
        <p>{lookalikeCount(props.h)}</p>
        <For each={props.h.found.slice(0, SHOWN_PAIRS)}>
          {(l) => <LookalikePair l={l} here="In this transaction" like={likeLabel(l)} />}
        </For>
        <Show when={more() > 0}>
          <p class="tx-lookalike__quiet">
            {`And ${groupDigits(more())} more lookalike ${more() === 1 ? "address" : "addresses"} in this transaction.`}
          </p>
        </Show>
        <p class="tx-lookalike__quiet">
          It may be address poisoning: an address made to start and end like one you use, so that it
          gets copied by mistake. Check every character, not just the ends, before you copy an
          address from this transaction. Each lookalike is marked where it appears below.
          <Show when={props.h.more}> The history had more than are marked here.</Show>
        </p>
        <p class="tx-lookalike__quiet">
          Shown because you came here from that address's history: this page does not look for
          lookalikes itself.
        </p>
      </div>
    </section>
  );
}

/** A flow card's mark: the caution triangle and a word, with the card's caution rule (CSS). */
export function LookalikeTag() {
  return (
    <span class="tx-lookalike-tag">
      <CautionIcon />
      Lookalike
      <span class="visually-hidden"> address: check every character</span>
    </span>
  );
}

/**
 * The inspector's address when it is a lookalike: whole, its agreeing ends marked, still a link and
 * copyable, then what it resembles. The copy button says what it copies.
 */
export function MarkedAddress(props: { l: Lookalike }) {
  const marks = () => ({ prefix: props.l.prefix, head: props.l.head, tail: props.l.tail });
  return (
    <>
      <span class="tx-lookalike-addr">
        <Link class="tap-line" href={paths.address(props.l.here)}>
          <Marked address={props.l.here} {...marks()} />
        </Link>
        <CopyButton value={props.l.here} label="Copy lookalike address" />
      </span>
      <span class="tx-lookalike-note">
        <CautionIcon />
        <span class="tx-lookalike-note__body">
          <span>
            {props.l.own
              ? "Lookalike: it starts and ends like the address you came from."
              : "Lookalike: it starts and ends like another address in the history you came from."}
          </span>
          <span class="tx-lookalike-note__like">
            <span class="lookalike__label">{likeLabel(props.l)}</span>
            <Marked address={props.l.like} {...marks()} />
          </span>
          <span class="visually-hidden">{agreement(props.l)}</span>
          <span>Check every character, not just the ends, before you copy it.</span>
        </span>
      </span>
    </>
  );
}
