import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HINT, labelOf, showLabels } from "../labels";
import { readFile } from "./bip329";
import {
  buildIndex,
  exportFile,
  planImport,
  records,
  refresh,
  remove,
  removeAll,
  reset,
  runImport,
  setLabel,
  VERSION,
} from "./db";
import { fakeIndexedDB } from "./fake-idb";

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";
const ADDR = "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c";

let fake: ReturnType<typeof fakeIndexedDB>;
const use = (options?: Parameters<typeof fakeIndexedDB>[0]) => {
  fake = fakeIndexedDB(options);
  Object.defineProperty(globalThis, "indexedDB", { value: fake.factory, configurable: true });
  reset();
};

beforeEach(() => {
  localStorage.clear();
  showLabels(new Map());
  use();
});
afterEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
});

const shown = (type: Parameters<typeof labelOf>[0], ref: string) => {
  flush();
  return labelOf(type, ref);
};

const lines = async (text: string) => (await readFile(text)).records;

describe("the label store", () => {
  it("adds, edits and removes a label, and the pages see each change", async () => {
    await setLabel("tx", TXID, "rent, March");
    expect(shown("tx", TXID)).toBe("rent, March");
    expect(localStorage.getItem(HINT)).not.toBeNull();
    await setLabel("tx", TXID, "rent, April");
    expect(shown("tx", TXID)).toBe("rent, April");
    expect((await exportFile()).text).toBe(`{"type":"tx","ref":"${TXID}","label":"rent, April"}\n`);
    await setLabel("tx", TXID, null);
    expect(shown("tx", TXID)).toBeUndefined();
    expect((await exportFile()).count).toBe(0);
    expect(localStorage.getItem(HINT)).toBeNull();
  });

  it("treats a blank label as removing it", async () => {
    await setLabel("addr", ADDR, "cold storage");
    await setLabel("addr", ADDR, "   ");
    expect(shown("addr", ADDR)).toBeUndefined();
  });

  it("keeps what is stored across a reload", async () => {
    await setLabel("addr", ADDR, "cold storage");
    reset();
    showLabels(new Map());
    await refresh();
    expect(shown("addr", ADDR)).toBe("cold storage");
  });

  it("keeps a record's other fields when its label is removed", async () => {
    const plan = await planImport(
      await lines(`{"type":"output","ref":"${TXID}:1","label":"x","spendable":false}`),
    );
    await runImport(plan);
    await setLabel("output", `${TXID}:1`, null);
    expect((await exportFile()).text).toBe(
      `{"type":"output","ref":"${TXID}:1","spendable":false}\n`,
    );
  });

  it("shows the label without an origin over one with, else the first", async () => {
    const plan = await planImport(
      await lines(
        [
          `{"type":"tx","ref":"${TXID}","label":"wallet A","origin":"wpkh([aaaaaaaa/84'/0'/0'])"}`,
          `{"type":"tx","ref":"${TXID}","label":"wallet B","origin":"wpkh([bbbbbbbb/84'/0'/0'])"}`,
        ].join("\n"),
      ),
    );
    await runImport(plan);
    expect(shown("tx", TXID)).toBe("wallet A");
    // An edit from the page changes the record the page shows, and keeps its origin.
    await setLabel("tx", TXID, "wallet A, renamed");
    expect((await exportFile()).text).toContain(`"label":"wallet A, renamed","origin"`);
    await setLabel("tx", TXID, null);
    expect(shown("tx", TXID)).toBe("wallet B");
  });

  it("imports by BIP329's rule: the file's label wins, an omitted one keeps the reader's", async () => {
    await setLabel("tx", TXID, "mine");
    await setLabel("addr", ADDR, "mine too");
    const plan = await planImport(
      await lines(
        [
          `{"type":"tx","ref":"${TXID}","label":"theirs"}`,
          `{"type":"addr","ref":"${ADDR}","keypath":"/0/1"}`,
          `{"type":"output","ref":"${TXID}:0","label":"new"}`,
        ].join("\n"),
      ),
    );
    expect(plan.added).toHaveLength(1);
    expect(plan.replaced).toHaveLength(2);
    await runImport(plan);
    expect(shown("tx", TXID)).toBe("theirs");
    expect(shown("addr", ADDR)).toBe("mine too");
    expect(shown("output", `${TXID}:0`)).toBe("new");
    // A replaced record keeps its place; a new one goes last.
    expect((await exportFile()).text.split("\n").slice(0, 3)).toStrictEqual([
      `{"type":"tx","ref":"${TXID}","label":"theirs"}`,
      `{"type":"addr","ref":"${ADDR}","keypath":"/0/1","label":"mine too"}`,
      `{"type":"output","ref":"${TXID}:0","label":"new"}`,
    ]);
  });

  it("keeps xpubs, spscan keys and unknown types, never shown, and exports them untouched", async () => {
    const text = [
      `{"type":"xpub","ref":"xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8","label":"Extended Public Key"}`,
      `{ "type": "spscan", "ref": "spscan1q5zs2pg9q5zs", "label": "scan" }`,
      `{"type":"descriptor","ref":"wpkh([d34db33f/84'/0'/0'])","label":"later type"}`,
    ].join("\n");
    await runImport(await planImport(await lines(text)));
    expect((await exportFile()).text).toBe(`${text}\n`);
    flush();
    expect(buildIndex((await records()).values()).size).toBe(0);
  });

  it("deletes one record, and all of them", async () => {
    await setLabel("tx", TXID, "a");
    await setLabel("addr", ADDR, "b");
    const all = await records();
    await remove([[...all.keys()][0] ?? ""]);
    expect(shown("tx", TXID)).toBeUndefined();
    expect(shown("addr", ADDR)).toBe("b");
    await removeAll();
    expect(shown("addr", ADDR)).toBeUndefined();
    expect(localStorage.getItem(HINT)).toBeNull();
  });

  it("imports 100 000 records in one transaction", async () => {
    const text = Array.from(
      { length: 100_000 },
      (_, i) => `{"type":"output","ref":"${TXID}:${i}","label":"coin ${i}"}`,
    ).join("\n");
    const plan = await planImport(await lines(text));
    const seen: number[] = [];
    await runImport(plan, (done) => seen.push(done));
    expect(seen).toHaveLength(100);
    expect(shown("output", `${TXID}:99999`)).toBe("coin 99999");
    reset();
    expect((await records()).size).toBe(100_000);
  }, 60_000);
});

