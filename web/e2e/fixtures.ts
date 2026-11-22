// Every browser test imports `test` and `expect` from here, never from @playwright/test.
import { type Browser, type Page, test as base, expect } from "@playwright/test";

export { expect } from "@playwright/test";

/** The regtest node's JSON-RPC, which only the `mines` project is given (playwright.config.ts). */
export interface RegtestRpc {
  url: string;
  user: string;
  password: string;
}

// P2WSH of OP_TRUE, the harness's anyone-can-spend miner script (docs/REGTEST.md).
const MINER = "raw(00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260)";

/**
 * How long the projected blocks may trail the node. A new block's projection follows its `block`
 * message at once, or at most 3 s later when the node is slow to serve the block (docs/WS.md "When
 * a block is found"); a new transaction reaches it at the tracker's next cycle, at most about 1 s
 * away, and the topic's next send, at most 2 s (`WS_MEMPOOL_INTERVAL_MS`). 3 s more for a busy
 * machine. A wait on it ends as soon as the page catches up, so a passing run never pays it.
 */
export const PROJECTION_LAG_MS = 6_000;

// How the page names a CSP violation caused by Playwright itself rather than the site.
const PLAYWRIGHT_STYLE = "Playwright's own style, refused by the CSP:";
/** What each document logs as it starts (`noConsoleErrors`). */
const DOCUMENT_START = "e2e: document started";

// Tests this worker has started, for their client addresses.
let started = 0;

// A busy refusal of the block summaries, which the server gives when its queue of uncached ones
// is full (`summary_busy`, as a cold server under load can) and every page asks again as it says
// (`fetchSummaries`). The browser still logs it, which is no error of the page's.
const SUMMARY_BUSY = /status of 503\b.* \S*\/app\/blocks\/summary\?/;

// What a handler answers, told from pages and static files as the server's limiter does.
const HANDLED = /^\/(?:healthz|readyz)(?:\/|$)|^\/(?:[^/]*\/)?(?:api|app)(?:\/|$)/;

/**
 * Stand-ins for the prose fonts other systems have, as local faces any machine has one of
 * (docs/FRONTEND.md "Other systems' fonts"). Each entry is a regular face and its bold.
 * `wide` is DejaVu Sans, Linux's usual default and the widest measured; where it is missing,
 * Verdana, within 3% of it on the site's own strings. `narrow` is Arial's metrics (Liberation
 * Sans is drawn to them), as narrow as Roboto, Cantarell and San Francisco or narrower.
 */
const PROSE_STAND_INS = {
  wide: [
    ["DejaVu Sans", "DejaVu Sans Bold"],
    ["Verdana", "Verdana Bold"],
  ],
  narrow: [
    ["Liberation Sans", "Liberation Sans Bold"],
    ["Arial", "Arial Bold"],
  ],
} as const;
export type Prose = "system" | keyof typeof PROSE_STAND_INS;

const proseFromEnv = process.env["E2E_PROSE"] ?? "system";
if (proseFromEnv !== "system" && !(proseFromEnv in PROSE_STAND_INS)) {
  throw new Error(`E2E_PROSE is ${proseFromEnv}: use system, wide or narrow`);
}

/** Sets prose in the first of `faces` this system has, before the app's own script runs. */
function useProseStandIn(faces: readonly (readonly [string, string])[]) {
  const families: string[] = [];
  const loads: Promise<boolean>[] = [];
  for (const [i, [regular, bold]] of faces.entries()) {
    families.push(`"Prose stand-in ${i}"`);
    for (const [name, weight] of [
      [regular, "1 550"],
      [bold, "551 1000"],
    ] as const) {
      const face = new FontFace(`Prose stand-in ${i}`, `local("${name}")`, { weight });
      document.fonts.add(face);
      loads.push(
        face.load().then(
          () => true,
          () => false,
        ),
      );
    }
  }
  // The digit-group gap stays ours, as in the real stack.
  const stack = `"Recursive Gap", ${families.join(", ")}`;
  const apply = () => document.documentElement.style.setProperty("--font-sans", stack);
  // An init script can run before the document has its root element.
  if ((document.documentElement as HTMLElement | null) !== null) apply();
  // Before the app's module runs, which reads the stack.
  document.addEventListener("readystatechange", apply, { once: true });
  void Promise.all(loads).then((loaded) => {
    // A regular face, the first of each pair, or the page is measured in the wrong font.
    if (!loaded.some((ok, i) => ok && i % 2 === 0)) {
      // oxlint-disable-next-line no-console -- the console is how the test hears of it
      console.error(`prose stand-in: no face of ${JSON.stringify(faces)} on this system`);
    }
  });
}

