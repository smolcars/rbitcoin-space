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

/** A route as method and path segments; a parameter's name is left out (`:`). */
const key = (method: string, path: string) => `${method} ${path.replaceAll(/:\w+/g, ":")}`;

/** Whether a documented route stands for a served one: a parameter stands for any segment. */
function covers(doc: string, route: string): boolean {
  const [dm, ...dp] = doc.split(/[ /]/);
  const [sm, ...sp] = route.split(/[ /]/);
  return dm === sm && dp.length === sp.length && dp.every((d, i) => d === sp[i] || d === ":");
}

/** Every route the inventory marks `served`, and the BlindBit routes, optional parts expanded. */
function served(): string[] {
  const out = new Set<string>();
  for (const md of Object.values(COMPAT)) {
    for (const line of md.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells[4] !== "served") continue;
      const route = /^`(GET|POST) (\/[^`?\s]*)/.exec(cells[1] ?? "");
      if (!route) continue;
      for (const path of expand(route[2] ?? "")) out.add(key(route[1] ?? "", `/api${path}`));
    }
  }
  const api = Object.values(API)[0] ?? "";
  const blindbit = api.slice(api.indexOf("### BlindBit v1"), api.indexOf("### Not served"));
  for (const line of blindbit.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const method = /^(GET|POST)\b/.exec(cells[1] ?? "")?.[1];
    if (method === undefined) continue;
    for (const m of (cells[2] ?? "").matchAll(/`(\/[^`]+)`/g)) {
      out.add(key(method, `/api/blindbit/v1${m[1] ?? ""}`));
    }
  }
  return [...out];
}

function documented(): string[] {
  const out = new Set<string>();
  for (const page of PAGES) {
    const md = DOCS[`../../docs/${page.slug === "" ? "index" : page.slug}.md`] ?? "";
    for (const r of routes(page, md)) {
      for (const path of expand(r.path)) out.add(key(r.method, path));
    }
  }
  return [...out];
}

describe("the docs' routes", () => {
  it("read the inventory", () => {
    expect(served().length).toBeGreaterThan(90);
  });

  it("cover every route the server serves", () => {
    const docs = documented();
    expect(served().filter((s) => !docs.some((d) => covers(d, s)))).toStrictEqual([]);
  });

  it("are all served", () => {
    const serving = served();
    expect(documented().filter((d) => !serving.some((s) => covers(d, s)))).toStrictEqual([]);
  });
});
