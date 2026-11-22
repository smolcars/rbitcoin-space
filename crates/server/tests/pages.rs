//! Page paths end to end: the server on port 0 serves the app shell with a head that says what
//! each page is, on every network, from parsed identifiers, its block table and its Lightning
//! graph, and never asks the node. The mock node records every byte it is sent, so a test can
//! show that no identifier from a page path reached it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::http::{Method, Uri};
use axum::routing::any;
use bitcoin::BlockHash;
use bitcoin::hashes::Hash;
use engine::lightning::{Announcement, GraphChannel, GraphNode, Index, Past};
use engine::store::{Options, Store, params};
use rbitcoin_space::{App, Config, SECURITY_HEADERS};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The shell as written; the build keeps its head's `<title>` element as it is here.
const SHELL: &str = include_str!("../../../web/index.html");
const SITE: &str = " | rbitcoin.space";

const TXID: &str = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
/// One Arkade address's keys under mainnet's prefix and the test networks'.
const ARK_MAIN: &str = "ark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqn9qxkrw";
const ARK_TEST: &str = "tark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqnrjdp6x";
const GENESIS: &str = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
/// A block only the regtest table holds, at [`KNOWN_HEIGHT`].
const KNOWN: &str = "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";
const KNOWN_HEIGHT: u32 = 7;
/// A transaction the mock node knows, confirmed in [`KNOWN`].
const CARD_TX: &str = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
/// Transactions whose ids start so the mock node takes 5 s to answer: longer than a card waits.
const SLOW: &str = "5105";
/// The site's static link preview picture, as the build copies it to `/assets`.
const PICTURE: &str = "assets/preview-55449820.png";
/// Foundry USA's first listed payout script, so the block's miner is named.
const FOUNDRY: &str = "76a9140e6ed2f95e8a7f3131535472e1009a1c77bd01e588ac";

// The node: everything it is sent, Esplora and RPC over HTTP, Electrum over TCP.

type Log = Arc<Mutex<Vec<String>>>;

async fn mock_node() -> (u16, u16, Log) {
    let log: Log = Arc::default();
    let l = Arc::clone(&log);
    let http = axum::Router::new().fallback(any(move |m: Method, u: Uri, body: Bytes| {
        l.lock()
            .unwrap()
            .push(format!("{m} {u} {}", String::from_utf8_lossy(&body)));
        // One transaction, for its card; nothing else exists. A node that hangs on [`SLOW`].
        let found = u.path() == format!("/tx/{CARD_TX}");
        let slow = u.path().starts_with(&format!("/tx/{SLOW}"));
        async move {
            if slow {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            if found {
                let tx = format!(
                    "{{\"txid\":\"{CARD_TX}\",\"fee\":1410,\"weight\":561,\"vout\":[{{\"value\":5000}},{{\"value\":12345}}],\
                     \"status\":{{\"confirmed\":true,\"block_height\":7,\"block_hash\":\"{KNOWN}\",\"block_time\":1700000000}}}}"
                );
                (axum::http::StatusCode::OK, tx)
            } else {
                (axum::http::StatusCode::NOT_FOUND, "{}".to_owned())
            }
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, http).await });

    let electrum = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let electrum_port = electrum.local_addr().unwrap().port();
    let l = Arc::clone(&log);
    tokio::spawn(async move {
        while let Ok((mut s, _)) = electrum.accept().await {
            let l = Arc::clone(&l);
            tokio::spawn(async move {
                let mut buf = vec![0; 4096];
                while let Ok(n @ 1..) = s.read(&mut buf).await {
                    l.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&buf[..n]).into_owned());
                }
            });
        }
    });
    (http_port, electrum_port, log)
}

