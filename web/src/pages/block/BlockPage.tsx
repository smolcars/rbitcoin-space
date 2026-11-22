import { useParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  Loading,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount, Sats } from "../../components/Amount";
import { AuditSection } from "../../components/audit/Audit";
import { readAudit } from "../../components/audit/model";
import { DataTable } from "../../components/DataTable";
import { FeeKey, FeeRate } from "../../components/FeeRate";
import { Goggles } from "../../components/Goggles";
import { Hash, HashFull } from "../../components/Hash";
import { Link } from "../../components/Link";
import { Note } from "../../components/Note";
import { SectionHeader } from "../../components/SectionHeader";
import { describeBands, Strata, strataLayers, strataTop } from "../../components/Strata";
import { ErrorState } from "../../components/States";
import { TimeAgo, TimeUtc } from "../../components/Time";
import type { GridState } from "../../components/txgrid/TxGrid";
import { decodeTxs, TxsFormatError, TXS_VERSION } from "../../components/txgrid/decode";
import type { GridTx } from "../../components/txgrid/layout";
import {
  createApi,
  createRequest,
  fetchApi,
  fetchApp,
  fetchStamped,
  isNotFound,
  type Stamped,
} from "../../lib/api";
import { blocksTopic } from "../../lib/blocks-topic";
import { litLabel, litOf, pick } from "../../lib/goggles";
import type { Block, BlockStatus, Transaction } from "../../lib/esplora";
import {
  feeRate,
  formatFeeRate,
  formatSize,
  groupDigits,
  MISSING,
  truncateMiddle,
  vsizeFromWeight,
} from "../../lib/format";
import { useTopic } from "../../lib/live";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import {
  type BlockSummary,
  fetchSummaries,
  knownSummary,
  rememberSummary,
} from "../../lib/summary";
import {
  blockReward,
  coinbaseTag,
  formatDifficulty,
  fullness,
  HALVING_INTERVAL,
  hex32,
  MAX_BLOCK_WEIGHT,
  parseBlockId,
  shownParam,
} from "./chain";
import "./BlockPage.css";
import { failed, ready, Skel } from "./parts";
import { BlockLightning } from "../lightning/BlockLightning";

// WebGL and its layout load only when a block page draws them.
const TxGrid = lazy(() => import("../../components/txgrid/TxGrid"));

/** The API serves a block's transactions 25 at a time. */
const PAGE = 25;

const percent = (share: number) => {
  const p = share * 100;
  return `${p >= 99.995 ? "100" : p.toFixed(p < 1 ? 2 : 1)}%`;
};

/** `/block/:id`, where `id` is a block hash or a height. */
export default function BlockPage() {
  const params = useParams<{ id: string }>();
  const id = createMemo(() => parseBlockId(params.id));
  const [byHeight, byHeightCtl] = createApi<string>(
    () => {
      const i = id();
      return i?.kind === "height" && `/block-height/${i.height}`;
    },
    { as: "text", cached: true },
  );
  const hash = () => {
    const i = id();
    if (i?.kind === "hash") return i.hash;
    const h = i && ready(byHeight);
    return h && /^[0-9a-f]{64}$/.test(h) ? h : undefined;
  };
  const height = () => {
    const i = id();
    return i?.kind === "height" ? i.height : undefined;
  };
  const heightError = () => (id()?.kind === "height" ? failed(byHeight) : undefined);

  return (
    <Switch fallback={<BlockView hash={hash()} height={height()} />}>
      <Match when={!id()}>
        <BadId value={params.id} />
      </Match>
      <Match when={heightError()}>
        {(e) => (
          <Show
            when={isNotFound(e())}
            fallback={<PageError error={e()} retry={() => byHeightCtl.refetch()} />}
          >
            <NoBlockAtHeight height={height() ?? 0} />
          </Show>
        )}
      </Match>
    </Switch>
  );
}

function Message(props: { title: string; children: JSX.Element }) {
  usePageTitle(() => props.title);
  return (
    <div class="wrap block-page block-message">
      <h1>{props.title}</h1>
      {props.children}
    </div>
  );
}

function BadId(props: { value: string }) {
  return (
    <Message title="Not a block">
      <p class="block-message__text">
        “{truncateMiddle(shownParam(props.value), 40, 20)}” is not a block hash or a height. A block
        hash is 64 hexadecimal characters, and a height is a whole number such as{" "}
        <Link href={paths.block(840_000)}>840{" "}000</Link>.
      </p>
    </Message>
  );
}

