import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
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

  it("keeps the row, the editor and its draft when another tab deletes that label, and says so", async () => {
    const A = "aa".repeat(32);
    const B = "bb".repeat(32);
    const text = [
      `{"type":"tx","ref":"${A}","label":"A"}`,
      `{"type":"tx","ref":"${B}","label":"B"}`,
    ];
    const both = (await readFile(text.join("\n"))).records;
    await runImport(both, await previewImport(both));
    const el = mount(() => <LabelsPage />, "/regtest/labels");
    const button = (start: string) =>
      [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(start));
    await until(() => button("Edit the label of transaction aaaaaaaa") !== undefined);
    button("Edit the label of transaction aaaaaaaa")?.click();
    await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
    const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
    if (!field) throw new TypeError("no field");
    field.value = "A, my draft";
    field.focus();
    // Another tab deletes A.
    await remove([recordKey("tx", A, undefined)]);
    await until(() => (el.querySelector(".label-editor__elsewhere")?.textContent ?? "") !== "");
    expect(el.querySelector(".label-editor__elsewhere")?.textContent).toContain(
      "deleted elsewhere",
    );
    expect(el.querySelector<HTMLInputElement>("input.label-editor__field")).toBe(field);
    expect(field.value).toBe("A, my draft");
    expect(document.activeElement).toBe(field);
    // Cancel lets it go: the row leaves the list.
    button("Cancel")?.click();
    await until(() => button("Edit the label of transaction aaaaaaaa") === undefined);
    expect(button("Edit the label of transaction aaaaaaaa")).toBeUndefined();
    expect(button("Edit the label of transaction bbbbbbbb")).toBeDefined();
  });

  it("makes a label deleted elsewhere again when its draft is saved", async () => {
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
    await until(() => el.querySelector<HTMLInputElement>("input.label-editor__field") !== null);
    const field = el.querySelector<HTMLInputElement>("input.label-editor__field");
    if (!field) throw new TypeError("no field");
    field.value = "A, again";
    await remove([recordKey("tx", A, undefined)]);
    await until(() => (el.querySelector(".label-editor__elsewhere")?.textContent ?? "") !== "");
    el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => el.querySelector("input.label-editor__field") === null);
    const { records } = await readAll();
    expect(records.map((r) => r.label)).toStrictEqual(["A, again"]);
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
