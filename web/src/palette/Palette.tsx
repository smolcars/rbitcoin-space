// The command palette: one field that goes anywhere. Loaded on first open (PaletteKey.tsx); the
// header search's logic (search/search.ts) reads identifiers, so the two never disagree.
import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiError, fetchApi } from "../lib/api";
import { type AppConfig, loadConfig } from "../lib/config";
import { formatBtcShort, groupDigits, truncateMiddle } from "../lib/format";
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
  pages,
  rank,
  readDate,
  readPools,
} from "./match";
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
  run: () => void;
}

interface Group {
  name: string;
  rows: Row[];
}

/** Pools by network, asked for once per page load. */
const poolLists = new Map<Network, Promise<Pool[]>>();
function loadPools(network: Network): Promise<Pool[]> {
  let list = poolLists.get(network);
  if (!list) {
    list = fetchApi<unknown>(network, "/v1/mining/pools").then(
      (body) => readPools(body, cleanAlias),
      // A server without a block table has no pool list: the palette offers none.
      () => [],
    );
    poolLists.set(network, list);
  }
  return list;
}

interface Found {
  height: number;
  hash: string;
}

const isFound = (v: unknown): v is Found =>
  typeof v === "object" &&
  v !== null &&
  "height" in v &&
  typeof v.height === "number" &&
  "hash" in v &&
  typeof v.hash === "string" &&
  /^[0-9a-f]{64}$/.test(v.hash);

export interface PaletteProps {
  /** What the field starts with: the header search's text when the palette is opened from it. */
  initial: string;
  /** Gives the opener a way to close it (the shortcut pressed again). */
  control: (close: () => void) => void;
  /** Called once the palette has closed and may be removed. */
  onClosed: () => void;
}