// The store: one block row on regtest.

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(name: &str) -> Dir {
    let d = std::env::temp_dir().join(format!(
        "rbitcoin-space-pages-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("web/assets")).unwrap();
    std::fs::write(d.join("web/index.html"), SHELL).unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/public")
            .join(PICTURE),
        d.join("web").join(PICTURE),
    )
    .unwrap();
    Dir(d)
}

const INSERT: &str = "INSERT INTO blocks (height, hash, time, tx_count, size, weight, \
    paying_weight, fees, subsidy, reward, difficulty, coinbase_tag, payouts, rated, fee_min, \
    fee_p10, fee_p25, fee_median, fee_p75, fee_p90, fee_max, band0, band1, band2, band3, band4, \
    band5, band6, band7, band8, band9, pool) VALUES (?1, ?2, ?3, 5, 1000, 4000, 3000, 10000, \
    5000000000, 5000010000, 4.656542373906925e-10, ?4, ?5, 0, NULL, NULL, NULL, NULL, NULL, NULL, \
    NULL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)";

async fn fill(dir: &Path) {
    let store = Store::open(dir, "regtest", Options::default()).unwrap();
    let hash = BlockHash::from_str(KNOWN).unwrap();
    store
        .write(move |sql| {
            let mut payouts = vec![25u8];
            payouts.extend(hex(FOUNDRY));
            sql.prepare(INSERT)?.execute(params![
                KNOWN_HEIGHT,
                &hash.as_byte_array()[..],
                1_700_000_000u32,
                b"<script>alert(1)</script>".to_vec(),
                payouts,
            ])?;
            Ok(())
        })
        .await
        .unwrap();
    store.close().await;
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

// The graph: four regtest nodes, each with a channel.

fn key(n: u8) -> [u8; 33] {
    let mut k = [n; 33];
    k[0] = 3;
    k
}

fn key_hex(n: u8) -> String {
    key(n).iter().map(|b| format!("{b:02x}")).collect()
}

const HOSTILE_ALIAS: &str = "<img src=x onerror=alert(1)>\"'&";

fn graph() -> Index {
    let node = |n: u8, alias: Option<&str>| GraphNode {
        id: key(n),
        announcement: alias.map(|a| Announcement {
            alias: a.to_owned(),
            color: [0, 0, 0],
            addresses: Vec::new(),
            features: Vec::new(),
            last_update: 1_790_000_000,
        }),
    };
    let nodes = vec![
        node(1, Some("ACINQ ⚡️")),
        node(2, Some(HOSTILE_ALIAS)),
        node(3, None),
        node(4, Some("a\u{202e}b")),
    ];
    let channel = |scid: u64, a: u8, b: u8, capacity: u64| GraphChannel {
        scid,
        nodes: [key(a), key(b)],
        capacity,
        policies: [None, None],
    };
    let channels = vec![
        channel(1 << 40, 1, 2, 5_000_000),
        channel(2 << 40, 1, 3, 2_000_000),
        channel(3 << 40, 4, 3, 100_000),
    ];
    Index::build(nodes, channels, &Past::default())
}

// The server.

/// Every network on, against the mock node; a store for each, holding one regtest block, and
/// Lightning on regtest with [`graph`].
async fn start(dir: &Path) -> (String, Log) {
    start_at(dir, None).await
}

/// The server, told its public address (`SITE_URL`) when `site` is set.
async fn start_at(dir: &Path, site: Option<&str>) -> (String, Log) {
    start_with(dir, site, &[]).await
}

/// With more settings.
async fn start_with(dir: &Path, site: Option<&str>, more: &[(&str, &str)]) -> (String, Log) {
    fill(dir).await;
    let (http, electrum, log) = mock_node().await;
    let mut vars: HashMap<String, String> = HashMap::new();
    for net in ["MAINNET", "SIGNET", "TESTNET4", "TESTNET5", "REGTEST"] {
        for (k, v) in [
            ("RPC_HOST", "127.0.0.1".to_owned()),
            ("RPC_PORT", http.to_string()),
            ("RPC_USER", "u".to_owned()),
            ("RPC_PASSWORD", "p".to_owned()),
            ("ESPLORA_URL", format!("http://127.0.0.1:{http}")),
            ("ELECTRUM_ADDR", format!("127.0.0.1:{electrum}")),
            ("MEMPOOL_ENABLED", "false".to_owned()),
        ] {
            vars.insert(format!("{net}_{k}"), v);
        }
    }
    vars.insert("REGTEST_LIGHTNING_ENABLED".into(), "true".into());
    vars.insert(
        "REGTEST_LIGHTNING_PEERS".into(),
        format!("{}@127.0.0.1:1", key_hex(9)),
    );
    vars.insert("BACKFILL_ENABLED".into(), "false".into());
    vars.insert("DATA_DIR".into(), dir.display().to_string());
    vars.insert("WEB_DIR".into(), dir.join("web").display().to_string());
    if let Some(site) = site {
        vars.insert("SITE_URL".into(), site.to_owned());
    }
    for (k, v) in more {
        vars.insert((*k).to_owned(), (*v).to_owned());
    }
    let config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let app = App::new(&config);
    app.lightning()[0].set_index(graph());
    tokio::spawn(app.serve(listener, std::future::pending()));
    (addr, log)
}

struct Reply {
    status: u16,
    head: String,
    body: String,
    bytes: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name}: ")))
    }

    /// The `<title>` element's text, entities as written.
    fn title(&self) -> &str {
        let start = self.body.find("<title>").unwrap() + "<title>".len();
        let end = self.body.find("</title>").unwrap();
        &self.body[start..end]
    }

    fn meta(&self, attr: &str, name: &str) -> &str {
        let tag = format!("<meta {attr}=\"{name}\" content=\"");
        let start = self.body.find(&tag).unwrap_or_else(|| panic!("no {name}")) + tag.len();
        let len = self.body[start..].find('"').unwrap();
        &self.body[start..start + len]
    }
}

/// `target` is sent as written, so a test can send what a browser would not.
async fn get(addr: &str, target: &str) -> Reply {
    get_with(addr, target, "").await
}

/// With more request headers, each ending `\r\n`.
async fn get_with(addr: &str, target: &str, headers: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {target} HTTP/1.1\r\nHost: t\r\n{headers}Connection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    Reply {
        status: head[9..12].parse().unwrap(),
        head,
        body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
        bytes: raw[split + 4..].to_vec(),
    }
}

/// The shell around its title element: what every filled page keeps byte for byte.
fn around_title() -> (&'static str, &'static str) {
    let start = SHELL.find("<title>").unwrap();
    let end = SHELL.find("</title>").unwrap() + "</title>".len();
    (&SHELL[..start], &SHELL[end..])
}

fn assert_filled(r: &Reply, path: &str) {
    assert_eq!(r.status, 200, "{path}");
    let (before, after) = around_title();
    assert!(r.body.starts_with(before), "{path}");
    assert!(r.body.ends_with(after), "{path}");
    let head = &r.body[before.len()..r.body.len() - after.len()];
    // Only the title and the preview tags are new, one element to a line.
    for line in head.lines().map(str::trim) {
        assert!(
            line.starts_with("<title>") && line.ends_with("</title>")
                || line.starts_with("<meta ") && line.ends_with(" />"),
            "{path}: {line}"
        );
    }
    assert_eq!(
        r.meta("property", "og:title"),
        r.title().strip_suffix(SITE).unwrap(),
        "{path}"
    );
    assert_eq!(
        r.meta("name", "description"),
        r.meta("property", "og:description"),
        "{path}"
    );
    assert_eq!(r.meta("property", "og:type"), "website");
    assert_eq!(r.meta("property", "og:site_name"), "rbitcoin.space");
    assert_eq!(r.meta("name", "twitter:card"), "summary");
    // No absolute URL: the server is not told its own address (docs/CONFIG.md).
    assert!(
        !r.body.contains("og:url") && !r.body.contains("canonical"),
        "{path}"
    );
}

