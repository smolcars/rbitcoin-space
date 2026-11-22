import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  chainTip,
  clearApiCache,
  createRequest,
  errorMessage,
  fetchApi,
  fetchApp,
  fetchStamped,
  isImmutable,
  isNotFound,
  RETRY_ATTEMPTS,
  retryDelay,
  withRetry,
  isBusy,
} from "./api";

function reply(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearApiCache();
});

describe("errorMessage", () => {
  it("uses our server's error body as a sentence", () => {
    expect(errorMessage(404, { error: "not found" })).toBe("Not found.");
    expect(errorMessage(400, { error: "Invalid txid." })).toBe("Invalid txid.");
  });

  it("falls back to the status for anything else", () => {
    expect(errorMessage(404, "Transaction not found")).toBe("Not found.");
    expect(errorMessage(429, null)).toBe("Too many requests. Try again in a moment.");
    expect(errorMessage(500, { error: 7 })).toBe("The server could not answer.");
    expect(errorMessage(418, { error: "  " })).toBe("HTTP 418.");
  });
});

describe("isImmutable", () => {
  it("keeps only replies marked as never changing", () => {
    expect(isImmutable("public, max-age=31536000, immutable")).toBe(true);
    expect(isImmutable("max-age=86400")).toBe(true);
    expect(isImmutable("max-age=10")).toBe(false);
    expect(isImmutable("no-store, immutable")).toBe(false);
    expect(isImmutable("no-cache")).toBe(false);
    expect(isImmutable(null)).toBe(false);
  });
});

describe("fetchApi", () => {
  it("prefixes the network and parses JSON", async () => {
    const fetch = vi.fn<() => Promise<Response>>(async () => reply(200, '{"height":5}'));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchApi("signet", "/block/ab")).resolves.toStrictEqual({ height: 5 });
    expect(fetch).toHaveBeenCalledWith("/signet/api/block/ab", expect.anything());
  });

  it("skips the browser's HTTP cache unless a cached answer will do", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      reply(200, "[]"),
    );
    vi.stubGlobal("fetch", fetch);
    await fetchApi("mainnet", "/blocks");
    await fetchApi("mainnet", "/blocks", { cached: true });
    await fetchStamped("mainnet", "/blocks");
    await fetchApp("mainnet", "/blocks");
    expect(fetch.mock.calls.map(([, init]) => init?.cache)).toStrictEqual([
      "no-cache",
      undefined,
      "no-cache",
      "no-cache",
    ]);
  });

  it("reads text replies", async () => {
    vi.stubGlobal("fetch", async () => reply(200, "975411\n"));
    await expect(fetchApi("mainnet", "/blocks/tip/height", { as: "text" })).resolves.toBe("975411");
  });

  it("maps error bodies to ApiError", async () => {
    vi.stubGlobal("fetch", async () => reply(404, '{"error":"not found"}'));
    const e = await fetchApi("mainnet", "/tx/00").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect(isNotFound(e)).toBe(true);
    expect((e as ApiError).message).toBe("Not found.");
  });

  it("reports an unreachable server and an unreadable reply", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchApi("mainnet", "/x")).rejects.toMatchObject({ status: 0 });
    vi.stubGlobal("fetch", async () => reply(200, "<html>"));
    await expect(fetchApi("mainnet", "/x")).rejects.toMatchObject({ status: 200 });
  });

  it("passes an abort through instead of reporting it as an error", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- fetch rejects with the abort reason, whatever it is
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const pending = fetchApi("mainnet", "/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.not.toBeInstanceOf(ApiError);
  });

  it("caches immutable replies and nothing else", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
      url.endsWith("/block/ab")
        ? reply(200, "1", { "cache-control": "public, max-age=31536000, immutable" })
        : reply(200, "2", { "cache-control": "max-age=5" }),
    );
    vi.stubGlobal("fetch", fetch);
    await fetchApi("mainnet", "/block/ab");
    await fetchApi("mainnet", "/block/ab");
    await fetchApi("mainnet", "/blocks");
    await fetchApi("mainnet", "/blocks");
    // Same path on another network is another resource.
    await fetchApi("signet", "/block/ab");
    expect(fetch.mock.calls.map((c) => c[0])).toStrictEqual([
      "/api/block/ab",
      "/api/blocks",
      "/api/blocks",
      "/signet/api/block/ab",
    ]);
  });
});

