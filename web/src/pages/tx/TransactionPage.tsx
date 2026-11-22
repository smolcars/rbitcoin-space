import { useLocation, useParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount, Sats } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { Note } from "../../components/Note";
import { Hash, HashFull } from "../../components/Hash";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState } from "../../components/States";
import { TimeAgo, TimeUtc } from "../../components/Time";
import {
  createApi,
  createRequest,
  fetchApi,
  fetchApp,
  fetchStamped,
  isNotFound,
} from "../../lib/api";
import { type BlocksMessage, blocksTopic, type ChainTip } from "../../lib/blocks-topic";
import type { Outspend, Transaction, TxStatus } from "../../lib/esplora";
import { feeColor, formatSize, groupDigits, MISSING, truncateMiddle } from "../../lib/format";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { useLiveStatus } from "../../lib/live";
import { useNetwork, usePageTitle } from "../../lib/page";
import { type Handover, readHandover } from "../../lib/lookalike";
import { fetchSummaries } from "../../lib/summary";
import { type ReplacementLink, type TxMessage, txTopic } from "../../lib/track-topics";
import { TxLightning } from "../lightning/TxLightning";
import { Code } from "./Code";
import { CompareLine } from "./Compare";
import { Flow, type Selection } from "./Flow";
import { Inspector } from "./Inspector";
import { LookalikeNotice, lookalikeTitle, marksOf } from "./Lookalike";
import { Chain, Follow, Group, leftWithParent, LiveState, POLL_MS, Strip } from "./Live";
import {
  announcement as sayChange,
  LEFT_WITH_PARENT,
  answered,
  EMPTY,
  heard,
  type Liveness,
  liveness,
  type Model,
  parseRelatives,
  parseReplacements,
  place,
  placeShort,
  polls,
  ratesDiffer,
  recorded,
  type Relatives,
  type Replacements,
  type Shown,
  shown,
  type StripPlace,
  stripPlace,
} from "./state";
import { confirmations, features, isCoinbase, isTxid, lockTimeMeaning, vsize } from "./tx";
import { checkPrivacy } from "../../lib/privacy";
import { Eye, LIST_ID, TxPrivacy } from "./Privacy";
import { cardMarks, countTone, sayCount, shownFindings } from "./privacytext";
import { bringIntoView, returnFocus, setOpener } from "./flash";
import { judgeFee, parentsOf, verdictDetail, verdictText, verdictTitle } from "./verdict";
import "./TransactionPage.css";

export { POLL_MS } from "./Live";

/** Links the route said are a child's that a page remembers: as many as one answer can list. */
const CHILD_LINKS_KEPT = 32;
/** A server following as many transactions as it can is asked again this much later. */
const REFUSED_RETRY_MS = 60_000;
/** How long a live socket may say nothing about the transaction before the page checks over HTTP. */
const QUIET_MS = 5000;
/** Confirmations after which most services treat a payment as final, and a coinbase's maturity. */
const SETTLED = 6;
const MATURE = 100;

export default function TransactionPage() {
  const params = useParams<{ txid: string }>();
  const network = useNetwork();
  const id = () => (isTxid(params.txid) ? params.txid.toLowerCase() : null);
  usePageTitle(() => (id() ? `Transaction ${truncateMiddle(id() ?? "")}` : "Transaction"));
  return (
    <div class="wrap tx-page">
      <Show
        when={id() ? `${network()}/${id()}` : null}
        keyed
        fallback={<BadInput value={params.txid} />}
      >
        {(key) => <TransactionView txid={key.slice(key.indexOf("/") + 1)} />}
      </Show>
    </div>
  );
}

