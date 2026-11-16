import { afterEach, describe, expect, it, vi } from "vitest";
import type { Decoded } from "./decode";
import { ask, AskError, MAX_ANSWER, plan, read } from "./service";
import { ANSWERS } from "./testdata";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lnurl = (url: string, tag: string | null = null) =>
  ({ ...ANSWERS.lnurl, url, host: new URL(url).hostname, tag }) as Decoded;

/** LUD-06's own example answer, as a service sends it. */
const PAY = {
  callback: "https://pay.example.com/cb",
  maxSendable: 100_000_000,
  minSendable: 1000,
  metadata: JSON.stringify([
    ["text/plain", "Coffee"],
    ["text/long-desc", "A cup of coffee, black"],
    ["text/identifier", "satoshi@pay.example.com"],
    ["image/png;base64", "iVBORw0KGgo="],
  ]),
  tag: "payRequest",
  commentAllowed: 255,
};

describe("what is asked", () => {
  it("asks a pay, withdraw or untagged LNURL and a Lightning address, over HTTPS to a public name", () => {
    expect(plan(lnurl("https://pay.example.com/p?q=1"))).toStrictEqual({
      ask: "https://pay.example.com/p?q=1",
      host: "pay.example.com",
    });
    expect(plan(lnurl("https://w.example.com/w", "withdrawRequest"))).toHaveProperty("ask");
    expect(plan(ANSWERS.lightning_address as Decoded)).toStrictEqual({
      ask: "https://bitcoin.org/.well-known/lnurlp/satoshi",
      host: "bitcoin.org",
    });
  });

  it("never asks a login link, nor anything but a decoded LNURL or address", () => {
    expect(plan(lnurl("https://site.example/auth?tag=login&k1=00", "login"))).toBeNull();
    // However the tag is written, as the service will read it.
    expect(plan(lnurl("https://site.example/auth?tag=%6cogin&k1=00", "%6cogin"))).toBeNull();
    expect(plan(lnurl("https://site.example/auth?tag=LOGIN&k1=00", "LOGIN"))).toBeNull();
    expect(plan(lnurl("https://site.example/a?tag=payRequest&tag=login", "payRequest"))).toBeNull();
    expect(plan(ANSWERS.lnurl_withdraw as Decoded)).toHaveProperty("ask");
    expect(plan(ANSWERS.bolt11 as Decoded)).toBeNull();
    expect(plan(ANSWERS.arkade as Decoded)).toBeNull();
  });

  it.each([
    "http://abcdefgh.onion/p",
    "http://pay.example.com/p",
    "https://192.168.1.1/p",
    "https://[::1]/p",
    "https://localhost/p",
    "https://router.local/p",
    "https://nas.internal/p",
    "https://router.home.arpa/p",
    "https://user:pw@pay.example.com/p",
  ])("does not ask %s", (url) => {
    expect(plan(lnurl(url))).toStrictEqual({ skip: "not-public" });
  });
});

describe("reading the answer", () => {
  it("reads a pay answer, and no image, HTML or link from it", () => {
    expect(read(PAY, "pay.example.com")).toStrictEqual({
      tag: "payRequest",
      min: 1000,
      max: 100_000_000,
      description: "Coffee",
      longDescription: "A cup of coffee, black",
      identifier: "satoshi@pay.example.com",
      comment: 255,
      callbackHost: "pay.example.com",
      otherHost: false,
    });
  });

  it("reads a withdraw and a channel answer", () => {
    expect(
      read(
        {
          tag: "withdrawRequest",
          callback: "https://w.example.com/cb",
          k1: "ab",
          minWithdrawable: 0,
          maxWithdrawable: 5_000_000,
          defaultDescription: "Prize",
        },
        "w.example.com",
      ),
    ).toMatchObject({ tag: "withdrawRequest", min: 0, max: 5_000_000, description: "Prize" });
    expect(
      read(
        { tag: "channelRequest", uri: "03ab@1.2.3.4:9735", callback: "https://c.example/cb" },
        "c.example",
      ),
    ).toMatchObject({ tag: "channelRequest", uri: "03ab@1.2.3.4:9735" });
  });

  it("says when the next step goes to another host", () => {
    expect(read({ ...PAY, callback: "https://evil.example/cb" }, "pay.example.com")).toMatchObject({
      callbackHost: "evil.example",
      otherHost: true,
    });
    // A callback that is no HTTPS URL has no host to show.
    const script = ["javascript", "alert(1)"].join(":");
    expect(read({ ...PAY, callback: script }, "pay.example.com").callbackHost).toBeUndefined();
  });

  it("reads the service's refusal as text", () => {
    expect(read({ status: "ERROR", reason: "<b>Unknown user</b>" }, "x.example")).toStrictEqual({
      error: "<b>Unknown user</b>",
    });
    expect(read({ status: "error" }, "x.example")).toStrictEqual({ error: "no reason given" });
  });

  it.each([
    ["not an object", "payRequest"],
    ["an array", [PAY]],
    ["null", null],
  ])("reads nothing from %s", (_, v) => {
    expect(read(v, "x.example")).toStrictEqual({});
  });

  it("leaves out what is missing or of the wrong type, huge or negative", () => {
    const a = read(
      {
        tag: "payRequest",
        minSendable: "1000",
        maxSendable: 1e30,
        metadata: "not json",
        commentAllowed: -5,
        callback: 42,
        defaultDescription: { text: "x" },
      },
      "x.example",
    );
    expect(a).toStrictEqual({ tag: "payRequest" });
    // The least above the most is no range at all.
    expect(read({ ...PAY, minSendable: 9, maxSendable: 1 }, "x").min).toBeUndefined();
    expect(read({ tag: "shout" }, "x")).toStrictEqual({});
  });

  it("cuts a 10,000-character description, never inside an emoji", () => {
    const long = `${"🦀".repeat(5000)}${"a".repeat(5000)}`;
    const a = read({ ...PAY, metadata: JSON.stringify([["text/plain", long]]) }, "x");
    const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    expect([...graphemes.segment(a.description ?? "")]).toHaveLength(1001);
    expect(a.description?.endsWith("🦀…")).toBe(true);
  });
});

describe("the one GET", () => {
  it("asks only the URL, once, without cookies or referrer, and never the callback", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Response.json(PAY);
    });
    const answer = await ask("https://pay.example.com/p", new AbortController().signal);
    expect(read(answer, "pay.example.com").tag).toBe("payRequest");
    expect(calls.map(([u]) => u)).toStrictEqual(["https://pay.example.com/p"]);
    expect(calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
  });

  it("gives up after its time, and says so", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (_: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    );
    const asked = ask("https://slow.example/p", new AbortController().signal, 8000);
    const settled = Promise.allSettled([asked]);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(settled).resolves.toStrictEqual([
      { status: "rejected", reason: new AskError("timeout") },
    ]);
  });

  it("stops reading past its cap, and fails on what is not JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(MAX_ANSWER + 1)));
    await expect(ask("https://big.example/p", new AbortController().signal)).rejects.toStrictEqual(
      new AskError("failed"),
    );
    vi.stubGlobal("fetch", async () => new Response("<html>"));
    await expect(ask("https://html.example/p", new AbortController().signal)).rejects.toStrictEqual(
      new AskError("failed"),
    );
  });
});
