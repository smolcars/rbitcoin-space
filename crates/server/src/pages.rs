//! Page paths: the app shell with a head that says what the page is, so a link pasted into a chat
//! previews as that page (docs/FRONTEND.md, "Link previews"). The head is built from the path's
//! parsed identifiers, the server's memory and the block table, never the node: anyone can ask
//! for any path at any rate (SECURITY.md rule 11).

use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::Uri;
use axum::http::header::CONTENT_TYPE;
use axum::response::{IntoResponse, Response};
use engine::blocks::Row;
use engine::mining::pools::{self, UNKNOWN};
use tokio::sync::Semaphore;

use crate::config::Network;
use crate::{ApiError, NetworkContext, esplora, lightning};

/// Ends every title, as `usePageTitle` in `web/src/lib/page.ts` ends it.
const SITE: &str = "rbitcoin.space";

/// Block table reads for previews running at once, server-wide. Past it a block's head goes
/// without its facts, so a flood of block paths holds at most this many of a store's readers.
const STORE_READS: usize = 2;

/// The site's link preview picture, 1200 by 630, for every page but a transaction's and a block's,
/// which name their own card (`cards`), and what a card answers when it cannot be drawn: under
/// `/assets`, so it is served as built with a year's cache. A redrawn picture takes a new name, as chat apps cache it by its
/// address; a test holds the name to the file's hash (docs/FRONTEND.md, "Link previews").
pub(crate) const IMAGE: &str = "/assets/preview-55449820.png";

/// What the picture shows, for a reader who cannot see it.
const IMAGE_ALT: &str = "The rbitcoin.space logo: a crab lifting a block of layers.";

/// The narrow no-break space the frontend groups digits with (`NNBSP` in `lib/format.ts`).
const NNBSP: char = '\u{202f}';

/// The built shell, read once at start, and what a head is made from.
pub(crate) struct Pages {
    shell: Option<Shell>,
    /// `SITE_URL`, without a trailing slash: the absolute addresses a picture card needs.
    site: Option<String>,
    networks: Vec<Arc<NetworkContext>>,
    reads: Semaphore,
}

/// The build's `index.html`, split around its `<title>` element.
struct Shell {
    /// Served as built for a path that names no page we can describe.
    raw: String,
    /// Where the `<title>` element starts and ends; `None` if the build has none.
    title: Option<(usize, usize)>,
}

impl Shell {
    fn new(raw: String) -> Self {
        let start = raw.find("<title>");
        let end = start.and_then(|s| {
            raw.get(s..)?
                .find("</title>")
                .map(|e| s + e + "</title>".len())
        });
        Self {
            title: start.zip(end),
            raw,
        }
    }
}

/// What a page is: its title as the page sets it, without the network or the site, and one
/// sentence about it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Head {
    pub title: String,
    pub description: String,
}

impl Pages {
    pub(crate) fn new(
        web_dir: Option<&Path>,
        site: Option<&str>,
        networks: Vec<Arc<NetworkContext>>,
    ) -> Self {
        Self {
            shell: web_dir
                .and_then(|d| std::fs::read_to_string(d.join("index.html")).ok())
                .map(Shell::new),
            site: site.map(str::to_owned),
            networks,
            reads: Semaphore::new(STORE_READS),
        }
    }

