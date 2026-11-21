import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { NNBSP } from "../lib/format";
import { Amount, Sats } from "./Amount";
import { DataTable } from "./DataTable";
import { FeeKey, FeeRate } from "./FeeRate";
import { Hash, HashFull } from "./Hash";
import { Pagination } from "./Pagination";
import { Empty, ErrorState } from "./States";
import { TimeAgo } from "./Time";
import { mount } from "./test-utils";

const txid = "65428488a6202f1d681d053b3ff5d8ea9f5b0e5e1e0dcf7bf2e4c1e5a3f9c2e1";
const hostile = '<img src=x onerror="alert(1)">';
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type argument picks the element type, as querySelector's does
const q = <T extends Element = HTMLElement>(el: Element, sel: string) => {
  const found = el.querySelector<T & Element>(sel);
  if (!found) throw new Error(`no ${sel}`);
  return found;
};

describe("Amount", () => {
  it("dims trailing zeros and shows sats on hover", () => {
    const el = mount(() => <Amount sats={3_500_000} />);
    expect(el.textContent).toBe("0.03\u202F500\u202F000 BTC");
    expect(q(el, ".amount__zeros").textContent).toBe("00\u202F000");
    expect(q(el, ".amount").title).toBe(`3${NNBSP}500${NNBSP}000 sats`);
  });

  it("signs incoming amounts and survives bad input", () => {
    expect(mount(() => <Amount sats={150} signed />).textContent).toBe(
      "+0.00\u202F000\u202F150 BTC",
    );
    expect(mount(() => <Amount sats={-150} signed />).textContent).toBe(
      "−0.00\u202F000\u202F150 BTC",
    );
    expect(mount(() => <Amount sats={0.5} />).textContent).toBe("–");
    expect(mount(() => <Sats sats={1234} />).textContent).toBe(`1${NNBSP}234 sats`);
  });
});

describe("FeeRate", () => {
  it("shows a swatch only when asked, colored by the printed value", () => {
    expect(mount(() => <FeeRate rate={0.1996} />).querySelector(".fee__swatch")).toBeNull();
    const el = mount(() => <FeeRate rate={0.1996} swatch />);
    expect(el.textContent).toBe("0.20 sat/vB");
    expect(q(el, ".fee__swatch").style.getPropertyValue("--swatch")).toBe("var(--fee-4)");
    expect(mount(() => <FeeRate rate={0.64} approx />).textContent).toBe("~0.64 sat/vB");
  });

  it("keeps a unit hidden from sight for screen readers, where a table names it in its header", () => {
    for (const [el, unit] of [
      [mount(() => <Amount sats={150} unit={false} />), " BTC"],
      [mount(() => <Sats sats={150} unit={false} />), " sats"],
      [mount(() => <FeeRate rate={0.64} unit={false} />), " sat/vB"],
    ] as const) {
      expect(q(el, ".unit").textContent).toBe(unit);
      expect(q(el, ".unit").classList.contains("visually-hidden")).toBe(true);
    }
    expect(
      q(
        mount(() => <Amount sats={150} />),
        ".unit",
      ).classList,
    ).not.toContain("visually-hidden");
  });

  it("has twelve bands in the key", () => {
    const el = mount(() => <FeeKey />);
    const labels = [...el.querySelectorAll(".feekey__label")].map((l) => l.textContent);
    expect(labels).toStrictEqual([
      "0.1",
      "0.12",
      "0.15",
      "0.2",
      "0.3",
      "0.5",
      "1",
      "1.5",
      "2",
      "3",
      "5",
      "10+",
    ]);
    const last = el.querySelectorAll<HTMLElement>(".feekey__swatch")[11];
    expect(last?.style.getPropertyValue("--swatch")).toBe("var(--fee-12)");
  });
});

