//! Esplora client against a local mock server: fixture decoding and transport behaviour.
//! Nothing here reaches a node.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bitcoin::{Address, BlockHash, Network, Txid};
use node::esplora::model::ScriptType;
use node::esplora::{
    BlockTxsStart, ChainTip, Error, Esplora, MAX_BLOCK_TXS, MAX_SUMMARY_BYTES, OutPosition,
    OutPositions, Route, ScriptHash, ScriptRef, TipCheck, consistent,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};

const BLOCK_800K: &str = "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054";
const TIP_A: &str = "00000000000000000000ec095818efb89e40f794c13326dbbdec38e1de395193";
const TIP_B: &str = "0000000000000000000000000000000000000000000000000000000000000001";

#[derive(Debug, Clone)]
struct Req {
    method: String,
    path: String,
    body: Vec<u8>,
}

struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
    delay: Duration,
    /// Pause between sending the headers and the body.
    body_delay: Duration,
    /// Send no Content-Length and close the connection to end the body.
    close_delimited: bool,
}

impl Reply {
    fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            headers: vec![],
            body: body.into(),
            delay: Duration::ZERO,
            body_delay: Duration::ZERO,
            close_delimited: false,
        }
    }

    fn stamped(mut self, hash: &str, height: u32) -> Self {
        self.headers.push(("x-bitcoin-chain-tip", hash.to_owned()));
        self.headers
            .push(("x-bitcoin-chain-tip-height", height.to_string()));
        self
    }
}

type Handler = Arc<dyn Fn(&Req) -> Reply + Send + Sync>;

#[derive(Clone, Default)]
struct Log {
    conns: Arc<AtomicUsize>,
    reqs: Arc<Mutex<Vec<Req>>>,
}

impl Log {
    fn paths(&self) -> Vec<String> {
        self.reqs
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.path.clone())
            .collect()
    }
}

async fn serve<S>(stream: S, handler: Handler, log: Log)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    log.conns.fetch_add(1, Ordering::SeqCst);
    let mut s = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if s.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let (method, path) = (
            parts.next().unwrap().to_owned(),
            parts.next().unwrap().to_owned(),
        );
        let mut len = 0;
        loop {
            let mut h = String::new();
            s.read_line(&mut h).await.unwrap();
            if h.trim().is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':')
                && k.eq_ignore_ascii_case("content-length")
            {
                len = v.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; len];
        s.read_exact(&mut body).await.unwrap();
        let req = Req { method, path, body };
        log.reqs.lock().unwrap().push(req.clone());
        let reply = handler(&req);
        tokio::time::sleep(reply.delay).await;
        let mut head = format!("HTTP/1.1 {} X\r\n", reply.status);
        if reply.close_delimited {
            head.push_str("connection: close\r\n");
        } else {
            head.push_str(&format!("content-length: {}\r\n", reply.body.len()));
        }
        for (k, v) in &reply.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        let w = s.get_mut();
        if w.write_all(head.as_bytes()).await.is_err() || w.flush().await.is_err() {
            return;
        }
        tokio::time::sleep(reply.body_delay).await;
        if w.write_all(&reply.body).await.is_err() {
            return;
        }
        if reply.close_delimited {
            let _ = w.shutdown().await;
            return;
        }
    }
}

/// A TCP mock on port 0. Returns the base URL (with an `/api` base path) and its request log.
async fn tcp_mock(handler: impl Fn(&Req) -> Reply + Send + Sync + 'static) -> (String, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api", listener.local_addr().unwrap());
    let (handler, log): (Handler, Log) = (Arc::new(handler), Log::default());
    let l = log.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = listener.accept().await {
            tokio::spawn(serve(s, handler.clone(), l.clone()));
        }
    });
    (url, log)
}

