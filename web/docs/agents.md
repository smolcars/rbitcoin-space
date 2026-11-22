# Use with an agent

Give a chat bot or a coding agent the explorer as tools, or point it at these pages. Nothing here needs a key or an account.

## Connect the MCP server

The [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp` gives an agent nine read-only tools that look things up on any network this server has on. Nothing can be broadcast through it.

```text
https://rbitcoin.space/mcp
```

The transport is Streamable HTTP. There is no sign-in. A server you run yourself serves it once `MCP_ENABLED=true` is set.

### Claude Code

```sh
claude mcp add --transport http rbitcoin https://rbitcoin.space/mcp
```

### Claude and Claude Desktop

Open Settings, then Connectors, choose Add custom connector, and paste the URL.

### Cursor

Choose Add to Cursor in the page menu at the top of any docs page, or add it to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "rbitcoin": { "url": "https://rbitcoin.space/mcp" } } }
```

### VS Code

Add it to `.vscode/mcp.json` in your project:

```json
{ "servers": { "rbitcoin": { "type": "http", "url": "https://rbitcoin.space/mcp" } } }
```

### The tools

Each chain tool takes `network` (`mainnet`, `signet`, `testnet4` or `testnet5`). Without it, a tool asks the first network the server has on: mainnet on rbitcoin.space, but on a server without mainnet another one, so name the network when it matters. Each answer says which network it came from. Amounts are in satoshis, fee rates in sat/vB.

| Tool                        | Answers                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `get_fees`                  | What to pay for the next block, half an hour, an hour and a day               |
| `get_mempool`               | Transactions and fees waiting, and the projected blocks                       |
| `get_block`                 | A block by height or hash, or the newest: its size, miner, reward and fees    |
| `get_transaction`           | Confirmed or not, fee, fee rate, and its first inputs and outputs             |
| `decode_transaction`        | What a raw transaction does before anyone sends it. Nothing is broadcast      |
| `get_address`               | Balance, totals and the newest transactions of an address                     |
| `get_difficulty_adjustment` | Progress to the next adjustment and the expected change                       |
| `get_lightning_node`        | A Lightning node by key, or nodes matching an alias                           |
| `decode`                    | What a Lightning invoice, offer, LNURL, Lightning address or Ark address says |

## Point it at the docs

Agents read these pages best as Markdown:

- Add `.md` to any docs address, for example [/docs/limits.md](/docs/limits.md).
- Or ask for the normal address with `Accept: text/markdown`.
- [/llms.txt](/llms.txt) lists every page with one line on each, and [/llms-full.txt](/llms-full.txt) is every page in one file.

```sh
curl -H 'Accept: text/markdown' https://rbitcoin.space/docs/limits
```

## Paste into AGENTS.md or CLAUDE.md

A few lines that tell a coding agent where the API is and how to stay within its limits:

```markdown
## Bitcoin data

Use https://rbitcoin.space/api (Esplora REST, no key). Docs for agents: https://rbitcoin.space/llms.txt
Fees: GET https://rbitcoin.space/api/v1/fees/precise (sat/vB, three decimals).
On 429 or 503, wait for Retry-After before asking again. Use the WebSocket for live data instead of polling.
```

## Limits for bots

The MCP server's tools call the same routes as everyone else, under the same [limits](/docs/limits). Limits are per client address, so every user of one hosted bot shares its provider's allowance. There are no keys and no paid tier. To stay inside the allowance, cache what does not change (a block by its hash never does), and use the WebSocket rather than polling.

## Text from the chain

Some answers carry text a stranger wrote: an invoice's description, a Lightning node's alias. The MCP server lists those fields in `untrusted_text` on each answer, and its instructions ask the model to treat them as data. Your client decides what it does with them.
