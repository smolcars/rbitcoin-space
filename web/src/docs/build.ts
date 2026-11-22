// Builds the public docs from their Markdown: a page of HTML and a Markdown copy for each, and
// /llms.txt and /llms-full.txt for agents. Pure: the Vite plugin (scripts/docs.ts) reads and writes.

import { escape, render } from "./markdown";
import { type DocPage, href, mdHref, PAGES, SITE } from "./pages";

/** The files to write, by their path in the build. */
export type Files = Map<string, string>;

const NAME = "rbitcoin.space";

/** The opening of /llms.txt: what the site is, for a model that reads nothing else. */
const ABOUT = `> Block explorer and free public API for rbitcoin on mainnet, signet, testnet4 and Testnet 5. No key and no account.
> Esplora-compatible REST at /api, the explorer's own routes at /api/v1, a WebSocket at /api/v1/ws, and a read-only MCP server at /mcp.
> Every page below is Markdown. Keep to the limits in "Limits and errors", and on a 429 or 503 wait for Retry-After before asking again.`;

/**
 * A Markdown copy's links, made whole: a docs page's link goes to its Markdown copy, any other
 * path on this site to its full address. Code blocks never hold a link written `](/`.
 */
export function absoluteLinks(md: string): string {
  return md.replaceAll(/\]\((\/[^/\\)\s][^)\s]*|\/)\)/g, (_, path: string) => {
    const [base = "", frag] = path.split("#", 2);
    const tail = frag === undefined ? "" : `#${frag}`;
    const docs = /^\/docs(\/[a-z0-9/-]+)?$/.exec(base);
    if (docs) return `](${SITE}${mdHref((docs[1] ?? "").slice(1))}${tail})`;
    return `](${SITE}${path})`;
  });
}

/** The Markdown copy: the page with whole links, and a line under its title saying where it lives. */
export function markdownCopy(p: DocPage, md: string): string {
  const [first = "", ...rest] = absoluteLinks(md).trimEnd().split("\n");
  const where = `> ${SITE}${href(p.slug)} as Markdown. Every page: ${SITE}/llms.txt`;
  return `${first}\n\n${where}\n${rest.join("\n")}\n`;
}

function sideMenu(current: string): string {
  const groups = new Map<string, DocPage[]>();
  for (const p of PAGES) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  return [...groups]
    .map(([group, pages]) => {
      const links = pages
        .map((p) => {
          const here = p.slug === current ? ' aria-current="page"' : "";
          return `<li><a href="${href(p.slug)}"${here}>${escape(p.label)}</a></li>`;
        })
        .join("");
      return `<div class="docs-nav__group"><h2>${escape(group)}</h2><ul>${links}</ul></div>`;
    })
    .join("");
}

function contents(headings: { depth: number; text: string; id: string }[]): string {
  const top = headings.filter((h) => h.depth === 2);
  if (top.length === 0) return "";
  const items = top.map((h) => `<li><a href="#${h.id}">${escape(h.text)}</a></li>`).join("");
  return `<nav class="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>${items}</ul></nav>`;
}

/** Fills the built template (web/docs.html, its scripts and styles already linked) for one page. */
export function page(template: string, p: DocPage, md: string): string {
  const r = render(md);
  const fill: Record<string, string> = {
    title: escape(p.slug === "" ? `Docs | ${NAME}` : `${r.title} | ${NAME} docs`),
    summary: escape(p.summary),
    canonical: `${SITE}${href(p.slug)}`,
    md: mdHref(p.slug),
    nav: sideMenu(p.slug),
    group: escape(p.group),
    h1: escape(r.title),
    body: r.html,
    toc: contents(r.headings),
  };
  return template.replaceAll(/\{\{(\w+)\}\}/g, (whole, key: string) => fill[key] ?? whole);
}

export function llmsTxt(): string {
  const groups = new Map<string, DocPage[]>();
  for (const p of PAGES) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const sections = [...groups].map(
    ([group, pages]) =>
      `## ${group}\n\n${pages.map((p) => `- [${p.label}](${SITE}${mdHref(p.slug)}): ${p.summary}`).join("\n")}`,
  );
  const optional = `## Optional\n\n- [Every page in one file](${SITE}/llms-full.txt)`;
  return `# ${NAME}\n\n${ABOUT}\n\n${sections.join("\n\n")}\n\n${optional}\n`;
}

/**
 * Every file the docs add to the build. `sources` holds each page's Markdown by its slug; a page
 * without one, or a source with no title, fails the build rather than ship a hole.
 */
export function build(template: string, sources: ReadonlyMap<string, string>): Files {
  const files: Files = new Map();
  const copies: string[] = [];
  for (const p of PAGES) {
    const md = sources.get(p.slug);
    if (md === undefined) throw new Error(`docs: no Markdown for /docs/${p.slug}`);
    if (!/^# \S/.test(md)) throw new Error(`docs: ${p.slug || "index"}.md must open with "# "`);
    if (!template.includes("{{body}}")) throw new Error("docs: the template has no {{body}}");
    files.set(p.slug === "" ? "docs/index.html" : `docs/${p.slug}.html`, page(template, p, md));
    const copy = markdownCopy(p, md);
    files.set(mdHref(p.slug).slice(1), copy);
    copies.push(copy);
  }
  files.set("llms.txt", llmsTxt());
  files.set("llms-full.txt", copies.join("\n---\n\n"));
  return files;
}
