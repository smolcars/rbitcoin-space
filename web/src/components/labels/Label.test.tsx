import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexKey, showLabels } from "../../lib/labels";
import { reset } from "../../lib/labels/db";
import { fakeIndexedDB } from "../../lib/labels/fake-idb";
import { mount } from "../test-utils";
import { LabelControl, LabelOf, YourLabel } from "./Label";

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";

const HOSTILE = [
  `<img src=x onerror="document.title='owned'">`,
  `<script>window.hit=1</script>`,
  // oxlint-disable-next-line no-script-url -- hostile text a label must show as text
  "javascript:alert(1)",
  `Confirmed${String.fromCodePoint(0x20_2e)}✓ 6 blocks`,
  `a\u0000b\u001B[2Jc`,
  `line one\nline two`,
  "W".repeat(5000),
];

/** Waits, flushing, until `ok` holds: the editor's code and the store answer in later tasks. */
const until = (ok: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const end = Date.now() + 5000;
    const look = () => {
      flush();
      if (ok() || Date.now() > end) resolve();
      else setTimeout(look, 0);
    };
    look();
  });

beforeEach(() => {
  showLabels(new Map());
  flush();
});

describe("YourLabel", () => {
  it.each(HOSTILE)("shows %j as inert text, marked as the reader's own", (text) => {
    const el = mount(() => <YourLabel text={text} />);
    flush();
    const tag = el.querySelector(".your-label");
    expect(tag).not.toBeNull();
    // Nothing but the two spans the component draws, and text inside them.
    expect([...el.querySelectorAll("*")].map((n) => n.tagName)).toStrictEqual([
      "SPAN",
      "SPAN",
      "SPAN",
    ]);
    expect(el.querySelector("img, script, a")).toBeNull();
    expect(tag?.textContent?.startsWith("Your label: ")).toBe(true);
    const shown = el.querySelector(".your-label__text")?.textContent ?? "";
    expect(shown.length).toBeLessThanOrEqual(41);
    expect(/[\p{Cc}\p{Cf}]/u.test(shown)).toBe(false);
    expect(tag?.getAttribute("title")?.startsWith("Your label, kept in this browser: ")).toBe(true);
  });
});

describe("LabelOf", () => {
  it("shows the first reference the reader labelled, and nothing when none is", () => {
    const el = mount(() => (
      <LabelOf
        refs={[
          ["output", `${TXID}:0`],
          ["tx", TXID],
        ]}
      />
    ));
    flush();
    expect(el.textContent).toBe("");
    showLabels(new Map([[indexKey("tx", TXID), "rent"]]));
    flush();
    expect(el.textContent).toBe("Your label: rent");
    showLabels(
      new Map([
        [indexKey("tx", TXID), "rent"],
        [indexKey("output", `${TXID}:0`), "change"],
      ]),
    );
    flush();
    expect(el.textContent).toBe("Your label: change");
  });
});

describe("LabelControl", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIndexedDB().factory,
      configurable: true,
    });
    reset();
    localStorage.clear();
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
  });

  it("adds, edits and removes a label from the keyboard, focus coming back to its button", async () => {
    const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
    flush();
    const button = el.querySelector<HTMLButtonElement>(".label-control__open");
    expect(button?.textContent).toBe("Add a label");
    button?.click();
    await until(
      () => el.querySelector("input") !== null && document.activeElement?.tagName === "INPUT",
    );
    const field = el.querySelector<HTMLInputElement>("input");
    expect(document.activeElement).toBe(field);
    expect(el.querySelector("label")?.textContent).toBe("Your label for this transaction");
    if (!field) throw new Error("no field");
    field.value = "rent, March";
    el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => el.querySelector("input") === null);
    expect(el.querySelector(".your-label__text")?.textContent).toBe("rent, March");
    expect(button?.textContent).toBe("Edit label");
    expect(document.activeElement).toBe(button);
    expect(el.querySelector("[role=status]")?.textContent).toBe("Label saved");

    // Escape closes without a change.
    button?.click();
    await until(() => el.querySelector("input") !== null);
    const again = el.querySelector<HTMLInputElement>("input");
    expect(again?.value).toBe("rent, March");
    again?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => el.querySelector("input") === null);
    expect(el.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(button);

    button?.click();
    await until(() => el.querySelector("input") !== null);
    const remove = [...el.querySelectorAll("button")].find((b) => b.textContent === "Remove label");
    remove?.click();
    await until(() => el.querySelector(".your-label") === null);
    expect(el.querySelector(".your-label")).toBeNull();
    expect(button?.textContent).toBe("Add a label");
    expect(el.querySelector("[role=status]")?.textContent).toBe("Label removed");
  });

  it("says plainly when this browser cannot keep labels", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
    reset();
    const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
    el.querySelector<HTMLButtonElement>(".label-control__open")?.click();
    await until(() => el.querySelector("input") !== null);
    const field = el.querySelector<HTMLInputElement>("input");
    if (!field) throw new Error("no field");
    field.value = "x";
    el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => el.querySelector("[role=alert]") !== null);
    expect(el.querySelector("[role=alert]")?.textContent).toMatch(/cannot be kept here/);
    expect(el.querySelector(".your-label")).toBeNull();
  });
});