function NoBlockAtHeight(props: { height: number }) {
  const [tip] = createApi<string>(() => "/blocks/tip/height", { as: "text", cached: true });
  const tipHeight = () => {
    const t = Number(ready(tip));
    return Number.isSafeInteger(t) ? t : undefined;
  };
  return (
    <Message title={`No block ${groupDigits(props.height)} yet`}>
      <p class="block-message__text">
        Block {groupDigits(props.height)} has not been mined.{" "}
        <Show when={tipHeight()}>
          {(t) => (
            <>
              The newest block is <Link href={paths.block(t())}>{groupDigits(t())}</Link>.
            </>
          )}
        </Show>
      </p>
    </Message>
  );
}

function NotFound(props: { hash: string }) {
  const network = useNetwork();
  return (
    <Message title="Block not found">
      <div class="block-head__hash">
        <HashFull value={props.hash} copyLabel="Copy block hash" />
      </div>
      <p class="block-message__text">
        No block with this hash is known on {NETWORK_NAMES[network()]}. It may belong to another
        network: check the network switch above.
      </p>
    </Message>
  );
}

function PageError(props: { error: unknown; retry: () => void }) {
  usePageTitle(() => "Block");
  return (
    <div class="wrap block-page">
      <h1>Block</h1>
      <ErrorState title="Could not load this block" error={props.error} retry={props.retry} />
    </div>
  );
}

/** What the Stratum V2 mark rests on: the coinbase's layout, which its builder chose. */
const SV2_NOTE =
  "The coinbase is laid out as the Stratum V2 reference implementation writes it, " +
  "Sv2/<pool tag>/<miner tag>/. That is what the block's builder wrote, not something the chain proves.";

/** One label and value in the facts list. `sub` is a muted second line; space for it is always kept. */
function Fact(props: {
  label: string;
  value: JSX.Element | undefined;
  sub?: JSX.Element;
  /** Spans both columns, or only on phones where the value would not fit in one. */
  wide?: true | "phone";
  /** Keeps two lines for the value, which can wrap (the coinbase tag). */
  tall?: boolean;
}) {
  return (
    <div
      class={[
        "block-fact",
        {
          "block-fact--wide": props.wide === true,
          "block-fact--wide-phone": props.wide === "phone",
          "block-fact--tall": props.tall === true,
        },
      ]}
    >
      <dt>{props.label}</dt>
      <dd>
        <span class="block-fact__value">{props.value ?? <Skel />}</span>
        <span class="block-fact__sub">{props.sub}</span>
      </dd>
    </div>
  );
}

/** The thinnest layer in the core sample, as a share of its frame (about 2 px of 400). */
const CORE_LAYER_MIN = 0.005;

