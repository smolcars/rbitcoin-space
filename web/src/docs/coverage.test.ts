// The docs name every public HTTP route the server serves, and only those. The served routes are
// the `served` rows of the compatibility inventory (docs/compat/esplora.md and api-v1.md) and the
// BlindBit table in docs/API.md; the documented ones are the pages' route headings, which
// /openapi.json is made from.
import { describe, expect, it } from "vitest";
import { expand, routes } from "./openapi";
import { PAGES } from "./pages";

const COMPAT = import.meta.glob<string>("../../../docs/compat/{esplora,api-v1}.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const API = import.meta.glob<string>("../../../docs/API.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const DOCS = import.meta.glob<string>("../../docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A route with its parameters' names left out: `GET /api/tx/:` for `GET /api/tx/:txid`. */
const key = (method: string, path: string) => `${method} ${path.replaceAll(/:\w+/g, ":")}`;

/** Every route the inventory marks `served`, and the BlindBit routes, optional parts expanded. */
function served(): Set<string> {
  const out = new Set<string>();
  for (const md of Object.values(COMPAT)) {
    for (const line of md.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells[4] !== "served") continue;
      for (const route of (cells[1] ?? "").matchAll(/`(GET|POST) (\/[^`?\s]*)/g)) {
        // `/v1/historical-price[?currency=]`: the path stops where its query begins.
        const path = (route[2] ?? "").replace(/\[$/, "");
        for (const p of expand(path)) out.add(key(route[1] ?? "", `/api${p}`));
      }
    }
  }
  const api = Object.values(API)[0] ?? "";
  const start = api.indexOf("### BlindBit v1");
  const end = api.indexOf("### Not served", start);
  if (start === -1 || end === -1) throw new Error("docs/API.md: no BlindBit table found");
  for (const line of api.slice(start, end).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const method = /^(GET|POST)\b/.exec(cells[1] ?? "")?.[1];
    if (method === undefined) continue;
    for (const m of (cells[2] ?? "").matchAll(/`(\/[^`]+)`/g)) {
      out.add(key(method, `/api/blindbit/v1${m[1] ?? ""}`));
    }
  }
  return out;
}

function documented(): Set<string> {
  const out = new Set<string>();
  for (const page of PAGES) {
    const md = DOCS[`../../docs/${page.slug === "" ? "index" : page.slug}.md`] ?? "";
    for (const r of routes(page, md)) {
      for (const p of expand(r.path)) out.add(key(r.method, p));
    }
  }
  return out;
}

describe("the docs' routes", () => {
  it("read the inventory", () => {
    expect(served().size).toBeGreaterThan(90);
  });

  it("cover every route the server serves", () => {
    const docs = documented();
    expect([...served()].filter((r) => !docs.has(r))).toStrictEqual([]);
  });

  it("are all served", () => {
    const serving = served();
    expect([...documented()].filter((r) => !serving.has(r))).toStrictEqual([]);
  });
});
