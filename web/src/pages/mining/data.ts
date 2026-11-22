// Loading a mining route: retried while the server is not ready, checked, with its coverage.
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { ApiError, type Coverage, fetchStamped } from "../../lib/api";
import type { Network } from "../../lib/network";

/** The server keeps no block table, so it has no mining history at all (docs/API.md "Mining"). */
export class NoHistoryError extends Error {
  constructor() {
    super("This server keeps no mining history.");
    this.name = "NoHistoryError";
  }
}

/** The server's refusal when it runs without `DATA_DIR`: waiting will not change it. */
export const isNoTable = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 503 && /block table/i.test(e.message);

export interface Answer<T> {
  value: T;
  coverage: Coverage | undefined;
  /** The route this answer came from, so what is said about it names its own period. */
  path: string;
}

export interface MiningData<T> {
  /** The last answer; kept while the next one loads, so a new period never empties the page. */
  answer: Accessor<Answer<T> | undefined>;
  error: Accessor<unknown>;
  loading: Accessor<boolean>;
  retry: () => void;
}

/**
 * One mining route on the page's network, fetched again whenever `path` changes. Return
 * undefined from `path` to wait. A 503 before the server's first answer is retried as it says
 * (`lib/api.ts`).
 */
export function createMiningData<T>(
  network: Accessor<Network>,
  path: () => string | undefined,
  check: (v: unknown) => v is T,
): MiningData<T> {
  const [answer, setAnswer] = createSignal<Answer<T>>();
  const [error, setError] = createSignal<unknown>();
  const [loading, setLoading] = createSignal(false);
  let controller: AbortController | undefined;

  const load = () => {
    controller?.abort();
    const p = path();
    if (p === undefined) return;
    const n = network();
    const c = new AbortController();
    controller = c;
    setLoading(true);
    // Busy refusals are retried inside; a server without a table is not, since it will not grow one.
    fetchStamped<unknown>(n, p, { signal: c.signal, cached: true }).then(
      (r) => {
        if (c.signal.aborted) return;
        setLoading(false);
        if (check(r.value)) {
          setAnswer({ value: r.value, coverage: r.coverage, path: p });
          setError(undefined);
        } else setError(new ApiError(200, "The server sent a reply that could not be read."));
      },
      (e: unknown) => {
        if (c.signal.aborted) return;
        setLoading(false);
        setError(isNoTable(e) ? new NoHistoryError() : e);
      },
    );
  };

  createEffect(
    () => [network(), path()],
    () => load(),
  );
  onCleanup(() => controller?.abort());
  return { answer, error, loading, retry: load };
}
