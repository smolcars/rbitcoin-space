//! The Arkade VTXO route against a fake Arkade server and a fake Esplora, both on port 0, answering
//! from signet answers recorded in `fixtures/arkade`. Nothing here reaches a real server.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::IntoResponse;
use logging::{Format, Level, Settings};
use rbitcoin_space::ark_arkade::CLIENT_BURST;
use rbitcoin_space::{App, Config};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const PRE: &str = "d922b2c3811ec22ae6c7b0bea4eaef16c33250bf4e717950f1898095e79773fc";
const C128: &str = "5cac5e493337e37ef5a66c66a4c36f7d8e87f3c9b85c635ca49fe6721268bd80";
const UNKNOWN: &str = "abababababababababababababababababababababababababababababababab";
/// Signet's server key and the script of `d922b2c3…:0`, as an address: 256 VTXOs, 11 pages.
const ADDRESS: &str = "tark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqnrjdp6x";
const SCRIPT: &str = "5120679eb02033f3fa5b7c8e1c00679f0d3f8966a62f0c8bca7d78462e6df1ed1813";
/// arkd's own test vector: an address of another server.
const FOREIGN: &str = "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/../../fixtures/arkade/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(path).unwrap()
}

/// The fake Arkade server's answers by path and query, and how many requests it saw.
struct Ark {
    routes: HashMap<String, String>,
    hits: AtomicUsize,
}

async fn ark(State(ark): State<Arc<Ark>>, uri: Uri) -> impl IntoResponse {
    ark.hits.fetch_add(1, Ordering::SeqCst);
    let key = uri
        .path_and_query()
        .map(ToString::to_string)
        .unwrap_or_default();
    match ark.routes.get(&key) {
        Some(body) => (StatusCode::OK, body.clone()),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"code":13,"message":"not found"}"#.to_owned(),
        ),
    }
}

/// The fake node's Esplora: the commitment transaction is confirmed, the rest unknown. Counts the
/// status reads it answers.
async fn esplora(State(reads): State<Arc<AtomicUsize>>, uri: Uri) -> impl IntoResponse {
    if uri.path().starts_with("/tx/") && uri.path().ends_with("/status") {
        reads.fetch_add(1, Ordering::SeqCst);
    }
    if uri.path() == format!("/tx/{C128}/status") {
        return (
            StatusCode::OK,
            format!(
                r#"{{"confirmed":true,"block_height":274022,"block_hash":"{}","block_time":1760540480}}"#,
                "00".repeat(32)
            ),
        );
    }
    (StatusCode::NOT_FOUND, "Transaction not found".to_owned())
}

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await });
    url
}

/// The server on port 0, with an Arkade server at `arkade` (none when `None`). Clients are told
/// apart by `X-Real-IP`.
async fn start(arkade: Option<&str>) -> String {
    start_counting(arkade).await.0
}

/// [`start`], and the number of status reads its node has answered.
async fn start_counting(arkade: Option<&str>) -> (String, Arc<AtomicUsize>) {
    capture();
    let reads = Arc::new(AtomicUsize::new(0));
    let esplora = serve(
        Router::new()
            .fallback(esplora)
            .with_state(Arc::clone(&reads)),
    )
    .await;
    let mut vars: HashMap<&str, String> = [
        ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
        ("REGTEST_RPC_PORT", "1".to_owned()),
        ("REGTEST_RPC_USER", "u".to_owned()),
        ("REGTEST_RPC_PASSWORD", "p".to_owned()),
        ("REGTEST_ESPLORA_URL", esplora),
        ("REGTEST_ELECTRUM_ADDR", "127.0.0.1:1".to_owned()),
        ("REGTEST_MEMPOOL_ENABLED", "false".to_owned()),
        ("TRUSTED_PROXY_HEADER", "X-Real-IP".to_owned()),
        ("TRUSTED_PROXIES", "127.0.0.1".to_owned()),
    ]
    .into_iter()
    .collect();
    if let Some(url) = arkade {
        vars.insert("REGTEST_ARKADE_URL", url.to_owned());
    }
    let config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(App::new(&config).serve(listener, std::future::pending()));
    (addr, reads)
}

