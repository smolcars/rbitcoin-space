// The privacy check on the page (docs/FRONTEND.md "Privacy check"): its marks on the flow's cards,
// the list under the flow on the transaction page, and the notice on Broadcast and the decoder.
// The words are all in privacytext.ts; this file only lays them out, as text nodes.
import { createMemo, For, Show } from "solid-js";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import type { PrivacyReport } from "../../lib/privacy";
import {
  CHECKS,
  findingId,
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
import { bringIntoView, cardId, showCard } from "./flash";
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

/** Brings a finding into view and outlines it, after `before` has made room for it. */
function showFinding(id: string, before: (() => void) | undefined) {
  before?.();
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) bringIntoView(el);
  });
}

/**
 * A card's marks, at the end of its meta line, on a line of their own: the spent status arrives
 * after the card, and would otherwise push them to a second line and the flow down. Each links to
 * its finding; on a narrow screen it shows one word (Privacy.css), its full words its name.
 */
export function CardMarks(props: {
  marks: readonly Mark[] | undefined;
  /** Before the link is followed: the page makes room for the list (closes an inspector). */
  onFollow?: (() => void) | undefined;
}) {
  return (
    <Show when={(props.marks?.length ?? 0) > 0}>
      <span class="pv-tags">
        <For each={props.marks ?? []}>
          {(m) => (
            <a
              class={`pv-tag pv-tag--${m.tone}`}
              href={`#${findingId(m.kind)}`}
              // A link within the page: never the router's "current page" (claims.js).
              aria-current="false"
              aria-label={m.text}
              onClick={(e) => {
                e.preventDefault();
                showFinding(findingId(m.kind), props.onFollow);
              }}
            >
              <Eye tone={m.tone} />
              <span class="pv-tag__long">{m.text}</span>
              <span class="pv-tag__short">{m.short}</span>
            </a>
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
        if ("ref" in piece) {
          const { ref: side, index } = piece;
          return (
            <a
              class="pv-ref num"
              href={`#${cardId(side, index)}`}
              aria-current="false"
              aria-label={`Show ${side === "in" ? "input" : "output"} ${index}`}
              onClick={(e) => {
                e.preventDefault();
                showCard(side, index);
              }}
            >
              {String(index)}
            </a>
          );
        }
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
    <li class={`pv-item pv-item--${props.said.tone}`} id={findingId(props.said.kind)} tabindex="-1">
      <Eye tone={props.said.tone} />
      <div class="pv-item__body">
        <p class="pv-item__title">
          <span>
            <Words s={props.said.title} />
          </span>
          <Show when={props.said.note}>{(n) => <span class="pv-item__note">{n()}</span>}</Show>
        </p>
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
        <For each={CHECKS}>
          {(c) => (
            <li>
              {c.text}
              <Show when={c.readings}>
                {(rs) => (
                  <ol class="pv-checks__readings">
                    <For each={rs()}>{(r) => <li>{r}</li>}</For>
                  </ol>
                )}
              </Show>
              <Show when={c.after}>{(a) => <p>{a()}</p>}</Show>
            </li>
          )}
        </For>
      </ul>
      <For each={LIMITS}>{(l) => <p>{l}</p>}</For>
    </More>
  );
}

/** The findings to show and the lines on what could not be checked, each worked out once. */
function useWords(report: () => PrivacyReport, unsent: () => boolean) {
  const said = createMemo(() => {
    const shown = shownFindings(report(), unsent());
    return shown.map((f) => sayFinding(f, shown));
  });
  const partial = createMemo(() => sayPartial(report(), unsent()));
  const nothing = createMemo(() => sayNothing(isPartial(report())));
  return { said, partial, nothing };
}

function FindingList(props: { said: Said[] }) {
  return (
    <ul class={["pv-list", { "pv-list--many": props.said.length > 1 }]}>
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

/** The list's id on the transaction page, where the summary's line leads. */
export const LIST_ID = "pv-list";

/**
 * On the transaction page. Beside the flow (`rail`), its own panel under "Details", always with
 * its heading. Under the flow (`under`, a narrow screen), quiet, in the flow's own panel; with
 * nothing to show, one muted line and no heading.
 */
export function TxPrivacy(props: { report: PrivacyReport; place: "rail" | "under" }) {
  const w = useWords(
    () => props.report,
    () => false,
  );
  return (
    <Show
      when={props.place === "under"}
      fallback={
        <section class="pv-rail" id={LIST_ID} aria-labelledby="pv-rail-title">
          <SectionHeader title={LIST_TITLE} id="pv-rail-title" />
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
          <WhatThisChecks />
        </section>
      }
    >
      <Under w={w} />
    </Show>
  );
}

function Under(props: { w: ReturnType<typeof useWords> }) {
  const w = props.w;
  return (
    <section class="pv-under" id={LIST_ID} aria-labelledby="pv-under-title" tabindex="-1">
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
