// The exit picture: the batch trees in quiet ink on the Bitcoin line, which is also the VTXO's
// lifetime, with this VTXO's way out in the accent (an owner-approved exception to DESIGN.md
// principle 3). "Play exit" lights the transactions in broadcast order and ends on the wait.
// Its one idle motion, the VTXO's halo breathing, is the other approved exception (principle 6);
// reduced motion stills both. The transaction table below is the picture's text alternative.
import { createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { Hash } from "../../../components/Hash";
import { SectionHeader } from "../../../components/SectionHeader";
import { formatSats, groupDigits, MONTHS } from "../../../lib/format";
import { paths } from "../../../lib/network";
import { type Dot, layout, type Scene } from "./layout";
import { exitCounts, rough, type Step, timeLeft, type VtxoAnswer } from "./vtxo";
import { onChainNow, StateView } from "./parts";

/** Reads a duration token in ms; the build may write it in seconds. 0 under reduced motion. */
function tokenMs(name: string): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

/** "7 Nov": a day on the Bitcoin line. */
function dayMonth(t: number): string {
  const d = new Date(t * 1000);
  return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}` : "–";
}

export function Tree(props: {
  answer: VtxoAnswer;
  steps: Step[];
  now: number;
  selected: string | undefined;
  onSelect: (txid: string | undefined) => void;
}) {
  const [width, setWidth] = createSignal(0);
  let box: HTMLDivElement | undefined;
  onSettled(() => {
    // Escape lets go of a selected transaction, wherever focus is.
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.selected !== undefined) props.onSelect(undefined);
    };
    window.addEventListener("keydown", escape);
    setWidth(Math.round(box?.clientWidth ?? 0) || 1000);
    const watch =
      box && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            const w = Math.round(entries[0]?.contentRect.width ?? 0);
            if (w > 0) setWidth(w);
          })
        : undefined;
    if (box) watch?.observe(box);
    return () => {
      window.removeEventListener("keydown", escape);
      watch?.disconnect();
    };
  });
  // The picture moves with the minute, not the second, so its elements are not remade each tick.
  const minute = createMemo(() => Math.floor(props.now / 60) * 60);
  const scene = createMemo(() =>
    width() > 0 ? layout(props.answer, props.steps, width(), minute()) : undefined,
  );
  const byN = createMemo(() => new Map(props.steps.map((s) => [s.n, s])));
  const total = () => exitCounts(props.steps).total;
  const swept = () => props.answer.vtxo.swept;

  // Play: undefined shows every step lit; a number lights the steps up to it.
  const [played, setPlayed] = createSignal<number | undefined>(undefined);
  const [waiting, setWaiting] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);
  onCleanup(stop);
  const play = () => {
    stop();
    const pace = tokenMs("--dur-slow");
    if (pace === 0) {
      setPlayed(undefined);
      setWaiting(true);
      return;
    }
    setWaiting(false);
    setPlayed(0);
    let n = 0;
    timer = setInterval(() => {
      n++;
      if (n > total()) {
        stop();
        setPlayed(undefined);
        setWaiting(true);
      } else {
        setPlayed(n);
      }
    }, pace);
  };
  const lit = (n: number) => {
    const p = played();
    return p === undefined || n <= p;
  };

  const mine = () => props.steps.filter((s) => s.kind !== "commitment" || s.onchain !== null);
  const picked = () => props.steps.find((s) => s.txid === props.selected);
  const move = (by: number) => {
    const list = mine();
    const i = list.findIndex((s) => s.txid === props.selected);
    const next = list[(i + by + list.length) % list.length];
    if (next) props.onSelect(next.txid);
  };
  const vtxos = () => props.answer.batches.reduce((n, b) => n + b.vtxos, 0);

  return (
    <section class="arkade-exit">
      <SectionHeader title="Exit path">
        <button class="btn" type="button" onClick={play}>
          Play exit
        </button>
      </SectionHeader>
      <div class="arkade-scene" ref={(el) => (box = el)}>
        <Show when={scene()}>
          {(sc) => (
            <svg
              class={["arkade-svg", { "is-playing": played() !== undefined, "is-swept": swept() }]}
              viewBox={`0 0 ${sc().width} ${sc().height}`}
              width={sc().width}
              height={sc().height}
              role="group"
              aria-label={`Exit path: ${total()} transactions from the Bitcoin chain to this VTXO`}
            >
              <Show when={vtxos() > 0}>
                <text class="arkade-svg__count" x={sc().width - 12} y="20" text-anchor="end">
                  {groupDigits(vtxos())} VTXOs
                </text>
              </Show>
              <line
                class="arkade-svg__chain"
                x1="0"
                x2={sc().width}
                y1={sc().lineY}
                y2={sc().lineY}
              />
              <For each={sc().links}>
                {(l) => (
                  <path
                    class={[
                      "arkade-link",
                      {
                        "arkade-link--mine": l.mine,
                        "arkade-link--confirmed":
                          l.mine && byN().get(l.n)?.onchain?.state === "confirmed",
                        "is-dim": l.mine && !lit(l.n),
                      },
                    ]}
                    d={l.d}
                  />
                )}
              </For>
              <For each={sc().dots}>
                {(d) => (
                  <DotView
                    dot={d}
                    scene={sc()}
                    lit={d.step ? lit(d.step.n) : true}
                    selected={d.step !== undefined && d.step.txid === props.selected}
                    swept={swept()}
                    onSelect={props.onSelect}
                  />
                )}
              </For>
              <Axis scene={sc()} answer={props.answer} now={props.now} />
              <Labels scene={sc()} answer={props.answer} waiting={waiting()} />
            </svg>
          )}
        </Show>
      </div>
      <ul class={["arkade-legend", { "is-swept": swept() }]}>
        <li>
          <svg viewBox="0 0 24 8" aria-hidden="true">
            <path class="arkade-legend__mine" d="M1 4h16" />
            <circle class="arkade-legend__dot" cx="18" cy="4" r="2.6" />
          </svg>
          {swept() ? "Expired" : "Exit transaction"}
        </li>
        <Show when={props.steps.some((s) => s.kind !== "commitment" && onChainNow(s.onchain))}>
          <li>
            <svg viewBox="0 0 24 8" aria-hidden="true">
              <path class="arkade-legend__confirmed" d="M1 4h16" />
            </svg>
            On chain
          </li>
        </Show>
        <li>
          <svg viewBox="0 0 24 8" aria-hidden="true">
            <circle class="arkade-legend__other" cx="4" cy="4" r="1.6" />
            <circle class="arkade-legend__other" cx="11" cy="4" r="1.6" />
            <circle class="arkade-legend__other" cx="18" cy="4" r="1.6" />
          </svg>
          Other VTXOs
        </li>
      </ul>
      <Show when={picked()}>
        {(s) => (
          <div class="arkade-pick" role="region" aria-label="Selected transaction">
            <div class="arkade-pick__head">
              <h3>
                <Show when={s().n > 0}>
                  <span class="num muted">#{s().n} </span>
                </Show>
                {s().name}
              </h3>
              <div class="arkade-pick__nav">
                <button
                  class="btn arkade-pick__btn"
                  type="button"
                  aria-label="Previous transaction"
                  onClick={() => move(-1)}
                >
                  ‹
                </button>
                <button
                  class="btn arkade-pick__btn"
                  type="button"
                  aria-label="Next transaction"
                  onClick={() => move(1)}
                >
                  ›
                </button>
                <button
                  class="btn arkade-pick__btn"
                  type="button"
                  aria-label="Close"
                  onClick={() => props.onSelect(undefined)}
                >
                  ×
                </button>
              </div>
            </div>
            <dl class="arkade-pick__facts">
              <div>
                <dt>State</dt>
                <dd>
                  <StateView state={s().onchain} swept={swept()} />
                </dd>
              </div>
              <div>
                <dt>Txid</dt>
                <dd>
                  <Hash
                    value={s().txid}
                    copyLabel="Copy the txid"
                    {...(onChainNow(s().onchain) ? { href: paths.tx(s().txid) } : {})}
                  />
                </dd>
              </div>
              <Show when={s().spends.length > 0}>
                <div>
                  <dt>Spends</dt>
                  <dd class="arkade-pick__list">
                    <For each={s().spends}>{(t) => <Hash value={t} copy={false} />}</For>
                  </dd>
                </div>
              </Show>
            </dl>
          </div>
        )}
      </Show>
    </section>
  );
}

function DotView(props: {
  dot: Dot;
  scene: Scene;
  lit: boolean;
  selected: boolean;
  swept: boolean;
  onSelect: (txid: string | undefined) => void;
}) {
  const d = () => props.dot;
  const r = () => (props.scene.compact ? 2.8 : 3.3);
  const state = () => d().step?.onchain?.state;
  return (
    <Show
      when={d().step}
      fallback={
        <circle
          class={d().kind === "leaf" ? "arkade-dot arkade-dot--leaf" : "arkade-dot"}
          cx={d().x}
          cy={d().y}
          r={d().kind === "leaf" ? (props.scene.compact ? 1.4 : 2) : 1.6}
        />
      }
    >
      {(step) => (
        <g
          class={[
            "arkade-node",
            {
              "arkade-node--anchor": d().kind === "anchor",
              "arkade-node--confirmed": state() === "confirmed",
              "arkade-node--mempool": state() === "mempool",
              "arkade-node--expired": props.swept && state() !== "confirmed",
              "is-dim": !props.lit,
              "is-selected": props.selected,
              "is-me": step().mine,
            },
          ]}
          transform={`translate(${d().x} ${d().y})`}
          tabindex="0"
          role="button"
          aria-pressed={props.selected ? "true" : "false"}
          aria-label={`${step().n > 0 ? `${step().n}. ` : ""}${step().name}${step().mine ? ", this VTXO" : ""}`}
          onClick={() => props.onSelect(props.selected ? undefined : step().txid)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              props.onSelect(props.selected ? undefined : step().txid);
            }
          }}
        >
          <circle class="arkade-node__hit" r="12" />
          <Show when={step().mine}>
            <circle class="arkade-node__halo" r="9" />
          </Show>
          <Show when={props.selected}>
            <circle class="arkade-node__ring" r="7" />
          </Show>
          <Show when={d().kind === "anchor"} fallback={<circle class="arkade-node__dot" r={r()} />}>
            <rect class="arkade-node__dot" x="-3.5" y="-3.5" width="7" height="7" rx="1" />
          </Show>
        </g>
      )}
    </Show>
  );
}

/** The line's marks: the commitment, now (while the VTXO lives), the expiry. */
function Axis(props: { scene: Scene; answer: VtxoAnswer; now: number }) {
  const sc = () => props.scene;
  const y = () => sc().lineY;
  const left = () => props.answer.vtxo.expires_at - props.now;
  const over = () => props.answer.vtxo.swept || left() <= 0;
  // Near the end the words go before the marker, so they never run off the picture.
  const nowFlip = () => sc().axis.now > sc().width - 110;
  const commitmentTime = () => {
    const b = props.answer.batches[0];
    return b ? b.ended_at || b.started_at : props.answer.vtxo.created_at;
  };
  return (
    <g class="arkade-axis">
      <line
        class="arkade-axis__tick"
        x1={sc().axis.end}
        x2={sc().axis.end}
        y1={y() - 7}
        y2={y() + 3}
      />
      <text x={sc().axis.commitment} y={y() + 20} text-anchor="middle">
        {sc().compact ? "" : "Commitment "}
        {dayMonth(commitmentTime())}
      </text>
      <text
        x={sc().axis.end}
        y={y() + 20}
        text-anchor="end"
        class={over() ? "arkade-axis__over" : undefined}
      >
        {props.answer.vtxo.swept ? "Swept " : "Expiry "}
        {dayMonth(props.answer.vtxo.expires_at)}
      </text>
      <Show when={!over()}>
        <path class="arkade-axis__now" d={`M${sc().axis.now - 4} ${y() - 11}h8l-4 6z`} />
        <text
          x={nowFlip() ? sc().axis.now - 8 : sc().axis.now + 8}
          y={y() - 6}
          text-anchor={nowFlip() ? "end" : "start"}
        >
          {timeLeft(left()).join(" ")} left
        </text>
      </Show>
      <text class="arkade-axis__name" x="10" y={y() + 40}>
        Bitcoin chain
      </text>
    </g>
  );
}

/** "This VTXO" and its amount; checkpoints named on a wide picture; the wait after an exit. */
function Labels(props: { scene: Scene; answer: VtxoAnswer; waiting: boolean }) {
  const me = () => props.scene.me;
  return (
    <g class="arkade-labels">
      <Show when={me()}>
        {(m) => {
          const flip = () => m().x > props.scene.width - 130;
          const x = () => (flip() ? m().x - 14 : m().x + 14);
          const anchor = () => (flip() ? "end" : "start");
          return (
            <>
              <text class="arkade-labels__me" x={x()} y={m().y - 4} text-anchor={anchor()}>
                This VTXO
              </text>
              <text x={x()} y={m().y + 11} text-anchor={anchor()}>
                {formatSats(props.answer.vtxo.amount)} sats
              </text>
              <Show when={props.waiting}>
                <text class="arkade-labels__wait" x={x()} y={m().y + 26} text-anchor={anchor()}>
                  then wait {rough(props.answer.server.exit_delay_secs)}
                </text>
              </Show>
            </>
          );
        }}
      </Show>
      <Show when={!props.scene.compact && props.scene.checkpoints.length <= 4}>
        <For each={props.scene.checkpoints}>
          {(c) => {
            const flip = c.x > props.scene.width - 100;
            return (
              <text x={flip ? c.x - 10 : c.x + 10} y={c.y + 4} text-anchor={flip ? "end" : "start"}>
                checkpoint
              </text>
            );
          }}
        </For>
      </Show>
    </g>
  );
}
