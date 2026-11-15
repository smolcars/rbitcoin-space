// A block's transactions as packed squares, drawn with WebGL2 (docs/FRONTEND.md "Transaction
// grid"). Loaded lazily: import it with `lazy()` so pages without a grid never fetch it.
import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { FEE_BANDS, formatSats, formatSize, MISSING, truncateMiddle } from "../../lib/format";
import { onNetwork, paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { Amount } from "../Amount";
import { FeeRate } from "../FeeRate";
import { parseBezier, parseColor, type Paint, Renderer, type View } from "./gl";
import { type GridTx, gridSize, hitTest, type Layout, layout, rateOf } from "./layout";
import { type Motion, Scene } from "./scene";
import "./TxGrid.css";

/** What the grid has done, for the page to swap its stand-in: drawn, or why it cannot be. */
export type GridState = "drawn" | "lost" | "unsupported";

export interface TxGridProps {
  /**
   * Every transaction to draw. Give a new array to change them: it is matched to the last one by
   * `id`, so squares that stay move to their new places, new ones drop in and gone ones fade.
   */
  txs: readonly GridTx[];
  /** vB the frame stands for, 1 000 000 for a block; more transactions than this shrink to fit. */
  capacity: number;
  /** The text alternative: what the picture shows, in a sentence or two. */
  label: string;
  /** The txid of a transaction, shown on hover and opened on click. */
  txid: (tx: GridTx) => Promise<string>;
  /** Keeps the transactions this returns true for lit and dims the rest; all lit when absent. */
  lit?: ((tx: GridTx) => boolean) | undefined;
  /** Rings this transaction, by id, such as while its row in a list is hovered. */
  highlight?: number | string | undefined;
  onState?: (state: GridState) => void;
}

const ms = (v: string): number => {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.trim().endsWith("ms") ? n : n * 1000;
};

const SETTLE: [number, number, number, number] = [0.3, 1.45, 0.6, 1];
/** A dimmed square's alpha when the theme does not say (`--txgrid-dim`). */
const DIM = 0.14;
/**
 * While no more than this share of the squares is lit, a lit square narrower than `MARK` CSS px is
 * drawn again that wide in a ring: a few among thousands are found. More lit than that, and the
 * dimmed ones are the few: rings everywhere would only be noise.
 */
const RARE = 0.1;
const MARK = 5;
const IN_OUT: [number, number, number, number] = [0.65, 0, 0.35, 1];

/**
 * Packed transaction squares filling the box it is put in: area by virtual size, color by fee
 * rate, the highest rate at the top left, sitting on the floor of the frame. Hover or tap shows a
 * square's figures; click, or a second tap, opens it. Says nothing to a screen reader beyond
 * `label`: give the transactions as a list beside it.
 */
export default function TxGrid(props: TxGridProps) {
  const network = useNetwork();
  const navigate = useNavigate();
  let canvas!: HTMLCanvasElement;
  let tip!: HTMLDivElement;
  let renderer: Renderer | null = null;
  let scene = new Scene(performance.now());
  let current: Layout | undefined;
  let shown: readonly GridTx[] = [];
  let raf = 0;
  let arrived = 0;
  let drawn = false;
  /** Frames drawn at the end of the scene since it last changed: see `frame`. */
  let finals = 0;
  // CSS pixels of the canvas, and device pixels per CSS pixel.
  let width = 0;
  let height = 0;
  let scale = 1;
  let paint: Paint = {
    colors: new Float32Array(33),
    ease: new Float32Array([...SETTLE, ...IN_OUT]),
    ring: new Float32Array(3),
  };
  const [dim, setDim] = createSignal(DIM);
  /** Whether small lit squares are marked: see `RARE`. */
  let marks = false;
  const [geometry, setGeometry] = createSignal(0);
  const [rankOf, setRankOf] = createSignal(new Map<number | string, number>());
  const [active, setActive] = createSignal<number | string>();
  const [touch, setTouch] = createSignal(false);
  // A lost context shows the browser's broken-canvas picture: hidden, so what is behind shows.
  const [lost, setLost] = createSignal(false);
  const [txids, setTxids] = createSignal(new Map<number | string, string>());
  const [tipAt, setTipAt] = createSignal({ x: 0, y: 0 });

  const style = () => getComputedStyle(canvas);
  const motion = (): Motion => {
    const s = style();
    const v = (name: string) => s.getPropertyValue(name);
    return {
      block: ms(v("--dur-block")),
      slow: ms(v("--dur-slow")),
      base: ms(v("--dur-base")),
      fade: ms(v("--dur-fade")),
      stagger: ms(v("--stagger")),
      settle: parseBezier(v("--ease-settle")) ?? SETTLE,
      inOut: parseBezier(v("--ease-in-out")) ?? IN_OUT,
    };
  };
  const readPaint = () => {
    const s = style();
    const colors = new Float32Array((FEE_BANDS + 1) * 3);
    const names = [
      ...Array.from({ length: FEE_BANDS }, (_, i) => `--fee-${i + 1}`),
      "--color-text-muted",
    ];
    for (const [i, name] of names.entries()) {
      colors.set(parseColor(s.getPropertyValue(name)) ?? [0.5, 0.5, 0.5], i * 3);
    }
    const d = Number.parseFloat(s.getPropertyValue("--txgrid-dim"));
    setDim(Number.isFinite(d) ? d : DIM);
    const m = motion();
    paint = {
      colors,
      ease: new Float32Array([...m.settle, ...m.inOut]),
      ring: new Float32Array(parseColor(s.getPropertyValue("--color-text")) ?? [0.5, 0.5, 0.5]),
    };
  };

  /** The grid's cell and origin in CSS pixels: as large as fits, centred, on the floor. */
  const placement = () => {
    if (!current || width === 0) return undefined;
    const cell = Math.min(width / current.cols, height / current.rows);
    return {
      cell,
      x: (width - cell * current.cols) / 2,
      y: height - cell * current.rows,
    };
  };

  const view = (): View | undefined => {
    const p = placement();
    if (!p) return undefined;
    const radius = Number.parseFloat(style().getPropertyValue("--radius-s")) || 2;
    return {
      width: canvas.width,
      height: canvas.height,
      originX: p.x * scale,
      originY: p.y * scale,
      cell: p.cell * scale,
      dpr: scale,
      radius: radius * scale,
      mark: marks ? MARK * scale : 0,
    };
  };

  const frame = () => {
    raf = 0;
    const v = view();
    if (!renderer || lost() || !v) return;
    const now = performance.now() - scene.epoch;
    renderer.draw(now, v, paint);
    if (!drawn && scene.count > 0) {
      drawn = true;
      performance.measure("txgrid first frame", { start: arrived });
      props.onState?.("drawn");
    }
    // The last frame is drawn twice: WebKit on Linux shows a frame only once the next is drawn, so a
    // single frame (a restore, a resize, a theme switch) would never appear there.
    finals = now < scene.end ? 0 : finals + 1;
    if (finals < 2 && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const schedule = () => {
    finals = 0;
    if (raf === 0 && !document.hidden) raf = requestAnimationFrame(frame);
  };

  /** Lays the transactions out again and moves the squares there. */
  const relayout = (arrival: "pour" | "change" | "snap") => {
    if (width === 0 || height === 0 || !renderer) return;
    const start = performance.now();
    current = layout(shown, width / height, props.capacity);
    performance.measure("txgrid layout", { start });
    const lit = props.lit;
    const d = dim();
    scene.update(
      current,
      shown,
      start - scene.epoch,
      document.hidden ? "snap" : arrival,
      motion(),
      lit ? (tx) => (lit(tx) ? 1 : d) : undefined,
    );
    marks = lit !== undefined && scene.lit <= scene.live * RARE;
    const ranks = new Map<number | string, number>();
    for (let r = 0; r < scene.live; r++) ranks.set(scene.ids[r] ?? r, r);
    setRankOf(ranks);
    renderer.upload(scene.data);
    setGeometry((g) => g + 1);
    schedule();
  };

  createEffect(
    () => props.txs,
    (txs) => {
      const first = shown.length === 0;
      shown = txs;
      if (first) arrived = performance.now();
      relayout(first || !drawn ? "pour" : "change");
    },
  );

  // A new pick, or a theme's dim level: the squares fade where they stand, with no new layout.
  createEffect(
    () => [props.lit, dim()] as const,
    ([lit, d]) => {
      const l = current;
      if (!renderer || !l) return;
      const start = performance.now();
      scene.relight(
        (r) => {
          const tx = shown[l.order[r] ?? -1];
          return !lit || !tx || lit(tx) ? 1 : d;
        },
        start - scene.epoch,
        document.hidden ? { ...motion(), slow: 0, base: 0, fade: 0 } : motion(),
      );
      marks = lit !== undefined && scene.lit <= scene.live * RARE;
      performance.measure("txgrid relight", { start });
      renderer.upload(scene.data);
      schedule();
    },
    { defer: true },
  );

  onSettled(() => {
    renderer = Renderer.create(canvas);
    if (!renderer) {
      props.onState?.("unsupported");
      return undefined;
    }
    readPaint();
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;
      // The browser's exact device pixels, so nothing is resampled and blurred. Emulated pixel
      // ratios (headless browsers) leave that box in CSS pixels, so it is checked against the ratio.
      const exact = (v: number | undefined, css: number) =>
        v !== undefined && Math.abs(v - css * dpr) < 2 ? v : Math.round(css * dpr);
      const box = entry.devicePixelContentBoxSize?.[0];
      canvas.width = Math.max(1, exact(box?.inlineSize, w));
      canvas.height = Math.max(1, exact(box?.blockSize, h));
      const before = current;
      width = w;
      height = h;
      scale = w > 0 ? canvas.width / w : dpr;
      const size = gridSize(w / h);
      if (!before) relayout(drawn ? "snap" : "pour");
      else if (size.cols !== before.cols || size.rows !== before.rows) relayout("snap");
      else setGeometry((g) => g + 1);
      schedule();
    });
    try {
      resize.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      resize.observe(canvas);
    }
    const repaint = () => {
      readPaint();
      schedule();
    };
    const theme = new MutationObserver(repaint);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const dark = matchMedia("(prefers-color-scheme: dark)");
    dark.addEventListener("change", repaint);
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else {
        // Come back to where things ended, not to an animation that was meant for then.
        scene.finish();
        renderer?.upload(scene.data);
        schedule();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    const onLost = (e: Event) => {
      e.preventDefault();
      setLost(true);
      setActive(undefined);
      cancelAnimationFrame(raf);
      raf = 0;
      props.onState?.("lost");
    };
    const onRestored = () => {
      if (!renderer?.init()) return;
      setLost(false);
      scene.finish();
      renderer.upload(scene.data);
      drawn = false;
      schedule();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      theme.disconnect();
      dark.removeEventListener("change", repaint);
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      renderer = null;
      scene = new Scene(0);
    };
  });

  // ---- Pointing ----

  const txAt = (e: PointerEvent | MouseEvent): GridTx | undefined => {
    const p = placement();
    if (!p || !current) return undefined;
    const box = canvas.getBoundingClientRect();
    const r = hitTest(
      current,
      (e.clientX - box.left - p.x) / p.cell,
      (e.clientY - box.top - p.y) / p.cell,
    );
    return r === -1 ? undefined : shown[current.order[r] ?? -1];
  };
  const byId = (id: number | string | undefined): GridTx | undefined => {
    if (id === undefined || !current) return undefined;
    const r = rankOf().get(id);
    return r === undefined ? undefined : shown[current.order[r] ?? -1];
  };

  let lookup = 0;
  const resolve = (tx: GridTx): Promise<string> => {
    const known = txids().get(tx.id);
    if (known !== undefined) return Promise.resolve(known);
    return props.txid(tx).then((txid) => {
      setTxids((m) => new Map(m).set(tx.id, txid));
      return txid;
    });
  };
  createEffect(active, (id) => {
    clearTimeout(lookup);
    const tx = byId(id);
    // A short rest first, so sweeping across the grid does not ask for every square passed.
    if (tx) lookup = window.setTimeout(() => void resolve(tx).catch(() => undefined), 90);
  });
  onCleanup(() => clearTimeout(lookup));

  const open = (tx: GridTx) => {
    resolve(tx).then(
      (txid) => navigate(onNetwork(network(), paths.tx(txid))),
      () => undefined,
    );
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    setTouch(false);
    setActive(txAt(e)?.id);
  };
  let pointer = "mouse";
  const onDown = (e: PointerEvent) => {
    pointer = e.pointerType;
  };
  const onClick = (e: MouseEvent) => {
    const tx = txAt(e);
    if (!tx) {
      setActive(undefined);
      return;
    }
    if (pointer === "mouse" || active() === tx.id) {
      open(tx);
      return;
    }
    // Touch: the first tap shows what the square is, the second opens it.
    setTouch(true);
    setActive(tx.id);
  };
  onSettled(() => {
    const away = (e: PointerEvent) => {
      if (e.target !== canvas) setActive(undefined);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  });

  // ---- Ring and tooltip ----

  /** A square's box in CSS pixels within the grid. */
  const box = (id: number | string | undefined) => {
    geometry();
    const r = id === undefined ? undefined : rankOf().get(id);
    const p = placement();
    if (r === undefined || !p || !current) return undefined;
    return {
      x: p.x + (current.x[r] ?? 0) * p.cell,
      y: p.y + (current.y[r] ?? 0) * p.cell,
      w: (current.w[r] ?? 0) * p.cell,
      h: (current.h[r] ?? 0) * p.cell,
    };
  };
  const ringed = () => box(active() ?? props.highlight);
  const shownTx = () => byId(active());

  // Above the square where there is room, else below; always inside the frame.
  createEffect(
    () => {
      txids();
      return box(active());
    },
    (b) => {
      if (!b) return;
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const gap = 8;
      const x = Math.min(Math.max(0, b.x + b.w / 2 - w / 2), Math.max(0, width - w));
      const above = b.y - h - gap;
      const y = above >= 0 ? above : Math.min(b.y + b.h + gap, Math.max(0, height - h));
      setTipAt({ x, y });
    },
  );

  return (
    <div class={["txgrid", { "txgrid--lost": lost() }]}>
      <canvas
        ref={canvas}
        class={["txgrid__canvas", { "txgrid__canvas--over": active() !== undefined }]}

        role="img"
        aria-label={props.label}
        data-squares={rankOf().size}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerLeave={() => !touch() && setActive(undefined)}
        onClick={onClick}
      />
      <Show when={ringed()}>
        {(b) => (
          <span
            class="txgrid__ring"
            aria-hidden="true"
            style={{
              "--x": `${b().x}px`,
              "--y": `${b().y}px`,
              "--w": `${b().w}px`,
              "--h": `${b().h}px`,
            }}
          />
        )}
      </Show>
      <div
        ref={tip}
        class={["txgrid__tip", { "txgrid__tip--shown": shownTx() !== undefined }]}

        aria-hidden="true"
        style={{ "--tip-x": `${tipAt().x}px`, "--tip-y": `${tipAt().y}px` }}
      >
        <Show when={shownTx()}>
          {(tx) => (
            <>
              <span class="txgrid__title">
                <Show when={!tx().coinbase} fallback="Coinbase">
                  <FeeRate rate={rateOf(tx())} swatch />
                </Show>
              </span>
              <span class="txgrid__id">
                {truncateMiddle(txids().get(tx().id) ?? "", 8, 8) || MISSING}
              </span>
              <Show when={!tx().coinbase}>
                <span>
                  Fee <span class="num">{formatSats(tx().fee)}</span> sats
                </span>
              </Show>
              <span>
                Size <span class="num">{formatSize(tx().vsize)}</span>
              </span>
              <Show when={tx().value !== undefined}>
                <span>
                  {tx().coinbase ? "Pays " : "Sends "}
                  <Amount sats={tx().value ?? 0} />
                </span>
              </Show>
              <span class="txgrid__hint">{touch() ? "Tap again to open" : "Click to open"}</span>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
