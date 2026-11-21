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

beforeEach(() => {
  clearApiCache();
  answer = async () => new Response("", { status: 500 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/api/tx")) return answer();
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
  [...el.querySelectorAll(".pv-item__title")].map((t) => t.textContent);

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
