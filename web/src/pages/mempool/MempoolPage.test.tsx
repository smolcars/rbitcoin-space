import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import MempoolPage from "./MempoolPage";
import { history, point, T0 } from "./testdata";

type Reply = () => Response;
let replies: Record<string, Reply>;
let requests: string[];

beforeEach(() => {
  clearApiCache();
  requests = [];
  replies = {};
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace(/^\/(regtest|signet|testnet4)/, "");
    // The replacements panel at the foot of the page asks for its own list.
    if (path.endsWith("/v1/replacements")) return Response.json([]);
    requests.push(path);
    const reply = replies[path];
    return reply ? reply() : Response.json({ error: "not found" }, { status: 404 });
  });
  // happy-dom lays nothing out: give the chart a width to draw in.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const text = (el: HTMLElement) => el.textContent ?? "";
const answer = (h: ReturnType<typeof history>) => () => Response.json(h);
/** The plot: size and flow on one time axis, one slider. */
const sizeChart = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[role=slider][aria-label^='The mempool']");
const layers = (chart: HTMLElement) => [...chart.querySelectorAll(".mempool-layer")];
const press = (chart: HTMLElement, key: string) => {
  chart.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flush();
};
const button = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === name);
const drawn = async (el: HTMLElement) => {
  await vi.waitFor(() => expect(sizeChart(el)?.querySelector("svg")).toBeInstanceOf(SVGSVGElement));
  return sizeChart(el) as HTMLElement;
};
const subpaths = (d: string | null | undefined) => (d ?? "").match(/M/g)?.length ?? 0;

