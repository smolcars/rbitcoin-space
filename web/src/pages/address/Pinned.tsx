// The address page as of a past block (`?at=<height>`): the block field that picks one, the band
// that says which block the page shows, and the page itself, every read pinned to that block's
// hash. Nothing live: no topic, no ledger, no refresh. docs/FRONTEND.md "An address as of a block".
import { useBeforeLeave, useLocation, useNavigate } from "@solidjs/router";
import {
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import "../../components/Button.css";
import { Amount } from "../../components/Amount";
import { openPop } from "../../components/pop";
import { Link } from "../../components/Link";
import { ErrorState } from "../../components/States";
import { TimeAgo, TimeUtc } from "../../components/Time";
import {
  busyRetrying,
  createApi,
  createRequest,
  fetchApi,
  fetchStamped,
  isNotFound,
} from "../../lib/api";
import type { AddressStats, Transaction } from "../../lib/esplora";
import { groupDigits } from "../../lib/format";
import { NETWORK_NAMES, type Network, paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { blockAt } from "../../palette/block-at";
import { refusal } from "./address";
import {
  type At,
  type Pinned,
  pinnedPath,
  readPinned,
  readTip,
  readTyped,
  nextChange,
  previousChange,
  PAGE_ROWS,
  type Since,
  type Step,
  compareNow,
  unusedThen,
} from "./asof";
import { loadHistory, MAX_PAGES, MAX_ROWS, readRows } from "./balance";
import { BalanceChart } from "./BalanceChart";
import { History } from "./History";
import { createLookalikes } from "./LookalikeNotice";
import { Notice, Skeleton, settled } from "./parts";
import { Totals } from "./Totals";

/**
 * Where focus goes once a page this file navigated to arrives: the control the reader pressed is
 * gone with the page it was on, and focus would fall to the body with no word that the page
 * changed. To the band's heading for a block (read out as the page's new subject), or to "As of
 * a block" back on the live page. Set by this file's own navigations, just before them, scoped to
 * the page key and `at` they go to.
 */
let arriving: { page: string; at: string | undefined } | undefined;
function arrive(page: string, at: string | undefined): void {
  arriving = { page, at };
}

/**
 * Settles the focus request for this visit: in `onSettled`, which runs once the visit's page has
 * committed and never for one disposed before that (a move overtaken by another). The router
 * commits one move at a time, so the first visit to settle after a request is the one it was
 * made for, or one that overtook it: it takes the request either way, and focuses only if it is
 * its own. `page` is the settled key `AddressPage` passes down: no router or network read here.
 */
function useArrival(target: () => HTMLElement | undefined, page: string, at: string | undefined) {
  onSettled(() => {
    const was = arriving;
    if (was === undefined) return;
    arriving = undefined;
    const el = target();
    if (was.page === page && was.at === at && el?.isConnected === true) el.focus();
  });
}

/**
 * Moves to this page at block `at` (or now): a navigation built from the page it is asked on
 * (its path and its other parameters, such as `?view=`), never merged into wherever the router
 * may be heading meanwhile.
 */
function useGo(page: () => string): (at: string | undefined, focus?: boolean) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (at, focus = true) => {
    const params = new URLSearchParams(location.search);
    if (at === undefined) params.delete("at");
    else params.set("at", at);
    if (focus) arrive(page(), at);
    const query = params.toString();
    navigate(`${location.pathname}${query === "" ? "" : `?${query}`}`, { scroll: false });
  };
}

/**
 * The block field: a height, or a date (UTC) for the newest block by the end of that day, as the
 * command palette reads one. A height goes into the URL as it is; a date is asked of the server
 * first, and its block's height goes in.
 */
export function AsOfForm(props: {
  id: string;
  /** The page it belongs to: its network and normalised address, as `AddressPage` keys it. */
  page: string;
  current?: number | undefined;
  /** Takes focus once shown: it opened at the reader's asking. */
  focus?: boolean;
  /** The block asked is the one shown: nothing to navigate to. */
  onSame?: () => void;
}) {
  const network = useNetwork();
  const go = useGo(() => props.page);
  const [note, setNote] = createSignal<string>();
  /** The newest block, named when the reader asked for a day still to come. */
  const [newest, setNewest] = createSignal<number>();
  const [asking, setAsking] = createSignal(false);
  let ask: AbortController | undefined;
  onCleanup(() => ask?.abort());
  const show = (height: number) => {
    if (height === props.current) {
      props.onSame?.();
      return;
    }
    go(String(height));
  };
  // The reader's later move wins: any navigation begun while a date is looked up drops the lookup,
  // so its block cannot overtake a link followed since. Nothing is kept: the field submits again.
  useBeforeLeave(() => ask?.abort());
  const noteId = `${props.id}-note`;
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const target = e.currentTarget;
    if (!(target instanceof HTMLFormElement)) return;
    const value = new FormData(target).get("at");
    const typed = readTyped(typeof value === "string" ? value : "", Date.now() / 1000);
    ask?.abort();
    setAsking(false);
    setNewest(undefined);
    if (typed.kind === "empty") {
      setNote("Type a block height, such as 840000, or a date, such as 2024-04-20.");
      return;
    }
    if (typed.kind === "invalid") {
      setNote("That is neither a block height nor a date. Try 840000 or 2024-04-20.");
      return;
    }
    if (typed.kind === "height") {
      setNote(undefined);
      show(typed.height);
      return;
    }
    const net = network();
    const controller = new AbortController();
    ask = controller;
    setAsking(true);
    setNote(undefined);
    try {
      // A day still to come has no block: said as a height past the tip is, naming the newest.
      if (typed.kind === "future") {
        const tip = await fetchApi<string>(net, "/blocks/tip/height", {
          as: "text",
          signal: controller.signal,
          fresh: true,
        }).then(readTip, () => undefined);
        if (controller.signal.aborted) return;
        setNewest(tip);
        setNote(
          `${typed.label} has not come yet.${tip === undefined ? "" : ` The newest block is ${groupDigits(tip)}.`}`,
        );
        return;
      }
      const answer = await blockAt(typed.moment, net, controller.signal);
      if (controller.signal.aborted) return;
      if (answer.kind === "found") show(answer.found.height);
      else if (answer.kind === "none") {
        setNote(
          `This server's ${NETWORK_NAMES[net]} history has no block by ${typed.moment.label}.`,
        );
      } else setNote(`Could not look up that date: ${answer.message}`);
    } catch {
      // Aborted: another submit or the page went away.
    } finally {
      if (ask === controller) setAsking(false);
    }
  };
  return (
    <form class="address-asof-form" onSubmit={(e) => void submit(e)} novalidate>
      <label class="address-asof-form__label" for={props.id}>
        Block height or date
      </label>
      <div class="address-asof-form__row">
        <input
          id={props.id}
          name="at"
          class="address-asof-form__input num"
          inputmode="text"
          autocomplete="off"
          spellcheck={false}
          placeholder="840000 or 2024-04-20"
          ref={(el) => {
            // Set once: a bound value would be put back over what the reader types.
            el.value = props.current === undefined ? "" : String(props.current);
            // A frame later, once it is in the document.
            if (props.focus === true)
              requestAnimationFrame(() => {
                el.focus({ preventScroll: true });
                el.select();
              });
          }}
          aria-invalid={note() === undefined ? "false" : "true"}
          aria-describedby={`${props.id}-hint${note() === undefined ? "" : ` ${noteId}`}`}
          onInput={() => {
            setNote(undefined);
            setNewest(undefined);
          }}
        />
        <button class="btn btn--accent" type="submit" aria-disabled={asking() ? "true" : "false"}>
          {asking() ? "Looking up…" : "Show"}
        </button>
      </div>
      <p class="address-asof-form__hint" id={`${props.id}-hint`}>
        A date shows the last block of that day, in UTC.
      </p>
      <Show when={note()}>
        {(text) => (
          <p class="address-asof-form__note" id={noteId} role="alert">
            {text()}
          </p>
        )}
      </Show>
      {/* Wrapped, so a newest block at height 0 (a new chain) is not taken for none. */}
      <Show when={boxed(newest())}>
        {(n) => (
          <p>
            <button class="btn" type="button" onClick={() => show(n().height)}>
              Show block {groupDigits(n().height)}
            </button>
          </p>
        )}
      </Show>
    </form>
  );
}

