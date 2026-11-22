import { useParams, useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { HashFull } from "../../components/Hash";
import { QrButton } from "../../components/qr/QrButton";
import { busyRetrying, createApi, createRequest, fetchApp } from "../../lib/api";
import { fetchConfig } from "../../lib/config";
import { type LiveStatus, useLiveStatus, useTopic } from "../../lib/live";
import type { AddressStats, Transaction } from "../../lib/esplora";
import { truncateMiddle } from "../../lib/format";
import { NETWORK_NAMES, type Network, onNetwork, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { type Recognised, recognise, TYPE_NAMES } from "../../lib/address";
import { type AddressMessage, addressTopic } from "../../lib/track-topics";
import { refusal } from "./address";
import { BalanceChart } from "./BalanceChart";
import { History } from "./History";
import { LargeAddress } from "./Large";
import { asksAgain, LEDGER_POLL_MS, readLedger, waiting } from "./ledger";
import { AddingUp, KeptAddress } from "./Kept";
import { readAt } from "./asof";
import { createLookalikes } from "./LookalikeNotice";
import { Notice, settled } from "./parts";
import { AsOfPicker, ClockIcon, PinnedBody } from "./Pinned";
import { SilentPaymentAddress } from "./SilentPayment";
import { Totals } from "./Totals";
import "./AddressPage.css";

/** How addresses start on each network, for the malformed-address message. */
const PREFIXES: Record<Network, string> = {
  mainnet: "bc1, 1 or 3",
  signet: "tb1, m, n or 2",
  testnet4: "tb1, m, n or 2",
  testnet5: "tb1, m, n or 2",
  regtest: "bcrt1, m, n or 2",
};

/**
 * The first history page waits this long for the totals: the node refuses them for size within tens
 * of milliseconds, and then the history is not asked for at all (docs/API.md, "Very large addresses").
 */
const HISTORY_WAITS_MS = 1000;

/**
 * The page asks for the address once the server has said where its history stands, or after this
 * long without a word: normally a few milliseconds, longer while the socket opens on a first load.
 */
const FOLLOW_WAITS_MS = 1000;

/** A history change the address index has not shown yet is asked again after 1, 2 and 4 s. */
const CATCH_UP_MS = 1000;
const CATCH_UP_TRIES = 3;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export default function AddressPage() {
  const params = useParams<{ address: string }>();
  const network = useNetwork();
  const input = () => decode(params.address);
  const found = createMemo(() => recognise(input()));
  // Recreates the body for another address or network, so nothing from the last one lingers.
  const key = () => {
    const f = found();
    return f?.networks.includes(network()) ? `${network()} ${f.address}` : undefined;
  };
  // A key has no address: the page is the key's, and says so.
  const isKey = () => found()?.type === "p2pk";
  // `?at=<height>`: the page as of that block (Pinned.tsx), made afresh for each block asked.
  const [search] = useSearchParams<{ at: string }>();
  const at = createMemo(() => readAt(search.at));
  const pinnedKey = () => {
    const k = key();
    return k !== undefined && at().kind !== "now" ? `${k} ${search.at ?? ""}` : undefined;
  };
  usePageTitle(
    () => `${isKey() ? "Public key" : "Address"} ${truncateMiddle(found()?.address ?? input())}`,
  );

  return (
    <div class="wrap address">
      <header class="address-head">
        <div class="address-head__row">
          <h1>{isKey() ? "Public key" : "Address"}</h1>
          <Show when={found()}>
            {(f) => (
              <span class="address-type" title={TYPE_NAMES[f().type].long}>
                {TYPE_NAMES[f().type].short}
              </span>
            )}
          </Show>
        </div>
        <Show when={found()} fallback={<p class="address-head__raw">{input()}</p>}>
          {(f) => (
            <HashFull value={f().address} copyLabel={isKey() ? "Copy public key" : "Copy address"}>
              {/* No code for a key: a wallet that scans one cannot pay it. */}
              <Show when={!isKey()}>
                <QrButton value={f().address} what="address" />
              </Show>
            </HashFull>
          )}
        </Show>
      </header>
      <Switch>
        <Match when={!found()}>
          <Malformed network={network()} />
        </Match>
        <Match when={key() === undefined}>
          <WrongNetwork found={found() as Recognised} network={network()} />
        </Match>
        {/* Read from the address alone: nothing is asked of the server for it. */}
        <Match when={found()?.type === "sp"}>
          <SilentPaymentAddress address={(found() as Recognised).address} network={network()} />
        </Match>
        <Match when={pinnedKey()} keyed>
          {(k) => (
            <PinnedBody
              address={k.split(" ")[1] ?? ""}
              isKey={found()?.type === "p2pk"}
              at={untrack(at)}
              page={k.split(" ").slice(0, 2).join(" ")}
            />
          )}
        </Match>
        <Match when={key()} keyed>
          {(k) => <AddressBody address={k.slice(k.indexOf(" ") + 1)} found={found()} page={k} />}
        </Match>
      </Switch>
    </div>
  );
}

function AddressBody(props: {
  address: string;
  found: Recognised | null;
  /** This page's settled key (the keyed match's): network and normalised address. */
  page: string;
}) {
  const network = useNetwork();
  // The page is made afresh for each address (AddressPage keys it).
  const address = untrack(() => props.address);
  const path = `/address/${encodeURIComponent(address)}`;
  const socket = useLiveStatus();
  // Follow first, then ask (docs/WS.md): a change before the first status is in what the page then
  // asks for, and a change after it is a new status. Asked early, with no status to come soon (the
  // socket is down, or slow to open), the first status that comes is treated as a change.
  const [asking, setAsking] = createSignal(false);
  let started = false;
  const [waited, setWaited] = createSignal(false);
  let wait: ReturnType<typeof setTimeout> | undefined;
  const ask = () => {
    if (started) return;
    started = true;
    setAsking(true);
    wait = setTimeout(() => setWaited(true), HISTORY_WAITS_MS);
  };
  const follow = setTimeout(ask, FOLLOW_WAITS_MS);
  onCleanup(() => {
    clearTimeout(follow);
    clearTimeout(wait);
  });
  createEffect(socket, (s) => {
    if (s === "reconnecting" || s === "offline") ask();
  });
  // Every answer from the server: one the browser kept a second could predate the status.
  const [stats, { refetch: refetchStats }] = createApi<AddressStats>(() => asking() && path);
  // Once true, stays true: a later refetch of the totals does not take the history away.
  const statsAnswered = createMemo(
    (was?: boolean) =>
      was === true || waited() || (stats.state !== "unresolved" && stats.state !== "pending"),
  );
  const tooLarge = () => stats.state === "errored" && refusal(stats.error) === "too-large";
  // What the server's own ledger says of it (docs/API.md, "Very large addresses"): asked once the
  // totals have answered, from memory and the store only, and again while it is being added up.
  // Asked again once the totals settle: a slow answer may have taught the server it is large.
  const statsSettled = () => stats.state !== "unresolved" && stats.state !== "pending";
  const [ledgerAnswer, { refetch: refetchLedger }] = createRequest(
    () => statsAnswered() && `${network()} ${statsSettled() ? "settled" : "waited"}`,
    (_, signal) => fetchApp<unknown>(untrack(network), `${path}/ledger`, { signal }),
  );
  const ledger = createMemo(() => readLedger(ledgerAnswer.latest));
  const ledgerAnswered = () =>
    ledgerAnswer.state !== "unresolved" && ledgerAnswer.state !== "pending";
  const kept = () => {
    const l = ledger();
    return l.state === "tracked" ? l : undefined;
  };
  // Too large for the node to answer at once, or answered by it too slowly: the large page.
  const large = () =>
    tooLarge() || (stats.state === "errored" && ledger().state !== "none" && !kept());
  // While a seed waits or runs, every few seconds; after one failed, now and then, since the
  // server tries again only when it is asked after its pause.
  let lastAsk = Date.now();
  const askLedger = () => {
    if (document.hidden || ledgerAnswer.loading) return;
    const l = ledger();
    if (!asksAgain(l, Date.now() - lastAsk)) return;
    lastAsk = Date.now();
    refetchLedger();
  };
  const ledgerTimer = setInterval(askLedger, LEDGER_POLL_MS);
  onCleanup(() => clearInterval(ledgerTimer));
  // Added up meanwhile: the totals now come from the ledger.
  createEffect(
    () => kept() !== undefined,
    (isKept, was) => {
      if (isKept && was === false) refetchStats();
    },
  );
  // Every transaction of a kept address once the server keeps its whole history: its confirmed
  // pages, since its unconfirmed ones are listed apart.
  const whole = () => kept()?.history === "whole";
  const [first, { refetch: refetchFirst }] = createApi<Transaction[]>(
    () =>
      statsAnswered() &&
      ledgerAnswered() &&
      (whole() ? `${path}/txs/chain` : !kept() && !large() && `${path}/txs`),
  );
  // As an address becomes a kept one, the mixed list it had is still showing until the kept list
  // answers: confirmed only by the rows themselves too.
  const { onShown, lookalike, notice, announced } = createLookalikes(
    address,
    (shown) => whole() && shown.every((t) => t.status.confirmed),
  );
  let refreshHistory = () => {
    // Replaced by History once it mounts.
  };
  let refreshBalance = () => {
    // Replaced by the balance chart once it mounts.
  };

  // A refusal that holds for the whole address, from whichever request answered first.
  const pageRefusal = () => {
    for (const r of [stats, first]) {
      if (r.state !== "errored") continue;
      const kind = refusal(r.error);
      if (kind === "no-index" || kind === "invalid" || kind === "wrong-network") return kind;
    }
    return undefined;
  };
  const retryAll = () => {
    refetchStats();
    if (first.state === "errored") refetchFirst();
  };

  // The address topic says when its history changes; the page then refetches what it shows.
  // A request still in flight is asked again, so its answer is as new as the change.
  const asked = (state: string) =>
    state === "ready" || state === "refreshing" || state === "pending";
  const refresh = () => {
    if (asked(stats.state)) refetchStats();
    if (asked(first.state)) refetchFirst();
    refreshHistory();
    refreshBalance();
  };
  // A refetch that brings nothing new is tried again, a few times, in case the node's index trails
  // its status: never seen on regtest once answers skip the browser's cache, kept as a guard.
  const fingerprint = () =>
    JSON.stringify([settled(stats), settled(first)?.map((t) => [t.txid, t.status.block_hash])]);
  let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(catchUpTimer));
  const catchUp = (before: string, attempt = 0) => {
    clearTimeout(catchUpTimer);
    refresh();
    if (attempt >= CATCH_UP_TRIES) return;
    const check = () => {
      if (stats.state === "refreshing" || first.state === "refreshing") {
        catchUpTimer = setTimeout(check, CATCH_UP_MS);
      } else if (fingerprint() === before) {
        catchUp(before, attempt + 1);
      }
    };
    catchUpTimer = setTimeout(check, CATCH_UP_MS * 2 ** attempt);
  };
  const [watch, setWatch] = createSignal<AddressMessage>();
  /** The last status heard; undefined before the first. */
  let token: string | null | undefined;
  useTopic(addressTopic(address), {
    message: (m) => {
      setWatch(m);
      // A block changed what the ledger keeps, or it began keeping it.
      if (m.type === "ledger") {
        if (started) {
          refetchLedger();
          refetchStats();
          if (whole()) refetchFirst();
        }
        ask();
        return;
      }
      if (m.type !== "watching") {
        ask();
        return;
      }
      const before = token;
      token = m.status;
      // The first status before the page asked: what it asks now is at least as new.
      if (!started) {
        ask();
        return;
      }
      if (before !== m.status) catchUp(fingerprint());
    },
    // After a reconnect the first message is compared with the last status heard.
    resync: () => undefined,
  });

  // Whether the page is live, and the way to see it as of a past block, on one row: made once,
  // above the switch, so a page that turns out kept does not make its button a second time.
  const status = () => (
    <div class="address-status">
      <LiveLine watch={watch()} socket={socket()} />
      <AsOfPicker
        id="address-asof-pick"
        page={untrack(() => props.page)}
        title={`This ${props.found?.type === "p2pk" ? "key" : "address"} at a past block`}
        class="address-asof-open"
        arrival
        label={
          <>
            <ClockIcon />
            As of a block
          </>
        }
      />
    </div>
  );

  return (
    <>
      {/* Present from the start, so the one announcement it makes is heard. */}
      <p class="visually-hidden address-announce" aria-live="polite">
        {announced()}
      </p>
      <Show when={pageRefusal() === undefined && !large()}>{status()}</Show>
      <Switch>
        <Match when={pageRefusal() === "no-index"}>
          <Notice title="This server does not index addresses" tone="caution">
            Its node runs without an address index, so it cannot show the balance or history of any
            address. This says nothing about this address or its funds: look it up with another
            explorer or your own node.
          </Notice>
        </Match>
        <Match when={pageRefusal() === "invalid"}>
          <Show when={props.found?.type === "p2pk"} fallback={<Malformed network={network()} />}>
            <Notice title="This is not a valid public key" tone="caution">
              It has a key's length and first digits, but it is not a point on Bitcoin's curve.
              Check it for a mistyped character.
            </Notice>
          </Show>
        </Match>
        <Match when={pageRefusal() === "wrong-network" && props.found}>
          {(f) => <WrongNetwork found={f()} network={network()} />}
        </Match>
        {/* An address the server keeps its own totals for: they come at once. */}
        <Match when={kept()}>
          {(k) => (
            <>
              {notice()}
              <KeptAddress
                address={props.address}
                ledger={k()}
                stats={stats}
                retry={retryAll}
                whole={
                  <History
                    address={props.address}
                    stats={stats}
                    first={first}
                    retryFirst={() => refetchFirst()}
                    onRefresh={(fn) => {
                      refreshHistory = fn;
                    }}
                    kept
                    lookalike={lookalike()}
                    onShown={onShown}
                  />
                }
              />
            </>
          )}
        </Match>
        {/* What the node says about an address above its cap, its unconfirmed transactions, and
            whether the server is adding it up. */}
        <Match when={large()}>
          <LargeAddress
            address={props.address}
            note={
              waiting(ledger()) || ledger().state === "failed" ? (
                <AddingUp ledger={ledger()} />
              ) : undefined
            }
          />
        </Match>
        <Match when={true}>
          <Show when={busyRetrying()}>
            <p class="address-busy" role="status">
              The server is busy for a moment, so this page is waiting to ask again.
            </p>
          </Show>
          {notice()}
          <Totals stats={stats} retry={retryAll} />
          <BalanceChart
            address={props.address}
            stats={stats}
            after={first.state !== "unresolved" && first.state !== "pending"}
            onRefresh={(fn) => {
              refreshBalance = fn;
            }}
          />
          <History
            address={props.address}
            held={!ledgerAnswered()}
            stats={stats}
            first={first}
            retryFirst={() => refetchFirst()}
            onRefresh={(fn) => {
              refreshHistory = fn;
            }}
            lookalike={lookalike()}
            onShown={onShown}
          />
        </Match>
      </Switch>
    </>
  );
}

/**
 * Whether the page updates itself, said quietly: a word when it does, and why not when it cannot.
 * Nothing before the first answer, so a normal load shows no flicker of "connecting".
 */
function LiveLine(props: { watch: AddressMessage | undefined; socket: LiveStatus }) {
  const why = (): string | undefined => {
    const w = props.watch;
    if (w === undefined) return undefined;
    if (props.socket !== "live") {
      return "The live connection dropped. This page catches up by itself when it is back.";
    }
    if (w.type === "watching" || w.type === "ledger") return "";
    if (w.type === "unavailable") {
      return "The server has lost touch with its node. This page catches up by itself when it is back.";
    }
    if (w.reason === "no_index") return undefined; // The page already says the node has no index.
    // This visitor opened addresses faster than the server starts following them (docs/WS.md).
    if (w.reason === "follow_rate") {
      return "Too many addresses were opened at once to follow this one too, so the page does not update by itself. Reload it in a moment to follow it.";
    }
    return w.reason === "too_large"
      ? "This address has too much history for the node to watch, so the page does not update by itself. Reload it to see new transactions."
      : "The node is watching as many addresses as it can, so the page does not update by itself. Reload it to see new transactions.";
  };
  return (
    <Show when={why() !== undefined}>
      <p class={["address-live", { "address-live--on": why() === "" }]}>
        <svg class="address-live__icon" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="4" />
        </svg>
        <span class="address-live__label">{why() === "" ? "Live" : "Not live"}</span>
        <Show when={why()}>
          <span class="address-live__detail">{why()}</span>
        </Show>
      </p>
    </Show>
  );
}

function Malformed(props: { network: Network }) {
  return (
    <Notice title="This is not a valid address" tone="caution">
      Check it for a missing or mistyped character. {NETWORK_NAMES[props.network]} addresses start
      with {PREFIXES[props.network]}.
    </Notice>
  );
}

/** An address of another network's form: name its network, and link there when it is served. */
function WrongNetwork(props: { found: Recognised; network: Network }) {
  const [config] = createRequest(() => true, fetchConfig);
  const theirs = () => props.found.networks.filter((n) => n !== props.network);
  const served = () => theirs().filter((n) => config()?.networks.includes(n));
  const names = (list: readonly Network[]) => {
    const all = list.map((n) => NETWORK_NAMES[n]);
    return all.length > 1 ? `${all.slice(0, -1).join(", ")} or ${all.at(-1)}` : (all[0] ?? "");
  };
  return (
    <Notice title={`This is a ${names(theirs())} address`} tone="caution">
      <p>Addresses belong to one network, and this page shows {NETWORK_NAMES[props.network]}.</p>
      <Show
        when={served().length > 0}
        fallback={
          <Show when={config.state === "ready"}>
            <p>This server does not serve {names(theirs())}.</p>
          </Show>
        }
      >
        <ul class="address-elsewhere">
          <For each={served()}>
            {(n) => (
              <li>
                <a href={onNetwork(n, paths.address(props.found.address))}>
                  Open it on {NETWORK_NAMES[n]}
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Notice>
  );
}
