// /openapi.json, made from the docs' own Markdown as the renderer reads it (markdown.ts): every
// `## GET|POST /api/...` heading is an operation, its first paragraph the summary, the first answer
// shown under it the example, its parameter tables its inputs. One source, so the description
// cannot drift from the pages (docs/FRONTEND.md "Public docs").

import { type Block, plain, render } from "./markdown";
import { type DocPage, href, PAGES, SITE } from "./pages";

export interface Param {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  /** Given once for each value, as `txId[]=a&txId[]=b`. */
  repeated?: boolean;
}

export interface Route {
  method: "GET" | "POST";
  /** As written, `:name` for a parameter and `[...]` round an optional part. */
  path: string;
  page: DocPage;
  /** The heading's anchor on its page, as the renderer gives it. */
  id: string;
  summary: string;
  example?: { lang: string; text: string };
  params: Param[];
  /** A POST's body: its media type, from the request shown. */
  body?: string;
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

const isRoute = (b: Block | undefined): boolean => b?.kind === "heading" && b.route !== undefined;

/**
 * A route's parameters: its parameter tables (`| Parameter | ... |`, a name in backticks, "Required"
 * in its description when it must be given), the names in its path, the query names in the request
 * shown, and those its paragraphs list after "Takes" (`` Takes `?asof=` ``). A query name is
 * optional unless a table says otherwise.
 */
function params(path: string, section: Block[]): Param[] {
  const named = new Map<string, string>();
  for (const b of section) {
    if (b.kind !== "table" || plain(b.rows[0]?.[0] ?? "") !== "Parameter") continue;
    for (const row of b.rows.slice(1)) {
      for (const m of (row[0] ?? "").matchAll(/`([^`]+)`/g)) {
        named.set(m[1] ?? "", plain(row[1] ?? ""));
      }
    }
  }
  const inPath = [...path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? "");
  const out: Param[] = inPath.map((name) => ({
    name,
    in: "path",
    required: true,
    description: named.get(name) ?? "",
  }));
  const query = new Set([...named.keys()].filter((n) => !inPath.includes(n)));
  for (const b of section) {
    if (b.kind === "code" && b.lang === "sh") {
      for (const m of b.text.matchAll(/[?&]([\w[\]]+)=/g)) query.add(m[1] ?? "");
    }
    // "Takes `?asof=` and `?after_txid=`": the list stops at anything else ("not `?after_txid=`").
    if (b.kind === "paragraph") {
      for (const list of b.text.matchAll(/\bTakes ((?:`\?\w+=`(?:,? and |, )?)+)/g)) {
        for (const m of (list[1] ?? "").matchAll(/`\?(\w+)=`/g)) query.add(m[1] ?? "");
      }
    }
  }
  for (const name of query) {
    const description = named.get(name) ?? "";
    out.push({
      name,
      in: "query",
      required: /\bRequired\b/.test(description),
      description,
      ...(name.endsWith("[]") ? { repeated: true } : {}),
    });
  }
  return out;
}

/** The routes a page documents, in its order. */
export function routes(page: DocPage, md: string): Route[] {
  const { blocks } = render(md);
  const found: Route[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== "heading") return;
    const method = b.route?.method;
    const path = b.route?.path ?? "";
    if ((method !== "GET" && method !== "POST") || !path.startsWith("/api/")) return;
    // Everything under the heading, to the next heading as high or the next route; its own part,
    // where the summary and the example are, ends at the first heading of any depth.
    const section: Block[] = [];
    for (const n of blocks.slice(i + 1)) {
      if (n.kind === "heading" && (n.depth <= b.depth || isRoute(n))) break;
      section.push(n);
    }
    const end = section.findIndex((n) => n.kind === "heading");
    const own = end === -1 ? section : section.slice(0, end);
    const para = own.find((n) => n.kind === "paragraph");
    const answer = own.find((n) => n.kind === "code" && (n.lang === "json" || n.lang === "text"));
    const request = own.find((n) => n.kind === "code" && n.lang === "sh");
    found.push({
      method,
      path,
      page,
      id: b.id,
      summary: para?.kind === "paragraph" ? plain(para.text) : "",
      ...(answer?.kind === "code" ? { example: { lang: answer.lang, text: answer.text } } : {}),
      params: params(path, section),
      ...(method === "POST"
        ? {
            body:
              request?.kind === "code" && request.text.includes("application/json")
                ? "application/json"
                : "text/plain",
          }
        : {}),
    });
  });
  return found;
}

function operationId(method: string, path: string): string {
  const words = path
    .replaceAll(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "");
  return method.toLowerCase() + words.map((w) => (w[0] ?? "").toUpperCase() + w.slice(1)).join("");
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The answer's media type and example: as shown, else raw bytes for `/raw`, else JSON. */
function content(path: string, ex: Route["example"]): Json {
  if (ex?.lang === "text") return { "text/plain": { example: ex.text } };
  if (ex === undefined && path.endsWith("/raw")) return { "application/octet-stream": {} };
  if (ex === undefined) return { "application/json": {} };
  try {
    return { "application/json": { example: JSON.parse(ex.text) as Json } };
  } catch {
    // An example cut short to fit the page is no JSON: the answer's type still stands.
    return { "application/json": {} };
  }
}

/** A page's tag: its label, with its group where two pages share one. */
function tag(page: DocPage): string {
  const shared = PAGES.filter((p) => p.label === page.label).length > 1;
  return shared ? `${page.label}, ${page.group}` : page.label;
}

/** The OpenAPI 3.1 document for every route the pages document. */
export function openapi(sources: ReadonlyMap<string, string>, version: string): Json {
  const paths: Record<string, Record<string, Json>> = {};
  // One template per route: `/tx/{txid}` and `/tx/{id}` are the same path to a client.
  const templates = new Map<string, string>();
  const tags: Json[] = [];
  for (const page of PAGES) {
    const found = routes(page, sources.get(page.slug) ?? "");
    if (found.length === 0) continue;
    tags.push({
      name: tag(page),
      description: page.summary,
      externalDocs: { url: `${SITE}${href(page.slug)}` },
    });
    for (const r of found) {
      for (const variant of expand(r.path)) {
        const path = variant.replaceAll(/:(\w+)/g, "{$1}");
        const shape = path.replaceAll(/\{\w+\}/g, "{}");
        const seen = templates.get(shape);
        if (seen !== undefined && seen !== path) {
          throw new Error(`docs: ${path} and ${seen} are one route; name its parameters alike`);
        }
        templates.set(shape, path);
        const op = r.method.toLowerCase();
        const entry = paths[path] ?? {};
        paths[path] = entry;
        if (entry[op] !== undefined) {
          throw new Error(`docs: ${r.method} ${path} has two headings; give it one`);
        }
        // A path parameter the optional part left out is not this variant's.
        const parameters = r.params
          .filter((p) => p.in === "query" || path.includes(`{${p.name}}`))
          .map((p) => {
            const out: Record<string, Json> = { name: p.name, in: p.in, required: p.required };
            if (p.description !== "") out["description"] = p.description;
            if (p.repeated === true) {
              out["schema"] = { type: "array", items: { type: "string" } };
              out["style"] = "form";
              out["explode"] = true;
            } else out["schema"] = { type: "string" };
            return out;
          });
        entry[op] = {
          operationId: operationId(r.method, path),
          tags: [tag(page)],
          summary: r.summary.split(/(?<=\.) /)[0] ?? r.summary,
          description: r.summary,
          externalDocs: { url: `${SITE}${href(page.slug)}#${r.id}` },
          ...(parameters.length > 0 ? { parameters } : {}),
          ...(r.body === undefined
            ? {}
            : {
                requestBody: {
                  required: true,
                  description: "As the page describes",
                  content: {
                    [r.body]: { schema: r.body === "text/plain" ? { type: "string" } : {} },
                  },
                },
              }),
          responses: {
            "200": {
              description: "The answer, as the page shows it",
              content: content(path, r.example),
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
