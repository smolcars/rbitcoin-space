// The command palette: one field that goes anywhere. Loaded on first open (PaletteKey.tsx); the
// header search's logic (search/search.ts) reads identifiers, so the two never disagree.
import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiError, fetchApi } from "../lib/api";
import { type AppConfig, loadConfig } from "../lib/config";
import { formatBtcShort, groupDigits, truncateMiddle } from "../lib/format";
import { intend } from "../lib/intent";
import { NETWORK_NAMES, type Network, onNetwork, paths, stripNetwork } from "../lib/network";
import { useNetwork } from "../lib/page";
import { scheme, toggleTheme } from "../lib/theme";
import { cleanAlias } from "../pages/lightning/lightning";
import { classify } from "../search/query";
import { createSearch, describe, type Suggestion } from "../search/search";
import {
  type Action,
  actions,
  type Moment,
  type Offer,
  type Pool,
  orderGroups,
  pages,
  ranked,
  readDate,
  readPools,
} from "./match";
import { blockAt, type Dated } from "./block-at";
import "./Palette.css";

/** How long typing pauses before the server is asked: the header search's own pause. */
const ASK_MS = 280;
/** How long the result count waits for typing to pause before it is announced. */
const SAY_MS = 600;
const MAX_POOLS = 6;

type Kind =
  | "tx"
  | "block"
  | "address"
  | "node"
  | "channel"
  | "payment"
  | "search"
  | "date"
  | "page"
  | "pool"
  | "network"
  | "theme";

/** The word at a row's end, so a row's kind is never told by its icon alone. */
const KIND_WORDS: Record<Kind, string> = {
  tx: "Transaction",
  block: "Block",
  address: "Address",
  node: "Lightning node",
  channel: "Lightning channel",
  payment: "Decoder",
  search: "Search",
  date: "Block by date",
  page: "Page",
  pool: "Mining pool",
  network: "Network",
  theme: "Theme",
};

interface Row {
  id: string;
  kind: Kind;
  title: string;
  /** Set in the monospace: an id, an address, a key. */
  mono?: boolean;
  detail?: string | undefined;
  /** A Lightning node's key, shown beside its alias: the name is a claim, the key the identity. */
  key?: string;
  /** How well it matched (match.ts `score`): only a strong match is pinned as the default. */
  score?: number;
  run: () => void;
}

interface Group {
  name: string;
  rows: Row[];
  /** Its best row's match, which places it among the others (orderGroups). */
  best: number;
}

/** Above any name's score: what the query is (an id, a date) leads. */
const FIRST = 1000;
/** Lightning's index ranks its own nodes: a name it matched sits with a word's start. */
const NODES = 60;
/**
 * The least score whose row is pinned when shown as the default selection: a name's start, a
 * word's start or a keyword's. Below it, letters in order and the Lightning catch-all, which show
 * while names are still being asked for, give way to the name that arrives.
 */
const PIN = 55;

/** Pools by network, asked for once per page load. */
const poolLists = new Map<Network, Promise<Pool[]>>();
function loadPools(network: Network): Promise<Pool[]> {
  let list = poolLists.get(network);
  if (!list) {
    list = fetchApi<unknown>(network, "/v1/mining/pools", { cached: true }).then(
      (body) => readPools(body, cleanAlias),
      // A server without a block table has no pool list: the palette offers none.
      () => [],
    );
    poolLists.set(network, list);
  }
  return list;
}

export interface PaletteProps {
  /** What the field starts with: the header search's text when the palette is opened from it. */
  initial: string;
  /** The opener says it is closing (opener.ts): the palette fades out and runs nothing more. */
  closing: boolean;
  /** The reader is done with it: Escape, a press outside, an action done. */
  onDismiss: () => void;
  /** The fade has ended and the dialog is closed. */
  onClosed: () => void;
}

/** What a date's kept answer is for: the typed text, and its cutoff once that has passed. */
const dateKey = (q: string, moment: Moment) => `${q}|${moment.open ? "open" : moment.at}`;