export const test = base.extend<{
  prose: Prose;
  proseStandIn: undefined;
  consoleErrorsAllowed: RegExp[];
  noConsoleErrors: undefined;
  regtestRpc: RegtestRpc | null;
  rpc: <T>(method: string, params?: unknown[]) => Promise<T>;
  mine: (blocks: number) => Promise<string[]>;
}>({
  regtestRpc: [null, { option: true }],
  // The prose font: the system's, or a stand-in for another system's. `E2E_PROSE` sets it for a
  // run; a test sets it with `test.use({ prose: "wide" })`.
  prose: [proseFromEnv as Prose, { option: true }],
  proseStandIn: [
    async ({ context, prose }, use) => {
      if (prose !== "system") await context.addInitScript(useProseStandIn, PROSE_STAND_INS[prose]);
      await use(undefined);
    },
    { auto: true },
  ],
  // Each test is a visitor of its own, as its fresh browser context is: e2e.sh trusts
  // X-Forwarded-For from 127.0.0.1, so the server keys every per-client limit on this address and
  // the suite runs at the defaults. It reaches pages, files, API calls, WebSockets and `request`.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    started += 1;
    const client = `198.18.${testInfo.parallelIndex}.${(started % 254) + 1}`;
    await use({ ...extraHTTPHeaders, "x-forwarded-for": client });
  },
  // Mines blocks on the run's node and returns their hashes. Only `*.mine.e2e.ts` files may: they
  // run after every other test, so no test ever sees the chain change under it. Before such a test
  // starts, the server must have caught up with the blocks earlier ones mined.
  // The run's node's JSON-RPC, for tests that change the chain; only `*.mine.e2e.ts` files may.
  rpc: async ({ request, regtestRpc }, use) => {
    await use(async <T>(method: string, params: unknown[] = []): Promise<T> => {
      if (!regtestRpc) {
        throw new Error('only *.mine.e2e.ts tests may mine (docs/FRONTEND.md "Browser tests")');
      }
      const res = await request.post(regtestRpc.url, {
        headers: { authorization: `Basic ${btoa(`${regtestRpc.user}:${regtestRpc.password}`)}` },
        data: { jsonrpc: "1.0", id: 1, method, params },
      });
      const body = (await res.json()) as { result: T | null; error: unknown };
      if (body.result === null) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
      return body.result;
    });
  },
  mine: async ({ browser, baseURL, extraHTTPHeaders, rpc, regtestRpc }, use, testInfo) => {
    if (regtestRpc) {
      const tip = await rpc<string>("getbestblockhash");
      const ms = await caughtUp(browser, baseURL ?? "", extraHTTPHeaders ?? {}, tip);
      testInfo.annotations.push({ type: "server caught up", description: `${ms} ms` });
    }
    await use((blocks) => rpc<string[]>("generatetodescriptor", [blocks, MINER]));
  },
  // Console errors a test causes on purpose, such as a fetch that fails. CSP violations never pass.
  consoleErrorsAllowed: [[], { option: true }],
  // Runs around every test: a console error, an uncaught exception or a CSP violation on any
  // page of the test fails it, and so does a page or static file the server's limits refused.
  noConsoleErrors: [
    async ({ context, consoleErrorsAllowed, baseURL }, use) => {
      const errors: string[] = [];
      const refused = new Set<string>();
      // Each engine words a CSP violation differently, so the page reports every violation itself,
      // in words the check below knows. In WebKit every Playwright screenshot adds a style of its
      // own, which the CSP refuses: one with no file and no element, reported against the document
      // itself, where a style of the site's names its `<style>` element. That one is named apart.
      await context.addInitScript((playwrightStyle) => {
        document.addEventListener("securitypolicyviolation", (e) => {
          const what = `${e.violatedDirective} ${e.blockedURI}`;
          // oxlint-disable-next-line no-console -- the console is how the test hears of it
          console.error(
            e.sourceFile === "" && e.violatedDirective === "style-src-elem" && e.target === document
              ? `${playwrightStyle} ${what}`
              : `Content Security Policy violation: ${what}`,
          );
        });
      }, PLAYWRIGHT_STYLE);
      // WebKit on Linux reports each of our own fetches that leaving a page cut off, and each the
      // page starts while it unloads, as an error of its own ("Fetch API cannot load … due to
      // access control checks"), though the page caught it. From a page's navigation request,
      // errors in that wording are held, and dropped once its next document starts. A navigation
      // that keeps the page (no content, or aborted) starts none: what it held counts, at the next
      // navigation or at the end of the test.
      await context.addInitScript((start) => {
        // oxlint-disable-next-line no-console -- the console is how the test hears of it
        console.debug(start);
      }, DOCUMENT_START);
      const leaving = new Map<Page, string[]>();
      const host = baseURL ? new URL(baseURL).host : "";
      const report = (page: Page | null, error: string, text: string) => {
        const held = page ? leaving.get(page) : undefined;
        const cutOff = text.includes("due to access control checks") && text.includes(host);
        (held && cutOff ? held : errors).push(error);
      };
      context.on("request", (r) => {
        const page = r.frame().page();
        if (!r.isNavigationRequest() || r.frame() !== page.mainFrame()) return;
        // A redirect is the same navigation. Any other means the last one kept the page, if it
        // still holds anything: what it held counts.
        const held = leaving.get(page);
        if (held && r.redirectedFrom()) return;
        errors.push(...(held ?? []));
        leaving.set(page, []);
      });
      context.on("console", (m) => {
        const page = m.page();
        if (m.type() === "debug" && m.text() === DOCUMENT_START && page) leaving.delete(page);
        // A failed load's text does not name the resource; its location does.
        if (m.type() === "error")
          report(page, `${m.text()} ${m.location().url}`.trimEnd(), m.text());
      });
      context.on("weberror", (e) => {
        report(e.page(), `uncaught: ${e.error().message}`, e.error().message);
      });
      context.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if ((r.status() !== 429 && r.status() !== 503) || HANDLED.test(path)) return;
        // Only the server's own answers: a test's `page.route` stand-ins carry no request id.
        if (r.headers()["x-request-id"] === undefined) return;
        // At the defaults no page load may trip a limit, so end the test now with the reason
        // instead of letting a later assertion time out. e2e.sh prints which limit refused it.
        const why = `the server refused ${r.request().method()} ${path} with ${r.status()}: a page or static file over its limits (docs/CONFIG.md "Static files")`;
        if (refused.size === 0) void context.close({ reason: why });
        refused.add(why);
      });
      await use(undefined);
      for (const held of leaving.values()) errors.push(...held);
      expect([...refused], "pages and static files refused by the server's limits").toEqual([]);
      // WebKit also logs each of Playwright's own refused styles in its usual words: drop as many.
      let playwright = errors.filter((e) => e.startsWith(PLAYWRIGHT_STYLE)).length;
      const unexpected = errors.filter((e) => {
        if (e.startsWith(PLAYWRIGHT_STYLE)) return false;
        if (playwright > 0 && e.startsWith("Refused to apply a stylesheet")) {
          playwright -= 1;
          return false;
        }
        if (SUMMARY_BUSY.test(e)) return false;
        return /Content.Security.Policy/i.test(e) || !consoleErrorsAllowed.some((r) => r.test(e));
      });
      expect(unexpected, "console errors and CSP violations").toEqual([]);
    },
    { auto: true },
  ],
});

