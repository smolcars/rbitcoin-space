import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HINT, labelOf, recordKey } from "../labels";
import { readFile } from "./bip329";
import {
  exportFile,
  planImport,
  records,
  remove,
  removeAll,
  reset,
  resetStore,
  runImport,
  setLabel,
  VERSION,
} from "./db";
import { fakeIndexedDB, KeyRange } from "./fake-idb";
import { refresh } from "./store";

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";
const ADDR = "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c";

let fake: ReturnType<typeof fakeIndexedDB>;
const use = (options?: Parameters<typeof fakeIndexedDB>[0]) => {
  fake = fakeIndexedDB(options);
  Object.defineProperty(globalThis, "indexedDB", { value: fake.factory, configurable: true });
  reset();
  resetStore();
};

beforeEach(() => {
  Object.defineProperty(globalThis, "IDBKeyRange", { value: KeyRange, configurable: true });
  localStorage.clear();
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
const importText = async (text: string) => runImport(await planImport(await lines(text)));

/** As a reload: what this tab read is forgotten and read again from the store. */
const reload = async () => {
  reset();
  resetStore();
  await refresh();
};

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
    await reload();
    expect(shown("addr", ADDR)).toBe("cold storage");
  });

  it("gives every write a new hint, two in the same millisecond included", async () => {
    await setLabel("tx", TXID, "a");
    const first = localStorage.getItem(HINT);
    await setLabel("tx", TXID, "b");
    expect(localStorage.getItem(HINT)).not.toBe(first);
    expect(Number(localStorage.getItem(HINT))).toBe(Number(first) + 1);
  });

  it("keeps a record's other fields when its label is removed, each byte of them", async () => {
    await importText(
      `{"type":"output","ref":"${TXID}:1","label":"x","spendable":false,"value":9007199254740993}`,
    );
    await setLabel("output", `${TXID}:1`, null);
    expect((await exportFile()).text).toBe(
      `{"type":"output","ref":"${TXID}:1","spendable":false,"value":9007199254740993}\n`,
    );
  });

  it("shows the label without an origin over one with, else the first", async () => {
    await importText(
      [
        `{"type":"tx","ref":"${TXID}","label":"wallet A","origin":"wpkh([aaaaaaaa/84'/0'/0'])"}`,
        `{"type":"tx","ref":"${TXID}","label":"wallet B","origin":"wpkh([bbbbbbbb/84'/0'/0'])"}`,
      ].join("\n"),
    );
    expect(shown("tx", TXID)).toBe("wallet A");
    // An edit from the page changes the record the page shows, and keeps its origin.
    await setLabel("tx", TXID, "wallet A, renamed");
    expect((await exportFile()).text).toContain(`"label":"wallet A, renamed","origin"`);
    await setLabel("tx", TXID, null);
    expect(shown("tx", TXID)).toBe("wallet B");
    await importText(`{"type":"tx","ref":"${TXID}","label":"mine"}`);
    expect(shown("tx", TXID)).toBe("mine");
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
      `{"type":"constructor","ref":"__proto__","label":"later type"}`,
    ].join("\n");
    await importText(text);
    expect((await exportFile()).text).toBe(`${text}\n`);
    const rows = fake.databases.get("rbitcoin-labels")?.tables.get("shown")?.rows;
    expect(rows?.size).toBe(0);
  });

  it("deletes one record, and all of them", async () => {
    await setLabel("tx", TXID, "a");
    await setLabel("addr", ADDR, "b");
    await remove([recordKey("tx", TXID, undefined)]);
    expect(shown("tx", TXID)).toBeUndefined();
    expect(shown("addr", ADDR)).toBe("b");
    await removeAll();
    expect(shown("addr", ADDR)).toBeUndefined();
    expect(localStorage.getItem(HINT)).toBeNull();
    await reload();
    expect(shown("addr", ADDR)).toBeUndefined();
  });

  it("imports 100 000 records in one transaction, and reads them back for pages in slices", async () => {
    const text = Array.from(
      { length: 100_000 },
      (_, i) => `{"type":"output","ref":"${TXID}:${i}","label":"coin ${i}"}`,
    ).join("\n");
    const seen: number[] = [];
    await runImport(await planImport(await lines(text)), (done) => seen.push(done));
    expect(seen).toHaveLength(100);
    expect(shown("output", `${TXID}:99999`)).toBe("coin 99999");
    await reload();
    expect(shown("output", `${TXID}:99999`)).toBe("coin 99999");
    reset();
    expect((await records()).size).toBe(100_000);
  }, 60_000);
});

