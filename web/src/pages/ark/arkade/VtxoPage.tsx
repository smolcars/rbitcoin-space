// An Arkade VTXO (docs/DESIGN.md "Arkade VTXO"): its status as the Arkade server reports it, its
// amount and expiry, the batch tree with this VTXO's way out lit, and the transactions that way
// takes, each with where our own node has it. Nothing here checks the server's claims.
import { useParams } from "@solidjs/router";
import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { Amount, Sats } from "../../../components/Amount";
import { CopyButton } from "../../../components/CopyButton";
import { type Column, DataTable } from "../../../components/DataTable";
import { Hash } from "../../../components/Hash";
import { Link } from "../../../components/Link";
import { SectionHeader } from "../../../components/SectionHeader";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { TimeUtc } from "../../../components/Time";
import { ApiError, createRequest, fetchApp, isNotFound } from "../../../lib/api";
import { loadConfig } from "../../../lib/config";
import { blocksTopic } from "../../../lib/blocks-topic";
import { useNow } from "../../../lib/clock";
import { formatUtc, groupDigits, hashGroups } from "../../../lib/format";
import { useTopic } from "../../../lib/live";
import { isNetwork, type Network, paths } from "../../../lib/network";
import { useNetwork, usePageTitle } from "../../../lib/page";
import { BadgeView, onChainNow, StateView } from "./parts";
import { Tree } from "./Tree";
import {
  type Badge,
  badges,
  describeCounts,
  exitCounts,
  exiting,
  exitSteps,
  lifeShare,
  NEAR_SECS,
  type Outpoint,
  parseOutpoint,
  readAnswer,
  rough,
  type Step,
  timeLeft,
  type VtxoAnswer,
} from "./vtxo";
import "./VtxoPage.css";

/** How often an open page asks again while in view, besides each new block. */
export const POLL_MS = 30_000;
/** The server's word for a network without Arkade, as `errorMessage` writes it. */
const OFF = "Arkade is not available here.";

export default function VtxoPage() {
  const params = useParams<{ outpoint: string }>();
  const network = useNetwork();
  // A string, so a route that renders again with the same address keeps the page as it is.
  const key = createMemo(() => {
    const o = parseOutpoint(params.outpoint ?? "");
    return o ? `${network()} ${o.txid} ${o.vout}` : undefined;
  });
  usePageTitle(() => "Arkade VTXO");
  // Asked only where the network has Arkade; elsewhere the page says so without a request.
  const [config] = createRequest(() => true, loadConfig);
  const here = () => config()?.ark[network()]?.includes("arkade") === true;
  return (
    <div class="wrap arkade-page">
      <Link class="arkade-page__back tap" href={paths.ark()}>
        ← Another VTXO
      </Link>
      <Show
        when={key()}
        keyed
        fallback={
          <>
            <Title />
            <Empty title="Not a VTXO">An Arkade VTXO is named txid:vout.</Empty>
          </>
        }
      >
        {(k) => {
          const [n, txid, vout] = k.split(" ");
          const outpoint = { txid: txid ?? "", vout: Number(vout) };
          return (
            <Switch>
              <Match when={config.loading}>
                <Title />
                <OutpointLine outpoint={outpoint} />
                <Loading label="Asking Arkade" />
              </Match>
              <Match when={!here()}>
                <Title />
                <Empty title="Arkade is not available on this network" />
              </Match>
              <Match when={true}>
                <Lookup network={isNetwork(n) ? n : "mainnet"} outpoint={outpoint} />
              </Match>
            </Switch>
          );
        }}
      </Show>
    </div>
  );
}

function Title(props: { badges?: Badge[] }) {
  return (
    <div class="arkade-head__row">
      <h1>VTXO</h1>
      <span class="arkade-impl">Arkade</span>
      <For each={props.badges ?? []}>{(b) => <BadgeView badge={b} />}</For>
    </div>
  );
}

const unreadable = () => new ApiError(200, "Arkade sent a reply that could not be read.");