#[tokio::test]
async fn every_kind_of_page_on_every_network_says_what_it_is() {
    let dir = temp("kinds");
    let (addr, _) = start(&dir.0).await;
    for (prefix, name, chain, address, short) in [
        (
            "",
            "",
            "Bitcoin",
            "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            "bc1qar0s…zzwf5mdq",
        ),
        (
            "/signet",
            "Signet: ",
            "Signet",
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            "tb1qw508…7kxpjzsx",
        ),
        (
            "/testnet4",
            "Testnet4: ",
            "Testnet4",
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            "tb1qw508…7kxpjzsx",
        ),
        (
            "/testnet5",
            "Testnet5: ",
            "Testnet5",
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            "tb1qw508…7kxpjzsx",
        ),
        (
            "/regtest",
            "Regtest: ",
            "Regtest",
            "bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s",
            "bcrt1qw5…npx95u7s",
        ),
    ] {
        let unknown_node = key_hex(0x77);
        let ark = if prefix.is_empty() {
            ARK_MAIN
        } else {
            ARK_TEST
        };
        let pages: Vec<(String, String, String)> = vec![
            (
                "/".into(),
                "Blocks and mempool".into(),
                format!(
                    "{chain}'s newest blocks, its mempool and the blocks it would fill next, live."
                ),
            ),
            (
                "/block/975411".into(),
                "Block 975\u{202f}411".into(),
                format!("{chain} block 975\u{202f}411: its miner, fees and transactions."),
            ),
            (
                format!("/block/{GENESIS}"),
                "Block 00000000…0a8ce26f".into(),
                format!("{chain} block {GENESIS}: its height, miner, fees and transactions."),
            ),
            (
                format!("/block/{}", GENESIS.to_uppercase()),
                "Block 00000000…0a8ce26f".into(),
                format!("{chain} block {GENESIS}: its height, miner, fees and transactions."),
            ),
            (
                "/block/next".into(),
                "Next block".into(),
                format!(
                    "The block {chain}'s mempool would fill next: its transactions and fee rates, live."
                ),
            ),
            (
                "/block/next/1".into(),
                "Next block".into(),
                format!(
                    "The block {chain}'s mempool would fill next: its transactions and fee rates, live."
                ),
            ),
            (
                "/block/next/2".into(),
                "Second block from now".into(),
                format!(
                    "The second block from now, as {chain}'s mempool would fill it: its transactions and fee rates, live."
                ),
            ),
            (
                "/block/next/7".into(),
                "Seventh block from now".into(),
                format!(
                    "The seventh block from now, as {chain}'s mempool would fill it: its transactions and fee rates, live."
                ),
            ),
            (
                "/block/next/8".into(),
                "The rest of the mempool".into(),
                format!(
                    "Everything in {chain}'s mempool past the next seven blocks: its transactions and fee rates, live."
                ),
            ),
            (
                "/blocks".into(),
                "Blocks".into(),
                format!(
                    "{chain}'s blocks, newest first: their time, miner, transactions, fees and size."
                ),
            ),
            (
                "/blocks/120000".into(),
                "Blocks".into(),
                format!(
                    "{chain}'s blocks from height 120\u{202f}000 down: their time, miner, transactions, fees and size."
                ),
            ),
            (
                format!("/tx/{TXID}"),
                "Transaction 4a5e1e4b…fdeda33b".into(),
                format!("{chain} transaction {TXID}: its inputs, outputs, fee and status."),
            ),
            (
                format!("/tx/{}", TXID.to_uppercase()),
                "Transaction 4a5e1e4b…fdeda33b".into(),
                format!("{chain} transaction {TXID}: its inputs, outputs, fee and status."),
            ),
            (
                format!("/address/{address}"),
                format!("Address {short}"),
                format!("{chain} address {address}: its balance and its transactions."),
            ),
            (
                format!("/address/{}", address.to_uppercase()),
                format!("Address {short}"),
                format!("{chain} address {address}: its balance and its transactions."),
            ),
            (
                "/mining".into(),
                "Mining".into(),
                format!(
                    "Who mines {chain}'s blocks: each pool's share, the hashrate, the difficulty and the rewards."
                ),
            ),
            (
                "/mining?period=1w".into(),
                "Mining".into(),
                format!(
                    "Who mines {chain}'s blocks: each pool's share, the hashrate, the difficulty and the rewards."
                ),
            ),
            (
                "/mining/pool/foundryusa".into(),
                "Foundry USA".into(),
                format!(
                    "Blocks mined by Foundry USA on {chain}: its share, its hashrate and its newest blocks."
                ),
            ),
            (
                "/mempool".into(),
                "Mempool history".into(),
                format!(
                    "{chain}'s mempool over time: its size by fee rate, and the flow in and out."
                ),
            ),
            (
                "/fees/score".into(),
                "Fee track record".into(),
                format!(
                    "How often this server's recommended fees on {chain} were mined in time: each level against its 85% target, what it cost, and what the figures rest on."
                ),
            ),
            (
                "/fees/score?window=24h".into(),
                "Fee track record".into(),
                format!(
                    "How often this server's recommended fees on {chain} were mined in time: each level against its 85% target, what it cost, and what the figures rest on."
                ),
            ),
            (
                "/lightning".into(),
                "Lightning".into(),
                format!(
                    "The Lightning network on {chain}, as this server's gossip peer sees it: nodes, channels and capacity over time."
                ),
            ),
            (
                format!("/lightning/node/{unknown_node}"),
                "Lightning node".into(),
                format!(
                    "Lightning node {unknown_node} on {chain}: its channels, capacity and fees."
                ),
            ),
            (
                "/lightning/channel/811984x2037x0".into(),
                "Lightning channel 811984x2037x0".into(),
                format!(
                    "Lightning channel 811984x2037x0 on {chain}: its capacity, its two nodes and their fees."
                ),
            ),
            (
                "/lightning/channel/892785849701564416".into(),
                "Lightning channel 892785849701564416".into(),
                format!(
                    "Lightning channel 892785849701564416 on {chain}: its capacity, its two nodes and their fees."
                ),
            ),
            (
                "/ark".into(),
                "Ark".into(),
                format!("Look up an Ark VTXO or address on {chain}."),
            ),
            (
                format!("/ark/vtxo/{}:7", "ab".repeat(32)),
                "Ark VTXO".into(),
                format!(
                    "Ark VTXO {}:7 on {chain}, on whichever Ark server knows it.",
                    "ab".repeat(32)
                ),
            ),
            (
                format!("/ark/bark/vtxo/{}:7", "ab".repeat(32)),
                "Bark VTXO".into(),
                format!(
                    "Bark VTXO {}:7 on {chain}: its amount, its expiry and its exit path, checked.",
                    "ab".repeat(32)
                ),
            ),
            (
                "/ark/bark/hex".into(),
                "Bark VTXO".into(),
                format!(
                    "A Bark VTXO on {chain}, read from its hex: its amount, its expiry and its exit path, checked."
                ),
            ),
            (
                format!("/ark/arkade/address/{}", ark.to_uppercase()),
                "Arkade address".into(),
                format!("Arkade address {ark} on {chain}: its VTXOs, as Arkade reports them."),
            ),
            (
                format!("/ark/arkade/vtxo/{}:7", "ab".repeat(32)),
                "Arkade VTXO".into(),
                format!(
                    "Arkade VTXO {}:7 on {chain}: its amount, its expiry and its exit path, as Arkade reports them.",
                    "ab".repeat(32)
                ),
            ),
            (
                "/lightning/search?q=acinq".into(),
                "Lightning search".into(),
                format!(
                    "Find Lightning nodes and channels on {chain} by name, public key or channel id."
                ),
            ),
            (
                "/lightning/rankings".into(),
                "Lightning nodes by capacity".into(),
                format!("The 100 Lightning nodes on {chain} with the most capacity."),
            ),
            (
                "/lightning/rankings?by=channels".into(),
                "Lightning nodes by open channels".into(),
                format!("The 100 Lightning nodes on {chain} with the most open channels."),
            ),
            (
                "/lightning/rankings?by=age&by=capacity".into(),
                "Lightning nodes oldest first".into(),
                format!("The 100 Lightning nodes on {chain} that have been around longest."),
            ),
            // Names and values are read decoded, the first `by` only, as `URLSearchParams`.
            (
                "/lightning/rankings?by=%61ge".into(),
                "Lightning nodes oldest first".into(),
                format!("The 100 Lightning nodes on {chain} that have been around longest."),
            ),
            (
                "/lightning/rankings?%62y=channels".into(),
                "Lightning nodes by open channels".into(),
                format!("The 100 Lightning nodes on {chain} with the most open channels."),
            ),
            (
                "/lightning/rankings?by&by=age".into(),
                "Lightning nodes by capacity".into(),
                format!("The 100 Lightning nodes on {chain} with the most capacity."),
            ),
            (
                "/lightning/rankings?by=%3Cx%3E".into(),
                "Lightning nodes by capacity".into(),
                format!("The 100 Lightning nodes on {chain} with the most capacity."),
            ),
        ];
        for (path, title, description) in pages {
            let path = if path == "/" && !prefix.is_empty() {
                String::new()
            } else {
                path
            };
            let target = format!("{prefix}{path}");
            let target = if target.is_empty() {
                "/".to_owned()
            } else {
                target
            };
            let r = get(&addr, &target).await;
            assert_filled(&r, &target);
            assert_eq!(
                r.title(),
                format!("{name}{}{SITE}", title.replace('\'', "&#39;")),
                "{target}"
            );
            assert_eq!(
                r.meta("name", "description"),
                description.replace('\'', "&#39;"),
                "{target}"
            );
        }
    }
    // The network's root with a slash is its home page too.
    assert_eq!(
        get(&addr, "/signet/").await.title(),
        format!("Signet: Blocks and mempool{SITE}")
    );
}

