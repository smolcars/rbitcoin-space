// "Highlight": pick kinds of transaction to keep lit in a block's map (docs/FRONTEND.md "Goggles",
// docs/DESIGN.md "The goggles"). The pick is the visit's, shared with every map; this is its control.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  census,
  type Flagged,
  formatShare,
  GROUPS,
  type Group,
  type Kind,
  KINDS,
  type Mode,
  type Pick,
  pick,
  resultLine,
  setPick,
  toggled,
} from "../lib/goggles";
import "./Goggles.css";

/** Narrow screens take the panel as a sheet from the bottom; wider ones dock it beside the map. */
const SHEET = "(max-width: 65em)";
const COMMON = KINDS.filter((k) => k.group === "Common").length;

const Lens = () => (
  <svg class="gg__icon" viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="6" cy="11" r="3.6" />
    <circle cx="14" cy="11" r="3.6" />
    <path d="M9.6 10.4q.4-.8.8 0M2.4 10.6 3.8 6M17.6 10.6 16.2 6" />
  </svg>
);
const Cross = () => (
  <svg class="gg__x" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 3l6 6M9 3l-6 6" />
  </svg>
);

let panels = 0;

/**
 * The "Highlight" button under a map, the picked kinds beside it with the result in one line, and
 * the panel that picks them. `txs` is the block as it is now; a live block may change it at any
 * time, and the figures follow without a word to a screen reader: only the reader's own change is
 * announced. `frame` is what to keep in view above the sheet on a narrow screen.
 */
export function Goggles(props: {
  txs: readonly Flagged[] | undefined;
  frame: () => HTMLElement | undefined;
}) {
  const id = `gg-panel-${++panels}`;
  const [open, setOpen] = createSignal(false);
  const [more, setMore] = createSignal(false);
  let toggle: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;

  // Once per change of the block or the pick, never per render.
  const counted = createMemo(() => {
    const start = performance.now();
    const c = census(props.txs ?? [], pick());
    performance.measure("goggles census", { start });
    return c;
  });
  const result = () => resultLine(counted());
  const picked = () => pick().kinds;

  // Said once, after the reader's own change, with the figures it gave.
  const [said, setSaid] = createSignal("");
  let asked = false;
  const choose = (next: Pick) => {
    asked = true;
    setPick(next);
  };
  createEffect(counted, (c) => {
    if (!asked) return;
    asked = false;
    // A trailing no-break space when the words repeat, so the region still speaks.
    const line = resultLine(c);
    setSaid((was) => (was === line ? `${line} ` : line));
  });

  const close = () => {
    setOpen(false);
    toggle?.focus();
  };
  const show = () => {
    setOpen(true);
    if (matchMedia(SHEET).matches) {
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      props.frame()?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    }
    queueMicrotask(() =>
      panel?.querySelector<HTMLElement>(".gg__chip")?.focus({ preventScroll: true }),
    );
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) close();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const chip = (k: Kind) => {
    const i = KINDS.indexOf(k);
    const c = () => counted();
    const share = () => (c().size > 0 ? (c().sizes[i] ?? 0) / c().size : 0);
    const none = () => (c().counts[i] ?? 0) === 0;
    const on = () => picked().includes(k);
    const clash = () => !on() && c().withPick?.[i] === 0;
    return (
      <button
        type="button"
        class={["gg__chip", { "gg__chip--dashed": none() || clash() }]}
        aria-pressed={on() ? "true" : "false"}
        aria-disabled={none() && !on() ? "true" : undefined}
        style={{ "--share": String(share()) }}
        onClick={() => {
          if (!none() || on()) choose(toggled(pick(), k));
        }}
      >
        <span class="gg__label">{k.label}</span>
        <span class="gg__share num">{formatShare(share())}</span>
        <span class="visually-hidden">
          {none()
            ? " of the block: none here"
            : clash()
              ? " of the block, none with the picked kinds"
              : " of the block"}
        </span>
      </button>
    );
  };
  const group = (name: Group) => (
    <div class="gg__group" role="group" aria-label={name === "Common" ? "Common kinds" : name}>
      <Show when={name !== "Common"}>
        <span class="gg__group-name" aria-hidden="true">
          {name}
        </span>
      </Show>
      <div class="gg__chips">
        <For each={KINDS.filter((k) => k.group === name)}>{(k) => chip(k)}</For>
      </div>
    </div>
  );
  const mode = (m: Mode, label: string) => (
    <button
      type="button"
      aria-pressed={pick().mode === m ? "true" : "false"}
      onClick={() => choose({ ...pick(), mode: m })}
    >
      {label}
    </button>
  );

  return (
    <div class={["gg", { "gg--open": open() }]}>
      <div class="gg__bar">
        <button
          ref={toggle}
          type="button"
          class="btn gg__toggle"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          disabled={props.txs === undefined}
          onClick={() => (open() ? close() : show())}
        >
          <Lens />
          Highlight
        </button>
        <Show when={picked().length > 0}>
          <ul class="gg__picked" aria-label="Highlighted kinds">
            <For each={picked()}>
              {(k, i) => (
                <li>
                  <Show when={i() > 0}>
                    <span class="gg__join">{pick().mode === "any" ? "or" : "and"}</span>
                  </Show>
                  <button
                    type="button"
                    class="gg__tag"
                    aria-label={`Stop highlighting ${k.name}`}
                    onClick={() => {
                      choose(toggled(pick(), k));
                      // The tag goes: focus stays in the bar rather than falling to the page.
                      toggle?.focus();
                    }}
                  >
                    {k.name}
                    <Cross />
                  </button>
                </li>
              )}
            </For>
          </ul>
          <p class={["gg__result num", { "gg__result--none": counted().lit?.count === 0 }]}>
            {result()}
          </p>
        </Show>
      </div>
      <p class="visually-hidden" role="status">
        {said()}
      </p>
      <div
        ref={panel}
        id={id}
        class="gg__panel"
        role="dialog"
        aria-label="Highlight transactions by kind"
      >
        <div class="gg__head">
          <span class="gg__now num" aria-hidden="true">
            {result()}
          </span>
          <Show when={picked().length > 0}>
            <div class="gg__mode" role="group" aria-label="Match">
              {mode("any", "Any")}
              {mode("all", "All")}
            </div>
            <button
              type="button"
              class="gg__clear"
              onClick={() => {
                choose({ ...pick(), kinds: [] });
                // Clear goes with what it cleared: focus moves to the first kind.
                panel?.querySelector<HTMLElement>(".gg__chip")?.focus();
              }}
            >
              Clear
            </button>
          </Show>
          <button type="button" class="btn gg__done" onClick={close}>
            Done
          </button>
        </div>
        <div class="gg__body">
          {group("Common")}
          <button
            type="button"
            class="gg__more"
            aria-expanded={more() ? "true" : "false"}
            onClick={() => setMore((m) => !m)}
          >
            {more() ? "Fewer kinds" : "More kinds"}{" "}
            <Show when={!more()}>
              <span class="num">{KINDS.length - COMMON}</span>
            </Show>
          </button>
          <Show when={more()}>
            <For each={GROUPS.slice(1)}>{(name) => group(name)}</For>
          </Show>
        </div>
      </div>
    </div>
  );
}
