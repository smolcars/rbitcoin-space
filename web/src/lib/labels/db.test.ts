import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HINT, labelOf, recordKey } from "../labels";
import { MAX_BYTES, readFile } from "./bip329";
import {
  exportFile,
  previewImport,
  readAll,
  remove,
  removeAll,
  resetStore,
  runImport,
  setLabel,
  StaleImportError,
  VERSION,
} from "./db";
import { fakeIndexedDB, KeyRange } from "./fake-idb";
import { changed, refresh } from "./store";

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";
const ADDR = "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c";

let fake: ReturnType<typeof fakeIndexedDB>;
const use = (options?: Parameters<typeof fakeIndexedDB>[0]) => {
  fake = fakeIndexedDB(options);
  Object.defineProperty(globalThis, "indexedDB", { value: fake.factory, configurable: true });
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
const importText = async (text: string) => runImport(await previewImport(await lines(text)));

/** As a reload: what this tab read is forgotten and read again from the store. */
const reload = async () => {
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
    expect(localStorage.getItem(HINT)).not.toBeNull();
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
    const plan = await previewImport(
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
    expect(localStorage.getItem(HINT)).not.toBeNull();
    await reload();
    expect(shown("addr", ADDR)).toBeUndefined();
  });

  it("imports 100 000 records in one transaction, and reads them back for pages in slices", async () => {
    const text = Array.from(
      { length: 100_000 },
      (_, i) => `{"type":"output","ref":"${TXID}:${i}","label":"coin ${i}"}`,
    ).join("\n");
    const seen: number[] = [];
    await runImport(await previewImport(await lines(text)), (done) => seen.push(done));
    expect(seen).toHaveLength(100);
    expect(shown("output", `${TXID}:99999`)).toBe("coin 99999");
    await reload();
    expect(shown("output", `${TXID}:99999`)).toBe("coin 99999");
    resetStore();
    expect((await readAll()).records).toHaveLength(100_000);
  }, 60_000);
});

describe("a change made against an older read", () => {
  it("refuses a plan made before another change, so a newer label is never undone", async () => {
    await setLabel("tx", TXID, "old");
    const plan = await previewImport(await lines(`{"type":"tx","ref":"${TXID}","height":800000}`));
    // Another tab, or the editor, changes the label after the file was read.
    await setLabel("tx", TXID, "newer");
    await expect(runImport(plan)).rejects.toMatchObject({ kind: "stale" });
    expect(shown("tx", TXID)).toBe("newer");
    // Planned again, the file's line keeps the newer label.
    await runImport(
      await previewImport(await lines(`{"type":"tx","ref":"${TXID}","height":800000}`)),
    );
    expect((await exportFile()).text).toBe(
      `{"type":"tx","ref":"${TXID}","height":800000,"label":"newer"}\n`,
    );
  });

  it("lets only one of two plans made together pass, so they cannot pass the limit together", async () => {
    const a = await previewImport(await lines(`{"type":"tx","ref":"${TXID}","label":"a"}`));
    const b = await previewImport(await lines(`{"type":"addr","ref":"${ADDR}","label":"b"}`));
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
    resetStore();
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
    await expect(readAll()).rejects.toMatchObject({ kind: "unavailable" });
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
      const plan = await previewImport(
        await lines(
          [0, 1, 2].map((i) => `{"type":"output","ref":"${TXID}:${i}","label":"c"}`).join("\n"),
        ),
      );
      await expect(runImport(plan)).rejects.toMatchObject({ kind: "full" });
      expect(shown("output", `${TXID}:0`)).toBeUndefined();
      resetStore();
      expect((await readAll()).records).toHaveLength(1);
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

  it("starts a store of version 1, which was never released, afresh", async () => {
    // Version 1, the first draft of this feature, only ever on development builds.
    const v1 = fake.factory.open("rbitcoin-labels", 1);
    await new Promise<void>((resolve) => {
      v1.addEventListener("upgradeneeded", () => {
        v1.result.createObjectStore("records", { keyPath: "key" }).put({
          key: `tx\n${TXID}\n`,
          type: "tx",
          ref: TXID,
          label: "draft",
          line: `{"type":"tx","ref":"${TXID}","label":"draft"}`,
          seq: 1,
        });
      });
      v1.addEventListener("success", () => {
        v1.result.close();
        resolve();
      });
    });
    await refresh();
    expect(shown("tx", TXID)).toBeUndefined();
    await setLabel("tx", TXID, "new");
    expect(shown("tx", TXID)).toBe("new");
    expect((await readAll()).records.map((r) => r.key)).toStrictEqual([
      recordKey("tx", TXID, undefined),
    ]);
  });
});

/** localStorage refusing everything: no hint is written, so no tab hears another's change. */
const blockHint = () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("blocked", "SecurityError");
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
  };
};

