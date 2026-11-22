//! JSON-RPC client against a local mock server: fixture decoding and transport behaviour.
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

use bitcoin::{Amount, BlockHash, OutPoint, SignedAmount, Txid};
use node::rpc::{BlockRef, Error, Limits, MAX_PREVOUTS, Rpc};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const USER: &str = "explorer";
const PASSWORD: &str = "correct horse battery staple";
/// base64("explorer:correct horse battery staple")
const BASIC: &str = "Basic ZXhwbG9yZXI6Y29ycmVjdCBob3JzZSBiYXR0ZXJ5IHN0YXBsZQ==";

#[derive(Debug, Clone)]
struct Req {
    authorization: Option<String>,
    body: Value,
}

struct Reply {
    status: u16,
    body: Vec<u8>,
    delay: Duration,
}

impl Reply {
    fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            body: body.into(),
            delay: Duration::ZERO,
        }
    }
}

type Handler = Arc<dyn Fn(&Req) -> Reply + Send + Sync>;

#[derive(Clone, Default)]
struct Log {
    reqs: Arc<Mutex<Vec<Req>>>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: Arc<AtomicUsize>,
}

async fn serve(stream: tokio::net::TcpStream, handler: Handler, log: Log) {
    let mut s = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if s.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let (mut len, mut authorization) = (0, None);
        loop {
            let mut h = String::new();
            s.read_line(&mut h).await.unwrap();
            if h.trim().is_empty() {
                break;
            }
            let (k, v) = h.split_once(':').unwrap();
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap();
            } else if k.eq_ignore_ascii_case("authorization") {
                authorization = Some(v.trim().to_owned());
            }
        }
        let mut body = vec![0; len];
        s.read_exact(&mut body).await.unwrap();
        let req = Req {
            authorization,
            body: serde_json::from_slice(&body).unwrap(),
        };
        log.reqs.lock().unwrap().push(req.clone());
        let now = log.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        log.max_in_flight.fetch_max(now, Ordering::SeqCst);
        let reply = handler(&req);
        tokio::time::sleep(reply.delay).await;
        log.in_flight.fetch_sub(1, Ordering::SeqCst);
        let head = format!(
            "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
            reply.status,
            reply.body.len()
        );
        let w = s.get_mut();
        if w.write_all(head.as_bytes()).await.is_err() || w.write_all(&reply.body).await.is_err() {
            return;
        }
    }
}

/// A mock node on port 0.
async fn mock(handler: impl Fn(&Req) -> Reply + Send + Sync + 'static) -> (u16, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (handler, log): (Handler, Log) = (Arc::new(handler), Log::default());
    let l = log.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = listener.accept().await {
            tokio::spawn(serve(s, handler.clone(), l.clone()));
        }
    });
    (port, log)
}

fn client(port: u16) -> Rpc {
    Rpc::new("127.0.0.1", port, USER, PASSWORD).unwrap()
}

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/rpc")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Answers each method with its recorded mainnet response, after checking the credentials.
fn mainnet(req: &Req) -> Reply {
    if req.authorization.as_deref() != Some(BASIC) {
        return Reply::new(401, "Unauthorized");
    }
    let method = req.body["method"].as_str().unwrap();
    let params = &req.body["params"];
    let name = match method {
        "getmempoolentry" if params[0] == "00".repeat(32) => {
            return Reply::new(500, fixture("mainnet/getmempoolentry-missing.json"));
        }
        "estimatesmartfee" if params[0] == 1008 => "estimatesmartfee-1008".to_owned(),
        m => m.to_owned(),
    };
    Reply::new(200, fixture(&format!("mainnet/{name}.json")))
}

fn txid(s: &str) -> Txid {
    s.parse().unwrap()
}

#[tokio::test]
async fn blockchain_info_reads_the_optional_prune_watermark() {
    for pruneheight in [None, Some(0), Some(976_759)] {
        let (port, _) = mock(move |req| {
            let reply = mainnet(req);
            let mut answer: Value = serde_json::from_slice(&reply.body).unwrap();
            answer["result"]["pruned"] = true.into();
            if let Some(height) = pruneheight {
                answer["result"]["pruneheight"] = height.into();
            }
            Reply::new(200, serde_json::to_vec(&answer).unwrap())
        })
        .await;
        let info = client(port).blockchain_info().await.unwrap();
        assert!(info.pruned);
        assert_eq!(info.pruneheight, pruneheight);
    }
}