#[tokio::test]
async fn with_the_site_address_every_page_has_the_picture_and_its_own_address() {
    let dir = temp("site");
    let (addr, _) = start_at(&dir.0, Some("https://rbitcoin.space/")).await;
    let ranked = "/lightning/rankings";
    for (target, url) in [
        ("/".to_owned(), "https://rbitcoin.space/".to_owned()),
        (
            format!("/tx/{TXID}"),
            format!("https://rbitcoin.space/tx/{TXID}"),
        ),
        // A query is not part of a page's address, and what it holds is never written.
        (
            format!("/regtest/block/{KNOWN_HEIGHT}?x=%22%3E%3Cscript%3E&y='"),
            format!("https://rbitcoin.space/regtest/block/{KNOWN_HEIGHT}"),
        ),
        (
            "/signet".to_owned(),
            "https://rbitcoin.space/signet".to_owned(),
        ),
        // Except the rankings page's order, written back in its one canonical form.
        (
            format!("{ranked}?x=%3Cb%3E&by=channels&by=age"),
            format!("https://rbitcoin.space{ranked}?by=channels"),
        ),
        (
            format!("{ranked}?b%79=age"),
            format!("https://rbitcoin.space{ranked}?by=age"),
        ),
        (
            format!("{ranked}?by=%22%3E%3Cb%3E"),
            format!("https://rbitcoin.space{ranked}"),
        ),
    ] {
        let r = get(&addr, &target).await;
        assert_eq!(r.status, 200, "{target}");
        let (before, after) = around_title();
        assert!(
            r.body.starts_with(before) && r.body.ends_with(after),
            "{target}"
        );
        assert_eq!(r.meta("property", "og:url"), url, "{target}");
        let image = r.meta("property", "og:image");
        // A transaction's and a block's page show their own card; every other page the site's.
        let card = if target.starts_with("/tx/") {
            Some(format!("https://rbitcoin.space/app/card/tx/{TXID}.png"))
        } else if target.starts_with("/regtest/block/") {
            Some(format!(
                "https://rbitcoin.space/regtest/app/card/block/{KNOWN_HEIGHT}.png"
            ))
        } else {
            None
        };
        match card {
            Some(card) => assert_eq!(image, card, "{target}"),
            None => assert!(
                image.starts_with("https://rbitcoin.space/assets/preview-")
                    && image.ends_with(".png"),
                "{target}: {image}"
            ),
        }
        assert_eq!(r.meta("name", "twitter:image"), image, "{target}");
        assert_eq!(r.meta("property", "og:image:type"), "image/png");
        assert_eq!(r.meta("property", "og:image:width"), "1200");
        assert_eq!(r.meta("property", "og:image:height"), "630");
        assert!(!r.meta("property", "og:image:alt").is_empty());
        assert_eq!(r.meta("name", "twitter:card"), "summary_large_image");
        assert!(
            !r.body.contains("<b>") && !r.body.contains("%3C") && !r.body.contains("canonical"),
            "{target}"
        );
    }
    // A path that names no page is still the shell as built.
    assert_eq!(get(&addr, "/no/such/page").await.body, SHELL);
}