describe("one truth: the database", () => {
  it("refuses an import whose preview another tab's edit and then this tab's own made old", async () => {
    const unblock = blockHint();
    try {
      await setLabel("tx", TXID, "old");
      // Tab A reads the file and previews it; its line leaves the label out.
      const preview = await previewImport(
        await lines(`{"type":"tx","ref":"${TXID}","height":800000}`),
      );
      // Tab B changes the label; A hears nothing (no hint), then A saves a label of its own.
      await setLabel("tx", TXID, "newer, from tab B");
      await setLabel("addr", ADDR, "A's own");
      const refused = runImport(preview);
      await expect(refused).rejects.toBeInstanceOf(StaleImportError);
      expect(shown("tx", TXID)).toBe("newer, from tab B");
      // The refusal carries the import worked out against the store as it is now.
      const fresh = (await refused.catch((e: unknown) => e)) as StaleImportError;
      await runImport(fresh.fresh);
      expect((await exportFile()).text.split("\n")[0]).toBe(
        `{"type":"tx","ref":"${TXID}","height":800000,"label":"newer, from tab B"}`,
      );
    } finally {
      unblock();
    }
  });

  it("throws away a page's read that a write overlapped, and reads again", async () => {
    const text = Array.from(
      { length: 5000 },
      (_, i) => `{"type":"output","ref":"${TXID}:${i}","label":"coin ${i}"}`,
    ).join("\n");
    await importText(text);
    resetStore();
    // A read in flight, over more rows than one slice...
    const reading = refresh();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // ...when another tab writes straight into the store and its storage event arrives.
    const rows = fake.databases.get("rbitcoin-labels")?.tables.get("shown")?.rows;
    const key = recordKey("output", `${TXID}:0`, undefined);
    rows?.set(key, { key, at: `output:${TXID}:0`, label: "from tab B", plain: true, seq: 1 });
    const heard = changed();
    await reading;
    await heard;
    expect(shown("output", `${TXID}:0`)).toBe("from tab B");
    expect(shown("output", `${TXID}:4999`)).toBe("coin 4999");
  });

  it("refuses an edit that would pass the text this browser keeps", async () => {
    await setLabel("tx", TXID, "a");
    fake.databases
      .get("rbitcoin-labels")
      ?.tables.get("meta")
      ?.rows.set("bytes", MAX_BYTES - 10);
    await expect(setLabel("addr", ADDR, "x".repeat(200))).rejects.toMatchObject({
      kind: "too-big",
    });
    expect(shown("addr", ADDR)).toBeUndefined();
  });

  it("opens again after a failure that came at once, not keeping the failure", async () => {
    use({ throwOnOpen: true });
    await expect(setLabel("tx", TXID, "x")).rejects.toMatchObject({ kind: "unavailable" });
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIndexedDB().factory,
      configurable: true,
    });
    await setLabel("tx", TXID, "x");
    expect(shown("tx", TXID)).toBe("x");
  });

  it("asks for a reload when the store is newer than this page", async () => {
    use({ versionError: true });
    await expect(setLabel("tx", TXID, "x")).rejects.toMatchObject({ kind: "outdated" });
  });
});

describe("the hint", () => {
  it("stays once set, so a delete-all finishing late never hides another tab's newer label", async () => {
    await setLabel("tx", TXID, "a");
    await removeAll();
    // Nothing is left, and the hint stays: it is never taken away once set.
    expect(localStorage.getItem(HINT)).not.toBeNull();
    // One tab deletes everything while another adds a label: whichever finishes last, the hint stays.
    await Promise.all([removeAll(), setLabel("addr", ADDR, "from tab B")]);
    expect(localStorage.getItem(HINT)).not.toBeNull();
    // A new page reads the store, finds the label, and shows it.
    resetStore();
    await refresh();
    expect(shown("addr", ADDR)).toBe("from tab B");
  });
});
