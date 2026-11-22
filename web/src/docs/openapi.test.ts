import { describe, expect, it } from "vitest";
import { expand, openapi, routes } from "./openapi";
import { PAGES } from "./pages";

const DOCS = import.meta.glob<string>("../../docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const sources = new Map(
  PAGES.map((p) => [p.slug, DOCS[`../../docs/${p.slug === "" ? "index" : p.slug}.md`] ?? ""]),
);
const page = PAGES[0];

describe("expand", () => {
  it("writes each optional part both ways", () => {
    expect(expand("/a")).toStrictEqual(["/a"]);
    expect(expand("/a[/:b]")).toStrictEqual(["/a", "/a/:b"]);
    expect(expand("/a[/:b]/c[/:d]")).toStrictEqual(["/a/c", "/a/c/:d", "/a/:b/c", "/a/:b/c/:d"]);
  });
});

describe("routes", () => {
  it("reads a route heading's anchor, first paragraph and first answer", () => {
    if (!page) throw new Error("no pages");
    const md = [
      "# T",
      "## Errors",
      "## GET /api/a/:b",
      "",
      "What it answers. More.",
      "",
      "```sh",
      "curl x",
      "```",
      "",
      "```json",
      '{"a":1}',
      "```",
      "### Fields",
      "## GET /api/c",
      "## Errors",
      "```sh",
      "## GET /api/not-a-heading",
      "```",
    ].join("\n");
    const found = routes(page, md);
    expect(found.map((r) => [r.method, r.path, r.id])).toStrictEqual([
      ["GET", "/api/a/:b", "get-api-a-b"],
      ["GET", "/api/c", "get-api-c"],
    ]);
    expect(found[0]?.summary).toBe("What it answers. More.");
    expect(found[0]?.example).toStrictEqual({ lang: "json", text: '{"a":1}' });
    expect(found[1]?.example).toBeUndefined();
  });
});

describe("the document", () => {
  const doc = openapi(sources, "1.2.3") as {
    openapi: string;
    info: { version: string };
    paths: Record<string, Record<string, { operationId: string; parameters?: { name: string }[] }>>;
  };

  it("is OpenAPI 3.1 at the server's version", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.2.3");
  });

  it("has every documented route, each operation once, each path parameter declared", () => {
    const ids = new Set<string>();
    let count = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      expect(path).toMatch(/^\/api\//);
      for (const op of Object.values(ops)) {
        count += 1;
        expect(ids.has(op.operationId) ? op.operationId : "").toBe("");
        ids.add(op.operationId);
        const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        expect((op.parameters ?? []).map((p) => p.name)).toStrictEqual(named);
      }
    }
    const documented = PAGES.flatMap((p) => routes(p, sources.get(p.slug) ?? "")).flatMap((r) =>
      expand(r.path).map((path) => `${r.method} ${path}`),
    );
    expect(count).toBe(new Set(documented).size);
  });
});
