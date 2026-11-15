import { createRouter, memoryHistory, useLocation, useNavigate } from "@solidjs/router";
import { type Component, flush, lazy, Loading } from "solid-js";
import { type JSX, render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../lib/api";
import type { Network } from "../lib/network";
import { SearchField } from "./SearchField";
import { mount } from "./test-utils";

/** The networks the faked server config has Lightning on; each test sets it through `server`. */
const config = vi.hoisted(() => ({ lightning: [] as Network[] }));
vi.mock(import("../lib/config"), () => ({
  loadConfig: async () => ({ networks: [], version: "", ark: {}, lightning: config.lightning }),
}));

const TXID = "65428488a6202f1d681d053b3ff5d8ea9f5b0e5e1e0dcf7bf2e4c1e5a3f9c2e1";

/** The field, and the path the router is on. */
function setup(url = "/") {
  const el = mount(() => {
    const location = useLocation();
    return (
      <>
        <SearchField />
        <output data-testid="path">{location.pathname}</output>
      </>
    );
  }, url);
  const input = el.querySelector("input");
  if (!input) throw new Error("no input");
  const path = () => el.querySelector("output")?.textContent;
  const type = (value: string) => {
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    // A browser applies the update before the next event (the Enter) arrives.
    flush();
  };
  const enter = () => input.form?.requestSubmit();
  return { el, input, path, type, enter };
}

const reply = (status: number, body: unknown) => Response.json(body, { status });

afterEach(() => {
  vi.unstubAllGlobals();
  clearApiCache();
});

describe("SearchField", () => {
  it("is a labelled search landmark with a shortcut", () => {
    const { el, input } = setup();
    expect(el.querySelector("search")).not.toBeNull();
    expect(el.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("Search");
    expect(input.getAttribute("aria-keyshortcuts")).toBe("/");
    expect(input.maxLength).toBe(512);
  });

  it("reads the query as it is typed, and says when Enter will act", async () => {
    const { el, type } = setup();
    type("840000");
    const reading = () => el.querySelector(".search__reading");
    await vi.waitFor(() => expect(reading()?.textContent).toContain("Block 840\u{202F}000"));
    expect(reading()?.querySelector("kbd")).not.toBeNull();
    type(`${TXID.slice(0, 10)}abc`);
    await vi.waitFor(() => expect(reading()?.textContent).toBe("13 of 64 characters"));
    expect(reading()?.querySelector("kbd")).toBeNull();
  });

  it("goes straight to a height's block page on its network, then empties the field", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const { input, path, type, enter } = setup("/signet/");
    type(" #975,411 ");
    enter();
    await vi.waitFor(() => expect(path()).toBe("/signet/block/975411"));
    expect(input.value).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("looks a 64-hex id up and opens what it is", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(url.endsWith("/status") ? reply(200, { confirmed: true }) : reply(404, {})),
    );
    const { path, type, enter } = setup();
    type(`https://mempool.space/tx/${TXID}#vout=1`);
    enter();
    await vi.waitFor(() => expect(path()).toBe(`/tx/${TXID}`));
  });

  it("shows what was searched and what search finds when nothing matches", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(reply(404, { error: "not found" })));
    const { el, path, type, enter } = setup("/testnet4/");
    type(TXID);
    enter();
    const panel = () => el.querySelector(".search__panel");
    await vi.waitFor(() => expect(panel()?.textContent).toContain("Nothing matches"));
    expect(panel()?.textContent).toContain("No block or transaction on Testnet4 has the ID");
    expect(panel()?.querySelector("[title]")?.getAttribute("title")).toBe(TXID);
    expect(panel()?.querySelector("dl")?.textContent).toContain("the whole address");
    expect(el.querySelector('[role="status"]')?.textContent).toContain("Nothing matches");
    expect(path()).toBe("/testnet4/");
    // The field itself says the ID was understood and nothing has it, until the query changes.
    const reading = () => el.querySelector(".search__reading")?.textContent;
    expect(reading()).toBe("Nothing has this ID");
    type(TXID.slice(1));
    await vi.waitFor(() => expect(reading()).toBe("63 of 64 characters"));
  });

  it("explains an unrecognised query as text, and closes on Escape", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(reply(200, { state: "off" })));
    const { el, input, type, enter } = setup();
    type('<img src=x onerror="alert(1)">');
    enter();
    const panel = () => el.querySelector(".search__panel");
    await vi.waitFor(() => expect(panel()).not.toBeNull());
    expect(panel()?.querySelector("q")?.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(panel()?.querySelector("img")).toBeNull();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel()).toBeNull();
    expect(input.value).toBe('<img src=x onerror="alert(1)">');
  });

  it("says the node is unavailable, not that nothing matches, and retries", async () => {
    let up = false;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(up ? reply(200, {}) : reply(502, { error: "upstream unavailable" })),
    );
    const { el, path, type, enter } = setup();
    type(TXID);
    enter();
    const panel = () => el.querySelector(".search__panel");
    await vi.waitFor(() => expect(panel()?.textContent).toContain("Search could not finish"));
    expect(panel()?.textContent).toContain("Upstream unavailable.");
    up = true;
    panel()?.querySelector("button")?.click();
    await vi.waitFor(() => expect(path()).toBe(`/tx/${TXID}`));
  });

  it("shows it is looking while the answer is slow, and typing cancels it", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise(() => {
          if (init.signal) signals.push(init.signal);
        }),
    );
    const { el, path, type, enter } = setup();
    type(TXID);
    enter();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(el.querySelector(".search__busy")?.textContent).toBe("Looking up");
    type(`${TXID}0`);
    expect(el.querySelector(".search__busy")).toBeNull();
    expect(signals[0]?.aborted).toBe(true);
    expect(path()).toBe("/");
  });
});

