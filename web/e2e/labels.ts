// The reader's labels for browser tests: written straight into the browser's own store, as the app
// keeps them (src/lib/labels/store.ts), from a page that loads no app code, so a test can start
// with labels without the manager's page in its requests.
import type { Page } from "@playwright/test";

/** A BIP329 record: its type, reference, label and any other fields, as in a file's line. */
export type Line = { type: string; ref: string; label?: string } & Record<string, unknown>;

/** The reference as the app compares it: hex and bech32 in lower case, base58 as written. */
function normal(type: string, ref: string): string {
  if (["tx", "input", "output", "pubkey"].includes(type)) return ref.toLowerCase();
  if (type === "addr" && /^(bc|tb|bcrt)1/i.test(ref)) return ref.toLowerCase();
  return ref;
}

/** Puts `lines` in the page's origin's label store, as an import would have. */
export async function seedLabels(page: Page, lines: readonly Line[]): Promise<void> {
  // The server's liveness route: same origin, no app code, no other request.
  await page.goto("/healthz");
  const rows = lines.map((l, i) => ({
    key: `${l.type}\n${normal(l.type, l.ref)}\n${typeof l["origin"] === "string" ? l["origin"] : ""}`,
    type: l.type,
    ref: l.ref,
    ...(l.label === undefined ? {} : { label: l.label }),
    line: JSON.stringify(l),
    seq: i + 1,
  }));
  await page.evaluate(
    (records) =>
      new Promise<void>((resolve, reject) => {
        // From nothing, as version 1 kept it: the app moves it to its current version on opening.
        indexedDB.deleteDatabase("rbitcoin-labels");
        const req = indexedDB.open("rbitcoin-labels", 1);
        req.addEventListener("upgradeneeded", () => {
          req.result.createObjectStore("records", { keyPath: "key" });
        });
        req.addEventListener("error", () => reject(new Error("could not open")));
        req.addEventListener("success", () => {
          const tx = req.result.transaction("records", "readwrite");
          for (const r of records) tx.objectStore("records").put(r);
          tx.addEventListener("complete", () => {
            req.result.close();
            localStorage.setItem("labels", String(Date.now()));
            resolve();
          });
          tx.addEventListener("error", () => reject(new Error("could not write")));
        });
      }),
    rows,
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