#[tokio::test]
async fn a_block_the_table_holds_is_described_from_it() {
    let dir = temp("table");
    let (addr, _) = start(&dir.0).await;
    let description = "Regtest block 7, mined 2023-11-14 22:13 UTC by Foundry USA: 5 transactions and 0.00010000 BTC in fees.";
    for path in [
        format!("/regtest/block/{KNOWN_HEIGHT}"),
        format!("/regtest/block/{KNOWN}"),
    ] {
        let r = get(&addr, &path).await;
        assert_filled(&r, &path);
        assert_eq!(r.title(), format!("Regtest: Block 7{SITE}"), "{path}");
        assert_eq!(r.meta("name", "description"), description, "{path}");
        // The coinbase tag is chain data and is never written.
        assert!(!r.body.contains("alert"), "{path}");
    }
    // Another network's table does not have it.
    let r = get(&addr, &format!("/signet/block/{KNOWN}")).await;
    assert_eq!(r.title(), format!("Signet: Block 0f9188f1…466e2206{SITE}"));
}

#[tokio::test]
async fn a_lightning_node_the_graph_holds_is_named_as_its_page_names_it() {
    let dir = temp("graph");
    let (addr, _) = start(&dir.0).await;
    for (n, title, channels, capacity) in [
        (1, "ACINQ ⚡️", "2 open channels", "0.07000000"),
        // Markup in an alias is text: the page shows it as written, so the title does too.
        (
            2,
            "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;",
            "1 open channel",
            "0.05000000",
        ),
        // No alias: the key's first 20 digits.
        (3, "03030303030303030303", "2 open channels", "0.02100000"),
        // A bidi override is cleaned to U+FFFD, as `cleanAlias` does.
        (4, "a\u{fffd}b", "1 open channel", "0.00100000"),
    ] {
        let key = key_hex(n);
        for k in [key.clone(), key.to_uppercase()] {
            let path = format!("/regtest/lightning/node/{k}");
            let r = get(&addr, &path).await;
            assert_filled(&r, &path);
            assert_eq!(
                r.title(),
                format!("Regtest: Lightning node {title}{SITE}"),
                "{path}"
            );
            assert_eq!(
                r.meta("name", "description"),
                format!(
                    "Lightning node {key} on Regtest: {channels} and {capacity} BTC of capacity."
                ),
                "{path}"
            );
            assert!(
                !r.body.contains("<img") && !r.body.contains('\u{202e}'),
                "{path}"
            );
        }
    }
}

