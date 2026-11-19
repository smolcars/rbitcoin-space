// Loading the palette's code, and opening it, as one operation. Pure: the fetching is injected,
// so loader.test.ts can hold each step and send every event at each point.
import { IDLE, type Opener, type OpenerEvent, step } from "./opener";

/** What loading the palette takes, in order. */
export interface Steps<C> {
  /**
   * Asks again for the palette's own files that failed before (`retryFiles` with a test of the
   * address, docs/FRONTEND.md "When a page's files fail to load"). Its own outcome is not decisive:
   * the palette's files are proven by the next two steps.
   */
  retry: () => Promise<unknown>;
  /** The code itself: `import()`. */
  load: () => Promise<C>;
  /** Whether the palette's stylesheet is applied now. Without it the dialog would open unstyled. */
  styled: () => boolean;
}

/**
 * One load in flight at a time, shared by every caller (a hover's warm-up, a press); kept once it
 * has succeeded. Any failure clears it, so the next call starts afresh, files retried and all.
 */
export function createLoader<C>(steps: Steps<C>): () => Promise<C> {
  let done: C | undefined;
  let flight: Promise<C> | undefined;
  return () => {
    if (done !== undefined) return Promise.resolve(done);
    flight ??= (async () => {
      try {
        await steps.retry().catch(() => undefined);
        const code = await steps.load();
        if (!steps.styled()) throw new Error("The palette's stylesheet did not load");
        done = code;
        return code;
      } finally {
        flight = undefined;
      }
    })();
    return flight;
  };
}

/**
 * The opener's state machine (opener.ts) with the load wired in: leaving `idle` for `loading`
 * starts a load (or joins the one a hover began), and its end is `arrived` or `failed`. `changed`
 * hears every new state, with the code once it has arrived.
 */
export function createOpener<C>(
  load: () => Promise<C>,
  changed: (state: Opener, code: C | undefined) => void,
) {
  let state: Opener = IDLE;
  let code: C | undefined;
  const send = (event: OpenerEvent): void => {
    const before = state;
    const after = step(before, event);
    if (after === before) return;
    state = after;
    changed(after, code);
    if (before.kind === "idle" && after.kind === "loading") {
      load().then(
        (c) => {
          code = c;
          send("arrived");
        },
        () => send("failed"),
      );
    }
  };
  return { send, state: () => state };
}