function Lookup(props: { network: Network; outpoint: Outpoint }) {
  const [answer, { refetch }] = createRequest(
    () => props.outpoint,
    async (o, signal) => {
      const v = await fetchApp<unknown>(props.network, `/ark/arkade/vtxo/${o.txid}/${o.vout}`, {
        signal,
      });
      const a = readAnswer(v);
      if (!a) throw unreadable();
      return a;
    },
  );
  // A new block can put a transaction of the exit on chain: ask again then, and now and then.
  let first = true;
  useTopic(blocksTopic, {
    message: (m) => {
      if (first) {
        first = false;
        return;
      }
      if ((m.type === "block" || m.type === "reorg") && !answer.loading) refetch();
    },
    resync: () => refetch(),
  });
  onSettled(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !answer.loading) refetch();
    }, POLL_MS);
    return () => clearInterval(timer);
  });
  const off = () =>
    answer.error instanceof ApiError && isNotFound(answer.error) && answer.error.message === OFF;
  // The answer is read from the request itself, not through a Match's accessor: the body's table
  // reads it while the Switch is still choosing, which Solid treats as a stale read.
  return (
    <Switch>
      <Match when={answer.latest !== undefined}>
        <Body answer={() => answer.latest} />
      </Match>
      <Match when={answer.state === "errored" && off()}>
        <Title />
        <Empty title="Arkade is not available on this network" />
      </Match>
      <Match when={answer.state === "errored" && isNotFound(answer.error)}>
        <Title />
        <OutpointLine outpoint={props.outpoint} />
        <Empty title="Arkade knows no such VTXO" />
      </Match>
      <Match when={answer.state === "errored"}>
        <Title />
        <OutpointLine outpoint={props.outpoint} />
        <ErrorState
          title="Arkade is not answering"
          error={answer.error}
          message="Try again in a moment."
          retry={refetch}
        />
      </Match>
      <Match when={true}>
        <Title />
        <OutpointLine outpoint={props.outpoint} />
        <Loading label="Asking Arkade" />
      </Match>
    </Switch>
  );
}

/** The outpoint in groups of eight, `:vout` on the last, with copy. */
function OutpointLine(props: { outpoint: Outpoint }) {
  const groups = () => hashGroups(props.outpoint.txid);
  const value = () => `${props.outpoint.txid}:${props.outpoint.vout}`;
  return (
    <span class="hash hash--full arkade-outpoint">
      <span class="hash__text">
        <For each={groups()}>
          {(g, i) => (
            <span class="hash__group">
              {g}
              {i() === groups().length - 1 ? `:${props.outpoint.vout}` : ""}
            </span>
          )}
        </For>
      </span>
      <CopyButton value={value()} label="Copy the outpoint" />
    </span>
  );
}