describe("when storage fails", () => {
  it("says labels cannot be kept when there is no IndexedDB", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
    reset();
    await expect(setLabel("tx", TXID, "x")).rejects.toMatchObject({ kind: "unavailable" });
    expect(shown("tx", TXID)).toBeUndefined();
  });

  it("says labels cannot be kept when opening throws or fails", async () => {
    use({ throwOnOpen: true });
    await expect(records()).rejects.toMatchObject({ kind: "unavailable" });
    use({ failOpen: true });
    await expect(refresh()).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("says the browser is full, and keeps nothing of a write that did not fit", async () => {
    use({ room: 2 });
    await setLabel("tx", TXID, "a");
    const plan = await planImport(
      await lines(
        [0, 1, 2].map((i) => `{"type":"output","ref":"${TXID}:${i}","label":"c"}`).join("\n"),
      ),
    );
    await expect(runImport(plan)).rejects.toMatchObject({ kind: "full" });
    // All or nothing: the database and the pages hold only the first label.
    expect(shown("output", `${TXID}:0`)).toBeUndefined();
    reset();
    expect((await records()).size).toBe(1);
  });

  it("works with localStorage blocked: no hint, the database still read", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      await setLabel("tx", TXID, "a");
      expect(shown("tx", TXID)).toBe("a");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  it("creates the store at version 1, so a later version can migrate from it", async () => {
    await setLabel("tx", TXID, "a");
    const stored = fake.databases.get("rbitcoin-labels");
    expect(stored?.version).toBe(VERSION);
    expect([...(stored?.stores.keys() ?? [])]).toStrictEqual(["records"]);
    const row = [...(stored?.stores.get("records")?.rows.values() ?? [])][0];
    expect(row).toMatchObject({ type: "tx", ref: TXID, label: "a", seq: 1 });
  });
});