    /// The head for `path`, or `None` for a path that is no page of an enabled network or whose
    /// identifier does not parse.
    async fn head(&self, path: &str, query: Option<&str>) -> Option<(Network, Head)> {
        let (network, rest) = split(path);
        let ctx = self.networks.iter().find(|c| c.config.network == network)?;
        let on = chain(network);
        // The Ark pages named by an outpoint (docs/ARK.md).
        if let Some(id) = rest.strip_prefix("/ark/arkade/vtxo/") {
            let (txid, vout) = id.split_once(':')?;
            let txid = esplora::txid(txid).ok()?;
            let vout = arkade::parse_vout(vout)?;
            let head = Head {
                title: "Arkade VTXO".into(),
                description: format!(
                    "Arkade VTXO {txid}:{vout} on {on}: its amount, its expiry and its exit path, as Arkade reports them."
                ),
            };
            return Some((network, head));
        }
        // The VTXO itself is in the fragment, which never reaches the server.
        if rest == "/ark/bark/hex" {
            let head = Head {
                title: "Bark VTXO".into(),
                description: format!(
                    "A Bark VTXO on {on}, read from its hex: its amount, its expiry and its exit path, checked."
                ),
            };
            return Some((network, head));
        }
        if let Some(a) = rest.strip_prefix("/ark/arkade/address/") {
            arkade::Address::parse(a, network == Network::Mainnet).ok()?;
            // It parsed, so it is bech32 characters only; written in its canonical lower case.
            let address = a.to_ascii_lowercase();
            let head = Head {
                title: "Arkade address".into(),
                description: format!(
                    "Arkade address {address} on {on}: its VTXOs, as Arkade reports them."
                ),
            };
            return Some((network, head));
        }
        if let Some(id) = rest.strip_prefix("/ark/vtxo/") {
            let (txid, vout) = id.split_once(':')?;
            let txid = esplora::txid(txid).ok()?;
            let vout = arkade::parse_vout(vout)?;
            let head = Head {
                title: "Ark VTXO".into(),
                description: format!(
                    "Ark VTXO {txid}:{vout} on {on}, on whichever Ark server knows it."
                ),
            };
            return Some((network, head));
        }
        if let Some(id) = rest.strip_prefix("/ark/bark/vtxo/") {
            let id: bark::VtxoId = id.parse().ok()?;
            let head = Head {
                title: "Bark VTXO".into(),
                description: format!(
                    "Bark VTXO {id} on {on}: its amount, its expiry and its exit path, checked."
                ),
            };
            return Some((network, head));
        }
        let mut segs = rest.split('/');
        // `rest` is empty or starts with `/`, so the first segment is always empty.
        let s = [segs.next(), segs.next(), segs.next(), segs.next()];
        if segs.next().is_some() {
            return None;
        }
        let head = match s {
            [_, None | Some(""), None, None] => Head {
                title: "Blocks and mempool".into(),
                description: format!(
                    "{on}'s newest blocks, its mempool and the blocks it would fill next, live."
                ),
            },
            [_, Some("block"), Some("next"), n] => projected(on, n)?,
            [_, Some("block"), Some(id), None] => self.block(ctx, on, id).await?,
            [_, Some("blocks"), from, None] => {
                let from = from.map(height).transpose().ok()?;
                Head {
                    title: "Blocks".into(),
                    description: match from {
                        Some(h) => format!(
                            "{on}'s blocks from height {} down: their time, miner, transactions, fees and size.",
                            group(u64::from(h))
                        ),
                        None => format!(
                            "{on}'s blocks, newest first: their time, miner, transactions, fees and size."
                        ),
                    },
                }
            }
            [_, Some("tx"), Some(id), None] => {
                let txid = esplora::txid(id).ok()?.to_string();
                Head {
                    title: format!("Transaction {}", short(&txid)),
                    description: format!(
                        "{on} transaction {txid}: its inputs, outputs, fee and status."
                    ),
                }
            }
            [_, Some("address"), Some(a), None] => {
                let payee = esplora::payee(a, network).ok()?;
                let (what, lower) = match payee {
                    esplora::Payee::Address(_) => ("Address", "address"),
                    esplora::Payee::Key(_) => ("Public key", "public key"),
                };
                let name = payee.to_string();
                Head {
                    title: format!("{what} {}", short(&name)),
                    description: format!("{on} {lower} {name}: its balance and its transactions."),
                }
            }
            [_, Some("mining"), None, None] => Head {
                title: "Mining".into(),
                description: format!(
                    "Who mines {on}'s blocks: each pool's share, the hashrate, the difficulty and the rewards."
                ),
            },
            [_, Some("mining"), Some("pool"), Some(slug)] => {
                let pool = pools::list().by_slug(slug)?;
                Head {
                    title: pool.name.clone(),
                    description: format!(
                        "Blocks mined by {} on {on}: its share, its hashrate and its newest blocks.",
                        pool.name
                    ),
                }
            }
            [_, Some("mempool"), None, None] => Head {
                title: "Mempool history".into(),
                description: format!(
                    "{on}'s mempool over time: its size by fee rate, and the flow in and out."
                ),
            },
            [_, Some("rbf"), None, None] => Head {
                title: "Replacements".into(),
                description: format!(
                    "Transactions replaced on {on}'s mempool, newest first: what replaced what, how much the fee rate rose, and which was mined, live."
                ),
            },
            [_, Some("fees"), Some("score"), None] => Head {
                title: "Fee track record".into(),
                description: format!(
                    "How often this server's recommended fees on {on} were mined in time: each level against its 85% target, what it cost, and what the figures rest on."
                ),
            },
            [_, Some("lightning"), None, None] => Head {
                title: "Lightning".into(),
                description: format!(
                    "The Lightning network on {on}, as this server's gossip peer sees it: nodes, channels and capacity over time."
                ),
            },
            [_, Some("lightning"), Some("node"), Some(key)] => node(ctx, on, key)?,
            [_, Some("lightning"), Some("channel"), Some(id)] => {
                let scid = lightning::nodes::scid(id).ok()?;
                // `scid` takes only canonical forms, so this writes the id back as it came.
                let id = if id.contains('x') {
                    lightning::scid_text(scid)
                } else {
                    scid.to_string()
                };
                Head {
                    title: format!("Lightning channel {id}"),
                    description: format!(
                        "Lightning channel {id} on {on}: its capacity, its two nodes and their fees."
                    ),
                }
            }
            [_, Some("lightning"), Some("search"), None] => Head {
                title: "Lightning search".into(),
                description: format!(
                    "Find Lightning nodes and channels on {on} by name, public key or channel id."
                ),
            },
            [_, Some("lightning"), Some("rankings"), None] => rankings(on, query),
            [_, Some("ark"), None, None] => Head {
                title: "Ark".into(),
                description: format!("Look up an Ark VTXO or address on {on}."),
            },
            _ => return None,
        };
        Some((network, head))
    }

    async fn block(&self, ctx: &NetworkContext, on: &str, id: &str) -> Option<Head> {
        let by_height = height(id);
        let by_hash = match by_height {
            Ok(_) => None,
            Err(()) => Some(esplora::block_hash(id).ok()?),
        };
        let row = self.row(ctx, by_height.ok(), by_hash).await;
        Some(match (row, by_hash) {
            (Some(r), _) => {
                let pool = pools::list();
                let (id, _) = pool.attribute(&r.coinbase.tag, &r.coinbase.payouts);
                let miner = pool
                    .by_id(id)
                    .filter(|p| p.id != UNKNOWN)
                    .map_or_else(|| "an unknown miner".to_owned(), |p| p.name.clone());
                let time = crate::mining::iso8601(r.time);
                let time = time.get(..16).unwrap_or_default().replace('T', " ");
                Head {
                    title: format!("Block {}", group(u64::from(r.height))),
                    description: format!(
                        "{on} block {}, mined {time} UTC by {miner}: {} and {} BTC in fees.",
                        group(u64::from(r.height)),
                        count(r.tx_count, "transaction"),
                        btc(r.fees),
                    ),
                }
            }
            (None, Some(hash)) => {
                let hash = hash.to_string();
                Head {
                    title: format!("Block {}", short(&hash)),
                    description: format!(
                        "{on} block {hash}: its height, miner, fees and transactions."
                    ),
                }
            }
            (None, None) => {
                let h = group(u64::from(by_height.ok()?));
                Head {
                    title: format!("Block {h}"),
                    description: format!("{on} block {h}: its miner, fees and transactions."),
                }
            }
        })
    }

