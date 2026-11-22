import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Amount } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { Link } from "../../components/Link";
import { Note } from "../../components/Note";
import { type Layer, Strata, strataLayers, strataMark, strataSide } from "../../components/Strata";
import "../../components/BlockBox.css";
import { ErrorState } from "../../components/States";
import { useNow } from "../../lib/clock";
import type { Block } from "../../lib/esplora";
import {
  EARLY_NOTE,
  formatFeeRate,
  formatInterval,
  formatRelative,
  formatSize,
  formatUtc,
  groupDigits,
  isoTime,
  timedBefore,
} from "../../lib/format";
import type { LiveStatus } from "../../lib/live";
import type { ProjectedBlock } from "../../lib/projected-topic";
import { type Network, paths } from "../../lib/network";
import { STRIP_MAX } from "./feeds";
import {
  createPastBlocks,
  EXTENT_AHEAD,
  inView,
  LOAD_AHEAD,
  laneSlots,
  MAX_DEPTH,
  OVERSCAN,
  type Slot,
  type Want,
} from "./past";
import { LiveIndicator } from "./LiveIndicator";
import { type Motion, motion } from "./motion";
import {
  EMPTY_MODEL,
  type ProjectedView,
  type ProjectionModel,
  projectedView,
  provisionalFor,
  releaseIn,
  sameTiles,
} from "./projection";
import { ProjectedTile, projectedLayers, sameLayers, TILE_LAYER_MIN } from "./ProjectedTile";
import { createSummaries, type TileFacts } from "./summaries";
import { dragScroll } from "../../components/dragScroll";
import { owned } from "../../components/owned";

const MAX_WEIGHT = 4_000_000;
/** Projected tiles on screen, not the ones fading out. */
const PROJECTED = ".home-tile--projected[data-key]:not(.home-tile--leaving)";

/** How full a block is, as tile text: `99.9% full`, `under 1% full`. */
export function fullness(weight: number): string {
  const pct = (Math.min(MAX_WEIGHT, Math.max(0, weight)) / MAX_WEIGHT) * 100;
  if (pct < 1) return "under 1% full";
  return `${Math.round(pct * 10) / 10}% full`;
}