async fn unix_mock(handler: impl Fn(&Req) -> Reply + Send + Sync + 'static) -> (PathBuf, Log) {
    static N: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "esplora-{}-{}.sock",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let (handler, log): (Handler, Log) = (Arc::new(handler), Log::default());
    let l = log.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = listener.accept().await {
            tokio::spawn(serve(s, handler.clone(), l.clone()));
        }
    });
    (path, log)
}

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/esplora")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Serves recorded responses at the paths they were recorded from.
fn fixtures(req: &Req) -> Reply {
    let path = req.path.strip_prefix("/api").unwrap();
    let name = match path {
        "/tx/b75ca3106ed100521aa50e3ec267a06431c6319538898b25e1b757a5736f5fb4" => {
            "mainnet/tx-coinbase.json"
        }
        "/tx/6033990087599ce3cc6fd6f90694736fb9d7912bf5b2eec973389adf29066634" => {
            "mainnet/tx-segwit-opreturn.json"
        }
        "/tx/6033990087599ce3cc6fd6f90694736fb9d7912bf5b2eec973389adf29066634/raw" => {
            "mainnet/tx-segwit-opreturn.bin"
        }
        "/tx/6033990087599ce3cc6fd6f90694736fb9d7912bf5b2eec973389adf29066634/outspends" => {
            "mainnet/tx-outspends.json"
        }
        "/tx/6033990087599ce3cc6fd6f90694736fb9d7912bf5b2eec973389adf29066634/merkle-proof" => {
            "mainnet/tx-merkle-proof.json"
        }
        "/tx/6033990087599ce3cc6fd6f90694736fb9d7912bf5b2eec973389adf29066634/status" => {
            "mainnet/tx-status.json"
        }
        "/tx/c2f59c6fc8e812f5f1f00c8a0a9ab1929c1e796788c57f49001b8006a824ea17" => {
            "mainnet/tx-taproot.json"
        }
        "/tx/2d8b65963e039a9115207e4f7e73509235ab61dbf622979ba9465bb5f719cb97" => {
            "testnet4/tx-unconfirmed.json"
        }
        "/tx/2d8b65963e039a9115207e4f7e73509235ab61dbf622979ba9465bb5f719cb97/status" => {
            "testnet4/tx-status-unconfirmed.json"
        }
        p if p == format!("/block/{BLOCK_800K}") => "mainnet/block.json",
        p if p == format!("/block/{BLOCK_800K}/status") => "mainnet/block-status.json",
        p if p == format!("/block/{BLOCK_800K}/header") => "mainnet/block-header.txt",
        "/block-heights/txs/outs" => "mainnet/outputs-at.json",
        "/address/bc1q9luv2de4z8mhg60mv0cx0d8s7wl3xzxq562pss" => "mainnet/address-empty.json",
        "/address/bc1q9luv2de4z8mhg60mv0cx0d8s7wl3xzxq562pss/txs" => {
            "mainnet/address-empty-txs.json"
        }
        "/address/bc1q9luv2de4z8mhg60mv0cx0d8s7wl3xzxq562pss/utxo" => {
            "mainnet/address-empty-utxo.json"
        }
        "/address/tb1pd5lycwpxag9suvpwcuu974xj7tzf57jyqk3pr2c98e022r5s2zkqzg6xd2" => {
            "signet/address.json"
        }
        "/address/tb1pd5lycwpxag9suvpwcuu974xj7tzf57jyqk3pr2c98e022r5s2zkqzg6xd2/txs/summary" => {
            "signet/address-summary.json"
        }
        "/address/tb1pd5lycwpxag9suvpwcuu974xj7tzf57jyqk3pr2c98e022r5s2zkqzg6xd2/utxo" => {
            "signet/address-utxo.json"
        }
        "/fee-estimates" => "mainnet/fee-estimates.json",
        "/mempool" => "mainnet/mempool.json",
        "/mempool/recent" => "testnet4/mempool-recent.json",
        "/blocks" => "signet/blocks.json",
        _ => return Reply::new(404, "Not Found"),
    };
    let reply = Reply::new(200, fixture(name));
    // The mempool, fee and recent routes are unstamped upstream.
    if name.contains("mempool") || name.contains("fee") {
        reply
    } else {
        reply.stamped(TIP_A, 975_509)
    }
}