/** A clock: the way to choose the block a page is read at. */
export function ClockIcon() {
  return (
    <svg class="address-asof__clock" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

/** Layers with a line drawn through them at a depth: the page is read at one block of the chain. */
function DepthMark() {
  return (
    <svg class="address-asof__mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="3" width="16" height="4" rx="1" />
      <rect x="4" y="9" width="16" height="4" rx="1" />
      <rect x="4" y="15" width="16" height="6" rx="1" />
      <path class="address-asof__cut" d="M1 13.9h22" />
    </svg>
  );
}

/** A height for `Show`/`Match`, which take 0 for "nothing": block 0 is a block. */
const boxed = (height: number | undefined): { height: number } | undefined =>
  height === undefined ? undefined : { height };

/** From this width the block field opens over the page, under its button; below, in the page. */
const OVER = "(min-width: 65em)";

/**
 * A button that opens the block field: from 65em over the page, anchored under the button so
 * nothing moves (components/pop.ts closes it on a press outside or Escape); narrower, in the page
 * under the button's row. Either way the field takes focus, a close button and Escape close it,
 * and focus returns to the button. Place it in a wrapping flex row that is `position: relative`.
 */
export function AsOfPicker(props: {
  id: string;
  page: string;
  title: string;
  label: JSX.Element;
  class?: string;
  current?: number | undefined;
  /** Takes focus when the reader came back here from a past block ("Back to now"). */
  arrival?: boolean;
  /** Its name, where its label may be hidden (a phone shows the icon alone). */
  name?: string;
}) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  let closePop: (() => void) | undefined;
  // In the page, Escape is heard here (pop.ts hears it over the page), and only while focus is
  // in the field or on its button: an Escape for another pop-up (the QR code) is that one's.
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const at = document.activeElement;
    if (!(panel?.contains(at) === true || at === button)) return;
    shut();
    button?.focus();
  };
  // Across 65em its form would change under it (floating with no press outside to close it, or
  // the reverse): it closes instead.
  let media: MediaQueryList | undefined;
  const crossed = () => shut();
  /** Every way it closes ends here: its listeners go, whoever closed it. */
  const closed = () => {
    document.removeEventListener("keydown", escape);
    media?.removeEventListener("change", crossed);
    media = undefined;
    setOpen(false);
  };
  const shut = () => {
    const close = closePop;
    closePop = undefined;
    // pop.ts calls back `closed` (below) as it closes; in the page, there is no pop to close.
    if (close === undefined) closed();
    else close();
  };
  const show = () => {
    setOpen(true);
    media = window.matchMedia(OVER);
    media.addEventListener("change", crossed);
    if (!media.matches) {
      document.addEventListener("keydown", escape);
      return;
    }
    closePop = openPop(
      () => {
        closePop = undefined;
        // Closed by a press outside while it held focus: focus goes back to its button.
        if (panel?.contains(document.activeElement) === true)
          button?.focus({ preventScroll: true });
        closed();
      },
      () => [button, panel],
    );
  };
  onCleanup(shut);
  if (props.arrival === true) useArrival(() => button, props.page, undefined);
  return (
    <>
      <button
        ref={button}
        class={`btn address-asof-picker ${props.class ?? ""}`}
        type="button"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={props.id}
        aria-label={props.name}
        onClick={() => (open() ? shut() : show())}
      >
        {props.label}
      </button>
      <div
        ref={panel}
        id={props.id}
        class="address-asof-pop"
        role="group"
        aria-labelledby={`${props.id}-title`}
        hidden={!open()}
      >
        <Show when={open()}>
          <div class="address-asof-pop__head">
            <p class="address-asof-pop__title" id={`${props.id}-title`}>
              {props.title}
            </p>
            <button
              class="address-asof-pop__close"
              type="button"
              aria-label="Close"
              onClick={() => {
                shut();
                button?.focus();
              }}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
          <AsOfForm
            id={`${props.id}-at`}
            page={props.page}
            current={props.current}
            focus
            onSame={() => {
              // The block shown: close, and focus its heading, the page's subject, read out.
              shut();
              document.getElementById("address-asof-title")?.focus();
            }}
          />
        </Show>
      </div>
    </>
  );
}

