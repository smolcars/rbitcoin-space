import { describe, expect, it } from "vitest";
import { createLoader, createOpener } from "./loader";
import type { Opener, OpenerEvent } from "./opener";

/** A promise the test settles by hand. */
function deferred<T>() {
  let settle: { resolve: (v: T) => void; reject: (e: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return {
    promise,
    resolve: (v: T) => settle.resolve(v),
    reject: (e: unknown) => settle.reject(e),
  };
}

/** Lets every settled promise's handlers run. */
const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

type Retry = "ok" | "fails";
interface Outcome {
  retry: Retry;
  load: "ok" | "fails";
  styled: boolean;
}

/** Fake steps, each held until the test lets it go, counting how often each is asked for. */
function rig(outcome: Outcome) {
  const asked = { retry: 0, load: 0 };
  const held = { retry: deferred<unknown>(), load: deferred<string>() };
  const loader = createLoader<string>({
    retry: () => {
      asked.retry += 1;
      held.retry = deferred<unknown>();
      return held.retry.promise;
    },
    load: () => {
      asked.load += 1;
      held.load = deferred<string>();
      return held.load.promise;
    },
    styled: () => outcome.styled,
  });
  const seen: Opener[] = [];
  const opener = createOpener(loader, (s) => seen.push(s));
  const settle = {
    retry: async () => {
      if (outcome.retry === "ok") held.retry.resolve(undefined);
      else held.retry.reject(new Error("a file failed again"));
      await flush();
    },
    load: async () => {
      if (outcome.load === "ok") held.load.resolve("code");
      else held.load.reject(new Error("import failed"));
      await flush();
    },
  };
  return { loader, opener, asked, settle, seen };
}

const OUTCOMES: Outcome[] = (["ok", "fails"] as const).flatMap((retry) =>
  (["ok", "fails"] as const).flatMap((load) =>
    [true, false].map((styled) => ({ retry, load, styled })),
  ),
);
/** Where an event comes: while the retry is held, while the import is held, after both. */
const POINTS = ["retry held", "import held", "after"] as const;
const EVENTS: (OpenerEvent | "none")[] = ["none", "press", "escape", "navigation"];

describe("loading the palette", () => {
  it.each(OUTCOMES)("ends as its steps did: %o", async (outcome) => {
    const r = rig(outcome);
    r.opener.send("press");
    await r.settle.retry();
    await r.settle.load();
    const ok = outcome.load === "ok" && outcome.styled;
    // Opened only with its code in and its stylesheet applied; a failed retry of some other file
    // does not decide it.
    expect(r.opener.state().kind).toBe(ok ? "open" : "idle");
  });

  it("never opens unstyled, and opens only for a press that is still wanted, at every point", async () => {
    const bad: string[] = [];
    for (const outcome of OUTCOMES) {
      for (const at of POINTS) {
        for (const event of EVENTS) {
          const r = rig(outcome);
          r.opener.send("press");
          const fire = () => {
            if (event !== "none") r.opener.send(event);
          };
          if (at === "retry held") fire();
          await r.settle.retry();
          if (at === "import held") fire();
          await r.settle.load();
          if (at === "after") fire();
          const ok = outcome.load === "ok" && outcome.styled;
          const label = `${JSON.stringify(outcome)} ${event} ${at}`;
          const state = r.opener.state().kind;
          // A second press during the load withdraws it; Escape or a navigation withdraws it.
          const withdrawn = event !== "none" && at !== "after";
          let want: string;
          if (!ok) want = event === "press" && at === "after" ? "loading" : "idle";
          else if (withdrawn) want = "idle";
          else want = event === "none" ? "open" : "closing";
          if (state !== want) bad.push(`${label}: ${state}, wanted ${want}`);
          if (r.seen.some((s) => s.kind === "open") && !ok) bad.push(`${label}: opened unstyled`);
          // One load per round: a press while it is in flight joins it.
          if (r.asked.retry !== (event === "press" && at === "after" && !ok ? 2 : 1)) {
            bad.push(`${label}: retried ${r.asked.retry} times`);
          }
        }
      }
    }
    expect(bad).toStrictEqual([]);
  });

  it("starts afresh after a failure: the next press asks for every file again", async () => {
    const r = rig({ retry: "ok", load: "fails", styled: true });
    r.opener.send("press");
    await r.settle.retry();
    await r.settle.load();
    expect(r.opener.state().kind).toBe("idle");
    r.opener.send("press");
    expect(r.asked).toStrictEqual({ retry: 2, load: 1 });
    await r.settle.retry();
    expect(r.asked.load).toBe(2);
  });

  it("lets a press join a warm-up already under way, and a failed warm-up not stick", async () => {
    const r = rig({ retry: "ok", load: "fails", styled: true });
    // A hover warms the code; it fails before any press.
    const warm = r.loader().catch(() => "failed");
    await r.settle.retry();
    await r.settle.load();
    await expect(warm).resolves.toBe("failed");
    // The press starts a fresh load, which a second warm-up then joins.
    r.opener.send("press");
    void r.loader().catch(() => undefined);
    expect(r.asked).toStrictEqual({ retry: 2, load: 1 });
  });

  it("keeps the code once in: later opens ask for nothing", async () => {
    const r = rig({ retry: "ok", load: "ok", styled: true });
    r.opener.send("press");
    await r.settle.retry();
    await r.settle.load();
    r.opener.send("escape");
    r.opener.send("closed");
    r.opener.send("press");
    await flush();
    expect(r.opener.state().kind).toBe("open");
    expect(r.asked).toStrictEqual({ retry: 1, load: 1 });
  });
});
