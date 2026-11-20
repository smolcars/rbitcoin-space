// The address page as of a past block (`?at=<height>`): the block field that picks one, the band
// that says which block the page shows, and the page itself, every read pinned to that block's
// hash. Nothing live: no topic, no ledger, no refresh. docs/FRONTEND.md "An address as of a block".
import { useSearchParams } from "@solidjs/router";
import { createMemo, createSignal, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import "../../components/Button.css";
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
  unusedThen,
} from "./asof";
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
export function AsOfForm(props: { id: string; current?: number | undefined }) {
  const network = useNetwork();
  const [, setSearch] = useSearchParams<{ at: string }>();
  const [note, setNote] = createSignal<string>();
  const [asking, setAsking] = createSignal(false);
  let ask: AbortController | undefined;
  onCleanup(() => ask?.abort());
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

type Resolved =
  | { kind: "block"; block: Pinned; tip: number | undefined }
  | { kind: "future"; tip: number | undefined };

/** A height on the best chain now: its hash, then that block's time, and the tip beside them. */
async function resolve(net: Network, height: number, signal: AbortSignal): Promise<Resolved> {
  // Only to say how far the chain reaches and to stop "Next" there; never read into the figures.
  const tip = fetchApi<string>(net, "/blocks/tip/height", { as: "text", signal, fresh: true }).then(
    readTip,
    () => undefined,
  );
  let hash: string;
  try {
    hash = (
      await fetchApi<string>(net, `/block-height/${height}`, { as: "text", signal, fresh: true })
    ).trim();
  } catch (error) {
    if (isNotFound(error)) return { kind: "future", tip: await tip };
    throw error;
  }
  const block = /^[0-9a-f]{64}$/.test(hash)
    ? await fetchApi<unknown>(net, `/block/${hash}`, { signal })
    : undefined;
  const pinned = readPinned(hash, block, height);
  if (pinned === undefined) throw new Error("The node's answer for this block could not be read.");
  return { kind: "block", block: pinned, tip: await tip };
}

/**
 * The page as of `at`. Made afresh when the reader asks to look the height up again (a block that
 * left the best chain), so nothing from the last hash lingers.
 */
export function PinnedBody(props: { address: string; isKey: boolean; at: At }) {
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
          <NotAHeight text={at.kind === "invalid" ? at.text : ""} />
        );
      }}
    </Show>
  );
}

/** The band's actions: back to the present, and another block. */
function Actions(props: { height?: number | undefined; tip?: number | undefined }) {
  const [, setSearch] = useSearchParams<{ at: string }>();
  const [open, setOpen] = createSignal(false);
  const step = (h: number) => setSearch({ at: String(h) }, { scroll: false });
  return (
    <>
      <div class="address-asof__actions">
        <button class="btn btn--accent" type="button" onClick={() => setSearch({ at: undefined })}>
          Back to now
        </button>
        <Show when={props.height !== undefined}>
          <Show when={(props.height ?? 0) > 0}>
            <button class="btn" type="button" onClick={() => step((props.height ?? 1) - 1)}>
              <span aria-hidden="true">‹</span> Block {groupDigits((props.height ?? 1) - 1)}
            </button>
          </Show>
          <button
            class="btn"
            type="button"
            disabled={props.tip !== undefined && (props.height ?? 0) >= props.tip}
            onClick={() => step((props.height ?? 0) + 1)}
          >
            Block {groupDigits((props.height ?? 0) + 1)} <span aria-hidden="true">›</span>
          </button>
        </Show>
        <button
          class="btn"
          type="button"
          aria-expanded={open() ? "true" : "false"}
          aria-controls="address-asof-other"
          onClick={() => setOpen((o) => !o)}
        >
          Another block
        </button>
      </div>
      <div id="address-asof-other" hidden={!open()}>
        <Show when={open()}>
          <AsOfForm id="address-asof-at" current={props.height} />
        </Show>
      </div>
    </>
  );
}

/** `?at=` that is not a height: said, with the field to give one and the way back. */
function NotAHeight(props: { text: string }) {
  return (
    <section class="address-asof panel" aria-labelledby="address-asof-title">
      <DepthMark />
      <div class="address-asof__body">
        <h2 class="address-asof__title" id="address-asof-title">
          {`“${props.text}” is not a block height`}
        </h2>
        <p class="address-asof__what">
          The link asks for this address as of a block, but names none this page can read. Give a
          height in digits, or a date.
        </p>
        <Actions />
      </div>
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
  const tip = () => answer()?.tip;
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
        <DepthMark />
        <div class="address-asof__body">
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
          <p class="address-asof__when" hidden={answer()?.kind === "future"}>
            <Show
              when={block()}
              fallback={
                <Show when={resolved.loading}>
                  <Skeleton width="22ch" />
                </Show>
              }
            >
              {(b) => (
                <>
                  Mined <TimeUtc time={b().time} />, <TimeAgo time={b().time} />
                </>
              )}
            </Show>
          </p>
          {/* A block not mined yet has no "then" and no neighbours to step to. */}
          <Show when={answer()?.kind !== "future"}>
            <p class="address-asof__what">
              {`The ${noun}'s figures, coins and history as they stood at this block. Later blocks and unconfirmed transactions are left out, and the page does not update.`}
            </p>
          </Show>
          <Actions height={answer()?.kind === "future" ? undefined : height} tip={tip()} />
        </div>
      </section>
      <Switch>
        <Match when={resolved.state === "errored"}>
          <ErrorState
            title={`Could not look up block ${groupDigits(height)}`}
            error={resolved.error}
            retry={retryResolve}
          />
        </Match>
        <Match when={answer()?.kind === "future"}>
          <Notice title={`Block ${groupDigits(height)} has not been mined yet`}>
            <Show
              when={tip()}
              fallback="The chain does not reach that height yet. Pick a lower block."
            >
              {(t) => (
                <p>
                  The newest block is{" "}
                  <Link class="num" href={paths.block(t())}>
                    {groupDigits(t())}
                  </Link>
                  . Pick a block at or below it, or go back to now.
                </p>
              )}
            </Show>
          </Notice>
        </Match>
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
          <Notice title={`This ${noun} cannot be shown as of a past block`}>
            It has more history than this server's node will add up, now or at any block, which is
            common for exchange and mining pool addresses.
          </Notice>
        </Match>
        <Match when={kept()}>
          <Notice title={`Totals at block ${groupDigits(height)} are not kept for this ${noun}`}>
            It has so much history that this server keeps its running totals only as they stand now,
            not its balance at past blocks. Its transactions are listed below while this block is
            among the server's last 100.
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
            {`No transaction had paid to or spent from this ${noun} by this block: its balance then was nothing. Its first transaction came later. Try a later block, or go back to now.`}
          </Notice>
        </Match>
        <Match when={true}>
          {notice()}
          <Totals stats={stats} retry={retryAll} at={height} />
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
