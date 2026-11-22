// The strip's past: older blocks loaded a page at a time as the visitor scrolls right, and the
// window of tiles kept in the page (docs/FRONTEND.md "The block strip's past").
import { type Accessor, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { ApiError, fetchStamped, isBusy, type Stamped } from "../../lib/api";
import { isBlock } from "../../lib/blocks-topic";
import type { Block } from "../../lib/esplora";
import type { Network } from "../../lib/network";

/** Blocks in one page of the past: what `/api/v1/blocks/:start_height` answers with. */
export const PAGE = 15;
/** Tiles kept in the page beyond each edge of the view, so a fling or a Tab never meets a gap. */
export const OVERSCAN = 6;
/** Blocks loaded beyond the far edge of the view, so the next ones are there before they are seen. */
export const LOAD_AHEAD = 2 * PAGE;
/** Blocks kept in memory beyond each edge of the view; farther ones are let go. */
export const KEEP = 6 * PAGE;
/** Slots laid out past the deepest one seen, so the scroller never shows an end it does not have. */
export const EXTENT_AHEAD = 200;
// Browsers cap an element's width near 17.9 million px (Firefox); at the largest tile pitch a
// reader's text size gives, this many slots stay well under it.
/** The deepest the strip goes; older blocks are on the Blocks page. */
export const MAX_DEPTH = 50_000;

/** The tiles in view, by index from the tip (0): first and last, or undefined before layout. */
export function inView(
  scrollLeft: number,
  viewWidth: number,
  laneLeft: number,
  pitch: number,
): [number, number] | undefined {
  if (!(pitch > 0) || !(viewWidth > 0)) return undefined;
  const first = Math.max(0, Math.floor((scrollLeft - laneLeft) / pitch));
  const last = Math.max(first, Math.floor((scrollLeft + viewWidth - laneLeft) / pitch));
  return [first, last];
}

/** One item of the mined lane, `skip` empty slots after the item before it. */
export type Slot =
  | { kind: "block"; key: string; index: number; skip: number; block: Block }
  | { kind: "wait"; key: string; index: number; skip: number }
  | {
      kind: "failed";
      key: string;
      index: number;
      skip: number;
      /** Slots it covers, newest first from `index`. */
      span: number;
      top: number;
      bottom: number;
      error: unknown;
    }
  | { kind: "end"; key: string; index: number; skip: number };

/**
 * The lane's items for indices `from` to `to` (inclusive) under `tip`, and the pinned height (a
 * focused tile) wherever it is. A failed page's slots in the range are one item.
 */
export function laneSlots(o: {
  tip: number;
  from: number;
  to: number;
  /** Slots laid out: the lane ends after index `count - 1`. */
  count: number;
  /** Whether the lane stops at {@link MAX_DEPTH} rather than at block 0. */
  capped: boolean;
  /** Heights kept in the page wherever they are: the newest, and a focused tile. */
  pinned: readonly (number | undefined)[];
  block: (height: number) => Block | undefined;
  failure: (height: number) => unknown;
}): Slot[] {
  const out: Slot[] = [];
  let end = -1;
  const push = (s: Slot) => {
    out.push(s);
    end = s.index + (s.kind === "failed" ? s.span : 1) - 1;
  };
  const indices = new Set<number>();
  for (let i = Math.max(0, o.from); i <= Math.min(o.to, o.count - 1); i++) indices.add(i);
  for (const h of o.pinned) {
    if (h !== undefined && o.block(h) && o.tip - h < o.count) indices.add(o.tip - h);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array; toSorted is newer than the browsers we build for
  for (const i of [...indices].sort((a, b) => a - b)) {
    if (i <= end) continue;
    const height = o.tip - i;
    const skip = i - end - 1;
    const b = o.block(height);
    if (b) {
      push({ kind: "block", key: `b${b.id}`, index: i, skip, block: b });
      continue;
    }
    const error = o.failure(height);
    if (error === undefined) {
      push({ kind: "wait", key: `w${height}`, index: i, skip });
      continue;
    }
    // The failed page's slots from here down, within the range.
    const page = Math.floor(height / PAGE);
    let bottom = height;
    while (
      bottom - 1 >= page * PAGE &&
      o.tip - (bottom - 1) <= Math.min(o.to, o.count - 1) &&
      !o.block(bottom - 1)
    ) {
      bottom--;
    }
    push({
      kind: "failed",
      key: `f${page}`,
      index: i,
      skip,
      span: height - bottom + 1,
      top: height,
      bottom,
      error,
    });
  }
  if (o.capped && o.to >= o.count - 1)
    push({ kind: "end", key: "end", index: o.count, skip: o.count - end - 1 });
  return out;
}

/** The heights to load, from `top` down to `bottom`, the view's middle at `middle`, under `tip`. */
export interface Want {
  top: number;
  bottom: number;
  middle: number;
  tip: number;
}

/** A page to ask for: its top (or the tip), and its highest block not here. */
export interface PageAsk {
  top: number;
  missing: number;
}

/**
 * The next page to ask for, or undefined when everything wanted is here: the page nearest the
 * middle of the view that misses a wanted block. Pages are fixed ranges of {@link PAGE} heights
 * asked for from their top, so one request serves every visitor and is cached for all of them.
 */
export function nextPage(
  want: Want,
  has: (height: number) => boolean,
  failed: (page: number) => boolean,
): PageAsk | undefined {
  let best: (PageAsk & { distance: number }) | undefined;
  const bottom = Math.max(0, want.bottom);
  const top = Math.min(want.top, want.tip);
  for (let page = pageOf(bottom); page * PAGE <= top; page++) {
    if (failed(page)) continue;
    const lo = page * PAGE;
    const hi = lo + PAGE - 1;
    let start: number | undefined;
    for (let h = Math.min(hi, want.tip); h >= lo; h--) {
      if (!has(h)) {
        start = h;
        break;
      }
    }
    // Only a page missing a height in the wanted range is asked for.
    if (start === undefined || start < bottom) continue;
    const distance = want.middle > hi ? want.middle - hi : want.middle < lo ? lo - want.middle : 0;
    if (!best || distance < best.distance) {
      best = { top: Math.min(hi, want.tip), missing: start, distance };
    }
  }
  return best && { top: best.top, missing: best.missing };
}

/** The page a height is in. */
export const pageOf = (height: number) => Math.floor(height / PAGE);

export interface Past {
  /** The block at a height, when it is loaded. */
  block: (height: number) => Block | undefined;
  /** Why the page holding a height could not be loaded, or undefined. */
  failure: (height: number) => unknown;
  /** Asks again for every page that failed. */
  retry: () => void;
}

/**
 * Older blocks, kept by height: the live list's (so a block that leaves it stays), and pages of
 * the past around what the visitor looks at, one request at a time. Blocks and failures far from
 * the view are let go; a reorg below the live list drops everything older than it.
 */
export function createPastBlocks(
  network: Network,
  live: Accessor<Block[] | undefined>,
  want: Accessor<Want | undefined>,
  pinned: Accessor<number | undefined>,
): Past {
  const blocks = new Map<number, Block>();
  const failed = new Map<number, unknown>();
  const [version, setVersion] = createSignal(0);
  const changed = () => setVersion((v) => v + 1);
  let controller: AbortController | undefined;
  let busy = false;
  /** Counts deep reorgs, so a page asked for before one is not kept after it. */
  let chain = 0;
  /** The extras route needs the server's block table; without one, the node's own pages serve. */
  let useV1 = true;

  createEffect(live, (list) => {
    if (!list || list.length === 0) return;
    const tip = list[0]?.height ?? 0;
    for (const h of blocks.keys()) if (h > tip) blocks.delete(h);
    for (const b of list) blocks.set(b.height, b);
    // A reorg deeper than the live list: what is kept below it is another chain's.
    const bottom = list.at(-1);
    const below = bottom ? blocks.get(bottom.height - 1) : undefined;
    if (bottom && below && below.id !== bottom.previousblockhash) {
      for (const h of blocks.keys()) if (h < bottom.height) blocks.delete(h);
      failed.clear();
      chain++;
    }
    // At "now" nothing loads, so new blocks are let go of here too.
    const w = untrack(want);
    if (w) prune(w);
    changed();
    step();
  });

  /** A page and the tip its answer is stamped with (none when it came from the page's cache). */
  async function load(
    { top, missing }: PageAsk,
    signal: AbortSignal,
  ): Promise<{ list: Block[]; tip: Stamped<unknown>["tip"] }> {
    // After a deep reorg the browser may still hold a page of the old branch for its second.
    const ask = { signal, cached: chain === 0 };
    const page = async (path: string) => {
      const r = await fetchStamped<unknown>(network, path, ask);
      return { list: parse(r.value), tip: r.tip };
    };
    if (useV1) {
      try {
        const r = await page(`/v1/blocks/${top}`);
        if (r.list.some((b) => b.height === missing)) return r;
        // Cut short where the server's block table ends (a fresh install): the node has the rest.
      } catch (e) {
        if (signal.aborted || !(e instanceof ApiError) || (e.status !== 404 && e.status !== 503))
          throw e;
        // No block table here (a lasting 503), or this block is not in it yet (404): ask the node.
        if (e.status === 503 && !isBusy(e)) useV1 = false;
      }
    }
    // The node's pages hold ten, so they are asked for from the highest block still missing.
    return page(`/blocks/${missing}`);
  }

  /**
   * Lets go of what is far from the view; keeps the block under the live list, which tells a deep
   * reorg, and a focused tile with its neighbours, which arrow keys go to.
   */
  function prune(w: Want) {
    const lowest = untrack(live)?.at(-1)?.height ?? Number.POSITIVE_INFINITY;
    const pin = untrack(pinned);
    for (const h of blocks.keys()) {
      if (h >= lowest - 1 || (pin !== undefined && Math.abs(h - pin) <= 1)) continue;
      if (h < w.bottom - KEEP || h > w.top + KEEP) blocks.delete(h);
    }
    for (const p of failed.keys()) {
      if ((p + 1) * PAGE <= w.bottom - KEEP || p * PAGE > w.top + KEEP) failed.delete(p);
    }
  }

  function step() {
    if (busy) return;
    const w = untrack(want);
    if (!w) return;
    const ask = nextPage(
      w,
      (h) => blocks.has(h),
      (p) => failed.has(p),
    );
    if (!ask) return;
    const start = ask.missing;
    busy = true;
    controller = new AbortController();
    const { signal } = controller;
    const asked = chain;
    load(ask, signal).then(
      ({ list, tip: stamp }) => {
        if (asked !== chain) {
          busy = false;
          step();
          return;
        }
        const tip = untrack(live)?.[0]?.height ?? Number.POSITIVE_INFINITY;
        const lowest = untrack(live)?.at(-1)?.height ?? Number.POSITIVE_INFINITY;
        // A page that does not chain onto the blocks kept above it is another branch's. After a deep
        // reorg, one far below the live list has none above it: its stamp must name a live block,
        // as the server answers rows of the chain under that tip only. A page from this page's own
        // cache has no stamp, and is settled, deeper than any reorg the server repairs.
        const kept = untrack(live) ?? [];
        if (
          list.some(
            (b) => blocks.has(b.height + 1) && blocks.get(b.height + 1)?.previousblockhash !== b.id,
          ) ||
          (chain > 0 && stamp !== undefined && !kept.some((b) => b.id === stamp.hash))
        ) {
          failed.set(
            pageOf(start),
            new ApiError(503, "The chain changed while these blocks were asked for."),
          );
          busy = false;
          changed();
          step();
          return;
        }
        // The live list's blocks are newer news than any page.
        for (const b of list) if (b.height < lowest && b.height <= tip) blocks.set(b.height, b);
        if (!blocks.has(start)) {
          failed.set(pageOf(start), new ApiError(502, `The server did not send block ${start}.`));
        }
        const now = untrack(want);
        if (now) prune(now);
        busy = false;
        changed();
        step();
      },
      (e: unknown) => {
        busy = false;
        if (signal.aborted) return;
        failed.set(pageOf(start), e);
        changed();
        step();
      },
    );
  }

  createEffect(want, () => step());
  onCleanup(() => controller?.abort());

  return {
    block: (h) => {
      version();
      return blocks.get(h);
    },
    failure: (h) => {
      version();
      return failed.get(pageOf(h));
    },
    retry: () => {
      failed.clear();
      changed();
      step();
    },
  };
}

function parse(reply: unknown): Block[] {
  return Array.isArray(reply) ? reply.filter((b: unknown) => isBlock(b)) : [];
}
