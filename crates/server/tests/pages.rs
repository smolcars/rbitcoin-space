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
const GENESIS: &str = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
/// A block only the regtest table holds, at [`KNOWN_HEIGHT`].
const KNOWN: &str = "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";
const KNOWN_HEIGHT: u32 = 7;
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
        async { (axum::http::StatusCode::NOT_FOUND, "{}") }
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
    std::fs::create_dir_all(d.join("web")).unwrap();
    std::fs::write(d.join("web/index.html"), SHELL).unwrap();
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
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {target} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    Reply {
        status: head[9..12].parse().unwrap(),
        head,
        body: String::from_utf8(raw[split + 4..].to_vec()).unwrap(),
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
                "Ark VTXO".into(),
                format!("Look up an Ark VTXO on {chain} by its id."),
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