async fn fake_ark() -> (String, Arc<Ark>) {
    let page = "page.size=128&page.index=1";
    let tree = "page.size=512&page.index=1";
    let routes = HashMap::from([
        ("/v1/info".to_owned(), fixture("info-signet")),
        (
            format!("/v1/indexer/vtxos?outpoints={PRE}:0"),
            fixture("vtxo-preconfirmed"),
        ),
        (
            format!("/v1/indexer/vtxo/{PRE}/0/chain?{page}"),
            fixture("chain-preconfirmed"),
        ),
        (
            format!("/v1/indexer/commitmentTx/{C128}"),
            fixture("commitment-128"),
        ),
        (
            format!("/v1/indexer/batch/{C128}/0/tree?{tree}"),
            fixture("tree-128"),
        ),
        (
            format!("/v1/indexer/vtxos?outpoints={UNKNOWN}:0"),
            fixture("vtxo-unknown"),
        ),
        (
            format!("/v1/indexer/vtxos?scripts={SCRIPT}&page.size=25&page.index=1"),
            fixture("list-page1"),
        ),
        (
            format!("/v1/indexer/vtxos?scripts={SCRIPT}&page.size=25&page.index=11"),
            fixture("list-last"),
        ),
    ]);
    let ark = Arc::new(Ark {
        routes,
        hits: AtomicUsize::new(0),
    });
    let url = serve(
        Router::new()
            .fallback(self::ark)
            .with_state(Arc::clone(&ark)),
    )
    .await;
    (url, ark)
}

#[derive(Debug)]
struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name}: ")))
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

async fn get(addr: &str, target: &str, ip: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req =
        format!("GET {target} HTTP/1.1\r\nHost: t\r\nConnection: close\r\nX-Real-IP: {ip}\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    Reply {
        status: head[9..12].parse().unwrap(),
        head,
        body: raw[split + 4..].to_vec(),
    }
}

/// The answer for signet's `d922b2c3…:0`, from its recorded Arkade answers, is what the browser
/// tests stub the route with (`web/e2e/ark-answers.ts`). `ARKADE_RECORD=1` writes it again.
fn held_equal_to_the_recorded_answer(body: &[u8]) {
    held_equal_to(body, "answer-preconfirmed");
}

fn held_equal_to(body: &[u8], name: &str) {
    let path = format!(
        "{}/../../fixtures/arkade/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let answer = String::from_utf8(body.to_vec()).unwrap() + "\n";
    if std::env::var_os("ARKADE_RECORD").is_some() {
        std::fs::write(&path, &answer).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        answer,
        "ARKADE_RECORD=1 writes it again"
    );
}

fn vtxo(txid: &str, vout: &str) -> String {
    format!("/regtest/app/ark/arkade/vtxo/{txid}/{vout}")
}

#[tokio::test]
async fn a_vtxo_comes_with_its_tree_and_where_each_transaction_is() {
    let (url, ark) = fake_ark().await;
    let addr = start(Some(&url)).await;
    let r = get(&addr, &vtxo(PRE, "0"), "192.0.2.1").await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.header("cache-control"), Some("no-store"));
    let v = r.json();
    assert_eq!(v["vtxo"]["txid"], PRE);
    assert_eq!(v["vtxo"]["preconfirmed"], true);
    assert_eq!(v["vtxo"]["amount"], 1000);
    assert_eq!(v["server"]["exit_delay_secs"], 172_544);
    let chain = v["chain"].as_array().unwrap();
    assert_eq!(chain.len(), 11);
    assert_eq!(chain[0]["kind"], "ark");
    assert_eq!(chain[1]["kind"], "checkpoint");
    assert_eq!(chain[10]["kind"], "commitment");
    assert_eq!(v["chain_complete"], true);
    let onchain = v["onchain"].as_array().unwrap();
    assert_eq!(onchain.len(), 11);
    assert_eq!(onchain[0]["state"], "off");
    assert_eq!(onchain[10]["state"], "confirmed");
    assert_eq!(onchain[10]["height"], 274_022);
    assert_eq!(v["batches"][0]["tree"].as_array().unwrap().len(), 255);
    assert_eq!(v["batches"][0]["vtxos"], 128);
    assert_eq!(ark.hits.load(Ordering::SeqCst), 5);
    held_equal_to_the_recorded_answer(&r.body);

    // Asked again, the Arkade server is not.
    let again = get(&addr, &vtxo(PRE, "0"), "192.0.2.1").await;
    assert_eq!(again.status, 200);
    assert_eq!(ark.hits.load(Ordering::SeqCst), 5);

    // What was looked up never reaches the log: the request line carries the route's template.
    logging::flush(Duration::from_secs(1));
    let log = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("/app/ark/arkade/vtxo/{txid}/{vout}"));
    assert!(!log.contains(PRE), "an outpoint was logged");
}