type Resolved = { kind: "block"; block: Pinned } | { kind: "future"; tip: number };

/** Height lookups that may answer 404 while the tip already reaches the height, before giving up. */
const LOOKUPS = 3;

/**
 * A height on the best chain now: its hash, then that block's time. Not found, the tip is read to
 * name the newest block; a tip at or above the height means the block was mined between the two
 * answers, and the height is looked up again.
 */
async function resolve(net: Network, height: number, signal: AbortSignal): Promise<Resolved> {
  /** The height's hash, or undefined when the node does not know the height (404). */
  const lookup = async (): Promise<string | undefined> => {
    try {
      const h = await fetchApi<string>(net, `/block-height/${height}`, {
        as: "text",
        signal,
        fresh: true,
      });
      return h.trim();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };
  let hash = await lookup();
  for (let i = 1; hash === undefined; i++) {
    // oxlint-disable-next-line no-await-in-loop -- only after a 404
    const tip = await fetchApi<string>(net, "/blocks/tip/height", {
      as: "text",
      signal,
      fresh: true,
    }).then(readTip, () => undefined);
    // Not mined only when a tip was read and falls short of the height; a tip that cannot be
    // read says nothing, and is a failure to look the block up, with Try again.
    if (tip === undefined) throw new Error("The node did not say how far its chain reaches.");
    if (tip < height) {
      // The tip may come from the server's one-second cache, from before the block was found:
      // the height is looked up once more, so "not mined" is true as of the page's last lookup.
      // oxlint-disable-next-line no-await-in-loop -- once, and the loop ends after it
      hash = await lookup();
      if (hash === undefined) return { kind: "future", tip };
      break;
    }
    if (i >= LOOKUPS) throw new Error(`The node does not answer for block ${height} yet.`);
    // oxlint-disable-next-line no-await-in-loop -- each lookup follows the tip read before it
    hash = await lookup();
  }
  const block = /^[0-9a-f]{64}$/.test(hash)
    ? await fetchApi<unknown>(net, `/block/${hash}`, { signal })
    : undefined;
  const pinned = readPinned(hash, block, height);
  if (pinned === undefined) throw new Error("The node's answer for this block could not be read.");
  return { kind: "block", block: pinned };
}

/**
 * The page as of `at`. Made afresh when the reader asks to look the height up again (a block that
 * left the best chain), so nothing from the last hash lingers.
 */
export function PinnedBody(props: {
  address: string;
  isKey: boolean;
  at: At;
  /** This page's settled key, as `AddressPage` keys it: network and normalised address. */
  page: string;
}) {
  const [round, setRound] = createSignal(1);
  return (
    <Show when={round()} keyed>
      {(_round) => {
        const at = untrack(() => props.at);
        return at.kind === "height" ? (
          <PinnedAt
            address={props.address}
            isKey={props.isKey}
            height={at.height}
            page={props.page}
            again={() => setRound((r) => r + 1)}
          />
        ) : (
          <NotAHeight text={at.kind === "invalid" ? at.text : ""} page={props.page} />
        );
      }}
    </Show>
  );
}

/** Shown in a step button while what it leads to is still being worked out. */
interface Pending {
  kind: "pending";
}

/**
 * The band's actions: back to the present, a step to the address's previous and next change (one
 * block rarely changes an address, so a step of one block would mostly lead to the same page), and
 * another block. A step that cannot be known cheaply is not offered; one being worked out holds
 * its place, unpressable, so the row does not move when it lands.
 */
function Actions(props: {
  page: string;
  height?: number | undefined;
  /** The newest block, read when the height asked is past it: a step straight back to it. */
  newest?: number | undefined;
  previous?: Step | Pending | undefined;
  next?: Step | Pending | undefined;
}) {
  const to = useGo(() => props.page);
  const go = (h: number) => to(String(h));
  const target = (s: Step | Pending | undefined) =>
    s !== undefined && s.kind !== "none" && s.kind !== "pending" ? s.height : undefined;
  /** What a step is called, with its block once known: its name, and its label on a desktop. */
  const name = (s: Step | Pending | undefined, back: boolean): string => {
    const h = target(s);
    const block = h === undefined ? "" : `: block ${groupDigits(h)}`;
    if (s?.kind === "before-first") return `Before first use${block}`;
    if (s?.kind === "first") return `First used at block ${groupDigits(h ?? 0)}`;
    return `${back ? "Previous" : "Next"} change${block}`;
  };
  const label = (s: Step | Pending | undefined, back: boolean): string => {
    if (s?.kind === "before-first") return "Before first use";
    if (s?.kind === "first") return name(s, back);
    return back ? "Previous change" : "Next change";
  };
  const shown = (s: Step | Pending | undefined) => s !== undefined && s.kind !== "none";
  return (
    <div class="address-asof__actions">
      <button class="btn btn--accent" type="button" onClick={() => to(undefined)}>
        Back to now
      </button>
      <Show when={boxed(props.newest)}>
        {(n) => (
          <button
            class="btn"
            type="button"
            aria-label={`Show block ${groupDigits(n().height)}`}
            onClick={() => go(n().height)}
          >
            Show <span class="address-asof__long">block </span>
            {groupDigits(n().height)}
          </button>
        )}
      </Show>
      {/* On a phone the steps are their arrows alone, 44 px square and named in full, under a
          caption that says what they step between: one block rarely changes an address. */}
      <Show when={shown(props.previous) || shown(props.next)}>
        <div class="address-asof__steps" role="group" aria-labelledby="address-asof-steps">
          <span class="address-asof__steps-label" id="address-asof-steps">
            {props.next?.kind === "first" && !shown(props.previous) ? "First use" : "Changes"}
          </span>
          <div class="address-asof__arrows">
            <Show when={shown(props.previous)}>
              <button
                class="btn address-asof__step"
                type="button"
                aria-disabled={props.previous?.kind === "pending" ? "true" : "false"}
                aria-label={name(props.previous, true)}
                title={name(props.previous, true)}
                onClick={() => {
                  const h = target(props.previous);
                  if (h !== undefined) go(h);
                }}
              >
                <span aria-hidden="true">‹</span>
                <span class="address-asof__label" aria-hidden="true">
                  {label(props.previous, true)}
                </span>
              </button>
            </Show>
            <Show when={shown(props.next)}>
              <button
                class="btn address-asof__step"
                type="button"
                aria-disabled={props.next?.kind === "pending" ? "true" : "false"}
                aria-label={name(props.next, false)}
                title={name(props.next, false)}
                onClick={() => {
                  const h = target(props.next);
                  if (h !== undefined) go(h);
                }}
              >
                <span class="address-asof__label" aria-hidden="true">
                  {label(props.next, false)}
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </Show>
          </div>
        </div>
      </Show>
      <AsOfPicker
        id="address-asof-other"
        page={props.page}
        title="Show another block"
        name="Another block"
        class="address-asof__step"
        label={
          <>
            <ClockIcon />
            <span class="address-asof__label" aria-hidden="true">
              Another block
            </span>
          </>
        }
        current={props.height}
      />
    </div>
  );
}

/** `?at=` that is not a height: said, with the field to give one and the way back. */
function NotAHeight(props: { text: string; page: string }) {
  let heading: HTMLHeadingElement | undefined;
  useArrival(() => heading, props.page, props.text);
  return (
    <section class="address-asof panel" aria-labelledby="address-asof-title">
      <div class="address-asof__body">
        <div class="address-asof__head">
          <DepthMark />
          <h2 class="address-asof__title" id="address-asof-title" tabindex="-1" ref={heading}>
            {`“${props.text}” is not a block height`}
          </h2>
        </div>
        <p class="address-asof__what">
          The link names no block this page can read. Give a height in digits, or a date.
        </p>
      </div>
      <Actions page={props.page} />
    </section>
  );
}

function PinnedAt(props: {
  address: string;
  isKey: boolean;
  height: number;
  page: string;
  again: () => void;
}) {
  const network = useNetwork();
  const address = untrack(() => props.address);
  const height = untrack(() => props.height);
  const noun = untrack(() => (props.isKey ? "key" : "address"));
  const path = `/address/${encodeURIComponent(address)}`;
  /** This page's settled key (`AddressPage`'s keyed match): what focus on arrival is scoped to. */
  const page = untrack(() => props.page);
  const go = useGo(() => page);
  let heading: HTMLHeadingElement | undefined;
  useArrival(() => heading, page, String(height));
  const [resolved, { refetch: retryResolve }] = createRequest(
    () => network(),
    (net, signal) => resolve(net, height, signal),
  );
  const answer = () => (resolved.state === "ready" ? resolved.latest : undefined);
  const block = () => {
    const a = answer();
    return a?.kind === "block" ? a.block : undefined;
  };
  const hash = () => block()?.hash;
  // Every read is as of one hash, so the figures agree with one another.
  const [stats, { refetch: refetchStats }] = createApi<AddressStats>(() => {
    const h = hash();
    return h !== undefined && pinnedPath(path, h);
  });
  const failure = () => (stats.state === "errored" ? refusal(stats.error) : undefined);
  const unused = () => {
    const s = settled(stats);
    return s !== undefined && unusedThen(s);
  };
  // A kept address answers its history as of its last 100 blocks, though never its totals.
  const kept = () => failure() === "not-kept";
  const [first, { refetch: refetchFirst }] = createApi<Transaction[]>(() => {
    const h = hash();
    const asks = (settled(stats) !== undefined && !unused()) || kept();
    return h !== undefined && asks && pinnedPath(`${path}/txs/chain`, h);
  });
  const [goneSeen, setGone] = createSignal(false);
  const gone = () =>
    goneSeen() ||
    failure() === "gone" ||
    (first.state === "errored" && refusal(first.error) === "gone");
  const { onShown, lookalike, notice, announced } = createLookalikes(address, () => true);
  const retryAll = () => {
    refetchStats();
    if (first.state === "errored") refetchFirst();
  };
  const tip = () => {
    const a = answer();
    return a?.kind === "future" ? a.tip : undefined;
  };
  // How it stands now, and where its next change is: the current totals, read fresh and stamped
  // with the tip they are as of, put through the one gate (`compareNow`); only a present it proves
  // comparable is shown, or has its history read, and that history is read as of the same tip.
  // Asked once the pinned totals answered, so an address refused those (too large, kept) asks
  // nothing more. Neither feeds the figures, coins, chart or history shown.
  const [now, { refetch: refetchNow }] = createApi<AddressStats>(
    () => settled(stats) !== undefined && path,
    { stamped: true, fresh: true },
  );
  /** The present beside the block, through the gate; undefined until both totals are in, and
   * while the current ones are being read again, so nothing is shown from the totals replaced. */
  const present = createMemo((): Since | undefined => {
    const n = now.state === "ready" ? now.latest : undefined;
    const t = settled(stats);
    const b = block();
    if (n === undefined || t === undefined || b === undefined) return undefined;
    return compareNow(t.chain_stats, n.value.chain_stats, n.tip, { height, hash: b.hash });
  });
  /** Before its first transaction with more history now than the lookup reads: further back. */
  const beyondReach = () => {
    const p = present();
    return unused() && p?.kind === "later" && p.transactions > MAX_ROWS;
  };
  // Its history as of the tip the gate passed, newest first: one page, or, before its first
  // transaction, as much as the live page's chart reads (MAX_PAGES), which this page then spends
  // instead: it draws no chart, list or coins. Asked only of a present proved later than the block.
  const [recent, { refetch: refetchRecent }] = createRequest(
    () => {
      // False while the totals are read again, so a new answer, even for the same tip, asks the
      // history afresh, after it and for its tip only.
      const tipHash = now.state === "ready" ? now.latest?.tip?.hash : undefined;
      if (present()?.kind !== "later" || tipHash === undefined || beyondReach()) return false;
      return `${network()} ${unused() ? "whole" : "page"} ${tipHash}`;
    },
    async (key, signal): Promise<{ heights: number[]; complete: boolean }> => {
      const [, mode, pin = ""] = key.split(" ");
      const net = untrack(network);
      const read = (p: string) => fetchStamped<unknown>(net, p, { signal });
      if (mode === "whole") {
        // Strict: a page that fails is a failed lookup, offered again, never a short history.
        const h = await loadHistory(path, read, MAX_PAGES, undefined, pin, true);
        return { heights: h.rows.map((r) => r.height), complete: h.complete };
      }
      const rows = readRows((await read(pinnedPath(`${path}/txs/summary`, pin))).value);
      return {
        heights: rows.flatMap((r) => (r.height > 0 ? [r.height] : [])),
        complete: rows.length < PAGE_ROWS,
      };
    },
  );
  const previous = createMemo((): Step | Pending | undefined => {
    if (unused()) return undefined; // Every block before shows the same: nothing.
    const rows = settled(first);
    if (rows === undefined) {
      return first.state === "pending" || first.state === "unresolved"
        ? { kind: "pending" }
        : undefined;
    }
    const heights = rows.flatMap((t) =>
      t.status.confirmed && t.status.block_height !== undefined ? [t.status.block_height] : [],
    );
    // A full page is the whole history by then when the pinned totals count no more.
    const count = settled(stats)?.chain_stats.tx_count;
    return previousChange(heights, rows.length < PAGE_ROWS || heights.length === count);
  });
  /** A refusal that will never change (too large, not kept): no step, and nothing to retry. */
  const lasting = (error: unknown) => {
    const kind = refusal(error);
    return kind === "too-large" || kind === "not-kept";
  };
  /** The look at the present failed (busy past its retries, or the node failing): worth a retry.
   * Nothing while the totals are being read again: the page shows its pending step instead. */
  const nowFailed = () => {
    if (now.state === "pending" || now.state === "refreshing") return undefined;
    for (const r of [now, recent]) {
      if (r.state === "errored" && !lasting(r.error)) return r.error;
    }
    return undefined;
  };
  /**
   * Try again runs the failed request again, whatever its inputs. A history read as of a tip
   * that has since left the chain (404) belonged to totals that are gone: those are read again,
   * and the history follows them, once, for the tip they give.
   */
  const retryNow = () => {
    if (recent.state === "errored" && !isNotFound(recent.error)) refetchRecent();
    else refetchNow();
  };
  const next = createMemo((): Step | Pending | undefined => {
    const p = present();
    // Until both totals are in: waiting, unless one was refused or failed (no step then).
    if (p === undefined) {
      return stats.state === "errored" || now.state === "errored" ? undefined : { kind: "pending" };
    }
    if (p.kind === "same") return { kind: "none" };
    // Not comparable, beyond what is read, or its history failed: no step.
    if (p.kind === "unknown" || beyondReach() || recent.state === "errored") return undefined;
    // Only an answer for the tip accepted now: never one kept while the next is asked.
    const r = recent.state === "ready" ? recent.latest : undefined;
    if (r === undefined) return { kind: "pending" };
    return nextChange(r.heights, r.complete, height, !unused(), p.transactions);
  });
  /** Its first block, when it had none by this one and its history reaches back to it. */
  const firstUse = () => {
    const n = next();
    return n?.kind === "first" ? n.height : undefined;
  };
  /** Before its first transaction, its first use is further back than this page reads. */
  const firstFarBack = () =>
    unused() &&
    present()?.kind === "later" &&
    (beyondReach() || (recent.state === "ready" && next() === undefined));
  /** Under the balance at the block, how it stands now: said only of a comparable snapshot. */
  const since = () => {
    const p = present();
    if (p === undefined) {
      return now.state === "errored" ? undefined : <Skeleton width="20ch" />;
    }
    if (p.kind === "unknown") return undefined;
    if (p.kind === "same") return "The same now: no transaction since";
    return (
      <>
        Now <Amount sats={p.balance} />, {groupDigits(p.transactions)}{" "}
        {p.transactions === 1 ? "transaction" : "transactions"} later
      </>
    );
  };
  const pinnedFor = createMemo(() => {
    const b = block();
    return b === undefined ? undefined : { hash: b.hash, height: b.height };
  });

  return (
    <>
      <p class="visually-hidden address-announce" aria-live="polite">
        {announced()}
      </p>
      <section class="address-asof panel" aria-labelledby="address-asof-title">
        <div class="address-asof__body">
          <div class="address-asof__head">
            <DepthMark />
            <h2 class="address-asof__title" id="address-asof-title" tabindex="-1" ref={heading}>
              As of block {/* A link only to a block there is: not one past the tip. */}
              <Show
                when={answer()?.kind !== "future"}
                fallback={<span class="num">{groupDigits(height)}</span>}
              >
                <Link class="num" href={paths.block(hash() ?? height)}>
                  {groupDigits(height)}
                </Link>
              </Show>
            </h2>
            <p class="address-asof__when">
              <Switch
                fallback={
                  <Show when={resolved.loading}>
                    <Skeleton width="22ch" />
                  </Show>
                }
              >
                <Match when={block()}>
                  {(b) => (
                    <>
                      {/* A phone drops the word: under "As of block N" a time is the block's. */}
                      <span class="address-asof__long">Mined </span>
                      <TimeUtc time={b().time} seconds={false} />, <TimeAgo time={b().time} />
                    </>
                  )}
                </Match>
                <Match when={boxed(tip())}>
                  {(t) => (
                    <>
                      Not mined yet. The newest block is{" "}
                      <Link class="num" href={paths.block(t().height)}>
                        {groupDigits(t().height)}
                      </Link>
                      .
                    </>
                  )}
                </Match>
              </Switch>
            </p>
          </div>
          {/* A block not mined yet has no "then". */}
          <Show when={answer()?.kind !== "future"}>
            <p class="address-asof__what">
              {/* A phone says it in four words: what is shown is what had confirmed by then. */}
              <span class="address-asof__long">
                Later blocks and unconfirmed transactions are left out; it never updates.
              </span>
              <span class="address-asof__short">Confirmed through this block.</span>
            </p>
          </Show>
          {/* A step that cannot be worked out yet, or at all, says why rather than sit greyed. */}
          <Show when={block() !== undefined && !gone()}>
            <Switch>
              <Match when={nowFailed()}>
                {(error) => (
                  <p class="address-asof__note" role="status">
                    {`The next change could not be looked up${error() instanceof Error ? `: ${(error() as Error).message}` : "."}`}{" "}
                    <button class="address-asof__retry" type="button" onClick={retryNow}>
                      Try again
                    </button>
                  </p>
                )}
              </Match>
              <Match when={next()?.kind === "pending" && busyRetrying()}>
                <p class="address-asof__note" role="status">
                  The server is busy, so the next change is still being looked up.
                </p>
              </Match>
            </Switch>
          </Show>
        </div>
        <Actions
          page={page}
          height={height}
          newest={tip()}
          previous={block() === undefined || gone() ? undefined : previous()}
          next={block() === undefined || gone() ? undefined : next()}
        />
      </section>
      <Switch>
        <Match when={resolved.state === "errored"}>
          <ErrorState
            title={`Could not look up block ${groupDigits(height)}`}
            error={resolved.error}
            retry={retryResolve}
          />
        </Match>
        {/* Said in the band: nothing more to show. */}
        <Match when={answer()?.kind === "future"}>{null}</Match>
        <Match when={gone()}>
          <Notice
            title={`Block ${groupDigits(height)} is no longer on the best chain`}
            tone="caution"
          >
            <p>
              The block this page was reading at that height was replaced by another (a chain
              reorganization), so nothing is shown as of it.
            </p>
            <p>
              <button class="btn" type="button" onClick={() => props.again()}>
                Show block {groupDigits(height)} as it is now
              </button>
            </p>
          </Notice>
        </Match>
        <Match when={failure() === "no-index"}>
          <Notice title="This server does not index addresses" tone="caution">
            Its node runs without an address index, so it cannot show the balance or history of any
            address, now or at a past block.
          </Notice>
        </Match>
        <Match when={failure() === "too-large"}>
          <Notice title={`This ${noun} is not shown as of a past block`}>
            {`This server does not add this ${noun} up, so at a past block it shows no totals, confirmed transactions or coins for it.`}
          </Notice>
        </Match>
        <Match when={kept()}>
          <Notice title={`Totals at block ${groupDigits(height)} are not kept for this ${noun}`}>
            It has so much history that this server keeps its running totals only as they stand now,
            not its balance at past blocks. Its transactions as of this block are listed below only
            if the server keeps its whole history and this block is among the server's last 100.
          </Notice>
          <Show when={pinnedFor()}>
            {(p) => (
              <History
                address={address}
                stats={stats}
                first={first}
                retryFirst={() => refetchFirst()}
                onRefresh={() => undefined}
                kept
                asof={p()}
                onGone={() => setGone(true)}
                lookalike={lookalike()}
                onShown={onShown}
              />
            )}
          </Show>
        </Match>
        <Match when={unused()}>
          <Notice title={`Not used yet at block ${groupDigits(height)}`}>
            <p>
              {`No transaction paying or spending this ${noun} had confirmed by block ${groupDigits(height)}.`}
            </p>
            {/* Only of a snapshot comparable with the block: never a count from an older reply. */}
            <Switch>
              <Match when={present()?.kind === "same"}>
                <p>None has since.</p>
              </Match>
              <Match when={present()?.kind === "later" && (present() as { transactions: number })}>
                {(p) => (
                  <p>
                    {`It has ${groupDigits(p().transactions)} confirmed ${p().transactions === 1 ? "transaction" : "transactions"} now.`}
                  </p>
                )}
              </Match>
            </Switch>
            {/* Where to go from here: its first use when its history reaches it, else now. */}
            <Switch>
              <Match when={boxed(firstUse())}>
                {(h) => (
                  <p class="address-asof__onward">
                    <button
                      class="btn"
                      type="button"
                      onClick={() => {
                        go(String(h().height));
                      }}
                    >
                      {`First used at block ${groupDigits(h().height)}`}
                    </button>
                  </p>
                )}
              </Match>
              <Match when={firstFarBack()}>
                <p>{`Its first transaction is further back than the newest ${groupDigits(MAX_PAGES * PAGE_ROWS)} this page reads.`}</p>
                <p class="address-asof__onward">
                  <button
                    class="btn"
                    type="button"
                    onClick={() => {
                      go(undefined);
                    }}
                  >
                    {`Show the ${noun} now`}
                  </button>
                </p>
              </Match>
            </Switch>
          </Notice>
        </Match>
        <Match when={true}>
          {notice()}
          <Totals stats={stats} retry={retryAll} at={height} since={since()} />
          <Show when={block()}>
            {(b) => (
              <BalanceChart
                address={address}
                stats={stats}
                after={first.state !== "unresolved" && first.state !== "pending"}
                onRefresh={() => undefined}
                asof={{ hash: b().hash, time: b().time }}
                onGone={() => setGone(true)}
              />
            )}
          </Show>
          <Show when={pinnedFor()}>
            {(p) => (
              <History
                address={address}
                stats={stats}
                first={first}
                retryFirst={() => refetchFirst()}
                onRefresh={() => undefined}
                asof={p()}
                onGone={() => setGone(true)}
                lookalike={lookalike()}
                onShown={onShown}
              />
            )}
          </Show>
        </Match>
      </Switch>
    </>
  );
}
