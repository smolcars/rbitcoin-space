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
  {
    slug: "api/blocks",
    label: "Blocks",
    group: "REST (Esplora)",
    summary:
      "The chain tip, lists of blocks, and a block by hash or height: header, status, raw bytes and transactions",
  },
  {
    slug: "api/transactions",
    label: "Transactions",
    group: "REST (Esplora)",
    summary: "A transaction, its status, raw form, merkle proofs and which outputs are spent",
  },
  {
    slug: "api/addresses",
    label: "Addresses",
    group: "REST (Esplora)",
    summary: "Balances, unspent outputs and history of an address, a public key or a scripthash",
  },
  {
    slug: "api/mempool",
    label: "Mempool",
    group: "REST (Esplora)",
    summary: "What is waiting to be mined, its transaction ids and the node's fee estimates",
  },
  {
    slug: "api/broadcast",
    label: "Broadcast",
    group: "REST (Esplora)",
    summary: "Send a signed transaction to the network, and why the node may reject it",
  },
  {
    slug: "api/blindbit",
    label: "Silent payments",
    group: "REST (Esplora)",
    summary: "The BlindBit v1 routes a silent payments wallet scans with",
  },
  {
    slug: "api/v1/fees",
    label: "Fees",
    group: "Explorer routes",
    summary: "What to pay to be mined within a block, an hour or a day, and the projected blocks",
  },
  {
    slug: "api/v1/blocks",
    label: "Blocks and audits",
    group: "Explorer routes",
    summary:
      "Blocks with their miner, reward and fee rates, every transaction of a block, and block audits",
  },
  {
    slug: "api/v1/transactions",
    label: "Transactions",
    group: "Explorer routes",
    summary: "Replacements, CPFP, transaction flags, first-seen times and prevouts",
  },
  {
    slug: "api/v1/mining",
    label: "Mining",
    group: "Explorer routes",
    summary: "Mining pools, their blocks and share, hashrate and block health",
  },
  {
    slug: "api/v1/difficulty",
    label: "Difficulty and server info",
    group: "Explorer routes",
    summary: "Progress to the next difficulty adjustment, and what this server runs",
  },
  {
    slug: "api/v1/statistics",
    label: "Mempool statistics",
    group: "Explorer routes",
    summary: "The mempool's size by fee rate over time",
  },
  {
    slug: "api/v1/lightning",
    label: "Lightning",
    group: "Explorer routes",
    summary: "Lightning nodes, channels, search and rankings from the public graph",
  },
  {
    slug: "websocket",
    label: "WebSocket",
    group: "Live",
    summary: "New blocks, mempool changes and a transaction or address followed as they happen",
  },
];

/** A page's address on this site. */
export const href = (slug: string): string => (slug === "" ? "/docs" : `/docs/${slug}`);

/** Its Markdown copy's address. */
export const mdHref = (slug: string): string => (slug === "" ? "/docs.md" : `/docs/${slug}.md`);
