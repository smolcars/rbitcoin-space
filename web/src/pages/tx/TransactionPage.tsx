import { useParams } from "@solidjs/router";
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
import { Hash, HashFull } from "../../components/Hash";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { Empty, ErrorState } from "../../components/States";
import { TimeAgo, TimeUtc } from "../../components/Time";
import { createApi, createRequest, fetchApi, fetchApp, isNotFound } from "../../lib/api";
import { type BlocksMessage, blocksTopic } from "../../lib/blocks-topic";
import type { Outspend, Transaction, TxStatus } from "../../lib/esplora";
import { formatSize, groupDigits, MISSING, truncateMiddle } from "../../lib/format";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { useLiveStatus } from "../../lib/live";
import { useNetwork, usePageTitle } from "../../lib/page";
import { type ReplacementLink, type TxMessage, txTopic } from "../../lib/track-topics";
import { TxLightning } from "../lightning/TxLightning";
import { Code } from "./Code";
import { Flow, type Selection } from "./Flow";
import { Inspector } from "./Inspector";
import { Chain, Follow, Group, LiveState, POLL_MS, Where } from "./Live";
import {
  announcement as sayChange,
  answered,
  EMPTY,
  heard,
  type Liveness,
  liveness,
  type Model,
  parseRelatives,
  parseReplacements,
  place,
  polls,
  ratesDiffer,
  recorded,
  type Relatives,
  type Replacements,
  type Shown,
  shown,
} from "./state";
import { confirmations, features, isCoinbase, isTxid, lockTimeMeaning, vsize } from "./tx";
import "./TransactionPage.css";