#[tokio::test]
async fn paths_that_do_not_parse_get_the_shell_as_built() {
    let dir = temp("hostile");
    let (addr, log) = start(&dir.0).await;
    let long = "a".repeat(8000);
    let hostile = [
        "/no/such/page".to_owned(),
        "/index.html".to_owned(),
        "/tx/%3Cscript%3Ealert(1)%3C/script%3E".to_owned(),
        "/tx/<script>alert(1)</script>".to_owned(),
        format!("/tx/{TXID}%00"),
        format!("/tx/{TXID}/"),
        format!("/tx/{}", &TXID[..63]),
        format!("/tx/{TXID}0"),
        format!("/tx/%34{}", &TXID[1..]),
        "/tx/\"onmouseover=\"alert(1)".to_owned(),
        "/address/%22%3E%3Cscript%3E".to_owned(),
        "/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq%0d%0aX-Injected:%201".to_owned(),
        "/signet/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".to_owned(),
        "/address/bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s".to_owned(),
        format!("/address/{long}"),
        format!("/block/{long}"),
        format!("/lightning/node/{long}"),
        "/block/4294967296".to_owned(),
        "/block/+5".to_owned(),
        "/block/%35".to_owned(),
        "/block/-1".to_owned(),
        "/block/next/0".to_owned(),
        "/block/next/9".to_owned(),
        "/block/next/01".to_owned(),
        "/blocks/x".to_owned(),
        "/mining/pool/FoundryUSA".to_owned(),
        "/mining/pool/%3Cimg%3E".to_owned(),
        "/lightning/channel/01x2x3".to_owned(),
        "/lightning/channel/1x2x3x4".to_owned(),
        "/lightning/channel/18446744073709551616".to_owned(),
        format!("/lightning/node/{}'", &key_hex(1)[..65]),
        format!("/lightning/node/02{}", "zz".repeat(32)),
        "/lightning/node/%E2%80%AE".to_owned(),
        "/regtestx/".to_owned(),
        "/mempool/extra".to_owned(),
        "/fees".to_owned(),
        "/fees/score/extra".to_owned(),
        format!("/ark/arkade/vtxo/{TXID}"),
        format!("/ark/arkade/vtxo/{TXID}:01"),
        format!("/ark/arkade/vtxo/{TXID}:4294967296"),
        format!("/ark/arkade/vtxo/{TXID}:0/x"),
        "/ark/arkade/vtxo/not-an-outpoint".to_owned(),
        "/ark/bark/hex/00".to_owned(),
        // Another network's, a checksum broken, Bark's version, markup.
        format!("/ark/arkade/address/{ARK_TEST}"),
        format!("/ark/arkade/address/{}", &ARK_MAIN[..ARK_MAIN.len() - 1]),
        format!(
            "/ark/arkade/address/{}",
            ARK_MAIN.replacen("ark1q", "ark1p", 1)
        ),
        "/ark/arkade/address/%3Cscript%3E".to_owned(),
        format!("/ark/vtxo/{TXID}"),
        format!("/ark/vtxo/{TXID}:01"),
        format!("/ark/vtxo/{TXID}:0/x"),
    ];
    for path in &hostile {
        let r = get(&addr, path).await;
        // A request line no browser would send may be refused before it is routed.
        if r.status == 400 {
            assert!(path.contains(['<', '"']), "{path}");
            continue;
        }
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(r.body, SHELL, "{path}");
        assert_eq!(r.header("cache-control"), Some("no-cache"), "{path}");
    }
    assert_eq!(get(&addr, "/tx/a\x01b").await.status, 400);
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .all(|l| !l.contains("alert") && !l.contains("Injected"))
    );
}

#[tokio::test]
async fn pages_are_revalidated_and_keep_the_security_headers() {
    let dir = temp("headers");
    let (addr, _) = start(&dir.0).await;
    for path in [
        "/".to_owned(),
        format!("/regtest/tx/{TXID}"),
        "/no/such/page".to_owned(),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!(
            r.header("content-type"),
            Some("text/html; charset=utf-8"),
            "{path}"
        );
        // The head varies by URL alone, which is every cache's key; `no-cache` makes a cache ask
        // again, so a deploy's new shell is seen at once.
        assert_eq!(r.header("cache-control"), Some("no-cache"), "{path}");
        assert_eq!(r.header("vary"), None, "{path}");
        assert_eq!(r.header("content-encoding"), None, "{path}");
        for (name, value) in SECURITY_HEADERS {
            assert_eq!(
                r.header(name.as_str()),
                Some(value.to_ascii_lowercase().as_str()),
                "{path}: {name}"
            );
        }
    }
}

#[tokio::test]
async fn no_page_path_reaches_the_node_and_a_flood_stays_inside_the_static_limits() {
    let dir = temp("flood");
    let (addr, log) = start(&dir.0).await;
    // Distinct paths of every kind that reads something: blocks by height and hash, the stored
    // block, transactions, addresses, nodes.
    let paths: Vec<String> = (0..1000u32)
        .map(|i| match i % 5 {
            0 => format!("/regtest/block/{}", 3_000_000_000 + i),
            1 => format!("/block/{:064x}", 0xabc0_0000 + i),
            2 => format!("/regtest/block/{KNOWN}"),
            3 => format!("/signet/tx/{:064x}", 0xdef0_0000 + i),
            _ => format!("/regtest/lightning/node/02{:064x}", 0x1230_0000 + i),
        })
        .collect();
    let started = std::time::Instant::now();
    let mut codes: HashMap<u16, usize> = HashMap::new();
    for chunk in paths.chunks(50) {
        let mut set = tokio::task::JoinSet::new();
        for p in chunk {
            let (addr, p) = (addr.clone(), p.clone());
            set.spawn(async move { get(&addr, &p).await.status });
        }
        while let Some(status) = set.join_next().await {
            *codes.entry(status.unwrap()).or_default() += 1;
        }
    }
    let took = started.elapsed();
    // One client: the static allowance (a burst of 400, then 100 a second) serves the first and
    // refuses the rest, as it did before pages had heads.
    let ok = codes.get(&200).copied().unwrap_or(0);
    let refused = codes.get(&429).copied().unwrap_or(0);
    assert_eq!(ok + refused, paths.len(), "{codes:?}");
    assert!(
        (400..=400 + 100 * took.as_secs() as usize + 100).contains(&ok),
        "{codes:?} in {took:?}"
    );
    let log = log.lock().unwrap();
    for needle in ["3000000", "abc0", "def0", "1230", &KNOWN[..16]] {
        assert!(
            log.iter().all(|l| !l.contains(needle)),
            "{needle} reached the node"
        );
    }
}

