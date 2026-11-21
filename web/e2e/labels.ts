// The reader's labels for browser tests: written straight into the browser's own store, as the app
// keeps them (src/lib/labels/store.ts, version 2), from a page that loads no app code, so a test
// can start with labels without the manager's page in its requests.
import type { Page } from "@playwright/test";

/** A BIP329 record: its type, reference, label and any other fields, as in a file's line. */
export type Line = { type: string; ref: string; label?: string } & Record<string, unknown>;

const SHOWN = new Set(["tx", "addr", "pubkey", "input", "output"]);

/** The reference as the app compares it: hex and bech32 in lower case, base58 as written. */
function normal(type: string, ref: string): string {
  if (type === "input" || type === "output") {
    const [txid = "", n = ""] = ref.split(":");
    return `${txid.toLowerCase()}:${Number(n)}`;
  }
  if (type === "tx" || type === "pubkey") return ref.toLowerCase();
  if (type === "addr" && /^(bc|tb|bcrt)1/i.test(ref)) return ref.toLowerCase();
  return ref;
}

/** Puts `lines` in the page's origin's label store, as an import would have, replacing any. */
export async function seedLabels(page: Page, lines: readonly Line[]): Promise<void> {
  // The server's liveness route: same origin, no app code, no other request.
  await page.goto("/healthz");
  const records = lines.map((l, i) => {
    const origin = typeof l["origin"] === "string" ? l["origin"] : null;
    return {
      key: JSON.stringify([l.type, normal(l.type, l.ref), origin]),
      type: l.type,
      ref: l.ref,
      ...(l.label === undefined ? {} : { label: l.label }),
      line: JSON.stringify(l),
      seq: i + 1,
      origin,
    };
  });
  const shown = records
    .filter((r) => r.label !== undefined && r.label.trim() !== "" && SHOWN.has(r.type))
    .map((r) => ({
      key: r.key,
      at: `${r.type}:${normal(r.type, r.ref)}`,
      label: r.label,
      plain: r.origin === null,
      seq: r.seq,
    }));
  await page.evaluate(
    ({ rows, show }) =>
      new Promise<void>((resolve, reject) => {
        indexedDB.deleteDatabase("rbitcoin-labels");
        const req = indexedDB.open("rbitcoin-labels", 2);
        req.addEventListener("upgradeneeded", () => {
          const db = req.result;
          db.createObjectStore("records", { keyPath: "key" }).createIndex("seq", "seq");
          db.createObjectStore("shown", { keyPath: "key" });
          db.createObjectStore("meta");
        });
        req.addEventListener("error", () => reject(new Error("could not open")));
        req.addEventListener("success", () => {
          const tx = req.result.transaction(["records", "shown", "meta"], "readwrite");
          for (const { origin: _, ...r } of rows) tx.objectStore("records").put(r);
          for (const r of show) tx.objectStore("shown").put(r);
          tx.objectStore("meta").put(rows.length, "seq");
          tx.objectStore("meta").put(1, "rev");
          tx.addEventListener("complete", () => {
            req.result.close();
            localStorage.setItem("labels", "1");
            resolve();
          });
          tx.addEventListener("error", () => reject(new Error("could not write")));
        });
      }),
    { rows: records, show: shown },
  );
}

/** A file's text from records: one JSON object a line. */
export const bip329 = (lines: readonly Line[]): string =>
  lines.map((l) => `${JSON.stringify(l)}\n`).join("");

/** Labels on the scenario's transaction and its outputs' payees, one of them long, for the sweeps. */
export function labelled(txid: string, addresses: readonly string[]): Line[] {
  return [
    { type: "tx", ref: txid, label: "rent, March" },
    { type: "output", ref: `${txid}:0`, label: "change back to the savings wallet, March" },
    ...addresses.map((a, i) => ({
      type: "addr",
      ref: a,
      label: i === 0 ? `cold storage ${"and more words ".repeat(8)}` : `wallet ${i}`,
    })),
    {
      type: "xpub",
      ref: "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8",
      label: "Extended public key of the old wallet",
    },
  ];
}