/** The chain `dev/regtest/regtest.py scenario` builds; every hash is fixed (docs/REGTEST.md). */
export const chain = {
  tip: { height: 110, hash: "3fa932c75119e4a4f4c4f5f43afe8fec03c5f3bc9b84fbadd1e96dd34bc6654d" },
  blocks: {
    1: "55c72c83b6934bee3a62540b5bc7f0438e9dcefb03779b87e8456bc545171960",
    106: "2ac64444e3172ee94aeeff3b09014b1d69b4daeccddac025d493332d54f6f145",
  },
  txs: {
    script_types: "44c64894ca2125fb361f286005f8e27d1c1846bfe00c692925ab4d6844721bbd",
    consolidation: "f8580c086f549b53145643e6b846d617aef17305ec2af34125e41faa74bfd787",
    spend_p2sh_p2a: "aa4652e9b6189d3569c54d148016f38538fea374c22965dbbe472ffef5c25f5f",
    payment: "0def111d15485da613e9dc24a587a9657d3726772dcc68e0c55c2daa67b1dca9",
    rbf_original: "c465329ca476d6454a42d21372a3461c2753426a8a07c46e0f2a5d6a731b756d",
    rbf_replacement: "39134afd670713636c838ddb195e1c9d45cd2625b01d19fc73f4cae5ba51a9f8",
    cpfp_parent: "7621473f23691b3acc681cada96b25a64e64ff298d8f95fd4818855ea886abbd",
    cpfp_child: "ad853f8771d8e8f764d362723b23fe758654432f52da63baa993ffc66af93f51",
  },
  addresses: {
    p2pkh: "mwLW3XDqcAYmYKp8VDEYXweSBJ5mTUAuat",
    p2sh: "2ND8PB9RrfCaAcjfjP1Y6nAgFd9zWHYX4DN",
    p2wpkh: "bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s",
    p2wsh: "bcrt1qgpsh04whvyp5fvrul6rr8384qt0mf4a7h507m5ed79d72euknpgqpmza40",
    p2tr: "bcrt1pz9ml8p3h96z9hlvz0esm3uwdq9pxssmykz209jrg57znrdvx5y0shy3atk",
    p2a: "bcrt1pfeesnyr2tx",
    miner: "bcrt1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqseac85",
  },
} as const;

