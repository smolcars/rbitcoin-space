import { useBeforeLeave, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { ApiError } from "../lib/api";
import { intend } from "../lib/intent";
import { formatBtcShort, groupDigits, truncateMiddle } from "../lib/format";
import { NETWORK_NAMES, type Network, onNetwork, paths } from "../lib/network";
import { useNetwork } from "../lib/page";
import { ScanButton } from "../scan/ScanButton";
import type { Logic, Outcome, Query, Suggestion } from "../search/search";
import { Link } from "./Link";
import "./Button.css";
import "./SearchField.css";

/** How long typing pauses before Lightning's index is asked for names. */
const SUGGEST_MS = 280;

/** The longest payment string the decoder reads (search/query.ts MAX_PAYMENT); classify() refuses
 * anything else longer than MAX_QUERY. */
const MAX_LENGTH = 8192;

export interface SearchFieldProps {
  id?: string;
  ref?: (el: HTMLInputElement) => void;
}

type Miss = Exclude<Outcome, { kind: "go" }>;

const queried = (miss: Miss) => (miss.kind === "missing" ? miss.query : null);

/** What a finished search that leads nowhere says, in one sentence for screen readers. */
function summary(miss: Miss, network: string, scanned: boolean): string {
  if (miss.kind === "failed") return "Search could not finish.";
  if (miss.query?.kind === "hash") {
    return `Nothing matches: no block or transaction on ${network} has this ID.`;
  }
  return scanned
    ? "Code not recognised: what it holds is not a transaction ID, block hash, height or address."
    : "Nothing matches: this is not a transaction ID, block hash, height or address.";
}

/**
 * The header's search. Reads the query as it is typed, and on Enter goes to its page or explains
 * why there is none. The logic (search/search.ts) loads when the field is first used.
 */
/** A phone's resting header gives the search little room: its hint is one word there. */
const PHONE = "(max-width: 40em)";

export function SearchField(props: SearchFieldProps) {
  const id = () => props.id ?? "search";
  const phone = typeof matchMedia === "function" ? matchMedia(PHONE) : undefined;
  const [narrow, setNarrow] = createSignal(phone?.matches === true);
  onSettled(() => {
    const change = (e: MediaQueryListEvent) => setNarrow(e.matches);
    phone?.addEventListener("change", change);
    return () => phone?.removeEventListener("change", change);
  });
  const network = useNetwork();
  const navigate = useNavigate();
  const [text, setText] = createSignal("");
  const [logic, setLogic] = createSignal<Logic>();
  const [busy, setBusy] = createSignal(false);
  // `scanned`: the query is what a QR code held, not what was typed.
  const [miss, setMiss] = createSignal<{ query: string; miss: Miss; scanned: boolean }>();
  const [said, setSaid] = createSignal("");
  // A well-formed ID that nothing on this network has: the field says so, not what it looks like.
  const [nothingFor, setNothingFor] = createSignal<string>();
  // Whether a network has Lightning, once the search logic has asked; and the nodes it suggests.
  const [lightning, setLightning] = createSignal<{ network: Network; on: boolean }>();
  const [found, setFound] = createSignal<{ q: string; nodes: Suggestion[] }>();
  const [active, setActive] = createSignal(-1);
  let root: HTMLElement | undefined;
  let input: HTMLInputElement | undefined;

  let loading: Promise<Logic> | undefined;
  let searcher: ReturnType<Logic["createSearch"]> | undefined;
  const load = () => {
    loading ??= (async () => {
      try {
        const m = await import("../search/search");
        searcher ??= m.createSearch();
        setLogic(() => m);
        return m;
      } catch (error) {
        loading = undefined;
        throw error;
      }
    })();
    return loading;
  };
  const warm = () => void load().catch(() => undefined);

  const reading = createMemo(() => {
    const m = logic();
    const q = text().trim();
    if (q !== "" && q === nothingFor()) return { label: "Nothing has this ID", ready: false };
    const l = lightning();
    return m && q !== "" ? m.describe(q, network(), l?.network === network() && l.on) : undefined;
  });

  // The reading is announced once typing pauses, and only when it changed: not every keystroke.
  let pause: ReturnType<typeof setTimeout> | undefined;
  createEffect(reading, (r) => {
    clearTimeout(pause);
    if (r) pause = setTimeout(() => setSaid(r.label), 900);
  });
  onCleanup(() => clearTimeout(pause));

  // Every new search, edit, or navigation makes the search or suggestion in flight stale; closing
  // the list makes only the suggestion stale, so a search under way still lands.
  let generation = 0;
  let asking = 0;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const dismiss = () => {
    asking += 1;
    clearTimeout(waiting);
    setFound(undefined);
    setActive(-1);
  };
  const stop = () => {
    generation += 1;
    asking += 1;
    clearTimeout(waiting);
    searcher?.cancel();
    setBusy(false);
    setMiss(undefined);
    setActive(-1);
  };
  onCleanup(() => clearTimeout(waiting));

  // The list stays until a newer one replaces it, so it does not flicker with every keystroke.
  // Given the value: a signal just written reads its old value until Solid flushes.
  const suggest = (value: string) => {
    const q = value.trim();
    if (q === "") {
      setFound(undefined);
      return;
    }
    const mine = asking;
    const net = network();
    waiting = setTimeout(() => {
      void (async () => {
        try {
          await load();
        } catch {
          return;
        }
        const r = await searcher?.suggest(q, net);
        if (r === undefined || mine !== asking) return;
        if (r.lightning !== undefined) setLightning({ network: net, on: r.lightning });
        setFound(r.nodes.length > 0 ? { q, nodes: r.nodes } : undefined);
        setActive(-1);
      })();
    }, SUGGEST_MS);
  };
  const open = () => (miss() || busy() ? undefined : found());
  // Focus stays in the input, so the browser does not bring the highlighted option into view.
  createEffect(active, (i) => {
    if (i < 0) return;
    const el = document.getElementById(`${id()}-option-${i}`);
    // jsdom has no scrollIntoView.
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  });
  /** Each option's page: the nodes, then every result for the query. */
  const choices = () => {
    const f = open();
    return f ? [...f.nodes.map((n) => n.path), paths.lightningSearch(f.q)] : [];
  };
  const go = (path: string) => {
    const net = network();
    setText("");
    setFound(undefined);
    input?.blur();
    navigate(onNetwork(net, path));
  };
  // Navigation start, not end: a page still loading must not be overridden by a search answering.
  // The query goes too: on the next page it would read as that page's, "Not recognised" and all.
  useBeforeLeave(() => {
    stop();
    setText("");
    setFound(undefined);
    setNothingFor(undefined);
  });

  // A scanned code is looked up as what it holds: never as a Lightning node's name.
  const search = async (query: string, scanned = false) => {
    stop();
    const mine = generation;
    // A later choice made elsewhere meanwhile (an address's date) wins over this answer.
    const latest = intend();
    const net = network();
    setBusy(true);
    let outcome: Outcome | undefined;
    try {
      await load();
      if (mine !== generation) return;
      outcome = await searcher?.run(query, net, !scanned);
    } catch (error) {
      outcome = { kind: "failed", error };
    }
    if (outcome === undefined || mine !== generation) return;
    setBusy(false);
    if (!latest()) return;
    if (outcome.kind === "go") {
      setText("");
      // The field, or its scan button after a scan: the search lets go of focus for the new page.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && root?.contains(focused)) focused.blur();
      navigate(onNetwork(net, outcome.path));
    } else {
      setMiss({ query, miss: outcome, scanned });
      if (outcome.kind === "missing" && outcome.query?.kind === "hash") setNothingFor(query);
      setSaid(summary(outcome, NETWORK_NAMES[net], scanned));
    }
  };

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const query = text().trim();
    if (query !== "") void search(query);
  };

  // A miss closes when the reader moves on: a press outside, or focus leaving the search.
  const outside = (target: EventTarget | null) =>
    target instanceof Node && root !== undefined && !root.contains(target);
  onSettled(() => {
    const onPress = (e: PointerEvent) => {
      if (!outside(e.target)) return;
      setMiss(undefined);
      dismiss();
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  });

  return (
    <search
      class="search"
      ref={(el) => (root = el)}
      onFocusOut={(e) => {
        // Focus going nowhere (iOS's Done, a press on the page) closes the list, which the
        // searching row collapses under; a miss stays until the reader moves on (Header.css).
        if (e.relatedTarget === null || outside(e.relatedTarget)) dismiss();
        if (outside(e.relatedTarget)) setMiss(undefined);
      }}
    >
      <form class="search__field" onSubmit={submit}>
        <label class="visually-hidden" for={id()}>
          Search
        </label>
        <svg class="search__icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        <input
          ref={(el) => {
            input = el;
            // Set here: Solid writes a literal "/" into its template unquoted, which some parsers drop.
            el.setAttribute("aria-keyshortcuts", "/");
            props.ref?.(el);
          }}
          id={id()}
          name="q"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={open() ? `${id()}-list` : undefined}
          aria-activedescendant={active() >= 0 ? `${id()}-option-${active()}` : undefined}
          placeholder={narrow() ? "Search" : "Transaction, address or block"}
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="search"
          maxlength={MAX_LENGTH}
          aria-describedby={`${id()}-reading`}
          value={text()}
          onFocus={warm}
          onPointerEnter={warm}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setNothingFor(undefined);
            stop();
            suggest(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            const all = choices();
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && all.length > 0) {
              e.preventDefault();
              const down = e.key === "ArrowDown";
              const i = active();
              setActive(
                i < 0
                  ? down
                    ? 0
                    : all.length - 1
                  : (i + (down ? 1 : -1) + all.length) % all.length,
              );
            } else if (e.key === "Enter" && active() >= 0) {
              const path = all[active()];
              if (path === undefined) return;
              e.preventDefault();
              go(path);
            } else if (e.key === "Escape") {
              // What is shown closes and keeps the query (a search field's own Escape empties
              // it); a list not yet arrived is dropped too: Escape means none is wanted.
              const shown = miss() !== undefined || open() !== undefined;
              dismiss();
              if (!shown) return;
              e.preventDefault();
              setMiss(undefined);
            }
          }}
        />
        <span id={`${id()}-reading`} class="search__reading">
          <Show
            when={!busy()}
            fallback={
              <span class="search__busy">
                <span class="search__pulse" aria-hidden="true" />
                Looking up
              </span>
            }
          >
            <Show when={reading()}>
              {(r) => (
                <span class={["search__label", { "search__label--ready": r().ready }]}>
                  {r().label}
                  <Show when={r().ready}>
                    <kbd class="search__key" title="Press Enter to search">
                      <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M10 2v4.5H2.5M5 4 2.5 6.5 5 9" />
                      </svg>
                      <span class="visually-hidden">Enter</span>
                    </kbd>
                  </Show>
                </span>
              )}
            </Show>
          </Show>
        </span>
        <kbd class="search__slash" aria-hidden="true" title="Press / to search">
          /
        </kbd>
        <ScanButton
          onScan={(value) => {
            // The code's text goes in the field and is looked up as if typed; it is only text.
            const query = value.trim();
            setText(query);
            setNothingFor(undefined);
            dismiss();
            if (query !== "") void search(query, true);
          }}
        />
      </form>
      <span class="visually-hidden" role="status">
        {said()}
      </span>
      <Show when={open()}>
        {(f) => (
          // The input keeps focus and takes the keys (aria-activedescendant): a press on an option
          // must not take focus first.
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the combobox input handles the keys
          <div
            class="search__list"
            tabindex="-1"
            id={`${id()}-list`}
            role="listbox"
            aria-label="Lightning nodes"
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const option =
                e.target instanceof Element ? e.target.closest<HTMLElement>("[data-option]") : null;
              const path = choices()[Number(option?.dataset["option"])];
              if (path !== undefined) go(path);
            }}
          >
            <For each={f().nodes}>
              {(n, i) => (
                <div
                  class="search__option"
                  id={`${id()}-option-${i()}`}
                  role="option"
                  aria-selected={active() === i() ? "true" : "false"}
                  data-option={i()}
                >
                  {/* A name is a claim: the key beside it is the identity. */}
                  <span class={["search__name", { "search__name--none": n.name === null }]}>
                    {n.name ?? "No name"}
                  </span>
                  <span class="search__cap">{formatBtcShort(n.capacity)} BTC</span>
                  <span class="search__nodekey">{truncateMiddle(n.key, 10, 10)}</span>
                </div>
              )}
            </For>
            <div
              class="search__option search__all"
              id={`${id()}-option-${f().nodes.length}`}
              role="option"
              aria-selected={active() === f().nodes.length ? "true" : "false"}
              data-option={f().nodes.length}
            >
              All results for “{truncateMiddle(f().q, 24, 8)}”
            </div>
          </div>
        )}
      </Show>
      <Show when={miss()}>
        {(m) => (
          <div class="search__panel" tabindex="-1">
            <Show
              when={m().miss.kind === "missing"}
              fallback={
                <Failed
                  miss={m().miss}
                  retry={() => {
                    void search(m().query, m().scanned);
                  }}
                />
              }
            >
              <Nothing
                query={m().query}
                found={queried(m().miss)}
                network={NETWORK_NAMES[network()]}
                scanned={m().scanned}
                visible={logic()?.visible ?? (() => "")}
              />
            </Show>
          </div>
        )}
      </Show>
    </search>
  );
}