fn address(s: &str, network: Network) -> ScriptRef {
    ScriptRef::Address(
        s.parse::<Address<_>>()
            .unwrap()
            .require_network(network)
            .unwrap(),
    )
}

fn txid(s: &str) -> Txid {
    s.parse().unwrap()
}

#[tokio::test]
async fn decodes_transactions() {
    let (url, _) = tcp_mock(fixtures).await;
    let c = Esplora::new(&url).unwrap();

    let cb = c
        .tx(txid(
            "b75ca3106ed100521aa50e3ec267a06431c6319538898b25e1b757a5736f5fb4",
        ))
        .await
        .unwrap();
    assert_eq!(
        cb.tip.unwrap(),
        ChainTip {
            hash: TIP_A.parse().unwrap(),
            height: 975_509
        }
    );
    let cb = cb.value;
    assert!(cb.vin[0].is_coinbase && cb.vin[0].prevout.is_none());
    assert_eq!(cb.vin[0].vout, u32::MAX);
    assert_eq!(cb.status.block_height, Some(800_000));
    assert!(
        cb.vout
            .iter()
            .any(|o| o.scriptpubkey_type == ScriptType::OpReturn)
    );

    let sw = c
        .tx(txid(
            "6033990087599ce3cc6fd6f90694736fb9d7912bf5b2eec973389adf29066634",
        ))
        .await
        .unwrap()
        .value;
    let prev = sw.vin[0].prevout.as_ref().unwrap();
    assert_eq!(prev.scriptpubkey_type, ScriptType::V0P2wpkh);
    assert_eq!(sw.vin[0].witness.as_ref().unwrap().len(), 2);
    let op_return = sw
        .vout
        .iter()
        .find(|o| o.scriptpubkey_type == ScriptType::OpReturn)
        .unwrap();
    assert!(op_return.scriptpubkey_address.is_none());
    assert_eq!(
        sw.fee,
        Some(
            sw.vin
                .iter()
                .map(|i| i.prevout.as_ref().unwrap().value)
                .sum::<u64>()
                - sw.vout.iter().map(|o| o.value).sum::<u64>()
        )
    );

    let tr = c
        .tx(txid(
            "c2f59c6fc8e812f5f1f00c8a0a9ab1929c1e796788c57f49001b8006a824ea17",
        ))
        .await
        .unwrap()
        .value;
    assert_eq!(
        tr.vin[0].prevout.as_ref().unwrap().scriptpubkey_type,
        ScriptType::V1P2tr
    );
    assert_eq!(
        tr.vin[0].witness.as_ref().unwrap().len(),
        1,
        "key-path spend"
    );

    let un_id = txid("2d8b65963e039a9115207e4f7e73509235ab61dbf622979ba9465bb5f719cb97");
    let un = c.tx(un_id).await.unwrap().value;
    assert!(
        !un.status.confirmed && un.status.block_height.is_none() && un.status.block_hash.is_none()
    );
    assert!(!c.tx_status(un_id, None).await.unwrap().value.confirmed);

    let raw = c.tx_raw(sw.txid).await.unwrap().value;
    assert_eq!(raw.compute_txid(), sw.txid);
    let spends = c.tx_outspends(sw.txid, None).await.unwrap().value;
    assert_eq!(spends.len(), sw.vout.len());
    let proof = c.tx_merkle_proof(sw.txid).await.unwrap().value;
    assert_eq!(proof.block_height, 800_000);
    assert!(c.tx_status(sw.txid, None).await.unwrap().value.confirmed);
}

