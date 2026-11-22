// A Bark VTXO (docs/DESIGN.md "Ark"): its amount, expiry and exit, the exit path as a picture,
// and the exit transactions, each with where it is on chain, kept current.
import { useParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Amount, Sats } from "../../../components/Amount";
import { type Column, DataTable } from "../../../components/DataTable";
import { CopyButton } from "../../../components/CopyButton";
import { Hash } from "../../../components/Hash";
import { Link } from "../../../components/Link";
import { SectionHeader } from "../../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../../components/States";
import {
  ApiError,
  createApi,
  createRequest,
  fetchApi,
  fetchApp,
  isNotFound,
} from "../../../lib/api";
import { blocksTopic } from "../../../lib/blocks-topic";
import { loadConfig } from "../../../lib/config";
import type { TxStatus } from "../../../lib/esplora";
import { groupDigits, hashGroups } from "../../../lib/format";
import { useTopic } from "../../../lib/live";
import { paths } from "../../../lib/network";
import { useNetwork, usePageTitle } from "../../../lib/page";
import { ExitPath } from "./ExitPath";
import {
  type Badge,
  type BarkVtxo,
  badges,
  counts,
  type ExitTx,
  lifeElapsed,
  type OnChain,
  parseVtxo,
  readVtxoId,
  roughTime,
} from "./vtxo";
import "./Bark.css";

/** How often the transactions' places on chain are asked again between blocks. */
const POLL_MS = 30_000;

const KIND: Record<ExitTx["kind"], string> = {
  branch: "Branch",
  leaf: "Leaf",
  transfer: "Transfer",
};

const BADGE: Record<Badge, [string, "positive" | "caution" | "negative" | "plain"]> = {
  signed: ["Signatures OK", "positive"],
  unsigned: ["Not all signed", "caution"],
  unverified: ["Not verified", "caution"],
  unsettled: ["Not settled yet", "caution"],
  exiting: ["Exiting", "plain"],
  expiring: ["Expires soon", "caution"],
  expired: ["Expired", "negative"],
};

function Icon(props: { tone: "positive" | "caution" | "negative" | "plain" }) {
  return (
    <svg class="bark-icon" viewBox="0 0 16 16" aria-hidden="true">
      {props.tone === "positive" ? (
        <path d="M4.5 8.5l2.4 2.4L11.8 5.6" />
      ) : props.tone === "caution" ? (
        <circle cx="8" cy="8" r="5.5" stroke-dasharray="2.6 2" />
      ) : props.tone === "negative" ? (
        <path d="M5 5l6 6M11 5l-6 6" />
      ) : (
        <path d="M8 12.5V3.5M4.5 7L8 3.5 11.5 7" />
      )}
    </svg>
  );
}

/** The id as a page subject: the txid in groups of eight, the vout kept on the last. */
function IdFull(props: { id: string }) {
  const groups = () => {
    const [txid = "", vout = ""] = props.id.split(":");
    const g = hashGroups(txid);
    const last = g.pop() ?? "";
    return [...g, `${last}:${vout}`];
  };
  return (
    <span class="hash hash--full">
      <span class="hash__text">
        <For each={groups()}>{(g) => <span class="hash__group">{g}</span>}</For>
      </span>
      <CopyButton value={props.id} label="Copy the VTXO ID" />
    </span>
  );
}

/** A network without a Bark server. */
function Off(props: { id: string }) {
  return (
    <>
      <h1>VTXO</h1>
      <IdFull id={props.id} />
      <Empty title="No Bark server is set up on this network" />
    </>
  );
}

function durationMs(name: string): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