export { POLL_MS } from "./Live";
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
  const [tx, { refetch }] = createApi<Transaction>(() => `/tx/${props.txid}`);
  // Fetched alongside the transaction rather than after it, so neither waits on the other.
  const [outspends, { refetch: refetchSpends }] = createApi<Outspend[]>(
    () => `/tx/${props.txid}/outspends`,
  );
  const [tipText, { refetch: refetchTip }] = createApi<string>(() => "/blocks/tip/height", {
    as: "text",
  });
  const retry = () => {
    refetch();
    refetchSpends();
    refetchTip();
  };

  const ready = () => (tx.state === "ready" ? tx() : undefined);
  /** The model's clock when the transaction was last asked for. */
  let txAsked = 0;
  /** Numbers the page's HTTP questions about the status, the first load being 0. */
  let requests = 0;
  let txReq = 0;
  const missing = () => tx.state === "errored" && isNotFound(tx.error);
  // undefined while loading; null when it failed, so the page can say so instead of waiting.
  const spends = () =>
    outspends.state === "ready" ? outspends() : outspends.state === "errored" ? null : undefined;

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
          fresh: true,
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
        fresh: true,
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
    if (l === "off" || l === "connecting") return false;
    if (missing()) return "missing";
    const s = shownNow().kind;
    if (s === "gone") return "gone";
    const t = ready();
    return t && !t.status.confirmed ? "waiting" : false;
  };
  // The page's own abort signal, not the request's: an answer a newer request replaced still
  // records what it learned in the model.
  const [replacements] = createRequest(replacementsKey, async () => {
    try {
      const r = parseReplacements(
        await fetchApp<unknown>(network(), `/tx/${props.txid}/replacements`, {
          signal: controller.signal,
        }),
      );
      if (r) setModel((m) => recorded(m, r.replacedBy, r.truncated));
      return r ?? null;
    } catch {
      return null;
    }
  });
  const replaced = () => replacements()?.replaces.filter((l) => l.by === props.txid) ?? [];

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
          }),
        ) ?? null
      );
    } catch {
      return null;
    }
  });

  // Each change of state is said once, in words; a position that only moves is not.
  const [announcement, setAnnouncement] = createSignal("");
  const [justConfirmed, setJustConfirmed] = createSignal(false);
  const [reorged, setReorged] = createSignal<number>();
  createEffect(shownNow, (after, before) => {
    if (!before) return;
    const said = sayChange(before, after);
    if (said !== undefined) setAnnouncement(said);
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
            <StatusBadge shown={shownNow()} />
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
      <Switch fallback={<Skeleton />}>
        <Match when={missing() && shownNow()} keyed>
          {(s) => <Departed shown={s} replacements={replacements()} />}
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
              justConfirmed={justConfirmed()}
              reorged={reorged()}
              replaced={replaced()}
              relatives={relatives() ?? undefined}
              liveness={live()}
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
function Departed(props: { shown: Shown; replacements: Replacements | null | undefined }) {
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
        {(s) => <ReplacedNotice chain={s.chain} truncated={s.truncated} />}
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

function ReplacedNotice(props: { chain: ReplacementLink[]; truncated: boolean }) {
  const first = () => props.chain[0];
  return (
    <Notice tone="negative" title="This version was replaced">
      <Show when={first()}>
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
      <Chain chain={props.chain} truncated={props.truncated} />
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

function StatusBadge(props: { shown: Shown }) {
  const badge = () => (props.shown.kind === "loading" ? undefined : BADGES[props.shown.kind]);
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
  justConfirmed: boolean;
  /** The height of the block that held it, when a reorganisation sent it back to the mempool. */
  reorged: number | undefined;
  /** What it replaced, as far as the server remembers. */
  replaced: ReplacementLink[];
  relatives: Relatives | undefined;
  liveness: Liveness;
}) {
  const network = useNetwork();
  const coinbase = () => isCoinbase(props.tx);
  const status = () => props.status;
  const confirmed = () => status()?.confirmed === true;
  /** Left the mempool without confirming: replaced, dropped, or gone for a reason nobody knows. */
  const left = () => props.status === undefined;
  const mempool = () => (props.shown.kind === "mempool" ? props.shown : undefined);
  const [selected, setSelected] = createSignal<Selection | null>(null);
  let inspectorHeading: HTMLHeadingElement | undefined;

  const select = (s: Selection) => {
    const cur = selected();
    if (cur && cur.side === s.side && cur.index === s.index) {
      setSelected(null);
      return;
    }
    setSelected(s);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      inspectorHeading?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      inspectorHeading?.focus({ preventScroll: true });
    });
  };

  const steps = (): Step[] => {
    const s = status();
    const block = (st: TxStatus) => (
      <>
        <span>
          In{" "}
          <Link href={paths.block(st.block_hash ?? st.block_height ?? "")}>
            block {groupDigits(st.block_height ?? Number.NaN)}
          </Link>
        </span>
        <Show when={st.block_time}>
          {(t) => (
            <>
              <TimeUtc time={t()} />
              <TimeAgo time={t()} />
            </>
          )}
        </Show>
      </>
    );
    const target = coinbase() ? MATURE : SETTLED;
    const third: Step = (() => {
      if (coinbase() && s?.block_height === 0) {
        return {
          title: "Never spendable",
          detail: "The genesis block's reward was never added to the coins that can be spent.",
          state: "done",
        };
      }
      const title = coinbase() ? "Spendable" : "Six confirmations";
      if (props.shown.kind === "replaced") {
        return {
          title: "Will not confirm",
          detail: "Its coins are spent by the version that replaced it.",
          state: "dead",
        };
      }
      if (left()) return { title, detail: "", state: "dead" };
      if (!s?.confirmed)
        return { title, detail: "Most services treat six confirmations as final.", state: "todo" };
      const c = props.confs;
      if (c === undefined) return { title, detail: "", state: "current" };
      const count = `${groupDigits(c)} confirmation${c === 1 ? "" : "s"}`;
      if (c >= target)
        return {
          title,
          detail: coinbase() ? `${count}: its outputs can be spent.` : `${count}.`,
          state: "done",
          tone: "positive",
        };
      return {
        title,
        detail: coinbase()
          ? `${count} of the ${MATURE} a miner's reward needs before it can be spent.`
          : `${count} of ${SETTLED} so far.`,
        state: "current",
      };
    })();
    const first: Step = coinbase()
      ? {
          title: "Created",
          detail: "A miner's reward, made with the block that holds it.",
          state: "done",
        }
      : {
          title: "Broadcast",
          detail: <Broadcast time={mempool()?.time} replaced={props.replaced} />,
          state: "done",
        };
    const second = ((): Step => {
      const now = props.shown;
      if (now.kind === "replaced") {
        const l = now.chain[0];
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
      if (s?.confirmed)
        return { title: "Confirmed", detail: block(s), state: "done", tone: "positive" };
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
  const lock = () => lockTimeMeaning(props.tx.locktime, props.tx.vin);
  const [raw, setRaw] = createSignal<{ hex?: string; error?: unknown; loading?: boolean }>({});
  const loadRaw = async () => {
    setRaw({ loading: true });
    try {
      setRaw({
        hex: await fetchApi<string>(network(), `/tx/${props.tx.txid}/hex`, { as: "text" }),
      });
    } catch (e) {
      setRaw({ error: e });
    }
  };

  const totalOut = () => props.tx.vout.reduce((sum, o) => sum + o.value, 0);
  const statusWord = () => (props.shown.kind === "loading" ? undefined : BADGES[props.shown.kind]);
  const summaryStatus = (): JSX.Element => {
    const s = status();
    if (s?.confirmed) {
      const c = props.confs;
      return c === undefined ? "" : `${groupDigits(c)} confirmation${c === 1 ? "" : "s"}`;
    }
    const p = mempool()?.position;
    if (p) {
      const at = place(p, network());
      return (
        <Link class="tap" href={paths.projected(at.page)}>
          {at.where}
        </Link>
      );
    }
    return statusWord() ? (steps()[1]?.title ?? "") : "";
  };
  /**
   * Confirmed, or waiting in the mempool, with nothing replaced or reorganised: the steps say no
   * more than the summary and where it waits do, so they shrink to one line.
   */
  const settled = () =>
    props.reorged === undefined &&
    ((confirmed() && props.shown.kind === "confirmed") || props.shown.kind === "mempool");

  return (
    <>
      {/* The answer first: where it is, how much it moved, what it paid, and when. */}
      <dl class="tx-summary panel" aria-label="Summary">
        <div class="tx-summary__item">
          <dt>Status</dt>
          <dd>
            <span class="tx-summary__value">{statusWord()?.[0] ?? MISSING}</span>
            <span class="tx-summary__sub">{summaryStatus()}</span>
          </dd>
        </div>
        <div class="tx-summary__item">
          <dt>Fee</dt>
          <dd>
            <Show
              when={rate() !== undefined}
              fallback={<span class="tx-summary__value">{coinbase() ? "None" : MISSING}</span>}
            >
              <span class="tx-summary__value">
                <FeeRate rate={effective() ?? rate() ?? 0} />
              </span>
              <span class="tx-summary__sub">
                <Sats sats={props.tx.fee ?? 0} />
                {effective() === undefined ? "" : ", effective rate with its group"}
              </span>
            </Show>
          </dd>
        </div>
        <div class="tx-summary__item tx-summary__item--amount">
          <dt>Amount</dt>
          <dd>
            <span class="tx-summary__value">
              <Amount sats={totalOut()} />
            </span>
            <span class="tx-summary__sub">
              {`Sent to ${groupDigits(props.tx.vout.length)} output${props.tx.vout.length === 1 ? "" : "s"}`}
            </span>
          </dd>
        </div>
        <div class="tx-summary__item">
          <Show
            when={status()?.confirmed && status()}
            fallback={
              <>
                <dt>First seen</dt>
                <dd>
                  <Show
                    when={mempool()?.time}
                    fallback={<span class="tx-summary__value">{MISSING}</span>}
                  >
                    {(t) => (
                      <>
                        <span class="tx-summary__value">
                          <TimeAgo time={t()} />
                        </span>
                        <span class="tx-summary__sub">
                          <TimeUtc time={t()} />
                        </span>
                      </>
                    )}
                  </Show>
                </dd>
              </>
            }
          >
            {(st) => (
              <>
                <dt>Block</dt>
                <dd>
                  <span class="tx-summary__value">
                    <Link
                      class="tap"
                      href={paths.block(st().block_hash ?? st().block_height ?? "")}
                    >
                      <span class="visually-hidden">block </span>
                      <span class="num">{groupDigits(st().block_height ?? Number.NaN)}</span>
                    </Link>
                  </span>
                  <span class="tx-summary__sub">
                    <Show when={st().block_time}>{(t) => <TimeUtc time={t()} />}</Show>
                  </span>
                </dd>
              </>
            )}
          </Show>
        </div>
      </dl>
      <Switch>
        <Match when={props.shown.kind === "replaced" && props.shown} keyed>
          {(r) => <ReplacedNotice chain={r.chain} truncated={r.truncated} />}
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
      <ol class={["tx-timeline", { "tx-timeline--line": settled() }]} aria-label="Status">
        {/* By position: each change of status updates the three steps in place, never remakes them. */}
        <For keyed={false} each={steps()}>
          {(step, i) => (
            <li
              class={[
                `tx-step tx-step--${step().state}${step().tone ? ` tx-step--${step().tone}` : ""}`,
                {
                  "tx-step--landed": props.justConfirmed && i === 1 && step().tone === "positive",
                },
              ]}
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

      <div class="tx-layout">
        <section class="tx-layout__flow" aria-labelledby="tx-flow-title">
          <SectionHeader title="Inputs and outputs" id="tx-flow-title">
            <span class="num">
              {groupDigits(props.tx.vin?.length ?? 0)} input{props.tx.vin?.length === 1 ? "" : "s"},{" "}
              {groupDigits(props.tx.vout.length)} output{props.tx.vout.length === 1 ? "" : "s"}
            </span>
          </SectionHeader>
          <Show when={props.tx.pruned}>
            <p class="tx-note">
              This node has pruned the inputs of transactions this old, so some are missing.
            </p>
          </Show>
          <Flow tx={props.tx} outspends={props.spends} selected={selected()} onSelect={select} />
          {/* Keyed: each selection mounts fresh, so no "Show all" carries over to another item. */}
          <Show when={selected()} keyed>
            {(s) => (
              <Inspector
                tx={props.tx}
                selected={s}
                outspends={props.spends}
                onClose={() => setSelected(null)}
                ref={(el) => {
                  inspectorHeading = el;
                }}
              />
            )}
          </Show>
        </section>

        <div class="tx-layout__fee">
          {/* Nothing to show with the mempool engine off: the head already says it is not live. */}
          <Show when={props.liveness !== "off" && mempool()}>
            {(m) => (
              <Where
                position={m().position}
                live={m().live}
                reserve={props.liveness === "live" || props.liveness === "connecting"}
              />
            )}
          </Show>
          <section aria-labelledby="tx-fee-title">
            <SectionHeader title="Fee" id="tx-fee-title" />
            <dl class="tx-facts tx-facts--single">
              <div class="tx-fact">
                <dt>Fee rate</dt>
                <dd>
                  <Show
                    when={rate() !== undefined}
                    fallback={coinbase() ? "None: a coinbase pays no fee" : MISSING}
                  >
                    <FeeRate rate={rate() ?? 0} />
                  </Show>
                </dd>
              </div>
              <Show when={effective()}>
                {(eff) => (
                  <div class="tx-fact">
                    <dt>Effective fee rate</dt>
                    <dd>
                      <FeeRate rate={eff()} />
                      <span class="tx-fact__sub">
                        The rate of the group it will be mined with (below).
                      </span>
                    </dd>
                  </div>
                )}
              </Show>
              <div class="tx-fact">
                <dt>Fee</dt>
                <dd>
                  <Show
                    when={!coinbase() && props.tx.fee !== undefined}
                    fallback={coinbase() ? "None" : MISSING}
                  >
                    <Sats sats={props.tx.fee ?? 0} />
                    <span class="tx-fact__sub">
                      <Amount sats={props.tx.fee ?? 0} />
                    </span>
                  </Show>
                </dd>
              </div>
              <div class="tx-fact">
                <dt>Virtual size</dt>
                <dd class="num">{v() === undefined ? MISSING : formatSize(v() ?? 0)}</dd>
              </div>
              <div class="tx-fact">
                <dt>Weight</dt>
                <dd class="num">
                  {props.tx.weight === undefined ? MISSING : formatSize(props.tx.weight, "WU")}
                </dd>
              </div>
              <div class="tx-fact">
                <dt>Size</dt>
                <dd class="num">
                  {props.tx.size === undefined ? MISSING : formatSize(props.tx.size, "B")}
                </dd>
              </div>
              <div class="tx-fact">
                <dt>Replaceable</dt>
                <dd>
                  <Switch>
                    <Match when={props.shown.kind === "replaced"}>No: it was replaced</Match>
                    <Match when={left()}>No: it is no longer in the mempool</Match>
                    <Match when={confirmed()}>No: it is confirmed</Match>
                    <Match when={true}>
                      Yes, until it confirms
                      <More label="Why">
                        <p>
                          Nodes relay a replacement that pays more, whatever this transaction's
                          sequence numbers say (full replace-by-fee).
                        </p>
                      </More>
                    </Match>
                  </Switch>
                </dd>
              </div>
            </dl>
            <Show when={mempool()?.live === true && props.relatives}>
              {(r) => <Group relatives={r()} txid={props.tx.txid} rate={rate() ?? null} />}
            </Show>
          </section>
        </div>

        <section class="tx-layout__details" aria-labelledby="tx-details-title">
          <SectionHeader title="Details" id="tx-details-title" />
          <dl class="tx-facts tx-facts--two">
            <div class="tx-fact">
              <dt>Version</dt>
              <dd class="num">{props.tx.version}</dd>
            </div>
            <div class="tx-fact">
              <dt>Witness</dt>
              <dd>{features(props.tx)}</dd>
            </div>
            <div class="tx-fact tx-fact--wide">
              <dt>Lock time</dt>
              <dd>
                <span class="num">{lock().value}</span>
                <span class="tx-fact__sub">{lock().detail}</span>
              </dd>
            </div>
            <div class="tx-fact tx-fact--wide">
              <dt>Raw transaction</dt>
              <dd>
                <Switch>
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
                  <Match when={true}>
                    <button
                      class="btn"
                      type="button"
                      onClick={() => void loadRaw()}
                      disabled={raw().loading}
                    >
                      {raw().loading ? "Loading raw hex…" : "Show raw hex"}
                    </button>
                    <span class="tx-fact__sub num">
                      {props.tx.size === undefined ? "" : formatSize(props.tx.size, "B")}
                    </span>
                  </Match>
                </Switch>
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <TxLightning txid={props.tx.txid} confirmed={confirmed()} />
    </>
  );
}

/** The first step's detail: when the node first saw it, and what it replaced. */
function Broadcast(props: { time: number | undefined; replaced: ReplacementLink[] }) {
  return (
    <>
      <span>
        {props.time === undefined
          ? "Relayed to the network."
          : "Relayed to the network; first seen"}
      </span>
      <Show when={props.time}>{(t) => <TimeUtc time={t()} />}</Show>
      <For each={props.replaced.slice(0, 1)}>
        {(l) => (
          <span>
            It replaced <Hash value={l.txid} href={paths.tx(l.txid)} copy={false} />
            <Show when={l.rate !== undefined}>
              , which paid <FeeRate rate={l.rate ?? 0} />
            </Show>
            {props.replaced.length > 1 ? ` and ${groupDigits(props.replaced.length - 1)} more` : ""}
            .
          </span>
        )}
      </For>
    </>
  );
}

/** Placeholders shaped like the page, so nothing moves when the transaction arrives. */
function Skeleton() {
  return (
    <div class="tx-skeleton" role="status">
      <span class="visually-hidden">Loading transaction</span>
      <ol class="tx-timeline" aria-hidden="true">
        <For each={[0, 1, 2]}>
          {() => (
            <li class="tx-step tx-step--todo">
              <span class="tx-step__marker" />
              <span class="tx-step__title">
                <span class="tx-bar tx-bar--title" />
              </span>
              <span class="tx-step__detail">
                <span class="tx-bar" />
              </span>
            </li>
          )}
        </For>
      </ol>
      <div class="tx-layout" aria-hidden="true">
        <div class="tx-layout__flow">
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
        <div class="tx-layout__fee">
          <div class="section__head">
            <span class="tx-bar tx-bar--head" />
          </div>
          <div class="tx-facts tx-facts--single">
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
  );
}