#[tokio::test]
async fn decodes_blocks_addresses_and_mempool() {
    let (url, _) = tcp_mock(fixtures).await;
    let c = Esplora::new(&url).unwrap();
    let hash: BlockHash = BLOCK_800K.parse().unwrap();

    let block = c.block(hash).await.unwrap().value;
    assert_eq!((block.id, block.height), (hash, 800_000));
    assert_eq!(c.block_header(hash).await.unwrap().value.block_hash(), hash);
    let status = c.block_status(hash).await.unwrap().value;
    assert!(status.in_best_chain && status.next_best.is_some());
    let blocks = c.blocks(None).await.unwrap().value;
    assert_eq!(blocks.len(), 10);
    assert!(blocks.windows(2).all(|w| w[0].height == w[1].height + 1));

    let positions = OutPositions::new(vec![
        OutPosition {
            height: 800_000,
            index: 1,
            vout: 0,
        },
        OutPosition {
            height: 800_000,
            index: 0,
            vout: 9,
        },
    ])
    .unwrap();
    let outs = c.outputs_at(positions, None).await.unwrap().value;
    assert_eq!(
        outs[0].as_ref().unwrap().out.scriptpubkey_type,
        ScriptType::V1P2tr
    );
    assert!(outs[1].is_none());

    let empty = address(
        "bc1q9luv2de4z8mhg60mv0cx0d8s7wl3xzxq562pss",
        Network::Bitcoin,
    );
    let stats = c.script_stats(empty.clone(), None).await.unwrap().value;
    assert_eq!(
        (stats.chain_stats.tx_count, stats.mempool_stats.tx_count),
        (0, 0)
    );
    assert!(
        c.script_txs(empty.clone(), None, None)
            .await
            .unwrap()
            .value
            .is_empty()
    );
    assert!(c.script_utxo(empty, None).await.unwrap().value.is_empty());

    let busy = address(
        "tb1pd5lycwpxag9suvpwcuu974xj7tzf57jyqk3pr2c98e022r5s2zkqzg6xd2",
        Network::Signet,
    );
    assert!(
        c.script_stats(busy.clone(), None)
            .await
            .unwrap()
            .value
            .chain_stats
            .tx_count
            > 0
    );
    let summary = c
        .script_txs_summary(busy.clone(), None, None)
        .await
        .unwrap()
        .value;
    assert_eq!(summary.len(), 25);
    let utxo = c.script_utxo(busy, None).await.unwrap().value;
    assert!(utxo.iter().any(|u| u.status.confirmed) && utxo.iter().any(|u| !u.status.confirmed));

    let mempool = c.mempool().await.unwrap();
    assert!(mempool.tip.is_none());
    assert!(!mempool.value.fee_histogram.is_empty());
    let fees = c.fee_estimates().await.unwrap().value;
    assert!(fees[&1] >= fees[&144]);
    assert_eq!(c.mempool_recent().await.unwrap().value.len(), 10);
}

#[tokio::test]
async fn maps_upstream_errors() {
    let (url, _) = tcp_mock(|r| match r.path.as_str() {
        "/api/blocks/tip/height" => Reply::new(503, "scripthash index disabled"),
        "/api/blocks/tip/hash" => Reply::new(
            503,
            "scripthash join exceeds --max-sh-creates (3 creates, cap 2)",
        ),
        "/api/mempool" => Reply::new(503, "chain view moved"),
        "/api/mempool/txids" => Reply::new(502, "<html>bad gateway</html>"),
        "/api/fee-estimates" => Reply::new(200, "{\"1\": \"lots\"}"),
        "/api/mempool/recent" => Reply::new(422, "after_txid not found"),
        "/api/blocks" => Reply::new(200, "[]").stamped("not-a-hash", 1),
        _ => Reply::new(404, "Not Found"),
    })
    .await;
    let c = Esplora::new(&url).unwrap();
    assert_eq!(
        c.tip_height().await.unwrap_err(),
        Error::AddressIndexDisabled
    );
    assert_eq!(c.tip_hash().await.unwrap_err(), Error::TooLarge);
    assert_eq!(c.mempool().await.unwrap_err(), Error::ChainViewMoved);
    assert!(matches!(
        c.mempool_txids().await.unwrap_err(),
        Error::Unavailable(_)
    ));
    assert!(matches!(
        c.fee_estimates().await.unwrap_err(),
        Error::Decode(_)
    ));
    let rejected = c.mempool_recent().await.unwrap_err();
    assert!(
        matches!(&rejected, Error::Rejected { status, message } if status.as_u16() == 422 && message == "after_txid not found")
    );
    assert_eq!(
        c.block(BLOCK_800K.parse().unwrap()).await.unwrap_err(),
        Error::NotFound
    );
    // A malformed stamp is dropped, not trusted and not fatal.
    assert_eq!(c.blocks(None).await.unwrap().tip, None);

    // Raw calls hand back any status untouched.
    let raw = c.raw(&Route::TipHeight).await.unwrap();
    assert_eq!(
        (raw.status.as_u16(), &raw.body[..]),
        (503, &b"scripthash index disabled"[..])
    );

    // Nothing listens on a port we just released.
    let gone = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = gone.local_addr().unwrap();
    drop(gone);
    let c = Esplora::new(&format!("http://{addr}")).unwrap();
    assert!(matches!(
        c.tip_height().await.unwrap_err(),
        Error::Unavailable(_)
    ));
}

