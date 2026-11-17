import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../components/test-utils";
import { clearApiCache } from "./api";
import { FakeSocket } from "./fakes";
import { createReplacements, type Replacements } from "./replacements";

let asks: number[];
/** How each ask treated the browser's HTTP cache. */
let caching: (RequestCache | undefined)[];
let feeds: Replacements[];
/** How long the server takes to answer, as a retry after a refusal would. */
let delay = 0;
let start = Date.now();

function Probe() {
  feeds.push(createReplacements("regtest", () => false, { gapMs: 1500 }));
  return null;
}
const version = (v: number) =>
  FakeSocket.last().receive({ topic: "replacements", type: "replacements", version: v });

beforeEach(() => {
  // Asks are remembered page-wide, so each test starts well past every wait the others left.
  start += 3_600_000;
  vi.useFakeTimers({ now: start, toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  clearApiCache();
  asks = [];
  feeds = [];
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  delay = 0;
  caching = [];
  vi.stubGlobal("fetch", async (_: string, init?: RequestInit) => {
    asks.push(Date.now());
    caching.push(init?.cache);
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
    return Response.json([]);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createReplacements", () => {
  it("spaces its asks after any feed's ask, so a burst of changes costs one", async () => {
    mount(() => <Probe />, "/regtest/");
    FakeSocket.last().hello();
    version(1);
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    // The reader opens a second view of the list a moment later, as the record changes.
    mount(() => <Probe />, "/regtest/");
    await vi.advanceTimersByTimeAsync(200);
    version(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(asks.length).toBeGreaterThan(1);
    expect((asks[1] ?? 0) - (asks[0] ?? 0)).toBeGreaterThanOrEqual(1500);
  });

  it("leaves the switched-off state when the record is there again", async () => {
    mount(() => <Probe />, "/regtest/");
    FakeSocket.last().hello();
    FakeSocket.last().receive({ topic: "replacements", type: "off" });
    flush();
    expect(feeds[0]?.off()).toBe(true);
    // The server came back with its engine on.
    version(1);
    flush();
    expect(feeds[0]?.off()).toBe(false);
    // Past any wait an earlier test's ask left: asks are remembered page-wide, and that one was
    // made on a fake clock that ran ahead.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(feeds[0]?.stories()).toStrictEqual([]);
  });

  it("waits from the answer, not the ask, when the answer was slow", async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    delay = 3000;
    mount(() => <Probe />, "/regtest/");
    FakeSocket.last().hello();
    version(1);
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(3000);
    delay = 0;
    // The record changes just after the slow answer came: its gap is still running.
    await vi.advanceTimersByTimeAsync(200);
    version(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(asks).toHaveLength(2);
    // The answer took 3 s, then its 1.5 s wait.
    expect((asks[1] ?? 0) - (asks[0] ?? 0)).toBeGreaterThanOrEqual(4500);
  });

  it("shows the list the page already holds at once when opened again, then asks within the gap", async () => {
    await vi.advanceTimersByTimeAsync(30_000);
    mount(() => <Probe />, "/regtest/");
    FakeSocket.last().hello();
    version(1);
    await vi.waitFor(() => expect(feeds[0]?.stories()).toStrictEqual([]));
    const before = asks.length;
    // The reader comes back to the page a moment later: the topic says nothing new.
    await vi.advanceTimersByTimeAsync(200);
    mount(() => <Probe />, "/regtest/");
    expect(feeds[1]?.stories()).toStrictEqual([]);
    expect(asks).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1400);
    expect(asks).toHaveLength(before + 1);
  });

  it("asks the server, never the browser's cache, which can hold the list from before a change", async () => {
    // Past the wait the tests before left: asks are remembered page-wide, on a clock they ran ahead.
    await vi.advanceTimersByTimeAsync(60_000);
    mount(() => <Probe />, "/regtest/");
    FakeSocket.last().hello();
    version(1);
    await vi.waitFor(() => expect(caching).toStrictEqual(["no-cache"]));
  });
});
