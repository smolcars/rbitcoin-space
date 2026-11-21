import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexKey, showLabels } from "../../lib/labels";
import { readFile, recordKey } from "../../lib/labels/bip329";
import {
  previewImport,
  readAll,
  remove,
  resetStore,
  runImport,
  setLabel,
} from "../../lib/labels/db";
import { fakeIndexedDB, KeyRange } from "../../lib/labels/fake-idb";
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
    Object.defineProperty(globalThis, "IDBKeyRange", { value: KeyRange, configurable: true });
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIndexedDB().factory,
      configurable: true,
    });
    resetStore();
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
    const removeButton = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Remove label",
    );
    removeButton?.click();
    await until(() => el.querySelector(".your-label") === null);
    expect(el.querySelector(".your-label")).toBeNull();
    expect(button?.textContent).toBe("Add a label");
    expect(el.querySelector("[role=status]")?.textContent).toBe("Label removed");
  });

  it("says plainly when this browser cannot keep labels", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
    resetStore();
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

  it("a save that ends after its editor closed leaves the editor opened since, and its draft, alone", async () => {
    const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
    flush();
    const button = el.querySelector<HTMLButtonElement>(".label-control__open");
    button?.click();
    await until(() => el.querySelector("input") !== null);
    const first = el.querySelector<HTMLInputElement>("input");
    if (!first) throw new TypeError("no field");
    first.value = "first";
    el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    // Closed before that save has ended, and opened again, with something typed.
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    button?.click();
    await until(() => el.querySelector("input") !== null && el.querySelector("input") !== first);
    const second = el.querySelector<HTMLInputElement>("input");
    if (!second) throw new TypeError("no field");
    second.value = "a draft";
    // The first save ends.
    await until(() => el.querySelector(".your-label__text")?.textContent === "first");
    expect(el.querySelector("input")).toBe(second);
    expect(second.value).toBe("a draft");
  });

  it("an editor saved without a change writes nothing, so another tab's newer label stays", async () => {
    await setLabel("tx", TXID, "A");
    const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
    await until(() => el.querySelector(".your-label__text")?.textContent === "A");
    el.querySelector<HTMLButtonElement>(".label-control__open")?.click();
    await until(() => el.querySelector("input") !== null);
    expect(el.querySelector<HTMLInputElement>("input")?.value).toBe("A");
    // Another tab saves B meanwhile.
    await setLabel("tx", TXID, "B");
    await until(() => el.querySelector(".your-label__text")?.textContent === "B");
    // Save, the field untouched: nothing is written, nothing announced as saved.
    el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => el.querySelector("input") === null);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    flush();
    expect(el.querySelector(".your-label__text")?.textContent).toBe("B");
    expect(el.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("saves into the record it was opened for, a wallet's with its origin, and makes none beside it", async () => {
    const origin = "wpkh([aaaaaaaa/84'/0'/0'])";
    const got = (
      await readFile(`{"type":"tx","ref":"${TXID}","label":"wallet","origin":"${origin}"}`)
    ).records;
    await runImport(got, await previewImport(got));
    const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
    await until(() => el.querySelector(".your-label__text")?.textContent === "wallet");
    el.querySelector<HTMLButtonElement>(".label-control__open")?.click();
    await until(() => el.querySelector("input") !== null);
    const field = el.querySelector<HTMLInputElement>("input");
    if (!field) throw new TypeError("no field");
    field.value = "wallet, renamed";
    el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => el.querySelector("input") === null);
    const { records } = await readAll();
    expect(records.map((r) => [r.key, r.label])).toStrictEqual([
      [recordKey("tx", TXID, origin), "wallet, renamed"],
    ]);
  });

  describe("a save applies only to what the editor opened on", () => {
    const open = async (el: HTMLElement) => {
      el.querySelector<HTMLButtonElement>(".label-control__open")?.click();
      await until(() => el.querySelector("input") !== null);
      const field = el.querySelector<HTMLInputElement>("input");
      if (!field) throw new TypeError("no field");
      return field;
    };
    const submit = (el: HTMLElement) =>
      el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    const status = (el: HTMLElement) => el.querySelector(".label-editor__elsewhere")?.textContent;
    const label = async () => (await readAll()).records.map((r) => r.label);

    it("refuses to save over a label deleted and made again elsewhere, keeps the draft, and saves on a second Save", async () => {
      await setLabel("tx", TXID, "first");
      const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
      await until(() => el.querySelector(".your-label__text")?.textContent === "first");
      const field = await open(el);
      field.value = "my draft";
      // Another tab deletes the label and makes one again under the same key.
      await remove([recordKey("tx", TXID, undefined)]);
      await setLabel("tx", TXID, "made again");
      submit(el);
      await until(() => (status(el) ?? "") !== "");
      expect(status(el)).toContain("changed in another tab since you opened it, to “made again”");
      expect(el.querySelector("input")).toBe(field);
      expect(field.value).toBe("my draft");
      expect(document.activeElement).toBe(field);
      await expect(label()).resolves.toStrictEqual(["made again"]);
      submit(el);
      await until(() => el.querySelector("input") === null);
      await expect(label()).resolves.toStrictEqual(["my draft"]);
    });

    it("the reviewer's sequence: a second Save never replaces a label its message did not name", async () => {
      await setLabel("tx", TXID, "original");
      const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
      await until(() => el.querySelector(".your-label__text")?.textContent === "original");
      const field = await open(el);
      field.value = "my draft";
      field.focus();
      // B deletes it and imports the same key.
      await remove([recordKey("tx", TXID, undefined)]);
      const again = (await readFile(`{"type":"tx","ref":"${TXID}","label":"first replacement"}`))
        .records;
      await runImport(again, await previewImport(again));
      submit(el);
      await until(() => (status(el) ?? "").includes("“first replacement”"));
      expect(status(el)).toContain(
        "so nothing was saved. Pressing Save again replaces “first replacement” with what you typed.",
      );
      // B edits that record in place; the page's tag follows, the editor's words do not yet.
      await setLabel("tx", TXID, "second edit in B");
      await until(() => el.querySelector(".your-label__text")?.textContent === "second edit in B");
      submit(el);
      await until(() => (status(el) ?? "").includes("“second edit in B”"));
      expect(status(el)).toContain(
        "Pressing Save again replaces “second edit in B” with what you typed.",
      );
      expect(el.querySelector("input")).toBe(field);
      expect(field.value).toBe("my draft");
      expect(document.activeElement).toBe(field);
      await expect(label()).resolves.toStrictEqual(["second edit in B"]);
      submit(el);
      await until(() => el.querySelector("input") === null);
      await expect(label()).resolves.toStrictEqual(["my draft"]);
    });

    it("refuses to save over a label another tab added after it opened on none, keeps the draft, and saves on a second Save", async () => {
      const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
      flush();
      const field = await open(el);
      field.value = "mine";
      await setLabel("tx", TXID, "theirs");
      submit(el);
      await until(() => (status(el) ?? "") !== "");
      expect(status(el)).toContain("to “theirs”");
      expect(field.value).toBe("mine");
      await expect(label()).resolves.toStrictEqual(["theirs"]);
      submit(el);
      await until(() => el.querySelector("input") === null);
      await expect(label()).resolves.toStrictEqual(["mine"]);
    });
  });

  it("opens its editor as a named dialog that leaves the page usable", async () => {
    const el = mount(() => <LabelControl type="tx" reference={TXID} what="this transaction" />);
    flush();
    el.querySelector<HTMLButtonElement>(".label-control__open")?.click();
    await until(() => el.querySelector(".label-pop") !== null);
    const pop = el.querySelector(".label-pop");
    expect(pop?.getAttribute("role")).toBe("dialog");
    expect(pop?.getAttribute("aria-label")).toBe("Your label for this transaction");
    expect(pop?.hasAttribute("aria-modal")).toBe(false);
  });
});
