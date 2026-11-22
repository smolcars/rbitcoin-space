// The home page's data: the block list kept live over the socket, and the panels polled over HTTP.
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { fetchApi } from "../../lib/api";
import {
  applyBlock,
  applyReorg,
  type BlocksMessage,
  blocksTopic,
  differsFrom,
  isBlock,
} from "../../lib/blocks-topic";
import type { Block } from "../../lib/esplora";
import { type LiveStatus, useTopic } from "../../lib/live";
import type { Network } from "../../lib/network";

/** Mined blocks kept in the strip: what `/blocks` answers with. */
export const STRIP_MAX = 10;
/** While the socket is down, the strip still moves: `/blocks` is fetched this often. */
export const FALLBACK_POLL_MS = 15_000;
/** Messages held while a fetch is in flight; past this the fetch is simply repeated. */
const QUEUE_MAX = 32;
/**
 * Tip answers are cached for a second (docs/API.md), so a list asked for just after a `block`
 * message can lack it: a list behind what is known is asked for again after this, a few times.
 */
const STALE_RETRY_MS = 1_200;
const STALE_RETRIES = 8;

export interface Feed<T> {
  data: Accessor<T | undefined>;
  error: Accessor<unknown>;
  refresh: () => void;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/**
 * The mined blocks, newest first. Loaded over HTTP, then kept current from the `blocks` topic.
 * A gap, a `resync` that disagrees, and a reconnect all fetch the list again; while the socket is
 * down it is fetched every {@link FALLBACK_POLL_MS}.
 */
export function createBlockFeed(network: Network, status: Accessor<LiveStatus>): Feed<Block[]> {
  const [data, setData] = createSignal<Block[]>();
  const [error, setError] = createSignal<unknown>();
  /** The list as last set: a write reaches `data()` only when the update is applied. */
  let current: Block[] | undefined;
  const show = (list: Block[]) => {
    current = list;
    setData(list);
  };
  let controller: AbortController | undefined;
  /** Messages that arrived while a fetch was in flight, replayed on top of its answer. */
  let queue: BlocksMessage[] | undefined;
  let again = false;
  /** The tip the socket said exists, until a list that reaches it arrives. */
  let expected: { height: number; hash: string } | undefined;
  let staleRetries = 0;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;

  /** A newly announced tip gets its own run of retries. */
  const expect = (tip: { height: number; hash: string }) => {
    expected = tip;
    staleRetries = 0;
  };

  /** Asks again in a moment, unless it has already asked enough times. */
  const retryLater = () => {
    if (staleRetries >= STALE_RETRIES) return false;
    staleRetries++;
    clearTimeout(staleTimer);
    staleTimer = setTimeout(refresh, STALE_RETRY_MS);
    return true;
  };

  const refresh = () => {
    if (controller) {
      again = true;
      return;
    }
    void load();
  };

  async function load() {
    controller = new AbortController();
    const { signal } = controller;
    queue = [];
    again = false;
    try {
      // The first load may come from the cache: the topic's first message corrects it.
      const reply = await fetchApi<unknown>(network, "/blocks", {
        signal,
        cached: current === undefined,
      });
      const list = (Array.isArray(reply) ? reply.filter((b: unknown) => isBlock(b)) : [])
        // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array; toSorted is newer than the browsers we build for
        .sort((a, b) => b.height - a.height)
        .slice(0, STRIP_MAX);
      const shown = current;
      const newest = list[0];
      const behindShown = !!shown?.[0] && !!newest && newest.height < shown[0].height;
      const behindExpected = !!expected && (!newest || newest.height < expected.height);
      // A list older than what is on screen is never shown; one that is ahead of it but not yet at
      // the announced tip is shown, and asked for again.
      if (!behindShown && !sameList(shown, list)) show(list);
      if ((behindShown || behindExpected) && retryLater()) return;
      staleRetries = 0;
      expected = undefined;
      // Retries ran out: take the node's word over the screen's.
      if (behindShown) show(list);
      setError(undefined);
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      setError(e);
      if (expected && !retryLater()) {
        // Out of retries: wait for the next announcement, which starts afresh.
        expected = undefined;
        staleRetries = 0;
      }
    } finally {
      if (!signal.aborted) {
        controller = undefined;
        const held = queue ?? [];
        queue = undefined;
        // Applied together, so held messages reach the strip as one change, not several.
        for (const m of held) handle(m);
        if (again) refresh();
      }
    }
  }

  function handle(m: BlocksMessage) {
    // Fee facts are the tiles' business (summaries.ts), not the list's.
    if (m.type === "summary") return;
    if (queue) {
      if (queue.length < QUEUE_MAX) queue.push(m);
      else again = true;
      return;
    }
    const shown = current;
    if (!shown) {
      refresh();
      return;
    }
    if (m.type === "block") {
      const next = applyBlock(shown, m.block, STRIP_MAX);
      if (next === "gap") {
        expect({ height: m.block.height, hash: m.block.id });
        refresh();
      } else if (!sameList(shown, next)) show(next);
    } else if (m.type === "reorg") {
      const next = applyReorg(shown, m.forkHeight);
      if (next.length !== shown.length) show(next);
    } else if (m.tip && differsFrom(shown, m.tip)) {
      // Often the hub's answer to a block the node could not serve yet: wait for HTTP to have it.
      expect(m.tip);
      refresh();
    }
  }

  useTopic(blocksTopic, { message: handle, resync: refresh });
  refresh();

  // The socket is the fast path; HTTP keeps the strip moving while it is down.
  createEffect(status, (s) => {
    if (s === "live") return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  });
  onCleanup(() => {
    controller?.abort();
    clearTimeout(staleTimer);
  });
  return { data, error, refresh };
}

function sameList(a: readonly Block[] | undefined, b: readonly Block[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x.id === b[i]?.id);
}

/**
 * One API path fetched every `everyMs` while the tab is visible, and at once when it comes back.
 * Keeps the last good answer through a failure; `error` says the latest attempt failed.
 */
export function createPoll<T>(
  network: Network,
  path: string,
  everyMs: number,
  valid: (v: unknown) => v is T,
  /** Polls only while this is true, and at once when it becomes true. */
  enabled: Accessor<boolean> = () => true,
): Feed<T> {
  const [data, setData] = createSignal<T>();
  const [error, setError] = createSignal<unknown>();
  let controller: AbortController | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;

  const refresh = () => {
    controller?.abort();
    const c = new AbortController();
    controller = c;
    lastAt = Date.now();
    fetchApi<unknown>(network, path, { signal: c.signal, cached: true }).then(
      (v) => {
        if (c.signal.aborted) return;
        if (valid(v)) {
          setData(() => v);
          setError(undefined);
        } else {
          setError(new Error("unexpected reply"));
        }
      },
      (e: unknown) => {
        if (!c.signal.aborted && !isAbort(e)) setError(e);
      },
    );
  };

  const due = () => {
    const never = lastAt === Number.NEGATIVE_INFINITY;
    if (never || (!document.hidden && Date.now() - lastAt >= everyMs)) refresh();
  };
  createEffect(enabled, (on) => {
    if (!on) return undefined;
    due();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, everyMs);
    document.addEventListener("visibilitychange", due);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", due);
    };
  });
  onCleanup(() => controller?.abort());
  return { data, error, refresh };
}