function Nothing(props: {
  query: string;
  found: Query | null;
  network: string;
  scanned: boolean;
  visible: (text: string) => string;
}) {
  const isHash = () => props.found?.kind === "hash";
  return (
    <>
      <p class="search__title">
        {props.scanned && !isHash() ? "Code not recognised" : "Nothing matches"}
      </p>
      <Show
        when={props.found?.kind === "hash" && props.found.hash}
        fallback={
          <Show
            when={props.scanned}
            fallback={
              <p>
                <q class="search__query">{truncateMiddle(props.query, 28, 12)}</q> is not a
                transaction ID, block hash, block height or address.
              </p>
            }
          >
            {/* What a code holds is someone else's text: shown as text, cut, never followed. */}
            <p>
              The QR code holds{" "}
              <q class="search__query" title={props.visible(props.query)}>
                {truncateMiddle(props.visible(props.query), 96, 32)}
              </q>
              , which is not a transaction ID, block hash, block height or address.
            </p>
          </Show>
        }
      >
        {(hash) => (
          <p>
            No block or transaction on {props.network} has the ID{" "}
            <span class="search__query search__query--hash" title={hash()}>
              {truncateMiddle(hash(), 12, 12)}
            </span>
            .
          </p>
        )}
      </Show>
      <dl class="search__finds">
        <dt>Transaction</dt>
        <dd>its ID, 64 characters</dd>
        <dt>Block</dt>
        <dd>
          its hash, or its height such as{" "}
          <Link href={paths.block(840_000)}>{groupDigits(840_000)}</Link>
        </dd>
        <dt>Address</dt>
        <dd>the whole address</dd>
        <dt>Lightning</dt>
        <dd>a node's public key, or a channel ID such as 811984x2037x0</dd>
      </dl>
      <p class="search__aside">
        Search finds exact matches on {props.network} only, never part of an ID or an address. For
        another network, switch to it first, or browse the{" "}
        <Link href={paths.blocks()}>latest blocks</Link>.
      </p>
    </>
  );
}

function Failed(props: { miss: Miss; retry: () => void }) {
  const message = () => {
    const e = props.miss.kind === "failed" ? props.miss.error : undefined;
    return e instanceof ApiError
      ? e.message
      : "The search could not be loaded. Check your connection.";
  };
  return (
    <>
      <p class="search__title">Search could not finish</p>
      <p>{message()}</p>
      <button type="button" class="btn" onClick={() => props.retry()}>
        Try again
      </button>
    </>
  );
}
