import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../../lib/api";
import { mount } from "../test-utils";
import { AuditSection } from "./Audit";
import { AUDIT } from "./fakes";
import { type AuditTotals, formatMatchRate, KINDS, readAudit, readAuditDetail } from "./model";

const HASH = "ab".repeat(32);
const txid = (n: number) => n.toString(16).padStart(64, "0");

const text = (el: Element) => (el.textContent ?? "").replaceAll(" ", " ");
const until = <T,>(fn: () => T) => vi.waitFor(fn, { timeout: 2000 });
const item = (el: Element, name: string) =>
  text(
    [...el.querySelectorAll(".audit-kinds__item")].find(
      (li) => li.querySelector(".audit-kinds__name")?.textContent === name,
    ) ?? document.createElement("li"),
  );

function serveDetail(reply: () => Response) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return url === `/app/block/${HASH}/audit`
      ? reply()
      : Response.json({ error: "not found" }, { status: 404 });
  });
  return asked;
}

const detail = (txs: unknown[], complete = true, totals: AuditTotals = AUDIT) =>
  Response.json({ ...totals, id: HASH, height: 100, time: 1000, seen_at: 2000, complete, txs });

afterEach(() => {
  vi.unstubAllGlobals();
  clearApiCache();
});

describe("readAudit", () => {
  it("reads totals and refuses what it cannot draw", () => {
    expect(readAudit(AUDIT)).toStrictEqual(AUDIT);
    expect(readAudit(null)).toBeNull();
    expect(readAudit(undefined)).toBeNull();
    expect(readAudit({ ...AUDIT, match_rate: "99" })).toBeNull();
    expect(readAudit({ ...AUDIT, match_rate: 101 })).toBeNull();
    expect(readAudit({ ...AUDIT, unseen: { txs: -1, vsize: 0 } })).toBeNull();
    const { added: _, ...withoutAdded } = AUDIT;
    expect(readAudit(withoutAdded)).toBeNull();
  });

  it("drops listed entries it cannot read, and never a matched one", () => {
    const d = readAuditDetail({
      ...AUDIT,
      seen_at: 5,
      complete: false,
      txs: [
        { txid: txid(1), kind: "missing", vsize: 100, rate: 2000, first_seen: 3 },
        { txid: "<img src=x>", kind: "missing", vsize: 100, rate: 2000 },
        { txid: txid(2), kind: "matched", vsize: 100, rate: 2000 },
        { txid: txid(3), kind: "unseen", vsize: 100, rate: 1500 },
      ],
    });
    expect(d?.complete).toBe(false);
    expect(d?.txs.map((t) => t.txid)).toStrictEqual([txid(1), txid(3)]);
    expect(d?.txs[0]?.first_seen).toBe(3);
    expect(d?.txs[1]?.first_seen).toBeUndefined();
  });

  it("prints the score as sent, never rounded up", () => {
    expect(formatMatchRate(99.87)).toBe("99.87");
    expect(formatMatchRate(99.999)).toBe("99.99");
    expect(formatMatchRate(66.5)).toBe("66.50");
    expect(formatMatchRate(100)).toBe("100");
    expect(formatMatchRate(0)).toBe("0");
  });
});