/** A tile's age, short enough for its foot: `just now`, `42 s`, `13 min`, then whole hours and days. */
export function tileAge(time: number, now: number): string {
  const s = now - time;
  if (s < 3600) return formatRelative(time, now, { suffix: false });
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

/**
 * The block strip: projected blocks left of the "now" line, mined blocks right of it. Whenever the
 * tiles change places (a block is mined, a burst, a reorg, the projection catching up) it plays
 * the new-block sequence (docs/DESIGN.md "Motion"): every tile is measured, both lanes are
 * swapped in one go, then each tile glides from where it was (FLIP), and a mined block that was
 * projected crosses the line from its projected tile. A change of figures alone moves nothing.
 */
export function BlockStrip(props: {
  blocks: Accessor<Block[] | undefined>;
  error: Accessor<unknown>;
  retry: () => void;
  status: Accessor<LiveStatus>;
  /** The node is not answering the page's requests, though the socket is up. */
  stale: Accessor<boolean>;
  projection: Accessor<ProjectionModel>;
  network: Network;
}) {
  const now = useNow();
  const [shown, setShown] = createSignal<Block[]>();
  const [view, setView] = createSignal<ProjectedView>(projectedView(EMPTY_MODEL, undefined, 0));
  const [announcement, setAnnouncement] = createSignal("");
  // A held projection is released by time, not by a message: this ticks when it is due.
  const [tick, setTick] = createSignal(0);

  // The mined lane is a window over every block down to block 0 (docs/FRONTEND.md "The block
  // strip's past"): tiles have a fixed pitch, so only those near the view are in the page.
  /** The tiles in view, by index from the tip; undefined until the strip is laid out. */
  const [seen, setSeen] = createSignal<[number, number] | undefined>(undefined, {
    equals: (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1],
  });
  /** The "now" line is out of view: the visitor is looking at the past. */
  const [away, setAway] = createSignal(false);
  /** The deepest height the lane has been laid out to, so it only grows as the visitor goes. */
  const [deepest, setDeepest] = createSignal(Number.POSITIVE_INFINITY);
  /** The focused tile's height: it stays in the page wherever the strip scrolls. */
  const [focused, setFocused] = createSignal<number>();
  // Layout facts, read when the strip is laid out or resized, never per scroll frame.
  let pitch = 0;
  let laneLeft = 0;
  let nowRight = 0;
  let viewWidth = 0;
  const tipHeight = () => shown()?.[0]?.height;
  const floor = () => {
    const tip = tipHeight() ?? 0;
    return Math.max(0, tip + 1 - MAX_DEPTH, Math.min(deepest(), tip - EXTENT_AHEAD));
  };
  const capped = () => floor() > 0 && floor() === (tipHeight() ?? 0) + 1 - MAX_DEPTH;
  const count = () => {
    const tip = tipHeight();
    return tip === undefined ? 0 : tip - floor() + 1;
  };
  const want = createMemo<Want | undefined>(
    () => {
      const s = seen();
      const tip = tipHeight();
      if (!s || tip === undefined) return undefined;
      return {
        top: tip - Math.max(0, s[0] - OVERSCAN),
        bottom: Math.max(floor(), tip - s[1] - LOAD_AHEAD),
        middle: tip - Math.round((s[0] + s[1]) / 2),
        tip,
      };
    },
    {
      equals: (a, b) =>
        a?.top === b?.top &&
        a?.bottom === b?.bottom &&
        a?.middle === b?.middle &&
        a?.tip === b?.tip,
    },
  );
  const past = createPastBlocks(props.network, props.blocks, want, focused);
  const live = createMemo(() => new Map((shown() ?? []).map((b) => [b.height, b])));
  /** The block at a height, from the live list or the pages loaded below it. */
  const blockAt = (h: number) =>
    live().get(h) ?? (h < (shown()?.at(-1)?.height ?? 0) ? past.block(h) : undefined);
  const slots = createMemo<Slot[]>(() => {
    const list = shown();
    const tip = list?.[0]?.height;
    if (!list || tip === undefined) return [];
    const s = seen();
    const n = count();
    return laneSlots({
      tip,
      // Before layout, the live list's tiles; after, the view and a few beyond each edge.
      from: s ? s[0] - OVERSCAN : 0,
      to: s ? s[1] + OVERSCAN : STRIP_MAX - 1,
      count: n,
      capped: capped(),
      // The newest stays too, so "back to now" always has a tile to give focus to; and a focused
      // tile's neighbours, so Tab finds the next one however fast it is pressed.
      pinned: [tip, ...near(focused())],
      block: blockAt,
      failure: (h) => past.failure(h),
    });
  });
  // The lane is one Tab stop, so the page past it stays a Tab away: the focused tile, else the
  // first in view, else the newest. Arrow keys walk from it (onKey).
  const tabStop = createMemo(() => {
    const f = focused();
    if (f !== undefined) return f;
    const s = seen();
    const tip = tipHeight();
    const first = s && tip !== undefined ? tip - s[0] : undefined;
    return first !== undefined &&
      slots().some((x) => x.kind === "block" && x.block.height === first)
      ? first
      : tip;
  });
  /** Older blocks in the page, for their fee facts. */
  const older = createMemo<Block[]>(
    () => {
      const lowest = shown()?.at(-1)?.height ?? 0;
      return slots().flatMap((s) =>
        s.kind === "block" && s.block.height < lowest ? [s.block] : [],
      );
    },
    { equals: (a, b) => sameIds(a, b) },
  );
  const facts = createSummaries(props.network, props.blocks, older);
  /** Blocks crossing the line: what each was projected to be, until it lands. */
  const crossings = new Map<string, Crossing>();
  /** Lands each crossing still in the air; the sequence calls one as its tile touches down. */
  const landers = new Map<string, () => void>();
  const landAll = () => {
    for (const land of landers.values()) land();
    landers.clear();
  };
  /** Whether projected tiles drawn now settle their layers in by themselves (see `sequence`). */
  let settleNew = false;
  let scroller: HTMLDivElement | undefined;
  /** Ends a mouse flick's glide, so it cannot carry on over a scroll from here. */
  let stopGlide: (() => void) | undefined;
  let lane: HTMLOListElement | undefined;
  let upcoming: HTMLDivElement | undefined;
  let next: HTMLDivElement | undefined;
  let flash: HTMLSpanElement | undefined;
  let nowLine: HTMLDivElement | undefined;
  let minedBox: HTMLDivElement | undefined;
  const running = new Set<Animation>();
  const ghosts = new Set<Element>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const play = (el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    const a = el.animate(keyframes, options);
    running.add(a);
    void a.finished.then(
      () => running.delete(a),
      () => running.delete(a),
    );
    return a;
  };
  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      f();
    }, ms);
    timers.add(t);
  };

  /** Ends the sequence in progress where it stands, so a new one starts from what is on screen. */
  const interrupt = () => {
    // Whatever was in the air lands where the next sequence starts it from: settled.
    landAll();
    for (const a of running) a.cancel();
    running.clear();
    for (const g of ghosts) g.remove();
    ghosts.clear();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const el of lane?.querySelectorAll<HTMLElement>(".home-tile--landing") ?? []) {
      el.classList.remove("home-tile--landing", "home-tile--crossing");
    }
  };

  const target = createMemo(() => {
    tick();
    const blocks = props.blocks();
    return { blocks, view: projectedView(props.projection(), blocks, Date.now()) };
  });
  createEffect(
    () => releaseIn(props.projection(), props.blocks(), Date.now()),
    (wait) => {
      if (wait === undefined) return undefined;
      const t = setTimeout(() => setTick((n) => n + 1), wait + 50);
      return () => clearTimeout(t);
    },
  );

  createEffect(target, ({ blocks: list, view: nextView }) => {
    const before = shown();
    const beforeView = view();
    const minedSame = sameIds(before, list);
    // The same tiles in the same places: the figures change where they stand.
    if (minedSame && sameTiles(beforeView, nextView)) {
      setView(nextView);
      return;
    }
    const tip = list?.[0];
    const oldTip = before?.[0]?.height ?? Number.POSITIVE_INFINITY;
    if (before && list && tip && tip.height > oldTip) {
      const txs = `${groupDigits(tip.tx_count)} ${tip.tx_count === 1 ? "transaction" : "transactions"}`;
      setAnnouncement(`Block ${groupDigits(tip.height)} mined: ${txs}.`);
    }
    // What the new blocks were projected to be, shown until each lands.
    const fresh: [string, ProjectedBlock][] = [];
    if (before && list && !document.hidden) {
      const model = props.projection();
      for (const b of list) {
        if (b.height <= oldTip) break;
        const p = provisionalFor(model, list, b);
        if (p) fresh.push([b.id, p]);
      }
    }
    const fly = () => {
      for (const [id, guess] of fresh) {
        const [landed, setLanded] = createSignal(false);
        crossings.set(id, { guess, landed });
        landers.set(id, () => setLanded(true));
      }
    };
    const show = () => {
      setShown(list);
      setView(nextView);
    };
    // Looking at the past: nothing plays, and what is in view stays where it is.
    const shift = (list?.[0]?.height ?? 0) - (before?.[0]?.height ?? 0);
    if (away() && list?.[0] && before?.[0]) {
      interrupt();
      settleNew = false;
      show();
      if (shift !== 0) {
        setSeen((s) => s && [s[0] + shift, s[1] + shift]);
        // After the lane has its new width, before the browser paints.
        queueMicrotask(() => {
          if (scroller) scroller.scrollLeft += shift * pitch;
        });
      }
      return;
    }
    // Nothing to animate from, or nobody to see it: just show the new state.
    if (!list || !before || !lane || !upcoming || document.hidden || !("animate" in lane)) {
      interrupt();
      settleNew = !document.hidden;
      show();
      return;
    }
    // First: where everything is now, mid-animation included.
    const first = new Map<string, DOMRect>();
    const tiles = [...lane.children, ...upcoming.querySelectorAll(PROJECTED)].filter(
      (el) => !el.classList.contains("home-tile--leaving"),
    );
    for (const el of tiles as HTMLElement[]) {
      const id = el.dataset["id"] ?? (el.dataset["key"] ? `p${el.dataset["key"]}` : undefined);
      if (id) first.set(id, el.getBoundingClientRect());
    }
    // Where a crossing block leaves from when it had no tile of its own: the next block's place.
    const from = (
      upcoming.querySelector(".home-tile--projected") ?? upcoming
    ).getBoundingClientRect();
    const keep = new Set([
      ...list.map((b) => b.id),
      ...nextView.tiles.map((t) => `p${t.key}`),
      // A projected tile that becomes a mined block leaves as that block, not as a ghost.
      ...list.map((b) => `p${b.height}`),
    ]);
    // A mined tile leaves only when its block left the live list's heights (a reorg); an older
    // one stays in the past, or leaves the window out of sight.
    const lowest = list.at(-1)?.height ?? 0;
    const out = (tiles as HTMLElement[])
      .filter((el) => {
        const id = el.dataset["id"];
        if (id !== undefined) return !keep.has(id) && Number(el.dataset["height"]) >= lowest;
        const key = el.dataset["key"];
        return key !== undefined && !keep.has(`p${key}`);
      })
      .map((el) => {
        const parent = el.parentElement;
        const g = el.cloneNode(true) as HTMLElement;
        const r = el.getBoundingClientRect();
        const box = parent?.getBoundingClientRect();
        return { g, parent, left: box ? r.left - box.left : 0 };
      });
    interrupt();
    fly();
    // A tile that forms behind a crossing block settles in time with the crossing, below.
    const crossingNow = !!tip && tip.height > oldTip;
    settleNew = !crossingNow;
    show();
    // Solid has updated the DOM by the time this runs, and the browser has not painted yet.
    queueMicrotask(() => sequence(first, from, out, oldTip));
  });

  function sequence(
    first: Map<string, DOMRect>,
    from: DOMRect,
    out: { g: HTMLElement; parent: HTMLElement | null; left: number }[],
    oldTip: number,
  ) {
    if (!lane || !upcoming) {
      landAll();
      return;
    }
    const m: Motion = motion();
    const mined = [...lane.querySelectorAll<HTMLElement>(":scope > li[data-id]")];
    const projected = [...upcoming.querySelectorAll<HTMLElement>(PROJECTED)];
    const idOf = (el: HTMLElement) => el.dataset["id"] ?? `p${el.dataset["key"] ?? ""}`;
    const arriving = mined.filter((el) => !first.has(idOf(el)));
    const crossing = arriving.filter((el) => Number(el.dataset["height"]) > oldTip);
    const glide = (el: HTMLElement, order: number) => {
      const was = first.get(idOf(el));
      if (!was || m.reduced) return;
      const dx = was.left - el.getBoundingClientRect().left;
      if (Math.abs(dx) < 1) return;
      play(el, [{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
        duration: m.slow,
        easing: m.easeOut,
        delay: order * m.stagger,
        fill: "backwards",
      });
    };

    // Leaders move first: mined tiles from the farthest, projected tiles from the nearest. Past the
    // live list's ten, out of sight, they all lead together.
    const lead = Math.min(mined.length, STRIP_MAX) - 1;
    mined.forEach((el, i) => glide(el, Math.max(0, lead - i)));
    projected.forEach((el, i) => glide(el, 2 + i));

    // Tiles that leave fade where they stood.
    for (const { g, parent, left } of out) {
      if (!parent) continue;
      g.classList.add("home-tile--leaving");
      g.setAttribute("aria-hidden", "true");
      g.inert = true;
      g.style.setProperty("left", `${left}px`);
      parent.append(g);
      ghosts.add(g);
      const a = play(
        g,
        [{ opacity: 1 }, { opacity: 0, transform: m.reduced ? "none" : "translateX(24px)" }],
        { duration: m.slow || m.fade, easing: "ease-out", fill: "forwards" },
      );
      void a.finished.then(
        () => {
          g.remove();
          ghosts.delete(g);
        },
        () => {
          // Cancelled: whoever cancelled it cleans up.
        },
      );
    }

    // New projected tiles form at the far end once the crossing is under way, their layers
    // dropping in one at a time, cheapest first, like sediment.
    for (const el of projected) {
      if (first.has(idOf(el))) continue;
      if (crossing.length > 0 && !m.reduced) {
        const layers = el.querySelectorAll(".strata__layer");
        // The box's right face and its fill mark show them as the last one drops (BlockBox.css,
        // HomePage.css).
        const core = el.querySelector(".block-box__core");
        if (core)
          for (const pseudoElement of ["::after", "::before"])
            // Offset 0: a lone keyframe is otherwise the end, not the start.
            play(core, [{ opacity: 0, offset: 0 }], {
              pseudoElement,
              duration: m.slow,
              easing: m.easeOut,
              delay: m.block * 0.4 + Math.max(0, layers.length - 1) * m.stagger,
              fill: "backwards",
            });
        layers.forEach((layer, i) =>
          play(
            layer,
            [
              { opacity: 0, transform: "translateY(-18px)" },
              { opacity: 1, transform: "none" },
            ],
            {
              duration: m.slow,
              easing: m.easeSettle,
              delay: m.block * 0.4 + i * m.stagger,
              fill: "backwards",
            },
          ),
        );
      }
      play(
        el,
        [
          { opacity: 0, transform: m.reduced ? "none" : "translateX(-28px)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: m.slow || m.fade,
          easing: m.easeOut,
          delay: crossing.length > 0 ? m.block * 0.35 : 0,
          fill: "backwards",
        },
      );
    }

    // New blocks below the old tip (a reorg's replacements, or older ones filling in) fade in.
    for (const el of arriving) {
      if (crossing.includes(el)) continue;
      play(el, [{ opacity: 0 }, { opacity: 1 }], {
        duration: m.slow || m.fade,
        easing: "ease-out",
        fill: "backwards",
      });
    }
    if (crossing.length === 0) {
      landAll();
      return;
    }

    // Each new block crosses the line from its projected tile on a shallow arc and lands with a
    // small squash. Several at once leave one after another, the one going farthest first.
    crossing.forEach((el, k) => {
      const delay = (crossing.length - 1 - k) * m.stagger * 3;
      const id = el.dataset["id"] ?? "";
      const land = () => {
        landers.get(id)?.();
        landers.delete(id);
      };
      el.classList.add("home-tile--landing");
      if (m.reduced) {
        play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: m.fade, delay, fill: "backwards" });
        later(delay + m.fade, land);
        // Nothing travels, but the accent still marks the new block for about as long.
        later(delay + m.fade * 6, () => el.classList.remove("home-tile--landing"));
        return;
      }
      // Provisional while it travels; it sets, solid, at the top of its arc.
      el.classList.add("home-tile--crossing");
      later(delay + m.block * 0.45, () => el.classList.remove("home-tile--crossing"));
      const start = first.get(`p${el.dataset["height"] ?? ""}`) ?? from;
      const dx = start.left - el.getBoundingClientRect().left;
      const arc = play(
        el,
        [
          { transform: `translateX(${dx}px)` },
          { transform: `translate(${dx * 0.45}px, -14px) scale(1.05)`, offset: 0.45 },
          { transform: "none" },
        ],
        { duration: m.block, easing: m.easeInOut, delay, fill: "backwards" },
      );
      const body = el.querySelector(".home-tile__body");
      if (body) {
        play(
          body,
          [
            { transform: "scaleY(1)" },
            { transform: "scaleY(1)", offset: 0.82 },
            { transform: "scaleY(0.94)", offset: 0.9 },
            { transform: "scaleY(1)" },
          ],
          { duration: m.block, easing: m.easeSettle, delay },
        );
      }
      // Its projected figures and layers give way to its own as it touches down.
      later(delay + m.block * 0.82, land);
      void arc.finished.then(
        () => el.classList.remove("home-tile--landing"),
        () => {
          // Cancelled: whoever cancelled it cleans up.
        },
      );
    });

    // The line flashes, and the placeholder for the next block, if that is what shows, re-forms.
    if (flash)
      play(flash, [{ opacity: 0 }, { opacity: 0.85, offset: 0.2 }, { opacity: 0 }], {
        duration: m.block || m.fade * 3,
      });
    if (next?.isConnected) {
      play(
        next,
        [
          { opacity: 0, transform: m.reduced ? "none" : "translateX(-28px)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: m.slow || m.fade,
          easing: m.easeOut,
          delay: m.block * 0.35,
          fill: "backwards",
        },
      );
    }
  }

  // The strip starts with the "now" line in the middle.
  const nowAt = () => (nowLine ? nowLine.offsetLeft - viewWidth / 2 + nowLine.offsetWidth / 2 : 0);
  /** Reads the layout facts the window is computed from. */
  const layout = () => {
    if (!scroller || !lane || !minedBox || !nowLine) return;
    const tile = lane.querySelector<HTMLElement>(":scope > .home-tile:not(.home-tile--leaving)");
    const gap = Number.parseFloat(getComputedStyle(lane).columnGap) || 0;
    pitch = tile ? Number.parseFloat(getComputedStyle(tile).width) + gap : 0;
    laneLeft = minedBox.offsetLeft;
    nowRight = nowLine.offsetLeft + nowLine.offsetWidth;
    viewWidth = scroller.clientWidth;
  };
  /** Which tiles are in view, from the scroll position alone. */
  const measure = () => {
    frame = 0;
    if (!scroller) return;
    const x = scroller.scrollLeft;
    const s = inView(x, viewWidth, laneLeft, pitch);
    setSeen(s);
    setAway(s !== undefined && x > nowRight);
    const tip = untrack(tipHeight);
    if (s && tip !== undefined) setDeepest((d) => Math.min(d, tip - s[1] - EXTENT_AHEAD));
  };
  let frame = 0;
  const onScroll = () => {
    frame ||= requestAnimationFrame(measure);
  };
  /** Back to the "now" line: glides when it is near and motion is welcome, else jumps. */
  const toNow = (focus: boolean) => {
    if (!scroller) return;
    stopGlide?.();
    const left = nowAt();
    const near = Math.abs(scroller.scrollLeft - left) < 3 * viewWidth;
    scroller.scrollTo({ left, behavior: near && !motion().reduced ? "smooth" : "instant" });
    // The newest tile is always in the page, so focus has somewhere to land.
    if (focus) {
      lane
        ?.querySelector<HTMLElement>(`:scope > li[data-height="${tipHeight() ?? ""}"] a`)
        ?.focus({ preventScroll: true });
    }
  };
  // A focused tile is kept in the page (`pinned`), so scrolling away never drops focus.
  const onFocusIn = (e: FocusEvent) => {
    const li = (e.target as Element).closest<HTMLElement>(".home-strip__lane > li[data-height]");
    setFocused(li ? Number(li.dataset["height"]) : undefined);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (!lane?.contains(e.relatedTarget as Node | null)) setFocused(undefined);
  };
  // Right and Left walk to the next older and newer tile, the strip following; Home goes back to
  // now, to the newest block, from however far in the past.
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const li = (e.target as Element).closest<HTMLElement>(".home-strip__lane > li[data-height]");
    if (!li) return;
    if (e.key === "Home") {
      e.preventDefault();
      toNow(true);
      return;
    }
    const step = e.key === "ArrowRight" ? -1 : e.key === "ArrowLeft" ? 1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const to = Number(li.dataset["height"]) + step;
    lane?.querySelector<HTMLElement>(`:scope > li[data-height="${to}"] a`)?.focus();
  };
  onSettled(() => {
    layout();
    if (scroller) scroller.scrollLeft = nowAt();
    measure();
    let width = viewWidth;
    // Handled in the next frame, so what it changes cannot loop back into the observer.
    let resized = 0;
    const ro = new ResizeObserver(() => {
      resized ||= requestAnimationFrame(() => {
        resized = 0;
        layout();
        // A resize keeps the visitor's place in the past; at "now" it centres the line again.
        if (scroller && viewWidth !== width && !untrack(away)) scroller.scrollLeft = nowAt();
        width = viewWidth;
        measure();
      });
    });
    if (scroller) {
      ro.observe(scroller);
      scroller.addEventListener("scroll", onScroll, { passive: true });
      scroller.addEventListener("focusin", onFocusIn);
      scroller.addEventListener("focusout", onFocusOut);
      scroller.addEventListener("keydown", onKey);
    }
    return () => {
      ro.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
      scroller?.removeEventListener("focusin", onFocusIn);
      scroller?.removeEventListener("focusout", onFocusOut);
      scroller?.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resized);
    };
  });
  onCleanup(interrupt);

  const sinceTip = () => {
    const tip = shown()?.[0];
    return tip ? formatRelative(tip.timestamp, now(), { suffix: false }) : undefined;
  };
  const keys = createMemo(() => view().tiles.map((t) => t.key));
  /** A crossing is for the tile drawn for it, once: a refetch redraws it settled. */
  const take = (id: string) => {
    const c = crossings.get(id);
    crossings.delete(id);
    return c;
  };
  const tileAt = (key: number) => () => view().tiles.find((t) => t.key === key);
  const note = () => {
    const v = view();
    if (v.mode === "off") return "This server does not track the mempool on this network.";
    if (v.stale) return "The last projection before the server lost touch with its node.";
    const [first, second] = v.tiles;
    if (!first) return "";
    if (first.txs === 0) return "Nothing is waiting. The next block would hold only its coinbase.";
    return second ? "" : "Everything waiting fits in the next block.";
  };

  return (
    <section class="home-strip" aria-labelledby="strip-title">
      <div class="home-strip__head wrap">
        <h1 id="strip-title" class="home-strip__title">
          Blocks
        </h1>
        <p class="home-strip__legend">
          <span class="home-strip__key">
            {view().mode === "off" ? "Next block" : "Projected from the mempool"}
          </span>
          <span class="home-strip__key home-strip__key--mined">Mined</span>
        </p>
        <Show when={away()}>
          <button
            type="button"
            class="btn home-strip__back"
            aria-label="Back to now"
            // A keypress (no pointer, detail 0) moves focus on to the newest block.
            onClick={(e) => toNow(e.detail === 0)}
          >
            <span aria-hidden="true">←</span> Now
          </button>
        </Show>
        <LiveIndicator status={props.status} stale={props.stale} />
      </div>
      <div
        class="home-strip__scroller"
        ref={owned((el) => {
          scroller = el;
          stopGlide = dragScroll(el);
        })}
      >
        <div class="home-strip__track">
          <div class="home-strip__upcoming" ref={upcoming}>
            <p class="home-strip__pending">{note()}</p>
            <Show
              when={keys().length > 0}
              fallback={
                <div class="home-tile home-tile--projected" ref={next}>
                  <div class="home-tile__body block-box">
                    <span class="home-tile__title">Next block</span>
                    <span class="home-tile__waiting">
                      <span class="home-tile__since num">{sinceTip() ?? ""}</span>
                      <span class="home-tile__since-label">
                        {sinceTip() ? "since last block" : ""}
                      </span>
                    </span>
                  </div>
                  <span class="home-tile__pool" />
                </div>
              }
            >
              <ol class="home-strip__projected" aria-label="Projected blocks, next first">
                <For each={keys()}>
                  {(key) => (
                    <ProjectedTile tile={tileAt(key)} network={props.network} settle={settleNew} />
                  )}
                </For>
              </ol>
            </Show>
          </div>
          <div class="home-strip__now" ref={nowLine} aria-hidden="true">
            <span class="home-strip__flash" ref={flash} />
            <span class="home-strip__now-label">now</span>
          </div>
          <div class="home-strip__mined" ref={minedBox}>
            <Show
              when={shown() ?? props.error() === undefined}
              fallback={
                <div class="home-strip__error">
                  <ErrorState
                    title="Could not load the latest blocks"
                    error={props.error()}
                    retry={props.retry}
                  />
                </div>
              }
            >
              <ol
                class="home-strip__lane"
                ref={lane}
                aria-label="Mined blocks, newest first"
                aria-busy={shown() ? "false" : "true"}
                style={{ "--slots": String(shown() ? count() + (capped() ? 1 : 0) : STRIP_MAX) }}
              >
                <Show
                  when={shown()}
                  fallback={
                    <For each={Array.from({ length: STRIP_MAX })}>{() => <SkeletonTile />}</For>
                  }
                >
                  <For each={slots()} keyed={(s) => s.key}>
                    {(slot) => {
                      const s = untrack(slot);
                      const skip = () => slot().skip;
                      if (s.kind === "block") {
                        return (
                          <MinedTile
                            block={s.block}
                            parent={blockAt(s.block.height - 1)}
                            now={now}
                            facts={facts(s.block.id)}
                            crossing={take(s.block.id)}
                            skip={skip()}
                            place={slot().index + 1}
                            of={(tipHeight() ?? 0) + 1}
                            stop={s.block.height === tabStop()}
                          />
                        );
                      }
                      if (s.kind === "wait") return <SkeletonTile skip={skip()} />;
                      if (s.kind === "end") {
                        return (
                          <li class="home-strip__end" style={{ "--skip": String(skip()) }}>
                            Older blocks are on the{" "}
                            <Link href={paths.blocks(Math.max(0, floor() - 1))}>Blocks page</Link>.
                          </li>
                        );
                      }
                      const failed = () => slot() as Extract<Slot, { kind: "failed" }>;
                      return (
                        <li
                          class="home-strip__gap"
                          style={{ "--skip": String(skip()), "--span": String(failed().span) }}
                        >
                          <div class="home-strip__gap-note">
                            <ErrorState
                              title={`Blocks ${groupDigits(failed().top)} to ${groupDigits(failed().bottom)} could not be loaded`}
                              error={failed().error}
                              retry={past.retry}
                            />
                          </div>
                        </li>
                      );
                    }}
                  </For>
                </Show>
              </ol>
            </Show>
          </div>
        </div>
      </div>
      <p class="visually-hidden" aria-live="polite">
        {announcement()}
      </p>
    </section>
  );
}