export default function Palette(props: PaletteProps): JSX.Element {
  const network = useNetwork();
  const navigate = useNavigate();
  const location = useLocation();
  const searcher = createSearch();
  const [text, setText] = createSignal(props.initial);
  const [config, setConfig] = createSignal<AppConfig | null>();
  const [pools, setPools] = createSignal<{ network: Network; list: Pool[] }>();
  const [nodes, setNodes] = createSignal<{ q: string; network: Network; list: Suggestion[] }>();
  const [dated, setDated] = createSignal<{ at: number; network: Network; found: Found | null }>();
  // A row the reader ran that is still looking, or what it found instead of a page.
  const [busy, setBusy] = createSignal<string>();
  const [note, setNote] = createSignal<{ id: string; text: string }>();
  const [active, setActive] = createSignal(0);
  const [said, setSaid] = createSignal("");
  const [closing, setClosing] = createSignal(false);
  const [room, setRoom] = createSignal<number>();
  let dialog: HTMLDialogElement | undefined;
  let input: HTMLInputElement | undefined;
  // A phone's field holds only a short hint.
  const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 40em)").matches;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let left = false;

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

  const go = (path: string) => {
    left = true;
    navigate(onNetwork(network(), path));
    close();
  };
  const act = (action: Action) => {
    if (action.kind === "theme") {
      toggleTheme();
      close();
      return;
    }
    left = true;
    navigate(
      onNetwork(action.network, stripNetwork(location.pathname)) + location.search + location.hash,
    );
    close();
  };

  // An identifier is looked up as the header search looks it up; a miss is said in its row.
  const lookUp = async (id: string, raw: string) => {
    const net = network();
    setNote(undefined);
    setBusy(id);
    const outcome = await searcher.run(raw, net);
    if (outcome === undefined) return;
    setBusy(undefined);
    if (outcome.kind === "go") go(outcome.path);
    else if (outcome.kind === "missing") {
      setNote({ id, text: `Nothing on ${NETWORK_NAMES[net]} has this ID` });
    } else {
      const e = outcome.error;
      setNote({ id, text: e instanceof ApiError ? e.message : "Search could not finish" });
    }
  };

  let dateAsk: AbortController | undefined;
  const askDate = async (moment: Moment, net: Network): Promise<Found | null> => {
    dateAsk?.abort();
    const controller = new AbortController();
    dateAsk = controller;
    try {
      const body = await fetchApi<unknown>(net, `/v1/mining/blocks/timestamp/${moment.at}`, {
        signal: controller.signal,
      });
      return isFound(body) ? body : null;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return null;
    } finally {
      if (dateAsk === controller) dateAsk = undefined;
    }
  };
  const goToDate = async (id: string, moment: Moment) => {
    const net = network();
    const known = dated();
    let found = known?.at === moment.at && known.network === net ? known.found : undefined;
    if (found === undefined) {
      setBusy(id);
      try {
        found = await askDate(moment, net);
      } catch {
        return;
      }
      setBusy(undefined);
    }
    if (found) go(paths.block(found.hash));
    else setNote({ id, text: `No block on ${NETWORK_NAMES[net]} by then` });
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
        rows: [
          {
            id,
            kind,
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
      const found = d?.at === moment.at && d.network === net ? d.found : undefined;
      const n = note();
      out.push({
        name: "Go to a date",
        rows: [
          {
            id,
            kind: "date",
            title: moment.timed ? `${moment.label} UTC` : `${moment.label}, end of the day UTC`,
            detail:
              busy() === id
                ? "Looking up…"
                : n?.id === id
                  ? n.text
                  : found
                    ? `Block ${groupDigits(found.height)}, the newest by then`
                    : found === null
                      ? `No block on ${NETWORK_NAMES[net]} by then`
                      : "The newest block by then, read in UTC",
            run: () => void goToDate(id, moment),
          },
        ],
      });
    }

    const pageRows = rank(q, pages(o), (p) => p).map((p): Row => ({
      id: `page-${p.path}`,
      kind: "page",
      title: p.name,
      run: () => go(p.path),
    }));
    if (pageRows.length > 0) out.push({ name: "Pages", rows: pageRows });

    const p = pools();
    if (q !== "" && query === null && p?.network === net) {
      const rows = rank(q, p.list, (pool) => ({ name: pool.name, words: [pool.slug] }))
        .slice(0, MAX_POOLS)
        .map((pool): Row => ({
          id: `pool-${pool.slug}`,
          kind: "pool",
          title: pool.name,
          run: () => go(paths.pool(pool.slug)),
        }));
      if (rows.length > 0) out.push({ name: "Mining pools", rows });
    }

    const found = nodes();
    if (o.lightning && q !== "" && query === null && reading?.ready === true) {
      const fresh = found?.q === q && found.network === net ? found.list : [];
      out.push({
        name: "Lightning nodes",
        rows: [
          ...fresh.map((s): Row => ({
            id: `node-${s.key}`,
            kind: "node",
            title: s.name ?? "No name",
            detail: `${formatBtcShort(s.capacity)} BTC`,
            key: s.key,
            run: () => go(s.path),
          })),
          {
            id: "lightning-search",
            kind: "search",
            title: `All Lightning results for “${truncateMiddle(q, 24, 8)}”`,
            run: () => go(paths.lightningSearch(q)),
          },
        ],
      });
    }

    const actionRows = rank(q, actions(o, scheme()), (a) => a).map((a): Row => ({
      id: a.action.kind === "theme" ? "theme" : `network-${a.action.network}`,
      kind: a.action.kind,
      title: a.name,
      run: () => act(a.action),
    }));
    if (actionRows.length > 0) out.push({ name: "Actions", rows: actionRows });
    return out;
  });

  const rows = createMemo(() => groups().flatMap((g) => g.rows));
  const optionId = (row: Row) => `palette-option-${row.id.replaceAll(/[^\w-]/g, "_")}`;
  const current = () => rows()[Math.min(active(), rows().length - 1)];
  const activeId = () => {
    const row = current();
    return row ? optionId(row) : undefined;
  };

  // Every change of query puts the selection back on the first row.
  createEffect(text, () => {
    setActive(0);
    setNote(undefined);
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
  let askTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => ({ q: text().trim(), net: network(), lightning: offer().lightning }),
    ({ q, net, lightning }) => {
      clearTimeout(askTimer);
      searcher.cancel();
      dateAsk?.abort();
      if (q === "") return;
      askTimer = setTimeout(() => {
        void (async () => {
          if (classify(q) === null && pools()?.network !== net) {
            const list = await loadPools(net);
            if (network() === net) setPools({ network: net, list });
          }
          const moment = readDate(q, Date.now() / 1000);
          if (moment) {
            try {
              const found = await askDate(moment, net);
              setDated({ at: moment.at, network: net, found });
            } catch {
              // Aborted by a newer query.
            }
            return;
          }
          if (!lightning) return;
          const r = await searcher.suggest(q, net);
          if (r !== undefined) setNodes({ q, network: net, list: r.nodes });
        })();
      }, ASK_MS);
    },
  );

  const close = () => {
    if (closing() || !dialog?.open) return;
    setClosing(true);
    clearTimeout(askTimer);
    searcher.cancel();
    dateAsk?.abort();
    const done = () => {
      clearTimeout(fallback);
      dialog?.removeEventListener("animationend", done);
      if (dialog?.open) dialog.close();
    };
    // Under reduced motion there is no animation to wait for.
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fallback = setTimeout(done, still ? 0 : 400);
    if (!still) dialog.addEventListener("animationend", done);
  };
  props.control(close);

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
    clearTimeout(askTimer);
    clearTimeout(sayTimer);
    searcher.cancel();
    dateAsk?.abort();
  });

  const rowAt = (target: EventTarget | null): number | undefined => {
    const row = target instanceof Element ? target.closest<HTMLElement>("[data-index]") : null;
    const i = Number(row?.dataset["index"]);
    return row && Number.isInteger(i) && i >= 0 ? i : undefined;
  };

  const move = (to: number) => {
    const n = rows().length;
    if (n > 0) setActive(((to % n) + n) % n);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const i = Math.min(active(), rows().length - 1);
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home" && !e.shiftKey) move(0);
    else if (e.key === "End" && !e.shiftKey) move(rows().length - 1);
    else if (e.key === "Enter") current()?.run();
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  };

  return (
    // A press on the backdrop closes the palette; Escape is the keyboard's way (onCancel).
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a click on the dialog itself is a click on its backdrop
    <dialog
      ref={dialog}
      class={["palette", { "palette--closing": closing() }]}
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
            if (i !== undefined && i !== active()) setActive(i);
          }}
          onClick={(e) => {
            const i = rowAt(e.target);
            if (i !== undefined) rows()[i]?.run();
          }}
        >
          <Show
            when={rows().length > 0}
            fallback={
              <p class="palette__empty" role="presentation">
                Nothing here goes by that name. Try a page, a pool, a date such as 2024-04-20, or a
                block, transaction or address.
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