describe("retries", () => {
  const busy = (status: number, after?: number) => new ApiError(status, "busy", after);

  it("waits at least as long as Retry-After, backing off from 1 s to 30 s", () => {
    const none = () => 0;
    expect(retryDelay(busy(503, 1), 0, none)).toBe(1000);
    expect(retryDelay(busy(503, 1), 1, none)).toBe(2000);
    expect(retryDelay(busy(503, 1), 3, none)).toBe(8000);
    expect(retryDelay(busy(429, 2), 0, none)).toBe(2000);
    expect(retryDelay(busy(429, 20), 1, none)).toBe(20_000);
    expect(retryDelay(busy(503), 5, none)).toBe(30_000);
    // Up to a quarter more at random, so clients spread out.
    expect(retryDelay(busy(503, 1), 0, () => 1)).toBe(1250);
  });

  it("retries only refusals that say to, and stops after a few", () => {
    expect(retryDelay(busy(404), 0)).toBeUndefined();
    expect(retryDelay(busy(502), 0)).toBeUndefined();
    expect(retryDelay(busy(0), 0)).toBeUndefined();
    expect(retryDelay(new Error("x"), 0)).toBeUndefined();
    expect(retryDelay(busy(503, 1), RETRY_ATTEMPTS)).toBeUndefined();
    // A server whose mempool engine is off says so on every try.
    expect(retryDelay(new ApiError(503, "Mempool is switched off.", 1), 0)).toBeUndefined();
  });

  it("waits as a busy refusal says, then answers", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(reply(429, '{"error":"slow down"}', { "retry-after": "2" }))
      .mockResolvedValue(reply(200, "7"));
    vi.stubGlobal("fetch", fetch);
    const settled = Promise.allSettled([fetchApi("mainnet", "/x")]);
    await vi.advanceTimersByTimeAsync(1900);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(700);
    await expect(settled).resolves.toStrictEqual([{ status: "fulfilled", value: 7 }]);
    vi.useRealTimers();
  });

  it("gives up with the last refusal, which a retry around it does not retry again", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<() => Promise<Response>>(async () =>
      reply(503, '{"error":"busy"}', { "retry-after": "1" }),
    );
    vi.stubGlobal("fetch", fetch);
    const settled = Promise.allSettled([withRetry(() => fetchApi("mainnet", "/x"))]);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(settled).resolves.toMatchObject([
      { status: "rejected", reason: { status: 503, retryAfter: 1 } },
    ]);
    expect(fetch).toHaveBeenCalledTimes(RETRY_ATTEMPTS + 1);
    // Out of retries, but still busy, not broken: the page says so calmly.
    const [result] = await settled;
    const reason: unknown = result?.status === "rejected" ? result.reason : undefined;
    expect(isBusy(reason)).toBe(true);
    expect(retryDelay(reason, 0)).toBeUndefined();
    expect(isBusy(new ApiError(503, "Mempool is switched off.", 1))).toBe(false);
    expect(isBusy(new ApiError(503, "Block extras need a block table on this server.", 1))).toBe(
      false,
    );
    expect(isBusy(new ApiError(503, "the mempool engine is off on this server", 1))).toBe(false);
    // A kept address as of an old block: about the address, not the moment.
    expect(
      isBusy(
        new ApiError(
          503,
          "Unspent outputs and older history are not kept for an address this large.",
          1,
        ),
      ),
    ).toBe(false);
    vi.useRealTimers();
  });

  it("never asks a refused URL again before its Retry-After, even from a new call", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(reply(503, '{"error":"busy"}', { "retry-after": "30" }))
      .mockResolvedValue(reply(200, "7"));
    vi.stubGlobal("fetch", fetch);
    // A poll abandons its call and starts another, as the home page's feeds do every few seconds.
    const first = new AbortController();
    const abandoned = Promise.allSettled([fetchApi("mainnet", "/x", { signal: first.signal })]);
    await vi.advanceTimersByTimeAsync(5000);
    first.abort();
    await abandoned;
    const next = Promise.allSettled([fetchApi("mainnet", "/x")]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(next).resolves.toStrictEqual([{ status: "fulfilled", value: 7 }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("says when the reader is offline rather than blaming the server", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await expect(fetchApi("mainnet", "/x")).rejects.toMatchObject({
      status: 0,
      message: "You are offline. Reconnect, then try again.",
    });
    vi.restoreAllMocks();
  });

  it("calls again after the wait, and gives up on the first other failure", async () => {
    vi.useFakeTimers();
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(busy(503, 1))
      .mockRejectedValueOnce(busy(404))
      .mockResolvedValue("ok");
    const settled = Promise.allSettled([withRetry(call)]);
    await vi.advanceTimersByTimeAsync(1300);
    await expect(settled).resolves.toMatchObject([{ status: "rejected", reason: { status: 404 } }]);
    expect(call).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("stops waiting when aborted", async () => {
    const c = new AbortController();
    const refused = async (): Promise<never> => {
      throw busy(503, 30);
    };
    const settled = Promise.allSettled([withRetry(refused, c.signal)]);
    c.abort();
    await expect(settled).resolves.toMatchObject([
      { status: "rejected", reason: { name: "AbortError" } },
    ]);
  });
});

describe("chain tip stamps", () => {
  const tip = "ab".repeat(32);

  it("reads a whole stamp and nothing less", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(
      chainTip(h({ "x-bitcoin-chain-tip": tip, "x-bitcoin-chain-tip-height": "975420" })),
    ).toStrictEqual({ hash: tip, height: 975_420 });
    expect(chainTip(h({ "x-bitcoin-chain-tip": tip }))).toBeUndefined();
    expect(
      chainTip(h({ "x-bitcoin-chain-tip": "zz", "x-bitcoin-chain-tip-height": "1" })),
    ).toBeUndefined();
    expect(
      chainTip(h({ "x-bitcoin-chain-tip": tip, "x-bitcoin-chain-tip-height": "-1" })),
    ).toBeUndefined();
  });

  it("hands the stamp over with the value", async () => {
    vi.stubGlobal("fetch", async () =>
      reply(200, '{"progressPercent":5}', {
        "x-bitcoin-chain-tip": tip,
        "x-bitcoin-chain-tip-height": "12",
      }),
    );
    await expect(fetchStamped("signet", "/v1/difficulty-adjustment")).resolves.toStrictEqual({
      value: { progressPercent: 5 },
      tip: { hash: tip, height: 12 },
    });
  });
});

describe("createRequest", () => {
  it("asks again for a new source or a refetch, not for the same source worked out again", async () => {
    const asked: string[] = [];
    const [n, setN] = createSignal(0);
    const [[value, { refetch }], dispose] = createRoot((d) => {
      const r = createRequest(
        () => (n() < 10 ? "low" : "high"),
        (key) => {
          asked.push(key);
          return key;
        },
      );
      return [r, d] as const;
    });
    const settle = async () => {
      flush();
      await Promise.resolve();
      flush();
    };
    await settle();
    expect(asked).toStrictEqual(["low"]);
    expect(value()).toBe("low");
    setN(1);
    await settle();
    expect(asked).toStrictEqual(["low"]);
    refetch();
    await settle();
    expect(asked).toStrictEqual(["low", "low"]);
    setN(10);
    await settle();
    expect(asked).toStrictEqual(["low", "low", "high"]);
    expect(value()).toBe("high");
    dispose();
  });
});