export default function Palette(props: PaletteProps): JSX.Element {
  const network = useNetwork();
  const navigate = useNavigate();
  const location = useLocation();
  // Two searches: suggestions are cancelled by every key and by the config arriving; an explicit
  // lookup only by its own cancellation (an edit, a newer lookup, closing). Neither touches the other.
  const suggester = createSearch();
  const runner = createSearch();
  const [text, setText] = createSignal(props.initial);
  const [config, setConfig] = createSignal<AppConfig | null>();
  const [pools, setPools] = createSignal<{ network: Network; list: Pool[] }>();
  const [nodes, setNodes] = createSignal<{ q: string; network: Network; list: Suggestion[] }>();
  // Kept by what was typed, not by the moment: today's moment is now, which moves on.
  // Kept with its cutoff's second once that has passed (dateKey): past midnight, the same text
  // asks again for the finished day.
  const [dated, setDated] = createSignal<{ key: string; network: Network; answer: Dated }>();
  // The explicit lookup under way, if any: "Looking up…" is drawn from it alone, and the lookup
  // clears it in its own `finally`, so no way it ends can leave the row looking.
  const [lookup, setLookup] = createSignal<{ token: number; id: string }>();
  const busy = () => lookup()?.id;
  const [note, setNote] = createSignal<{ id: string; text: string }>();
  // The selected row, by id: a row arriving late must not move the selection to another.
  const [activeKey, setActiveKey] = createSignal<string>();
  const [said, setSaid] = createSignal("");
  const [room, setRoom] = createSignal<number>();
  let dialog: HTMLDialogElement | undefined;
  let input: HTMLInputElement | undefined;
  // A phone's field holds only a short hint.
  const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 40em)").matches;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let left = false;
  // Closing (the opener's state) or unmounted: nothing more is run, asked or shown.
  let done = false;
  const ended = () => done || props.closing;
  // The scheduled asks (suggestions, a date's block) have a generation: an edit, a lookup or
  // closing makes an older one's answer stale.
  let asks = 0;
  let askTimer: ReturnType<typeof setTimeout> | undefined;
  const stopAsking = () => {
    asks += 1;
    clearTimeout(askTimer);
  };
  // The explicit lookup's token, kept in a plain variable as well: a signal's write is seen only
  // after the flush, and a lookup checks it right after its awaits.
  let token = 0;
  let lookupAbort: AbortController | undefined;
  const stopLookup = () => {
    token += 1;
    lookupAbort?.abort();
    lookupAbort = undefined;
    runner.cancel();
    setLookup(undefined);
  };
  /** Starts an explicit lookup for row `id`; `live` says whether it is still the current one. */
  const startLookup = (id: string) => {
    stopAsking();
    stopLookup();
    const mine = token;
    setLookup({ token: mine, id });
    setNote(undefined);
    lookupAbort = new AbortController();
    // A later choice made elsewhere meanwhile (an address's date) wins over this lookup.
    const latest = intend();
    return {
      signal: lookupAbort.signal,
      live: () => mine === token && !ended() && latest(),
      end: () => {
        if (mine === token) setLookup(undefined);
      },
    };
  };

  const offer = createMemo((): Offer => {
    const c = config();
    const n = network();
    return {
      network: n,
      networks: c !== null && c !== undefined && c.networks.length > 0 ? c.networks : [n],
      lightning: c?.lightning.includes(n) ?? false,
      ark: (c?.ark[n]?.length ?? 0) > 0,
      broadcast: c?.broadcast ?? false,
    };
  });

  // Navigating closes the palette by itself: the opener hears of every navigation.
  const go = (path: string) => {
    left = true;
    navigate(onNetwork(network(), path));
    props.onDismiss();
  };
  const act = (action: Action) => {
    if (action.kind === "theme") {
      toggleTheme();
      props.onDismiss();
      return;
    }
    left = true;
    navigate(
      onNetwork(action.network, stripNetwork(location.pathname)) + location.search + location.hash,
    );
    props.onDismiss();
  };

  // An identifier is looked up as the header search looks it up; a miss is said in its row.
  const lookUp = async (id: string, raw: string) => {
    const net = network();
    const run = startLookup(id);
    try {
      const outcome = await runner.run(raw, net);
      if (outcome === undefined || !run.live()) return;
      if (outcome.kind === "go") go(outcome.path);
      else if (outcome.kind === "missing") {
        setNote({ id, text: `Nothing on ${NETWORK_NAMES[net]} has this ID` });
      } else {
        const e = outcome.error;
        setNote({ id, text: e instanceof ApiError ? e.message : "Search could not finish" });
      }
    } finally {
      run.end();
    }
  };

  let dateAsk: AbortController | undefined;
  const askDate = blockAt;
  const dateText = (answer: Dated, net: Network): string =>
    answer.kind === "found"
      ? `Block ${groupDigits(answer.found.height)}, the newest by then`
      : answer.kind === "none"
        ? `This server's ${NETWORK_NAMES[net]} history has no block by then`
        : `Could not look this up: ${answer.message}`;
  const goToDate = async (id: string, q: string) => {
    // Read again now, not when the row was drawn: the day may have ended since.
    const moment = readDate(q, Date.now() / 1000);
    if (!moment) return;
    const net = network();
    const key = dateKey(q, moment);
    const known = dated();
    let answer = known?.key === key && known.network === net ? known.answer : undefined;
    // A failure is asked again; a block or its absence is kept.
    if (answer === undefined || answer.kind === "failed") {
      const run = startLookup(id);
      try {
        answer = await askDate(moment, net, run.signal);
      } catch {
        return;
      } finally {
        run.end();
      }
      if (!run.live()) return;
      setDated({ key, network: net, answer });
    }
    if (answer.kind === "found") go(paths.block(answer.found.hash));
    else setNote({ id, text: dateText(answer, net) });
  };

  const groups = createMemo((): Group[] => {
    const raw = text();
    const q = raw.trim();
    const net = network();
    const o = offer();
    const out: Group[] = [];
    const query = q === "" ? null : classify(q);
    const reading = q === "" ? undefined : describe(q, net, o.lightning);

    if (query !== null && reading?.ready === true) {
      const kind: Kind =
        query.kind === "hash"
          ? (query.as ?? "search")
          : query.kind === "height"
            ? "block"
            : query.kind;
      const n = note();
      const id = "search";
      out.push({
        name: "Search",
        best: FIRST,
        rows: [
          {
            id,
            kind,
            score: FIRST,
            title: query.kind === "height" ? reading.label : truncateMiddle(q, 18, 12),
            mono: query.kind !== "height",
            detail:
              busy() === id
                ? "Looking up…"
                : n?.id === id
                  ? n.text
                  : query.kind === "height"
                    ? undefined
                    : reading.label,
            run: () => void lookUp(id, q),
          },
        ],
      });
    }

    const moment = q === "" ? null : readDate(q, Date.now() / 1000);
    if (moment) {
      const id = "date";
      const d = dated();
      const answer = d?.key === dateKey(q, moment) && d.network === net ? d.answer : undefined;
      const n = note();
      const title = moment.timed ? `${moment.label} UTC` : `${moment.label}, end of the day UTC`;
      out.push({
        name: "Go to a date",
        best: FIRST,
        rows: [
          // Nothing is at or before a time before the first block: the nearest is block 0.
          moment.early
            ? {
                id,
                kind: "date",
                score: FIRST,
                title,
                detail: "Before the first block, 3 Jan 2009: opens block 0",
                run: () => go(paths.block(0)),
              }
            : {
                id,
                kind: "date",
                score: FIRST,
                title,
                detail:
                  busy() === id
                    ? "Looking up…"
                    : n?.id === id
                      ? n.text
                      : answer
                        ? dateText(answer, net)
                        : "The newest block by then, read in UTC",
                run: () => void goToDate(id, q),
              },
        ],
      });
    }

    const pageHits = ranked(q, pages(o), (p) => p);
    if (pageHits.length > 0) {
      out.push({
        name: "Pages",
        best: pageHits[0]?.score ?? 0,
        rows: pageHits.map(({ item: p, score }): Row => ({
          id: `page-${p.path}`,
          score,
          kind: "page",
          title: p.name,
          run: () => go(p.path),
        })),
      });
    }

    const p = pools();
    if (q !== "" && query === null && p?.network === net) {
      const hits = ranked(q, p.list, (pool) => ({ name: pool.name, words: [pool.slug] })).slice(
        0,
        MAX_POOLS,
      );
      if (hits.length > 0) {
        out.push({
          name: "Mining pools",
          best: hits[0]?.score ?? 0,
          rows: hits.map(({ item: pool, score }): Row => ({
            id: `pool-${pool.slug}`,
            score,
            kind: "pool",
            title: pool.name,
            run: () => go(paths.pool(pool.slug)),
          })),
        });
      }
    }

    const found = nodes();
    const named = o.lightning && q !== "" && query === null && reading?.ready === true;
    if (named) {
      const fresh = found?.q === q && found.network === net ? found.list : [];
      const rows = fresh.map((s): Row => ({
        id: `node-${s.key}`,
        score: NODES,
        kind: "node",
        title: s.name ?? "No name",
        detail: `${formatBtcShort(s.capacity)} BTC`,
        key: s.key,
        run: () => go(s.path),
      }));
      if (rows.length > 0) out.push({ name: "Lightning nodes", best: NODES, rows });
    }

    const actionHits = ranked(q, actions(o, scheme()), (a) => a);
    if (actionHits.length > 0) {
      out.push({
        name: "Actions",
        best: actionHits[0]?.score ?? 0,
        rows: actionHits.map(({ item: a, score }): Row => ({
          id: a.action.kind === "theme" ? "theme" : `network-${a.action.network}`,
          score,
          kind: a.action.kind,
          title: a.name,
          run: () => act(a.action),
        })),
      });
    }

    const ordered = orderGroups(out);
    // The catch-all comes last, after anything that matched by name.
    if (named) {
      ordered.push({
        name: "Lightning search",
        best: 0,
        rows: [
          {
            id: "lightning-search",
            kind: "search",
            title: `All Lightning results for “${truncateMiddle(q, 24, 8)}”`,
            run: () => go(paths.lightningSearch(q)),
          },
        ],
      });
    }
    return ordered;
  });

  const rows = createMemo(() => groups().flatMap((g) => g.rows));
  const optionId = (row: Row) => `palette-option-${row.id.replaceAll(/[^\w-]/g, "_")}`;
  const current = (): Row | undefined => {
    const key = activeKey();
    const all = rows();
    return all.find((r) => r.id === key) ?? all[0];
  };
  const active = () => {
    const row = current();
    return row ? rows().indexOf(row) : -1;
  };
  const activeId = () => {
    const row = current();
    return row ? optionId(row) : undefined;
  };

  // Every change of query puts the selection back on the first row, and makes a lookup under
  // way for the old one stale.
  createEffect(text, () => {
    setActiveKey(undefined);
    setNote(undefined);
    stopLookup();
  });

  // The row shown as selected is pinned by its id, the default included, when it matched by name:
  // a row arriving later above it must not take the selection, and Enter opens what the reader
  // saw selected. A weak default (letters in order, the Lightning catch-all) shows while the
  // names are still asked for and gives way to the first row until a strong one is pinned. The
  // reader's own move always pins (move). A pinned row that goes away hands the selection on.
  createEffect(current, (row) => {
    if (row && row.id !== activeKey() && (row.score ?? 0) >= PIN) setActiveKey(row.id);
  });

  // The selected row stays in sight; focus stays in the field, so the browser will not do it.
  createEffect(current, (row) => {
    if (!row) return;
    const el = document.getElementById(optionId(row));
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  });

  // The count is said once typing pauses, not with every key.
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => rows().length,
    (n) => {
      clearTimeout(sayTimer);
      sayTimer = setTimeout(
        () => setSaid(n === 0 ? "No results" : n === 1 ? "1 result" : `${n} results`),
        SAY_MS,
      );
    },
  );

  // The server is asked once typing pauses: pools on first need, then either the block at a date
  // or the Lightning nodes a name matches. Each new key aborts the request before it.
  createEffect(
    () => ({ q: text().trim(), net: network(), lightning: offer().lightning }),
    ({ q, net, lightning }) => {
      stopAsking();
      suggester.cancel();
      dateAsk?.abort();
      if (q === "") return;
      const mine = asks;
      // Whether this ask is still the latest, checked after every wait.
      const live = () => mine === asks && !ended();
      askTimer = setTimeout(() => {
        void (async () => {
          if (classify(q) === null && pools()?.network !== net) {
            const list = await loadPools(net);
            if (!live()) return;
            setPools({ network: net, list });
          }
          const moment = readDate(q, Date.now() / 1000);
          if (moment) {
            if (moment.early) return;
            dateAsk = new AbortController();
            try {
              const answer = await askDate(moment, net, dateAsk.signal);
              if (live()) setDated({ key: dateKey(q, moment), network: net, answer });
            } catch {
              // Aborted by a newer query, a lookup or closing.
            }
            return;
          }
          if (!lightning) return;
          const r = await suggester.suggest(q, net);
          if (r !== undefined && live()) setNodes({ q, network: net, list: r.nodes });
        })();
      }, ASK_MS);
    },
  );

  // The opener's closing: everything stops at once, the fade runs, then the dialog closes.
  const stopAll = () => {
    stopAsking();
    stopLookup();
    suggester.cancel();
    dateAsk?.abort();
  };
  createEffect(
    () => props.closing,
    (closing) => {
      if (!closing) return;
      stopAll();
      const finish = () => {
        clearTimeout(fallback);
        dialog?.removeEventListener("animationend", finish);
        if (dialog?.open === true) dialog.close();
      };
      // Under reduced motion there is no animation to wait for.
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const fallback = setTimeout(finish, still ? 0 : 400);
      if (!still) dialog?.addEventListener("animationend", finish);
    },
  );
  const close = () => props.onDismiss();

  onSettled(() => {
    void loadConfig().then((c) => setConfig(c));
    dialog?.showModal();
    input?.focus();
    input?.select();
    // The on-screen keyboard covers the page's foot without resizing it: the panel fits above it.
    const vv = window.visualViewport;
    const fit = () => setRoom(vv ? Math.round(vv.height) : undefined);
    fit();
    vv?.addEventListener("resize", fit);
    return () => vv?.removeEventListener("resize", fit);
  });
  onCleanup(() => {
    done = true;
    clearTimeout(sayTimer);
    stopAll();
  });

  /** Runs a row, but only while open: never during the fade (opener.ts `active`). */
  const runRow = (row: Row | undefined) => {
    if (!ended()) row?.run();
  };

  const rowAt = (target: EventTarget | null): number | undefined => {
    const row = target instanceof Element ? target.closest<HTMLElement>("[data-index]") : null;
    const i = Number(row?.dataset["index"]);
    return row && Number.isInteger(i) && i >= 0 ? i : undefined;
  };

  const move = (to: number) => {
    const all = rows();
    const n = all.length;
    if (n > 0) setActiveKey(all[((to % n) + n) % n]?.id);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const i = active();
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home" && !e.shiftKey) move(0);
    else if (e.key === "End" && !e.shiftKey) move(rows().length - 1);
    else if (e.key === "Enter") runRow(current());
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  };

  return (
    // A press on the backdrop closes the palette; Escape is the keyboard's way (onCancel).
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a click on the dialog itself is a click on its backdrop
    <dialog
      ref={dialog}
      class={["palette", { "palette--closing": props.closing }]}
      aria-label="Go to"
      style={{ "--palette-room": room() === undefined ? undefined : `${room()}px` }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={() => {
        if (!left && opener?.isConnected === true) opener.focus({ preventScroll: true });
        props.onClosed();
      }}
      onClick={(e) => {
        // The panel fills the dialog, so a click on the dialog itself is on the backdrop.
        if (e.target === dialog) close();
      }}
    >
      <div class="palette__panel">
        <div class="palette__field">
          <svg class="palette__glass" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="M12.6 12.6 17 17" />
          </svg>
          <input
            ref={input}
            class="palette__input"
            type="text"
            role="combobox"
            aria-label="Go to"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeId()}
            aria-describedby="palette-hints"
            placeholder={
              narrow ? "Page, pool, date or ID" : "Page, pool, date, block, transaction or address"
            }
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="go"
            maxlength={8192}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKey}
          />
        </div>
        {/* The field keeps focus and takes the keys: a press on a row must not take it first. A
            pointer that moves over a row selects it; one that only sits there while the list
            changes under it does not. */}
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the combobox field handles the keys */}
        <div
          id="palette-list"
          class="palette__list"
          role="listbox"
          aria-label="Results"
          aria-busy={busy() === undefined ? "false" : "true"}
          tabindex="-1"
          onPointerDown={(e) => e.preventDefault()}
          onPointerMove={(e) => {
            const i = rowAt(e.target);
            if (i !== undefined && i !== active()) move(i);
          }}
          onClick={(e) => {
            const i = rowAt(e.target);
            if (i !== undefined) runRow(rows()[i]);
          }}
        >
          <Show
            when={rows().length > 0}
            fallback={
              <p class="palette__empty" role="presentation">
                Nothing here goes by that name. Try a page, a pool, a date such as{" "}
                <span class="palette__eg">2024-04-20</span>, or a block, transaction or address.
              </p>
            }
          >
            <For each={groups()}>
              {(group) => (
                <div
                  class="palette__group"
                  role="group"
                  aria-labelledby={`palette-g-${group.name.replaceAll(" ", "-").toLowerCase()}`}
                >
                  <div
                    class="palette__heading"
                    id={`palette-g-${group.name.replaceAll(" ", "-").toLowerCase()}`}
                    role="presentation"
                  >
                    {group.name}
                  </div>
                  <For each={group.rows}>
                    {(row) => {
                      const at = createMemo(() => rows().indexOf(row));
                      return (
                        <div
                          id={optionId(row)}
                          class={["palette__row", `palette__row--${row.kind}`]}
                          role="option"
                          aria-selected={at() === active() ? "true" : "false"}
                          data-index={at()}
                        >
                          <Icon kind={row.kind} />
                          <span class="palette__text">
                            <span class={["palette__title", { mono: row.mono === true }]}>
                              {row.title}
                            </span>
                            <Show when={row.key}>
                              {(key) => (
                                <span class="palette__key mono">{truncateMiddle(key(), 8, 8)}</span>
                              )}
                            </Show>
                            <Show when={row.detail}>
                              {(d) => <span class="palette__detail">{d()}</span>}
                            </Show>
                          </span>
                          <span class="palette__kind">{KIND_WORDS[row.kind]}</span>
                        </div>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </div>
        <div class="palette__foot" id="palette-hints">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
          <span class="palette__net">On {NETWORK_NAMES[network()]}</span>
        </div>
        <span class="visually-hidden" role="status">
          {said()}
        </span>
      </div>
    </dialog>
  );
}

/** Each kind's mark, drawn on a 20 px square: never from data. */
const ICONS: Record<Kind, string> = {
  page: "M5 3.5h7l3 3v10H5zM12 3.5v3h3M7.5 10h5M7.5 13h4",
  pool: "M3.5 15.5h13M5 12h10M7 8.5h6M9 5h4",
  date: "M4 5.5h12v11H4zM4 8.5h12M7.5 3.5v3M12.5 3.5v3M7 12h2",
  block: "M4 7h9v9.5H4zM4 7l3-3h9v9.5l-3 3M13 7l3-3",
  tx: "M4 7h11M12 4l3 3-3 3M16 13H5M8 10l-3 3 3 3",
  address:
    "M10 17s-5-4.6-5-8.5a5 5 0 0 1 10 0c0 3.9-5 8.5-5 8.5zM10 10.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  node: "M11 3 5 11h4.5L9 17l6-8h-4.5z",
  channel: "M11 3 5 11h4.5L9 17l6-8h-4.5z",
  payment: "M11 3 5 11h4.5L9 17l6-8h-4.5z",
  network: "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  theme: "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 3.5v13",
  search: "M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM12.6 12.6 17 17",
};

function Icon(props: { kind: Kind }): JSX.Element {
  return (
    <span class="palette__icon" aria-hidden="true">
      <svg viewBox="0 0 20 20">
        <path d={ICONS[props.kind]} />
      </svg>
    </span>
  );
}
