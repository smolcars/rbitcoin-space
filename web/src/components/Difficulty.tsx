// The difficulty adjustment (docs/API.md "Difficulty adjustment"): how far through its period the
// chain is, and what the next retarget is expected to do. The home and mining pages show it.
import { type Accessor, createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { fetchStamped, withRetry } from "../lib/api";
import { useNow } from "../lib/clock";
import {
  change,
  type DifficultyAdjustment as Reply,
  isDifficultyAdjustment,
  PERIOD,
  paceText,
  periodText,
  retargets,
  retargetUtc,
  until,
} from "../lib/difficulty";
import { groupDigits } from "../lib/format";
import { NETWORK_NAMES, type Network } from "../lib/network";
import { ErrorState } from "./States";
import "./Difficulty.css";

/** The answer can trail a new tip by a moment; ask again this often, this many times. */
const BEHIND_RETRY_MS = 1_500;
const BEHIND_TRIES = 4;

/**
 * The period's progress bar and the expected, next and previous change. Fetched once, then again
 * whenever `tip` moves. On a network that never retargets it says so instead.
 */
export function DifficultyAdjustment(props: {
  network: Network;
  tip: Accessor<string | undefined>;
}) {
  return (
    <Show
      when={retargets(props.network)}
      fallback={
        <p class="difficulty__note">
          {NETWORK_NAMES[props.network]} never adjusts its difficulty: every block is mined at the
          minimum, so there is no next adjustment to show.
        </p>
      }
    >
      <Adjustment network={props.network} tip={props.tip} />
    </Show>
  );
}

function Stat(props: { label: string; children: JSX.Element }) {
  return (
    <div class="difficulty__stat">
      <dt class="difficulty__label">{props.label}</dt>
      <dd class="difficulty__value">{props.children}</dd>
    </div>
  );
}

function Adjustment(props: { network: Network; tip: Accessor<string | undefined> }) {
  const now = useNow();
  const [data, setData] = createSignal<Reply>();
  const [error, setError] = createSignal<unknown>();
  let controller: AbortController | undefined;
  let behind: ReturnType<typeof setTimeout> | undefined;
  let behindTries = 0;
  /** The tip the shown answer is as of. */
  let answeredAt: string | undefined;

  /** Asked once already: later asks follow a new tip, which a cached answer would predate. */
  let asked = false;
  const load = () => {
    const fresh = asked;
    asked = true;
    controller?.abort();
    clearTimeout(behind);
    const c = new AbortController();
    controller = c;
    // A 503 before the server's first answer is retried as it says, without showing an error.
    withRetry(
      () =>
        fetchStamped<unknown>(props.network, "/v1/difficulty-adjustment", {
          signal: c.signal,
          cached: !fresh,
        }),
      c.signal,
    ).then(
      ({ value, tip }) => {
        if (c.signal.aborted) return;
        if (isDifficultyAdjustment(value)) {
          setData(value);
          setError(undefined);
        } else setError(new Error("The server sent a reply that could not be read."));
        answeredAt = tip?.hash;
        // The answer is as of an older tip than the strip shows: the server is still recomputing.
        const want = props.tip();
        if (want && tip && tip.hash !== want && behindTries < BEHIND_TRIES) {
          behindTries++;
          behind = setTimeout(load, BEHIND_RETRY_MS);
        } else behindTries = 0;
      },
      (e: unknown) => {
        if (!c.signal.aborted) setError(e);
      },
    );
  };
  untrack(load);
  // A new tip changes the answer. The first tip only arrives with the strip, after `load` above.
  let changes = 0;
  createEffect(
    () => props.tip(),
    (tip) => {
      // The strip's first tip: ask again only if the answer already shown is as of another one.
      if (changes++ === 0 && (answeredAt === undefined || answeredAt === tip)) return;
      behindTries = 0;
      load();
    },
    { defer: true },
  );
  onCleanup(() => {
    controller?.abort();
    clearTimeout(behind);
  });

  const d = () => data();
  const expected = () => change(d()?.difficultyChange ?? 0);
  const previous = () => change(d()?.previousRetarget ?? 0);
  const progress = () => Math.min(1, Math.max(0, (d()?.progressPercent ?? 0) / 100));
  const paceTitle = () => {
    const a = d();
    return a ? paceText(a) : undefined;
  };
  const pace = () => Math.min(1, Math.max(0, (d()?.expectedBlocks ?? 0) / PERIOD));

  return (
    <Show
      when={d() ?? error() === undefined}
      fallback={
        <ErrorState title="Could not load the difficulty adjustment" error={error()} retry={load} />
      }
    >
      {/* The home page shows the count and figures only: the sentence stays in the title. */}
      <figure class="difficulty__period" title={paceTitle()}>
        <div class="difficulty__bar">
          <span
            class={["difficulty__done", { "difficulty__done--loading": !d() }]}

            style={{ "--p": String(progress()) }}
          />
          <Show when={d()}>
            <span class="difficulty__pace" style={{ "--p": String(pace()) }} />
          </Show>
        </div>
        <figcaption class="difficulty__caption">
          <span class="num difficulty__count">
            <Show when={d()}>{(a) => <>{periodText(a())}</>}</Show>
          </span>
          <span class="difficulty__pace-text">
            <Show when={d()}>{(a) => <>{paceText(a())}</>}</Show>
          </span>
        </figcaption>
      </figure>
      <dl class="difficulty__stats" aria-busy={d() ? "false" : "true"}>
        <Stat label="Expected change">
          <Show when={d()}>
            {(a) => (
              <>
                <span class="num">
                  <span class="difficulty__arrow" aria-hidden="true">
                    {expected().arrow}
                  </span>
                  {expected().text}
                </span>
                <span class="difficulty__sub num">
                  at block {groupDigits(a().nextRetargetHeight)}
                </span>
              </>
            )}
          </Show>
        </Stat>
        <Stat label="Next adjustment">
          <Show when={d()}>
            {(a) => (
              <>
                <span class="num">{until(a().estimatedRetargetDate, now() * 1000)}</span>
                <span class="difficulty__sub num">{retargetUtc(a().estimatedRetargetDate)}</span>
              </>
            )}
          </Show>
        </Stat>
        <Stat label="Previous change">
          <Show when={d()}>
            <span class="num">
              <span class="difficulty__arrow" aria-hidden="true">
                {previous().arrow}
              </span>
              {previous().text}
            </span>
          </Show>
        </Stat>
      </dl>
    </Show>
  );
}