/// The PNG's width and height, from its header.
fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let at = |i: usize| u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap());
    (at(16), at(20))
}

#[tokio::test]
async fn a_transaction_page_and_a_block_page_name_their_own_card() {
    let dir = temp("card-heads");
    let (addr, _) = start_at(&dir.0, Some("https://rbitcoin.space")).await;
    for (path, image, alt) in [
        (
            format!("/signet/tx/{}", TXID.to_uppercase()),
            format!("https://rbitcoin.space/signet/app/card/tx/{TXID}.png"),
            format!("Signet transaction {TXID}: "),
        ),
        (
            "/regtest/block/0007".to_owned(),
            "https://rbitcoin.space/regtest/app/card/block/7.png".to_owned(),
            "Regtest block 7: ".to_owned(),
        ),
        (
            format!("/block/{GENESIS}"),
            format!("https://rbitcoin.space/app/card/block/{GENESIS}.png"),
            format!("Bitcoin block {GENESIS}: "),
        ),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!(r.meta("property", "og:image"), image, "{path}");
        assert_eq!(r.meta("name", "twitter:image"), image, "{path}");
        assert!(
            r.meta("property", "og:image:alt").starts_with(&alt),
            "{path}"
        );
    }
    // The projected blocks' pages are no block's: the site's picture.
    let r = get(&addr, "/block/next/2").await;
    assert!(r.meta("property", "og:image").contains("/assets/preview-"));
    // Without the site's address, nothing names a picture, a card included.
    let dir = temp("card-heads-off");
    let (addr, _) = start(&dir.0).await;
    let r = get(&addr, &format!("/tx/{TXID}")).await;
    assert!(!r.body.contains("og:image") && !r.body.contains("/app/card/"));
}

#[tokio::test]
async fn a_card_address_answers_its_card_or_the_static_picture_and_a_bad_id_is_not_found() {
    let dir = temp("cards");
    let (addr, log) = start(&dir.0).await;
    let picture = std::fs::read(dir.0.join("web").join(PICTURE)).unwrap();

    // The block the table holds, by height and by hash, and the transaction the node knows.
    for path in [
        "/regtest/app/card/block/7.png".to_owned(),
        format!("/regtest/app/card/block/{KNOWN}.png"),
        format!("/regtest/app/card/tx/{CARD_TX}.png"),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(r.header("content-type"), Some("image/png"), "{path}");
        assert_eq!(png_size(&r.bytes), (1200, 630), "{path}");
        assert!(
            r.bytes.len() < 300 * 1024,
            "{path}: {} bytes",
            r.bytes.len()
        );
        assert_ne!(r.bytes, picture, "{path} is its own card");
        // Its block is at the tip the server knows of: it can change.
        assert_eq!(
            r.header("cache-control"),
            Some("public, max-age=60"),
            "{path}"
        );
        // Kept: the same bytes again, and the node is not asked twice.
        assert_eq!(get(&addr, &path).await.bytes, r.bytes, "{path}");
    }
    let asked = |needle: &str| {
        log.lock()
            .unwrap()
            .iter()
            .filter(|l| l.contains(needle))
            .count()
    };
    assert_eq!(asked(CARD_TX), 1);

    // A transaction the node does not know, a block the table does not hold: the static picture.
    for path in [
        format!("/app/card/tx/{TXID}.png"),
        format!("/signet/app/card/block/{KNOWN}.png"),
        "/testnet4/app/card/block/123.png".to_owned(),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(r.header("content-type"), Some("image/png"), "{path}");
        assert_eq!(r.bytes, picture, "{path}");
        assert_eq!(
            r.header("cache-control"),
            Some("public, max-age=60"),
            "{path}"
        );
    }
    // A block card never asks the node.
    assert_eq!(asked("123"), 0);

    // An id the page would not take, or no `.png`: not found, and nothing asked.
    for path in [
        "/app/card/tx/abc.png".to_owned(),
        format!("/app/card/tx/{TXID}"),
        format!("/app/card/tx/{TXID}.PNG"),
        format!("/app/card/tx/{TXID}0.png"),
        format!("/app/card/tx/%3Cb%3E{}.png", &TXID[3..]),
        "/app/card/block/12345678901.png".to_owned(),
        "/app/card/block/-1.png".to_owned(),
        "/app/card/block/.png".to_owned(),
        "/app/card/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq.png".to_owned(),
        format!("/nonet/app/card/tx/{TXID}.png"),
    ] {
        let r = get(&addr, &path).await;
        assert_eq!(r.status, 404, "{path}");
        assert_ne!(r.header("content-type"), Some("image/png"), "{path}");
    }
}