describe("AuditSection", () => {
  it("shows the score, both blocks and every category", () => {
    const el = mount(() => <AuditSection hash={HASH} audit={AUDIT} />);
    expect(text(el.querySelector(".audit__rate") as Element)).toBe("99.87%");
    const rows = [...el.querySelectorAll(".audit__compare tbody tr")].map((tr) => text(tr));
    expect(rows).toStrictEqual([
      "Transactions3 1003 150",
      "Virtual size998.00 kvB997.50 kvB",
      "Fees, BTC0.01 500 000 BTC0.01 498 000 BTC",
    ]);
    expect(item(el, "Matched")).toContain("2 900 transactions, 950.00 kvB");
    expect(item(el, "Missing")).toContain("3 transactions, 1 200 vB");
    expect(item(el, "Missing")).toContain("Only these lower the match rate");
    expect(item(el, "Unseen")).toContain("1 transaction, 200 vB");
    // Expected over mined, their matched parts lined up: the mined lane starts after what only
    // the expected block had.
    const lanes = [...el.querySelectorAll(".audit-bars__lane")];
    expect(lanes).toHaveLength(2);
    const matchedAt = (lane: Element | undefined) =>
      Number(
        lane?.querySelector<HTMLElement>(".audit-kind--matched")?.style.getPropertyValue("--x"),
      );
    expect(matchedAt(lanes[0])).toBeCloseTo(47_200 / 1_006_900);
    expect(matchedAt(lanes[1])).toBe(matchedAt(lanes[0]));
    // Matched is in both lanes.
    expect(el.querySelectorAll(".audit-bars__seg")).toHaveLength(8);
    expect(el.querySelector(".audit__details button")?.textContent).toBe(
      "Show the transactions that differ",
    );
  });

  it.each(KINDS)("says None for an empty %s category and draws no piece of it", (kind) => {
    const audit = { ...AUDIT, [kind]: { txs: 0, vsize: 0 } };
    const el = mount(() => <AuditSection hash={HASH} audit={audit} />);
    const name = kind.charAt(0).toUpperCase() + kind.slice(1);
    expect(item(el, name)).toContain("None");
    expect(item(el, name)).not.toContain("0 transactions");
    expect(el.querySelectorAll(`.audit-bars__seg.audit-kind--${kind}`)).toHaveLength(0);
    expect(el.querySelectorAll(".audit-bars__seg")).toHaveLength(kind === "matched" ? 6 : 7);
  });

  it("offers no list and no bars when nothing differed and nothing was waiting", () => {
    const zero = { txs: 0, vsize: 0 };
    const side = { txs: 0, vsize: 0, weight: 0, fees: 0 };
    const audit: AuditTotals = {
      ...AUDIT,
      match_rate: 100,
      expected: side,
      actual: side,
      ...Object.fromEntries(KINDS.map((k) => [k, zero])),
    };
    const el = mount(() => <AuditSection hash={HASH} audit={audit} />);
    expect(text(el.querySelector(".audit__rate") as Element)).toBe("100%");
    expect(el.querySelector(".audit-bars")).toBeNull();
    expect(el.querySelector(".audit__details")).toBeNull();
  });

  it("says plainly when there is no audit: no figures, no error", () => {
    const el = mount(() => <AuditSection hash={HASH} audit={null} />);
    expect(text(el.querySelector(".audit") as Element)).toBe(
      "AuditNot audited: we were not watching when this block arrived, so there is no block we expected to compare it with.",
    );
    expect(el.querySelector("[role=alert]")).toBeNull();
    expect(el.querySelector(".audit__rate")).toBeNull();
  });

  it("loads the list only when asked, by category, each linking to its transaction", async () => {
    const asked = serveDetail(() =>
      detail([
        { txid: txid(1), kind: "missing", vsize: 400, rate: 12_500, first_seen: 1280 },
        { txid: txid(2), kind: "missing", vsize: 300, rate: 1000 },
        { txid: txid(3), kind: "unseen", vsize: 200, rate: 2000 },
      ]),
    );
    const el = mount(() => <AuditSection hash={HASH} audit={AUDIT} />);
    expect(asked).toHaveLength(0);
    el.querySelector<HTMLButtonElement>(".audit__details button")?.click();
    flush();
    await until(() => expect(el.querySelectorAll(".audit-list tbody tr")).toHaveLength(2));
    expect(asked).toStrictEqual([`/app/block/${HASH}/audit`]);
    const pressed = el.querySelector(".audit-list__kind[aria-pressed=true]");
    expect(text(pressed as Element)).toBe("Missing 3");
    const first = el.querySelector(".audit-list tbody tr") as Element;
    expect(first.querySelector("a")?.getAttribute("href")).toBe(`/tx/${txid(1)}`);
    expect(text(first)).toContain("12.5");
    expect(text(first)).toContain("12 min");
    // Fewer listed than the category holds, and the list says so.
    expect(text(el.querySelector(".audit-list") as Element)).toContain(
      "2 of 3 missing transactions listed",
    );
    const unseen = [...el.querySelectorAll<HTMLButtonElement>(".audit-list__kind")].find((b) =>
      b.textContent?.startsWith("Unseen"),
    );
    unseen?.click();
    flush();
    expect(el.querySelectorAll(".audit-list tbody tr")).toHaveLength(1);
    expect(el.querySelector(".audit-list tbody a")?.getAttribute("href")).toBe(`/tx/${txid(3)}`);
  });

  it("says when the list was cut at 1,000", async () => {
    const txs = Array.from({ length: 1000 }, (_, i) => ({
      txid: txid(i + 1),
      kind: "fresh",
      vsize: 100,
      rate: 1000,
    }));
    // The most telling kinds are listed first, so only the last, fresh, is cut here.
    const none = { txs: 0, vsize: 0 };
    const audit: AuditTotals = {
      ...AUDIT,
      missing: none,
      unseen: none,
      added: none,
      displaced: none,
      conflicted: none,
      fresh: { txs: 1500, vsize: 150_000 },
    };
    serveDetail(() => detail(txs, false, audit));
    const el = mount(() => <AuditSection hash={HASH} audit={audit} />);
    el.querySelector<HTMLButtonElement>(".audit__details button")?.click();
    flush();
    // A page at a time, as the block's own list: never all 1,000 at once.
    await until(() => expect(el.querySelectorAll(".audit-list tbody tr")).toHaveLength(25));
    const list = text(el.querySelector(".audit-list") as Element);
    expect(list).toContain("The server lists at most 1 000 transactions");
    expect(list).toContain("1 000 of 1 500 fresh transactions listed");
    const more = el.querySelector<HTMLButtonElement>(".audit-list__more button");
    expect(more?.textContent).toBe("Show 25 more");
    more?.click();
    flush();
    expect(el.querySelectorAll(".audit-list tbody tr")).toHaveLength(50);
  });

  it("says so when the server has no list for the block", async () => {
    serveDetail(() => Response.json({ error: "audit not available" }, { status: 404 }));
    const el = mount(() => <AuditSection hash={HASH} audit={AUDIT} />);
    el.querySelector<HTMLButtonElement>(".audit__details button")?.click();
    flush();
    await until(() => expect(text(el)).toContain("No list for this block"));
    expect(el.querySelector("[role=alert]")).toBeNull();
  });

  it("offers to try again when the list fails", async () => {
    let n = 0;
    serveDetail(() =>
      ++n === 1
        ? Response.json({ error: "store failed" }, { status: 500 })
        : detail([{ txid: txid(1), kind: "missing", vsize: 400, rate: 12_500 }]),
    );
    const el = mount(() => <AuditSection hash={HASH} audit={AUDIT} />);
    el.querySelector<HTMLButtonElement>(".audit__details button")?.click();
    flush();
    const retry = await until(() => {
      const b = el.querySelector<HTMLButtonElement>(".audit-list [role=alert] button");
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    retry.click();
    flush();
    await until(() => expect(el.querySelectorAll(".audit-list tbody tr")).toHaveLength(1));
  });
});