function BlockView(props: { hash?: string | undefined; height?: number | undefined }) {
  const network = useNetwork();
  const at = (suffix: string) => () => props.hash && `/block/${props.hash}${suffix}`;
  const [block, blockCtl] = createApi<Block>(at(""), { cached: true });
  // Stamped: confirmations and "the newest block" both come from this one reply's tip, so they can
  // never disagree the way a separate tip request could when a block lands between the two. The
  // newest block asks again when the next is found (NextListener), from the server; each reply
  // names its block, so the previous block's never stands for this one's while it loads.
  let statusOf: string | undefined;
  const [status, statusCtl] = createRequest(
    () => (props.hash ? { hash: props.hash, network: network() } : undefined),
    async ({ hash, network: n }, signal) => {
      const fresh = statusOf === hash;
      statusOf = hash;
      const reply = await fetchStamped<BlockStatus>(n, `/block/${hash}/status`, {
        signal,
        cached: !fresh,
      });
      return { hash, reply };
    },
  );
  const [first, firstCtl] = createApi<Transaction[]>(at("/txs/0"), { cached: true });
  // Retried quietly while the server is busy (503) or this client has asked for a lot (429).
  const [summary, summaryCtl] = createRequest(
    () => (props.hash ? { hash: props.hash, network: network() } : undefined),
    async ({ hash, network: n }, signal): Promise<BlockSummary | null> => {
      const found = await fetchSummaries(n, [hash], signal);
      return found.get(hash) ?? null;
    },
  );
  // Every transaction's size and fee, for the map. Retried quietly while the server is busy.
  const [gridTxs, gridTxsCtl] = createRequest(
    () => (props.hash ? { hash: props.hash, network: network() } : undefined),
    async ({ hash, network: n }, signal): Promise<GridTx[]> => {
      // The format in the URL: a cache holding another format's answer has it under another key.
      const path = `/block/${hash}/txs?v=${TXS_VERSION}`;
      return decodeTxs(await fetchApp<ArrayBuffer>(n, path, { as: "bytes", signal, cached: true }));
    },
  );
  // The renderer's code downloads while the data does.
  onSettled(() => void TxGrid.preload());
  const [highlight, setHighlight] = createSignal<number>();
  const rowAt = (e: Event) => {
    const row = e.target instanceof Element ? e.target.closest("tbody tr") : null;
    const i = row?.parentElement ? [...row.parentElement.children].indexOf(row) : -1;
    setHighlight(i >= 0 && txs()?.[i] ? i : undefined);
  };
  const txidOf = (tx: GridTx): Promise<string> => {
    const i = Number(tx.id);
    const known = txs()?.[i]?.txid;
    if (known !== undefined) return Promise.resolve(known);
    return fetchApi<string>(network(), `/block/${props.hash ?? ""}/txid/${i}`, {
      as: "text",
      cached: true,
    });
  };
  // Layers arrive with a settle unless this page already had them when the block was opened.
  const settle = createMemo(() => !props.hash || !knownSummary(network(), props.hash));

  const b = () => ready(block);
  // Kept while it is asked again for the same block, so the pager does not blink on a new block.
  const kept = createMemo((was?: { hash: string; reply: Stamped<BlockStatus> }) => {
    const now = ready(status);
    if (now?.hash === props.hash) return now;
    return was?.hash === props.hash ? was : undefined;
  });
  const s = () => kept()?.reply.value;
  // A new block's facts, and its audit, may come over the WebSocket before the request answers.
  const [pushed, setPushed] = createSignal<BlockSummary>();
  const sum = () => {
    const p = pushed();
    return ready(summary) ?? (p && p.id === props.hash ? p : undefined);
  };
  const rates = () => sum()?.fee_rate;
  const height = () => b()?.height ?? props.height;
  const stale = () => s()?.in_best_chain === false;
  usePageTitle(() => {
    const h = height();
    return h === undefined
      ? `Block ${truncateMiddle(props.hash ?? "")}`.trim()
      : `Block ${groupDigits(h)}`;
  });

  // Further pages of transactions, appended below the first.
  const [more, setMore] = createSignal<Transaction[]>([]);
  const [moreLoading, setMoreLoading] = createSignal(false);
  const [moreError, setMoreError] = createSignal<unknown>();
  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  createEffect(
    () => props.hash,
    () => {
      controller?.abort();
      setMore([]);
      setMoreLoading(false);
      setMoreError(undefined);
    },
    { defer: true },
  );
  const txs = () => {
    const f = ready(first);
    return f ? [...f, ...more()] : undefined;
  };
  const txCount = () => b()?.tx_count;
  const hasMore = () => {
    const shown = txs()?.length ?? 0;
    const total = txCount() ?? 0;
    return shown > 0 && shown < total;
  };
  const loadMore = async () => {
    const hash = props.hash;
    const shown = txs()?.length;
    if (!hash || shown === undefined || moreLoading()) return;
    const c = new AbortController();
    controller = c;
    setMoreLoading(true);
    setMoreError(undefined);
    try {
      const page = await fetchApi<Transaction[]>(network(), `/block/${hash}/txs/${shown}`, {
        signal: c.signal,
        cached: true,
      });
      if (!c.signal.aborted) setMore((m) => [...m, ...page]);
    } catch (e) {
      if (!c.signal.aborted) setMoreError(e);
    } finally {
      if (!c.signal.aborted) setMoreLoading(false);
    }
  };

  const coinbase = () => ready(first)?.[0];
  const reward = () => {
    const blk = b();
    if (!blk || ready(first) === undefined) return undefined;
    return blockReward(coinbase(), blk.height, HALVING_INTERVAL[network()]);
  };
  // A miner may claim less than the subsidy and fees allow; what it left out was never created.
  const unclaimed = () => {
    const r = reward();
    const f = sum()?.fees;
    return r && f !== undefined ? Math.max(0, r.subsidy + f - r.reward) : 0;
  };
  const summaryRetry = () => (
    <span class="block-fact__pending">
      Could not load.{" "}
      <button type="button" class="block-fact__retry" onClick={() => summaryCtl.refetch()}>
        Try again
      </button>
    </span>
  );
  const tag = () => {
    const blk = b();
    const vin = coinbase()?.vin?.[0];
    return blk && vin?.is_coinbase ? coinbaseTag(vin.scriptsig, blk.height) : undefined;
  };
  const confirmations = () => {
    const blk = b();
    const st = s();
    if (!blk || !st) return undefined;
    const t = kept()?.reply.tip?.height;
    if (!st.in_best_chain) return 0;
    return t === undefined ? null : Math.max(1, t - blk.height + 1);
  };
  const pageError = () => failed(block) ?? failed(status);
  const retry = () => {
    if (failed(block) !== undefined) blockCtl.refetch();
    if (failed(status) !== undefined) statusCtl.refetch();
    if (failed(first) !== undefined) firstCtl.refetch();
  };

  const rows = (): readonly (Transaction | null)[] => {
    const list = txs();
    if (list) return list;
    return Array.from({ length: Math.min(PAGE, txCount() ?? PAGE) }, () => null);
  };

  return (
    <Show
      when={pageError() === undefined}
      fallback={
        <Show
          when={isNotFound(pageError()) && props.hash}
          fallback={<PageError error={pageError()} retry={retry} />}
        >
          {(h) => <NotFound hash={h()} />}
        </Show>
      }
    >
      <div class="wrap block-page">
        <nav class="block-pager" aria-label="Neighbouring blocks">
          <span class="block-pager__prev">
            <Show when={b()} fallback={<Skel size="s" />}>
              {(blk) => (
                <Show
                  when={blk().previousblockhash}
                  fallback={<span class="muted">Genesis block</span>}
                >
                  {(prev) => (
                    <Link class="tap" href={paths.block(prev())} rel="prev">
                      ← Previous: <span class="num">{groupDigits(blk().height - 1)}</span>
                    </Link>
                  )}
                </Show>
              )}
            </Show>
          </span>
          <span class="block-pager__next">
            <Show when={b() && s()} fallback={<Skel size="s" />}>
              <Switch>
                <Match when={stale()}>
                  <span class="muted">Not on the best chain</span>
                </Match>
                <Match when={s()?.next_best}>
                  {(next) => (
                    <Link class="tap" href={paths.block(next())} rel="next">
                      Next: <span class="num">{groupDigits((height() ?? 0) + 1)}</span>
                      {"\u202F→"}
                    </Link>
                  )}
                </Match>
                <Match when={true}>
                  <span class="muted">The newest block</span>
                </Match>
              </Switch>
            </Show>
          </span>
        </nav>

        <header class="block-head">
          <div class="block-head__title">
            <h1>
              Block{" "}
              <Show when={height() !== undefined} fallback={<Skel size="s" />}>
                <span class="num">{groupDigits(height() ?? 0)}</span>
              </Show>
            </h1>
            <Show when={stale()}>
              <span class="block-status">
                <svg class="block-status__icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                </svg>
                Stale
              </span>
            </Show>
          </div>
          <div class="block-head__hash">
            <Show
              when={props.hash}
              fallback={
                // The same hash shape with its text hidden, so it wraps exactly as the real one will.
                <span class="block-head__ghost" aria-hidden="true">
                  <HashFull value={"0".repeat(64)} />
                </span>
              }
            >
              {(h) => <HashFull value={h()} copyLabel="Copy block hash" />}
            </Show>
          </div>
        </header>

        <Show when={stale()}>
          <p class="block-notice">
            This block is not on the best chain. Another block took its place at height{" "}
            <Link href={paths.block(height() ?? 0)}>{groupDigits(height() ?? 0)}</Link>, so the
            transactions here are confirmed only if that chain included them too.
          </p>
        </Show>

        <div class="block-layout">
          {/* The facts, and under them the block's Lightning channels where it has some. */}
          <div class="block-lead">
            <div class="block-side panel">
              <dl class="block-facts">
                <Fact
                  label="Mined"
                  wide="phone"
                  value={b() ? <TimeUtc time={b()?.timestamp ?? 0} /> : undefined}
                  sub={b() && <TimeAgo time={b()?.timestamp ?? 0} />}
                />
                <Fact
                  label="Miner"
                  value={
                    failed(summary) === undefined ? (
                      sum() === undefined ? undefined : (
                        <Show
                          when={sum()?.miner}
                          fallback={
                            sum() ? (
                              <span class="block-fact__pending">Not known on this server</span>
                            ) : (
                              MISSING
                            )
                          }
                        >
                          {(m) => (
                            <span class="block-miner">
                              <Link
                                class="block-fact__line tap-line"
                                href={paths.pool(m().slug)}
                                title={m().name}
                              >
                                {m().name}
                              </Link>
                              <Show when={sum()?.sv2 === true}>
                                <Note
                                  focusable
                                  title="Stratum V2 coinbase tag"
                                  figure={<span class="block-sv2 tap">Sv2</span>}
                                >
                                  {SV2_NOTE}
                                </Note>
                              </Show>
                            </span>
                          )}
                        </Show>
                      )
                    ) : (
                      summaryRetry()
                    )
                  }
                  sub={
                    sum()?.miner && (
                      <span class="block-fact__line">
                        {sum()?.miner?.slug === "unknown"
                          ? "No listed address or tag"
                          : "By payout address or tag"}
                      </span>
                    )
                  }
                />
                <Fact
                  label="Transactions"
                  value={
                    b() ? <span class="num">{groupDigits(b()?.tx_count ?? 0)}</span> : undefined
                  }
                />
                <Fact
                  label="Fullness"
                  value={
                    b() ? <span class="num">{percent(fullness(b()?.weight ?? 0))}</span> : undefined
                  }
                  sub={b() && `${formatSize(b()?.weight ?? 0, "WU")} of 4 MWU`}
                />
                <Fact
                  label="Median fee rate"
                  value={
                    failed(summary) === undefined ? (
                      sum() === undefined ? undefined : (
                        <Show when={rates()} fallback={sum() ? "None" : MISSING}>
                          {(r) => <FeeRate rate={r().median} />}
                        </Show>
                      )
                    ) : (
                      summaryRetry()
                    )
                  }
                  sub={sum() && !rates() ? "Only the coinbase, which pays none" : undefined}
                />
                <Fact
                  label="Fee range"
                  value={
                    failed(summary) === undefined ? (
                      sum() === undefined ? undefined : (
                        <Show when={rates()} fallback={MISSING}>
                          {(r) => (
                            <span class="num block-range">
                              {formatFeeRate(r().min)} – {formatFeeRate(r().max)}
                              <span class="unit"> sat/vB</span>
                            </span>
                          )}
                        </Show>
                      )
                    ) : (
                      MISSING
                    )
                  }
                />
                <Fact
                  label="Total fees"
                  value={
                    failed(summary) === undefined ? (
                      sum() === undefined ? undefined : (
                        <Show when={sum()} fallback={MISSING}>
                          {(f) => <Amount sats={f().fees} />}
                        </Show>
                      )
                    ) : (
                      summaryRetry()
                    )
                  }
                  sub={sum() && <Sats sats={sum()?.fees ?? 0} />}
                />
                <Fact
                  label="Reward"
                  value={
                    reward() === undefined ? undefined : reward() ? (
                      <Amount sats={reward()?.reward ?? 0} />
                    ) : (
                      MISSING
                    )
                  }
                  sub={
                    reward() &&
                    (unclaimed() > 0 ? (
                      <>
                        <Amount sats={unclaimed()} /> less than the subsidy and fees allowed
                      </>
                    ) : (
                      <>
                        <Amount sats={reward()?.subsidy ?? 0} /> subsidy
                      </>
                    ))
                  }
                />
              </dl>
            </div>
            <BlockLightning hash={props.hash} />
          </div>
          <CoreSample
            weight={b()?.weight}
            summary={sum()}
            settle={settle()}
            txs={ready(gridTxs)}
            txsError={failed(gridTxs)}
            retryTxs={() => gridTxsCtl.refetch()}
            txid={txidOf}
            highlight={highlight()}
          />
          <div class="block-more panel">
            <dl class="block-facts">
              <Fact
                label="Size"
                value={b() ? <span class="num">{formatSize(b()?.size ?? 0, "B")}</span> : undefined}
                sub={b() && `${formatSize(vsizeFromWeight(b()?.weight ?? 0))} virtual`}
              />
              <Fact
                label="Confirmations"
                value={
                  confirmations() === undefined ? undefined : confirmations() === null ? (
                    MISSING
                  ) : (
                    <span class="num">{groupDigits(confirmations() ?? 0)}</span>
                  )
                }
                sub={stale() ? "Not on the best chain" : undefined}
              />
              <Fact
                label="Coinbase tag"
                wide
                tall
                value={
                  ready(first) === undefined ? undefined : (
                    <Show when={tag()} fallback={MISSING}>
                      {(t) => (
                        <Show
                          when={t().readable}
                          fallback={
                            <Show when={t().hex} fallback="None">
                              {(hex) => <span class="block-tag block-tag--hex">{hex()}</span>}
                            </Show>
                          }
                        >
                          <span class="block-tag">
                            <For each={t().parts}>
                              {(p) =>
                                "text" in p ? (
                                  p.text
                                ) : (
                                  <span
                                    class="block-tag__hidden"
                                    title={`${p.hidden} ${p.hidden === 1 ? "character" : "characters"} that are not text`}
                                  >
                                    {"·".repeat(p.hidden)}
                                  </span>
                                )
                              }
                            </For>
                          </span>
                        </Show>
                      )}
                    </Show>
                  )
                }
                sub={
                  ready(first) !== undefined &&
                  (tag()?.readable === false
                    ? tag()?.hex
                      ? "No readable text; shown as hex"
                      : "The miner wrote nothing after the height"
                    : tag()?.parts.some((p) => "hidden" in p)
                      ? "Written by the miner. Dots stand for bytes that are not text"
                      : tag() && "Written by the miner")
                }
              />
            </dl>

            <h2 class="block-side__title">Header</h2>
            <dl class="block-facts block-facts--header">
              <HeaderFact label="Difficulty">
                {(blk) => {
                  const d = formatDifficulty(blk.difficulty);
                  return (
                    <span class="num" title={d.full}>
                      {d.short}
                    </span>
                  );
                }}
              </HeaderFact>
              <HeaderFact label="Version">
                {(blk) => <span class="num">{hex32(blk.version)}</span>}
              </HeaderFact>
              <HeaderFact label="Bits">
                {(blk) => <span class="num">{hex32(blk.bits)}</span>}
              </HeaderFact>
              <HeaderFact label="Nonce">
                {(blk) => <span class="num">{groupDigits(blk.nonce)}</span>}
              </HeaderFact>
              <HeaderFact label="Median time">
                {(blk) => <TimeUtc time={blk.mediantime} />}
              </HeaderFact>
              <HeaderFact label="Merkle root">
                {(blk) => <Hash value={blk.merkle_root} copyLabel="Copy merkle root" />}
              </HeaderFact>
            </dl>
          </div>
        </div>

        <Show when={props.hash && !(s() && (stale() || s()?.next_best)) && props.hash} keyed>
          {(h) => (
            <NextListener
              hash={h}
              newest={() => s() !== undefined && !stale() && !s()?.next_best}
              onNext={() => statusCtl.refetch()}
            />
          )}
        </Show>
        <Show when={props.hash && sum() === undefined}>
          <SummaryListener
            onSummary={(pushedSummary) => {
              if (pushedSummary.id !== props.hash) return;
              rememberSummary(network(), pushedSummary);
              setPushed(pushedSummary);
            }}
          />
        </Show>
        {/* Below the fold on every screen, so its height settling when the facts arrive moves
            nothing the reader sees. */}
        <AuditSection
          hash={props.hash}
          audit={sum() === undefined ? undefined : readAudit(sum()?.audit)}
          error={failed(summary) !== undefined}
          retry={() => summaryCtl.refetch()}
        />

        <section class="block-txs" aria-labelledby="block-txs-title">
          <SectionHeader title="Transactions" id="block-txs-title">
            <span class="num" aria-live="polite">
              <Show when={txs() && txCount() !== undefined} fallback={<Skel size="s" />}>
                {groupDigits(txs()?.length ?? 0)} of {groupDigits(txCount() ?? 0)}, in block order
              </Show>
            </span>
          </SectionHeader>
          <Show
            when={failed(first) === undefined}
            fallback={
              <ErrorState
                title="Could not load the transactions"
                error={failed(first)}
                retry={() => firstCtl.refetch()}
              />
            }
          >
            {/* A row under the pointer or focus rings its square in the map above. */}
            <div
              class="block-txs__table"
              onPointerOver={rowAt}
              onFocusIn={rowAt}
              onPointerLeave={() => setHighlight(undefined)}
              onFocusOut={() => setHighlight(undefined)}
            >
              <DataTable
                caption="Transactions in this block"
                columns={columns}
                rows={rows()}
                rowHref={(tx) => (tx ? paths.tx(tx.txid) : undefined)}
              />
            </div>
            <div class="block-txs__more">
              <Show when={moreError()}>
                {(e) => (
                  <ErrorState
                    title="Could not load more transactions"
                    error={e()}
                    retry={() => void loadMore()}
                  />
                )}
              </Show>
              <Show when={hasMore() && moreError() === undefined}>
                <button
                  class="btn"
                  type="button"
                  aria-disabled={moreLoading() ? "true" : "false"}
                  onClick={() => void loadMore()}
                >
                  {moreLoading()
                    ? "Loading…"
                    : `Show ${Math.min(PAGE, (txCount() ?? 0) - (txs()?.length ?? 0))} more`}
                </button>
              </Show>
            </div>
          </Show>
        </section>
      </div>
    </Show>
  );

  function HeaderFact(p: { label: string; children: (blk: Block) => JSX.Element }) {
    return (
      <div class="block-fact">
        <dt>{p.label}</dt>
        <dd>
          {/* Keyed: a cached block can replace another without a loading state in between. */}
          <Show when={b()} keyed fallback={<Skel size="s" />}>
            {(blk) => p.children(blk)}
          </Show>
        </dd>
      </div>
    );
  }
}