describe("a change made against an older read", () => {
  it("refuses a plan made before another change, so a newer label is never undone", async () => {
    await setLabel("tx", TXID, "old");
    const plan = await planImport(await lines(`{"type":"tx","ref":"${TXID}","height":800000}`));
    // Another tab, or the editor, changes the label after the file was read.
    await setLabel("tx", TXID, "newer");
    await expect(runImport(plan)).rejects.toMatchObject({ kind: "stale" });
    expect(shown("tx", TXID)).toBe("newer");
    // Planned again, the file's line keeps the newer label.
    await runImport(await planImport(await lines(`{"type":"tx","ref":"${TXID}","height":800000}`)));
    expect((await exportFile()).text).toBe(
      `{"type":"tx","ref":"${TXID}","height":800000,"label":"newer"}\n`,
    );
  });

  it("lets only one of two plans made together pass, so they cannot pass the limit together", async () => {
    const a = await planImport(await lines(`{"type":"tx","ref":"${TXID}","label":"a"}`));
    const b = await planImport(await lines(`{"type":"addr","ref":"${ADDR}","label":"b"}`));
    await runImport(a);
    await expect(runImport(b)).rejects.toMatchObject({ kind: "stale" });
    expect(shown("addr", ADDR)).toBeUndefined();
  });

  it("an edit reads its record in its own transaction: another tab's change is kept", async () => {
    await importText(`{"type":"output","ref":"${TXID}:0","label":"x"}`);
    // Another tab sets spendable on the record, straight into the store.
    const db = fake.databases.get("rbitcoin-labels");
    const key = recordKey("output", `${TXID}:0`, undefined);
    const row = db?.tables.get("records")?.rows.get(key) as { line: string };
    row.line = `{"type":"output","ref":"${TXID}:0","label":"x","spendable":false}`;
    await setLabel("output", `${TXID}:0`, "y");
    reset();
    expect((await exportFile()).text).toBe(
      `{"type":"output","ref":"${TXID}:0","label":"y","spendable":false}\n`,
    );
  });
});

describe("when storage fails", () => {
  it("says labels cannot be kept when there is no IndexedDB", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
    resetStore();
    await expect(setLabel("tx", TXID, "x")).rejects.toMatchObject({ kind: "unavailable" });
    expect(shown("tx", TXID)).toBeUndefined();
  });

  it("says so when opening throws or fails, and tries again next time", async () => {
    use({ throwOnOpen: true });
    await expect(records()).rejects.toMatchObject({ kind: "unavailable" });
    use({ failOpen: true });
    await expect(refresh()).rejects.toMatchObject({ kind: "unavailable" });
    // The failure is not kept: once the store answers, the next call opens it.
    const good = fakeIndexedDB();
    Object.defineProperty(globalThis, "indexedDB", { value: good.factory, configurable: true });
    await setLabel("tx", TXID, "x");
    expect(shown("tx", TXID)).toBe("x");
  });

  it("gives up on a store that never answers, and says so", async () => {
    use({ hangOpen: true });
    await expect(setLabel("tx", TXID, "x")).rejects.toMatchObject({ kind: "unavailable" });
  }, 10_000);

  it.each(["request", "commit"] as const)(
    "says the browser is full when the quota is met at the %s, and keeps nothing of that write",
    async (quotaAt) => {
      use({ room: 2, quotaAt });
      await setLabel("tx", TXID, "a");
      const plan = await planImport(
        await lines(
          [0, 1, 2].map((i) => `{"type":"output","ref":"${TXID}:${i}","label":"c"}`).join("\n"),
        ),
      );
      await expect(runImport(plan)).rejects.toMatchObject({ kind: "full" });
      expect(shown("output", `${TXID}:0`)).toBeUndefined();
      reset();
      expect((await records()).size).toBe(1);
    },
  );

  it("asks for a reload when another tab opened a newer version of the store", async () => {
    await setLabel("tx", TXID, "a");
    fake.databases.get("rbitcoin-labels")?.dispatchEvent(new Event("versionchange"));
    await expect(setLabel("tx", TXID, "b")).rejects.toMatchObject({ kind: "outdated" });
  });

  it("works with localStorage blocked: no hint, the store still used", async () => {
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
});

describe("the store's versions", () => {
  it("creates version 2 with its records, what pages show and its revision", async () => {
    await setLabel("tx", TXID, "a");
    const db = fake.databases.get("rbitcoin-labels");
    expect(db?.version).toBe(VERSION);
    expect([...(db?.tables.keys() ?? [])]).toStrictEqual(["records", "shown", "meta"]);
    expect(db?.tables.get("meta")?.rows.get("rev")).toBe(2);
    expect(db?.tables.get("shown")?.rows.get(recordKey("tx", TXID, undefined))).toMatchObject({
      at: `tx:${TXID}`,
      label: "a",
      plain: true,
    });
  });

  it("moves version 1's records to keys no two triples share, and builds what pages show", async () => {
    // Version 1 as it was: type, reference and origin joined by line feeds.
    const v1 = fake.factory.open("rbitcoin-labels", 1);
    await new Promise<void>((resolve) => {
      v1.addEventListener("upgradeneeded", () => {
        const store = v1.result.createObjectStore("records", { keyPath: "key" });
        store.put({
          key: `tx\n${TXID}\n`,
          type: "tx",
          ref: TXID.toUpperCase(),
          label: "rent",
          line: `{"type":"tx","ref":"${TXID.toUpperCase()}","label":"rent"}`,
          seq: 1,
        });
        store.put({
          key: `tx\n${TXID}\nwpkh([aaaaaaaa/84'/0'/0'])`,
          type: "tx",
          ref: TXID,
          label: "wallet",
          line: `{"type":"tx","ref":"${TXID}","label":"wallet","origin":"wpkh([aaaaaaaa/84'/0'/0'])"}`,
          seq: 2,
        });
      });
      v1.addEventListener("success", () => {
        v1.result.close();
        resolve();
      });
    });
    await refresh();
    expect(shown("tx", TXID)).toBe("rent");
    const keys = [...((await records()) as Map<string, unknown>).keys()];
    expect(keys).toStrictEqual([
      recordKey("tx", TXID, undefined),
      recordKey("tx", TXID, "wpkh([aaaaaaaa/84'/0'/0'])"),
    ]);
    await setLabel("tx", TXID, "b");
    expect(Number(localStorage.getItem(HINT))).toBeGreaterThan(0);
  });
});