fn address(a: &str) -> String {
    format!("/regtest/app/ark/arkade/address/{a}")
}

#[tokio::test]
async fn an_address_lists_a_page_of_its_vtxos() {
    let (url, ark) = fake_ark().await;
    let addr = start(Some(&url)).await;
    let r = get(&addr, &address(ADDRESS), "192.0.2.30").await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.header("cache-control"), Some("no-store"));
    let v = r.json();
    assert_eq!(
        (v["page"].as_u64(), v["pages"].as_u64()),
        (Some(1), Some(11))
    );
    let vtxos = v["vtxos"].as_array().unwrap();
    assert_eq!(vtxos.len(), 25);
    assert!(vtxos.iter().all(|t| t["script"] == SCRIPT));
    // The server's info, then the page.
    assert_eq!(ark.hits.load(Ordering::SeqCst), 2);
    held_equal_to(&r.body, "answer-address");

    // The last page, in upper case: one more call.
    let r = get(
        &addr,
        &format!("{}?page=11", address(&ADDRESS.to_uppercase())),
        "192.0.2.30",
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["vtxos"].as_array().unwrap().len(), 6);
    held_equal_to(&r.body, "answer-address-last");
    assert_eq!(ark.hits.load(Ordering::SeqCst), 3);

    logging::flush(Duration::from_secs(1));
    let log = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("/app/ark/arkade/address/{address}"));
    assert!(!log.contains(&ADDRESS[10..40]), "an address was logged");
    assert!(!log.contains(&SCRIPT[4..]), "a script was logged");
}

#[tokio::test]
async fn addresses_that_cannot_be_listed_say_why_and_ask_nothing() {
    let (url, ark) = fake_ark().await;
    let addr = start(Some(&url)).await;
    // The same keys under mainnet's prefix, and behind Bark's version (its first five bits 00001).
    let encode = |hrp: &str, first: u8| {
        let checked = bitcoin::bech32::primitives::decode::CheckedHrpstring::new::<
            bitcoin::bech32::Bech32m,
        >(ADDRESS)
        .unwrap();
        let mut bytes: Vec<u8> = checked.byte_iter().collect();
        bytes[0] = first;
        let hrp = bitcoin::bech32::Hrp::parse(hrp).unwrap();
        bitcoin::bech32::encode::<bitcoin::bech32::Bech32m>(hrp, &bytes).unwrap()
    };
    let mainnet = encode("ark", 0);
    let bark = encode("tark", 0x08);
    let version_2 = encode("tark", 0x10);
    assert!(bark.starts_with("tark1p"));
    for (target, status, error) in [
        (address("not-an-address"), 400, "invalid address"),
        (address("%3Cscript%3E"), 400, "invalid address"),
        (
            address(&ADDRESS[..ADDRESS.len() - 1]),
            400,
            "invalid address",
        ),
        (
            address(&format!("ark1{}", &ADDRESS[5..])),
            400,
            "invalid address",
        ),
        (
            address(&ADDRESS.replace("tark1", "TARK1")),
            400,
            "invalid address",
        ),
        (address(&mainnet), 400, "address is for another network"),
        (address(&bark), 400, "bark address"),
        (address(&version_2), 400, "unknown ark address version"),
        (format!("{}?page=0", address(ADDRESS)), 400, "invalid page"),
        (
            format!("{}?page=1001", address(ADDRESS)),
            400,
            "invalid page",
        ),
        (format!("{}?page=02", address(ADDRESS)), 400, "invalid page"),
        (
            format!("{}?size=500", address(ADDRESS)),
            400,
            "unexpected query parameter",
        ),
    ] {
        let r = get(&addr, &target, "192.0.2.31").await;
        assert_eq!(
            (r.status, r.json()["error"].as_str()),
            (status, Some(error)),
            "{target}"
        );
    }
    assert_eq!(ark.hits.load(Ordering::SeqCst), 0);

    // Another server's address: its info is asked, its VTXOs are not.
    let r = get(&addr, &address(FOREIGN), "192.0.2.31").await;
    assert_eq!(r.status, 422);
    assert_eq!(
        r.json()["error"],
        "address belongs to another arkade server"
    );
    assert_eq!(ark.hits.load(Ordering::SeqCst), 1);

    let off = start(None).await;
    let r = get(&off, &address(ADDRESS), "192.0.2.31").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json()["error"], "arkade is not available here");
}