describe("mempool history page", () => {
  it("takes the interval from the address, asks for it and marks it current", async () => {
    replies["/app/mempool/history/1w"] = answer(history({ interval: "1w", step: 600 }));
    const el = mount(() => <MempoolPage />, "/mempool?interval=1w");
    await vi.waitFor(() => expect(requests).toContain("/app/mempool/history/1w"));
    expect(el.querySelector("[aria-current=page]")?.textContent).toBe("1 w: the last week");
    expect(el.querySelector("a[href='/mempool?interval=2h']")).not.toBeNull();
    expect(el.querySelector("a[href='/mempool?interval=all']")).not.toBeNull();
  });

  it("asks for the last 24 hours when the address names no interval, on its own network", async () => {
    mount(() => <MempoolPage />, "/signet/mempool?interval=nonsense");
    await vi.waitFor(() => expect(requests).toContain("/app/mempool/history/24h"));
  });

  it("bridges a few missing minutes, and breaks the line where recording paused longer", async () => {
    // Five missing minutes (T0+120 to T0+360), the most bridged, are drawn across; ten (T0+540 to
    // T0+1080) break it.
    replies["/app/mempool/history/2h"] = answer(
      history({
        points: [point(T0), point(T0 + 60), point(T0 + 420), point(T0 + 480), point(T0 + 1140)],
      }),
    );
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    const chart = await drawn(el);
    // Every fee band breaks at the same place; the empty ones draw nothing worth seeing.
    const drawnLayers = layers(chart);
    expect(drawnLayers).toHaveLength(12);
    expect(subpaths(drawnLayers[0]?.getAttribute("d"))).toBe(2);
    expect(subpaths(drawnLayers[6]?.getAttribute("d"))).toBe(2);
    expect(drawnLayers[6]?.getAttribute("style")).toContain("fill: var(--fee-7)");
    // The flow breaks in the same place, and only there.
    expect(subpaths(chart.querySelector(".mempool-flow-in")?.getAttribute("d"))).toBe(2);
    expect(subpaths(chart.querySelector(".mempool-flow-mined")?.getAttribute("d"))).toBe(2);
  });

  it("shows a period with a single point", async () => {
    replies["/app/mempool/history/24h"] = answer(
      history({
        interval: "24h",
        complete: false,
        sampled: 1,
        minutes: 1440,
        first: T0 + 3600,
        points: [point(T0 + 3600)],
      }),
    );
    // A period the reader chose keeps its whole width, the time before the records hatched.
    const el = mount(() => <MempoolPage />, "/mempool?interval=24h");
    const chart = await drawn(el);
    // A lone point is a sliver in its layers, and its flow holds over its minute: not nothing.
    expect(layers(chart)[6]?.getAttribute("d")).toMatch(/^M.*Z$/);
    expect(chart.querySelector(".mempool-flow-in")?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+H/);
    expect(text(el)).toMatch(/Under 1% recorded, from 12 Nov( 2026)?, 15:00 UTC\./);
    expect(text(el)).toContain("No data stored");
  });

  it("opens on what is recorded when the reader chose no period, and says so", async () => {
    replies["/app/mempool/history/24h"] = answer(
      history({
        interval: "24h",
        complete: false,
        sampled: 1,
        minutes: 1440,
        first: T0 + 3600,
        points: [point(T0 + 3600)],
      }),
    );
    const el = mount(() => <MempoolPage />, "/mempool");
    const chart = await drawn(el);
    expect(text(el)).toMatch(/Recorded since 12 Nov( 2026)?, 15:00 UTC\./);
    // The flow starts where the records do, not at its ten minutes' start, left of the plot.
    const flowStart = /^M([\d.]+)/.exec(
      chart.querySelector(".mempool-flow-in")?.getAttribute("d") ?? "",
    );
    expect(Number(flowStart?.[1])).toBeGreaterThanOrEqual(52);
    expect(text(el)).not.toContain("No data stored");
    // The choice marked is "Recorded", not "24 h", which means the whole day.
    expect(el.querySelector(".periods [aria-current=page]")?.textContent).toBe(
      "Recorded: since this server began recording",
    );
  });

  it("says when nothing has been recorded at all", async () => {
    replies["/app/mempool/history/2h"] = answer(
      history({ first: null, points: [], sampled: 0, complete: false }),
    );
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    await vi.waitFor(() => expect(text(el)).toContain("Nothing recorded yet"));
    expect(el.querySelector("[role=slider]")).toBeNull();
  });

  it("says when the period holds nothing but older records exist, and offers them", async () => {
    replies["/app/mempool/history/2h"] = answer(
      history({ first: T0 - 86_400, points: [], sampled: 0, complete: false }),
    );
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    await vi.waitFor(() => expect(text(el)).toContain("Nothing recorded in this period"));
    expect(text(el)).toContain("Its records begin 11 Nov 2026, 14:00 UTC.");
    expect(el.querySelector(".state a[href='/mempool?interval=all']")?.textContent).toBe(
      "See all of them",
    );
  });

  it("explains a server without a data directory, without retrying it", async () => {
    replies["/app/mempool/history/24h"] = () =>
      Response.json(
        { error: "mempool history needs a data directory on this server" },
        { status: 503, headers: { "retry-after": "1" } },
      );
    const el = mount(() => <MempoolPage />, "/mempool");
    await vi.waitFor(() => expect(text(el)).toContain("This server keeps no mempool history"));
    expect(requests.filter((r) => r.includes("/history/"))).toHaveLength(1);
  });

  it("draws minutes from before the low band was split as one layer, then the three finer ones", async () => {
    // The first minute was stored with ten bands: everything under 0.2 in one.
    const old = point(T0, { bands: [150_000, 50_000, 400_000, 0, 0, 0, 0, 0, 0, 0] });
    replies["/app/mempool/history/2h"] = answer(history({ points: [old, point(T0 + 60)] }));
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    const chart = await drawn(el);
    expect(layers(chart)).toHaveLength(13);
    // The latest minute was split: it has no unsplit part to read out, its row kept in the key.
    expect(chart.getAttribute("aria-valuetext")).not.toContain("not yet split");
    const row = button(el, "under 0.2, not split0 vB");
    expect(row?.classList.contains("mempool-band--empty")).toBe(true);
    press(chart, "Home");
    const then = chart.getAttribute("aria-valuetext") ?? "";
    expect(then).toContain("under 0.2 sat/vB, not yet split 150.00 kvB");
    expect(then).toContain("under 0.12 sat/vB 0 vB");
    // Its other bands keep their meaning: 0.2 to 0.3, and 0.3 to 0.5.
    expect(then).toContain("0.2–0.3 sat/vB 50.00 kvB");
    expect(then).toContain("0.3–0.5 sat/vB 400.00 kvB");
  });

  it("reads a moment's figures by keyboard", async () => {
    replies["/app/mempool/history/2h"] = answer(
      history({ points: [point(T0), point(T0 + 60, { count: 2345, vsize: 610_000 })] }),
    );
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    const chart = await drawn(el);
    // The latest point by default, with the size, count, floor, every band and the flow.
    const now = chart.getAttribute("aria-valuetext") ?? "";
    expect(now).toMatch(/^12 Nov 2026, 14:01 UTC: Total 610\.00 kvB, Transactions 2 345/);
    expect(now).toContain("Lowest accepted 0.10 sat/vB");
    expect(now).toContain("under 0.12 sat/vB 100.00 kvB");
    expect(now).toContain("10+ sat/vB 0 vB");
    expect(now).toContain("Arrived 100 vB/s");
    press(chart, "ArrowLeft");
    expect(chart.getAttribute("aria-valuetext")).toMatch(/^12 Nov 2026, 14:00 UTC: Total 550\.00/);
    expect(text(el.querySelector(".mempool-now") as HTMLElement)).toContain("14:00 UTC");
    press(chart, "Escape");
    expect(chart.getAttribute("aria-valuetext")).toContain("14:01 UTC");
  });

  it("reads a moment's figures under the pointer or a finger", async () => {
    replies["/app/mempool/history/2h"] = answer(
      history({ points: [point(T0), point(T0 + 3600, { count: 9 })] }),
    );
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    const chart = await drawn(el);
    const svg = chart.querySelector("svg") as SVGSVGElement;
    // The plot starts 52 px in, and two hours span the rest: the first point is at the left edge.
    svg.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: 70,
        clientY: 100,
        bubbles: true,
        pointerType: "touch",
      }),
    );
    flush();
    expect(chart.getAttribute("aria-valuetext")).toMatch(/^12 Nov 2026, 14:00 UTC/);
    // A finger lifting keeps the reading, as a tap shows it.
    svg.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerType: "touch" }));
    flush();
    expect(chart.getAttribute("aria-valuetext")).toMatch(/^12 Nov 2026, 14:00 UTC/);
  });

  it("hides the cheap bulk on a press, so the dearer bands fill the plot, and shows all again", async () => {
    // 97% of the latest minute under 0.15: the filter offered starts there.
    const bulk = point(T0 + 60, {
      vsize: 1_000_000,
      bands: [600_000, 370_000, 10_000, 10_000, 0, 0, 0, 0, 0, 0, 0, 10_000],
    });
    replies["/app/mempool/history/2h"] = answer(history({ points: [point(T0), bulk] }));
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    const chart = await drawn(el);
    expect(layers(chart)).toHaveLength(12);
    button(el, "From 0.15 up")?.click();
    flush();
    expect(layers(chart)).toHaveLength(10);
    expect(layers(chart)[0]?.getAttribute("style")).toContain("fill: var(--fee-3)");
    // The bands left out are empty swatches in the key; the readout says what of the whole shows.
    const off = [...el.querySelectorAll(".mempool-band--off .mempool-band__name")].map((n) =>
      text(n as HTMLElement),
    );
    expect(off).toStrictEqual(["0.12–0.15", "under 0.12"]);
    expect(text(el.querySelector(".mempool-now") as HTMLElement)).toContain(
      "30.00 kvB of 1.00 MvB",
    );
    expect(chart.getAttribute("aria-valuetext")).toContain("Shown 30.00 kvB");
    expect(chart.getAttribute("aria-valuetext")).not.toContain("under 0.12 sat/vB");
    button(el, "Show all")?.click();
    flush();
    expect(layers(chart)).toHaveLength(12);
    expect(el.querySelectorAll(".mempool-band--off")).toHaveLength(0);
  });

  it("reads both charts at the one crosshair: the flow's ten minutes that hold the point", async () => {
    // Twenty minutes: arrivals at 100 vB/s in the first ten, 300 vB/s in the next.
    const points = Array.from({ length: 20 }, (_, i) =>
      point(T0 + i * 60, { in_vsize: i < 10 ? 6000 : 18_000, count: 1000 + i }),
    );
    replies["/app/mempool/history/2h"] = answer(history({ points }));
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    const chart = await drawn(el);
    const arrived = () => text(el.querySelector(".mempool-flowkey li") as HTMLElement);
    expect(arrived()).toBe("Arrived300 vB/s");
    press(chart, "Home");
    expect(arrived()).toBe("Arrived100 vB/s");
    expect(text(el.querySelector(".mempool-now") as HTMLElement)).toContain("1 000 tx");
    press(chart, "PageDown");
    // Minute 10 opens the second ten minutes.
    expect(arrived()).toBe("Arrived300 vB/s");
    expect(chart.getAttribute("aria-valuetext")).toMatch(/14:10 UTC.*Arrived 300 vB\/s/);
    // The key reads the bands at the crosshair too.
    expect(text(el.querySelector(".mempool-bands") as HTMLElement)).toContain("1–1.5400.00 kvB");
  });

  it("keeps the figures behind a disclosure under the panel, drawn only once opened", async () => {
    replies["/app/mempool/history/2h"] = answer(
      history({ points: [point(T0), point(T0 + 60, { count: 2345 })] }),
    );
    const el = mount(() => <MempoolPage />, "/mempool?interval=2h");
    await drawn(el);
    const details = el.querySelector<HTMLDetailsElement>(".mempool-figures-table");
    expect(details?.closest(".mempool-board")).toBeNull();
    expect(el.querySelector(".mempool-table")).toBeNull();
    if (!details) throw new Error("no figures");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    flush();
    const rows = [...el.querySelectorAll(".mempool-table tbody tr")];
    expect(rows).toHaveLength(2);
    expect(text(rows[0] as HTMLElement)).toContain("2 345");
  });

  it("asks again just after each new minute is recorded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0 * 1000 + 30_000);
    replies["/app/mempool/history/2h"] = answer(history());
    mount(() => <MempoolPage />, "/mempool?interval=2h");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(32_000);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(3);
  });

  it("lets an ask still in flight finish rather than starting it again each minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0 * 1000);
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/replacements")) return Promise.resolve(Response.json([]));
      requests.push(url);
      signal = init.signal ?? undefined;
      // A server that never answers.
      return new Promise<Response>(() => {
        signal?.throwIfAborted();
      });
    });
    mount(() => <MempoolPage />, "/mempool?interval=2h");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(130_000);
    expect(requests).toHaveLength(1);
    expect(signal?.aborted).toBe(false);
  });
});
