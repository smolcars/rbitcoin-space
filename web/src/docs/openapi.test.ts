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
if (!page) throw new Error("no pages");

describe("expand", () => {
  it("writes each optional part both ways", () => {
    expect(expand("/a")).toStrictEqual(["/a"]);
    expect(expand("/a[/:b]")).toStrictEqual(["/a", "/a/:b"]);
    expect(expand("/a[/:b]/c[/:d]")).toStrictEqual(["/a/c", "/a/c/:d", "/a/:b/c", "/a/:b/c/:d"]);
  });
});

describe("routes", () => {
  const md = [
    "# T",
    "## Errors",
    "## GET /api/a/:b",
    "",
    "What it answers. More.",
    "",
    "```sh",
    "curl 'https://rbitcoin.space/api/a/1?asof=x&limit=2'",
    "```",
    "",
    "```http",
    "cache-control: public, max-age=1",
    "```",
    "",
    "```json",
    '{"a":1}',
    "```",
    "",
    "| Parameter | Format |",
    "|---|---|",
    "| `b` | A number |",
    "| `limit` | Required. Up to 10 |",
    "### GET /api/a/:b/child",
    "",
    "The child.",
    "",
    "```json",
    '{"child":1}',
    "```",
    "## GET /api/c",
    "",
    "No answer shown.",
    "",
    "### Fields",
    "",
    "```json",
    '{"not":"c"}',
    "```",
    "## Errors",
    "```text",
    "```word",
    "## GET /api/not-a-heading",
    "```",
    "## POST /api/d",
    "",
    "Takes JSON.",
    "",
    "```sh",
    "curl -X POST -H 'Content-Type: application/json' -d '[]' https://rbitcoin.space/api/d",
    "```",
  ].join("\r\n");
  const found = routes(page, md);

  it("reads what the renderer reads: CRLF, fences and anchors alike", () => {
    expect(found.map((r) => [r.method, r.path, r.id])).toStrictEqual([
      ["GET", "/api/a/:b", "get-api-a-b"],
      ["GET", "/api/a/:b/child", "get-api-a-b-child"],
      ["GET", "/api/c", "get-api-c"],
      ["POST", "/api/d", "post-api-d"],
    ]);
  });

  it("takes each route's own paragraph and answer, never a nested route's or a subsection's", () => {
    expect(found.map((r) => r.summary)).toStrictEqual([
      "What it answers. More.",
      "The child.",
      "No answer shown.",
      "Takes JSON.",
    ]);
    expect(found.map((r) => r.example)).toStrictEqual([
      { lang: "json", text: '{"a":1}' },
      { lang: "json", text: '{"child":1}' },
      undefined,
      undefined,
    ]);
  });

  it("reads parameters from the path, the tables and the request", () => {
    expect(found[0]?.params).toStrictEqual([
      { name: "b", in: "path", required: true, description: "A number" },
      { name: "limit", in: "query", required: true, description: "Required. Up to 10" },
      { name: "asof", in: "query", required: false, description: "" },
    ]);
    expect(found[3]?.body).toBe("application/json");
    expect(found[0]?.body).toBeUndefined();
  });
});

