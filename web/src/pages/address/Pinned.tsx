// The address page as of a past block (`?at=<height>`): the block field that picks one, the band
// that says which block the page shows, and the page itself, every read pinned to that block's
// hash. Nothing live: no topic, no ledger, no refresh. docs/FRONTEND.md "An address as of a block".
import { useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
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
import { createApi, createRequest, fetchApi, isNotFound } from "../../lib/api";
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
  type Step,
  unusedThen,
} from "./asof";
import { readRows } from "./balance";
import { BalanceChart } from "./BalanceChart";
import { History } from "./History";
import { createLookalikes } from "./LookalikeNotice";
import { Notice, Skeleton, settled } from "./parts";
import { Totals } from "./Totals";

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
}) {
  const network = useNetwork();
  const [, setSearch] = useSearchParams<{ at: string }>();
  const [note, setNote] = createSignal<string>();
  const [asking, setAsking] = createSignal(false);
  let ask: AbortController | undefined;
  onCleanup(() => ask?.abort());
  // A date's lookup belongs to the page that asked it: moving to another address or network
  // (the router keeps this form mounted) drops it, so its height never lands on that page. Another
  // spelling of the same address (upper-case Bech32) is the same page.
  // A memo, so the key worked out again to the same value (a new spelling) is no change: an
  // effect runs on every change to what it reads, equal or not.
  const page = createMemo(() => props.page);
  createEffect(page, (_, before) => {
    if (before === undefined) return;
    ask?.abort();
    setAsking(false);
    setNote(undefined);
  });
  const noteId = `${props.id}-note`;
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const value = new FormData(form).get("at");
    const typed = readTyped(typeof value === "string" ? value : "", Date.now() / 1000);
    ask?.abort();
    setAsking(false);
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
      setSearch({ at: String(typed.height) });
      return;
    }
    const net = network();
    const controller = new AbortController();
    ask = controller;
    setAsking(true);
    setNote(undefined);
    try {
      const answer = await blockAt(typed.moment, net, controller.signal);
      if (controller.signal.aborted) return;
      if (answer.kind === "found") setSearch({ at: String(answer.found.height) });
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
          onInput={() => setNote(undefined)}
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
    </form>
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
}) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  let closePop: (() => void) | undefined;
  // In the page, Escape is heard here; over it, pop.ts hears it.
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    shut();
    button?.focus();
  };
  const shut = () => {
    const close = closePop;
    closePop = undefined;
    close?.();
    document.removeEventListener("keydown", escape);
    setOpen(false);
  };
  const show = () => {
    setOpen(true);
    if (!window.matchMedia(OVER).matches) {
      document.addEventListener("keydown", escape);
      return;
    }
    closePop = openPop(
      () => {
        closePop = undefined;
        // Closed by a press outside while it held focus: focus goes back to its button.
        if (panel?.contains(document.activeElement) === true)
          button?.focus({ preventScroll: true });
        setOpen(false);
      },
      () => [button, panel],
    );
  };
  onCleanup(() => {
    closePop?.();
    document.removeEventListener("keydown", escape);
  });
  return (
    <>
      <button
        ref={button}
        class={`btn address-asof-picker ${props.class ?? ""}`}
        type="button"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={props.id}
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
          <AsOfForm id={`${props.id}-at`} page={props.page} current={props.current} focus />
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
export function PinnedBody(props: { address: string; isKey: boolean; at: At }) {
  const network = useNetwork();
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
            again={() => setRound((r) => r + 1)}
          />
        ) : (
          <NotAHeight
            text={at.kind === "invalid" ? at.text : ""}
            page={`${network()} ${props.address}`}
          />
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
  const [, setSearch] = useSearchParams<{ at: string }>();
  const go = (h: number) => setSearch({ at: String(h) }, { scroll: false });
  const stepTo = (s: Step | Pending | undefined) =>
    s !== undefined && s.kind !== "none" && s.kind !== "pending" ? s.height : undefined;
  return (
    <div class="address-asof__actions">
      <button class="btn btn--accent" type="button" onClick={() => setSearch({ at: undefined })}>
        Back to now
      </button>
      <Show when={props.newest}>
        {(n) => (
          <button class="btn" type="button" onClick={() => go(n())}>
            Show block {groupDigits(n())}
          </button>
        )}
      </Show>
      <Show when={props.previous !== undefined && props.previous.kind !== "none"}>
        <button
          class="btn"
          type="button"
          aria-disabled={props.previous?.kind === "pending" ? "true" : "false"}
          aria-label={
            props.previous?.kind === "before-first"
              ? `Before first use: block ${groupDigits(stepTo(props.previous) ?? 0)}`
              : stepTo(props.previous) === undefined
                ? undefined
                : `Previous change: block ${groupDigits(stepTo(props.previous) ?? 0)}`
          }
          title={
            stepTo(props.previous) === undefined
              ? undefined
              : `Block ${groupDigits(stepTo(props.previous) ?? 0)}`
          }
          onClick={() => {
            const h = stepTo(props.previous);
            if (h !== undefined) go(h);
          }}
        >
          <span aria-hidden="true">‹</span>{" "}
          {props.previous?.kind === "before-first" ? (
            "Before first use"
          ) : (
            // One flex item, so the button's gap does not fall between the words.
            <span>
              Previous<span class="address-asof__long"> change</span>
            </span>
          )}
        </button>
      </Show>
      <Show when={props.next !== undefined && props.next.kind !== "none"}>
        <button
          class="btn"
          type="button"
          aria-disabled={props.next?.kind === "pending" ? "true" : "false"}
          aria-label={
            props.next?.kind === "change"
              ? `Next change: block ${groupDigits(props.next.height)}`
              : undefined
          }
          title={
            stepTo(props.next) === undefined
              ? undefined
              : `Block ${groupDigits(stepTo(props.next) ?? 0)}`
          }
          onClick={() => {
            const h = stepTo(props.next);
            if (h !== undefined) go(h);
          }}
        >
          {props.next?.kind === "first" ? (
            `First used at block ${groupDigits(props.next.height)}`
          ) : (
            // One flex item, so the button's gap does not fall between the words.
            <span>
              Next<span class="address-asof__long"> change</span>
            </span>
          )}{" "}
          <span aria-hidden="true">›</span>
        </button>
      </Show>
      <AsOfPicker
        id="address-asof-other"
        page={props.page}
        title="Show another block"
        label="Another block"
        current={props.height}
      />
    </div>
  );
}

/** `?at=` that is not a height: said, with the field to give one and the way back. */
function NotAHeight(props: { text: string; page: string }) {
  return (
    <section class="address-asof panel" aria-labelledby="address-asof-title">
      <div class="address-asof__body">
        <div class="address-asof__head">
          <DepthMark />
          <h2 class="address-asof__title" id="address-asof-title">
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

function PinnedAt(props: { address: string; isKey: boolean; height: number; again: () => void }) {
  const network = useNetwork();
  const address = untrack(() => props.address);
  const height = untrack(() => props.height);
  const noun = untrack(() => (props.isKey ? "key" : "address"));
  const path = `/address/${encodeURIComponent(address)}`;
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
  // How it stands now, and where its next change is: the unpinned totals and newest history page,
  // asked once the pinned totals answered, so an address refused those asks nothing more. One
  // page each, never a walk of the history.
  const [now] = createApi<AddressStats>(() => settled(stats) !== undefined && path);
  const later = () => {
    const n = settled(now);
    const t = settled(stats);
    return n && t ? n.chain_stats.tx_count - t.chain_stats.tx_count : undefined;
  };
  const [recent] = createApi<unknown>(() => {
    const l = later();
    return (
      ((l !== undefined && l > 0) || (kept() && hash() !== undefined)) && `${path}/txs/summary`
    );
  });
  const previous = createMemo((): Step | Pending | undefined => {
    if (unused()) return undefined; // Every block before shows the same: nothing.
    const rows = settled(first);
    if (rows === undefined) {
      return first.state === "pending" || first.state === "unresolved"
        ? { kind: "pending" }
        : undefined;
    }
    return previousChange(
      rows.flatMap((t) =>
        t.status.confirmed && t.status.block_height !== undefined ? [t.status.block_height] : [],
      ),
    );
  });
  const next = createMemo((): Step | Pending | undefined => {
    if (later() === 0) return { kind: "none" };
    if (recent.state === "errored" || now.state === "errored") return undefined;
    const page = settled(recent);
    if (page === undefined) {
      // Not asked: a refusal or failure of the totals leaves nothing to step by.
      return stats.state === "errored" && !kept() ? undefined : { kind: "pending" };
    }
    try {
      const rows = readRows(page);
      const heights = rows.flatMap((r) => (r.height > 0 ? [r.height] : []));
      return nextChange(heights, rows.length, height, !unused());
    } catch {
      return undefined;
    }
  });
  /** Under the balance at the block, how it stands now. */
  const since = () => {
    const n = settled(now);
    const l = later();
    if (n === undefined || l === undefined) {
      return now.state === "errored" ? undefined : <Skeleton width="20ch" />;
    }
    if (l === 0) return "The same now: no transaction since";
    return (
      <>
        Now <Amount sats={n.chain_stats.funded_txo_sum - n.chain_stats.spent_txo_sum} />,{" "}
        {groupDigits(l)} {l === 1 ? "transaction" : "transactions"} later
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
            <h2 class="address-asof__title" id="address-asof-title">
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
                      Mined <TimeUtc time={b().time} seconds={false} />, <TimeAgo time={b().time} />
                    </>
                  )}
                </Match>
                <Match when={tip()}>
                  {(t) => (
                    <>
                      Not mined yet. The newest block is{" "}
                      <Link class="num" href={paths.block(t())}>
                        {groupDigits(t())}
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
              Later blocks and unconfirmed transactions are left out; it never updates.
            </p>
          </Show>
        </div>
        <Actions
          page={`${network()} ${address}`}
          height={answer()?.kind === "future" ? undefined : height}
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
            <Show when={settled(now)}>
              {(n) => (
                <p>
                  {n().chain_stats.tx_count === 0
                    ? "None has since."
                    : `It has ${groupDigits(n().chain_stats.tx_count)} confirmed ${n().chain_stats.tx_count === 1 ? "transaction" : "transactions"} now.`}
                </p>
              )}
            </Show>
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
