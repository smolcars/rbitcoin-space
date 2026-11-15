// The exit path as a picture (docs/DESIGN.md "Ark"): the Bitcoin line, which is also the VTXO's
// lifetime from its anchor to its expiry, and the transactions rising from the anchor to the VTXO.
// Drawn in the accent, as the owner approved for this one picture. Every node is a button that
// selects its transaction; the page shows the selection's details.
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { groupDigits } from "../../../lib/format";
import { axisX, layout, type Placed } from "./layout";
import type { BarkVtxo } from "./vtxo";

const KIND_WORD = { branch: "branch", leaf: "leaf", transfer: "transfer" } as const;

export function ExitPath(props: {
  vtxo: BarkVtxo;
  tip: number | undefined;
  anchorHeight: number | undefined;
  /** How many transactions Play exit has lit so far; undefined when it is not playing. */
  lit: number | undefined;
  /** Play exit reached the end: the wait shows. */
  done: boolean;
  selected: number | undefined;
  onSelect: (i: number) => void;
}) {
  let box: HTMLDivElement | undefined;
  const [width, setWidth] = createSignal(0);
  onSettled(() => {
    const el = box;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    const seen = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(el.clientWidth));
    });
    seen.observe(el);
    return () => {
      seen.disconnect();
      cancelAnimationFrame(frame);
    };
  });

  const l = createMemo(() =>
    layout(
      props.vtxo.txs.map((t) => t.kind),
      width() || 640,
    ),
  );
  const last = () => props.vtxo.txs.length - 1;
  const isLit = (i: number) => props.lit === undefined || i < props.lit;
  const axis = (h: number) =>
    axisX(l(), h, props.anchorHeight ?? props.tip ?? h, props.vtxo.expiryHeight);
  const vtxoPoint = () => l().nodes[last()] ?? l().anchor;
  const vtxoLeft = () => vtxoPoint().x > l().width - 140;
  /** The "now" mark is near the right end: its words go to its left. */
  const nowRight = () => axis(props.tip ?? 0) > l().width - 130;
  const vtxoLines = () => [
    { text: "This VTXO", cls: "bark-path__vtxo-name" },
    { text: `${groupDigits(props.vtxo.amount)} sats`, cls: undefined },
    ...(props.done
      ? [{ text: `then wait ${groupDigits(props.vtxo.exitDelta)} blocks`, cls: "bark-path__wait" }]
      : []),
  ];
  const left = () => (props.tip === undefined ? undefined : props.vtxo.expiryHeight - props.tip);

  const keyed = (i: number) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    props.onSelect(i);
  };

  const siblingLabel = (i: number) => {
    const s = props.vtxo.txs[i]?.siblings ?? [];
    const sum = s.reduce((a, b) => a + b, 0);
    return `${groupDigits(sum)} sats`;
  };

  const stub = (n: Placed, i: number) => {
    const dx = n.stub === "left" ? -34 : 0;
    const dy = n.stub === "left" ? -26 : -26;
    return (
      <g class="bark-path__sibling">
        <path d={`M${n.x} ${n.y}l${dx} ${dy}`} />
        <circle cx={n.x + dx} cy={n.y + dy} r="3" />
        <Show when={n.label}>
          <text
            x={n.x + dx + (n.stub === "left" ? -6 : 0)}
            y={n.y + dy - (n.stub === "left" ? -4 : 8)}
            text-anchor={n.stub === "left" ? "end" : "middle"}
          >
            {siblingLabel(i)}
          </text>
        </Show>
      </g>
    );
  };

  return (
    <div class="bark-path" ref={box}>
      <svg
        class={["bark-path__svg", { "bark-path__svg--playing": props.lit !== undefined }]}
        viewBox={`0 0 ${l().width} ${l().height}`}
        width={l().width}
        height={l().height}
        role="group"
        aria-label={`Exit path: ${props.vtxo.txs.length} transactions from the anchor to this VTXO`}
      >
        {/* The Bitcoin line, and the VTXO's life along it. */}
        <g class="bark-path__chain" aria-hidden="true">
          <line x1={l().axis.from} y1={l().baseline} x2={l().axis.to} y2={l().baseline} />
          <line
            class="bark-path__expiry"
            x1={axis(props.vtxo.expiryHeight)}
            y1={l().baseline - 7}
            x2={axis(props.vtxo.expiryHeight)}
            y2={l().baseline + 7}
          />
          <text
            x={axis(props.vtxo.expiryHeight)}
            y={l().baseline + 22}
            text-anchor="end"
          >{`Expiry ${groupDigits(props.vtxo.expiryHeight)}`}</text>
          <Show
            when={props.anchorHeight !== undefined && props.tip !== undefined && (left() ?? 0) > 0}
          >
            <path
              class="bark-path__now"
              d={`M${axis(props.tip ?? 0) - 5} ${l().baseline - 12}h10l-5 7z`}
            />
            <text
              class="bark-path__now-text"
              x={axis(props.tip ?? 0) + (nowRight() ? -9 : 9)}
              y={l().baseline - 8}
              text-anchor={nowRight() ? "end" : "start"}
            >{`${groupDigits(left() ?? 0)} blocks left`}</text>
          </Show>
          <rect
            class="bark-path__anchor"
            x={l().anchor.x - 5}
            y={l().baseline - 5}
            width="10"
            height="10"
          />
          <text x={l().anchor.x} y={l().baseline + 22} text-anchor="middle">
            {props.anchorHeight === undefined
              ? "Anchor"
              : `Anchor ${groupDigits(props.anchorHeight)}`}
          </text>
          <text class="bark-path__muted" x={l().axis.from} y={l().baseline + 40}>
            Bitcoin
          </text>
        </g>

        <g aria-hidden="true">
          <For each={l().edges}>
            {(d, i) => (
              <path class={["bark-path__edge", { "bark-path__edge--dim": !isLit(i()) }]} d={d} />
            )}
          </For>
        </g>

        <For each={l().nodes}>
          {(n, i) => (
            <g
              class={[
                "bark-path__node",
                {
                  "bark-path__node--dim": !isLit(i()),
                  "bark-path__node--now": props.lit !== undefined && i() === props.lit - 1,
                  "bark-path__node--selected": props.selected === i(),
                },
              ]}
              role="button"
              tabindex="0"
              aria-pressed={props.selected === i() ? "true" : "false"}
              aria-label={`Transaction ${i() + 1}, ${KIND_WORD[n.kind]}`}
              onClick={() => props.onSelect(i())}
              onKeyDown={keyed(i())}
            >
              <Show when={(props.vtxo.txs[i()]?.siblings.length ?? 0) > 0}>{stub(n, i())}</Show>
              <circle class="bark-path__hit" cx={n.x} cy={n.y} r="22" />
              <circle class="bark-path__dot" cx={n.x} cy={n.y} r="4.5" />
              <Show when={i() !== last()}>
                <text
                  class="bark-path__number"
                  x={n.stub === "left" ? n.x + 10 : n.x}
                  y={n.stub === "left" ? n.y + 4 : n.y + 18}
                  text-anchor={n.stub === "left" ? "start" : "middle"}
                >
                  {i() + 1}
                </text>
              </Show>
            </g>
          )}
        </For>

        {/* This VTXO, at the end of the path: its words beside it, or above it near the right edge
            (it always sits on the top row, so the room above is kept for them). */}
        <g
          class={["bark-path__vtxo", { "bark-path__node--dim": !isLit(last()) }]}
          aria-hidden="true"
        >
          <circle class="bark-path__ring" cx={vtxoPoint().x} cy={vtxoPoint().y} r="10" />
          <For each={vtxoLines()}>
            {(line, k) => (
              <text
                class={line.cls}
                x={vtxoLeft() ? vtxoPoint().x + 12 : vtxoPoint().x + 16}
                y={
                  vtxoPoint().y +
                  (vtxoLeft() ? -34 - (vtxoLines().length - 1 - k()) * 15 : -2 + k() * 15)
                }
                text-anchor={vtxoLeft() ? "end" : "start"}
              >
                {line.text}
              </text>
            )}
          </For>
        </g>
      </svg>
    </div>
  );
}