describe("the document", () => {
  interface Op {
    operationId: string;
    tags: string[];
    parameters?: { name: string; in: string; required: boolean }[];
    requestBody?: { content: Record<string, unknown> };
    responses: { "200": { content: Record<string, unknown> } };
  }
  const doc = openapi(sources, "1.2.3") as unknown as {
    openapi: string;
    info: { version: string };
    tags: { name: string }[];
    paths: Record<string, Record<string, Op>>;
  };
  const op = (path: string, method = "get") => doc.paths[path]?.[method];

  it("refuses one route written twice with its parameters named apart", () => {
    const twice = new Map(sources).set(
      "api/transactions",
      "# T\n## GET /api/tx/:txid\n\nOne.\n## GET /api/tx/:id\n\nTwo.\n",
    );
    expect(() => openapi(twice, "1")).toThrow(/one route/);
    const again = new Map(sources).set(
      "api/transactions",
      "# T\n## GET /api/tx/:txid\n\nOne.\n## GET /api/tx/:txid\n\nTwo.\n",
    );
    expect(() => openapi(again, "1")).toThrow(/two headings/);
  });

  it("takes a heading as a route only where the page draws one", () => {
    expect(routes(page, "# T\n## GET `/api/a`\n\nText.\n")).toStrictEqual([]);
  });

  it("is OpenAPI 3.1 at the server's version, its tags each named once", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.2.3");
    const names = doc.tags.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has every documented route, each operation once, each path parameter declared", () => {
    const ids = new Set<string>();
    let count = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      expect(path).toMatch(/^\/api\//);
      for (const o of Object.values(ops)) {
        count += 1;
        expect(ids.has(o.operationId) ? o.operationId : "").toBe("");
        ids.add(o.operationId);
        const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const inPath = (o.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
        expect(inPath).toStrictEqual(named);
        expect(Object.keys(o.responses["200"].content)).toHaveLength(1);
      }
    }
    const documented = PAGES.flatMap((p) => routes(p, sources.get(p.slug) ?? "")).flatMap((r) =>
      expand(r.path).map((path) => `${r.method} ${path}`),
    );
    expect(count).toBe(new Set(documented).size);
  });

  it("names the inputs a call needs and the answers' types", () => {
    const required = (path: string) =>
      (op(path)?.parameters ?? []).filter((p) => p.in === "query" && p.required).map((p) => p.name);
    expect(required("/api/txs/outspends")).toStrictEqual(["txids"]);
    expect(required("/api/v1/lightning/search")).toStrictEqual(["searchText"]);
    expect(required("/api/v1/lightning/channels")).toStrictEqual(["public_key"]);
    const times = op("/api/v1/transaction-times")?.parameters as unknown as Record<
      string,
      unknown
    >[];
    expect(times).toStrictEqual([
      {
        name: "txId[]",
        in: "query",
        required: false,
        description: "A txid; repeat it for each, up to 100. Without any, the answer is []",
        schema: { type: "array", items: { type: "string" } },
        style: "form",
        explode: true,
      },
    ]);
    const optional = (path: string) =>
      (op(path)?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);
    expect(optional("/api/address/{address}/txs")).toStrictEqual(["asof", "after_txid"]);
    expect(optional("/api/address/{address}/txs/summary/{last_seen_txid}")).toStrictEqual(["asof"]);
    expect(optional("/api/address/{address}/txs/mempool")).toStrictEqual([]);
    expect(optional("/api/tx/{txid}/status")).toStrictEqual(["asof"]);
    expect(optional("/api/blindbit/v1/tweak-index/{height}")).toStrictEqual(["dustLimit"]);
    expect(optional("/api/scripthash/{hash}/txs")).toStrictEqual(["asof", "after_txid"]);
    expect(optional("/api/scripthash/{hash}/txs/summary/{last_seen_txid}")).toStrictEqual(["asof"]);
    expect(Object.keys(op("/api/v1/prevouts", "post")?.requestBody?.content ?? {})).toStrictEqual([
      "application/json",
    ]);
    expect(Object.keys(op("/api/tx", "post")?.requestBody?.content ?? {})).toStrictEqual([
      "text/plain",
    ]);
    const type = (path: string, method = "get") =>
      Object.keys(op(path, method)?.responses["200"].content ?? {});
    expect(type("/api/v1/blocks")).toStrictEqual(["application/json"]);
    expect(type("/api/block/{hash}/raw")).toStrictEqual(["application/octet-stream"]);
    expect(type("/api/blocks/tip/height")).toStrictEqual(["text/plain"]);
    expect(type("/api/tx", "post")).toStrictEqual(["text/plain"]);
  });
});