/**
 * Waits until the server's `blocks` and `projected` topics both sit on the node's tip `tip`, and
 * returns how long that took. A test that mines while the server still trails the blocks an
 * earlier one mined sees those land with its own. Read from a page of the server's own origin, as
 * the WebSocket admits only those; bounded by PROJECTION_LAG_MS.
 */
async function caughtUp(
  browser: Browser,
  baseURL: string,
  extraHTTPHeaders: Record<string, string>,
  tip: string,
): Promise<number> {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders });
  try {
    const page = await context.newPage();
    await page.goto("/healthz");
    const seen = await page.evaluate(
      async ({ want, timeout }) => {
        const got = { blocks: "nothing yet", projected: "nothing yet", ms: 0 };
        const start = performance.now();
        const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/regtest/app/ws`);
        await new Promise<void>((resolve) => {
          const stop = setTimeout(resolve, timeout);
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ op: "subscribe", topics: ["blocks", "projected"] }));
          });
          ws.addEventListener("message", (e: MessageEvent<unknown>) => {
            if (typeof e.data !== "string") return;
            const m = JSON.parse(e.data) as {
              topic?: string;
              type?: string;
              block?: { id: string };
              tip?: { hash: string } | null;
            };
            if (m.topic === "blocks" && m.type === "block") got.blocks = m.block?.id ?? "";
            if (m.topic === "blocks" && m.type === "resync") got.blocks = m.tip?.hash ?? "";
            if (m.topic === "projected" && m.type === "projected") {
              got.projected = m.tip?.hash ?? "";
            }
            if (got.blocks === want && got.projected === want) {
              clearTimeout(stop);
              resolve();
            }
          });
        });
        ws.close();
        got.ms = Math.round(performance.now() - start);
        return got;
      },
      { want: tip, timeout: PROJECTION_LAG_MS },
    );
    expect(
      { blocks: seen.blocks, projected: seen.projected },
      `the server's blocks and projected topics caught up with the node's tip ${tip} within ${PROJECTION_LAG_MS} ms`,
    ).toEqual({ blocks: tip, projected: tip });
    return seen.ms;
  } finally {
    await context.close();
  }
}

/**
 * Past retargets for regtest, which never retargets: mainnet's last twelve, as
 * `/api/v1/mining/difficulty-adjustments` answers them, at heights the scenario's chain has, so
 * each row opens a real block.
 */
export const RETARGETS = [
  [1_793_301_298, 110, 148_364_561_003_867.4, 1.05539],
  [1_792_154_251, 108, 140_577_680_051_919.6, 1.05924],
  [1_791_011_796, 106, 132_716_002_350_731.28, 0.99969],
  [1_789_801_745, 104, 132_757_073_449_487.52, 1.04163],
  [1_788_640_367, 102, 127_450_789_715_843.14, 1.01307],
  [1_787_446_127, 100, 125_807_076_547_197.56, 0.98688],
  [1_786_217_755, 98, 127_479_855_693_691.4, 1.00989],
  [1_785_019_866, 96, 126_231_507_121_868.2, 0.99262],
  [1_783_800_551, 94, 127_170_500_429_035.2, 0.94996],
  [1_782_525_607, 92, 133_869_853_540_305.4, 1.07153],
  [1_781_396_637, 90, 124_932_866_006_548.16, 0.89909],
  [1_780_050_586, 88, 138_955_357_012_247.3, 1.01719],
] as const;

/** Answers regtest's past retargets with `RETARGETS`. */
export async function stubRetargets(page: Page): Promise<void> {
  await page.route(/\/regtest\/api\/v1\/mining\/difficulty-adjustments$/, (route) =>
    route.fulfill({ json: RETARGETS }),
  );
}