/**
 * Hears the `blocks` topic from the page's first answer on, for as long as the block may be the
 * newest, and calls `onNext` when its status says it is the newest and another tip has been heard:
 * the next block was found, before the status answered or after. It listens from the start
 * because a topic another part of the page already follows sends a new listener nothing at first.
 */
function NextListener(props: { hash: string; newest: () => boolean; onNext: () => void }) {
  // Another tip heard before the status said this block is the newest: that status may predate it.
  let heard = false;
  const next = () => {
    if (untrack(props.newest)) props.onNext();
    else heard = true;
  };
  useTopic(blocksTopic, {
    message: (m) => {
      if (m.type === "summary" || (m.type === "block" && m.block.id === props.hash)) return;
      next();
    },
    resync: next,
  });
  createEffect(props.newest, (newest) => {
    if (!newest || !heard) return;
    heard = false;
    props.onNext();
  });
  return null;
}

/** Hears the `blocks` topic while mounted, for a block whose facts have not arrived yet. */
function SummaryListener(props: { onSummary: (s: BlockSummary) => void }) {
  useTopic(blocksTopic, {
    message: (m) => {
      if (m.type === "summary") props.onSummary(m.summary);
    },
    // The facts are being asked for over HTTP anyway.
    resync: () => undefined,
  });
  return null;
}

