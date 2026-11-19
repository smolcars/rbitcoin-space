import { afterEach, describe, expect, it, vi } from "vitest";
import { isChunkError, RELOAD_GAP_MS, reloadOnce, retryFiles, watchFiles } from "./chunks";

watchFiles();

/** A stylesheet link that has failed to load, as the browser reports it. */
function failedLink(name: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset["name"] = name;
  document.head.append(link);
  link.dispatchEvent(new Event("error"));
  return link;
}
const current = (name: string) =>
  document.head.querySelector<HTMLLinkElement>(`link[data-name="${name}"]`);

describe("retryFiles", () => {
  it("asks again for each failed stylesheet and waits for all of them", async () => {
    failedLink("a");
    failedLink("b");
    let done = false;
    const retried = retryFiles().then(() => {
      done = true;
    });
    current("a")?.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(done).toBe(false);
    current("b")?.dispatchEvent(new Event("load"));
    await retried;
    expect(done).toBe(true);
  });

  it("does not answer while one is still loading after another failed, and keeps both", async () => {
    failedLink("c");
    failedLink("d");
    let settled = false;
    const retried = retryFiles().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    current("c")?.dispatchEvent(new Event("error"));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(settled).toBe(false);
    current("d")?.dispatchEvent(new Event("error"));
    await retried;
    // Both are noted again, so the next attempt asks for both.
    const again = retryFiles();
    current("c")?.dispatchEvent(new Event("load"));
    current("d")?.dispatchEvent(new Event("load"));
    await expect(again).resolves.toStrictEqual({ scripts: false });
  });
});

describe("retryFiles called while another call is in flight", () => {
  const tick = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

  it("waits for it, and asks again for what it failed to load", async () => {
    failedLink("waited");
    const first = retryFiles();
    let second = "pending";
    const next = retryFiles().then(
      () => {
        second = "loaded";
      },
      () => {
        second = "failed";
      },
    );
    await tick();
    // The first call holds "waited": the lists are empty, which is not "nothing failed".
    expect(second).toBe("pending");
    const held = current("waited");
    held?.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow("Could not load");
    await tick();
    // The second call asked for it again, through a link of its own.
    expect(current("waited")).not.toBe(held);
    expect(second).toBe("pending");
    current("waited")?.dispatchEvent(new Event("load"));
    await next;
    expect(second).toBe("loaded");
  });

  it("answers once the first has loaded everything, with nothing asked twice", async () => {
    failedLink("joined");
    const first = retryFiles();
    const second = retryFiles();
    const asked = current("joined");
    asked?.dispatchEvent(new Event("load"));
    await expect(first).resolves.toStrictEqual({ scripts: false });
    await expect(second).resolves.toStrictEqual({ scripts: false });
    expect(current("joined")).toBe(asked);
  });
});

/** A script preload that has failed, as Vite adds one for a page's code. */
function failedPreload(href: string): void {
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = href;
  document.head.append(link);
  link.dispatchEvent(new Event("error"));
}

describe("retryFiles and scripts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proves a failed script downloads now, bypassing the cache, and says one was checked", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response("", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetch);
    failedPreload("/assets/Page-a.js");
    await expect(retryFiles()).resolves.toStrictEqual({ scripts: true });
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/assets\/Page-a\.js$/), {
      cache: "reload",
    });
    // Nothing is left to ask for.
    await expect(retryFiles()).resolves.toStrictEqual({ scripts: false });
  });

  it("tells a call that waited for another that the other proved a script", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("", { status: 200 }))),
    );
    failedPreload("/assets/Page-joined.js");
    const first = retryFiles();
    const second = retryFiles();
    await expect(first).resolves.toStrictEqual({ scripts: true });
    await expect(second).resolves.toStrictEqual({ scripts: true });
    // A later call, with none in flight, starts clean.
    await expect(retryFiles()).resolves.toStrictEqual({ scripts: false });
  });

  it("keeps a script that still fails, by status or by network, for the next attempt", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    failedPreload("/assets/Page-b.js");
    await expect(retryFiles()).rejects.toThrow("Could not load");
    await expect(retryFiles()).rejects.toThrow("Could not load");
    await expect(retryFiles()).resolves.toStrictEqual({ scripts: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("still says a script was proven when only a stylesheet held up an attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("x", { status: 200 }))),
    );
    failedPreload("/assets/Page-c.js");
    failedLink("e");
    const first = retryFiles();
    current("e")?.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow("Could not load");
    const second = retryFiles();
    current("e")?.dispatchEvent(new Event("load"));
    await expect(second).resolves.toStrictEqual({ scripts: true });
  });

  it("does not count a script whose body broke off as downloaded", async () => {
    const broken = new ReadableStream({
      start: (c) => c.error(new TypeError("network connection was lost")),
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(broken, { status: 200 }))
        .mockResolvedValueOnce(new Response("x", { status: 200 })),
    );
    failedPreload("/assets/Page-d.js");
    await expect(retryFiles()).rejects.toThrow("Could not load");
    await expect(retryFiles()).resolves.toStrictEqual({ scripts: true });
  });
});

describe("reloadOnce", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("reloads, then not again until the gap has passed", () => {
    const reload = vi.fn<() => void>();
    expect(reloadOnce(1_000_000, reload)).toBe(true);
    expect(reloadOnce(1_000_000 + RELOAD_GAP_MS - 1, reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    expect(reloadOnce(1_000_000 + RELOAD_GAP_MS, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads without session storage, since it could not stop a loop", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const reload = vi.fn<() => void>();
    expect(reloadOnce(1_000_000, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("isChunkError", () => {
  it("knows each browser's words for a failed download, and nothing else", () => {
    expect(isChunkError(new TypeError("Failed to fetch dynamically imported module: /a.js"))).toBe(
      true,
    );
    expect(isChunkError(new Error("Unable to preload CSS for /a.css"))).toBe(true);
    expect(isChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkError(new TypeError("x is undefined"))).toBe(false);
  });
});