    /// The block table's row, if the table is open, holds the block, and a read slot is free.
    async fn row(
        &self,
        ctx: &NetworkContext,
        height: Option<u32>,
        hash: Option<bitcoin::BlockHash>,
    ) -> Option<Row> {
        let store = &ctx.blocks.as_ref()?.store;
        let _slot = self.reads.try_acquire().ok()?;
        match (height, hash) {
            (Some(h), _) => engine::blocks::by_height(store, h).await,
            (None, Some(h)) => engine::blocks::by_hash(store, h).await,
            (None, None) => return None,
        }
        .ok()
        .flatten()
    }
}

/// The network a page path is on, and the path after its prefix.
fn split(path: &str) -> (Network, &str) {
    Network::ALL
        .into_iter()
        .filter(|n| !n.path_prefix().is_empty())
        .find_map(|n| {
            let rest = path.strip_prefix(n.path_prefix())?;
            (rest.is_empty() || rest.starts_with('/')).then_some((n, rest))
        })
        .unwrap_or((Network::Mainnet, path))
}

/// How a description names the chain.
fn chain(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "Bitcoin",
        Network::Signet => "Signet",
        Network::Testnet4 => "Testnet4",
        Network::Testnet5 => "Testnet5",
        Network::Regtest => "Regtest",
    }
}

/// What a test network's titles start with, as `NETWORK_NAMES` in `web/src/lib/network.ts`.
fn title_prefix(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "",
        Network::Signet => "Signet: ",
        Network::Testnet4 => "Testnet4: ",
        Network::Testnet5 => "Testnet5: ",
        Network::Regtest => "Regtest: ",
    }
}

/// A height as the frontend takes one: 1 to 10 decimal digits within `u32` (`parseBlockId`).
pub(crate) fn height(s: &str) -> Result<u32, ()> {
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    s.parse().map_err(|_| ())
}

/// `/block/next` and `/block/next/:n`, `n` from 1 to 8, named as `positionName` names them.
fn projected(on: &str, n: Option<&str>) -> Option<Head> {
    const ORDINALS: [&str; 6] = ["Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh"];
    let n = match n {
        None => 1,
        Some(s) if s.len() == 1 => s.parse::<usize>().ok().filter(|n| (1..=8).contains(n))?,
        Some(_) => return None,
    };
    Some(match n {
        1 => Head {
            title: "Next block".into(),
            description: format!(
                "The block {on}'s mempool would fill next: its transactions and fee rates, live."
            ),
        },
        8 => Head {
            title: "The rest of the mempool".into(),
            description: format!(
                "Everything in {on}'s mempool past the next seven blocks: its transactions and fee rates, live."
            ),
        },
        n => {
            let name = ORDINALS.get(n - 2)?;
            Head {
                title: format!("{name} block from now"),
                description: format!(
                    "The {} block from now, as {on}'s mempool would fill it: its transactions and fee rates, live.",
                    name.to_lowercase()
                ),
            }
        }
    })
}

/// `/lightning/node/:key`. The alias is the node's own claim, read from the graph in memory.
fn node(ctx: &NetworkContext, on: &str, key: &str) -> Option<Head> {
    let id = lightning::nodes::pubkey(key).ok()?;
    let hex: String = id.iter().fold(String::with_capacity(66), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    });
    let index = ctx.lightning.as_ref().and_then(|l| l.index());
    let Some(n) = index.as_deref().and_then(|i| i.node(&id)) else {
        return Some(Head {
            title: "Lightning node".into(),
            description: format!("Lightning node {hex} on {on}: its channels, capacity and fees."),
        });
    };
    // The index cleaned it already; cleaning again changes nothing, and keeps the page's HTML
    // from depending on how the index it reads was built.
    let name = n
        .alias()
        .and_then(clean_alias)
        .unwrap_or_else(|| hex.get(..20).unwrap_or_default().to_owned());
    Some(Head {
        title: format!("Lightning node {name}"),
        description: format!(
            "Lightning node {hex} on {on}: {} and {} BTC of capacity.",
            count(u32::try_from(n.open()).unwrap_or(u32::MAX), "open channel"),
            btc(n.capacity)
        ),
    })
}

/// `/lightning/rankings?by=`, as `parseRanking` reads `URLSearchParams`: the first `by`, its
/// name and value decoded, and capacity for anything else.
fn rankings(on: &str, query: Option<&str>) -> Head {
    let (words, which) = match ranking(query) {
        Some("channels") => ("by open channels", "with the most open channels"),
        Some("age") => ("oldest first", "that have been around longest"),
        _ => ("by capacity", "with the most capacity"),
    };
    Head {
        title: format!("Lightning nodes {words}"),
        description: format!("The 100 Lightning nodes on {on} {which}."),
    }
}