describe("SearchField and navigation", () => {
  it("drops a search when the reader navigates elsewhere, even before that page has loaded", async () => {
    let answer: ((r: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    let release: () => void = () => undefined;
    const Slow = lazy(
      () =>
        new Promise<{ default: Component }>((resolve) => {
          release = () => resolve({ default: () => <p>slow page</p> });
        }),
    );
    let go: (path: string) => void = () => undefined;
    const history = memoryHistory("/");
    const Router = createRouter({
      routes: [
        { path: "/", component: () => <p>home</p> },
        { path: "/slow", component: Slow },
        { path: "/tx/:txid", component: () => <p>tx page</p> },
      ],
      history,
    });
    function Root(props: { children?: JSX.Element }) {
      const navigate = useNavigate();
      go = (path) => navigate(path);
      return (
        <>
          <SearchField />
          <Loading>{props.children}</Loading>
        </>
      );
    }
    const el = document.createElement("div");
    document.body.append(el);
    const dispose = render(() => <Router>{(page) => <Root>{page.children}</Root>}</Router>, el);
    const input = el.querySelector("input");
    if (!input) throw new Error("no input");
    input.value = TXID;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    input.form?.requestSubmit();
    await vi.waitFor(() => expect(answer).toBeDefined());
    go("/slow");
    // The search answers while the page the reader chose is still loading.
    answer?.(Response.json({ confirmed: true }));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    release();
    await vi.waitFor(() => expect(el.textContent).toContain("slow page"));
    expect(history.get()).toBe("/slow");
    // The query left with its page: the next page's field is empty, with nothing to say.
    expect(input.value).toBe("");
    expect(el.querySelector(".search__reading")?.textContent).toBe("");
    dispose();
  });
});

describe("SearchField and Lightning", () => {
  const KEY = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";
  const OTHER = `02${"ab".repeat(32)}`;
  /** A server with Lightning `on` everywhere or nowhere, finding two nodes for any name (one for
   * a name with "one" in it); records each path. */
  function server(on: boolean) {
    config.lightning = on ? ["mainnet", "signet"] : [];
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      const path = new URL(url, "http://x").pathname + new URL(url, "http://x").search;
      asked.push(path);
      const nodes = [
        { id: KEY, alias: "<b>ACINQ</b>", capacity: 27_383_219_285, channels: 1807 },
        { id: OTHER, alias: null, capacity: 5000, channels: 1 },
      ];
      return Promise.resolve(
        reply(200, { nodes: path.includes("one") ? nodes.slice(1) : nodes, channels: [] }),
      );
    });
    return asked;
  }
  const key = (input: HTMLInputElement, k: string) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    flush();
  };

  it("suggests nodes as a name is typed, names as text with their keys, and opens one by keyboard", async () => {
    const asked = server(true);
    const { el, input, path, type } = setup("/signet/");
    type("ac");
    type("aci");
    type("acinq");
    const list = () => el.querySelector('[role="listbox"]');
    await vi.waitFor(() => expect(list()).not.toBeNull());
    // One search: the edits before the pause asked nothing.
    expect(asked).toStrictEqual(["/signet/app/lightning/search?q=acinq"]);
    const options = [...el.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toStrictEqual([
      `<b>ACINQ</b>273.83 BTC${KEY.slice(0, 10)}…${KEY.slice(-10)}`,
      `No name0.0000500 BTC${OTHER.slice(0, 10)}…${OTHER.slice(-10)}`,
      "All results for “acinq”",
    ]);
    expect(list()?.querySelector("b")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".search__reading")?.textContent).toBe("Node nameEnter");
    key(input, "ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2]?.id);
    key(input, "ArrowDown");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    key(input, "Enter");
    await vi.waitFor(() => expect(path()).toBe(`/signet/lightning/node/${KEY}`));
    expect(input.value).toBe("");
  });

  it("opens the results page for a name on Enter, and closes the list on Escape", async () => {
    server(true);
    const { el, input, path, type, enter } = setup("/signet/");
    type("noderunner");
    await vi.waitFor(() => expect(el.querySelector('[role="listbox"]')).not.toBeNull());
    key(input, "Escape");
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    enter();
    await vi.waitFor(() => expect(path()).toBe("/signet/lightning/search"));
  });

  it("goes straight to a node or a channel by its id", async () => {
    const asked = server(true);
    const { path, type, enter } = setup("/signet/");
    type(KEY);
    enter();
    await vi.waitFor(() => expect(path()).toBe(`/signet/lightning/node/${KEY}`));
    type("811984x2037x0");
    enter();
    await vi.waitFor(() => expect(path()).toBe("/signet/lightning/channel/811984x2037x0"));
    expect(asked).toStrictEqual([]);
  });

  it("never searches a network without Lightning, where a name is still not recognised", async () => {
    const asked = server(false);
    const { el, type, enter } = setup();
    type("noderunner");
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(el.querySelector(".search__reading")?.textContent).toBe("Not recognised");
    enter();
    await vi.waitFor(() =>
      expect(el.querySelector(".search__panel")?.textContent).toContain("Nothing matches"),
    );
    expect(asked).toStrictEqual([]);
  });

  const pause = (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  it("never opens a list the reader closed before it answered", async () => {
    const asked = server(true);
    const { el, input, type } = setup("/signet/");
    type("acinq");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await pause(400);
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(asked).toStrictEqual([]);
    // Escape while a newer list is on its way keeps it closed too.
    type("acinq");
    await vi.waitFor(() => expect(el.querySelector('[role="listbox"]')).not.toBeNull());
    type("acinqs");
    key(input, "Escape");
    await pause(400);
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    // Escape before any list has come, and focus leaving for nowhere, close it too.
    type("acinqss");
    key(input, "Escape");
    await pause(400);
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    type("acinq");
    await vi.waitFor(() => expect(el.querySelector('[role="listbox"]')).not.toBeNull());
    input.blur();
    flush();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it("drops the highlight when a newer list replaces the one it was on", async () => {
    server(true);
    const { el, input, type } = setup("/signet/");
    type("acinq");
    await vi.waitFor(() => expect(el.querySelectorAll('[role="option"]')).toHaveLength(3));
    type("someone");
    key(input, "ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/option-2$/);
    await vi.waitFor(() => expect(el.querySelectorAll('[role="option"]')).toHaveLength(2));
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("brings the highlighted option into view", async () => {
    server(true);
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    try {
      const { el, input, type } = setup("/signet/");
      type("acinq");
      await vi.waitFor(() => expect(el.querySelector('[role="listbox"]')).not.toBeNull());
      key(input, "ArrowUp");
      await vi.waitFor(() => expect(scrolled.at(-1)?.textContent).toContain("All results"));
    } finally {
      // @ts-expect-error -- jsdom has none; the stand-in goes with the test
      delete Element.prototype.scrollIntoView;
    }
  });
});