describe("Hash", () => {
  it("truncates, keeps the full value in the title and links on the current network", () => {
    const el = mount(() => <Hash value={txid} href={`/tx/${txid}`} />, "/signet/block/1");
    const a = q<HTMLAnchorElement>(el, "a");
    expect(a.textContent).toBe("65428488…a3f9c2e1");
    expect(a.title).toBe(txid);
    expect(a.getAttribute("href")).toBe(`/signet/tx/${txid}`);
    expect(el.querySelector("button.copy")).not.toBeNull();
  });

  it("shows a full hash in groups of eight", () => {
    const el = mount(() => <HashFull value={txid} />);
    expect(el.querySelectorAll(".hash__group")).toHaveLength(8);
    expect(q(el, ".hash__text").textContent).toBe(txid);
  });

  it("copies and confirms", async () => {
    const writeText = vi.fn<() => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const el = mount(() => <Hash value={txid} copyLabel="Copy transaction ID" />);
    const button = q<HTMLButtonElement>(el, "button");
    expect(button.textContent).toBe("Copy transaction ID");
    button.click();
    await vi.waitFor(() => expect(button.dataset["copied"]).toBeDefined());
    expect(writeText).toHaveBeenCalledWith(txid);
    // Once in sight beside the icon, once for a screen reader.
    expect(q(button, ".copy__note").textContent).toBe("Copied");
    expect(q(button, "[aria-live]").textContent).toBe("Copied");
  });

  it("renders chain data as text, never as markup", () => {
    const el = mount(() => (
      <>
        <Hash value={hostile} head={40} />
        <HashFull value={hostile} />
      </>
    ));
    expect(el.querySelector("img")).toBeNull();
    expect(q(el, ".hash__text").textContent).toBe(hostile);
  });
});

describe("TimeAgo", () => {
  it("shows relative time with the UTC time in the title", () => {
    const now = Math.floor(Date.now() / 1000);
    const el = mount(() => <TimeAgo time={now - 13 * 60} />);
    const t = q<HTMLTimeElement>(el, "time");
    expect(t.textContent).toBe("13 min ago");
    expect(t.title).toMatch(/ UTC$/);
    expect(t.dateTime).toMatch(/Z$/);
  });
});

describe("DataTable", () => {
  const columns = [
    { header: "Transaction", cell: (r: { id: string; v: number }) => r.id },
    {
      header: "Value, sats",
      cell: (r: { v: number }) => String(r.v),
      numeric: true,
      optional: true,
    },
  ];

  it("renders headers, rows and column classes", () => {
    const rows = [
      { id: hostile, v: 1 },
      { id: "b", v: 2 },
    ];
    const el = mount(() => <DataTable caption="Latest" columns={columns} rows={rows} />);
    expect([...el.querySelectorAll("th")].map((th) => th.textContent)).toStrictEqual([
      "Transaction",
      "Value, sats",
    ]);
    expect(el.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(el.querySelector("img")).toBeNull();
    expect(q(el, "tbody td").textContent).toBe(hostile);
    expect(q(el, "th:last-child").className).toBe("table__num table__optional");
    expect(q(el, "caption").textContent).toBe("Latest");
  });

  it("shows the empty state instead of an empty table", () => {
    const el = mount(() => (
      <DataTable
        caption="x"
        columns={columns}
        rows={[]}
        empty={<Empty title="No transactions" />}
      />
    ));
    expect(el.querySelector("table")).toBeNull();
    expect(el.textContent).toBe("No transactions");
  });
});

describe("Pagination", () => {
  it("disables what cannot be reached and reports the page asked for", () => {
    const onPage = vi.fn<(page: number) => void>();
    const el = mount(() => <Pagination page={1} pageCount={3} onPage={onPage} label="Pages" />);
    const [prev, next] = el.querySelectorAll("button");
    expect(prev?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);
    expect(q(el, ".pagination__status").textContent).toBe("Page 1 of 3");
    next?.click();
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it("follows a total that changes", () => {
    const [count, setCount] = createSignal(3);
    const el = mount(() => <Pagination page={1} pageCount={count()} onPage={() => {}} label="P" />);
    setCount(5);
    flush();
    expect(q(el, ".pagination__status").textContent).toBe("Page 1 of 5");
  });

  it("works without a total", () => {
    const el = mount(() => <Pagination page={4} hasNext={false} onPage={() => {}} label="Pages" />);
    const [prev, next] = el.querySelectorAll("button");
    expect(prev?.disabled).toBe(false);
    expect(next?.disabled).toBe(true);
    expect(q(el, ".pagination__status").textContent).toBe("Page 4");
  });
});

describe("ErrorState", () => {
  it("shows the API's message and retries", () => {
    const retry = vi.fn<() => void>();
    const el = mount(() => (
      <ErrorState
        title="Could not load this block"
        error={new ApiError(404, "Not found.")}
        retry={retry}
      />
    ));
    expect(el.textContent).toContain("Could not load this block");
    expect(el.textContent).toContain("Not found.");
    q<HTMLButtonElement>(el, "button").click();
    expect(retry).toHaveBeenCalledWith();
  });

  it("never shows an unexpected error's internals", () => {
    const el = mount(() => <ErrorState title="Failed" error={new Error("secret stack detail")} />);
    expect(el.textContent).not.toContain("secret");
  });
});