#[tokio::test]
async fn every_method_decodes_its_fixture_and_sends_fixed_params() {
    let (port, log) = mock(mainnet).await;
    let rpc = client(port);

    let info = rpc.blockchain_info().await.unwrap();
    assert_eq!(info.chain, "main");
    assert_eq!(info.blocks, info.headers);
    assert_eq!(info.pruneheight, None);
    let header = rpc.block_header(info.bestblockhash).await.unwrap();
    assert_eq!(header.hash, info.bestblockhash);
    assert_eq!(header.height, info.blocks);
    assert!(header.previousblockhash.is_some() && header.n_tx > 0);
    let block = rpc.block(header.hash).await.unwrap();
    assert_eq!((block.hash, block.height), (header.hash, header.height));
    assert_eq!(block.tx.len(), 3);
    assert_eq!(block.tx[0].fee, None);
    assert_eq!(block.tx[1].fee, Some(Amount::from_sat(13_538)));
    assert_eq!((block.tx[1].vsize, block.tx[1].weight), (218, 870));
    assert_eq!(block.tx[0].value, Amount::from_sat(313_975_029));
    assert_eq!(block.tx[1].value, Amount::from_sat(62_213_389));
    // The coinbase's script and outputs are kept for pool attribution: ViaBTC's tag, four outputs.
    let tag = block.coinbase.script.as_bytes();
    assert!(tag.windows(8).any(|w| w == b"/ViaBTC/"));
    assert_eq!(block.coinbase.outputs.len(), 4);
    let paid: u64 = block
        .coinbase
        .outputs
        .iter()
        .map(|o| o.value.to_sat())
        .sum();
    assert_eq!(paid, block.tx[0].value.to_sat());
    assert_eq!(block.coinbase.outputs[0].script_pubkey.len(), 25);
    assert!(block.weight <= 4_000_000);
    let stats = rpc
        .block_stats(BlockRef::Height(info.blocks))
        .await
        .unwrap();
    assert_eq!(stats.blockhash, info.bestblockhash);
    assert_eq!(stats.subsidy, Amount::from_sat(312_500_000));
    let tips = rpc.chain_tips().await.unwrap();
    assert_eq!(tips[0].status, "active");
    assert!(rpc.difficulty().await.unwrap() > 1e14);
    assert!(rpc.network_hash_ps(120, None).await.unwrap() > 1e20);
    let mining = rpc.mining_info().await.unwrap();
    assert_eq!(mining.next.height, mining.blocks + 1);
    assert!(mining.networkhashps > u64::MAX as f64);
    assert_eq!(mining.blockmintxfee, Amount::from_sat(1));

    let mempool = rpc.mempool_info().await.unwrap();
    assert_eq!(mempool.mempoolminfee, Amount::from_sat(100));
    assert!(mempool.total_fee > Amount::ZERO);
    let raw = rpc.raw_mempool().await.unwrap();
    assert_eq!(raw.txids.len(), 5);
    assert!(raw.mempool_sequence > 0);
    let t = txid("000007b8d962b31541e6929d58b4be23835f5fe229437074287bfc4107ea1efd");
    assert_eq!(raw.txids[0], t);
    let entry = rpc.mempool_entry(t).await.unwrap();
    assert_eq!(entry.fees.base, Amount::from_sat(13));
    assert_eq!(entry.fees.chunk, SignedAmount::from_sat(312));
    assert_eq!(entry.weight, 502);
    assert!(entry.bip125_replaceable);
    let parent = entry.depends[0];
    let cluster = rpc.mempool_cluster(t).await.unwrap();
    let chunk = cluster.chunks.iter().find(|c| c.txs.contains(&t)).unwrap();
    assert_eq!(chunk.chunkweight, entry.chunkweight);
    assert_eq!(chunk.chunkfee, entry.fees.chunk);
    let ancestors = rpc.mempool_ancestors(t).await.unwrap();
    assert_eq!(ancestors.len() as u64, entry.ancestorcount - 1);
    assert!(ancestors.contains(&parent));
    let descendants = rpc.mempool_descendants(t).await.unwrap();
    assert_eq!(descendants.len() as u64, entry.descendantcount - 1);
    assert!(descendants.contains(&entry.spentby[0]));
    let diagram = rpc.mempool_feerate_diagram().await.unwrap();
    assert_eq!(diagram.len(), 13);
    assert!(diagram.iter().all(|p| p.weight > 0));
    let spends = rpc
        .tx_spending_prevout(&[OutPoint::new(parent, 0), OutPoint::new(parent, 1)])
        .await
        .unwrap();
    assert_eq!(spends[0].spendingtxid, Some(t));
    assert_eq!(
        (spends[1].txid, spends[1].vout, spends[1].spendingtxid),
        (parent, 1, None)
    );

    let template = rpc.block_template().await.unwrap();
    assert_eq!(template.height, info.blocks + 1);
    assert_eq!(template.previousblockhash, info.bestblockhash);
    assert_eq!(template.weightlimit, Some(4_000_000));
    assert_eq!(template.transactions.len(), 4);
    assert_eq!(template.transactions[3].depends, [3]);
    assert!(template.transactions.iter().all(|t| t.fee > Amount::ZERO));
    let fee = rpc.estimate_smart_fee(2).await.unwrap();
    assert_eq!(fee.blocks, 2);
    assert!(fee.feerate.is_some_and(|f| f >= Amount::from_sat(100)));
    let fee = rpc.estimate_smart_fee(1008).await.unwrap();
    assert_eq!(fee.blocks, 1008);
    let net = rpc.network_info().await.unwrap();
    assert_eq!(
        (net.version, net.subversion.as_str()),
        (190000, "/rbitcoin:0.9.1/")
    );

    // The wire requests: one fixed method name each, typed params, credentials on every call.
    let reqs = log.reqs.lock().unwrap();
    assert!(
        reqs.iter()
            .all(|r| r.authorization.as_deref() == Some(BASIC))
    );
    let sent: Vec<String> = reqs
        .iter()
        .map(|r| {
            format!(
                "{} {}",
                r.body["method"].as_str().unwrap(),
                r.body["params"]
            )
        })
        .collect();
    let tip = info.bestblockhash;
    assert_eq!(
        sent,
        [
            "getblockchaininfo []".to_owned(),
            format!("getblockheader [\"{tip}\",true]"),
            format!("getblock [\"{tip}\",2]"),
            format!("getblockstats [{}]", info.blocks),
            "getchaintips []".into(),
            "getdifficulty []".into(),
            "getnetworkhashps [120,-1]".into(),
            "getmininginfo []".into(),
            "getmempoolinfo []".into(),
            "getrawmempool [false,true]".into(),
            format!("getmempoolentry [\"{t}\"]"),
            format!("getmempoolcluster [\"{t}\"]"),
            format!("getmempoolancestors [\"{t}\",false]"),
            format!("getmempooldescendants [\"{t}\",false]"),
            "getmempoolfeeratediagram []".into(),
            format!(
                "gettxspendingprevout [[{{\"txid\":\"{parent}\",\"vout\":0}},{{\"txid\":\"{parent}\",\"vout\":1}}]]"
            ),
            r#"getblocktemplate [{"mode":"template","rules":["segwit","signet"]}]"#.into(),
            "estimatesmartfee [2]".into(),
            "estimatesmartfee [1008]".into(),
            "getnetworkinfo []".into(),
        ]
    );
    assert!(reqs.iter().all(|r| r.body["jsonrpc"] == "1.0"));
}

