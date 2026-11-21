// The privacy check on the page (docs/FRONTEND.md "Privacy check"): its marks on the flow's cards,
// the list under the flow on the transaction page, and the notice on Broadcast and the decoder.
// The words are all in privacytext.ts; this file only lays them out, as text nodes.
import { createMemo, For, Show } from "solid-js";
import { More } from "../../components/More";
import type { PrivacyReport } from "../../lib/privacy";
import {
  CHECKS,
  isPartial,
  LIMITS,
  LIST_TITLE,
  type Mark,
  type Said,
  type Sentence,
  sayFinding,
  sayNothing,
  sayPartial,
  shownAddress,
  shownFindings,
  type Tone,
  UNSENT_CLOSING,
  UNSENT_TITLE,
} from "./privacytext";
import "./Privacy.css";

/** What an observer sees. A filled pupil where something is given away, an open one otherwise. */
export function Eye(props: { tone: Tone }) {
  return (
    <svg class={`pv-eye pv-eye--${props.tone}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 8c1.6-2.9 3.8-4.4 6.5-4.4s4.9 1.5 6.5 4.4c-1.6 2.9-3.8 4.4-6.5 4.4S3.1 10.9 1.5 8z" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  );
}

/**
 * A card's marks, at the end of its meta line, on a line of their own: the spent status arrives
 * after the card, and would otherwise push them to a second line and the flow down.
 */
export function CardMarks(props: { marks: readonly Mark[] | undefined }) {
  return (
    <Show when={(props.marks?.length ?? 0) > 0}>
      <span class="pv-tags">
        <For each={props.marks ?? []}>
          {(m) => (
            <span class={`pv-tag pv-tag--${m.tone}`}>
              <Eye tone={m.tone} />
              {m.text}
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}

/**
 * A sentence: its text, and each address as `shownAddress` gives it, hidden characters made
 * visible, shortened as the site shortens one, its title bounded.
 */
function Words(props: { s: Sentence }) {
  return (
    <For each={props.s}>
      {(piece) => {
        if (typeof piece === "string") return piece;
        const a = shownAddress(piece.address);
        return (
          <span class="hash">
            <span class="hash__text" title={a.title}>
              {a.short}
            </span>
          </span>
        );
      }}
    </For>
  );
}

function Finding(props: { said: Said }) {
  return (
    <li class={`pv-item pv-item--${props.said.tone}`}>
      <Eye tone={props.said.tone} />
      <div class="pv-item__body">
        <p class="pv-item__title">{props.said.title}</p>
        <For each={props.said.body}>
          {(s) => (
            <p>
              <Words s={s} />
            </p>
          )}
        </For>
        <Show when={props.said.reasons.length > 0}>
          <ul class="pv-reasons">
            <For each={props.said.reasons}>
              {(s) => (
                <li>
                  <Words s={s} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </li>
  );
}

/** What this checks, and what it does not: one disclosure, keyboard-reachable. */
function WhatThisChecks() {
  return (
    <More label="What this checks">
      <ul class="pv-checks">
        <For each={CHECKS}>{(c) => <li>{c}</li>}</For>
      </ul>
      <For each={LIMITS}>{(l) => <p>{l}</p>}</For>
    </More>
  );
}

/** The findings to show and the lines on what could not be checked, each worked out once. */
function useWords(report: () => PrivacyReport, unsent: () => boolean) {
  const said = createMemo(() => shownFindings(report(), unsent()).map((f) => sayFinding(f)));
  const partial = createMemo(() => sayPartial(report(), unsent()));
  const nothing = createMemo(() => sayNothing(isPartial(report())));
  return { said, partial, nothing };
}

function FindingList(props: { said: Said[] }) {
  return (
    <ul class="pv-list">
      <For each={props.said}>{(s) => <Finding said={s} />}</For>
    </ul>
  );
}

function Partial(props: { lines: Sentence[] }) {
  return (
    <Show when={props.lines.length > 0}>
      <div class="pv-partial">
        <For each={props.lines}>
          {(s) => (
            <p>
              <Words s={s} />
            </p>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Under the flow on the transaction page: quiet, in the flow's own panel. With nothing to show,
 * one muted line and no heading. */
export function TxPrivacy(props: { report: PrivacyReport }) {
  const w = useWords(
    () => props.report,
    () => false,
  );
  return (
    <section class="pv-under" aria-labelledby="pv-under-title">
      <Show
        when={w.said().length > 0}
        fallback={
          <p class="pv-none" id="pv-under-title">
            <Eye tone="neutral" />
            {w.nothing()}
          </p>
        }
      >
        <h3 class="pv-title" id="pv-under-title">
          {LIST_TITLE}
        </h3>
        <FindingList said={w.said()} />
      </Show>
      <Partial lines={w.partial()} />
      <WhatThisChecks />
    </section>
  );
}

/**
 * On Broadcast and the decoder, before the action: what sending it would show, always whole
 * (heading, findings or the one line, closing). Once it has been pressed, whatever came back, it
 * says what the transaction page says and nothing about whether it was sent: the button's own line
 * says what the broadcast returned.
 */
export function UnsentPrivacy(props: {
  report: PrivacyReport;
  /** Never pressed; pressed, not confirmed; sent. */
  state: "unsent" | "attempted" | "sent";
}) {
  const w = useWords(
    () => props.report,
    () => props.state === "unsent",
  );
  return (
    <section class="pv-send" aria-labelledby="pv-send-title">
      <h2 class="pv-title" id="pv-send-title">
        {props.state === "unsent" ? UNSENT_TITLE : LIST_TITLE}
      </h2>
      <Show
        when={w.said().length > 0}
        fallback={
          <p class="pv-none">
            <Eye tone="neutral" />
            {w.nothing()}
          </p>
        }
      >
        <FindingList said={w.said()} />
      </Show>
      <Partial lines={w.partial()} />
      <Show when={props.state === "unsent"}>
        <p class="pv-closing">{UNSENT_CLOSING}</p>
      </Show>
      <WhatThisChecks />
    </section>
  );
}