const vsize = (tx: Transaction) =>
  tx.weight === undefined ? undefined : vsizeFromWeight(tx.weight);
const isCoinbase = (tx: Transaction) => tx.vin?.[0]?.is_coinbase === true;

/** A row's fee rate, or what stands in for one. */
function RateCell(props: { tx: Transaction; unit: boolean }) {
  const rate = () => {
    const v = vsize(props.tx);
    return props.tx.fee === undefined || v === undefined ? null : feeRate(props.tx.fee, v);
  };
  return (
    <Show when={!isCoinbase(props.tx)} fallback={<span class="muted">Coinbase</span>}>
      {/* A rate of 0 is a rate: a transaction may pay no fee. */}
      <Show when={rate() !== null} fallback={MISSING}>
        <FeeRate rate={rate() ?? 0} unit={props.unit} />
      </Show>
    </Show>
  );
}

const columns = [
  {
    header: "Transaction",
    cell: (tx: Transaction | null) =>
      tx ? (
        <span class="block-txcell">
          <Hash value={tx.txid} href={paths.tx(tx.txid)} copyLabel="Copy transaction ID" fit />
          {/* Phones drop the fee rate column, so the rate moves under the txid. */}
          <span class="block-txcell__rate">
            <RateCell tx={tx} unit />
          </span>
        </span>
      ) : (
        <Skel />
      ),
  },
  {
    header: "Fee rate, sat/vB",
    optional: true,
    cell: (tx: Transaction | null) => (tx ? <RateCell tx={tx} unit={false} /> : <Skel size="s" />),
  },
  {
    header: "Fee, sats",
    numeric: true,
    optional: true,
    cell: (tx: Transaction | null) => {
      if (!tx) return <Skel size="s" />;
      if (isCoinbase(tx)) return "";
      return tx.fee === undefined ? MISSING : <Sats sats={tx.fee} unit={false} />;
    },
  },
  {
    // Sizes keep their unit in the cell, as one column can span vB to kvB (docs/DESIGN.md).
    header: "Virtual size",
    numeric: true,
    optional: true,
    cell: (tx: Transaction | null) => {
      if (!tx) return <Skel size="s" />;
      const v = vsize(tx);
      return v === undefined ? MISSING : formatSize(v);
    },
  },
  {
    header: "Value, BTC",
    numeric: true,
    cell: (tx: Transaction | null) =>
      tx ? <Amount sats={tx.vout.reduce((sum, o) => sum + o.value, 0)} unit={false} /> : <Skel />,
  },
];