#[tokio::test]
async fn requests_that_arrive_together_read_the_node_once() {
    let (url, ark) = fake_ark().await;
    let (addr, reads) = start_counting(Some(&url)).await;
    let asks: Vec<_> = (0..8)
        .map(|i| {
            let addr = addr.clone();
            tokio::spawn(async move {
                get(&addr, &vtxo(PRE, "0"), &format!("192.0.2.{}", 20 + i)).await
            })
        })
        .collect();
    for a in asks {
        assert_eq!(a.await.unwrap().status, 200);
    }
    // One lookup at the Arkade server, one status read per chain transaction.
    assert_eq!(ark.hits.load(Ordering::SeqCst), 5);
    assert_eq!(reads.load(Ordering::SeqCst), 11);
}

#[tokio::test]
async fn unknown_malformed_and_switched_off() {
    let (url, ark) = fake_ark().await;
    let addr = start(Some(&url)).await;
    let r = get(&addr, &vtxo(UNKNOWN, "0"), "192.0.2.2").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json()["error"], "vtxo not found");

    for (txid, vout) in [
        (PRE, "01"),
        (PRE, "-1"),
        (PRE, "4294967296"),
        (&PRE[1..], "0"),
        ("<script>", "0"),
    ] {
        let r = get(&addr, &vtxo(txid, vout), "192.0.2.2").await;
        assert_eq!(r.status, 400, "{txid}:{vout}");
    }
    let r = get(&addr, &format!("{}?x=1", vtxo(PRE, "0")), "192.0.2.2").await;
    assert_eq!(r.status, 400);
    // Only the unknown VTXO reached the server: one call.
    assert_eq!(ark.hits.load(Ordering::SeqCst), 1);

    let off = start(None).await;
    let r = get(&off, &vtxo(PRE, "0"), "192.0.2.2").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json()["error"], "arkade is not available here");
}

#[tokio::test]
async fn a_server_that_is_down_is_a_bad_gateway() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let addr = start(Some(&url)).await;
    let r = get(&addr, &vtxo(PRE, "0"), "192.0.2.3").await;
    assert_eq!(r.status, 502);
    assert_eq!(r.json()["error"], "arkade is not answering");
}

#[tokio::test]
async fn one_client_has_a_share_of_its_own() {
    let (url, _) = fake_ark().await;
    let addr = start(Some(&url)).await;
    for _ in 0..CLIENT_BURST {
        assert_eq!(get(&addr, &vtxo(PRE, "0"), "192.0.2.4").await.status, 200);
    }
    let r = get(&addr, &vtxo(PRE, "0"), "192.0.2.4").await;
    assert_eq!(r.status, 429);
    // Another client is not held back by the first.
    assert_eq!(get(&addr, &vtxo(PRE, "0"), "192.0.2.5").await.status, 200);
}

// The log, shared by every test here.

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn capture() -> &'static Capture {
    static CAPTURE: OnceLock<Capture> = OnceLock::new();
    CAPTURE.get_or_init(|| {
        let c = Capture(Arc::default());
        let settings = Settings {
            format: Format::Json,
            level: Level::Debug,
            max_bytes_per_sec: logging::DEFAULT_MAX_BYTES_PER_SEC,
        };
        assert!(logging::init(settings, c.clone()));
        c
    })
}
