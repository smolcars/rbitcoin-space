import { describe, expect, it } from "vitest";
import { createLoader, type Outcome, wish } from "./load";

/**
 * How a stylesheet request is answered: at once, or held until the test releases it. "503-unseen"
 * fails with no error the failure record sees, as a guard for whatever could lose one.
 */
type Answer = "ok" | "503" | "held-ok" | "held-503" | "503-unseen";

/**
 * A page as the loader meets it: the pop-up's stylesheet link and how each request for it is
 * answered, the failure record that `retryFiles` keeps (lib/chunks.ts), and Vite's import, which
 * adds the link and waits for it only when there is none yet (its preload helper skips a stylesheet
 * it has a link for, loaded, pending or failed) and rejects when the one it added fails. Its
 * `styled` notes a stylesheet that is not applied as failed, as QrButton's does.
 */
function page(answers: Answer[], imports: ("ok" | "fail")[]) {
  let link: "none" | "pending" | "loaded" | "failed" = "none";
  let failed = false;
  let requests = 0;
  const held: (() => void)[] = [];
  /** One request for the stylesheet, answered by the next answer ("ok" once they run out). */
  const request = async (): Promise<void> => {
    requests++;
    link = "pending";
    const answer = answers.shift() ?? "ok";
    if (answer.startsWith("held"))
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
    if (answer.includes("503")) {
      link = "failed";
      failed = answer !== "503-unseen";
      throw new Error("503");
    }
    link = "loaded";
  };
  let importing = 0;
  return {
    steps: {
      retryFailed: async () => {
        if (!failed) return;
        failed = false;
        await request();
      },
      importCode: async () => {
        importing++;
        if (link === "none") await request();
        if ((imports.shift() ?? "ok") === "fail") throw new Error("import");
        return "code";
      },
      styled: () => {
        if (link !== "loaded") failed = true;
        return link === "loaded";
      },
    },
    styled: () => link === "loaded",
    requests: () => requests,
    failed: () => failed,
    imports: () => importing,
    release: () => held.shift()?.(),
    held: () => held.length,
  };
}

/** Lets every promise that can settle, settle. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

type Step = "press" | "cancel" | "second press" | "release" | "settle";

/** The runs each order of outcomes is put through: presses, cancels and held answers let go. */
const SCRIPTS: Record<string, Step[]> = {
  "a press": ["press", "settle"],
  "a press cancelled at once": ["press", "cancel", "settle"],
  "a second press while it loads": ["press", "second press", "settle"],
  "a cancel while the answer is held, then a press": [
    "press",
    "settle",
    "cancel",
    "press",
    "settle",
    "release",
    "settle",
    "release",
    "settle",
  ],
  "a press, then another after it settles": ["press", "settle", "press", "settle"],
};

const ORDERS: Record<string, [Answer[], ("ok" | "fail")[]]> = {
  "all succeed": [["ok"], []],
  "the stylesheet fails": [["503"], []],
  "the stylesheet fails, its replacement is held": [["503", "held-ok"], []],
  "the stylesheet fails, its replacement is held and fails": [["503", "held-503"], []],
  "the stylesheet fails twice": [["503", "503"], []],
  "the first stylesheet is held and fails": [["held-503"], []],
  "the import fails": [["ok"], ["fail"]],
  "the stylesheet and then the import fail": [["503"], ["fail"]],
  "the stylesheet fails unseen": [["503-unseen"], []],
  "the stylesheet fails unseen, then its replacement too": [["503-unseen", "503"], []],
};

const CASES = Object.entries(ORDERS).flatMap(([order, [answers, imports]]) =>
  Object.entries(SCRIPTS).map(
    ([name, script]) => [`${order}; ${name}`, answers, imports, script] as const,
  ),
);