/// `/block/:hash/txs/summary`: what rbitcoin answers, what a node without the route answers, and
/// every malformed or oversized answer as an error, never a panic.
#[tokio::test]
async fn decodes_block_txs_summaries_defensively() {
    const ROW: &str =
        r#"["4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",0,816,5000000000]"#;
    let huge = format!("[{}]", vec![ROW; MAX_BLOCK_TXS + 1].join(","));
    let (url, _) = tcp_mock(move |r| {
        let Some(rest) = r.path.strip_prefix("/api/block/") else {
            return Reply::new(404, "Not Found");
        };
        let (hash, _) = rest.split_once('/').unwrap();
        let body = match &hash[..4] {
            "0000" => fixture("testnet4/block-160394-txs-summary.json"),
            "0001" => format!("[{ROW}]").into_bytes(),
            "0002" => b"[]".to_vec(),
            "0010" => {
                r#"[["4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",0,816]]"#
                    .into()
            }
            "0011" => format!("[{}]", ROW.replace("]", ",1]")).into_bytes(),
            "0012" => ROW.replace(",0,", ",-1,").into_bytes(),
            "0013" => format!("[{}]", ROW.replace(",816,", ",4294967296,")).into_bytes(),
            "0014" => format!("[{}]", ROW.replace(",0,", ",\"0\",")).into_bytes(),
            "0015" => format!("[{}]", ROW.replace("4a5e", "zz")).into_bytes(),
            "0016" => br#"{"txid":"x"}"#.to_vec(),
            "0020" => huge.clone().into_bytes(),
            "0021" => vec![b' '; MAX_SUMMARY_BYTES + 1],
            // The same, streamed without a length: refused while reading, not after.
            "0022" => {
                return Reply {
                    close_delimited: true,
                    ..Reply::new(200, vec![b' '; MAX_SUMMARY_BYTES + 1])
                };
            }
            "0030" => return Reply::new(404, "Not Found"),
            "0031" => return Reply::new(404, "pruned"),
            // What rbitcoin v0.9.2 answers: the path falls through to `/txs/:start_index`.
            _ => {
                return Reply::new(
                    400,
                    "Invalid URL: Cannot parse value at index 1 with value `summary` to a `u32`",
                );
            }
        };
        Reply::new(200, body).stamped(TIP_A, 975_509)
    })
    .await;
    let c = Esplora::new(&url).unwrap();
    let hash =
        |prefix: &str| -> BlockHash { format!("{prefix}{}", "0".repeat(60)).parse().unwrap() };

    let rows = c.block_txs_summary(hash("0000")).await.unwrap();
    assert_eq!(rows.tip.unwrap().height, 975_509);
    let rows = rows.value;
    assert_eq!(rows.len(), 6);
    assert_eq!(
        (rows[0].fee.to_sat(), rows[0].weight, rows[0].value.to_sat()),
        (0, 1276, 5_000_000_981)
    );
    assert_eq!(
        rows[5].txid.to_string(),
        "a744298636e7c96603212df56831a0378d194703745ea2049e238d76600a3a58"
    );
    assert_eq!(
        (rows[5].fee.to_sat(), rows[5].weight, rows[5].value.to_sat()),
        (166, 661, 837_077)
    );
    // A block holding only its coinbase; an empty list decodes too, for the caller to judge.
    assert_eq!(
        c.block_txs_summary(hash("0001")).await.unwrap().value.len(),
        1
    );
    assert!(
        c.block_txs_summary(hash("0002"))
            .await
            .unwrap()
            .value
            .is_empty()
    );

    // Rows of three or five, a negative fee, a weight past u32, a fee as text, a bad txid, an
    // object: each a decode error.
    for p in ["0010", "0011", "0012", "0013", "0014", "0015", "0016"] {
        assert!(
            matches!(c.block_txs_summary(hash(p)).await, Err(Error::Decode(_))),
            "{p}"
        );
    }
    // More rows than a block can hold, and more bytes than such rows take.
    assert!(matches!(
        c.block_txs_summary(hash("0020")).await,
        Err(Error::Decode(_))
    ));
    for p in ["0021", "0022"] {
        assert_eq!(
            c.block_txs_summary(hash(p)).await.unwrap_err(),
            Error::ResponseTooBig,
            "{p}"
        );
    }

    // Unknown, off the best chain or pruned: 404, whatever the text.
    for p in ["0030", "0031"] {
        assert_eq!(
            c.block_txs_summary(hash(p)).await.unwrap_err(),
            Error::NotFound
        );
    }
    // A node without the route.
    assert!(matches!(
        c.block_txs_summary(hash("ffff")).await.unwrap_err(),
        Error::Rejected { status, .. } if status.as_u16() == 400
    ));
}

