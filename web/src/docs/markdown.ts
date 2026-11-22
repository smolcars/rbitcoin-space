// The public docs' Markdown, turned into HTML at build time (docs/FRONTEND.md "Public docs").
// The source is ours, so only the subset the pages use is read: headings, paragraphs, lists,
// tables, block quotes, fenced code, rules, and inline code, links and bold. Every piece of text
// is escaped all the same, and a link goes out only to http(s), a path or an anchor.

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export interface Rendered {
  /** The first `#` heading's text: the page's title. */
  title: string;
  /** The body, the title's heading left out: the template sets the title itself. */
  html: string;
  /** Every `##` and `###`, for the page's contents. */
  headings: Heading[];
}

/** A heading that names a route: its method, then its path. */
const ROUTE = /^(GET|POST|HEAD|PUT|DELETE|WS) (\/\S*)$/;

export function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A heading's anchor: its words, lower case, joined by hyphens. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "section"
  );
}

/** Text without its Markdown: what a heading reads as in a list of contents. */
export function plain(text: string): string {
  return text
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\*\*|`/g, "")
    .replaceAll("\\|", "|");
}

function safeHref(href: string): string | undefined {
  // A path, but not `//host` or `/\host`, which a browser reads as another site.
  return /^(https?:\/\/|\/(?![/\\])|#)/.test(href) ? href : undefined;
}

/** Inline Markdown: code spans, links and bold. Everything else is text. */
export function inline(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && /[\\`*[\]|]/.test(src[i + 1] ?? "")) {
      out += escape(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        out += `<code>${escape(src.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (c === "*" && src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        out += `<strong>${inline(src.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (c === "[") {
      const link = /^\[((?:`[^`]*`|[^\]])*)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (link) {
        const [whole, text = "", href = ""] = link;
        const safe = safeHref(href);
        out +=
          safe === undefined
            ? inline(text)
            : `<a href="${escape(safe)}"${/^https?:/.test(safe) ? ' rel="noopener noreferrer"' : ""}>${inline(text)}</a>`;
        i += whole.length;
        continue;
      }
    }
    out += escape(c ?? "");
    i += 1;
  }
  return out;
}

function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const parts: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] ?? "";
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cur += "\\|";
      i += 1;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function headingHtml(depth: number, text: string, id: string): string {
  const route = ROUTE.exec(text);
  const body = route
    ? `<span class="verb">${escape(route[1] ?? "")}</span> <code class="route">${escape(route[2] ?? "")}</code>`
    : inline(text);
  const cls = route ? ' class="route-heading"' : "";
  return `<h${depth} id="${id}"${cls}>${body}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>`;
}

/** Renders a page. Its first line is its `#` title. */
export function render(md: string): Rendered {
  const lines = md.replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  const headings: Heading[] = [];
  const ids = new Map<string, number>();
  let title = "";
  let i = 0;

  const uniqueId = (text: string) => {
    const base = slug(plain(text));
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  const isBlockStart = (l: string) =>
    /^(#{1,4} |```|> ?|- |\d+\. |\|)/.test(l) || /^---+$/.test(l.trim());

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (heading) {
      const depth = (heading[1] ?? "#").length;
      const text = (heading[2] ?? "").trim();
      if (depth === 1 && title === "") title = plain(text);
      else {
        const id = uniqueId(text);
        if (depth <= 3) headings.push({ depth, text: plain(text), id });
        html.push(headingHtml(depth, text, id));
      }
      i += 1;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      const attr = lang ? ` data-lang="${escape(lang)}"` : "";
      html.push(`<pre class="code"${attr}><code>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      html.push("<hr>");
      i += 1;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        rows.push(lines[i] ?? "");
        i += 1;
      }
      const [head = "", rule = "", ...body] = rows;
      const aligns = cells(rule).map((c) =>
        /^:?-+:$/.test(c) ? (c.startsWith(":") ? "center" : "right") : "",
      );
      const cell = (tag: string, c: string, n: number) => {
        const align = aligns[n] ? ` class="${aligns[n]}"` : "";
        return `<${tag}${align}>${inline(c)}</${tag}>`;
      };
      const thead = `<tr>${cells(head)
        .map((c, n) => cell("th", c, n))
        .join("")}</tr>`;
      const tbody = body
        .map(
          (r) =>
            `<tr>${cells(r)
              .map((c, n) => cell("td", c, n))
              .join("")}</tr>`,
        )
        .join("");
      html.push(
        `<div class="table"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }
    if (/^> ?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^> ?/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^> ?/, ""));
        i += 1;
      }
      // A note holds paragraphs and lists, never a heading.
      html.push(`<blockquote>${render(body.join("\n")).html}</blockquote>`);
      continue;
    }
    const item = /^(- |\d+\. )/.exec(line);
    if (item) {
      const ordered = (item[1] ?? "").endsWith(". ");
      const marker = ordered ? /^\d+\. / : /^- /;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (marker.test(l)) items.push(l.replace(marker, ""));
        else if (/^ {2,}\S/.test(l) && items.length > 0) {
          items[items.length - 1] += ` ${l.trim()}`;
        } else break;
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      const l = lines[i] ?? "";
      if (para.length > 0 && isBlockStart(l)) break;
      para.push(l.trim());
      i += 1;
    }
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { title, html: html.join("\n"), headings };
}
