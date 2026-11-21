import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import FeeScorePage from "./FeeScorePage";
import { MAINNET_1W, MAINNET_24H, nothingRecorded, SIGNET_1W } from "./testdata";

type Reply = () => Response;
let replies: Record<string, Reply>;
let requests: string[];

beforeEach(() => {
  clearApiCache();
  requests = [];
  replies = {};
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    const reply = replies[url];
    return reply ? reply() : Response.json({ error: "not found" }, { status: 404 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const text = (el: Element | null | undefined) => el?.textContent ?? "";
const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".fee-level")];
/** A header's full words: without its phone form and its unit line. */
const headerText = (th: Element) => {
  const copy = th.cloneNode(true) as Element;
  for (const x of copy.querySelectorAll(".table__short, .table__sub")) x.remove();
  return text(copy).trim();
};
/** A table's row named `name`, each cell under its column's header. */
const tableRow = (table: Element | undefined, name: string): Record<string, string> => {
  const headers = [...(table?.querySelectorAll("thead th") ?? [])].map((th) => headerText(th));
  const row = [...(table?.querySelectorAll("tbody tr") ?? [])].find(
    (r) => text(r.querySelector("th, td")).trim() === name,
  );
  const cells = [...(row?.querySelectorAll("th, td") ?? [])].map((c) => text(c).trim());
  return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
};
const refused = (error: string) => () =>
  Response.json({ error }, { status: 503, headers: { "Retry-After": "1" } });

describe("fee track record page", () => {
  it("asks for the week when the address names no window, and marks it current", async () => {
    replies["/app/fees/score?window=1w"] = () => Response.json(MAINNET_1W);
    const el = mount(() => <FeeScorePage />, "/fees/score");
    await vi.waitFor(() => expect(rows(el)).toHaveLength(4));
    expect(requests).toStrictEqual(["/app/fees/score?window=1w"]);
    expect(text(el.querySelector("[aria-current=page]"))).toBe("1 w: the last week");
    expect(el.querySelector("a[href='/fees/score?window=24h']")).not.toBeNull();
    expect(el.querySelector("a[href='/fees/score?window=all']")).not.toBeNull();
  });

  it("shows each level against its target, the day-long level plainly below it", async () => {
    replies["/app/fees/score?window=1w"] = () => Response.json(MAINNET_1W);
    const el = mount(() => <FeeScorePage />, "/fees/score?window=1w");
    await vi.waitFor(() => expect(rows(el)).toHaveLength(4));
    const [noRush, low, medium, high] = rows(el);
    expect(text(noRush?.querySelector("h3"))).toBe("No rush");
    expect(noRush?.classList.contains("fee-level--below")).toBe(true);
    expect(text(noRush?.querySelector(".fee-level__met"))).toBe("67.4%");
    expect(text(noRush?.querySelector(".fee-level__verdict"))).toBe("Below target");
    // The interval is drawn, its ends written under the band; the sentence is read aloud, and
    // shown only where it says more than the drawing.
    expect(text(noRush?.querySelector(".fee-meter__range"))).toBe("63.3–71.4%");
    const detail = noRush?.querySelector(".fee-level__detail");
    expect(text(detail)).toBe("95% interval 63.3–71.4%. Under 85% across its whole interval.");
    expect(detail?.classList.contains("visually-hidden")).toBe(true);
    // The counts are in the last table only.
    expect(text(noRush)).not.toContain("answers decided by");
    for (const r of [low, medium, high])
      expect(text(r?.querySelector(".fee-level__verdict"))).toBe("Meets target");
    expect(text(high?.querySelector(".fee-level__said"))).toBe("mined within the next block");
    // What it cost and what it rests on, as tables; the samples that were not ours, said.
    expect(el.querySelectorAll("table")).toHaveLength(2);
    expect(text(el)).toContain("under 0.01");
    expect(text(el)).toContain("In 539 samples from this period");
  });

  it("gives no share for a level with too few blocks", async () => {
    replies["/regtest/app/fees/score?window=24h"] = () => Response.json(MAINNET_24H);
    const el = mount(() => <FeeScorePage />, "/regtest/fees/score?window=24h");
    await vi.waitFor(() => expect(rows(el)).toHaveLength(4));
    const noRush = rows(el)[0];
    expect(noRush?.classList.contains("fee-level--too-few")).toBe(true);
    expect(text(noRush?.querySelector(".fee-level__met"))).toBe("–");
    expect(text(noRush?.querySelector(".fee-level__verdict"))).toBe("Too few blocks yet");
    expect(text(noRush?.querySelector(".fee-level__detail"))).toContain(
      "A share is given from 30 blocks",
    );
    expect(noRush?.querySelector(".fee-meter__mark")).toBeNull();
    expect(noRush?.querySelector(".fee-level__detail")?.classList.contains("visually-hidden")).toBe(
      false,
    );
    // A test network says why its shares read low, in the panel of the verdicts.
    expect(text(el.querySelector(".fee-score__levels"))).toContain(
      "On a test network most blocks have room to spare",
    );
  });

  it("on a test network marks a share under the target as no fair test, figures kept", async () => {
    replies["/signet/app/fees/score?window=1w"] = () => Response.json(SIGNET_1W);
    const el = mount(() => <FeeScorePage />, "/signet/fees/score");
    await vi.waitFor(() => expect(rows(el)).toHaveLength(4));
    for (const r of rows(el)) {
      expect(r.classList.contains("fee-level--untested")).toBe(true);
      expect(text(r.querySelector(".fee-level__verdict"))).toBe("Not a fair test here");
      expect(r.querySelector(".fee-level__verdict circle")).not.toBeNull();
      expect(text(r.querySelector(".fee-level__met"))).toBe("0%");
      expect(text(r.querySelector(".fee-meter__range"))).toMatch(/^0–0\.\d%$/);
    }
    // Mainnet's miss stays red and says so.
    replies["/app/fees/score?window=1w"] = () => Response.json(SIGNET_1W);
    const main = mount(() => <FeeScorePage />, "/fees/score");
    await vi.waitFor(() => expect(rows(main)).toHaveLength(4));
    expect(rows(main).every((r) => r.classList.contains("fee-level--below"))).toBe(true);
    expect(text(main)).not.toContain("On a test network");
  });

  it("says when nothing was recorded in the window, and offers everything", async () => {
    replies["/app/fees/score?window=24h"] = () => Response.json(nothingRecorded("24h"));
    const el = mount(() => <FeeScorePage />, "/fees/score?window=24h");
    await vi.waitFor(() => expect(text(el)).toContain("Nothing recorded in this period"));
    expect(el.querySelector(".state a[href='/fees/score?window=all']")).not.toBeNull();
    expect(rows(el)).toHaveLength(0);
  });

  it("says plainly when the server keeps no score, without retrying", async () => {
    replies["/app/fees/score?window=1w"] = refused("the mempool engine is off on this server");
    const el = mount(() => <FeeScorePage />, "/fees/score");
    await vi.waitFor(() => expect(text(el)).toContain("This server keeps no fee track record"));
    expect(requests).toHaveLength(1);
  });

  it("says the record is not ready once the server has kept saying so", async () => {
    vi.useFakeTimers();
    replies["/app/fees/score?window=1w"] = refused("not ready yet; retry");
    const el = mount(() => <FeeScorePage />, "/fees/score");
    for (let i = 0; i < 8 && !text(el).includes("not ready yet"); i++)
      await vi.advanceTimersByTimeAsync(31_000);
    expect(text(el)).toContain("The track record is not ready yet");
    const asked = requests.length;
    expect(asked).toBeGreaterThan(1);
    // "Try again" asks afresh, and a good answer replaces the notice.
    replies["/app/fees/score?window=1w"] = () => Response.json(MAINNET_1W);
    [...el.querySelectorAll("button")].find((b) => text(b) === "Try again")?.click();
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(rows(el)).toHaveLength(4));
  });

  it("puts each recorded figure under its own column", async () => {
    replies["/app/fees/score?window=1w"] = () => Response.json(MAINNET_1W);
    const el = mount(() => <FeeScorePage />, "/fees/score");
    await vi.waitFor(() => expect(rows(el)).toHaveLength(4));
    const [cost, evidence] = [...el.querySelectorAll("table")];
    expect(tableRow(cost, "No rush")).toStrictEqual({
      Level: "No rush",
      "Recommended, median": "0.12",
      "Overpaid when met, mean · median": "0.04 · under 0.01",
      "Short when missed, mean": "0.01",
    });
    expect(tableRow(cost, "High")).toStrictEqual({
      Level: "High",
      "Recommended, median": "2.00",
      "Overpaid when met, mean · median": "1.06 · 0.98",
      "Short when missed, mean": "0.75",
    });
    expect(tableRow(evidence, "High")).toStrictEqual({
      Level: "High",
      "Answers judged": "19\u202F521",
      "Blocks that decided them": "1\u202F035",
      "Left out": "38 34 not finished, 4 no clearing rate",
    });
    // One kind is named by its word; none, by the total alone.
    expect(tableRow(evidence, "No rush")["Left out"]).toBe("2\u202F769 not finished");
  });

  it("refuses an answer for another window than the one asked", async () => {
    replies["/app/fees/score?window=24h"] = () => Response.json(MAINNET_1W);
    const el = mount(() => <FeeScorePage />, "/fees/score?window=24h");
    await vi.waitFor(() => expect(text(el)).toContain("Could not load the fee track record"));
    expect(rows(el)).toHaveLength(0);
  });

  it("refuses an answer it cannot read rather than show it", async () => {
    replies["/app/fees/score?window=1w"] = () => Response.json({ window: "1w" });
    const el = mount(() => <FeeScorePage />, "/fees/score");
    await vi.waitFor(() => expect(text(el)).toContain("Could not load the fee track record"));
  });
});