#[tokio::test]
async fn times_out() {
    let (url, _) = tcp_mock(|r| {
        let slow = Duration::from_secs(5);
        match r.path.as_str() {
            "/api/blocks/tip/height" => Reply {
                delay: slow,
                ..Reply::new(200, "1")
            },
            // Headers arrive at once; the body stalls.
            _ => Reply {
                body_delay: slow,
                ..Reply::new(200, "1")
            },
        }
    })
    .await;
    let c = Esplora::with_limits(&url, Duration::from_millis(100), 1024).unwrap();
    assert_eq!(c.tip_height().await.unwrap_err(), Error::Timeout);
    assert_eq!(c.raw(&Route::TipHash).await.unwrap_err(), Error::Timeout);
}

#[tokio::test]
async fn caps_response_size() {
    let (url, _) = tcp_mock(|r| {
        let big = vec![b'7'; 2048];
        match r.path.as_str() {
            "/api/blocks/tip/height" => Reply::new(200, big),
            _ => Reply {
                close_delimited: true,
                ..Reply::new(200, big)
            },
        }
    })
    .await;
    let c = Esplora::with_limits(&url, Duration::from_secs(5), 1024).unwrap();
    // Announced by Content-Length, and found while streaming a body without one.
    assert_eq!(c.tip_height().await.unwrap_err(), Error::ResponseTooBig);
    assert_eq!(
        c.raw(&Route::TipHash).await.unwrap_err(),
        Error::ResponseTooBig
    );
    let roomy = Esplora::with_limits(&url, Duration::from_secs(5), 4096).unwrap();
    assert_eq!(roomy.raw(&Route::TipHash).await.unwrap().body.len(), 2048);
}

