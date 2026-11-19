// Loading the QR pop-up's code, apart from any one press's wish to see it (QrButton.tsx). Pure: the
// fetching is handed in, so every order of outcomes can be tested (load.test.ts).

/** The steps of one load, in order. */
export interface LoadSteps<M> {
  /** Asks again for every file whose download failed; rejects when any fails again. */
  retryFailed: () => Promise<unknown>;
  /** Imports the code. Vite does not wait for a stylesheet it already has a link for. */
  importCode: () => Promise<M>;
  /**
   * Whether the pop-up's stylesheet is applied: checked last, so an unstyled pop-up never opens.
   * When it is not, it notes the stylesheet as failed, so the next load's `retryFailed` asks again.
   */
  styled: () => boolean;
}

export interface Loader<M> {
  /**
   * The code: from the last load that succeeded, or from the load in flight, which every call
   * joins, or from a new one. Never cancelled; a failed one leaves the next call to start afresh.
   */
  load: () => Promise<M>;
  /** The code once a load has succeeded. */
  loaded: () => M | undefined;
}

export function createLoader<M>(steps: LoadSteps<M>): Loader<M> {
  let done: M | undefined;
  let running: Promise<M> | undefined;
  const run = async (): Promise<M> => {
    try {
      // First, always: a failed stylesheet is never asked for again by Vite, however the last
      // load ended (docs/FRONTEND.md, "When a page's files fail to load").
      await steps.retryFailed();
      const code = await steps.importCode();
      if (!steps.styled()) throw new Error("The QR code's stylesheet is not applied");
      done = code;
      return code;
    } finally {
      running = undefined;
    }
  };
  return {
    // Not async: a press while a load is in flight gets that very promise.
    load: () => {
      if (done !== undefined) return Promise.resolve(done);
      running ??= run();
      return running;
    },
    loaded: () => done,
  };
}

/** What became of one press's wish to open. */
export type Outcome = "open" | "failed" | "cancelled";

/**
 * One press's wish to open the pop-up, on the loader's code. `cancel` withdraws it: the load goes
 * on for the next press, and this wish then settles as cancelled, never as open.
 */
export function wish<M>(loader: Loader<M>): { settled: Promise<Outcome>; cancel: () => void } {
  let cancelled = false;
  const settled = loader.load().then(
    (): Outcome => (cancelled ? "cancelled" : "open"),
    (): Outcome => (cancelled ? "cancelled" : "failed"),
  );
  return {
    settled,
    cancel: () => {
      cancelled = true;
    },
  };
}
