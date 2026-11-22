// The public docs' pages, in the order the side menu and /llms.txt list them. A page's text is
// web/docs/<slug>.md (the overview is index.md); its title is that file's first heading.

export interface DocPage {
  /** The page's path under /docs: "" for the overview, "api/fees" for /docs/api/fees. */
  slug: string;
  /** Its name in the side menu. */
  label: string;
  group: string;
  /** One line on what it holds: its meta description and its line in /llms.txt. */
  summary: string;
}

/** Where the docs live: the Markdown copies and /llms.txt link to it in full. */
export const SITE = "https://rbitcoin.space";

export const PAGES: readonly DocPage[] = [
  {
    slug: "",
    label: "Overview",
    group: "Start",
    summary: "Base URLs for each network, the first requests to make, and which interface fits",
  },
  {
    slug: "limits",
    label: "Limits and errors",
    group: "Start",
    summary: "Rate limits, error bodies, Retry-After, caching and CORS",
  },
  {
    slug: "agents",
    label: "Use with an agent",
    group: "Start",
    summary: "Connect the read-only MCP server, or point an agent at these pages",
  },
];

/** A page's address on this site. */
export const href = (slug: string): string => (slug === "" ? "/docs" : `/docs/${slug}`);

/** Its Markdown copy's address. */
export const mdHref = (slug: string): string => (slug === "" ? "/docs.md" : `/docs/${slug}.md`);
