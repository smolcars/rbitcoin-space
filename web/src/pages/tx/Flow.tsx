import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { Link } from "../../components/Link";
import { scriptKey } from "../../lib/address";
import type { Outspend, Transaction, Vout } from "../../lib/esplora";
import { feeColor, groupDigits } from "../../lib/format";
import type { Lookalike } from "../../lib/lookalike";
import { paths } from "../../lib/network";
import type { TagPart } from "../block/chain";
import { type ChainText, coinbaseText, inputText, outputText } from "./chaintext";
import { LookalikeTag } from "./Lookalike";
import { bringIntoView, cardId, clearFlash, nextFrame, setOpener, SHOW } from "./flash";
import { CardMarks } from "./Privacy";
import type { Mark } from "./privacytext";
import { classify } from "./script";
import {
  cssMs,
  FIRST_SHOWN,
  isCoinbase,
  MORE_STEP,
  shownCount,
  totalIn,
  totalOut,
  vsize,
  whyUnspendable,
} from "./tx";

export type Side = "in" | "out";
export interface Selection {
  side: Side;
  index: number;
}

/** What a card names when there is no address: the script type, and an OP_RETURN's size when its data is not text. */
function scriptLabel(out: Vout): string {
  const about = outputText(out)?.about;
  return about ? `OP_RETURN, ${about}` : classify(out.scriptpubkey).label;
}

/** Chain text as text nodes: hidden runs as muted dots (six at most), counted in their title. */
export function ChainWords(props: { parts: TagPart[] }) {
  return (
    <For each={props.parts}>
      {(p) =>
        "text" in p ? (
          p.text
        ) : (
          <span
            class="tx-hidden"
            title={`${p.hidden} ${p.hidden === 1 ? "character" : "characters"} that are not text`}
          >
            {"·".repeat(Math.min(p.hidden, 6))}
          </span>
        )
      }
    </For>
  );
}

/**
 * A card's text line under its ledger row: the text in quotes, after its label when the card's
 * name does not give it; or what a payload that is not text is ("Inscription, image/png, 793 B").
 */
function Memo(props: { t: ChainText | null; label: boolean }) {
  return (
    <Show when={props.t}>
      {(t) => (
        <Show
          when={t().parts}
          fallback={
            <Show when={t().about}>
              {(a) => (
                <span class="tx-flow__memo tx-flow__memo--about">
                  {t().label}, {a()}
                </span>
              )}
            </Show>
          }
        >
          {(parts) => (
            <span class="tx-flow__memo">
              <Show when={props.label}>
                <span class="tx-flow__memo-label">{t().label}</span>{" "}
              </Show>
              “<ChainWords parts={parts()} />”
            </span>
          )}
        </Show>
      )}
    </Show>
  );
}

interface Ribbon {
  d: string;
  kind: "in" | "out" | "fee" | "more";
  key: string;
}

const tokenMs = (name: string) =>
  cssMs(getComputedStyle(document.documentElement).getPropertyValue(name));

/**
 * Inputs on the left, outputs on the right, joined by ribbons as thick as the value they carry.
 * Shows FIRST_SHOWN of each side, then MORE_STEP more per press; hidden items travel as one ribbon.
 */