/** A path segment as the reader typed it; left encoded if it does not decode. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function BadInput(props: { value: string }) {
  return (
    <>
      <header class="tx-head">
        <h1>Transaction</h1>
      </header>
      <Empty title="That is not a transaction ID">
        <p>
          “{truncateMiddle(decoded(props.value), 24, 8)}” is not one. A transaction ID is 64
          characters, each a digit or a letter from a to f. Check the link, or search for it again.
        </p>
      </Empty>
    </>
  );
}

function TransactionView(props: { txid: string }) {
  const network = useNetwork();
  const [tx, { refetch }] = createApi<Transaction>(() => `/tx/${props.txid}`, { cached: true });
  // Fetched alongside the transaction rather than after it, so neither waits on the other.
  const [outspends, { refetch: refetchSpends }] = createApi<Outspend[]>(
    () => `/tx/${props.txid}/outspends`,
    { stamped: true, cached: true },
  );
  const [tipText, { refetch: refetchTip }] = createApi<string>(() => "/blocks/tip/height", {
    as: "text",
    cached: true,
  });
  const retry = () => {
    refetch();
    refetchSpends();
    refetchTip();
  };

  const ready = () => (tx.state === "ready" ? tx() : undefined);
  // An address page's flagged row may hand over its findings in the history entry's state; only
  // those this transaction bears out are shown (lib/lookalike.ts).
  const location = useLocation();
  const handed = createMemo(() => {
    const t = ready();
    return t ? readHandover(location.state, t, network()) : undefined;
  });
  // Said politely when the notice shows, cleared when it goes. A memo of the words, so a refresh
  // that hands back the same findings writes nothing and is not said again.
  const lookalikeSaid = createMemo(() => {
    const h = handed();
    return h ? lookalikeTitle(h) : "";
  });
  /** The model's clock when the transaction was last asked for. */
  let txAsked = 0;
  /** Numbers the page's HTTP questions about the status, the first load being 0. */
  let requests = 0;
  let txReq = 0;
  const missing = () => tx.state === "errored" && isNotFound(tx.error);
  // undefined while loading; null when it failed, so the page can say so instead of waiting.
  const spends = () =>
    outspends.state === "ready"
      ? outspends()?.value
      : outspends.state === "errored"
        ? null
        : undefined;
  /** The chain tip the spends are as of: what the fee verdict checks before trusting them. */
  const spendsTip = () => (outspends.state === "ready" ? outspends()?.tip : undefined);

  const [model, setModel] = createSignal<Model>(EMPTY);
  const socket = useLiveStatus();
  const [quiet, setQuiet] = createSignal(false);
  const live = createMemo(() => liveness(model(), socket(), quiet()));
  const shownNow = createMemo(() => shown(model(), live() === "live"));
  createEffect(
    () => tx.state,
    () => {
      const t = ready();
      if (t) setModel((m) => answered(m, t.status, txAsked, txReq));
      else if (missing()) setModel((m) => answered(m, "missing", txAsked, txReq));
    },
  );

  const [polledTip, setPolledTip] = createSignal<number>();
  const tip = () => {
    const polled = polledTip();
    if (polled !== undefined) return polled;
    const t = tipText.state === "ready" ? Number(tipText()) : Number.NaN;
    return Number.isSafeInteger(t) ? t : undefined;
  };
  const status = (): TxStatus | undefined => {
    const s = shownNow();
    return s.kind === "confirmed"
      ? {
          confirmed: true,
          block_height: s.height,
          block_hash: s.hash,
          ...(s.time === undefined ? {} : { block_time: s.time }),
        }
      : s.kind === "mempool"
        ? { confirmed: false }
        : undefined;
  };
  const confs = () => confirmations(status()?.block_height, tip());
  const target = () => (ready() && isCoinbase(ready() as Transaction) ? MATURE : SETTLED);

  // What the page follows: nothing until the first answer, and nothing for a settled transaction.
  const following = createMemo(() => {
    const s = shownNow();
    if (s.kind === "loading") return false;
    if (s.kind !== "confirmed") return true;
    const c = confs();
    return c !== undefined && c < target();
  });
  // Whether its status can still change in a way a block or a poll would show.
  // Memos, so what depends on them restarts only when they change, not on every answer.
  const watching = createMemo(() => {
    const s = shownNow().kind;
    // A transaction the node did not know at first is watched for until it appears.
    return following() && (s === "mempool" || s === "confirmed" || (missing() && s === "gone"));
  });
  const polling = createMemo(() => watching() && polls(live()));
  // A socket that is live while the topic says nothing for a while: check over HTTP meanwhile.
  createEffect(
    () => following() && socket() === "live" && model().last === undefined,
    (silent) => {
      if (!silent) {
        setQuiet(false);
        return undefined;
      }
      const timer = setTimeout(() => setQuiet(true), QUIET_MS);
      return () => clearTimeout(timer);
    },
  );

  const controller = new AbortController();
  onCleanup(() => controller.abort());
  let checking = false;
  let again = false;
  /** Asks the node over HTTP: confirmed, waiting, or gone. One at a time; a call meanwhile repeats it. */
  const check = async (): Promise<void> => {
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    again = false;
    const asked = model().clock;
    const req = ++requests;
    try {
      try {
        const next = await fetchApi<TxStatus>(network(), `/tx/${props.txid}/status`, {
          signal: controller.signal,
        });
        setModel((m) => answered(m, next, asked, req));
      } catch (e) {
        if (!isNotFound(e)) throw e;
        setModel((m) => answered(m, "missing", asked, req));
      }
    } catch {
      // A failed check is tried again later; the page keeps what it shows.
    } finally {
      checking = false;
    }
    if (again && !controller.signal.aborted) await check();
  };
  const checkTip = async () => {
    try {
      const height = await fetchApi<string>(network(), "/blocks/tip/height", {
        as: "text",
        signal: controller.signal,
      });
      if (Number.isSafeInteger(Number(height))) setPolledTip(Number(height));
    } catch {
      // As above.
    }
  };

  // The topic speaks for the transaction while it can; a refusal is tried again a minute later.
  let refusedTimer: ReturnType<typeof setTimeout> | undefined;
  let restart = () => {
    // Replaced by Follow once it mounts.
  };
  onCleanup(() => clearTimeout(refusedTimer));
  const heardTx = (msg: TxMessage) => {
    const before = model();
    setModel((m) => heard(m, msg));
    if (msg.type === "refused") {
      clearTimeout(refusedTimer);
      refusedTimer = setTimeout(() => restart(), REFUSED_RETRY_MS);
    }
    if (msg.type !== "tx") return;
    // The topic asks the node nothing: whether an unknown transaction confirmed is HTTP's to say.
    // A first `unknown` adds nothing to a load that found it confirmed or missing a moment ago;
    // after one that found it waiting, it left the mempool before the page followed it.
    const http = before.http?.status;
    const waited = http !== undefined && http !== "missing" && !http.confirmed;
    const news = before.last !== undefined || before.http === undefined || waited;
    if (msg.state === "unknown" && news) void check();
    // The block's time, and an HTTP word as new as the topic's, come from the status route.
    if (
      msg.state === "confirmed" &&
      (http === undefined || http === "missing" || http.block_hash !== msg.hash)
    ) {
      void check();
    }
  };
  // The first block message is the tip as it stands, not a new block.
  let tipKnown = false;
  const heardBlock = (msg: BlocksMessage) => {
    if (msg.type === "block") setPolledTip(msg.block.height);
    else if (msg.type === "resync" && msg.tip) setPolledTip(msg.tip.height);
    else return;
    const fresh = tipKnown;
    tipKnown = true;
    if (!fresh && msg.type === "block") return;
    // On each new block, a status the topic cannot vouch for is asked again (docs/WS.md).
    const last = model().last;
    if (last?.type !== "tx" || last.state === "unknown" || last.stale) void check();
  };

  // Not live: check over HTTP at a modest pace while the tab is visible, as before the socket.
  createEffect(polling, (on) => {
    if (!on) return undefined;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      await check();
      await checkTip();
      busy = false;
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  // A transaction the node did not know at first may arrive (or confirm) while the page is open.
  createEffect(
    () => shownNow().kind,
    (kind) => {
      if (missing() && (kind === "mempool" || kind === "confirmed")) {
        txAsked = model().clock;
        txReq = ++requests;
        refetch();
      }
    },
    { defer: true },
  );

  // What replaced it, or what it replaced: asked when it may have been replaced, never when the
  // server does not follow this network's mempool (the route would refuse).
  const replacementsKey = () => {
    const l = live();
    if (l === "off") return false;
    const t = ready();
    const s = shownNow();
    // Replaced while open: asked again, so the page learns whether this was a version or a child
    // that left with its parent before it offers a comparison. Again when the newest changes.
    // Before anything else: a transaction that loaded confirmed can be sent back by a reorg and
    // then replaced.
    if (s.kind === "replaced") return `replaced:${s.chain.at(-1)?.by ?? ""}`;
    // Confirmed, it may be the newest version of something replaced, however long ago: asked
    // once (one lookup in the server's memory, never the node). A settled transaction follows no
    // topic, so this does not wait for one; a server without the mempool engine answers 503,
    // read as nothing. By what the page shows now, not by how it loaded.
    if (s.kind === "confirmed" || (s.kind === "loading" && t?.status.confirmed === true)) {
      return "confirmed";
    }
    if (l === "connecting") return false;
    if (missing()) return "missing";
    if (s.kind === "gone") return "gone";
    return t ? "waiting" : false;
  };
  // The page's own abort signal, not the request's: an answer a newer request replaced still
  // records what it learned in the model.
  const [replacements] = createRequest(replacementsKey, async () => {
    try {
      const r = parseReplacements(
        await fetchApp<unknown>(network(), `/tx/${props.txid}/replacements`, {
          signal: controller.signal,
          cached: true,
        }),
      );
      if (r) setModel((m) => recorded(m, r.replacedBy, r.truncated));
      return r ?? null;
    } catch {
      return null;
    }
  });
  // The links the route said are a child's, kept for the page's life: two transactions that share
  // no input never come to share one, so what was said of a link stays true of it. Taken only
  // from answers the page took up (one a newer ask replaced is never read here), and nothing
  // else of an old answer is kept. They stand beside whatever the route says now, for the links
  // it no longer speaks of: an ask that fails, or one answered after the server's bounded record
  // let the link go while the topic still shows it, does not send the page back to calling the
  // transaction replaced.
  const childLinks = new Map<string, ReplacementLink>();
  const later = createMemo((): ReplacementLink[] => {
    const said = replacements()?.replacedBy;
    for (const l of said ?? []) {
      if (l.shared !== 0) continue;
      const k = `${l.txid}>${l.by}`;
      // Newest last.
      childLinks.delete(k);
      childLinks.set(k, { txid: l.txid, by: l.by, shared: 0 });
    }
    // No more than one answer can list, on a page left open through many: the oldest is
    // forgotten, but never a link the page is showing, which is the one it must not misname.
    const now = shownNow();
    const showing = new Set(
      now.kind === "replaced" ? now.chain.map((l) => `${l.txid}>${l.by}`) : [],
    );
    while (childLinks.size > CHILD_LINKS_KEPT) {
      const oldest = [...childLinks.keys()].find((k) => !showing.has(k));
      if (oldest === undefined) break;
      childLinks.delete(oldest);
    }
    if (!said) return [...childLinks.values()];
    const spoken = new Set(said.map((l) => `${l.txid}>${l.by}`));
    const remembered = [...childLinks].filter(([k]) => !spoken.has(k)).map(([, l]) => l);
    return remembered.length === 0 ? said : [...said, ...remembered];
  });
  const replaced = () => replacements()?.replaces.filter((l) => l.by === props.txid) ?? [];
  // Shown as replaced, but by nothing of its own: it left with a transaction it depended on.
  const childNow = () => {
    const s = shownNow();
    return s.kind === "replaced" && leftWithParent(s.chain[0], later());
  };

  // Who it is mined with: asked again when its group's rate changes.
  const relativesKey = () => {
    const s = shownNow();
    return s.kind === "mempool" && s.position ? `${s.position.effectiveRate}` : false;
  };
  const [relatives] = createRequest(relativesKey, async () => {
    try {
      return (
        parseRelatives(
          await fetchApp<unknown>(network(), `/tx/${props.txid}/relatives`, {
            signal: controller.signal,
            cached: true,
          }),
        ) ?? null
      );
    } catch {
      return null;
    }
  });

  // Each change of state is said once, in words; a position that only moves is not.
  const [announcement, setAnnouncement] = createSignal("");
  // The same words twice in a row are still said twice. A live region speaks only when its text
  // changes, so a repeat carries a trailing no-break space, which is not read out: no change of
  // state goes unannounced for being worded like the one before it.
  const say = (text: string) => setAnnouncement((now) => (now === text ? `${text}\u00A0` : text));
  // The topic's word comes first and says only "replaced": once the route says it left with a
  // transaction it depended on, that is said, so the announcement does not stand uncorrected.
  createEffect(childNow, (is, was) => {
    if (is && was !== true) say(LEFT_WITH_PARENT);
  });
  const [justConfirmed, setJustConfirmed] = createSignal(false);
  const [reorged, setReorged] = createSignal<number>();
  createEffect(shownNow, (after, before) => {
    if (!before) return;
    const said = sayChange(before, after, childNow());
    if (said !== undefined) say(said);
    if (after.kind === "confirmed") {
      // Once, when it confirms; the block's time arriving a moment later changes nothing.
      if (before.kind !== "confirmed") setJustConfirmed(before.kind === "mempool");
      setReorged(undefined);
    } else {
      setJustConfirmed(false);
      if (after.kind === "mempool" && before.kind === "confirmed") setReorged(before.height);
    }
  });

  const topic = txTopic(props.txid);
  return (
    <>
      <Show when={following()}>
        <Follow
          topic={topic}
          message={heardTx}
          // After a reconnect the topic speaks afresh: what it said before vouches for nothing now.
          resync={() => setModel((m) => ({ ...m, last: undefined }))}
          again={(r) => {
            restart = r;
          }}
        />
      </Show>
      <Show when={watching()}>
        <Follow topic={blocksTopic} message={heardBlock} resync={() => void check()} />
      </Show>
      <header class="tx-head">
        <div class="tx-head__row">
          <h1>Transaction</h1>
          <Show
            when={shownNow().kind !== "loading" && !(missing() && shownNow().kind === "gone")}
            fallback={
              tx.error === undefined && (
                <span class="tx-status tx-status--pending" aria-hidden="true" />
              )
            }
          >
            <StatusBadge shown={shownNow()} child={childNow()} />
          </Show>
          <Show when={following()}>
            <LiveState liveness={live()} network={NETWORK_NAMES[network()]} />
          </Show>
        </div>
        <HashFull value={props.txid} copyLabel="Copy transaction ID" />
      </header>
      <p class="visually-hidden" aria-live="polite">
        {announcement()}
      </p>
      <p class="visually-hidden" aria-live="polite">
        {lookalikeSaid()}
      </p>
      <Switch fallback={<Skeleton />}>
        <Match when={missing() && shownNow()} keyed>
          {(s) => <Departed shown={s} replacements={replacements()} later={later()} />}
        </Match>
        <Match when={tx.error}>
          <ErrorState title="Could not load this transaction" error={tx.error} retry={retry} />
        </Match>
        <Match when={ready()}>
          {(t) => (
            <Body
              tx={t()}
              shown={shownNow()}
              status={status()}
              tip={tip()}
              confs={confs()}
              spends={spends}
              spendsTip={spendsTip}
              justConfirmed={justConfirmed()}
              reorged={reorged()}
              replaced={replaced()}
              versions={replacements()?.versions}
              later={later()}
              relatives={relatives() ?? undefined}
              liveness={live()}
              lookalike={handed()}
            />
          )}
        </Match>
      </Switch>
    </>
  );
}

/**
 * A transaction the node does not have: what this server knows of it, and no more. Replaced or
 * dropped while someone followed it, replaced while the server remembered, or simply not found.
 */
function Departed(props: {
  shown: Shown;
  replacements: Replacements | null | undefined;
  /** What replaced it, as the route said, or the child's links it said before an ask failed. */
  later: ReplacementLink[];
}) {
  const network = useNetwork();
  return (
    <Switch
      fallback={
        <Empty title="Transaction not found">
          <p>
            The {NETWORK_NAMES[network()]} node does not know this transaction. It may not have been
            broadcast yet, it may have left the mempool after being replaced or dropped, or it may
            belong to another network.
          </p>
          <Show when={props.replacements}>
            <p>
              This server keeps a record of recent replacements, and it has none for this
              transaction. The record starts when the server does, so an older replacement would not
              be in it.
            </p>
          </Show>
          <p>If it is broadcast while this page is open, it appears here.</p>
        </Empty>
      }
    >
      <Match when={props.shown.kind === "replaced" && props.shown} keyed>
        {(s) => (
          <ReplacedNotice
            chain={s.chain}
            truncated={s.truncated}
            versions={props.replacements?.versions}
            later={props.later}
          />
        )}
      </Match>
      <Match when={props.shown.kind === "evicted"}>
        <Notice tone="negative" title="Dropped from the mempool without being mined">
          <p>{EVICTED}</p>
        </Notice>
      </Match>
      <Match when={props.shown.kind === "mempool" || props.shown.kind === "confirmed"}>
        <Skeleton />
      </Match>
    </Switch>
  );
}

/** Why a transaction leaves without a reason the node reports (docs/MEMPOOL.md). */
const EVICTED =
  "The node let it go: pushed out by transactions paying more while the mempool was full, expired after two weeks, made invalid by a reorganisation, or replaced by a transaction this server did not see. It will not confirm unless it is broadcast again.";

function Notice(props: { tone: "negative" | "caution"; title: string; children: JSX.Element }) {
  return (
    <div class={`tx-notice tx-notice--${props.tone}`}>
      <Icon tone={props.tone} />
      <div class="tx-notice__body">
        <p class="tx-notice__title">{props.title}</p>
        {props.children}
      </div>
    </div>
  );
}

function ReplacedNotice(props: {
  chain: ReplacementLink[];
  truncated: boolean;
  versions?: string[] | undefined;
  later?: ReplacementLink[] | undefined;
}) {
  const first = () => props.chain[0];
  const child = () => leftWithParent(first(), props.later);
  return (
    <Notice
      tone="negative"
      title={child() ? "Removed with a replaced transaction" : "This version was replaced"}
    >
      <Show when={child() && first()}>
        {(l) => (
          <p>
            It left the mempool when <Hash value={l().by} href={paths.tx(l().by)} copy={false} />{" "}
            replaced a transaction it depended on. No new version of this transaction took its
            place. It can still confirm only if the replaced transaction is mined after all.
          </p>
        )}
      </Show>
      <Show when={!child() && first()}>
        {(l) => (
          <p>
            Another transaction spending the same coins took its place:{" "}
            <Hash value={l().by} href={paths.tx(l().by)} copy={false} />
            <Show when={l().byRate !== undefined && l().rate !== undefined}>
              , paying <FeeRate rate={l().byRate ?? 0} /> where this one paid{" "}
              <FeeRate rate={l().rate ?? 0} />
            </Show>
            <Show when={l().byFee !== undefined && l().fee !== undefined}>
              {" "}
              (a fee of <Sats sats={l().byFee ?? 0} /> instead of <Sats sats={l().fee ?? 0} />)
            </Show>
            . This version can no longer confirm.
          </p>
        )}
      </Show>
      <Chain
        chain={props.chain}
        truncated={props.truncated}
        versions={props.versions ?? []}
        later={props.later ?? []}
        explained
      />
    </Notice>
  );
}

const Icon = (props: { tone: "positive" | "caution" | "negative" }) => (
  <svg class="tx-icon" viewBox="0 0 16 16" aria-hidden="true">
    {props.tone === "positive" ? (
      <path d="M4.5 8.5l2.4 2.4L11.8 5.6" />
    ) : props.tone === "caution" ? (
      <circle cx="8" cy="8" r="5.5" stroke-dasharray="2.6 2" />
    ) : (
      <path d="M5 5l6 6M11 5l-6 6" />
    )}
  </svg>
);

const BADGES: Record<
  Exclude<Shown["kind"], "loading">,
  [string, "positive" | "caution" | "negative"]
> = {
  mempool: ["Unconfirmed", "caution"],
  confirmed: ["Confirmed", "positive"],
  replaced: ["Replaced", "negative"],
  evicted: ["Dropped", "negative"],
  gone: ["Removed", "negative"],
};

function StatusBadge(props: { shown: Shown; child?: boolean }) {
  // A child that left with its replaced parent was removed, not replaced.
  const badge = () =>
    props.shown.kind === "loading"
      ? undefined
      : BADGES[props.child === true ? "gone" : props.shown.kind];
  return (
    <Show when={badge()}>
      {(b) => (
        <span class={`tx-status tx-status--${b()[1]}`}>
          <Icon tone={b()[1]} />
          {b()[0]}
        </span>
      )}
    </Show>
  );
}

interface Step {
  title: string;
  detail: JSX.Element;
  state: "done" | "current" | "todo" | "dead";
  tone?: "positive" | "caution" | "negative";
}

function Body(props: {
  tx: Transaction;
  shown: Shown;
  /** The status as shown: undefined once it has left the mempool unconfirmed. */
  status: TxStatus | undefined;
  tip: number | undefined;
  confs: number | undefined;
  spends: () => Outspend[] | null | undefined;
  spendsTip: () => ChainTip | undefined;
  justConfirmed: boolean;
  /** The height of the block that held it, when a reorganisation sent it back to the mempool. */
  reorged: number | undefined;
  /** What it replaced, as far as the server remembers. */
  replaced: ReplacementLink[];
  /** Its line of versions, from the replacements route: undefined until asked. */
  versions: string[] | undefined;
  /** What replaced it, from the same route: how many inputs each pair shares. */
  later: ReplacementLink[];
  relatives: Relatives | undefined;
  liveness: Liveness;
  /** Lookalikes handed over from an address page's flagged row, checked against this transaction. */
  lookalike: Handover | undefined;
}) {
  const network = useNetwork();
  const coinbase = () => isCoinbase(props.tx);
  const status = () => props.status;
  const confirmed = () => status()?.confirmed === true;
  /** Left the mempool without confirming: replaced, dropped, or gone for a reason nobody knows. */
  const left = () => props.status === undefined;
  const mempool = () => (props.shown.kind === "mempool" ? props.shown : undefined);
  const genesis = () => coinbase() && status()?.block_height === 0;
  const [selected, setSelected] = createSignal<Selection | null>(null);
  let inspectorHeading: HTMLHeadingElement | undefined;
  // What the transaction shows an observer, worked out with the page itself, so nothing moves in
  // after it loads. A coinbase has no sender to give away and shows nothing.
  const privacy = createMemo(() => checkPrivacy(props.tx));
  const privacyMarks = createMemo(() => cardMarks(shownFindings(privacy(), false)));
  // Wide, the list is a panel of its own in the side column, first when it has something to say;
  // narrower, it sits under the flow and the summary carries a line that leads to it
  // (docs/DESIGN.md "Transaction").
  // Findings, or only part checked: what the summary's line counts.
  const reported = () => sayCount(privacy()) !== null;
  const stackedQuery = matchMedia(`(max-width: ${STACKED})`);
  const [stacked, setStacked] = createSignal(stackedQuery.matches);
  const onStacked = (e: MediaQueryListEvent) => setStacked(e.matches);
  stackedQuery.addEventListener("change", onStacked);
  onCleanup(() => stackedQuery.removeEventListener("change", onStacked));

  // Wide, the inspector opens in the side panel beside the flow, so nothing moves; narrower, the
  // panel is under the flow, and what opened is brought into view.
  const select = (s: Selection) => {
    const cur = selected();
    if (cur && cur.side === s.side && cur.index === s.index) {
      // Its own button pressed again: closed like Close, the focus to that button (flash.ts).
      // At once, not a frame later: the button is here now, and a later opener is never taken.
      setSelected(null);
      returnFocus(s.side, s.index);
      return;
    }
    setSelected(s);
    const under = stacked();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      if (under) {
        inspectorHeading?.scrollIntoView({
          block: "nearest",
          behavior: reduce ? "auto" : "smooth",
        });
      }
      inspectorHeading?.focus({ preventScroll: true });
    });
  };

  // Shown as replaced, but by nothing of its own: it left with a transaction it depended on.
  const child = () =>
    props.shown.kind === "replaced" && leftWithParent(props.shown.chain[0], props.later);
  // The full sequence, for a transaction that left the mempool unconfirmed or came back to it.
  const steps = (): Step[] => {
    const title = coinbase() ? "Spendable" : "Six confirmations";
    const third: Step =
      props.shown.kind === "replaced"
        ? {
            title: child() ? "Not expected to confirm" : "Will not confirm",
            detail: child()
              ? "Unless the transaction it depended on is mined after all, in place of what replaced it."
              : "Its coins are spent by the version that replaced it.",
            state: "dead",
          }
        : left()
          ? { title, detail: "", state: "dead" }
          : { title, detail: "Most services treat six confirmations as final.", state: "todo" };
    const first: Step = {
      title: "Broadcast",
      detail: (
        <>
          <span>
            {mempool()?.time === undefined
              ? "Relayed to the network."
              : "Relayed to the network; first seen"}
          </span>
          <Show when={mempool()?.time}>{(t) => <TimeUtc time={t()} />}</Show>
        </>
      ),
      state: "done",
    };
    const second = ((): Step => {
      const now = props.shown;
      if (now.kind === "replaced") {
        const l = now.chain[0];
        // A child's own link: it left with a transaction it depended on, replaced by what it names.
        if (l && child()) {
          return {
            title: "Removed with its parent",
            detail: (
              <>
                <span>
                  When <Hash value={l.by} href={paths.tx(l.by)} copy={false} /> replaced a
                  transaction it depended on
                </span>
                <Show when={l.seen}>{(t) => <TimeUtc time={t()} />}</Show>
              </>
            ),
            state: "dead",
            tone: "negative",
          };
        }
        return {
          title: "Replaced",
          detail: l ? (
            <>
              <span>
                By <Hash value={l.by} href={paths.tx(l.by)} copy={false} />
                <Show when={l.byRate !== undefined}>
                  {" "}
                  at <FeeRate rate={l.byRate ?? 0} />
                </Show>
              </span>
              <Show when={l.seen}>{(t) => <TimeUtc time={t()} />}</Show>
            </>
          ) : (
            ""
          ),
          state: "dead",
          tone: "negative",
        };
      }
      if (now.kind === "evicted") {
        return {
          title: "Dropped from the mempool",
          detail: "Without being mined. It will not confirm unless it is broadcast again.",
          state: "dead",
          tone: "negative",
        };
      }
      if (left()) {
        return {
          title: "No longer in the mempool",
          detail:
            "Replaced by a transaction spending the same coins, or dropped. It will not confirm unless it is sent again.",
          state: "dead",
          tone: "negative",
        };
      }
      const p = mempool()?.position;
      return {
        title: "Waiting for a block",
        detail: p ? (
          <span>
            <Link href={paths.projected(place(p, network()).page)}>
              {place(p, network()).where}
            </Link>
            , projected.
          </span>
        ) : (
          "This page updates when it confirms."
        ),
        state: "current",
        tone: "caution",
      };
    })();
    return [first, second, third];
  };

  const v = () => vsize(props.tx);
  const rate = () => {
    const size = v();
    return !coinbase() && props.tx.fee !== undefined && size !== undefined && size !== 0
      ? props.tx.fee / size
      : undefined;
  };
  /** The rate it will be mined at, when that differs from its own. */
  const effective = () => {
    const eff = mempool()?.position?.effectiveRate;
    const own = rate();
    return eff !== undefined && own !== undefined && ratesDiffer(eff, own) ? eff : undefined;
  };
  // Its rate against its block's low end: only once mined, and only when nothing could make it
  // mislead (docs/FRONTEND.md "A confirmed transaction's fee verdict").
  /** Whether a verdict may come: its line is kept from then on. */
  const judged = () => {
    const at = status();
    return (
      confirmed() &&
      !coinbase() &&
      rate() !== undefined &&
      at?.block_hash !== undefined &&
      at.block_height !== undefined
    );
  };
  const verdictKey = () => {
    const at = status();
    // After the page's own spends, which are used when they are as of this block.
    if (!judged() || props.spends() === undefined) return false;
    return `${at?.block_height}:${at?.block_hash}`;
  };
  const [verdict] = createRequest(verdictKey, async (key, signal) => {
    const [h = "", block = ""] = key.split(":");
    const height = Number(h);
    try {
      return await judgeFee({
        rate: rate(),
        block,
        height,
        parents: parentsOf(props.tx.vin ?? []),
        summary: async () => (await fetchSummaries(network(), [block], signal)).get(block),
        // Spends answered before this block was known (asked as it arrived, before a live
        // confirmation, or while another block held it at this height) cannot show a child mined
        // in it: they are asked again.
        spends: async () => {
          const value = props.spends();
          const tip = props.spendsTip();
          const sameLoad = props.tx.status.block_hash === block;
          return sameLoad && tip !== undefined && tip.height >= height
            ? { value, tip }
            : fetchStamped<Outspend[]>(network(), `/tx/${props.tx.txid}/outspends`, {
                signal,
              });
        },
        status: (txid) => fetchStamped<TxStatus>(network(), `/tx/${txid}/status`, { signal }),
      });
    } catch {
      return undefined;
    }
  });
  const lock = () => lockTimeMeaning(props.tx.locktime, props.tx.vin);
  const [raw, setRaw] = createSignal<{ hex?: string; error?: unknown; loading?: boolean }>({});
  const [rawShown, setRawShown] = createSignal(false);
  const loadRaw = async () => {
    setRaw({ loading: true });
    try {
      setRaw({
        hex: await fetchApi<string>(network(), `/tx/${props.tx.txid}/hex`, {
          as: "text",
          cached: true,
        }),
      });
    } catch (e) {
      setRaw({ error: e });
    }
  };
  const toggleRaw = () => {
    if (rawShown()) {
      setRawShown(false);
      return;
    }
    setRawShown(true);
    if (raw().hex === undefined && !raw().loading) void loadRaw();
  };

  const totalOut = () => props.tx.vout.reduce((sum, o) => sum + o.value, 0);
  const ins = () => props.tx.vin?.length ?? 0;
  const outs = () => props.tx.vout.length;
  /** Where it sits on the strip: in its projected block, or past the line in its own. */
  const stripAt = (): StripPlace | undefined => {
    if (confirmed()) return stripPlace({ confirmations: props.confs });
    const p = mempool()?.position;
    return p ? stripPlace({ position: p }) : undefined;
  };
  // A coinbase pays no fee rate, and fee colour is for fees.
  const stripColor = () => {
    const p = mempool()?.position;
    if (p) return feeColor(p.effectiveRate);
    const r = rate();
    return r === undefined ? "var(--color-text-muted)" : feeColor(r);
  };
  /** How many confirmations it has, against the six most wait for or a reward's hundred. */
  const confirmedSub = (): string => {
    if (genesis()) return "Never spendable";
    const c = props.confs;
    if (c === undefined) return "";
    const target = coinbase() ? MATURE : SETTLED;
    if (c < target) return `${groupDigits(c)} of ${groupDigits(target)} confirmations`;
    const count = plural(c, "confirmation");
    return coinbase() ? `Spendable: ${count}` : count;
  };
  /** Why there is no place in the queue to show, in a few words. */
  const unplaced = () =>
    props.liveness === "off"
      ? "Not followed here"
      : props.liveness === "connecting"
        ? ""
        : props.liveness === "live"
          ? "Not placed yet"
          : "Shows while live";
  /**
   * Waiting or confirmed, with nothing replaced or reorganised: the summary says all the steps
   * would, so they are left out. Otherwise the full sequence says how it came to this.
   */
  const settled = () =>
    props.reorged === undefined &&
    ((confirmed() && props.shown.kind === "confirmed") || props.shown.kind === "mempool");
  const rbf =
    "Until it confirms it can be replaced by a transaction spending the same coins that pays more: nodes relay one whatever its sequence numbers say (full replace-by-fee).";

  const marks = createMemo(() => marksOf(props.lookalike));
  return (
    <>
      <Show when={props.lookalike}>{(h) => <LookalikeNotice h={h()} />}</Show>
      {/* The answer first: where it is, what it paid, what it moved, and when. */}
      <dl class="tx-answer panel" aria-label="Summary">
        <div class="tx-answer__cell tx-answer__cell--where">
          <Switch
            fallback={
              <>
                <dt>Block</dt>
                <dd>
                  <span class="tx-answer__value">{MISSING}</span>
                  <span class="tx-answer__sub">
                    {child() ? "Not expected to confirm" : "Will not confirm"}
                  </span>
                </dd>
              </>
            }
          >
            <Match when={confirmed() && status()}>
              {(st) => (
                <>
                  <dt>Block</dt>
                  <dd>
                    <Link
                      class="tx-answer__value tap"
                      href={paths.block(st().block_hash ?? st().block_height ?? "")}
                    >
                      <span class="visually-hidden">block </span>
                      <span class="num">{groupDigits(st().block_height ?? Number.NaN)}</span>
                    </Link>
                    <Strip
                      place={stripAt() ?? stripPlace({ confirmations: undefined })}
                      color={stripColor()}
                      landed={props.justConfirmed}
                    />
                    <span class="tx-answer__sub">{confirmedSub()}</span>
                  </dd>
                </>
              )}
            </Match>
            <Match when={mempool()}>
              {(m) => (
                <>
                  <dt>Projected</dt>
                  <dd>
                    <Show
                      when={props.liveness !== "off" && m().position}
                      fallback={
                        <>
                          <span class="tx-answer__value">{MISSING}</span>
                          <span class="tx-strip" aria-hidden="true" />
                          <span class="tx-answer__sub">{unplaced()}</span>
                        </>
                      }
                    >
                      {(p) => (
                        <>
                          <Link
                            class="tx-answer__value tap"
                            href={paths.projected(place(p(), network()).page)}
                          >
                            {placeShort(p())}
                          </Link>
                          <Strip
                            place={stripAt() ?? stripPlace({ position: p() })}
                            color={stripColor()}
                            landed={false}
                          />
                          <span
                            class="tx-answer__sub num"
                            title={`${formatSize(p().aheadVsize)} ahead of it`}
                          >
                            {p().aheadTxs === 0
                              ? "Nothing ahead"
                              : `${groupDigits(p().aheadTxs)} tx${p().aheadTxs === 1 ? "" : "s"} ahead`}
                          </span>
                        </>
                      )}
                    </Show>
                  </dd>
                </>
              )}
            </Match>
          </Switch>
        </div>
        <div class="tx-answer__cell tx-answer__cell--fee">
          <dt>Fee rate</dt>
          <dd>
            <span class="tx-answer__value">
              <Show when={rate() !== undefined} fallback={coinbase() ? "None" : MISSING}>
                <FeeRate rate={rate() ?? 0} />
              </Show>
            </span>
            <span class="tx-answer__sub">
              <Show
                when={!coinbase() && props.tx.fee !== undefined}
                fallback={coinbase() ? "A coinbase, " : ""}
              >
                <Sats sats={props.tx.fee ?? 0} />,{" "}
              </Show>
              <span class="tx-answer__nowrap num">
                {v() === undefined ? MISSING : formatSize(v() ?? 0)}
              </span>
            </span>
            <Show when={effective()}>
              {(eff) => (
                <span class="tx-answer__sub">
                  Effective <FeeRate rate={eff()} />
                </span>
              )}
            </Show>
            {/* Its line is kept from the moment a verdict may come, so one arriving moves nothing
                where this cell has a row to itself (the narrowest phones). */}
            <Show when={judged()}>
              <span class="tx-answer__sub tx-verdict">
                <Show
                  when={verdictKey() !== false && verdict.state === "ready" && verdict()}
                  fallback={"\u00A0"}
                >
                  {(said) => (
                    <Note focusable below title={verdictTitle(said())} figure={verdictText(said())}>
                      {verdictDetail(said())}
                    </Note>
                  )}
                </Show>
              </span>
            </Show>
          </dd>
        </div>
        <div class="tx-answer__cell tx-answer__cell--amount">
          <dt>Amount</dt>
          <dd>
            <span class="tx-answer__value">
              <Amount sats={totalOut()} />
            </span>
            <span class="tx-answer__sub num">
              {plural(ins(), "input")} to {plural(outs(), "output")}
            </span>
          </dd>
        </div>
        <div class="tx-answer__cell">
          <dt>{confirmed() ? "Mined" : "First seen"}</dt>
          <dd>
            <Show
              when={confirmed() ? status()?.block_time : mempool()?.time}
              fallback={<span class="tx-answer__value">{MISSING}</span>}
            >
              {(t) => (
                <>
                  <span class="tx-answer__value">
                    <TimeAgo time={t()} />
                  </span>
                  <span class="tx-answer__sub">
                    <TimeUtc time={t()} />
                  </span>
                </>
              )}
            </Show>
          </dd>
        </div>
        {/* Narrow, a row of its own under the figures: the list is under the flow, off the first
            screen. Wide, the list opens the side column, in sight, so no row. */}
        <Show when={stacked() && !privacy().coinbase && sayCount(privacy())}>
          {(line) => (
            <div class="tx-answer__cell tx-answer__cell--privacy">
              <dt class="visually-hidden">Privacy</dt>
              <dd>
                <a
                  class="tx-answer__privacy"
                  href={`#${LIST_ID}`}
                  // A link within the page: never the router's "current page".
                  aria-current="false"
                  onClick={(e) => {
                    e.preventDefault();
                    const el = document.getElementById(LIST_ID);
                    if (el) bringIntoView(el, el, "start");
                  }}
                >
                  <Eye tone={countTone(privacy())} />
                  <span>{line()}</span>
                </a>
              </dd>
            </div>
          )}
        </Show>
      </dl>
      {/* The sentences behind the figures, one disclosure for the lot. */}
      <Switch>
        <Match when={confirmed()}>
          <More label={coinbase() ? "When it can be spent" : "When it is final"}>
            <p>
              {genesis()
                ? "The genesis block's reward was never added to the coins that can be spent."
                : coinbase()
                  ? `A miner's reward can be spent once ${MATURE} blocks are on top of the block that made it.`
                  : "Most services treat six confirmations as final: each block on top makes it harder to undo."}
            </p>
          </More>
        </Match>
        <Match when={mempool()}>
          {(m) => (
            <More label="How this changes">
              <Show
                when={props.liveness !== "off" && m().position}
                fallback={
                  <Show when={props.liveness !== "off"}>
                    <p>
                      {props.liveness === "live"
                        ? "Not placed yet: it reached the node a moment ago, and the projected blocks take it in with their next update."
                        : "Its place in the queue shows while the page is live. Until then the page checks over HTTP whether it has confirmed."}
                    </p>
                  </Show>
                }
              >
                {(p) => (
                  <>
                    <p class="tx-answer__figures">{place(p(), network()).ahead}</p>
                    <p>{place(p(), network()).when}</p>
                    <p>
                      A projection, not a promise: miners pick their own blocks, and anything that
                      pays more goes ahead of it.
                    </p>
                  </>
                )}
              </Show>
              <p>{rbf}</p>
            </More>
          )}
        </Match>
      </Switch>
      <Switch>
        <Match when={props.shown.kind === "replaced" && props.shown} keyed>
          {(r) => (
            <ReplacedNotice
              chain={r.chain}
              truncated={r.truncated}
              versions={props.versions}
              later={props.later}
            />
          )}
        </Match>
        <Match when={props.shown.kind === "evicted"}>
          <Notice tone="negative" title="Dropped from the mempool without being mined">
            <p>{EVICTED}</p>
          </Notice>
        </Match>
        <Match when={props.reorged}>
          {(h) => (
            <Notice tone="caution" title="Back in the mempool">
              <p>
                Block {groupDigits(h())}, which held this transaction, is no longer part of the
                chain: another branch overtook it. The transaction is waiting to be mined again, and
                until it is, it can be replaced like any other.
              </p>
            </Notice>
          )}
        </Match>
      </Switch>
      {/* A version that replaced others, and stands: what changed from the one before. */}
      <Show when={props.shown.kind !== "replaced" && props.versions}>
        {(line) => (
          <Show when={line().length > 1}>
            <div class="tx-versions">
              <CompareLine versions={line()} here={props.tx.txid} />
            </div>
          </Show>
        )}
      </Show>
      <Show when={!settled()}>
        <ol class="tx-timeline" aria-label="Status">
          {/* By position: each change of status updates the three steps in place, never remakes them. */}
          <For keyed={false} each={steps()}>
            {(step, i) => (
              <li
                class={`tx-step tx-step--${step().state}${step().tone ? ` tx-step--${step().tone}` : ""}`}
                aria-current={step().state === "current" ? "step" : undefined}
              >
                <span class="tx-step__marker num" aria-hidden="true">
                  {i + 1}
                </span>
                <span class="tx-step__title">{step().title}</span>
                <span class="tx-step__detail">{step().detail}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>

      <div class="tx-main">
        <section class="tx-main__flow" aria-labelledby="tx-flow-title">
          <SectionHeader title="Inputs and outputs" id="tx-flow-title" />
          {/* The node lists a pruned transaction's inputs whole or not at all (rbitcoin v0.9.2). */}
          <Show when={props.tx.pruned}>
            <p class="tx-note">
              {(props.tx.vin?.length ?? 0) === 0
                ? "This node has pruned the inputs of transactions this old, so none are listed."
                : "This node has pruned the scripts and signatures of transactions this old; the inputs still show what they spend."}
            </p>
          </Show>
          <Flow
            tx={props.tx}
            outspends={props.spends}
            selected={selected()}
            onSelect={select}
            lookalike={marks()}
            marks={privacyMarks()}
            onMark={() => {
              // The finding followed takes the focus; nothing is given back to the opener.
              setOpener(null);
              setSelected(null);
            }}
          />
          <Show when={stacked() && !privacy().coinbase}>
            <TxPrivacy report={privacy()} place="under" />
          </Show>
        </section>

        {/* The facts that are left; an input's or output's inspector takes their place. */}
        <div class={["tx-rail", { "tx-rail--open": selected() !== null }]}>
          {/* With something to report, the list opens the column, beside the marks it explains. */}
          <Show when={!stacked() && !privacy().coinbase && reported()}>
            <TxPrivacy report={privacy()} place="rail" />
          </Show>
          <section class="tx-rail__details" aria-labelledby="tx-details-title">
            <SectionHeader title="Details" id="tx-details-title" />
            <dl class="tx-facts tx-facts--rail">
              <Fact label="Size">
                <span class="num">
                  {props.tx.size === undefined ? MISSING : formatSize(props.tx.size, "B")}
                </span>
              </Fact>
              <Fact label="Weight">
                <span class="num">
                  {props.tx.weight === undefined ? MISSING : formatSize(props.tx.weight, "WU")}
                </span>
              </Fact>
              <Fact label="Replaceable">
                <Switch>
                  <Match when={child()}>No: it was removed with its parent</Match>
                  <Match when={props.shown.kind === "replaced"}>No: it was replaced</Match>
                  <Match when={left()}>No: it is no longer in the mempool</Match>
                  <Match when={confirmed()}>No: it is confirmed</Match>
                  <Match when={true}>Yes, until it confirms</Match>
                </Switch>
              </Fact>
              <Show when={props.replaced[0]}>
                {(l) => (
                  <Fact label="Replaces">
                    <span>
                      <Hash value={l().txid} href={paths.tx(l().txid)} copy={false} />
                      <Show when={l().rate !== undefined}>
                        , which paid <FeeRate rate={l().rate ?? 0} />
                      </Show>
                    </span>
                    <Show when={props.replaced.length > 1}>
                      <span class="tx-fact__sub">
                        and {groupDigits(props.replaced.length - 1)} more
                      </span>
                    </Show>
                  </Fact>
                )}
              </Show>
              <Fact label="Version">
                <span class="num">{props.tx.version}</span>
              </Fact>
              <Fact label="Witness">{features(props.tx)}</Fact>
              <Fact label="Lock time">
                <span class="num">{lock().value}</span>
                <span class="tx-fact__sub">{lock().detail}</span>
              </Fact>
              <Fact label="Raw hex">
                <span class="tx-fact__line">
                  <button
                    class="btn tx-fact__btn"
                    type="button"
                    aria-expanded={rawShown() ? "true" : "false"}
                    aria-controls="tx-raw"
                    onClick={toggleRaw}
                  >
                    {rawShown() ? "Hide" : "Show"}
                  </button>
                  <span class="tx-fact__sub num">
                    {props.tx.size === undefined ? "" : formatSize(props.tx.size, "B")}
                  </span>
                </span>
              </Fact>
            </dl>
            <div id="tx-raw" class="tx-raw">
              <Show when={rawShown()}>
                <Switch fallback={<p class="tx-fact__sub">Loading raw hex…</p>}>
                  <Match when={raw().hex}>
                    {(hex) => <Code label="Raw hex" value={hex()} bytes={hex().length / 2} />}
                  </Match>
                  <Match when={raw().error}>
                    <ErrorState
                      title="Could not load the raw transaction"
                      error={raw().error}
                      retry={() => void loadRaw()}
                    />
                  </Match>
                </Switch>
              </Show>
            </div>
            <Show when={mempool()?.live === true && props.relatives}>
              {(r) => <Group relatives={r()} txid={props.tx.txid} rate={rate() ?? null} />}
            </Show>
          </section>
          {/* Nothing to report: one muted panel, after the details. */}
          <Show when={!stacked() && !privacy().coinbase && !reported()}>
            <TxPrivacy report={privacy()} place="rail" />
          </Show>
          {/* Keyed: each selection mounts fresh, so no "Show all" carries over to another item. */}
          <Show when={selected()} keyed>
            {(s) => (
              <div class="tx-rail__over">
                <Inspector
                  tx={props.tx}
                  selected={s}
                  outspends={props.spends}
                  onClose={() => setSelected(null)}
                  lookalike={marks()}
                  ref={(el) => {
                    inspectorHeading = el;
                  }}
                />
              </div>
            )}
          </Show>
        </div>
      </div>
      <TxLightning txid={props.tx.txid} confirmed={confirmed()} />
    </>
  );
}

/** Where the side panel moves under the flow (docs/DESIGN.md "Breakpoints"). */
const STACKED = "65em";

const plural = (n: number, word: string) => `${groupDigits(n)} ${word}${n === 1 ? "" : "s"}`;

function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="tx-fact">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** Placeholders shaped like the page, so nothing moves when the transaction arrives. */
function Skeleton() {
  return (
    <div class="tx-skeleton" role="status">
      <span class="visually-hidden">Loading transaction</span>
      <div class="tx-answer panel" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>
          {() => (
            <div class="tx-answer__cell">
              <span class="tx-bar tx-bar--title" />
              <span class="tx-bar" />
              <span class="tx-bar" />
            </div>
          )}
        </For>
      </div>
      <div class="tx-main" aria-hidden="true">
        <div class="tx-main__flow panel">
          <div class="section__head">
            <span class="tx-bar tx-bar--head" />
          </div>
          <div class="tx-flow">
            <ul class="tx-flow__col">
              <li class="tx-flow__item tx-flow__item--ghost" />
            </ul>
            <span />
            <ul class="tx-flow__col">
              <li class="tx-flow__item tx-flow__item--ghost" />
              <li class="tx-flow__item tx-flow__item--ghost" />
            </ul>
          </div>
        </div>
        <div class="tx-rail">
          <div class="tx-rail__details panel">
            <div class="section__head">
              <span class="tx-bar tx-bar--head" />
            </div>
            <div class="tx-facts tx-facts--rail">
              <For each={[0, 1, 2, 3, 4, 5]}>
                {() => (
                  <div class="tx-fact">
                    <span class="tx-bar" />
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