#[tokio::test]
async fn reuses_connections() {
    let (url, log) = tcp_mock(|_| Reply::new(200, "975509")).await;
    let c = Esplora::new(&url).unwrap();
    for _ in 0..5 {
        assert_eq!(c.tip_height().await.unwrap().value, 975_509);
    }
    assert_eq!(log.conns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unix_socket_and_internal_routes() {
    let (path, log) = unix_mock(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/blocks/tip/height") => Reply::new(200, "42").stamped(TIP_A, 42),
        ("POST", "/internal/txs/outspends/by-txid") => {
            Reply::new(200, "[[],[{\"spent\":false}]]").stamped(TIP_A, 42)
        }
        _ => Reply::new(404, "Not Found"),
    })
    .await;
    let c = Esplora::new(path.to_str().unwrap()).unwrap();
    assert!(c.has_internal());
    assert_eq!(c.tip_height().await.unwrap().value, 42);
    let ids = vec![txid(BLOCK_800K), txid(TIP_A)];
    let spends = c.internal_outspends_by_txid(ids).await.unwrap().value;
    assert_eq!(spends.len(), 2);
    let body = log.reqs.lock().unwrap().last().unwrap().body.clone();
    assert_eq!(body, format!("[\"{BLOCK_800K}\",\"{TIP_A}\"]").into_bytes());
    let _ = std::fs::remove_file(&path);

    // Over TCP the internal routes are refused before any request is sent.
    let (url, log) = tcp_mock(|_| Reply::new(200, "[]")).await;
    let c = Esplora::new(&url).unwrap();
    assert!(!c.has_internal());
    assert_eq!(
        c.internal_mempool_txs(None, Some(10)).await.unwrap_err(),
        Error::InternalUnavailable
    );
    assert!(log.paths().is_empty());
}

#[tokio::test]
async fn retries_when_the_tip_moves() {
    // The block answers from tip A once, then tip B; its txs always from tip B.
    let block_calls = Arc::new(AtomicUsize::new(0));
    let calls = block_calls.clone();
    let (url, log) = tcp_mock(move |r| {
        if r.path.ends_with("/txs/0") {
            return Reply::new(200, "[]").stamped(TIP_B, 2);
        }
        let tip = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            TIP_A
        } else {
            TIP_B
        };
        Reply::new(200, fixture("mainnet/block.json"))
            .stamped(tip, if tip == TIP_A { 1 } else { 2 })
    })
    .await;
    let c = Esplora::new(&url).unwrap();
    let hash: BlockHash = BLOCK_800K.parse().unwrap();
    let read = || async {
        let mut tips = TipCheck::default();
        let block = tips.take(c.block(hash).await?)?;
        let txs = tips.take(c.block_txs(hash, BlockTxsStart::FIRST).await?)?;
        Ok((block, txs, tips.tip()))
    };
    let (block, txs, tip) = consistent(read).await.unwrap();
    assert_eq!(block.id, hash);
    assert!(txs.is_empty());
    assert_eq!(tip.unwrap().height, 2);
    assert_eq!(log.paths().len(), 4, "one retry");

    // A tip that never settles gives up with ChainViewMoved.
    let (url, _) = tcp_mock(|r| {
        let (tip, h) = if r.path.ends_with("/txs/0") {
            (TIP_B, 2)
        } else {
            (TIP_A, 1)
        };
        Reply::new(
            200,
            if h == 2 {
                b"[]".to_vec()
            } else {
                fixture("mainnet/block.json")
            },
        )
        .stamped(tip, h)
    })
    .await;
    let c = Esplora::new(&url).unwrap();
    let read = || async {
        let mut tips = TipCheck::default();
        tips.take(c.block(hash).await?)?;
        tips.take(c.block_txs(hash, BlockTxsStart::FIRST).await?)?;
        Ok(())
    };
    assert_eq!(consistent(read).await.unwrap_err(), Error::ChainViewMoved);
}

#[tokio::test]
async fn sends_asof_and_cursors() {
    let (url, log) = tcp_mock(|_| Reply::new(200, "[]")).await;
    let c = Esplora::new(&url).unwrap();
    let h: BlockHash = BLOCK_800K.parse().unwrap();
    let t = txid(TIP_A);
    let sh = ScriptRef::ScriptHash(ScriptHash::from_digest_hex(TIP_A).unwrap());
    c.script_txs_chain(sh.clone(), Some(t), Some(h))
        .await
        .unwrap();
    c.tx_outspends(t, Some(h)).await.unwrap();
    assert_eq!(
        log.paths(),
        [
            format!("/api/scripthash/{TIP_A}/txs/chain/{TIP_A}?asof={BLOCK_800K}"),
            format!("/api/tx/{TIP_A}/outspends?asof={BLOCK_800K}"),
        ]
    );
}
