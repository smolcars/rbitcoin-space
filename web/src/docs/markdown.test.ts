import { describe, expect, it } from "vitest";
import { inline, plain, render, slug } from "./markdown";

describe("inline", () => {
  it("escapes text, code and link text", () => {
    expect(inline('<b> & "x"')).toBe("&lt;b&gt; &amp; &quot;x&quot;");
    expect(inline("`<script>`")).toBe("<code>&lt;script&gt;</code>");
    expect(inline("[<i>](/docs)")).toBe('<a href="/docs">&lt;i&gt;</a>');
  });

  it("links only to http(s), a path or an anchor", () => {
    expect(inline("[x](javascript:void)")).toBe("x");
    expect(inline("[x](data:text/html,hi)")).toBe("x");
    expect(inline("[x](#a)")).toBe('<a href="#a">x</a>');
    expect(inline("[x](//example.org)")).toBe("x");
    expect(inline("[x](/\\example.org)")).toBe("x");
    expect(inline("[x](https://e.com/a)")).toBe(
      '<a href="https://e.com/a" rel="noopener noreferrer">x</a>',
    );
  });

  it("reads bold, code inside links and escaped characters", () => {
    expect(inline("**a `b`**")).toBe("<strong>a <code>b</code></strong>");
    expect(inline("[`API.md`](/x)")).toBe('<a href="/x"><code>API.md</code></a>');
    expect(inline("a \\| b \\*")).toBe("a | b *");
    expect(inline("2 * 3 and `unclosed")).toBe("2 * 3 and `unclosed");
  });
});

describe("render", () => {
  it("takes the first heading as the title and lists the others", () => {
    const r = render(
      "# Fees\n\nIntro.\n\n## GET /api/v1/fees/precise\n\n### Fields\n\n## Errors\n\n## Errors\n",
    );
    expect(r.title).toBe("Fees");
    expect(r.html).not.toContain("<h1");
    expect(r.headings).toStrictEqual([
      { depth: 2, text: "GET /api/v1/fees/precise", id: "get-api-v1-fees-precise" },
      { depth: 3, text: "Fields", id: "fields" },
      { depth: 2, text: "Errors", id: "errors" },
      { depth: 2, text: "Errors", id: "errors-2" },
    ]);
    expect(r.html).toContain(
      '<h2 id="get-api-v1-fees-precise" class="route-heading"><span class="verb">GET</span> <code class="route">/api/v1/fees/precise</code>',
    );
  });

  it("keeps code blocks verbatim and escaped", () => {
    const r = render('# T\n\n```json\n{"a": "<b>"}\n| not a table\n```\n');
    expect(r.html).toBe(
      '<pre class="code" data-lang="json"><code>{&quot;a&quot;: &quot;&lt;b&gt;&quot;}\n| not a table</code></pre>',
    );
  });

  it("draws tables, with pipes inside code and aligned columns", () => {
    const r = render("# T\n\n| A | B |\n|---|---:|\n| `a|b` | 2 |\n");
    expect(r.html).toBe(
      '<div class="table"><table><thead><tr><th>A</th><th class="right">B</th></tr></thead><tbody><tr><td><code>a|b</code></td><td class="right">2</td></tr></tbody></table></div>',
    );
  });

  it("reads lists with continued lines, quotes, rules and paragraphs", () => {
    const r = render(
      "# T\n\n- one\n  more\n- two\n\n1. first\n2. second\n\n> note\n> here\n\n---\n\nA\nB\n- list after text\n",
    );
    expect(r.html).toBe(
      [
        "<ul><li>one more</li><li>two</li></ul>",
        "<ol><li>first</li><li>second</li></ol>",
        "<blockquote><p>note here</p></blockquote>",
        "<hr>",
        "<p>A B</p>",
        "<ul><li>list after text</li></ul>",
      ].join("\n"),
    );
  });
});

describe("slug and plain", () => {
  it("makes anchors from a heading's words", () => {
    expect(slug("Limits and errors")).toBe("limits-and-errors");
    expect(slug("!!!")).toBe("section");
    expect(plain("Use [the API](/docs) `now` **here**")).toBe("Use the API now here");
  });
});
