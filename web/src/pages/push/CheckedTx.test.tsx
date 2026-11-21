// The notice before sending (docs/FRONTEND.md "Privacy check"): "It is not sent yet" only for a
// transaction this page has never tried to send. After a press, whatever came back, never again.
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import type { Transaction } from "../../lib/esplora";
import { CheckedTx } from "./CheckedTx";

const NOT_SENT =
  "It is not sent yet: a wallet can still change which coins it spends and where the change goes.";

/** What the broadcast route answers, for this test. */
let answer: () => Promise<Response>;
/** Every URL the page asked for. */
let asked: string[] = [];

beforeEach(() => {
  clearApiCache();
  asked = [];
  answer = async () => new Response("", { status: 500 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    asked.push(url);
    if (init?.method === "POST" && url.endsWith("/api/tx")) return answer();
    // Output 1 already spent by a child in the mempool, output 0 not.
    if (url.endsWith("/outspends"))
      return Response.json([
        { spent: false },
        { spent: true, txid: "c".repeat(64), vin: 0, status: { confirmed: false } },
      ]);
    return Response.json({ fastestFee: 2 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

let made = 0;
/** A transaction of two coins from one address to two outputs; each call a new txid. */
function checked(): { tx: Transaction; known: null } {
  made += 1;
  const coin = {
    scriptpubkey: `0014${"11".repeat(20)}`,
    scriptpubkey_asm: "",
    scriptpubkey_type: "v0_p2wpkh" as const,
    scriptpubkey_address: "bcrt1qsame",
    value: 100_000,
  };
  const input = (n: number) => ({
    txid: n.toString(16).padStart(64, "0"),
    vout: 0,
    is_coinbase: false,
    sequence: 0xfffffffd,
    scriptsig: "",
    prevout: coin,
  });
  return {
    tx: {
      txid: made.toString(16).padStart(64, "a"),
      version: 2,
      locktime: 0,
      size: 300,
      weight: 900,
      fee: 1_000,
      vin: [input(1), input(2)],
      vout: [
        {
          ...coin,
          scriptpubkey: `0014${"22".repeat(20)}`,
          scriptpubkey_address: "bcrt1qyou",
          value: 123_457,
        },
        { ...coin, value: 75_543 },
      ],
      status: { confirmed: false },
    },
    known: null,
  };
}

const text = (el: HTMLElement) => el.textContent ?? "";
/** Presses Broadcast and lets the page draw what the press changed. */
function press(el: HTMLElement) {
  const button = [...el.querySelectorAll("button")].find((b) =>
    b.textContent.startsWith("Broadcast"),
  );
  expect(button).toBeDefined();
  button?.click();
  flush();
}
/** The findings' titles: "What this checks" also names coins spent together, as a check. */
const titles = (el: HTMLElement) =>
  [...el.querySelectorAll(".pv-item__title > span:first-child")].map((t) => t.textContent);

/** Before any press: the notice for an unsent transaction, coins spent together included. */
function unsent(el: HTMLElement) {
  expect(text(el)).toContain("Once it is sent, anyone can read this from it");
  expect(text(el)).toContain(NOT_SENT);
  expect(titles(el)).toContain("Coins spent together");
}

/** After a press: what the transaction page says, and nothing about whether it was sent. */
function attempted(el: HTMLElement) {
  expect(text(el)).toContain("What an observer can read");
  expect(text(el)).not.toContain(NOT_SENT);
  expect(titles(el)).not.toContain("Coins spent together");
  expect(text(el)).not.toContain("Once it is sent");
  expect(text(el)).not.toMatch(/may already be public|could not be confirmed/);
}

const refusal = (error: string) => async () => Response.json({ error }, { status: 400 });

describe("the notice before sending", () => {
  it("never pressed: says it is not sent", () => {
    expect.hasAssertions();
    const c = checked();
    unsent(mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push"));
  });

  it.each([
    ["the node's refusal", refusal("min relay fee")],
    ["the node's duplicate", refusal("transaction already in the mempool or chain")],
    ["the same transaction in the mempool", refusal("txn-same-nonwitness-data-in-mempool")],
    ["missing or spent inputs", refusal("missing or spent inputs")],
    ["a 5xx", async () => Response.json({ error: "upstream unavailable" }, { status: 502 })],
    [
      "a dropped connection",
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("after a press answered by %s: never again says it is not sent", async (_, reply) => {
    answer = reply;
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    unsent(el);
    press(el);
    attempted(el);
    // Whatever the button's own line says once the answer is in, the notice stays as it is.
    await vi.waitFor(() => expect(el.querySelector(".push-send__why")).not.toBeNull());
    attempted(el);
  });

  it("while the answer is awaited: already says nothing about being unsent", () => {
    expect.hasAssertions();
    answer = () =>
      new Promise<Response>(() => {
        // Never answers.
      });
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    press(el);
    attempted(el);
  });

  it("confirmed sent: as the transaction page", async () => {
    const c = checked();
    answer = async () => new Response(c.tx.txid, { status: 200 });
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    press(el);
    await vi.waitFor(() => expect(text(el)).toContain("Follow it on its page"));
    attempted(el);
  });

  it("remade after a press, its view still never says it is not sent", async () => {
    answer = refusal("min relay fee");
    const c = checked();
    const first = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    press(first);
    await vi.waitFor(() => expect(first.querySelector(".push-send__why")).not.toBeNull());
    attempted(mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push"));
    // Another transaction is its own: never pressed, so not sent.
    const other = checked();
    unsent(mount(() => <CheckedTx c={other} hex="00" enabled />, "/regtest/tx/push"));
  });
});

/** Presses the open details' Close button, failing when the details or the button are not there. */
function closeDetails(el: HTMLElement) {
  const close = [...el.querySelectorAll<HTMLButtonElement>("#tx-inspector button")].find(
    (b) => b.textContent === "Close",
  );
  if (!close) throw new Error("no details open, or no Close button in them");
  close.click();
  flush();
}

/** 300 outputs, the last paying the inputs' address back: its number is far down the flow. */
function farPayback() {
  const c = checked();
  const [, back] = c.tx.vout;
  c.tx.vout = Array.from({ length: 300 }, (_, i) =>
    i === 299 && back
      ? { ...back, value: 500 }
      : {
          scriptpubkey: `0014${i.toString(16).padStart(40, "0")}`,
          scriptpubkey_asm: "",
          scriptpubkey_type: "v0_p2wpkh" as const,
          scriptpubkey_address: `bcrt1qfar${i}`,
          value: 500 + i,
        },
  );
  return c;
}
/** Follows output 299's first number, which opens its details; gives the number. */
function openFar(el: HTMLElement): HTMLAnchorElement {
  const chip = el.querySelector<HTMLAnchorElement>('a[aria-label="Show output 299"]');
  if (!chip) throw new Error("no number for output 299");
  chip.click();
  flush();
  expect(el.querySelector("#tx-inspector")?.textContent).toContain("Output 299");
  return chip;
}
const numbersFor299 = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLAnchorElement>('a[href="#flow-out-299"]'),
];

describe("whether its outputs are spent", () => {
  const spendsAsked = () => asked.filter((u) => u.endsWith("/outspends"));
  /** Opens output `i`'s details and gives their text. */
  const details = (el: HTMLElement, i: number) => {
    el.querySelector<HTMLButtonElement>(`button[aria-label="Details of output ${i}"]`)?.click();
    flush();
    return el.querySelector("#tx-inspector")?.textContent ?? "";
  };

  it("before sending, no card or detail says, and nothing is asked", () => {
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    expect(el.querySelectorAll(".tx-flow__status")).toHaveLength(0);
    expect(details(el, 0)).not.toContain("Spent");
    expect(spendsAsked()).toStrictEqual([]);
  });

  it("an unspendable output still says so before sending", () => {
    const c = checked();
    c.tx.vout.push({
      scriptpubkey: "6a0568656c6c6f",
      scriptpubkey_asm: "",
      scriptpubkey_type: "op_return",
      value: 0,
    });
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    expect(details(el, 2)).toContain("Unspendable");
  });

  it("once the node has taken it from this page, the cards say what spent it", async () => {
    const c = checked();
    answer = async () => new Response(c.tx.txid, { status: 200 });
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    press(el);
    await vi.waitFor(() => expect(el.querySelectorAll(".tx-flow__spent")).toHaveLength(1));
    expect(spendsAsked()).toHaveLength(1);
    expect(details(el, 1)).toContain("Being spent");
  });

  it("while the reply is awaited, nothing says whether its outputs are spent", () => {
    answer = () =>
      new Promise<Response>(() => {
        // Never answers.
      });
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    press(el);
    expect(el.querySelectorAll(".tx-flow__status")).toHaveLength(0);
    expect(spendsAsked()).toStrictEqual([]);
  });

  it("a reply naming another transaction is not taken as sent", async () => {
    const c = checked();
    answer = async () => new Response("b".repeat(64), { status: 200 });
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    press(el);
    await vi.waitFor(() =>
      expect(el.querySelector(".push-send__why")?.textContent).toBe(
        "The server sent a reply that could not be read.",
      ),
    );
    expect(text(el)).not.toContain("Follow it on its page");
    expect(spendsAsked()).toStrictEqual([]);
  });

  it("closed, a card's details give the focus back to its button", async () => {
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    const open = el.querySelector<HTMLButtonElement>('button[aria-label="Details of output 0"]');
    if (!open) throw new Error("no details button for output 0");
    open.click();
    flush();
    expect(el.querySelector("#tx-inspector")?.textContent).toContain("Output 0");
    closeDetails(el);
    await vi.waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("a card's button pressed again closes its details and keeps the focus, never the page's", async () => {
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    const open = el.querySelector<HTMLButtonElement>('button[aria-label="Details of output 1"]');
    if (!open) throw new Error("no details button for output 1");
    // Clicks that do not move the focus, as Safari's on a button do not.
    open.click();
    flush();
    const heading = el.querySelector("#tx-inspector-title");
    expect(heading?.textContent).toBe("Output 1");
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    open.click();
    flush();
    expect(el.querySelector("#tx-inspector")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("closed, details give the focus to the button clicked, not to one focused before", async () => {
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    const before = el.querySelector<HTMLButtonElement>('button[aria-label="Details of input 0"]');
    const open = el.querySelector<HTMLButtonElement>('button[aria-label="Details of output 1"]');
    if (!before || !open) throw new Error("no details buttons");
    before.focus();
    // A pointer that does not move the focus, as Safari's click on a button does not.
    open.click();
    flush();
    expect(document.activeElement).toBe(before);
    expect(el.querySelector("#tx-inspector")?.textContent).toContain("Output 1");
    closeDetails(el);
    await vi.waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("closed after the number that opened them is gone, details give the focus to another number for that output", async () => {
    const c = farPayback();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    const chip = openFar(el);
    chip.remove();
    const others = numbersFor299(el);
    expect(others.length).toBeGreaterThan(0);
    closeDetails(el);
    await vi.waitFor(() => expect(others).toContain(document.activeElement));
  });

  it("closed after another number for the same output was followed, details give the focus to that one", async () => {
    const c = farPayback();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    const first = openFar(el);
    const second = numbersFor299(el).find((a) => a !== first);
    if (!second) throw new Error("no second number for output 299");
    // Followed while the details are open: it is now what opened them.
    second.click();
    flush();
    expect(el.querySelector("#tx-inspector")?.textContent).toContain("Output 299");
    closeDetails(el);
    await vi.waitFor(() => expect(document.activeElement).toBe(second));
    expect(first.isConnected).toBe(true);
  });

  it("closed with no number for that output left, details give the focus to that side's Show more", async () => {
    const c = farPayback();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    openFar(el);
    for (const a of numbersFor299(el)) a.remove();
    closeDetails(el);
    const more = el.querySelector(".tx-flow__col--out .tx-flow__more");
    expect(more).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("closed after Broadcast redrew the check, details give the focus to the new number, never to the page", async () => {
    answer = refusal("min relay fee");
    const c = farPayback();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    const chip = openFar(el);
    press(el);
    await vi.waitFor(() => expect(text(el)).not.toContain(NOT_SENT));
    flush();
    // The press redrew every finding: the number that opened the details is gone.
    expect(chip.isConnected).toBe(false);
    const now = numbersFor299(el);
    expect(now.length).toBeGreaterThan(0);
    closeDetails(el);
    await vi.waitFor(() => expect(now).toContain(document.activeElement));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a refusal, or a press with no answer, never makes it known", async () => {
    answer = refusal("min relay fee");
    const c = checked();
    const el = mount(() => <CheckedTx c={c} hex="00" enabled />, "/regtest/tx/push");
    press(el);
    await vi.waitFor(() => expect(el.querySelector(".push-send__why")).not.toBeNull());
    expect(el.querySelectorAll(".tx-flow__status")).toHaveLength(0);
    expect(spendsAsked()).toStrictEqual([]);
  });
});