describe("loading the QR pop-up", () => {
  it.each(CASES)("%s", async (_, answers, imports, script) => {
    const p = page([...answers], [...imports]);
    const loader = createLoader(p.steps);
    // What went wrong, collected as it happens and checked once at the end.
    const faults: string[] = [];
    // Every load the loader starts, as the promise its callers share: never two in flight.
    const loads = new Set<Promise<string>>();
    const unsettled = new Set<Promise<string>>();
    const load = loader.load;
    loader.load = () => {
      const promise = load();
      if (!loads.has(promise)) {
        loads.add(promise);
        unsettled.add(promise);
        promise.then(
          () => unsettled.delete(promise),
          () => unsettled.delete(promise),
        );
      }
      if (unsettled.size > 1) faults.push("two loads in flight");
      return promise;
    };
    const wishes: { cancelled: boolean; outcome?: Outcome; cancel: () => void }[] = [];
    const press = () => {
      const w = wish(loader);
      const entry: (typeof wishes)[number] = {
        cancelled: false,
        cancel: () => {
          entry.cancelled = true;
          w.cancel();
        },
      };
      wishes.push(entry);
      void w.settled.then((outcome) => {
        entry.outcome = outcome;
        if (outcome === "open" && !p.styled()) faults.push("opened without its stylesheet");
        if (entry.cancelled && outcome !== "cancelled") faults.push(`a cancelled wish ${outcome}`);
      });
    };
    for (const step of script) {
      if (step === "press" || step === "second press") press();
      else if (step === "cancel") wishes.at(-1)?.cancel();
      else if (step === "release") p.release();
      else await settle();
    }
    // The network recovers: every held answer goes through, then presses go on until one opens.
    while (p.held() > 0) {
      p.release();
      await settle();
    }
    for (let i = 0; i < 4 && wishes.at(-1)?.outcome !== "open"; i++) {
      const before = p.requests();
      const hadFailed = p.failed();
      press();
      await settle();
      while (p.held() > 0) {
        p.release();
        await settle();
      }
      if (hadFailed && p.requests() <= before) faults.push("no new request after a failure");
    }
    expect(faults).toStrictEqual([]);
    expect(wishes.at(-1)?.outcome).toBe("open");
    expect(p.styled()).toBe(true);
    expect(loader.loaded()).toBe("code");
  });

  it("joins a press to the load in flight rather than starting another", async () => {
    const p = page(["held-ok"], []);
    const loader = createLoader(p.steps);
    const first = wish(loader);
    const second = wish(loader);
    await settle();
    expect(p.requests()).toBe(1);
    expect(p.imports()).toBe(1);
    p.release();
    await expect(first.settled).resolves.toBe("open");
    await expect(second.settled).resolves.toBe("open");
  });

  it("opens nothing for a wish cancelled while its load succeeds", async () => {
    const p = page(["held-ok"], []);
    const loader = createLoader(p.steps);
    const w = wish(loader);
    await settle();
    w.cancel();
    p.release();
    await expect(w.settled).resolves.toBe("cancelled");
    // The load itself went on, for the next press.
    expect(loader.loaded()).toBe("code");
  });

  it("does not take an unstyled module as loaded: the reviewer's race", async () => {
    // First stylesheet 503; its replacement held; the wish cancelled; another press while the
    // replacement is held; the replacement 503; then the network recovers.
    const p = page(["503", "held-503"], []);
    const loader = createLoader(p.steps);
    await expect(wish(loader).settled).resolves.toBe("failed");
    const first = wish(loader);
    await settle();
    expect(p.held()).toBe(1);
    first.cancel();
    const second = wish(loader);
    await settle();
    // The second press joined the first's load: nothing opened while the replacement is held.
    expect(second).not.toBe(first);
    p.release();
    await expect(first.settled).resolves.toBe("cancelled");
    await expect(second.settled).resolves.toBe("failed");
    expect(loader.loaded()).toBeUndefined();
    // Recovered: the next press asks for the stylesheet again and opens styled.
    const before = p.requests();
    await expect(wish(loader).settled).resolves.toBe("open");
    expect(p.requests()).toBe(before + 1);
    expect(p.styled()).toBe(true);
  });
});