/** What the server's refusal means to a reader. */
function failure(e: unknown): { title: string; empty: boolean } {
  if (e instanceof ApiError && e.status === 404) {
    return e.message.startsWith("bark is not")
      ? { title: "No Bark server is set up on this network", empty: true }
      : { title: "Bark does not know this VTXO", empty: true };
  }
  if (e instanceof ApiError && e.message.includes("did not verify")) {
    return { title: "The Bark server's answer did not check out", empty: false };
  }
  if (e instanceof ApiError && e.status === 502) {
    return { title: "The Bark server did not answer", empty: false };
  }
  return { title: "Could not load this VTXO", empty: false };
}

export default function VtxoPage() {
  const params = useParams<{ id: string }>();
  const network = useNetwork();
  const id = () => readVtxoId(params.id ?? "");
  usePageTitle(() => "Bark VTXO");

  // Asked only where the network has Bark; elsewhere the page says so without a request.
  const [config] = createRequest(() => true, loadConfig);
  const barkHere = () => config()?.ark[network()]?.includes("bark") === true;
  const [answer, { refetch }] = createRequest(
    () => {
      const v = id();
      return v === null || !barkHere() ? false : ([network(), v] as const);
    },
    async ([n, v], signal) => {
      const body = await fetchApp<unknown>(n, `/ark/bark/vtxo/${v}`, { signal, cached: true });
      const parsed = parseVtxo(body);
      if (parsed === null || parsed.id !== v)
        throw new ApiError(0, "The answer could not be read.");
      return parsed;
    },
  );

  return (
    <div class="wrap bark-page">
      <Link class="bark-page__back tap" href={paths.ark()}>
        ← Another VTXO
      </Link>
      <Show when={id()} fallback={<Empty title="Not a VTXO ID" />}>
        {(vid) => (
          <Show when={config.loading || barkHere()} fallback={<Off id={vid()} />}>
            <Show
              when={answer.state !== "errored"}
              fallback={
                <Show
                  when={!failure(answer.error).empty}
                  fallback={
                    <>
                      <h1>VTXO</h1>
                      <IdFull id={vid()} />
                      <Empty title={failure(answer.error).title} />
                    </>
                  }
                >
                  <h1>VTXO</h1>
                  <ErrorState
                    title={failure(answer.error).title}
                    error={answer.error}
                    retry={refetch}
                  />
                </Show>
              }
            >
              <Show when={answer.latest} fallback={<Loading label="Asking the Bark server" />}>
                {(v) => <Body vtxo={v()} />}
              </Show>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}

export function Body(props: { vtxo: BarkVtxo }) {
  const network = useNetwork();
  const [tipText, { refetch: refetchTip }] = createApi<string>(() => "/blocks/tip/height", {
    as: "text",
    cached: true,
  });
  const tip = () => {
    const t = Number(tipText.latest);
    return Number.isSafeInteger(t) && t >= 0 ? t : undefined;
  };

  // Where the anchor and each exit transaction are on chain. Asked in order, stopping at the
  // first the node does not know: a later one spends it, so it cannot be out either.
  const [places, setPlaces] = createSignal<Record<string, OnChain>>({});
  let asking: AbortController | undefined;
  const refreshPlaces = async () => {
    asking?.abort();
    const controller = new AbortController();
    asking = controller;
    const next: Record<string, OnChain> = {};
    let out = true;
    for (const txid of [props.vtxo.anchor.txid, ...props.vtxo.txs.map((t) => t.txid)]) {
      if (txid === null) break;
      if (!out) {
        next[txid] = { state: "none" };
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- each answer decides whether to ask for the next
        const s = await fetchApi<TxStatus>(network(), `/tx/${txid}/status`, {
          signal: controller.signal,
        });
        next[txid] =
          s.confirmed && typeof s.block_height === "number"
            ? { state: "confirmed", height: s.block_height }
            : { state: "mempool" };
      } catch (e) {
        if (controller.signal.aborted) return;
        if (!isNotFound(e)) return;
        next[txid] = { state: "none" };
        out = false;
      }
    }
    if (!controller.signal.aborted) setPlaces(next);
  };
  const refresh = () => {
    refetchTip();
    void refreshPlaces();
  };
  useTopic(blocksTopic, {
    message: (m) => {
      if (m.type === "block" || m.type === "reorg") refresh();
    },
    resync: refresh,
  });
  createEffect(
    () => props.vtxo,
    () => {
      void refreshPlaces();
      const timer = setInterval(() => {
        if (!document.hidden) void refreshPlaces();
      }, POLL_MS);
      return () => {
        clearInterval(timer);
        asking?.abort();
      };
    },
  );

  const place = (txid: string | null): OnChain | undefined =>
    txid === null ? undefined : places()[txid];
  const anchorHeight = () => {
    const p = place(props.vtxo.anchor.txid);
    return p?.state === "confirmed" ? p.height : undefined;
  };
  const exitPlaces = () => props.vtxo.txs.map((t) => place(t.txid) ?? ({ state: "none" } as const));
  const shownBadges = () => badges(props.vtxo, tip(), exitPlaces());
  const c = () => counts(props.vtxo);
  const left = () => {
    const t = tip();
    return t === undefined ? undefined : props.vtxo.expiryHeight - t;
  };

  // Play exit: lights the transactions one by one, in broadcast order, then shows the wait.
  const [lit, setLit] = createSignal<number | undefined>(undefined);
  const [done, setDone] = createSignal(false);
  const [selected, setSelected] = createSignal<number | undefined>(undefined);
  let timers: ReturnType<typeof setTimeout>[] = [];
  const stop = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
  onCleanup(stop);
  const play = () => {
    stop();
    const n = props.vtxo.txs.length;
    // From the tokens, so reduced motion (every duration 0) gives the end at once.
    const step = durationMs("--dur-slow");
    setDone(false);
    if (step <= 0) {
      setLit(n);
      setDone(true);
      return;
    }
    setLit(0);
    for (let k = 1; k <= n; k++) timers.push(setTimeout(() => setLit(k), k * step));
    timers.push(setTimeout(() => setDone(true), (n + 1) * step));
  };

  const pick = () => {
    const i = selected();
    return i === undefined ? undefined : props.vtxo.txs[i];
  };

  return (
    <>
      <header class="bark-head">
        <h1 class="bark-head__title">
          VTXO <span class="bark-head__impl">Bark</span>
        </h1>
        <ul class="bark-head__badges" aria-label="State">
          <For each={shownBadges()}>
            {(b) => (
              <li class={`bark-badge bark-badge--${BADGE[b][1]}`}>
                <Icon tone={BADGE[b][1]} />
                {BADGE[b][0]}
              </li>
            )}
          </For>
        </ul>
      </header>
      <IdFull id={props.vtxo.id} />

      <div class="bark-figures panel">
        <div class="bark-figure">
          <span class="bark-figure__label">Amount</span>
          <span class="bark-figure__value">
            <Amount sats={props.vtxo.amount} />
          </span>
          <span class="bark-figure__sub">
            <Sats sats={props.vtxo.amount} />
          </span>
        </div>
        <div class="bark-figure">
          <span class="bark-figure__label">Expires</span>
          <span class="bark-figure__value num">
            <Show when={left() !== undefined} fallback="–">
              <Show when={(left() ?? 0) > 0} fallback="Expired">
                {groupDigits(left() ?? 0)} <span class="unit">blocks left</span>
              </Show>
            </Show>
          </span>
          <span class="bark-figure__sub num">Block {groupDigits(props.vtxo.expiryHeight)}</span>
          <Show when={tip()}>
            {(t) => (
              <span class="bark-life" aria-hidden="true">
                <span
                  class="bark-life__used"
                  style={{
                    "--used": String(lifeElapsed(anchorHeight(), t(), props.vtxo.expiryHeight)),
                  }}
                />
              </span>
            )}
          </Show>
        </div>
        <div class="bark-figure">
          <span class="bark-figure__label">Exit</span>
          <span class="bark-figure__value num">
            {groupDigits(props.vtxo.txs.length)}{" "}
            <span class="unit">{props.vtxo.txs.length === 1 ? "transaction" : "transactions"}</span>
          </span>
          <span class="bark-figure__sub num">
            {c().tree} tree, {c().transfers} {c().transfers === 1 ? "transfer" : "transfers"}
          </span>
        </div>
      </div>

      <section class="bark-exit" aria-labelledby="exit-path">
        <SectionHeader title="Exit path" id="exit-path">
          <Show when={props.vtxo.txs.length > 0}>
            <button class="btn" type="button" onClick={play}>
              Play exit
            </button>
          </Show>
        </SectionHeader>
        <div class="bark-exit__well">
          <ExitPath
            vtxo={props.vtxo}
            tip={tip()}
            anchorHeight={anchorHeight()}
            lit={lit()}
            done={done()}
            selected={selected()}
            onSelect={(i) => setSelected((s) => (s === i ? undefined : i))}
          />
        </div>
        <ul class="bark-key" aria-label="Key">
          <li>
            <svg viewBox="0 0 28 10" aria-hidden="true">
              <path class="bark-key__edge" d="M1 5h20" />
              <circle class="bark-key__dot" cx="22" cy="5" r="3" />
            </svg>
            Exit transaction
          </li>
          <li>
            <svg viewBox="0 0 28 10" aria-hidden="true">
              <path class="bark-key__sibling" d="M1 5h20" />
              <circle class="bark-key__open" cx="23" cy="5" r="2.5" />
            </svg>
            Other output
          </li>
          <li>
            <svg viewBox="0 0 28 10" aria-hidden="true">
              <path class="bark-key__edge" d="M2 9Q14 -3 26 9" />
            </svg>
            Transfer
          </li>
        </ul>
        <Show when={pick()}>
          {(t) => (
            <dl class="bark-pick" aria-live="polite">
              <div>
                <dt>Transaction {(selected() ?? 0) + 1}</dt>
                <dd>
                  {KIND[t().kind]} <span class="muted">{t().bark}</span>
                </dd>
              </div>
              <div>
                <dt>Holds</dt>
                <dd>
                  <Sats sats={t().value} />
                </dd>
              </div>
              <div>
                <dt>Other outputs</dt>
                <dd class="num">
                  {t().siblings.length === 0
                    ? "None"
                    : t()
                        .siblings.map((s) => `${groupDigits(s)} sats`)
                        .join(", ")}
                </dd>
              </div>
              <div>
                <dt>On chain</dt>
                <dd>{placeWord(place(t().txid))}</dd>
              </div>
              <div class="bark-pick__wide">
                <dt>Txid</dt>
                <dd>
                  <Show when={t().txid} fallback="Not rebuilt">
                    {(txid) => <Hash value={txid()} href={paths.tx(txid())} fit />}
                  </Show>
                </dd>
              </div>
            </dl>
          )}
        </Show>
      </section>

      <details class="bark-details panel">
        <summary>Details</summary>
        <dl class="bark-facts">
          <div>
            <dt>Server key</dt>
            <dd>
              <Hash value={props.vtxo.serverPubkey} whole copyLabel="Copy the server's key" />
            </dd>
          </div>
          <Show when={props.vtxo.policy.userPubkey}>
            {(k) => (
              <div>
                <dt>User key</dt>
                <dd>
                  <Hash value={k()} whole copyLabel="Copy the user's key" />
                </dd>
              </div>
            )}
          </Show>
          <div>
            <dt>Policy</dt>
            <dd>{props.vtxo.policy.kind}</dd>
          </div>
          <div>
            <dt>Wait after exit</dt>
            <dd>
              <span class="num bark-figure-piece">{groupDigits(props.vtxo.exitDelta)} blocks</span>{" "}
              <span class="muted num bark-figure-piece">{roughTime(props.vtxo.exitDelta)}</span>
            </dd>
          </div>
          <div>
            <dt>Encoding</dt>
            <dd class="num">Version {props.vtxo.version}</dd>
          </div>
          <div>
            <dt>Anchor</dt>
            <dd>
              <Hash
                value={`${props.vtxo.anchor.txid}:${props.vtxo.anchor.vout}`}
                href={paths.tx(props.vtxo.anchor.txid)}
                copyLabel="Copy the anchor's outpoint"
              />{" "}
              <span class="muted num bark-figure-piece">
                {groupDigits(props.vtxo.anchor.value)} sats
              </span>
            </dd>
          </div>
        </dl>
      </details>

      <Transactions vtxo={props.vtxo} place={place} selected={selected()} />
    </>
  );
}

function placeWord(p: OnChain | undefined): string {
  if (p === undefined) return "–";
  if (p.state === "confirmed") return `Confirmed ${groupDigits(p.height)}`;
  return p.state === "mempool" ? "In mempool" : "Not broadcast";
}

interface Row {
  n: number | undefined;
  kind: string;
  bark: string;
  txid: string | null;
  signature: ExitTx["signature"] | undefined;
  siblings: number | undefined;
  fee: number | undefined;
}

function Transactions(props: {
  vtxo: BarkVtxo;
  place: (txid: string | null) => OnChain | undefined;
  selected: number | undefined;
}) {
  const rows = createMemo((): Row[] => [
    {
      n: undefined,
      kind: "Anchor",
      bark: "",
      txid: props.vtxo.anchor.txid,
      signature: undefined,
      siblings: undefined,
      fee: undefined,
    },
    ...props.vtxo.txs.map((t, i) => ({
      n: i + 1,
      kind: KIND[t.kind],
      bark: t.bark,
      txid: t.txid,
      signature: t.signature,
      siblings: t.siblings.length,
      fee: t.fee,
    })),
  ]);
  const columns: Column<Row>[] = [
    { header: "#", cell: (r) => (r.n === undefined ? "–" : String(r.n)), numeric: true },
    {
      header: "Kind",
      cell: (r) => (
        <>
          {r.kind} <span class="muted bark-table__bark">{r.bark}</span>
        </>
      ),
    },
    {
      header: "On chain",
      cell: (r) => {
        const p = props.place(r.txid);
        return (
          <span class={["bark-place", { "bark-place--confirmed": p?.state === "confirmed" }]}>
            {placeWord(p)}
          </span>
        );
      },
    },
    {
      header: "Signature",
      cell: (r) =>
        r.signature === undefined
          ? ""
          : r.signature === "valid"
            ? "Valid"
            : r.signature === "missing"
              ? "Missing"
              : "Unchecked",
      optional: true,
    },
    {
      header: "Other outputs",
      short: "Others",
      cell: (r) => (r.siblings === undefined ? "" : String(r.siblings)),
      numeric: true,
      optional: true,
    },
    {
      header: "Fee, sats",
      cell: (r) => (r.fee === undefined ? "" : groupDigits(r.fee)),
      numeric: true,
      optional: true,
    },
    {
      header: "Txid",
      cell: (r) =>
        r.txid === null ? "Not rebuilt" : <Hash value={r.txid} href={paths.tx(r.txid)} fit />,
      drop: 1,
    },
  ];
  return (
    <section class="bark-txs" aria-labelledby="exit-txs">
      <SectionHeader title="Transactions" id="exit-txs">
        <span class="muted">In broadcast order</span>
      </SectionHeader>
      <DataTable
        caption="The anchor and the exit transactions, in broadcast order"
        columns={columns}
        rows={rows()}
        rowClass={(r) =>
          r.n !== undefined && r.n - 1 === props.selected ? "bark-table__row--picked" : undefined
        }
        rowHref={(r) => (r.txid === null ? undefined : paths.tx(r.txid))}
      />
    </section>
  );
}
