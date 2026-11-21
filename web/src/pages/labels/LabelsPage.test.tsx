import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { readFile, recordKey } from "../../lib/labels/bip329";
import { LabelEditor } from "../../components/labels/LabelEditor";
import {
  exportFile,
  previewImport,
  readAll,
  remove,
  resetStore,
  runImport,
  setLabel,
} from "../../lib/labels/db";
import { fakeIndexedDB, KeyRange } from "../../lib/labels/fake-idb";
import { changed, type Stored } from "../../lib/labels/store";
import LabelsPage, { pageOf, typeName } from "./LabelsPage";

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";
const KEY = `02${"ab".repeat(32)}`;

describe("pageOf", () => {
  it("puts a transaction, input or output on the reader's network", () => {
    expect(pageOf({ type: "tx", ref: TXID.toUpperCase() }, "signet")).toBe(`/signet/tx/${TXID}`);
    expect(pageOf({ type: "output", ref: `${TXID}:3` }, "mainnet")).toBe(`/tx/${TXID}`);
    expect(pageOf({ type: "input", ref: `${TXID}:0` }, "regtest")).toBe(`/regtest/tx/${TXID}`);
  });

  it("puts an address on its own network, the reader's when its form fits several", () => {
    const tb = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    expect(pageOf({ type: "addr", ref: tb }, "testnet4")).toBe(`/testnet4/address/${tb}`);
    expect(pageOf({ type: "addr", ref: tb }, "mainnet")).toBe(`/signet/address/${tb}`);
    const bc = "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c";
    expect(pageOf({ type: "addr", ref: bc.toUpperCase() }, "signet")).toBe(`/address/${bc}`);
    expect(pageOf({ type: "pubkey", ref: KEY }, "regtest")).toBe(`/regtest/address/${KEY}`);
  });

  it("never gives a page for an xpub, a scan key or an unknown type: nothing is looked up", () => {
    expect(pageOf({ type: "xpub", ref: "xpub661MyMwAqRbc" }, "mainnet")).toBeUndefined();
    expect(pageOf({ type: "spscan", ref: "spscan1q5zs" }, "mainnet")).toBeUndefined();
    expect(pageOf({ type: "descriptor", ref: TXID }, "mainnet")).toBeUndefined();
    // An address record holding a key, or a key record holding an address, is not mapped.
    expect(pageOf({ type: "addr", ref: KEY }, "mainnet")).toBeUndefined();
  });
});

/**
 * Another tab's change, written straight to the store in one transaction, which this tab has not
 * read yet: `put` records (a shown row with each label), `drop` keys. `changed()` then reads it,
 * as the storage event from that tab would.
 */
