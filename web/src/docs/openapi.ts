// /openapi.json, made from the docs' own Markdown: every `## METHOD /path` heading is an
// operation, its first paragraph the summary, the example under it the example answer. One source,
// so the description cannot drift from the pages (docs/FRONTEND.md "Public docs").

import { plain, slug } from "./markdown";
import { type DocPage, href, PAGES, SITE } from "./pages";

/** A route heading: `## GET /api/tx/:txid`, an optional part in brackets (`/blocks[/:height]`). */
const ROUTE = /^(#{2,4}) (GET|POST) (\/api\/\S*)$/;

export interface Route {
  method: "GET" | "POST";
  /** As written, `:name` for a parameter and `[...]` round an optional part. */
  path: string;
  page: DocPage;
  /** The heading's anchor on its page. */
  id: string;
  summary: string;
  example?: { lang: string; text: string };
}

/** Both forms of a path with an optional part: `/a[/:b]` is `/a` and `/a/:b`. */
export function expand(path: string): string[] {
  const open = path.indexOf("[");
  const close = path.indexOf("]", open);
  if (open === -1 || close === -1) return [path];
  const before = path.slice(0, open);
  const after = path.slice(close + 1);
  return [...expand(before + after), ...expand(before + path.slice(open + 1, close) + after)];
}

/** The routes a page documents, in its order. */
export function routes(page: DocPage, md: string): Route[] {
  const lines = md.split("\n");
  const found: Route[] = [];
  const ids = new Map<string, number>();
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{2,4}) (.+)$/.exec(line);
    if (!heading) continue;
    // The same anchor the page gives the heading (markdown.ts numbers repeats).
    const base = slug(plain(heading[2] ?? ""));
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    const route = ROUTE.exec(line);
    if (!route) continue;
    const depth = (route[1] ?? "").length;
    const section: string[] = [];
    let inner = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] ?? "";
      if (l.startsWith("```")) inner = !inner;
      const h = inner ? null : /^(#{1,4}) /.exec(l);
      if (h && (h[1] ?? "").length <= depth) break;
      section.push(l);
    }
    found.push({
      method: route[2] === "POST" ? "POST" : "GET",
      path: route[3] ?? "",
      page,
      id: n === 1 ? base : `${base}-${n}`,
      summary: firstParagraph(section),
      ...example(section),
    });
  }
  return found;
}

function firstParagraph(section: string[]): string {
  const para: string[] = [];
  let fenced = false;
  for (const l of section) {
    if (l.startsWith("```")) fenced = !fenced;
    else if (!fenced && l.trim() === "" && para.length > 0) break;
    else if (!fenced && l.trim() !== "" && !/^(\||>|- |\d+\. |#)/.test(l)) para.push(l.trim());
    else if (para.length > 0) break;
  }
  return plain(para.join(" "));
}

/** The first answer shown under a route: the first fenced block that is not the request. */
function example(section: string[]): { example?: { lang: string; text: string } } {
  for (let i = 0; i < section.length; i += 1) {
    const open = /^```(\w*)\s*$/.exec(section[i] ?? "");
    if (!open) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < section.length && !(section[j] ?? "").startsWith("```"); j += 1) {
      body.push(section[j] ?? "");
    }
    const lang = open[1] ?? "";
    if (lang === "json" || lang === "text") return { example: { lang, text: body.join("\n") } };
    i = j;
  }
  return {};
}

function operationId(method: string, path: string): string {
  const words = path
    .replaceAll(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "");
  return method.toLowerCase() + words.map((w) => (w[0] ?? "").toUpperCase() + w.slice(1)).join("");
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function content(ex: Route["example"]): Json {
  if (ex === undefined) return null;
  if (ex.lang === "text") return { "text/plain": { example: ex.text } };
  try {
    return { "application/json": { example: JSON.parse(ex.text) as Json } };
  } catch {
    // An example cut short to fit the page is no JSON: the answer's type still stands.
    return { "application/json": {} };
  }
}

/** The OpenAPI 3.1 document for every route the pages document. */
export function openapi(sources: ReadonlyMap<string, string>, version: string): Json {
  const paths: Record<string, Record<string, Json>> = {};
  const tags: Json[] = [];
  for (const page of PAGES) {
    const md = sources.get(page.slug) ?? "";
    const found = routes(page, md);
    if (found.length === 0) continue;
    tags.push({
      name: page.label,
      description: page.summary,
      externalDocs: { url: `${SITE}${href(page.slug)}` },
    });
    for (const r of found) {
      for (const variant of expand(r.path)) {
        const path = variant.replaceAll(/:(\w+)/g, "{$1}");
        const op = r.method.toLowerCase();
        const entry = paths[path] ?? {};
        paths[path] = entry;
        if (entry[op] !== undefined) continue;
        const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
          name: m[1] ?? "",
          in: "path",
          required: true,
          schema: { type: "string" },
        }));
        const answer = content(r.example);
        entry[op] = {
          operationId: operationId(r.method, path),
          tags: [page.label],
          summary: r.summary.split(/(?<=\.) /)[0] ?? r.summary,
          description: r.summary,
          externalDocs: { url: `${SITE}${href(page.slug)}#${r.id}` },
          ...(params.length > 0 ? { parameters: params } : {}),
          responses: {
            "200": {
              description: "The answer, as the page shows it",
              ...(answer === null ? {} : { content: answer }),
            },
            "4XX": { $ref: "#/components/responses/Error" },
            "5XX": { $ref: "#/components/responses/Error" },
          },
        };
      }
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "rbitcoin.space API",
      version,
      license: { name: "MIT", identifier: "MIT" },
      description: `The public API of rbitcoin.space, a block explorer for rbitcoin: Esplora-compatible REST under /api and the explorer's own routes under /api/v1. No key. Every operation links to its page; ${SITE}/llms.txt lists them all.`,
    },
    externalDocs: { url: `${SITE}/docs` },
    // No key and no account: no operation asks for credentials.
    security: [],
    servers: [
      {
        url: `${SITE}{network}`,
        description: "Mainnet at the root; the test networks under their prefix",
        variables: {
          network: { default: "", enum: ["", "/signet", "/testnet4", "/testnet5"] },
        },
      },
    ],
    tags,
    paths,
    components: {
      responses: {
        Error: {
          description: `An error: a fixed message. ${SITE}/docs/limits lists them`,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { error: { type: "string" } },
                required: ["error"],
              },
              example: { error: "not found" },
            },
          },
        },
      },
    },
  };
}