export function Flow(props: {
  tx: Transaction;
  outspends: () => Outspend[] | null | undefined;
  selected: Selection | null;
  onSelect: (s: Selection) => void;
  /** Lookalike addresses handed over from an address page, by address: marked on their cards. */
  lookalike?: ReadonlyMap<string, Lookalike> | undefined;
  /** What the privacy check says of each card, keyed `in:N` and `out:N` (privacytext.ts). */
  marks?: ReadonlyMap<string, readonly Mark[]> | undefined;
  /** Before a mark's link is followed: the page makes room for what it leads to. */
  onMark?: (() => void) | undefined;
  /** False for a transaction the node does not have: its outputs exist nowhere yet, so no card
   * says whether one is spent. */
  known?: boolean | undefined;
}) {
  const [inPresses, setInPresses] = createSignal(0);
  const [outPresses, setOutPresses] = createSignal(0);
  const vin = () => props.tx.vin ?? [];
  const inShown = () => shownCount(vin().length, inPresses());
  const outShown = () => shownCount(props.tx.vout.length, outPresses());
  const coinbase = () => isCoinbase(props.tx);
  const fee = () => (coinbase() ? 0 : (props.tx.fee ?? 0));
  const rate = () => {
    const v = vsize(props.tx);
    return v !== undefined && v !== 0 ? fee() / v : 0;
  };
  const hiddenIn = () =>
    vin()
      .slice(inShown())
      .reduce((a, i) => a + (i.prevout?.value ?? 0), 0);
  const hiddenOut = () => props.tx.vout.slice(outShown()).reduce((a, o) => a + o.value, 0);

  let flowEl: HTMLDivElement | undefined;
  let svgEl: SVGSVGElement | undefined;
  let inCol: HTMLUListElement | undefined;
  let outCol: HTMLUListElement | undefined;
  const [ribbons, setRibbons] = createSignal<Ribbon[]>([]);
  const [trunk, setTrunk] = createSignal({ x: 0, y: 0, h: 0 });
  const [view, setView] = createSignal("0 0 0 0");

  // Ribbon geometry from where the cards actually sit. One layout read per draw.
  const draw = () => {
    if (!svgEl || !inCol || !outCol) return;
    const box = svgEl.getBoundingClientRect();
    const W = box.width;
    const H = box.height;
    if (W === 0 || H === 0) return;
    const total = Math.max(totalIn(props.tx), totalOut(props.tx) + fee(), 1);
    // The whole value is at most four fifths of the smallest card, so every ribbon meets its card
    // inside the card's edge, never past its corners.
    const cards = [...inCol.children, ...outCol.children].map(
      (el) => el.getBoundingClientRect().height,
    );
    const T = Math.min(H * 0.8, 96, Math.min(...cards) * 0.8);
    const mid = W / 2;
    const thicknesses = (col: HTMLUListElement) =>
      ([...col.children] as HTMLElement[]).map((el) =>
        Math.max(1.5, (Number(el.dataset["value"]) / total) * T),
      );
    const tIn = thicknesses(inCol);
    const tOut = thicknesses(outCol);
    const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const side = (col: HTMLUListElement, thick: number[], toRight: boolean): Ribbon[] => {
      const items = [...col.children] as HTMLElement[];
      let y = H / 2 - sumOf(thick) / 2;
      const c = (toRight ? 1 : -1) * W * 0.45;
      return items.map((el, k) => {
        const r = el.getBoundingClientRect();
        const cy = r.top + r.height / 2 - box.top;
        const th = thick[k] ?? 1.5;
        const a = { x: toRight ? 0 : W, y0: cy - th / 2, y1: cy + th / 2 };
        const b = { x: mid, y0: y, y1: y + th };
        y += th;
        const f = (n: number) => n.toFixed(1);
        return {
          d: `M${f(a.x)},${f(a.y0)} C${f(a.x + c)},${f(a.y0)} ${f(b.x - c)},${f(b.y0)} ${f(b.x)},${f(b.y0)} L${f(b.x)},${f(b.y1)} C${f(b.x - c)},${f(b.y1)} ${f(a.x + c)},${f(a.y1)} ${f(a.x)},${f(a.y1)} Z`,
          kind: (el.dataset["kind"] as Ribbon["kind"]) ?? (toRight ? "in" : "out"),
          key: `${toRight ? "i" : "o"}${el.dataset["key"] ?? k}`,
        };
      });
    };
    const left = side(inCol, tIn, true);
    const right = side(outCol, tOut, false);
    const span = Math.max(sumOf(tIn), sumOf(tOut));
    setView(`0 0 ${W} ${H}`);
    setTrunk({ x: mid, y: H / 2 - span / 2, h: span });
    setRibbons([...left, ...right]);
  };

  let first = true;
  const animate = () => {
    if (!first || !svgEl || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    first = false;
    const d = tokenMs("--dur-slow");
    const s = tokenMs("--stagger");
    const ease = getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim();
    if (!d) return;
    // Value flows in from the left, then out to the right; the stagger stops after a dozen.
    [...svgEl.querySelectorAll<SVGPathElement>(".tx-ribbon")].forEach((p, k) => {
      const out = p.dataset["side"] === "out";
      p.animate(
        [
          { opacity: 0, transform: "translateX(-8px)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: d,
          delay: (out ? d * 0.5 : 0) + Math.min(k, 12) * s,
          easing: ease || "ease-out",
          fill: "backwards",
        },
      );
    });
  };

  // A link from the privacy check: open the card's group if it is hidden, then show the card.
  const onShow = (e: Event) => {
    if (!(e instanceof CustomEvent)) return;
    const { side, index, from } = e.detail as Selection & { from?: HTMLElement };
    const total = side === "in" ? vin().length : props.tx.vout.length;
    if (!Number.isInteger(index) || index < 0 || index >= total) return;
    const need = Math.max(0, Math.ceil((index + 1 - FIRST_SHOWN) / MORE_STEP));
    const presses = side === "in" ? inPresses() : outPresses();
    // Past one more press of "Show more" the card is not drawn: every card before it would be,
    // thousands on a large payout. Its details open instead, as its own button opens them.
    if (need - presses > 1) {
      clearFlash();
      // The number followed is what opened them, even when they were open already.
      setOpener(from ?? null);
      // Already open (the list stays in view above them on a phone): bring them back and focus them.
      if (isSel(side, index)) {
        const heading = document.getElementById("tx-inspector-title");
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        heading?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
        heading?.focus({ preventScroll: true });
      } else props.onSelect({ side, index });
      return;
    }
    if (need > presses) (side === "in" ? setInPresses : setOutPresses)(need);
    nextFrame(() => {
      const card = flowEl?.querySelector<HTMLElement>(`#${cardId(side, index)}`);
      if (!card) return;
      bringIntoView(card, card.querySelector<HTMLElement>(".tx-flow__open") ?? card);
    });
  };

  onSettled(() => {
    const ro = new ResizeObserver(() => draw());
    if (flowEl) ro.observe(flowEl);
    requestAnimationFrame(() => {
      draw();
      requestAnimationFrame(animate);
    });
    document.addEventListener(SHOW, onShow);
    return () => {
      ro.disconnect();
      document.removeEventListener(SHOW, onShow);
      clearFlash();
      // The page is going: keep no element of it.
      setOpener(null);
    };
  });
  // Cards added or relabelled: redraw after they are laid out.
  createEffect(
    () => [inShown(), outShown(), props.outspends()],
    () => {
      requestAnimationFrame(draw);
    },
    { defer: true },
  );

  const marked = (out: Vout | null | undefined) => {
    const a = out?.scriptpubkey_address;
    return a !== undefined && props.lookalike?.has(a) === true;
  };

  const isSel = (side: Side, index: number) =>
    props.selected?.side === side && props.selected.index === index;

  const openButton = (side: Side, index: number) => (
    <button
      type="button"
      class="tx-flow__open"
      aria-expanded={isSel(side, index) ? "true" : "false"}
      aria-controls="tx-inspector"
      aria-label={`Details of ${side === "in" ? "input" : "output"} ${index}`}
      onClick={(e) => {
        setOpener(e.currentTarget);
        props.onSelect({ side, index });
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 4l4 4-4 4" />
      </svg>
    </button>
  );

  /** Whom an output pays: its address, or the key of a pay-to-pubkey script, which has none. */
  const payee = (out: Vout | null | undefined) =>
    out?.scriptpubkey_address ?? (out ? scriptKey(out.scriptpubkey) : undefined);

  /** The address, cut in the middle only as far as the card needs; or what the script is. */
  const who = (out: Vout | null | undefined): JSX.Element => (
    <Show
      when={payee(out)}
      fallback={<span class="tx-flow__label">{out ? scriptLabel(out) : "Unknown"}</span>}
    >
      {(a) => <Hash value={a()} href={paths.address(a())} fit copy={false} />}
    </Show>
  );

  const more = (side: Side, hidden: number, value: number, press: () => void): JSX.Element => (
    <li
      class="tx-flow__item tx-flow__item--more"
      data-value={value}
      data-kind="more"
      data-key="more"
    >
      <button type="button" class="tx-flow__more" onClick={press}>
        Show {groupDigits(Math.min(hidden, MORE_STEP))} more
      </button>
      <span class="tx-flow__amt">
        <Amount sats={value} unit={false} wrap />
      </span>
      <span class="tx-flow__meta">
        {groupDigits(hidden)} more {side === "in" ? "inputs" : "outputs"}
      </span>
    </li>
  );

  // A card is a ledger row: where the money came from or went and how much, then what kind of
  // script and whether it is spent.
  return (
    <div class="tx-flow" ref={flowEl}>
      <ul class="tx-flow__col tx-flow__col--in" aria-label="Inputs" ref={inCol}>
        <Show
          when={!coinbase()}
          fallback={
            <li
              class={["tx-flow__item", { "is-selected": isSel("in", 0) }]}
              data-value={totalOut(props.tx)}
              data-kind="in"
              data-key="0"
            >
              <span class="tx-flow__who">Coinbase</span>
              <span class="tx-flow__amt">
                <Amount sats={totalOut(props.tx)} unit={false} wrap />
              </span>
              <span class="tx-flow__meta">
                <Index n={0} />
                <span>New coins and fees</span>
              </span>
              <Memo t={coinbaseText(props.tx)} label={false} />
              {openButton("in", 0)}
            </li>
          }
        >
          <For each={vin().slice(0, inShown())}>
            {(input, i) => (
              <li
                class={[
                  "tx-flow__item",
                  {
                    "is-selected": isSel("in", i()),
                    "tx-flow__item--lookalike": marked(input.prevout),
                  },
                ]}
                id={cardId("in", i())}
                data-value={input.prevout?.value ?? 0}
                data-key={i()}
              >
                <span class="tx-flow__who">{who(input.prevout)}</span>
                <span class="tx-flow__amt">
                  <Show when={input.prevout} fallback={<span class="amount">–</span>}>
                    {(p) => <Amount sats={p().value} unit={false} wrap />}
                  </Show>
                </span>
                <span class="tx-flow__meta">
                  <Index n={i()} />
                  <Show when={marked(input.prevout)}>
                    <LookalikeTag />
                  </Show>
                  {input.prevout && payee(input.prevout)
                    ? classify(input.prevout.scriptpubkey).label
                    : ""}
                  <CardMarks marks={props.marks?.get(`in:${i()}`)} onFollow={props.onMark} />
                </span>
                <Memo t={inputText(input)} label />
                {openButton("in", i())}
              </li>
            )}
          </For>
          <Show when={vin().length > inShown()}>
            {more("in", vin().length - inShown(), hiddenIn(), () => setInPresses((n) => n + 1))}
          </Show>
        </Show>
      </ul>
      <svg class="tx-flow__ribbons" ref={svgEl} viewBox={view()} aria-hidden="true">
        {/* Index keeps each path element across redraws, so a resize never restarts or cuts an animation. */}
        <For keyed={false} each={ribbons()}>
          {(r) => (
            <path
              class={`tx-ribbon tx-ribbon--${r().kind}${
                props.selected !== null &&
                r().key === `${props.selected.side === "in" ? "i" : "o"}${props.selected.index}`
                  ? " is-selected"
                  : ""
              }`}
              data-side={r().key.startsWith("i") ? "in" : "out"}
              d={r().d}
              style={r().kind === "fee" ? { "--swatch": feeColor(rate()) } : undefined}
            />
          )}
        </For>
        <rect
          class="tx-flow__trunk"
          x={trunk().x - 3}
          y={trunk().y - 3}
          width={6}
          height={trunk().h + 6}
          rx={3}
        />
      </svg>
      <ul class="tx-flow__col tx-flow__col--out" aria-label="Outputs" ref={outCol}>
        <For each={props.tx.vout.slice(0, outShown())}>
          {(out, i) => (
            <li
              class={[
                "tx-flow__item",
                { "is-selected": isSel("out", i()), "tx-flow__item--lookalike": marked(out) },
              ]}
              id={cardId("out", i())}
              data-value={out.value}
              data-key={i()}
            >
              <span class="tx-flow__who">{who(out)}</span>
              <span class="tx-flow__amt">
                <Amount sats={out.value} unit={false} wrap />
              </span>
              <span class="tx-flow__meta">
                <Index n={i()} />
                <Show when={marked(out)}>
                  <LookalikeTag />
                </Show>
                <Show when={payee(out)}>
                  <span>{classify(out.scriptpubkey).label}</span>
                </Show>
                <Spent
                  unspendable={whyUnspendable(props.tx, out) !== null}
                  known={props.known !== false}
                  spend={props.outspends()?.[i()]}
                />
                <CardMarks marks={props.marks?.get(`out:${i()}`)} onFollow={props.onMark} />
              </span>
              <Memo t={outputText(out)?.parts ? outputText(out) : null} label={false} />
              {openButton("out", i())}
            </li>
          )}
        </For>
        <Show when={props.tx.vout.length > outShown()}>
          {more("out", props.tx.vout.length - outShown(), hiddenOut(), () =>
            setOutPresses((n) => n + 1),
          )}
        </Show>
        <Show when={fee() > 0}>
          <li
            class="tx-flow__item tx-flow__item--fee"
            style={{ "--swatch": feeColor(rate()) }}
            data-value={fee()}
            data-kind="fee"
            data-key="fee"
          >
            <span class="tx-flow__who">Fee</span>
            <span class="tx-flow__amt">
              <Amount sats={fee()} unit={false} wrap />
            </span>
            <span class="tx-flow__meta">
              <FeeRate rate={rate()} />
            </span>
          </li>
        </Show>
      </ul>
    </div>
  );
}

/** A card's index, as the privacy check's sentences and its details button name it. */
function Index(props: { n: number }) {
  return <span class="tx-flow__index num">#{props.n}</span>;
}

/**
 * Whether an output has been spent, and by which transaction. Nothing until the answer arrives;
 * nothing at all, and no room kept, for a transaction the node does not have.
 */
function Spent(props: { unspendable: boolean; known: boolean; spend: Outspend | undefined }) {
  return (
    <Show when={!props.unspendable} fallback={<span>Unspendable</span>}>
      {/* An output of a transaction nobody has yet is neither spent nor unspent. */}
      <Show when={props.known}>
        {/* The status's place from the start, as wide as its widest words, so the line wraps the
          same before the spends arrive and after, in any font. */}
        <span class="tx-flow__status">
          <span class="tx-flow__status-room" aria-hidden="true">
            Being spent
          </span>
          <Show when={props.spend}>
            {(s) => (
              <Show when={s().spent && s().txid} fallback={<span>Unspent</span>}>
                {(by) => (
                  <Link href={paths.tx(by())} class="tx-flow__spent">
                    {s().status?.confirmed === false ? "Being spent" : "Spent"}
                    <span class="visually-hidden"> in transaction {by()}</span>
                  </Link>
                )}
              </Show>
            )}
          </Show>
        </span>
      </Show>
    </Show>
  );
}