#[tokio::test]
async fn block_stats_by_hash_and_signet_template() {
    let (port, log) = mock(|req| {
        let name = match req.body["method"].as_str().unwrap() {
            "getblocktemplate" => "signet/getblocktemplate.json",
            _ => "mainnet/getblockstats.json",
        };
        Reply::new(200, fixture(name))
    })
    .await;
    let rpc = client(port);
    let hash: BlockHash = "000000000000000000006724a7529e086eeed0a7397d12f501c3ce743002311d"
        .parse()
        .unwrap();
    rpc.block_stats(BlockRef::Hash(hash)).await.unwrap();
    assert_eq!(
        log.reqs.lock().unwrap()[0].body["params"],
        serde_json::json!([hash.to_string()])
    );
    let template = rpc.block_template().await.unwrap();
    assert!(template.rules.iter().any(|r| r == "!signet"));
    assert_eq!(template.transactions.len(), 2);
}

#[tokio::test]
async fn node_errors_are_typed() {
    let (port, _) = mock(mainnet).await;
    let rpc = client(port);
    assert_eq!(
        rpc.mempool_entry(Txid::from_raw_hash(bitcoin::hashes::Hash::all_zeros()))
            .await
            .unwrap_err(),
        Error::Rpc {
            code: -5,
            message: "Transaction not in mempool".into()
        }
    );

    // Method not found comes back as 404 with a JSON-RPC body.
    let (port, _) = mock(|_| {
        Reply::new(
            404,
            r#"{"result":null,"error":{"code":-32601,"message":"Method not found"},"id":0}"#,
        )
    })
    .await;
    assert!(matches!(
        client(port).difficulty().await,
        Err(Error::Rpc { code: -32601, .. })
    ));

    let (port, _) =
        mock(|_| Reply::new(200, r#"{"result":{"chain":"main"},"error":null,"id":0}"#)).await;
    assert!(matches!(
        client(port).blockchain_info().await,
        Err(Error::Decode(_))
    ));
    let (port, _) = mock(|_| Reply::new(502, "<html>bad gateway</html>")).await;
    assert!(matches!(
        client(port).difficulty().await,
        Err(Error::Unavailable(_))
    ));
}

#[tokio::test]
async fn auth_failure_never_reveals_the_password() {
    let (port, log) = mock(mainnet).await;
    let rpc = Rpc::new("127.0.0.1", port, USER, "wrong password").unwrap();
    let err = rpc.blockchain_info().await.unwrap_err();
    assert_eq!(err, Error::Auth);
    assert!(log.reqs.lock().unwrap()[0].authorization.is_some());
    for text in [format!("{err}"), format!("{err:?}"), format!("{rpc:?}")] {
        assert!(!text.contains("wrong password"), "{text}");
        assert!(!text.contains("Basic"), "{text}");
    }
    assert!(client(port).blockchain_info().await.is_ok());
}

#[tokio::test]
async fn busy_node_is_backpressure() {
    let (port, _) = mock(|_| Reply::new(503, "Work queue depth exceeded")).await;
    assert_eq!(client(port).mempool_info().await.unwrap_err(), Error::Busy);
}

#[tokio::test]
async fn slow_node_times_out() {
    let (port, _) = mock(|_| Reply {
        delay: Duration::from_secs(5),
        ..Reply::new(200, fixture("mainnet/getdifficulty.json"))
    })
    .await;
    let limits = Limits {
        timeout: Duration::from_millis(200),
        ..Limits::default()
    };
    let rpc = Rpc::with_limits("127.0.0.1", port, USER, PASSWORD, limits).unwrap();
    assert_eq!(rpc.difficulty().await.unwrap_err(), Error::Timeout);
}

#[tokio::test]
async fn response_size_is_capped() {
    let (port, _) = mock(|_| Reply::new(200, fixture("mainnet/getblocktemplate.json"))).await;
    let limits = Limits {
        max_response_bytes: 1024,
        ..Limits::default()
    };
    let rpc = Rpc::with_limits("127.0.0.1", port, USER, PASSWORD, limits).unwrap();
    assert_eq!(
        rpc.block_template().await.unwrap_err(),
        Error::ResponseTooBig
    );
}

#[tokio::test]
async fn concurrent_calls_are_limited() {
    let (port, log) = mock(|_| Reply {
        delay: Duration::from_millis(100),
        ..Reply::new(200, fixture("mainnet/getdifficulty.json"))
    })
    .await;
    let limits = Limits {
        max_concurrent: 2,
        ..Limits::default()
    };
    let rpc = Rpc::with_limits("127.0.0.1", port, USER, PASSWORD, limits).unwrap();
    let calls: Vec<_> = (0..8)
        .map(|_| {
            let rpc = rpc.clone();
            tokio::spawn(async move { rpc.difficulty().await })
        })
        .collect();
    for c in calls {
        c.await.unwrap().unwrap();
    }
    assert_eq!(log.reqs.lock().unwrap().len(), 8);
    assert_eq!(log.max_in_flight.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn waiting_for_a_slot_counts_against_the_timeout() {
    let (port, _) = mock(|_| Reply {
        delay: Duration::from_millis(300),
        ..Reply::new(200, fixture("mainnet/getdifficulty.json"))
    })
    .await;
    let limits = Limits {
        timeout: Duration::from_millis(500),
        max_concurrent: 1,
        ..Limits::default()
    };
    let rpc = Rpc::with_limits("127.0.0.1", port, USER, PASSWORD, limits).unwrap();
    let (a, b) = tokio::join!(rpc.difficulty(), rpc.difficulty());
    // One call runs for 300 ms; the other waits for it, then has 200 ms left for its own 300.
    assert!(a.is_ok() != b.is_ok());
    assert_eq!(a.err().or(b.err()), Some(Error::Timeout));
}

#[tokio::test]
async fn unreachable_node_is_unavailable() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    assert!(matches!(
        client(port).difficulty().await,
        Err(Error::Unavailable(_))
    ));
}

#[tokio::test]
async fn too_many_outpoints_are_refused_before_sending() {
    let (port, log) = mock(mainnet).await;
    let rpc = client(port);
    let t = txid("000007b8d962b31541e6929d58b4be23835f5fe229437074287bfc4107ea1efd");
    let outpoints: Vec<OutPoint> = (0..=MAX_PREVOUTS as u32)
        .map(|v| OutPoint::new(t, v))
        .collect();
    assert_eq!(
        rpc.tx_spending_prevout(&outpoints).await.unwrap_err(),
        Error::RequestTooBig
    );
    assert!(log.reqs.lock().unwrap().is_empty());
    rpc.tx_spending_prevout(&outpoints[..MAX_PREVOUTS])
        .await
        .unwrap();
}

/// Answers a JSON-RPC 2.0 array from the fixtures, in reverse order, with `-5` for unknown txids.
/// As in 2.0, an answer carries either `result` or `error`, never both.
fn batch_mainnet(req: &Req) -> Reply {
    let known = "000007b8d962b31541e6929d58b4be23835f5fe229437074287bfc4107ea1efd";
    let result = |name: &str| -> Value {
        serde_json::from_slice::<Value>(&fixture(&format!("mainnet/{name}.json"))).unwrap()["result"]
            .clone()
    };
    let mut answers: Vec<Value> = req
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|call| {
            let id = call["id"].clone();
            if call["params"][0] != known {
                let error =
                    serde_json::json!({"code": -5, "message": "Transaction not in mempool"});
                return serde_json::json!({"jsonrpc": "2.0", "error": error, "id": id});
            }
            let r = result(call["method"].as_str().unwrap());
            serde_json::json!({"jsonrpc": "2.0", "result": r, "id": id})
        })
        .collect();
    answers.reverse();
    Reply::new(200, serde_json::to_vec(&answers).unwrap())
}

#[tokio::test]
async fn batches_answer_each_txid_in_order() {
    let (port, log) = mock(batch_mainnet).await;
    let rpc = client(port);
    let known = txid("000007b8d962b31541e6929d58b4be23835f5fe229437074287bfc4107ea1efd");
    let gone = Txid::from_raw_hash(bitcoin::hashes::Hash::all_zeros());

    let entries = rpc.mempool_entries(&[gone, known]).await.unwrap();
    assert!(matches!(entries[0], Err(Error::Rpc { code: -5, .. })));
    assert_eq!(entries[1].as_ref().unwrap().weight, 502);
    let txs = rpc.raw_transactions(&[known, gone]).await.unwrap();
    assert_eq!(txs[0].as_ref().unwrap().compute_txid(), known);
    assert!(matches!(txs[1], Err(Error::Rpc { code: -5, .. })));
    let sent = log.reqs.lock().unwrap()[1].body.clone();
    // Batches are a JSON-RPC 2.0 feature; a node may refuse 1.0 calls inside one.
    assert!(
        sent.as_array()
            .unwrap()
            .iter()
            .all(|c| c["jsonrpc"] == "2.0")
    );
    assert_eq!(sent[0]["method"], "getrawtransaction");
    assert_eq!(
        sent[0]["params"],
        serde_json::json!([known.to_string(), false])
    );
    assert!(rpc.bytes_received() > 1000);

    assert!(rpc.mempool_entries(&[]).await.unwrap().is_empty());
    assert_eq!(
        rpc.mempool_entries(&vec![known; node::rpc::MAX_BATCH + 1])
            .await
            .unwrap_err(),
        Error::RequestTooBig
    );
    assert_eq!(log.reqs.lock().unwrap().len(), 2);

    // A whole-batch failure fails the call; a short or mismatched answer is a decode error.
    let (port, _) = mock(|_| Reply::new(503, "Work queue depth exceeded")).await;
    assert_eq!(
        client(port).mempool_entries(&[known]).await.unwrap_err(),
        Error::Busy
    );
    let (port, _) = mock(|_| Reply::new(200, "[]")).await;
    assert!(matches!(
        client(port).mempool_entries(&[known]).await,
        Err(Error::Decode(_))
    ));
    let (port, _) = mock(|_| {
        Reply::new(
            500,
            r#"{"result":null,"error":{"code":-32700,"message":"Parse error"},"id":null}"#,
        )
    })
    .await;
    assert!(matches!(
        client(port).raw_transactions(&[known]).await,
        Err(Error::Rpc { code: -32700, .. })
    ));
}
