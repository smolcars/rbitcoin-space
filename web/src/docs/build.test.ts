import { describe, expect, it } from "vitest";
import { absoluteLinks, build, llmsTxt, markdownCopy } from "./build";
import { mdHref, PAGES, SITE } from "./pages";

const TEMPLATE =
  '<title>{{title}}</title><main data-md="{{md}}">{{nav}}<h1>{{h1}}</h1>{{body}}{{toc}}</main>';

/** Every docs page's Markdown in the repo, by its file. */
const FILES = import.meta.glob<string>("../../docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Each page's Markdown, by its slug, as the build reads it. */
function sources(): Map<string, string> {
  return new Map(
    PAGES.map((p) => [p.slug, FILES[`../../docs/${p.slug === "" ? "index" : p.slug}.md`] ?? ""]),
  );
}

describe("the Markdown copies", () => {
  it("link to each other's Markdown, and to this site in full", () => {
    expect(
      absoluteLinks(
        "[a](/docs) [b](/docs/limits#retrying) [c](/llms.txt) [d](https://x.org/y) [e](//x.org) [f](/) [g](/\\x.org)",
      ),
    ).toBe(
      `[a](${SITE}/docs.md) [b](${SITE}/docs/limits.md#retrying) [c](${SITE}/llms.txt) [d](https://x.org/y) [e](//x.org) [f](${SITE}/) [g](/\\x.org)`,
    );
  });

  it("say where they live under the title", () => {
    const page = PAGES.find((p) => p.slug === "limits");
    if (!page) throw new Error("no limits page");
    expect(markdownCopy(page, "# Limits\n\nText.\n").split("\n").slice(0, 4)).toStrictEqual([
      "# Limits",
      "",
      `> ${SITE}/docs/limits as Markdown. Every page: ${SITE}/llms.txt`,
      "",
    ]);
  });
});

describe("build", () => {
  it("writes a page, a Markdown copy and an llms.txt line for every page", () => {
    const files = build(TEMPLATE, sources());
    const llms = llmsTxt();
    for (const p of PAGES) {
      const html = files.get(p.slug === "" ? "docs/index.html" : `docs/${p.slug}.html`);
      expect(html).toContain(`data-md="${mdHref(p.slug)}"`);
      expect(html).not.toMatch(/\{\{\w+\}\}/);
      expect(html).toContain('aria-current="page"');
      expect(files.get(mdHref(p.slug).slice(1))).toMatch(/^# \S/);
      expect(llms).toContain(`(${SITE}${mdHref(p.slug)}): ${p.summary}`);
    }
    expect(files.get("llms.txt")).toBe(llms);
    expect(files.get("llms-full.txt")?.split("\n---\n").length).toBe(PAGES.length);
  });

  it("links only to pages that exist", () => {
    const known = new Set(PAGES.map((p) => (p.slug === "" ? "/docs" : `/docs/${p.slug}`)));
    for (const [slug, md] of sources()) {
      for (const m of md.matchAll(/\]\((\/docs[^)#\s]*)/g)) {
        const target = (m[1] ?? "").replace(/\.md$/, "");
        expect(known.has(target === "/docs/index" ? "/docs" : target), `${slug}: ${m[1]}`).toBe(
          true,
        );
      }
    }
  });

  it("has a page for every Markdown file", () => {
    expect(Object.keys(FILES)).toHaveLength(PAGES.length);
  });

  it("keeps the agents' files ASCII, which reads right as text/plain without a charset", () => {
    const wide = [...build(TEMPLATE, sources())]
      .filter(([name, text]) => name.endsWith(".txt") && /[^\t\n -~]/u.test(text))
      .map(([name]) => name);
    expect(wide).toStrictEqual([]);
  });

  it("fails without a page's Markdown, or with no title", () => {
    expect(() => build(TEMPLATE, new Map())).toThrow(/no Markdown/);
    const untitled = new Map(sources()).set("limits", "No title\n");
    expect(() => build(TEMPLATE, untitled)).toThrow(/must open/);
  });
});