#[tokio::test]
async fn requests_for_the_same_card_share_one_build() {
    let dir = temp("card-same");
    let (addr, log) = start(&dir.0).await;
    let picture = std::fs::read(dir.0.join("web").join(PICTURE)).unwrap();
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..6 {
        let addr = addr.clone();
        set.spawn(async move { get(&addr, &format!("/regtest/app/card/tx/{CARD_TX}.png")).await });
    }
    let mut cards = Vec::new();
    while let Some(r) = set.join_next().await {
        cards.push(r.unwrap().bytes);
    }
    // Every request got the card itself, not the picture of a full slot, and the node was asked
    // once.
    assert!(cards.iter().all(|c| *c == cards[0] && *c != picture));
    let asked = log
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.contains(CARD_TX))
        .count();
    assert_eq!(asked, 1);
}

#[tokio::test]
async fn cards_are_built_two_at_a_time_and_a_node_that_hangs_gets_the_static_picture() {
    let dir = temp("card-flood");
    let (addr, log) = start(&dir.0).await;
    let picture = std::fs::read(dir.0.join("web").join(PICTURE)).unwrap();
    let started = std::time::Instant::now();
    let mut set = tokio::task::JoinSet::new();
    for i in 0..20u32 {
        let addr = addr.clone();
        let path = format!("/app/card/tx/{SLOW}{:060x}.png", i);
        set.spawn(async move { get(&addr, &path).await });
    }
    while let Some(r) = set.join_next().await {
        let r = r.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-type"), Some("image/png"));
        assert_eq!(r.bytes, picture);
    }
    // Two reached the node and waited their 3 s; the rest had the picture at once.
    let took = started.elapsed();
    assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    let asked = log
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.contains(&format!("/tx/{SLOW}")))
        .count();
    assert_eq!(asked, 2);
}

#[tokio::test]
async fn the_docs_answer_in_html_or_in_markdown_for_a_client_that_asks() {
    let dir = temp("docs");
    let web = dir.0.join("web");
    std::fs::create_dir_all(web.join("docs")).unwrap();
    for (file, text) in [
        ("docs/index.html", "<!doctype html><p>overview</p>"),
        ("docs.md", "# Overview\n"),
        ("docs/limits.html", "<!doctype html><p>limits</p>"),
        ("docs/limits.md", "# Limits\n"),
        ("llms.txt", "# rbitcoin.space\n"),
    ] {
        std::fs::write(web.join(file), text).unwrap();
    }
    std::fs::write(web.join("docs/limits.html.br"), b"compressed").unwrap();
    let (addr, _) = start(&dir.0).await;
    const MD: &str = "accept: text/markdown, text/html;q=0.9, */*;q=0.8\r\n";
    const BROWSER: &str = "accept: text/html,application/xhtml+xml,*/*;q=0.8\r\n";

    for (path, headers, body, content_type) in [
        ("/docs", "", "<!doctype html><p>overview</p>", "text/html"),
        (
            "/docs/",
            BROWSER,
            "<!doctype html><p>overview</p>",
            "text/html",
        ),
        ("/docs", MD, "# Overview\n", "text/markdown; charset=utf-8"),
        (
            "/docs.md",
            BROWSER,
            "# Overview\n",
            "text/markdown; charset=utf-8",
        ),
        (
            "/docs/limits",
            BROWSER,
            "<!doctype html><p>limits</p>",
            "text/html",
        ),
        (
            "/docs/limits",
            MD,
            "# Limits\n",
            "text/markdown; charset=utf-8",
        ),
        (
            "/docs/limits.md",
            "",
            "# Limits\n",
            "text/markdown; charset=utf-8",
        ),
    ] {
        let r = get_with(&addr, path, headers).await;
        assert_eq!(r.status, 200, "{path} {headers}");
        assert_eq!(r.body, body, "{path} {headers}");
        assert_eq!(r.header("content-type"), Some(content_type), "{path}");
        assert_eq!(r.header("cache-control"), Some("no-cache"), "{path}");
        assert!(r.header("content-security-policy").is_some(), "{path}");
        // One address answers two ways, so caches key on Accept; a `.md` address answers one.
        let varies = r.head.lines().any(|l| l == "vary: accept");
        assert_eq!(varies, !path.ends_with(".md"), "{path}");
        let alternate = r.header("link");
        if content_type == "text/html" {
            let md = if path.starts_with("/docs/limits") {
                "/docs/limits.md"
            } else {
                "/docs.md"
            };
            let want = format!("<{md}>; rel=\"alternate\"; type=\"text/markdown\"");
            assert_eq!(alternate, Some(want.as_str()), "{path}");
        } else {
            assert_eq!(alternate, None, "{path}");
        }
    }

    // The build's compressed copy, to a client that takes it.
    let r = get_with(&addr, "/docs/limits", "accept-encoding: br\r\n").await;
    assert_eq!(r.header("content-encoding"), Some("br"));
    assert_eq!(r.body, "compressed");

    // No page: a 404, not the explorer's shell.
    for path in [
        "/docs/missing",
        "/docs/missing.md",
        "/docs/index",
        "/docs/index.md",
        "/docs/limits.html",
        "/docs/Limits",
        "/docs/../index.html",
        "/docs/a%2f..%2fb",
    ] {
        let r = get(&addr, path).await;
        assert_eq!(r.status, 404, "{path}");
        assert_eq!(r.body, "{\"error\":\"not found\"}", "{path}");
        assert_eq!(r.header("cache-control"), Some("no-store"), "{path}");
    }

    let r = get(&addr, "/llms.txt").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, "# rbitcoin.space\n");

    // Where MCP is off, the docs' script hides its actions.
    let r = get(&addr, "/app/config").await;
    assert!(r.body.contains("\"mcp\":false"), "{}", r.body);
}
