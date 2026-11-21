// The privacy check as drawn: hostile addresses stay text, the clean and partly checked lines, the
// notice before sending, and the marks on a card.
import { describe, expect, it } from "vitest";
import { mount } from "../../components/test-utils";
import type { Transaction, Vout } from "../../lib/esplora";
import { checkPrivacy } from "../../lib/privacy";
import { CardMarks, runs, TxPrivacy, UnsentPrivacy } from "./Privacy";

const HOSTILE = '<img src=x onerror="alert(1)">bcrt1qhostile';

function out(address: string, value: number, script: string): Vout {
  return {
    scriptpubkey: script,
    scriptpubkey_asm: "",
    scriptpubkey_type: "v0_p2wpkh",
    scriptpubkey_address: address,
    value,
  };
}

/** One input at `address`, paying 30,001 sats away and 60,001 back to `address`. */
function payback(address: string): Transaction {
  const me = out(address, 100_000, `0014${"11".repeat(20)}`);
  return {
    txid: "f".repeat(64),
    version: 2,
    locktime: 0,
    status: { confirmed: true },
    vin: [{ txid: "a".repeat(64), vout: 0, is_coinbase: false, prevout: me }],
    vout: [out("bcrt1qyou", 30_001, `0014${"22".repeat(20)}`), { ...me, value: 60_001 }],
  };
}

describe("the list under the flow", () => {
  it("sets a hostile address as text, shortened, whole in its title", () => {
    const el = mount(() => <TxPrivacy place="under" report={checkPrivacy(payback(HOSTILE))} />);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("[onerror]")).toBeNull();
    const shown = el.querySelector(".pv-item .hash__text");
    expect(shown?.getAttribute("title")).toBe(HOSTILE);
    expect(shown?.textContent).toBe(`${HOSTILE.slice(0, 8)}…${HOSTILE.slice(-8)}`);
    expect(el.querySelector("h3")?.textContent).toBe("What an observer can read");
    expect(el.textContent).toContain("Output 1 reads as change, output 0 as the payment");
  });

  it("is one muted line for a clean transaction, with what it checks", () => {
    const t = payback("bcrt1qme");
    const clean: Transaction = { ...t, vout: [out("bcrt1qyou", 90_000, `0014${"22".repeat(20)}`)] };
    const el = mount(() => <TxPrivacy place="under" report={checkPrivacy(clean)} />);
    expect(el.querySelector(".pv-none")?.textContent).toBe(
      "Nothing in this transaction's shape stands out.",
    );
    expect(el.querySelector("h3")).toBeNull();
    expect(el.querySelector("summary")?.textContent).toBe("What this checks");
  });

  it("never says nothing stands out when only part could be checked", () => {
    const t = payback("bcrt1qme");
    const part: Transaction = {
      ...t,
      vin: [{ txid: "a".repeat(64), vout: 0, is_coinbase: false, prevout: null }],
      vout: [out("bcrt1qyou", 90_000, `0014${"22".repeat(20)}`)],
    };
    const el = mount(() => <TxPrivacy place="under" report={checkPrivacy(part)} />);
    expect(el.textContent).not.toContain("stands out");
    expect(el.querySelector(".pv-none")?.textContent).toBe(
      "Nothing was found in the part that could be checked.",
    );
    expect(el.querySelector(".pv-partial")?.textContent).toContain(
      "What input 0 spends is not known here",
    );
  });
});

describe("the notice before sending", () => {
  it("says what sending would show, and that the wallet can still change it", () => {
    const el = mount(() => (
      <UnsentPrivacy report={checkPrivacy(payback("bcrt1qme"))} state="unsent" />
    ));
    expect(el.querySelector("h2")?.textContent).toBe(
      "Once it is sent, anyone can read this from it",
    );
    expect(el.querySelector(".pv-closing")?.textContent).toBe(
      "It is not sent yet: a wallet can still change which coins it spends and where the change goes.",
    );
  });
});

describe("the notice once sent, and with nothing to show", () => {
  it("says what the transaction page says once sent: no 'not sent yet'", () => {
    const el = mount(() => (
      <UnsentPrivacy report={checkPrivacy(payback("bcrt1qme"))} state="sent" />
    ));
    expect(el.querySelector("h2")?.textContent).toBe("What an observer can read");
    expect(el.querySelector(".pv-closing")).toBeNull();
    expect(el.textContent).toContain("Output 1 reads as change, output 0 as the payment");
  });
  it("is whole and quiet for a clean transaction not yet sent", () => {
    const t = payback("bcrt1qme");
    const clean: Transaction = { ...t, vout: [out("bcrt1qyou", 90_000, `0014${"22".repeat(20)}`)] };
    const el = mount(() => <UnsentPrivacy report={checkPrivacy(clean)} state="unsent" />);
    expect(el.querySelector("h2")?.textContent).toBe(
      "Once it is sent, anyone can read this from it",
    );
    expect(el.querySelector(".pv-none")?.textContent).toBe(
      "Nothing in this transaction's shape stands out.",
    );
    expect(el.querySelector(".pv-closing")).not.toBeNull();
    expect(el.querySelector("summary")?.textContent).toBe("What this checks");
  });
});

describe("marks on a card", () => {
  it("are words beside an eye the screen reader skips", () => {
    const el = mount(() => (
      <span>
        <CardMarks
          marks={[
            { text: "Reused address", short: "Reused", tone: "caution", kind: "reuse" },
            { text: "Equal amount", short: "Equal", tone: "neutral", kind: "coinjoin" },
          ]}
        />
      </span>
    ));
    expect(
      [...el.querySelectorAll(".pv-tag")].map((t) => t.getAttribute("aria-label")),
    ).toStrictEqual(["Reused address", "Equal amount"]);
    expect([...el.querySelectorAll(".pv-tag__short")].map((t) => t.textContent)).toStrictEqual([
      "Reused",
      "Equal",
    ]);
    // Each a link to its finding in the list.
    expect([...el.querySelectorAll("a.pv-tag")].map((t) => t.getAttribute("href"))).toStrictEqual([
      "#pv-reuse",
      "#pv-coinjoin",
    ]);
    expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a number in a sentence", () => {
  it("takes the punctuation right after it, so the two never part, and leaves words alone", () => {
    const n = (index: number) => ({ ref: "in" as const, index });
    expect(
      runs(["Inputs ", n(0), ", ", n(3), " and ", n(4), " spend from ", { address: "a" }, "."]),
    ).toStrictEqual([
      { text: "Inputs " },
      { ref: "in", index: 0, tail: "," },
      { text: " " },
      { ref: "in", index: 3, tail: "" },
      { text: " and " },
      { ref: "in", index: 4, tail: "" },
      { text: " spend from " },
      { address: "a" },
      { text: "." },
    ]);
    expect(runs(["(input ", n(11), "), and the other"])).toStrictEqual([
      { text: "(input " },
      { ref: "in", index: 11, tail: ")," },
      { text: " and the other" },
    ]);
  });
});