const behind = (put: readonly Stored[], drop: readonly string[] = []): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open("rbitcoin-labels", 3);
    req.addEventListener("error", () => reject(new Error("could not open")));
    req.addEventListener("success", () => {
      const db = req.result;
      const tx = db.transaction(["records", "shown", "meta"], "readwrite");
      for (const k of drop) {
        tx.objectStore("records").delete(k);
        tx.objectStore("shown").delete(k);
      }
      for (const r of put) {
        tx.objectStore("records").put(r);
        if (r.label !== undefined)
          tx.objectStore("shown").put({
            key: r.key,
            at: `${r.type}:${r.ref}`,
            label: r.label,
            plain: true,
            seq: r.seq,
          });
      }
      // Left open: the stand-in gives every connection one database, the app's among them.
      tx.addEventListener("complete", () => resolve());
      tx.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
/** A tx record as stored, with `label`, at place `seq`. */
const txRecord = (ref: string, label: string, seq: number): Stored => ({
  key: recordKey("tx", ref, undefined),
  type: "tx",
  ref,
  label,
  line: JSON.stringify({ type: "tx", ref, label }),
  seq,
});

/** Waits, flushing, until `ok` holds: the store answers in later tasks. */
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

describe("the manager", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "IDBKeyRange", { value: KeyRange, configurable: true });
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIndexedDB().factory,
      configurable: true,
    });
    resetStore();
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
  });

  it("names a type from a file only by what it is: constructor is no Object", () => {
    expect(typeName("constructor")).toBe("Other (constructor)");
    expect(typeName("__proto__")).toBe("Other (__proto__)");
    expect(typeName("toString")).toBe("Other (toString)");
  });

  it("lists and exports a record named like a plain object's own members", async () => {
    const line = `{"type":"constructor","ref":"__proto__","label":"test"}`;
    const one = (await readFile(line)).records;
    await runImport(one, await previewImport(one));
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    await until(() => (el.textContent ?? "").includes("Other (constructor)"));
    expect(el.textContent).toContain("Other (constructor)");
    let saved: unknown;
    const create = vi.fn<(b: Blob) => string>((b) => {
      saved = b;
      return "blob:x";
    });
    Object.defineProperty(URL, "createObjectURL", { value: create, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn<(u: string) => void>(),
      configurable: true,
    });
    const exportButton = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Export a file",
    );
    exportButton?.click();
    await until(() => saved !== undefined);
    await expect((saved as Blob).text()).resolves.toBe(`${line}\n`);
  });

  it("keeps an open editor and what is typed in it when another label changes", async () => {
    const A = "aa".repeat(32);
    const B = "bb".repeat(32);
    const text = [
      `{"type":"tx","ref":"${A}","label":"A"}`,
      `{"type":"tx","ref":"${B}","label":"B"}`,
    ];
    const both = (await readFile(text.join("\n"))).records;
    await runImport(both, await previewImport(both));
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const editA = () =>
      [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith("Edit the label of transaction aaaaaaaa"),
      );
    await until(() => editA() !== undefined);
    editA()?.click();
    await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
    const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
    if (!field) throw new TypeError("no field");
    field.value = "A, half typed";
    field.focus();
    // Another tab, or this one, changes B.
    await setLabel("tx", B, "B, changed elsewhere");
    await until(() => (el.textContent ?? "").includes("B, changed elsewhere"));
    expect(el.querySelector<HTMLInputElement>("input.label-editor__field")).toBe(field);
    expect(field.value).toBe("A, half typed");
    expect(document.activeElement).toBe(field);
  });

  it("keeps the draft when another tab changes the label being edited, and says so", async () => {
    const A = "aa".repeat(32);
    const one = (await readFile(`{"type":"tx","ref":"${A}","label":"A"}`)).records;
    await runImport(one, await previewImport(one));
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const editA = () =>
      [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith("Edit the label of transaction aaaaaaaa"),
      );
    await until(() => editA() !== undefined);
    editA()?.click();
    await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
    const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
    if (!field) throw new TypeError("no field");
    field.value = "A, my draft";
    field.focus();
    // Another tab changes this very label.
    await setLabel("tx", A, "A, from the other tab");
    await until(() => (el.querySelector(".label-editor__elsewhere")?.textContent ?? "") !== "");
    expect(el.querySelector(".label-editor__elsewhere")?.textContent).toContain(
      "“A, from the other tab”",
    );
    expect(el.querySelector<HTMLInputElement>("input.label-editor__field")).toBe(field);
    expect(field.value).toBe("A, my draft");
    expect(document.activeElement).toBe(field);
  });

  /** Imports `lines` as a file would be. */
  const importLines = async (lines: string[]) => {
    const got = (await readFile(lines.join("\n"))).records;
    await runImport(got, await previewImport(got));
  };
  /** The store's file, as Export would write it. */
  const stored = async () => (await exportFile()).text;
  /** The count the manager shows, and the rows it lists on its page, agree with the export. */
  const agree = async (el: HTMLElement, n: number, onPage = n) => {
    const lines = (await stored()).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(n);
    const count = () => el.querySelector(".labels-page__list .num")?.textContent;
    await until(() => count() === `${n} ${n === 1 ? "label" : "labels"}`);
    expect(count()).toBe(`${n} ${n === 1 ? "label" : "labels"}`);
    expect(el.querySelectorAll("tbody tr:not(.table__note)")).toHaveLength(onPage);
  };

  it("closes the editor when another tab deletes the record being edited, gives the draft back, and writes nothing to a record beside it", async () => {
    // Two records for one transaction: the reader's own, and a wallet's, with an origin.
    const plain = `{"type":"tx","ref":"${TXID}","label":"plain","note":"kept as it is"}`;
    const wallet = `{"type":"tx","ref":"${TXID}","label":"wallet","origin":"wpkh([aaaaaaaa/84'/0'/0'])"}`;
    await importLines([plain, wallet]);
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const edits = () =>
      [...el.querySelectorAll("button")].filter((b) =>
        (b.textContent ?? "").startsWith("Edit the label of transaction f91d0a8a"),
      );
    await until(() => edits().length === 2);
    // Newest first: the wallet's record is the first row.
    expect(el.querySelector("tbody tr")?.textContent).toContain("wallet");
    edits()[0]?.click();
    await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
    const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
    if (!field) throw new TypeError("no field");
    expect(field.value).toBe("wallet");
    field.value = "wallet, my draft";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
    // Another tab deletes the wallet's record.
    await remove([recordKey("tx", TXID, "wpkh([aaaaaaaa/84'/0'/0'])")]);
    await until(() => el.querySelector("input.label-editor__field") === null);
    // The row went, like any deleted row; the editor closed; nothing was written.
    expect(edits()).toHaveLength(1);
    await expect(stored()).resolves.toBe(`${plain}\n`);
    await agree(el, 1);
    // The manager says so, with the draft, as text, and focus on its Dismiss.
    const said = el.querySelector(".labels-page__said");
    expect(said?.textContent).toContain(
      "was deleted or replaced in another tab, so nothing was saved",
    );
    expect(el.querySelector(".labels-page__draft")?.textContent).toBe("wallet, my draft");
    const dismiss = [...(said?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Dismiss",
    );
    expect(document.activeElement).toBe(dismiss);
    // It stays until dismissed.
    await setLabel("tx", "bb".repeat(32), "another");
    await until(() => edits().length === 1 && (el.textContent ?? "").includes("another"));
    expect(el.querySelector(".labels-page__draft")?.textContent).toBe("wallet, my draft");
    dismiss?.click();
    flush();
    expect(el.querySelector(".labels-page__draft")).toBeNull();
    await expect(stored()).resolves.toContain(plain);
  });

  it("closes the editor and gives the draft back when another tab deletes the record and makes one again under its key", async () => {
    const A = "aa".repeat(32);
    await importLines([`{"type":"tx","ref":"${A}","label":"A"}`]);
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const edit = () =>
      [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith("Edit the label of transaction aaaaaaaa"),
      );
    await until(() => edit() !== undefined);
    edit()?.click();
    await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
    const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
    if (!field) throw new TypeError("no field");
    field.value = "A, my draft";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // Another tab: deleted, then the same key imported again, in a new place.
    await remove([recordKey("tx", A, undefined)]);
    await importLines([`{"type":"tx","ref":"${A}","label":"theirs","note":"new"}`]);
    await until(() => el.querySelector(".labels-page__draft") !== null);
    expect(el.querySelector("input.label-editor__field")).toBeNull();
    expect(el.querySelector(".labels-page__said")?.textContent).toContain(
      "was deleted or replaced in another tab, so nothing was saved",
    );
    expect(el.querySelector(".labels-page__draft")?.textContent).toBe("A, my draft");
    await expect(stored()).resolves.toBe(
      `{"type":"tx","ref":"${A}","label":"theirs","note":"new"}\n`,
    );
  });

  it("keeps its status region, a live region, in place from the start, empty", async () => {
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    await until(() => el.querySelector(".labels-page__said") !== null);
    const region = el.querySelector(".labels-page__said");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
  });

  describe("Copy draft", () => {
    // A letter with three combining marks: shown with two, copied with all three.
    const DRAFT = "e\u0301\u0302\u0303 rent";
    const lose = async () => {
      const A = "aa".repeat(32);
      await importLines([`{"type":"tx","ref":"${A}","label":"A"}`]);
      const el = mount(() => <LabelsPage />, "/regtest/labels");
      const edit = () =>
        [...el.querySelectorAll("button")].find((b) =>
          (b.textContent ?? "").startsWith("Edit the label of transaction aaaaaaaa"),
        );
      await until(() => edit() !== undefined);
      edit()?.click();
      await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
      const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
      if (!field) throw new TypeError("no field");
      field.value = DRAFT;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await remove([recordKey("tx", A, undefined)]);
      await until(() => el.querySelector(".labels-page__draft") !== null);
      expect(el.querySelector(".labels-page__draft")?.textContent).not.toBe(DRAFT);
      const copy = [...el.querySelectorAll("button")].find((b) => b.textContent === "Copy draft");
      if (!copy) throw new TypeError("no Copy draft");
      return { el, copy };
    };
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    });

    it("puts the draft on the clipboard as typed, and says so", async () => {
      const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const { el, copy } = await lose();
      copy.click();
      await until(() => (el.textContent ?? "").includes("Draft copied."));
      expect(writeText).toHaveBeenCalledWith(DRAFT);
      expect(el.querySelector(".labels-page__said")?.textContent).toContain("Draft copied.");
    });

    it("without a clipboard, offers the draft as typed in a field, selected to copy by hand", async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      const { el, copy } = await lose();
      copy.click();
      await until(() => el.querySelector<HTMLInputElement>("#labels-draft") !== null);
      await until(() => document.activeElement?.id === "labels-draft");
      const field = el.querySelector<HTMLInputElement>("#labels-draft");
      expect(field?.value).toBe(DRAFT);
      expect(field?.readOnly).toBe(true);
      expect(document.activeElement).toBe(field);
      expect([field?.selectionStart, field?.selectionEnd]).toStrictEqual([0, DRAFT.length]);
      expect(el.querySelector(".labels-page__said")?.textContent).toContain(
        "cannot use the clipboard here",
      );
    });

    it("a copy that ends after its draft was dismissed and another given back says nothing of it", async () => {
      let finish: () => void = () => undefined;
      const writeText = vi.fn<(t: string) => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const B = "bb".repeat(32);
      await importLines([`{"type":"tx","ref":"${B}","label":"B"}`]);
      const { el, copy } = await lose();
      copy.click();
      expect(writeText).toHaveBeenCalledWith(DRAFT);
      // Dismissed, then another label is lost: draft B.
      [...el.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")?.click();
      flush();
      const edit = () =>
        [...el.querySelectorAll("button")].find((b) =>
          (b.textContent ?? "").startsWith("Edit the label of transaction bbbbbbbb"),
        );
      await until(() => edit() !== undefined);
      edit()?.click();
      await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
      const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
      if (!field) throw new TypeError("no field");
      field.value = "draft B";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await remove([recordKey("tx", B, undefined)]);
      await until(() => el.querySelector(".labels-page__draft")?.textContent === "draft B");
      // Copying A ends now.
      finish();
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      flush();
      expect(el.querySelector(".labels-page__said")?.textContent).not.toContain("Draft copied.");
    });

    it("when the browser refuses the clipboard, offers the draft to copy by hand", async () => {
      const writeText = vi.fn<(t: string) => Promise<void>>(() =>
        Promise.reject(new DOMException("denied", "NotAllowedError")),
      );
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const { el, copy } = await lose();
      copy.click();
      await until(() => el.querySelector<HTMLInputElement>("#labels-draft") !== null);
      expect(el.querySelector<HTMLInputElement>("#labels-draft")?.value).toBe(DRAFT);
    });
  });

  describe("a save replaces only what the editor has shown", () => {
    const A = "aa".repeat(32);
    const openA = async () => {
      await importLines([`{"type":"tx","ref":"${A}","label":"A"}`]);
      const el = mount(() => <LabelsPage />, "/regtest/labels");
      const edit = () =>
        [...el.querySelectorAll("button")].find((b) =>
          (b.textContent ?? "").startsWith("Edit the label of transaction aaaaaaaa"),
        );
      await until(() => edit() !== undefined);
      edit()?.click();
      await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
      const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
      if (!field) throw new TypeError("no field");
      field.value = "A, my draft";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      const seq = (await readAll()).records[0]?.seq ?? 0;
      return { el, field, seq };
    };
    const submit = (el: HTMLElement) =>
      el
        .querySelector("form.label-editor")
        ?.dispatchEvent(new Event("submit", { cancelable: true }));
    const note = (el: HTMLElement) =>
      el.querySelector(".label-editor__elsewhere")?.textContent ?? "";

    it("refuses a Save made before the manager read another tab's edit in place, names the text there, and saves on the next", async () => {
      const { el, field, seq } = await openA();
      // Another tab edits A in place; this tab has not read it.
      await behind([txRecord(A, "B1", seq)]);
      submit(el);
      await until(() => note(el) !== "");
      expect(note(el)).toContain("so nothing was saved");
      expect(note(el)).toContain("Pressing Save again replaces “B1” with what you typed.");
      expect(el.querySelector("input.label-editor__field")).toBe(field);
      expect(field.value).toBe("A, my draft");
      expect(document.activeElement).toBe(field);
      await expect(stored()).resolves.toBe(`{"type":"tx","ref":"${A}","label":"B1"}\n`);
      // Again, unread: refused once more, naming the new text.
      await behind([txRecord(A, "B2", seq)]);
      submit(el);
      await until(() => note(el).includes("“B2”"));
      expect(note(el)).toContain("Pressing Save again replaces “B2” with what you typed.");
      expect(field.value).toBe("A, my draft");
      // Against what it last showed: it goes through.
      submit(el);
      await until(() => el.querySelector("input.label-editor__field") === null);
      await expect(stored()).resolves.toBe(`{"type":"tx","ref":"${A}","label":"A, my draft"}\n`);
    });

    it("a 'changed elsewhere' note from the manager's reading binds the next Save: one press replaces the text it names", async () => {
      const { el } = await openA();
      await setLabel("tx", A, "B1");
      await until(() => note(el).includes("“B1”"));
      expect(note(el)).toContain("Pressing Save replaces “B1” with what you typed.");
      submit(el);
      await until(() => el.querySelector("input.label-editor__field") === null);
      await expect(stored()).resolves.toBe(`{"type":"tx","ref":"${A}","label":"A, my draft"}\n`);
    });

    it("a reading that finds the record replaced under its key closes the editor and gives the draft back, the deletion never read on its own", async () => {
      const { el, field, seq } = await openA();
      // Deleted and made again in one go, as one reading would find it.
      await behind([txRecord(A, "theirs", seq + 1)], [recordKey("tx", A, undefined)]);
      expect(el.querySelector("input.label-editor__field")).toBe(field);
      await changed();
      await until(() => el.querySelector(".labels-page__draft") !== null);
      expect(el.querySelector("input.label-editor__field")).toBeNull();
      expect(el.querySelector(".labels-page__draft")?.textContent).toBe("A, my draft");
      await expect(stored()).resolves.toBe(`{"type":"tx","ref":"${A}","label":"theirs"}\n`);
    });
  });

  it("clears the message about a deleted label when another edit starts", async () => {
    const A = "aa".repeat(32);
    const B = "bb".repeat(32);
    await importLines([
      `{"type":"tx","ref":"${A}","label":"A"}`,
      `{"type":"tx","ref":"${B}","label":"B"}`,
    ]);
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const button = (start: string) =>
      [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(start));
    await until(() => button("Edit the label of transaction aaaaaaaa") !== undefined);
    button("Edit the label of transaction aaaaaaaa")?.click();
    await until(() => el.querySelector("input.label-editor__field") !== null);
    await remove([recordKey("tx", A, undefined)]);
    await until(() => el.querySelector(".labels-page__lost") !== null);
    // Nothing typed: the field's words, as it opened, are given back.
    expect(el.querySelector(".labels-page__draft")?.textContent).toBe("A");
    button("Edit the label of transaction bbbbbbbb")?.click();
    await until(() => el.querySelector("input.label-editor__field") !== null);
    expect(el.querySelector(".labels-page__lost")).toBeNull();
  });

  it("on the second page of 100 labels, a deleted label's editor closes, its draft comes back, and nothing is made again", async () => {
    const ref = (i: number) => i.toString(16).padStart(2, "0").repeat(32);
    await importLines(
      Array.from({ length: 100 }, (_, i) => `{"type":"tx","ref":"${ref(i)}","label":"L${i}"}`),
    );
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    await agree(el, 100, 50);
    const next = () =>
      [...el.querySelectorAll("button, a")].find((b) => /next/i.test(b.textContent ?? ""));
    await until(() => next() !== undefined);
    (next() as HTMLElement | undefined)?.click();
    // Newest first: the second page lists L49 to L0.
    const editOf = (i: number) =>
      [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith(`Edit the label of transaction ${ref(i).slice(0, 8)}`),
      );
    await until(() => editOf(10) !== undefined);
    editOf(10)?.click();
    await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
    const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
    if (!field) throw new TypeError("no field");
    field.value = "L10, my draft";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // Another tab deletes it, and with it some records listed before it.
    await remove([recordKey("tx", ref(10), undefined), recordKey("tx", ref(90), undefined)]);
    await until(() => el.querySelector(".labels-page__draft") !== null);
    expect(el.querySelector("input.label-editor__field")).toBeNull();
    expect(el.querySelector(".labels-page__draft")?.textContent).toBe("L10, my draft");
    await agree(el, 98, 48);
    await expect(stored()).resolves.not.toContain(ref(10));
  });

  describe("an open editor's row moving across pages", () => {
    const ref = (i: number) => i.toString(16).padStart(2, "0").repeat(32);
    /** 100 labels, L0 to L99: newest first, page 1 lists L99 to L50 and page 2 L49 to L0. */
    const hundred = () =>
      importLines(
        Array.from({ length: 100 }, (_, i) => `{"type":"tx","ref":"${ref(i)}","label":"L${i}"}`),
      );
    const editOf = (el: HTMLElement, i: number) =>
      [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith(`Edit the label of transaction ${ref(i).slice(0, 8)}`),
      );
    const pageShown = (el: HTMLElement) =>
      el.querySelector(".pagination__status [aria-live]")?.textContent;
    /** Opens the editor of L`i`, from page `at`, and types a draft in it. */
    const open = async (el: HTMLElement, i: number, at: number) => {
      await until(() => editOf(el, 99) !== undefined);
      if (at === 2)
        [...el.querySelectorAll("button")].find((b) => b.textContent === "Next")?.click();
      await until(() => editOf(el, i) !== undefined);
      expect(pageShown(el)).toBe(`Page ${at}`);
      editOf(el, i)?.click();
      await until(() => el.querySelector("input.label-editor__field") !== null);
      const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
      if (!field) throw new TypeError("no field");
      field.value = `L${i}, my draft`;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return field;
    };
    /** The same field, its draft and focus kept, on the page that now holds its row. */
    const kept = (el: HTMLElement, field: HTMLInputElement, i: number, at: number) => {
      expect(pageShown(el)).toBe(`Page ${at}`);
      expect(el.querySelector("input.label-editor__field")).toBe(field);
      expect(field.value).toBe(`L${i}, my draft`);
      expect(document.activeElement).toBe(field);
    };

    it("follows it to an earlier page when another tab deletes records before it", async () => {
      await hundred();
      const el = mount(() => <LabelsPage />, "/regtest/labels");
      const field = await open(el, 49, 2);
      // A selection made backward, from its end to its start.
      field.setSelectionRange(2, 6, "backward");
      await remove([recordKey("tx", ref(99), undefined), recordKey("tx", ref(70), undefined)]);
      await until(() => pageShown(el) === "Page 1" || editOf(el, 99) !== undefined);
      await until(() => el.querySelector(".labels-page__list .num")?.textContent === "98 labels");
      expect(field.value).toBe("L49, my draft");
      kept(el, field, 49, 1);
      // jsdom has no moveBefore: the row was moved by removing it, and focus given back.
      expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toStrictEqual([
        2,
        6,
        "backward",
      ]);
      await agree(el, 98, 50);
    });

    it("follows it to a later page when another tab adds records before it", async () => {
      await hundred();
      const el = mount(() => <LabelsPage />, "/regtest/labels");
      const field = await open(el, 50, 1);
      // Another tab imports two new labels: newest, so listed first.
      await importLines([
        `{"type":"tx","ref":"${"e1".repeat(32)}","label":"new 1"}`,
        `{"type":"tx","ref":"${"e2".repeat(32)}","label":"new 2"}`,
      ]);
      await until(() => el.querySelector(".labels-page__list .num")?.textContent === "102 labels");
      expect(field.value).toBe("L50, my draft");
      kept(el, field, 50, 2);
      await agree(el, 102, 50);
    });

    it("keeps it listed while the reader finds other labels", async () => {
      await hundred();
      const el = mount(() => <LabelsPage />, "/regtest/labels");
      const field = await open(el, 10, 2);
      const find = el.querySelector<HTMLInputElement>("#labels-find");
      if (!find) throw new TypeError("no find field");
      find.value = "L9";
      find.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      // L9 and L90 to L99 match; the row being edited stays, with its editor and draft.
      expect(el.querySelector("input.label-editor__field")).toBe(field);
      expect(field.value).toBe("L10, my draft");
      expect(editOf(el, 95)).toBeDefined();
      expect(editOf(el, 11)).toBeUndefined();
    });

    it("closes the editor when the reader turns the page themselves", async () => {
      await hundred();
      const el = mount(() => <LabelsPage />, "/regtest/labels");
      await open(el, 60, 1);
      [...el.querySelectorAll("button")].find((b) => b.textContent === "Next")?.click();
      await until(() => pageShown(el) === "Page 2");
      expect(pageShown(el)).toBe("Page 2");
      expect(el.querySelector("input.label-editor__field")).toBeNull();
      // And back on page 1 the row shows no editor: it was closed, not hidden.
      [...el.querySelectorAll("button")].find((b) => b.textContent === "Previous")?.click();
      await until(() => pageShown(el) === "Page 1");
      expect(el.querySelector("input.label-editor__field")).toBeNull();
      expect(editOf(el, 60)?.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("deleting the row being edited, here, closes its editor without saying another tab did", async () => {
    const A = "aa".repeat(32);
    await importLines([`{"type":"tx","ref":"${A}","label":"A"}`]);
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const button = (start: string) =>
      [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(start));
    await until(() => button("Edit the label of transaction aaaaaaaa") !== undefined);
    button("Edit the label of transaction aaaaaaaa")?.click();
    await until(() => el.querySelector("input.label-editor__field") !== null);
    button("Delete the label of transaction aaaaaaaa")?.click();
    await until(() => (el.querySelector(".labels-page__said")?.textContent ?? "") !== "");
    expect(el.querySelector(".labels-page__said")?.textContent).toMatch(/^Deleted the label of/);
    expect(el.querySelector(".labels-page__lost")).toBeNull();
    expect(el.querySelector("input.label-editor__field")).toBeNull();
  });

  it("refuses a save of a record that vanished, gives the draft back, and writes nothing", async () => {
    const plain = `{"type":"tx","ref":"${TXID}","label":"plain","note":"kept as it is"}`;
    const origin = "wpkh([aaaaaaaa/84'/0'/0'])";
    await importLines([plain]);
    let given: string | undefined;
    const el = mount(
      () => (
        <LabelEditor
          type="tx"
          reference={TXID}
          record={recordKey("tx", TXID, origin)}
          opened={{ key: recordKey("tx", TXID, origin), seq: 1 }}
          what="transaction f91d0a8a"
          current="wallet"
          gone={(text) => {
            given = text;
          }}
          done={() => {}}
        />
      ),
      "/regtest/labels",
    );
    await until(() => el.querySelector("input") !== null);
    const field = el.querySelector<HTMLInputElement>("input");
    if (!field) throw new TypeError("no field");
    field.value = "wallet, my draft";
    el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => given !== undefined);
    expect(given).toBe("wallet, my draft");
    expect(el.querySelector("[role=alert]")).toBeNull();
    await expect(stored()).resolves.toBe(`${plain}\n`);
  });

  it("says nothing changed elsewhere when the label's text comes back, whatever else changed", async () => {
    const A = "aa".repeat(32);
    await importLines([`{"type":"tx","ref":"${A}","label":"A"}`]);
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const edit = () =>
      [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith("Edit the label of transaction aaaaaaaa"),
      );
    await until(() => edit() !== undefined);
    edit()?.click();
    await until(() => el.querySelector(".label-editor__elsewhere") !== null);
    const region = el.querySelector(".label-editor__elsewhere");
    await setLabel("tx", A, "B");
    await until(() => (region?.textContent ?? "") !== "");
    // An import puts A back, with a note the record did not have.
    await importLines([`{"type":"tx","ref":"${A}","label":"A","note":"new"}`]);
    await until(() => (region?.textContent ?? "") === "");
    expect(region?.textContent).toBe("");
  });

  it("says in one status region, there from the start, what changed elsewhere, and clears it once undone", async () => {
    const A = "aa".repeat(32);
    const one = (await readFile(`{"type":"tx","ref":"${A}","label":"A"}`)).records;
    await runImport(one, await previewImport(one));
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const edit = () =>
      [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith("Edit the label of transaction aaaaaaaa"),
      );
    await until(() => edit() !== undefined);
    edit()?.click();
    await until(() => el.querySelector(".label-editor__elsewhere") !== null);
    const region = el.querySelector(".label-editor__elsewhere");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");
    await setLabel("tx", A, "A, from elsewhere");
    await until(() => (region?.textContent ?? "") !== "");
    expect(el.querySelector(".label-editor__elsewhere")).toBe(region);
    expect(region?.textContent).toContain("“A, from elsewhere”");
    // Changed back to what the editor opened with: nothing to warn of.
    await setLabel("tx", A, "A");
    await until(() => (region?.textContent ?? "") === "");
    expect(el.querySelector(".label-editor__elsewhere")).toBe(region);
    expect(region?.textContent).toBe("");
  });
});
