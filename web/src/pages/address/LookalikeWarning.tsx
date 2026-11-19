import { For, Show } from "solid-js";
import { groupDigits } from "../../lib/format";
import { CautionIcon, LookalikePair } from "../../components/Lookalike";
import type { Lookalike } from "./lookalike";

/** The id of a row's warning, which the page's notice takes the reader to. */
export const lookalikeId = (txid: string) => `lookalike-${txid}`;

/** Pairs shown under one row; a poisoning transaction can name hundreds of addresses. */
export const SHOWN_PAIRS = 2;

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
      <CautionIcon />
      <div class="lookalike__body">
        <p class="lookalike__title">
          {own()
            ? "An address here looks like this page's address"
            : "An address here looks like another in this history"}
        </p>
        <For each={props.found.slice(0, SHOWN_PAIRS)}>
          {(l) => (
            <LookalikePair
              l={l}
              here="In this transaction"
              like={l.own ? "This page's address" : "Elsewhere in this history"}
            />
          )}
        </For>
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