function Body(props: { answer: () => VtxoAnswer | undefined }) {
  const a = (): VtxoAnswer => props.answer() ?? EMPTY;
  const now = useNow();
  const steps = () => exitSteps(a());
  const counts = () => exitCounts(steps());
  const [selected, setSelected] = createSignal<string | undefined>(undefined);
  return (
    <>
      <header class="arkade-head">
        <Title badges={badges(a(), steps(), now())} />
        <OutpointLine outpoint={{ txid: a().vtxo.txid, vout: a().vtxo.vout }} />
      </header>

      <div class="panel arkade-figures">
        <div class="arkade-fig">
          <span class="arkade-fig__label">Amount</span>
          <span class="arkade-fig__value">
            <Amount sats={a().vtxo.amount} />
          </span>
          <span class="arkade-fig__sub">
            <Sats sats={a().vtxo.amount} />
          </span>
        </div>
        <Expiry answer={a()} now={now()} />
        <div class="arkade-fig">
          <span class="arkade-fig__label">Exit</span>
          <Show
            when={exiting(a(), steps())}
            fallback={
              <>
                <span class="arkade-fig__value">
                  <span class="num">{groupDigits(counts().total)}</span>{" "}
                  <span class="unit">{counts().total === 1 ? "transaction" : "transactions"}</span>
                </span>
                <span class="arkade-fig__sub">{describeCounts(counts())}</span>
              </>
            }
          >
            <span class="arkade-fig__value">
              <span class="num">
                {counts().confirmed} / {counts().total}
              </span>{" "}
              <span class="unit">confirmed</span>
            </span>
            <span class="arkade-fig__sub">
              <Show when={counts().mempool > 0}>{counts().mempool} in mempool</Show>
            </span>
          </Show>
        </div>
      </div>

      <Tree answer={a()} steps={steps()} now={now()} selected={selected()} onSelect={setSelected} />

      <details class="panel arkade-details">
        <summary class="arkade-details__summary">
          <h2>Details</h2>
        </summary>
        <dl class="arkade-facts">
          <div>
            <dt>Signer</dt>
            <dd>
              <Hash value={a().server.signer_pubkey} copyLabel="Copy the signer's key" />
            </dd>
          </div>
          <div>
            <dt>Script</dt>
            <dd>
              <Hash value={a().vtxo.script} copyLabel="Copy the script" />
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <TimeUtc time={a().vtxo.created_at} />
            </dd>
          </div>
          <div>
            <dt>Settled</dt>
            <dd>{a().vtxo.preconfirmed ? "No" : "Yes"}</dd>
          </div>
          <div>
            <dt>{a().batches.length + a().batches_omitted === 1 ? "Commitment" : "Commitments"}</dt>
            <dd class="arkade-facts__list">
              <For each={commitments(a())}>
                {(txid) => <Hash value={txid} href={paths.tx(txid)} copyLabel="Copy the txid" />}
              </For>
            </dd>
          </div>
          <div>
            <dt>Wait after exit</dt>
            <dd>{rough(a().server.exit_delay_secs)}</dd>
          </div>
        </dl>
      </details>

      <section class="arkade-txs">
        <SectionHeader title="Transactions">
          <span class="muted">
            {a().chain_complete ? "" : "first "}
            {groupDigits(steps().length)} in broadcast order
          </span>
        </SectionHeader>
        <DataTable
          caption="The exit's transactions, in broadcast order"
          columns={columns(a())}
          rows={steps()}
          rowClass={(s) =>
            [s.mine ? "arkade-row--mine" : "", s.txid === selected() ? "arkade-row--selected" : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
          rowHref={(s) => (onChainNow(s.onchain) ? paths.tx(s.txid) : undefined)}
        />
      </section>
    </>
  );
}

/** Never shown: the body is mounted only once there is an answer. */
const EMPTY: VtxoAnswer = {
  vtxo: {
    txid: "",
    vout: 0,
    amount: 0,
    script: "",
    created_at: 0,
    expires_at: 0,
    preconfirmed: false,
    swept: false,
    unrolled: false,
    spent: false,
    spent_by: null,
    settled_by: null,
    ark_txid: null,
    commitment_txids: [],
    depth: 0,
  },
  server: { signer_pubkey: "", exit_delay_secs: 0 },
  chain: [],
  chain_complete: true,
  batches: [],
  batches_omitted: 0,
  onchain: [],
};

/** Commitment transactions: those in the chain, then the VTXO's own list. */
function commitments(a: VtxoAnswer): string[] {
  const out = a.chain.filter((t) => t.kind === "commitment").map((t) => t.txid);
  for (const t of a.vtxo.commitment_txids) if (!out.includes(t)) out.push(t);
  return out;
}

function Expiry(props: { answer: VtxoAnswer; now: number }) {
  const v = () => props.answer.vtxo;
  const left = () => v().expires_at - props.now;
  const over = () => v().swept || left() <= 0;
  const near = () => !over() && left() < NEAR_SECS;
  return (
    <div class="arkade-fig">
      <span class="arkade-fig__label">Expires</span>
      <Show
        when={!over()}
        fallback={<span class="arkade-fig__value arkade-fig__value--negative">Expired</span>}
      >
        <span class="arkade-fig__value">
          <span class="num">{timeLeft(left())[0]}</span> <span>{timeLeft(left())[1]}</span>{" "}
          <span class="unit">left</span>
        </span>
      </Show>
      <span class="arkade-fig__sub">
        <time class="num" title={formatUtc(v().expires_at)}>
          {formatUtc(v().expires_at, false)}
        </time>
      </span>
      <span
        class={["arkade-life", { "arkade-life--over": over(), "arkade-life--near": near() }]}
        aria-hidden="true"
      >
        <span
          class="arkade-life__used"
          style={{ "--share": String(over() ? 1 : lifeShare(props.answer, props.now)) }}
        />
      </span>
    </div>
  );
}

function columns(a: VtxoAnswer): Column<Step>[] {
  return [
    {
      header: "#",
      numeric: true,
      cell: (s) => (s.n === 0 ? "–" : <span class="num">{s.n}</span>),
    },
    {
      header: "Kind",
      cell: (s) => (
        <span class="arkade-kind">
          {s.name}
          <Show when={s.term}>{(t) => <span class="muted"> {t()}</span>}</Show>
        </span>
      ),
    },
    { header: "State", cell: (s) => <StateView state={s.onchain} swept={a.vtxo.swept} /> },
    {
      header: "Spends",
      numeric: true,
      optional: true,
      cell: (s) => (s.kind === "commitment" ? "" : <span class="num">{s.spends.length}</span>),
    },
    {
      header: "Txid",
      drop: 1,
      cell: (s) => (
        <Hash
          value={s.txid}
          copyLabel="Copy the txid"
          {...(onChainNow(s.onchain) ? { href: paths.tx(s.txid) } : {})}
        />
      ),
    },
  ];
}
