// The privacy check on the page (docs/FRONTEND.md "Privacy check"): its marks on the flow's cards,
// the list under the flow on the transaction page, and the notice on Broadcast and the decoder.
// The words are all in privacytext.ts; this file only lays them out, as text nodes.
import { For, Show } from "solid-js";
import { Hash } from "../../components/Hash";
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

/** A card's marks, in its meta line: the eye and a few words each. */
export function CardMarks(props: { marks: readonly Mark[] | undefined }) {
  return (
    <For each={props.marks ?? []}>
      {(m) => (
        <span class={`pv-tag pv-tag--${m.tone}`}>
          <Eye tone={m.tone} />
          {m.text}
        </span>
      )}
    </For>
  );
}

/** A sentence: its text, and each address shortened as the site shortens one, whole in its title. */
function Words(props: { s: Sentence }) {
  return (
    <For each={props.s}>
      {(piece) => (typeof piece === "string" ? piece : <Hash value={piece.address} copy={false} />)}
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

/** The findings, what could not be checked, or the one line when there is nothing to show. */
function Findings(props: {
  report: PrivacyReport;
  unsent: boolean;
  titleId: string;
  title: string;
}) {
  const said = () => shownFindings(props.report, props.unsent).map((f) => sayFinding(f));
  const partial = () => sayPartial(props.report, props.unsent);
  return (
    <>
      <Show
        when={said().length > 0}
        fallback={
          <p class="pv-none" id={props.titleId}>
            <Eye tone="neutral" />
            {sayNothing(isPartial(props.report))}
          </p>
        }
      >
        <h3 class="pv-title" id={props.titleId}>
          {props.title}
        </h3>
        <ul class="pv-list">
          <For each={said()}>{(s) => <Finding said={s} />}</For>
        </ul>
      </Show>
      <Show when={partial().length > 0}>
        <div class="pv-partial">
          <For each={partial()}>
            {(s) => (
              <p>
                <Words s={s} />
              </p>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

/** Under the flow on the transaction page: quiet, in the flow's own panel. */
export function TxPrivacy(props: { report: PrivacyReport }) {
  return (
    <section class="pv-under" aria-labelledby="pv-under-title">
      <Findings report={props.report} unsent={false} titleId="pv-under-title" title={LIST_TITLE} />
      <WhatThisChecks />
    </section>
  );
}

/** On Broadcast and the decoder, above the action: what sending it would show. */
export function UnsentPrivacy(props: { report: PrivacyReport }) {
  const said = () => shownFindings(props.report, true);
  return (
    <section class="pv-send" aria-labelledby="pv-send-title">
      <Findings report={props.report} unsent titleId="pv-send-title" title={UNSENT_TITLE} />
      <Show when={said().length > 0}>
        <p class="pv-closing">{UNSENT_CLOSING}</p>
      </Show>
      <WhatThisChecks />
    </section>
  );
}