/**
 * The block as a core sample: a frame the size of the weight limit. Its fee layers stand in until
 * every transaction's size and fee arrive; then the map of them is drawn into the same box, so
 * nothing moves. The layers stay where the map cannot be drawn or its data cannot load.
 */
function CoreSample(props: {
  weight: number | undefined;
  summary: BlockSummary | null | undefined;
  settle: boolean;
  txs: GridTx[] | undefined;
  txsError: unknown;
  retryTxs: () => void;
  txid: (tx: GridTx) => Promise<string>;
  highlight: number | undefined;
}) {
  const share = () => (props.weight === undefined ? undefined : fullness(props.weight));
  const layers = createMemo(() => {
    const f = share();
    return props.summary && f !== undefined
      ? strataLayers(props.summary.fee_bands, f, CORE_LAYER_MIN)
      : [];
  });
  const described = () => (props.summary ? describeBands(props.summary.fee_bands) : []);
  const [grid, setGrid] = createSignal<GridState>();
  const lit = createMemo(() => litOf(pick()));
  let frame: HTMLDivElement | undefined;
  const drawn = () => grid() === "drawn" && props.txs !== undefined;
  const filled = () => (
    <Show when={share() !== undefined} fallback={<Skel size="s" />}>
      {percent(share() ?? 0)}
    </Show>
  );
  const label = () => {
    const n = props.txs?.length ?? 0;
    return `Map of the block's ${groupDigits(n)} ${n === 1 ? "transaction" : "transactions"}, one rectangle each, the highest fee rate at the top left.${litLabel(pick())} The list below has every one.`;
  };
  return (
    <figure class={["block-core panel", { "block-core--grid": drawn() }]}>
      <div class="block-core__frame" ref={frame}>
        <span class="block-core__limit" aria-hidden="true">
          Weight limit
        </span>
        <Show when={layers().length > 0}>
          <div class="block-core__strata">
            <Strata layers={layers()} settle={props.settle} />
          </div>
        </Show>
        <Show when={share()} keyed>
          {(f) => (
            <div
              class={[
                "block-core__fill",
                {
                  "block-core__fill--high": f > 0.85,
                  "block-core__fill--strata": layers().length > 0,
                },
              ]}

              style={{ "--fill": String(Math.max(f, strataTop(layers()))) }}
            >
              <span class="block-core__level num">{percent(f)} full</span>
            </div>
          )}
        </Show>
        <Show when={props.txs && grid() !== "unsupported"}>
          <div class="block-core__grid">
            <Loading>
              <TxGrid
                txs={props.txs ?? []}
                capacity={MAX_BLOCK_WEIGHT / 4}
                label={label()}
                txid={props.txid}
                lit={lit()}
                highlight={props.highlight}
                onState={setGrid}
              />
            </Loading>
          </div>
        </Show>
      </div>
      <Show when={grid() !== "unsupported" && props.txsError === undefined}>
        <Goggles txs={props.txs} frame={() => frame} />
      </Show>
      {/* Both captions are always laid out in one cell, so the taller sets its height and the
          swap from layers to map moves nothing. */}
      <figcaption class="block-core__caption">
        <span class={["block-core__text", { "block-core__text--off": drawn() }]}>
          The block fills {filled()} of its weight limit, in layers by fee rate: each is as thick as
          the virtual size paying that rate, the cheapest at the bottom.
          <Show when={grid() === "unsupported"}>
            {" "}
            The map of each transaction needs WebGL2, which this browser does not offer.
          </Show>
          <Show when={props.txsError !== undefined}>
            {" "}
            {props.txsError instanceof TxsFormatError && props.txsError.kind === "version"
              ? props.txsError.message
              : "The map of each transaction could not load."}{" "}
            <button type="button" class="block-core__retry" onClick={() => props.retryTxs()}>
              Try again
            </button>
          </Show>
        </span>
        <span class={["block-core__text", { "block-core__text--off": !drawn() }]}>
          {filled()} full: one rectangle a transaction, by size and fee rate.{" "}
          {/* rel="external" keeps the router out: it would mark this in-page link as the current page. */}
          <a href="#block-txs-title" rel="external">
            Every transaction is in the list below.
          </a>
        </span>
        <Show when={described().length > 0}>
          <span class="visually-hidden"> Layers, cheapest first: {described().join("; ")}.</span>
        </Show>
      </figcaption>
      <FeeKey />
    </figure>
  );
}