function sameIds(a: readonly Block[] | undefined, b: readonly Block[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((x, i) => x.id === b[i]?.id);
}

const near = (h: number | undefined) => (h === undefined ? [] : [h + 1, h, h - 1]);

/** A tile's two fee lines as words, for its label: median, then range. */
export function tileFeeText(facts: TileFacts): string | undefined {
  if (typeof facts !== "object") return undefined;
  const r = facts.fee_rate;
  if (!r) return "only the coinbase, no fees";
  return `median fee ${formatFeeRate(r.median)} sat/vB, fee range ${formatFeeRate(r.min)} to ${formatFeeRate(r.max)} sat/vB`;
}

/** A block crossing the line: what it was projected to be, and whether it has landed. */
interface Crossing {
  guess: ProjectedBlock;
  landed: Accessor<boolean>;
}

function MinedTile(props: {
  block: Block;
  /** The block before it, when the strip has it: a time before its parent's says so. */
  parent: Block | undefined;
  now: Accessor<number>;
  facts: TileFacts;
  /** When it is crossing the line: what it was projected to be, and whether it has landed. */
  crossing: Crossing | undefined;
  /** Empty slots before it in the lane. */
  skip: number;
  /** Its place among all the mined blocks, newest first, and how many there are. */
  place: number;
  of: number;
  /** The lane's one Tab stop: arrow keys move from it to the others. */
  stop: boolean;
}) {
  const b = () => props.block;
  const full = () => Math.min(1, Math.max(0, b().weight / MAX_WEIGHT));
  const crossing = untrack(() => props.crossing);
  const projected = crossing?.guess;
  const guess = projected ? projectedLayers(projected) : undefined;
  // A block crossing the line shows what it was projected to be until it lands, however soon its
  // own facts arrive; then its layers grow out of the projected ones.
  const facts = () => (!crossing || crossing.landed() ? props.facts : undefined);
  const summary = () => {
    const f = facts();
    return typeof f === "object" ? f : undefined;
  };
  /** Still showing what it was projected to be. */
  const guessing = () => !!projected && facts() === undefined;
  // Facts that arrive after the tile is drawn settle in, or grow out of the projected layers;
  // facts it was drawn with are simply there.
  const settle = untrack(() => props.facts === undefined) && !guess;
  const rates = () => summary()?.fee_rate ?? undefined;
  // Any summary arriving re-reads every tile's facts; unchanged layers keep their elements, so a
  // tile that settled in once does not settle again.
  const layers = createMemo<Layer[]>(
    () => {
      const s = summary();
      return s ? strataLayers(s.fee_bands, full(), TILE_LAYER_MIN) : [];
    },
    { equals: sameLayers },
  );
  /** The layers it shows: its own, or what it was projected to be. */
  const shown = () => (layers().length > 0 ? layers() : guessing() ? (guess ?? []) : []);
  /** The layers on the box's right face, or how full it is. */
  const side = () => strataSide(shown(), full());
  const miner = () => summary()?.miner?.name;
  /** Seconds from its parent's time to its own, when it is timed before its parent. */
  const early = () => {
    const p = props.parent;
    if (p?.id !== b().previousblockhash) return undefined;
    const d = b().timestamp - p.timestamp;
    return d < 0 ? { seconds: d, parent: p.height } : undefined;
  };
  const label = () =>
    [
      `Block ${groupDigits(b().height)}`,
      miner() && `mined by ${miner()}`,
      formatRelative(b().timestamp, props.now()),
      early() && `timed ${formatInterval(-(early()?.seconds ?? 0))} before the block it follows`,
      `${groupDigits(b().tx_count)} ${b().tx_count === 1 ? "transaction" : "transactions"}`,
      tileFeeText(facts()),
      fullness(b().weight),
    ]
      .filter(Boolean)
      .join(", ");
  return (
    <li
      class={["home-tile home-tile--mined", { "home-tile--guessing": guessing() }]}
      style={{ "--skip": String(props.skip) }}
      aria-posinset={props.place}
      aria-setsize={props.of}

      data-id={b().id}
      data-height={b().height}
    >
      <Link
        class="home-tile__body block-box"
        href={paths.block(b().id)}
        aria-label={label()}
        tabindex={props.stop ? 0 : -1}
      >
        {/* First, so the figures paint over the layers it fills the box with. */}
        <span
          class="home-tile__strata block-box__core"
          style={{ "--core-side": side(), ...strataMark(shown(), full()) }}
          aria-hidden="true"
        >
          {/* The neutral gauge: how full the block is, until its layers arrive and settle over it. */}
          <Show when={(layers().length === 0 && !guessing()) || settle}>
            <span
              class={["home-tile__fill", { "home-tile__fill--gone": layers().length > 0 }]}

              style={{ "--fill": String(full()) }}
            />
          </Show>
          <span class="home-tile__tint">
            {/* What it was projected to be, fading as the real layers grow out of it. */}
            <Show when={guess}>
              {(g) => (
                <span
                  class={[
                    "home-tile__layers home-tile__guess",
                    { "home-tile__guess--gone": !guessing() },
                  ]}
                >
                  <Strata layers={g()} />
                </span>
              )}
            </Show>
            <Show when={layers().length > 0}>
              <span class="home-tile__layers">
                <Strata layers={layers()} settle={settle} from={guess} />
              </span>
            </Show>
          </span>
        </span>
        <span class="home-tile__title num">{groupDigits(b().height)}</span>
        <span class="home-tile__fee num">
          <Switch fallback={<span class="home-tile__bone home-tile__bone--line" />}>
            <Match when={rates()}>{(r) => <FeeRate rate={r().median} />}</Match>
            <Match when={guessing() && projected}>
              {(p) => <FeeRate rate={p().medianRate} approx />}
            </Match>
            <Match when={summary()}>No fees</Match>
            <Match when={facts() === "failed"}>{formatSize(b().size, "B")}</Match>
          </Switch>
        </span>
        <span class="home-tile__range num">
          <Switch
            fallback={<span class="home-tile__bone home-tile__bone--line home-tile__bone--short" />}
          >
            <Match when={rates()}>
              {(r) => <>{`${formatFeeRate(r().min)} – ${formatFeeRate(r().max)}`}</>}
            </Match>
            <Match when={guessing() && projected}>
              {(p) => <>{`${formatFeeRate(p().minRate)} – ${formatFeeRate(p().maxRate)}`}</>}
            </Match>
            <Match when={summary()}>Coinbase only</Match>
            <Match when={facts() === "failed"}>{fullness(b().weight)}</Match>
          </Switch>
        </span>
        <span class="home-tile__fees">
          <Switch>
            <Match when={summary()}>{(f) => <Amount sats={f().fees} short />}</Match>
            <Match when={guessing() && projected}>
              {(p) => <Amount sats={p().fees} short approx />}
            </Match>
          </Switch>
        </span>
        <span class="home-tile__foot">
          <span class="num">
            {guessing() && projected
              ? `~${groupDigits(projected.txs)} tx`
              : `${groupDigits(b().tx_count)} tx`}
          </span>
          <Show
            when={early()}
            fallback={
              <time class="num" datetime={isoTime(b().timestamp)} title={formatUtc(b().timestamp)}>
                {tileAge(b().timestamp, props.now())}
              </time>
            }
          >
            {(e) => (
              // Below the tile, so the tile it explains stays in sight.
              <Note
                below
                title={timedBefore(e().seconds, e().parent)}
                figure={
                  <time class="num" datetime={isoTime(b().timestamp)}>
                    {tileAge(b().timestamp, props.now())}
                  </time>
                }
              >
                {EARLY_NOTE}
              </Note>
            )}
          </Show>
        </span>
      </Link>
      {/* Its line is always there, so the name lands without moving anything; the link says it. */}
      <span class="home-tile__pool" aria-hidden="true" title={miner()}>
        {miner()}
      </span>
    </li>
  );
}

function SkeletonTile(props: { skip?: number }) {
  return (
    <li
      class="home-tile home-tile--skeleton"
      aria-hidden="true"
      style={{ "--skip": String(props.skip ?? 0) }}
    >
      <span class="home-tile__body block-box">
        <span class="home-tile__bone home-tile__bone--title" />
        <span class="home-tile__bone" />
        <span class="home-tile__bone home-tile__bone--short" />
      </span>
      <span class="home-tile__pool" />
    </li>
  );
}