/// The rankings page's order, `channels` or `age`, or `None` for capacity, its default.
fn ranking(query: Option<&str>) -> Option<&'static str> {
    let decode = lightning::nodes::decode;
    let by = query.unwrap_or_default().split('&').find_map(|p| {
        let (name, value) = p.split_once('=').unwrap_or((p, ""));
        (decode(name).as_deref() == Some("by")).then(|| decode(value))
    });
    match by.flatten().as_deref() {
        Some("channels") => Some("channels"),
        Some("age") => Some("age"),
        _ => None,
    }
}

/// The alias as `cleanAlias` in `web/src/pages/lightning/lightning.ts` makes it: control and
/// format characters (but the joiner emoji are built with) become U+FFFD, and a run of combining
/// marks keeps its first two. `None` when no name is left. The index applies it to every alias it
/// holds, so the API, search and the node page's title serve the same text. Gossip
/// limits an alias to 32 bytes, under the page's 64-character cut.
pub(crate) fn clean_alias(alias: &str) -> Option<String> {
    let mut out = String::with_capacity(alias.len());
    let mut marks = 0;
    for c in alias.chars() {
        let c = if c.is_control() || (c != '\u{200d}' && within(FORMAT, c)) {
            '\u{fffd}'
        } else {
            c
        };
        marks = if within(MARKS, c) { marks + 1 } else { 0 };
        if marks <= 2 {
            out.push(c);
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

fn within(table: &[(u32, u32)], c: char) -> bool {
    let c = u32::from(c);
    table
        .binary_search_by(|&(lo, hi)| {
            if hi < c {
                std::cmp::Ordering::Less
            } else if lo > c {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

// The general categories Cf and M (Mn, Mc, Me) as the frontend's `\p{Cf}` and `\p{M}` match
// them: generated by testing every code point against those regular expressions under Bun
// (Unicode 17.0). Regenerate when the browsers' Unicode moves on.
#[rustfmt::skip]
const FORMAT: &[(u32, u32)] = &[
    (0xad, 0xad), (0x600, 0x605), (0x61c, 0x61c), (0x6dd, 0x6dd), (0x70f, 0x70f), (0x890, 0x891),
    (0x8e2, 0x8e2), (0x180e, 0x180e), (0x200b, 0x200f), (0x202a, 0x202e), (0x2060, 0x2064), (0x2066, 0x206f),
    (0xfeff, 0xfeff), (0xfff9, 0xfffb), (0x110bd, 0x110bd), (0x110cd, 0x110cd), (0x13430, 0x1343f), (0x1bca0, 0x1bca3),
    (0x1d173, 0x1d17a), (0xe0001, 0xe0001), (0xe0020, 0xe007f),
];
#[rustfmt::skip]
const MARKS: &[(u32, u32)] = &[
    (0x300, 0x36f), (0x483, 0x489), (0x591, 0x5bd), (0x5bf, 0x5bf), (0x5c1, 0x5c2), (0x5c4, 0x5c5),
    (0x5c7, 0x5c7), (0x610, 0x61a), (0x64b, 0x65f), (0x670, 0x670), (0x6d6, 0x6dc), (0x6df, 0x6e4),
    (0x6e7, 0x6e8), (0x6ea, 0x6ed), (0x711, 0x711), (0x730, 0x74a), (0x7a6, 0x7b0), (0x7eb, 0x7f3),
    (0x7fd, 0x7fd), (0x816, 0x819), (0x81b, 0x823), (0x825, 0x827), (0x829, 0x82d), (0x859, 0x85b),
    (0x897, 0x89f), (0x8ca, 0x8e1), (0x8e3, 0x903), (0x93a, 0x93c), (0x93e, 0x94f), (0x951, 0x957),
    (0x962, 0x963), (0x981, 0x983), (0x9bc, 0x9bc), (0x9be, 0x9c4), (0x9c7, 0x9c8), (0x9cb, 0x9cd),
    (0x9d7, 0x9d7), (0x9e2, 0x9e3), (0x9fe, 0x9fe), (0xa01, 0xa03), (0xa3c, 0xa3c), (0xa3e, 0xa42),
    (0xa47, 0xa48), (0xa4b, 0xa4d), (0xa51, 0xa51), (0xa70, 0xa71), (0xa75, 0xa75), (0xa81, 0xa83),
    (0xabc, 0xabc), (0xabe, 0xac5), (0xac7, 0xac9), (0xacb, 0xacd), (0xae2, 0xae3), (0xafa, 0xaff),
    (0xb01, 0xb03), (0xb3c, 0xb3c), (0xb3e, 0xb44), (0xb47, 0xb48), (0xb4b, 0xb4d), (0xb55, 0xb57),
    (0xb62, 0xb63), (0xb82, 0xb82), (0xbbe, 0xbc2), (0xbc6, 0xbc8), (0xbca, 0xbcd), (0xbd7, 0xbd7),
    (0xc00, 0xc04), (0xc3c, 0xc3c), (0xc3e, 0xc44), (0xc46, 0xc48), (0xc4a, 0xc4d), (0xc55, 0xc56),
    (0xc62, 0xc63), (0xc81, 0xc83), (0xcbc, 0xcbc), (0xcbe, 0xcc4), (0xcc6, 0xcc8), (0xcca, 0xccd),
    (0xcd5, 0xcd6), (0xce2, 0xce3), (0xcf3, 0xcf3), (0xd00, 0xd03), (0xd3b, 0xd3c), (0xd3e, 0xd44),
    (0xd46, 0xd48), (0xd4a, 0xd4d), (0xd57, 0xd57), (0xd62, 0xd63), (0xd81, 0xd83), (0xdca, 0xdca),
    (0xdcf, 0xdd4), (0xdd6, 0xdd6), (0xdd8, 0xddf), (0xdf2, 0xdf3), (0xe31, 0xe31), (0xe34, 0xe3a),
    (0xe47, 0xe4e), (0xeb1, 0xeb1), (0xeb4, 0xebc), (0xec8, 0xece), (0xf18, 0xf19), (0xf35, 0xf35),
    (0xf37, 0xf37), (0xf39, 0xf39), (0xf3e, 0xf3f), (0xf71, 0xf84), (0xf86, 0xf87), (0xf8d, 0xf97),
    (0xf99, 0xfbc), (0xfc6, 0xfc6), (0x102b, 0x103e), (0x1056, 0x1059), (0x105e, 0x1060), (0x1062, 0x1064),
    (0x1067, 0x106d), (0x1071, 0x1074), (0x1082, 0x108d), (0x108f, 0x108f), (0x109a, 0x109d), (0x135d, 0x135f),
    (0x1712, 0x1715), (0x1732, 0x1734), (0x1752, 0x1753), (0x1772, 0x1773), (0x17b4, 0x17d3), (0x17dd, 0x17dd),
    (0x180b, 0x180d), (0x180f, 0x180f), (0x1885, 0x1886), (0x18a9, 0x18a9), (0x1920, 0x192b), (0x1930, 0x193b),
    (0x1a17, 0x1a1b), (0x1a55, 0x1a5e), (0x1a60, 0x1a7c), (0x1a7f, 0x1a7f), (0x1ab0, 0x1add), (0x1ae0, 0x1aeb),
    (0x1b00, 0x1b04), (0x1b34, 0x1b44), (0x1b6b, 0x1b73), (0x1b80, 0x1b82), (0x1ba1, 0x1bad), (0x1be6, 0x1bf3),
    (0x1c24, 0x1c37), (0x1cd0, 0x1cd2), (0x1cd4, 0x1ce8), (0x1ced, 0x1ced), (0x1cf4, 0x1cf4), (0x1cf7, 0x1cf9),
    (0x1dc0, 0x1dff), (0x20d0, 0x20f0), (0x2cef, 0x2cf1), (0x2d7f, 0x2d7f), (0x2de0, 0x2dff), (0x302a, 0x302f),
    (0x3099, 0x309a), (0xa66f, 0xa672), (0xa674, 0xa67d), (0xa69e, 0xa69f), (0xa6f0, 0xa6f1), (0xa802, 0xa802),
    (0xa806, 0xa806), (0xa80b, 0xa80b), (0xa823, 0xa827), (0xa82c, 0xa82c), (0xa880, 0xa881), (0xa8b4, 0xa8c5),
    (0xa8e0, 0xa8f1), (0xa8ff, 0xa8ff), (0xa926, 0xa92d), (0xa947, 0xa953), (0xa980, 0xa983), (0xa9b3, 0xa9c0),
    (0xa9e5, 0xa9e5), (0xaa29, 0xaa36), (0xaa43, 0xaa43), (0xaa4c, 0xaa4d), (0xaa7b, 0xaa7d), (0xaab0, 0xaab0),
    (0xaab2, 0xaab4), (0xaab7, 0xaab8), (0xaabe, 0xaabf), (0xaac1, 0xaac1), (0xaaeb, 0xaaef), (0xaaf5, 0xaaf6),
    (0xabe3, 0xabea), (0xabec, 0xabed), (0xfb1e, 0xfb1e), (0xfe00, 0xfe0f), (0xfe20, 0xfe2f), (0x101fd, 0x101fd),
    (0x102e0, 0x102e0), (0x10376, 0x1037a), (0x10a01, 0x10a03), (0x10a05, 0x10a06), (0x10a0c, 0x10a0f), (0x10a38, 0x10a3a),
    (0x10a3f, 0x10a3f), (0x10ae5, 0x10ae6), (0x10d24, 0x10d27), (0x10d69, 0x10d6d), (0x10eab, 0x10eac), (0x10efa, 0x10eff),
    (0x10f46, 0x10f50), (0x10f82, 0x10f85), (0x11000, 0x11002), (0x11038, 0x11046), (0x11070, 0x11070), (0x11073, 0x11074),
    (0x1107f, 0x11082), (0x110b0, 0x110ba), (0x110c2, 0x110c2), (0x11100, 0x11102), (0x11127, 0x11134), (0x11145, 0x11146),
    (0x11173, 0x11173), (0x11180, 0x11182), (0x111b3, 0x111c0), (0x111c9, 0x111cc), (0x111ce, 0x111cf), (0x1122c, 0x11237),
    (0x1123e, 0x1123e), (0x11241, 0x11241), (0x112df, 0x112ea), (0x11300, 0x11303), (0x1133b, 0x1133c), (0x1133e, 0x11344),
    (0x11347, 0x11348), (0x1134b, 0x1134d), (0x11357, 0x11357), (0x11362, 0x11363), (0x11366, 0x1136c), (0x11370, 0x11374),
    (0x113b8, 0x113c0), (0x113c2, 0x113c2), (0x113c5, 0x113c5), (0x113c7, 0x113ca), (0x113cc, 0x113d0), (0x113d2, 0x113d2),
    (0x113e1, 0x113e2), (0x11435, 0x11446), (0x1145e, 0x1145e), (0x114b0, 0x114c3), (0x115af, 0x115b5), (0x115b8, 0x115c0),
    (0x115dc, 0x115dd), (0x11630, 0x11640), (0x116ab, 0x116b7), (0x1171d, 0x1172b), (0x1182c, 0x1183a), (0x11930, 0x11935),
    (0x11937, 0x11938), (0x1193b, 0x1193e), (0x11940, 0x11940), (0x11942, 0x11943), (0x119d1, 0x119d7), (0x119da, 0x119e0),
    (0x119e4, 0x119e4), (0x11a01, 0x11a0a), (0x11a33, 0x11a39), (0x11a3b, 0x11a3e), (0x11a47, 0x11a47), (0x11a51, 0x11a5b),
    (0x11a8a, 0x11a99), (0x11b60, 0x11b67), (0x11c2f, 0x11c36), (0x11c38, 0x11c3f), (0x11c92, 0x11ca7), (0x11ca9, 0x11cb6),
    (0x11d31, 0x11d36), (0x11d3a, 0x11d3a), (0x11d3c, 0x11d3d), (0x11d3f, 0x11d45), (0x11d47, 0x11d47), (0x11d8a, 0x11d8e),
    (0x11d90, 0x11d91), (0x11d93, 0x11d97), (0x11ef3, 0x11ef6), (0x11f00, 0x11f01), (0x11f03, 0x11f03), (0x11f34, 0x11f3a),
    (0x11f3e, 0x11f42), (0x11f5a, 0x11f5a), (0x13440, 0x13440), (0x13447, 0x13455), (0x1611e, 0x1612f), (0x16af0, 0x16af4),
    (0x16b30, 0x16b36), (0x16f4f, 0x16f4f), (0x16f51, 0x16f87), (0x16f8f, 0x16f92), (0x16fe4, 0x16fe4), (0x16ff0, 0x16ff1),
    (0x1bc9d, 0x1bc9e), (0x1cf00, 0x1cf2d), (0x1cf30, 0x1cf46), (0x1d165, 0x1d169), (0x1d16d, 0x1d172), (0x1d17b, 0x1d182),
    (0x1d185, 0x1d18b), (0x1d1aa, 0x1d1ad), (0x1d242, 0x1d244), (0x1da00, 0x1da36), (0x1da3b, 0x1da6c), (0x1da75, 0x1da75),
    (0x1da84, 0x1da84), (0x1da9b, 0x1da9f), (0x1daa1, 0x1daaf), (0x1e000, 0x1e006), (0x1e008, 0x1e018), (0x1e01b, 0x1e021),
    (0x1e023, 0x1e024), (0x1e026, 0x1e02a), (0x1e08f, 0x1e08f), (0x1e130, 0x1e136), (0x1e2ae, 0x1e2ae), (0x1e2ec, 0x1e2ef),
    (0x1e4ec, 0x1e4ef), (0x1e5ee, 0x1e5ef), (0x1e6e3, 0x1e6e3), (0x1e6e6, 0x1e6e6), (0x1e6ee, 0x1e6ef), (0x1e6f5, 0x1e6f5),
    (0x1e8d0, 0x1e8d6), (0x1e944, 0x1e94a), (0xe0100, 0xe01ef),
];

/// Shortens a hash or address in the middle, as `truncateMiddle` does: 8 first, `…`, 8 last.
fn short(s: &str) -> String {
    // Only parsed hashes and addresses come here: ASCII, so byte offsets are characters.
    match (s.get(..8), s.get(s.len().saturating_sub(8)..)) {
        (Some(head), Some(tail)) if s.len() > 17 => format!("{head}…{tail}"),
        _ => s.to_owned(),
    }
}

/// Digits in threes, as `groupDigits`.
fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 * 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(NNBSP);
        }
        out.push(c);
    }
    out
}

fn count(n: u32, what: &str) -> String {
    format!(
        "{} {what}{}",
        group(u64::from(n)),
        if n == 1 { "" } else { "s" }
    )
}

/// Sats as BTC with eight decimals.
fn btc(sats: u64) -> String {
    format!("{}.{:08}", group(sats / 100_000_000), sats % 100_000_000)
}

/// Text for an HTML text node or a double-quoted attribute.
fn escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
}

/// Where a page is, for the picture card's absolute addresses.
struct Address<'a> {
    /// `SITE_URL`, checked at start: an origin with no trailing slash.
    site: &'a str,
    /// The request's path, as the client sent it.
    path: &'a str,
    /// The rankings page's order, the one query that names a page, as [`ranking`] reads it.
    by: Option<&'static str>,
    /// The page's own picture, for a transaction or a block; else the site's one.
    card: Option<Card>,
}

/// A transaction's or block's own picture (`cards`): its path under the site, written from the
/// parsed id alone, and what it shows.
#[derive(Debug, PartialEq, Eq)]
struct Card {
    path: String,
    alt: String,
}

/// The card for a transaction or block page's path, its id parsed as [`Pages::head`] parses it.
fn card(network: Network, rest: &str) -> Option<Card> {
    let on = chain(network);
    let prefix = network.path_prefix();
    let mut segs = rest.split('/');
    let s = [segs.next(), segs.next(), segs.next(), segs.next()];
    match s {
        [_, Some("tx"), Some(id), None] => {
            let txid = esplora::txid(id).ok()?;
            Some(Card {
                path: format!("{prefix}/app/card/tx/{txid}.png"),
                alt: format!(
                    "{on} transaction {txid}: its amount, fee rate, fee, size and status, with its block among the newest blocks."
                ),
            })
        }
        [_, Some("block"), Some(id), None] if id != "next" => {
            let id = crate::cards::block_id(id)?;
            Some(Card {
                path: format!("{prefix}/app/card/block/{id}.png"),
                alt: format!(
                    "{on} block {id}: its height, time, miner, transactions and fees, with its neighbours in the chain."
                ),
            })
        }
        _ => None,
    }
}

/// The title element and the preview tags that replace the build's `<title>`. With the site's
/// address, a picture card; without it, a text card, as no absolute address can be written.
fn render(network: Network, head: &Head, at: Option<&Address<'_>>) -> String {
    let mut title = String::from(title_prefix(network));
    escape(&head.title, &mut title);
    let mut description = String::new();
    escape(&head.description, &mut description);
    let mut out = format!(
        "<title>{title} | {SITE}</title>\n    \
         <meta name=\"description\" content=\"{description}\" />\n    \
         <meta property=\"og:title\" content=\"{title}\" />\n    \
         <meta property=\"og:description\" content=\"{description}\" />\n    \
         <meta property=\"og:type\" content=\"website\" />\n    \
         <meta property=\"og:site_name\" content=\"{SITE}\" />\n    "
    );
    let Some(at) = at else {
        out.push_str("<meta name=\"twitter:card\" content=\"summary\" />");
        return out;
    };
    let mut site = String::new();
    escape(at.site, &mut site);
    let mut url = site.clone();
    escape(at.path, &mut url);
    if let Some(by) = at.by {
        let _ = write!(url, "?by={by}");
    }
    let (mut image, mut alt) = (site.clone(), String::new());
    match &at.card {
        Some(c) => {
            escape(&c.path, &mut image);
            escape(&c.alt, &mut alt);
        }
        None => {
            image.push_str(IMAGE);
            alt.push_str(IMAGE_ALT);
        }
    }
    let _ = write!(
        out,
        "<meta property=\"og:url\" content=\"{url}\" />\n    \
         <meta property=\"og:image\" content=\"{image}\" />\n    \
         <meta property=\"og:image:type\" content=\"image/png\" />\n    \
         <meta property=\"og:image:width\" content=\"1200\" />\n    \
         <meta property=\"og:image:height\" content=\"630\" />\n    \
         <meta property=\"og:image:alt\" content=\"{alt}\" />\n    \
         <meta name=\"twitter:card\" content=\"summary_large_image\" />\n    \
         <meta name=\"twitter:image\" content=\"{image}\" />"
    );
    out
}

/// Every page path: the shell, its head filled in for the page.
pub(crate) async fn page(State(pages): State<Arc<Pages>>, uri: Uri) -> Response {
    let Some(shell) = &pages.shell else {
        return ApiError::NOT_FOUND.into_response();
    };
    let (path, query) = (uri.path(), uri.query());
    let html = match (shell.title, pages.head(path, query).await) {
        (Some((start, end)), Some((network, head))) => {
            let (before, after) = (
                shell.raw.get(..start).unwrap_or_default(),
                shell.raw.get(end..).unwrap_or_default(),
            );
            // Only the rankings page is named by its query, and only by `by`; the rest is left out.
            let by = (split(path).1 == "/lightning/rankings")
                .then(|| ranking(query))
                .flatten();
            let at = pages.site.as_deref().map(|site| Address {
                site,
                path,
                by,
                card: card(network, split(path).1),
            });
            format!("{before}{}{after}", render(network, &head, at.as_ref()))
        }
        _ => shell.raw.clone(),
    };
    (
        [(CONTENT_TYPE, "text/html; charset=utf-8")],
        Body::from(html),
    )
        .into_response()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn markup_and_quotes_are_escaped() {
        let mut out = String::new();
        escape("<a href=\"x\" onclick='y'>&amp;</a>", &mut out);
        assert_eq!(
            out,
            "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;"
        );
    }

    #[test]
    fn numbers_are_written_as_the_frontend_writes_them() {
        assert_eq!(group(0), "0");
        assert_eq!(group(975), "975");
        assert_eq!(group(975_411), "975\u{202f}411");
        assert_eq!(group(1_234_567), "1\u{202f}234\u{202f}567");
        assert_eq!(btc(12_345), "0.00012345");
        assert_eq!(
            btc(2_100_000_000_000_000),
            "21\u{202f}000\u{202f}000.00000000"
        );
        assert_eq!(count(1, "transaction"), "1 transaction");
        assert_eq!(count(4198, "transaction"), "4\u{202f}198 transactions");
        assert_eq!(short("a3f9c2e1aaaaaaaaaaaaaa7b0d44e9"), "a3f9c2e1…7b0d44e9");
        assert_eq!(short("bcrt1pfeesnyr2tx"), "bcrt1pfeesnyr2tx");
    }

    #[test]
    fn heights_are_what_the_frontend_takes() {
        assert_eq!(height("0"), Ok(0));
        assert_eq!(height("0975411"), Ok(975_411));
        assert_eq!(height("4294967295"), Ok(u32::MAX));
        for bad in [
            "",
            "4294967296",
            "+5",
            "-1",
            "1e3",
            "12345678901",
            " 1",
            "１",
        ] {
            assert_eq!(height(bad), Err(()), "{bad}");
        }
    }

    #[test]
    fn aliases_are_cleaned_as_the_frontend_cleans_them() {
        // Each expectation is what `cleanAlias` returned for the same input under Bun.
        for (alias, clean) in [
            ("ACINQ ⚡️", Some("ACINQ ⚡️")),
            ("مرحبا", Some("مرحبا")),
            ("नमस्ते", Some("नमस्ते")),
            ("👨‍👩‍👧", Some("👨‍👩‍👧")),
            ("1️⃣", Some("1️⃣")),
            ("a\u{202e}b", Some("a\u{fffd}b")),
            ("a\u{200b}b", Some("a\u{fffd}b")),
            ("a\u{0}b", Some("a\u{fffd}b")),
            ("e\u{301}\u{301}\u{301}\u{301}x", Some("e\u{301}\u{301}x")),
            ("x\u{fe0f}\u{fe0f}\u{fe0f}", Some("x\u{fe0f}\u{fe0f}")),
            // A mark assigned in Unicode 16.
            ("x\u{897}\u{897}\u{897}", Some("x\u{897}\u{897}")),
            (
                "Z\u{351}\u{352}\u{353}a\u{354}\u{355}",
                Some("Z\u{351}\u{352}a\u{354}\u{355}"),
            ),
            ("\u{ad}", Some("\u{fffd}")),
            ("\u{feff} ", Some("\u{fffd} ")),
            ("   ", None),
            (" \u{3000} ", None),
            ("", None),
        ] {
            assert_eq!(clean_alias(alias).as_deref(), clean, "{alias:?}");
        }
    }

    #[test]
    fn paths_split_into_network_and_page() {
        assert_eq!(split("/"), (Network::Mainnet, "/"));
        assert_eq!(split("/signet"), (Network::Signet, ""));
        assert_eq!(split("/signet/tx/a"), (Network::Signet, "/tx/a"));
        assert_eq!(split("/signetx/tx"), (Network::Mainnet, "/signetx/tx"));
        assert_eq!(split("/regtest/"), (Network::Regtest, "/"));
    }

    fn tx() -> Head {
        Head {
            title: "Transaction a3f9c2e1…7b0d44e9".into(),
            description: "Bitcoin transaction a3f9: its inputs.".into(),
        }
    }

    #[test]
    fn a_hostile_path_is_escaped_in_the_page_address() {
        let at = Address {
            site: "https://rbitcoin.space",
            path: "/tx/\"><script>alert('x')</script>&",
            by: None,
            card: None,
        };
        let html = render(Network::Mainnet, &tx(), Some(&at));
        assert!(html.contains(
            "content=\"https://rbitcoin.space/tx/&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;\""
        ));
        assert!(!html.contains("<script") && !html.contains("'x'"), "{html}");
    }

    #[test]
    fn transaction_and_block_pages_name_their_card_from_the_parsed_id() {
        let txid = "4a705c0b4a53b3b9991663d5adae4959d67841d12b9a1ef3666934518c42e459";
        let c = card(Network::Signet, &format!("/tx/{}", txid.to_uppercase())).unwrap();
        assert_eq!(c.path, format!("/signet/app/card/tx/{txid}.png"));
        assert!(
            c.alt.starts_with(&format!("Signet transaction {txid}: ")),
            "{}",
            c.alt
        );
        let c = card(Network::Mainnet, "/block/0976200").unwrap();
        assert_eq!(c.path, "/app/card/block/976200.png");
        let hash = "00000000000000000001241ca13d41915e64b9dc6e5059d7b6fc7ad193c9cb61";
        let c = card(Network::Regtest, &format!("/block/{hash}")).unwrap();
        assert_eq!(c.path, format!("/regtest/app/card/block/{hash}.png"));
        for rest in [
            "/".to_owned(),
            "/block/next".to_owned(),
            "/block/next/2".to_owned(),
            format!("/tx/{txid}/x"),
            format!("/tx/{}", &txid[1..]),
            "/tx/<script>".to_owned(),
            "/block/12345678901".to_owned(),
            format!("/address/{txid}"),
            "/blocks/5".to_owned(),
        ] {
            assert_eq!(card(Network::Mainnet, &rest), None, "{rest}");
        }
    }

    #[test]
    fn a_card_is_the_picture_and_its_words_are_escaped() {
        let at = Address {
            site: "https://rbitcoin.space",
            path: "/tx/x\"><b>",
            by: None,
            card: Some(Card {
                path: "/app/card/tx/a.png".into(),
                alt: "a <b> & \"c\"".into(),
            }),
        };
        let html = render(Network::Mainnet, &tx(), Some(&at));
        for tag in [
            "<meta property=\"og:image\" content=\"https://rbitcoin.space/app/card/tx/a.png\" />",
            "<meta name=\"twitter:image\" content=\"https://rbitcoin.space/app/card/tx/a.png\" />",
            "<meta property=\"og:image:alt\" content=\"a &lt;b&gt; &amp; &quot;c&quot;\" />",
            "<meta property=\"og:url\" content=\"https://rbitcoin.space/tx/x&quot;&gt;&lt;b&gt;\" />",
        ] {
            assert!(html.contains(tag), "{tag} in {html}");
        }
        assert!(!html.contains(IMAGE) && !html.contains("<b>"), "{html}");
    }

    /// The picture is a 1200 by 630 PNG under 300 KB, named for its own bytes, so a redrawn one
    /// cannot keep an address chat apps have cached.
    #[test]
    fn the_picture_is_the_size_its_tags_say_and_named_for_its_bytes() {
        use bitcoin::hashes::{Hash, sha256};
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/public")
            .join(IMAGE.trim_start_matches('/'));
        let png = std::fs::read(&file).unwrap();
        assert!(png.len() < 300 * 1024, "{} bytes", png.len());
        assert_eq!(png.get(..8), Some(&b"\x89PNG\r\n\x1a\n"[..]));
        assert_eq!(png.get(12..16), Some(&b"IHDR"[..]));
        assert_eq!(png.get(16..24), Some(&[0, 0, 4, 176, 0, 0, 2, 118][..]));
        let hash = sha256::Hash::hash(&png).to_string();
        let name = IMAGE.trim_start_matches("/assets/preview-");
        assert_eq!(name, format!("{}.png", &hash[..8]), "rename the picture");
    }
}
