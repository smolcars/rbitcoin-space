//! The mempool.space-shaped socket's sessions and messages, against the real tracker and
//! projected blocks on the mock node of `track/tests.rs`, a mock Electrum server and a mock
//! Esplora on port 0. The end-to-end socket tests are in `tests/ws.rs`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize};

use axum::extract::Path;
use bitcoin::hashes::Hash;
use engine::projected::{Placed, Position, ProjectedBlock};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::*;
use crate::config::Network;
use crate::replacements::Link;
use crate::ws::tests::address;
use crate::ws::track::tests::{Electrum, Mock, Server, coin, context, context_at, context_with};

const WAIT: Duration = Duration::from_secs(10);

/// A socket as the session sees it: every message queued to it, in order.
struct Client {
    conn: Arc<Conn>,
    rx: mpsc::Receiver<Frame>,
    seen: VecDeque<Value>,
}

impl Client {
    fn new() -> Self {
        static IDS: AtomicU64 = AtomicU64::new(3_000_000);
        let (tx, rx) = mpsc::channel(256);
        let conn = Arc::new(Conn::test(IDS.fetch_add(1, Ordering::Relaxed), tx));
        Self {
            conn,
            rx,
            seen: VecDeque::new(),
        }
    }

    fn drain(&mut self) {
        while let Ok(f) = self.rx.try_recv() {
            self.seen.push_back(decode(&f));
        }
    }

    /// The next message with `key`; the ones before it are dropped.
    async fn next(&mut self, key: &str) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            self.drain();
            while let Some(v) = self.seen.pop_front() {
                if v.get(key).is_some() {
                    return v;
                }
            }
            assert!(Instant::now() < deadline, "no {key} message");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Everything queued so far.
    fn all(&mut self) -> Vec<Value> {
        self.drain();
        self.seen.drain(..).collect()
    }
}

/// A server frame's JSON payload.
fn decode(f: &Frame) -> Value {
    let b = f.as_bytes();
    let at = match b[1] & 0x7F {
        126 => 4,
        127 => 10,
        _ => 2,
    };
    serde_json::from_slice(&b[at..]).unwrap()
}

fn limits() -> WsLimits {
    WsLimits::default()
}

fn send(s: &mut Session<'_>, msg: &Value) {
    assert_eq!(s.handle(&msg.to_string(), &limits()), Ok(()), "{msg}");
}

fn script_of(address: &str) -> ScriptHash {
    match track::parse(&format!("address:{address}"), Network::Regtest) {
        Some((Topic::Address(sh), _)) => sh,
        _ => panic!("not an address"),
    }
}

#[tokio::test]
async fn client_messages_are_parsed_strictly() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &c_conn);
    let l = limits();

    // Not JSON closes the socket, as on the reference.
    for bad in ["", "hello", "{", r#"{"action":"#, "\u{0}"] {
        assert_eq!(s.handle(bad, &l), Err(Close::BAD_MESSAGE), "{bad:?}");
    }
    // JSON that is not understood, or a value that does not parse for this network, is left
    // unanswered and changes nothing.
    let lower = "ab".repeat(32);
    let mainnet = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    let quiet = [
        json!(null),
        json!([1, 2]),
        json!("want"),
        json!({}),
        json!({"bogus": 1}),
        json!({"action": 5}),
        json!({"action": "want"}),
        json!({"action": "want", "data": "blocks"}),
        json!({"action": "want", "data": ["blocks", 1]}),
        json!({"action": "want", "data": {"blocks": true}}),
        json!({"track-tx": "zz"}),
        json!({"track-tx": lower.to_uppercase()}),
        json!({"track-tx": &lower[1..]}),
        json!({"track-tx": format!("{lower}0")}),
        json!({"track-tx": format!(" {lower}")}),
        json!({"track-tx": format!("+{}", &lower[1..])}),
        json!({"track-tx": 5}),
        json!({"track-tx": [lower]}),
        json!({"track-address": "notanaddress"}),
        json!({"track-address": mainnet}),
        json!({"track-address": format!("{} ", address(1))}),
        json!({"track-address": null}),
        json!({"track-addresses": address(1)}),
        json!({"track-addresses": [1]}),
        json!({"track-addresses": [address(1), 2]}),
        json!({"track-addresses": [mainnet]}),
    ];
    for msg in &quiet {
        send(&mut s, msg);
    }
    assert_eq!(c.all(), Vec::<Value>::new());
    assert_eq!(ctx.track.tracked(), (0, 0));
    assert_eq!(ctx.v1.followed(), 0);

    send(&mut s, &json!({"action": "ping"}));
    assert_eq!(c.all(), [json!({"pong": true})]);
    // `init`: what no part carries, the backend as `/api/v1/backend-info` describes it.
    send(&mut s, &json!({"action": "init"}));
    let info = serde_json::to_value(api_v1::backend_info(&ctx)).unwrap();
    assert_eq!(
        c.all(),
        [json!({"loadingIndicators": {}, "backend": "esplora", "backendInfo": info})]
    );

    // `want` replaces the set; unknown names are ignored.
    send(
        &mut s,
        &json!({"action": "want", "data": ["blocks", "stats", "nonsense"]}),
    );
    let subs = |t| ctx.hub.subscribers(t);
    let wanted = || {
        [
            Topic::V1Blocks,
            Topic::V1Stats,
            Topic::V1MempoolBlocks,
            Topic::V1LiveChart,
        ]
        .map(subs)
    };
    assert_eq!(wanted(), [1, 1, 0, 0]);
    send(
        &mut s,
        &json!({"action": "want", "data": ["mempool-blocks", "live-2h-chart"]}),
    );
    assert_eq!(wanted(), [0, 0, 1, 1]);

    // One `track-tx` at a time: a new one replaces it, the same one changes nothing, `stop` ends it.
    send(&mut s, &json!({"track-tx": lower}));
    send(&mut s, &json!({"track-tx": lower}));
    assert_eq!(ctx.track.tracked(), (1, 0));
    send(&mut s, &json!({"track-tx": "cd".repeat(32)}));
    assert_eq!(ctx.track.tracked(), (1, 0));
    send(&mut s, &json!({"track-tx": "stop"}));
    assert_eq!(ctx.track.tracked(), (0, 0));

    // Addresses: upper-case bech32 is the same address; duplicates are one; the node is asked
    // once per address whatever the number of topics on it.
    send(&mut s, &json!({"track-address": address(1).to_uppercase()}));
    send(
        &mut s,
        &json!({"track-addresses": [address(1), address(1)]}),
    );
    assert_eq!((ctx.track.tracked(), ctx.v1.followed()), ((0, 1), 1));
    assert_eq!(s.addresses.len(), 1);

    // Over the per-connection cap, counted with `track-address`: refused whole, in the
    // reference's error key, and nothing changes.
    let too_many =
        json!({"track-addresses-error": "at most 2 addresses can be followed on one connection"});
    send(
        &mut s,
        &json!({"track-addresses": [address(2), address(3)]}),
    );
    assert_eq!(c.all(), std::slice::from_ref(&too_many));
    let flood: Vec<String> = (0..10_000).map(|i| format!("x{i}")).collect();
    send(&mut s, &json!({"track-addresses": flood}));
    assert_eq!(c.all(), [too_many]);
    assert_eq!((ctx.track.tracked(), ctx.v1.followed()), ((0, 1), 1));
    // A new set replaces the old; an empty one stops them all.
    send(&mut s, &json!({"track-addresses": [address(2)]}));
    assert_eq!((ctx.track.tracked(), ctx.v1.followed()), ((0, 2), 2));
    send(&mut s, &json!({"track-addresses": []}));
    send(&mut s, &json!({"track-address": "stop"}));
    assert_eq!(ctx.v1.followed(), 0);

    // The heavy topics say they are not served, and the socket carries on.
    send(
        &mut s,
        &json!({"track-mempool": true, "track-mempool-txids": true}),
    );
    assert_eq!(
        c.all(),
        [
            json!({"track-mempool-error": "not served by this server"}),
            json!({"track-mempool-txids-error": "not served by this server"}),
        ]
    );

    // Closing releases everything it held.
    send(
        &mut s,
        &json!({"track-tx": lower, "track-address": address(4)}),
    );
    assert_eq!(ctx.v1.followed(), 1);
    drop(s);
    assert_eq!(ctx.v1.followed(), 0);
    assert_eq!(ctx.track.tracked().0, 0);
}

#[tokio::test]
async fn every_part_a_transaction_two_addresses_and_a_drawing_fit_the_subscription_cap() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &c_conn);
    let all = ["blocks", "stats", "mempool-blocks", "live-2h-chart"];
    send(&mut s, &json!({"action": "want", "data": all}));
    send(&mut s, &json!({"track-tx": "ab".repeat(32)}));
    send(
        &mut s,
        &json!({"track-addresses": [address(5), address(6)]}),
    );
    send(&mut s, &json!({"track-mempool-block": 0}));
    let wanted = [
        Topic::V1Blocks,
        Topic::V1Stats,
        Topic::V1MempoolBlocks,
        Topic::V1LiveChart,
        Topic::V1ProjectedTxs(0),
    ]
    .map(|t| ctx.hub.subscribers(t));
    assert_eq!(wanted, [1, 1, 1, 1, 1]);
    assert_eq!((ctx.track.tracked(), ctx.v1.followed()), ((1, 2), 2));
    // Nothing refused; the default cap of 8 topics is unchanged.
    assert!(c.all().iter().all(|m| !m.to_string().contains("-error")));
    assert_eq!(limits().max_subscriptions, 8);
}

#[tokio::test]
async fn the_server_totals_are_said_in_the_reference_error_keys() {
    let ctx = context("127.0.0.1:1", true, |l| {
        l.tracked_txs_total = 1;
        l.tracked_addresses_total = 1;
    });
    let (mut a, mut b) = (Client::new(), Client::new());
    let a_conn = Arc::clone(&a.conn);
    let mut sa = Session::new(&ctx, &a_conn);
    let b_conn = Arc::clone(&b.conn);
    let mut sb = Session::new(&ctx, &b_conn);
    send(
        &mut sa,
        &json!({"track-tx": "ab".repeat(32), "track-address": address(1)}),
    );
    send(
        &mut sb,
        &json!({"track-tx": "cd".repeat(32), "track-address": address(2)}),
    );
    assert_eq!(a.all(), Vec::<Value>::new());
    assert_eq!(
        b.all(),
        [
            json!({"track-tx-error": "the server follows too many transactions; retry later"}),
            json!({"track-address-error": "the server follows too many addresses; retry later"}),
        ]
    );
    assert_eq!(ctx.v1.followed(), 1);
}

#[test]
fn transaction_messages_have_the_reference_shapes() {
    let txid: Txid = "ab".repeat(32).parse().unwrap();
    let by: Txid = "cd".repeat(32).parse().unwrap();
    let placed = |block| Placed {
        block,
        rate: 2000,
        vsize: 140,
        fee: 280,
        flags: 0,
    };
    // The position is inside the block: what is ahead of it there, not in the blocks before.
    let mempool = TxState::Mempool {
        time: 1,
        fee: 280,
        vsize: 140,
        position: Some(Position {
            placed: placed(2),
            ahead_vsize: 2_000_500,
            ahead_txs: 9,
        }),
    };
    let starts = [0, 999_000, 1_998_000, 2_997_000];
    assert_eq!(
        tx_message(&txid, &mempool, &starts),
        Some(
            json!({"txPosition": {"txid": txid.to_string(), "position": {"block": 2, "vsize": 2_500}}})
        )
    );
    let confirmed = TxState::Confirmed {
        height: 7,
        hash: BlockHash::from_byte_array([1; 32]),
    };
    assert_eq!(
        tx_message(&txid, &confirmed, &starts),
        Some(json!({"txConfirmed": txid.to_string()}))
    );
    let link = Link {
        txid,
        by,
        seen: 0,
        tx: crate::replacements::Facts::default(),
        by_tx: None,
        mined: crate::replacements::Mined::No,
    };
    assert_eq!(
        tx_message(&txid, &TxState::Replaced(vec![link], false), &starts),
        Some(json!({"txReplaced": {"txid": by.to_string()}}))
    );
    let unplaced = TxState::Mempool {
        time: 1,
        fee: 280,
        vsize: 140,
        position: None,
    };
    for quiet in [unplaced, TxState::Evicted, TxState::Unknown] {
        assert_eq!(tx_message(&txid, &quiet, &starts), None);
    }
}

#[tokio::test]
async fn a_tracked_transaction_through_acceptance_replacement_and_confirmation() {
    let mock = Mock::new();
    let server = Server::start(&mock, |_| {});
    let a = mock.send(&[coin(1)], 1, 2_000, 200);
    let behind = mock.send(&[coin(2)], 1, 500, 100);
    server.settle().await;
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(&server.ctx, &c_conn);

    // Waiting: its place in its block, the vsize mined before it there.
    send(&mut s, &json!({"track-tx": behind.to_string()}));
    assert_eq!(
        c.next("txPosition").await,
        json!({"txPosition": {"txid": behind.to_string(), "position": {"block": 0, "vsize": 200}}})
    );
    send(&mut s, &json!({"track-tx": a.to_string()}));
    assert_eq!(
        c.next("txPosition").await,
        json!({"txPosition": {"txid": a.to_string(), "position": {"block": 0, "vsize": 0}}})
    );
    // Replaced: by what.
    let b = mock.send(&[coin(1)], 1, 5_000, 200);
    server.settle().await;
    assert_eq!(
        c.next("txReplaced").await,
        json!({"txReplaced": {"txid": b.to_string()}})
    );
    // Following the replacement to its block.
    send(&mut s, &json!({"track-tx": b.to_string()}));
    c.next("txPosition").await;
    mock.mine(&[b]);
    server.settle().await;
    assert_eq!(
        c.next("txConfirmed").await,
        json!({"txConfirmed": b.to_string()})
    );
    // A socket arriving after the confirmation is told it.
    let mut late = Client::new();
    let late_conn = Arc::clone(&late.conn);
    let mut ls = Session::new(&server.ctx, &late_conn);
    send(&mut ls, &json!({"track-tx": b.to_string()}));
    assert_eq!(
        late.next("txConfirmed").await,
        json!({"txConfirmed": b.to_string()})
    );
}

/// An Esplora that serves one history page per script hash, and counts the reads.
#[derive(Clone, Default)]
struct History {
    pages: Arc<Mutex<HashMap<String, Value>>>,
    reads: Arc<AtomicUsize>,
    /// Milliseconds each read takes, as a slow node.
    delay: Arc<AtomicU64>,
    /// Reads the node is working on now, and the most at once.
    running: Arc<AtomicUsize>,
    most: Arc<AtomicUsize>,
    /// Pages are refused for size, as the node refuses a page that reads every create above
    /// its `--max-sh-creates`.
    refuse: Arc<std::sync::atomic::AtomicBool>,
}

impl History {
    async fn start(&self) -> String {
        async fn page(
            Path(sh): Path<String>,
            State(h): State<History>,
        ) -> axum::response::Response {
            h.reads.fetch_add(1, Ordering::Relaxed);
            let now = h.running.fetch_add(1, Ordering::Relaxed) + 1;
            h.most.fetch_max(now, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(h.delay.load(Ordering::Relaxed))).await;
            h.running.fetch_sub(1, Ordering::Relaxed);
            if h.refuse.load(Ordering::Relaxed) {
                return axum::response::IntoResponse::into_response((
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "scripthash join exceeds --max-sh-creates (52000 creates, cap 10000)",
                ));
            }
            let body = h
                .pages
                .lock()
                .unwrap()
                .get(&sh)
                .cloned()
                .unwrap_or(json!([]));
            axum::response::IntoResponse::into_response(body.to_string())
        }
        let app = axum::Router::new()
            .route("/scripthash/{sh}/txs", axum::routing::get(page))
            .with_state(self.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        url
    }

    fn set(&self, sh: ScriptHash, txs: &[Value]) {
        self.pages.lock().unwrap().insert(
            node::esplora::ScriptHash::from_electrum(sh).digest_hex(),
            json!(txs),
        );
    }

    async fn reads_reach(&self, n: usize) {
        let deadline = Instant::now() + WAIT;
        while self.reads.load(Ordering::Relaxed) < n {
            assert!(Instant::now() < deadline, "the history was never read");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

fn tx(n: u8, confirmed: bool) -> Value {
    json!({"txid": format!("{n:02x}").repeat(32), "fee": 141, "status": {"confirmed": confirmed}})
}

#[tokio::test]
async fn addresses_say_their_new_and_confirmed_transactions_once_for_every_socket() {
    let electrum = Electrum::start().await;
    let history = History::default();
    let url = history.start().await;
    let ctx = context_at(&electrum.addr, &url, false, |_| {});
    let tasks = [
        tokio::spawn(run(Arc::clone(&ctx))),
        tokio::spawn(track::follow_addresses(
            Arc::clone(&ctx.track),
            ctx.electrum.events(),
            ctx.electrum.health(),
        )),
    ];
    let (one, other) = (address(1), address(2));
    let sh = script_of(&one);
    history.set(sh, &[tx(1, true)]);

    let (mut a, mut b) = (Client::new(), Client::new());
    let a_conn = Arc::clone(&a.conn);
    let mut sa = Session::new(&ctx, &a_conn);
    let b_conn = Arc::clone(&b.conn);
    let mut sb = Session::new(&ctx, &b_conn);
    send(&mut sa, &json!({"track-address": one}));
    send(&mut sb, &json!({"track-addresses": [one, other]}));
    // One read each to know what is there already; nothing is said about it.
    history.reads_reach(2).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!((a.all(), b.all()), (vec![], vec![]));

    // A payment enters the mempool: the node's status changes.
    history.set(sh, &[tx(2, false), tx(1, true)]);
    electrum.notify(sh, &"aa".repeat(32));
    assert_eq!(
        a.next("address-transactions").await,
        json!({"address-transactions": [tx(2, false)]})
    );
    assert_eq!(
        b.next("multi-address-transactions").await,
        json!({"multi-address-transactions": {
            one.as_str(): {"mempool": [tx(2, false)], "confirmed": [], "removed": []}}})
    );
    // It confirms.
    history.set(sh, &[tx(2, true), tx(1, true)]);
    electrum.notify(sh, &"bb".repeat(32));
    assert_eq!(
        a.next("block-transactions").await,
        json!({"block-transactions": [tx(2, true)]})
    );
    assert_eq!(
        b.next("multi-address-transactions").await,
        json!({"multi-address-transactions": {
            one.as_str(): {"mempool": [], "confirmed": [tx(2, true)], "removed": []}}})
    );
    // Two sockets, three reads of the address: the baseline and one per change.
    history.reads_reach(4).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(history.reads.load(Ordering::Relaxed), 4);

    drop((sa, sb));
    assert_eq!(ctx.v1.followed(), 0);
    for t in tasks {
        t.abort();
    }
}

// Shapes against the reference, as recorded in `fixtures/websocket/reference.json`.

/// Checks that `ours` has the reference's shape: each of our keys is one of its keys with a value
/// of the same JSON type, and each of its keys we leave out, or send otherwise, is named in
/// `omitted` (as `path.key`). A reference `null` matches any type: it says nothing about the
/// type. Arrays are compared by their first element.
fn conforms(ours: &Value, reference: &Value, path: &str, omitted: &[&str], out: &mut Vec<String>) {
    if omitted.contains(&path) {
        return;
    }
    let kind = |v: &Value| match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };
    match (ours, reference) {
        (_, Value::Null) => {}
        (Value::Object(o), Value::Object(r)) => {
            for (k, v) in o {
                let at = format!("{path}.{k}");
                match r.get(k) {
                    Some(rv) => conforms(v, rv, &at, omitted, out),
                    None if omitted.contains(&at.as_str()) => {}
                    None => out.push(format!("{at}: not in the reference")),
                }
            }
            for k in r.keys() {
                let at = format!("{path}.{k}");
                if !o.contains_key(k) && !omitted.contains(&at.as_str()) {
                    out.push(format!("{at}: left out but not listed"));
                }
            }
        }
        (Value::Array(o), Value::Array(r)) => {
            if let (Some(o), Some(r)) = (o.first(), r.first()) {
                conforms(o, r, &format!("{path}[]"), omitted, out);
            }
        }
        (o, r) if kind(o) == kind(r) => {}
        (o, r) => out.push(format!(
            "{path}: {} where the reference has {}",
            kind(o),
            kind(r)
        )),
    }
}

fn reference() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/websocket/reference.json"
    ))
    .unwrap()
}

fn esplora_tx() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/esplora/mainnet/tx-segwit-opreturn.json"
    ))
    .unwrap()
}

/// What the reference sends that we do not, by message: each is listed in `docs/WS.md`.
const OMITTED: &[&str] = &[
    // Not node settings rbitcoin reports.
    ".mempoolInfo.permitbaremultisig",
    ".mempoolInfo.maxdatacarriersize",
    ".mempoolInfo.optimal",
    // rbitcoin's node reports it; the reference's node did not.
    ".mempoolInfo.fullrbf",
    // Block extras we do not compute yet: the same blocks as `GET /api/v1/blocks`.
    ".blocks[].extras.orphans",
    ".blocks[].extras.utxoSetChange",
    ".blocks[].extras.avgTxSize",
    ".blocks[].extras.totalInputs",
    ".blocks[].extras.totalOutputs",
    ".blocks[].extras.totalOutputAmt",
    ".blocks[].extras.segwitTotalTxs",
    ".blocks[].extras.segwitTotalSize",
    ".blocks[].extras.segwitTotalWeight",
    ".blocks[].extras.coinbaseBip54",
    ".blocks[].extras.similarity",
    ".block.extras.orphans",
    ".block.extras.utxoSetChange",
    ".block.extras.avgTxSize",
    ".block.extras.totalInputs",
    ".block.extras.totalOutputs",
    ".block.extras.totalOutputAmt",
    ".block.extras.segwitTotalTxs",
    ".block.extras.segwitTotalSize",
    ".block.extras.segwitTotalWeight",
    ".block.extras.coinbaseBip54",
    ".block.extras.similarity",
    // `null`, as on `GET /api/v1/blocks`: we keep no miner names.
    ".blocks[].extras.pool.minerNames",
    // CPFP details of a tracked transaction.
    ".txPosition.cpfp",
    // The reference's own fields on a transaction; ours is the node's Esplora JSON.
    ".block-transactions[].order",
    ".block-transactions[].vsize",
    ".block-transactions[].adjustedVsize",
    ".block-transactions[].feePerVsize",
    ".block-transactions[].adjustedFeePerVsize",
    ".block-transactions[].effectiveFeePerVsize",
    ".block-transactions[].firstSeen",
    ".block-transactions[].cpfpDirty",
    ".block-transactions[].clusterId",
    ".block-transactions[].chunkIndex",
    ".block-transactions[].cpfpChecked",
    // Esplora writes these only for some scripts (wrapped segwit, an output with an address):
    // the recorded transactions differ, not the format.
    ".block-transactions[].vin[].inner_redeemscript_asm",
    ".block-transactions[].vin[].inner_witnessscript_asm",
    ".block-transactions[].vout[].scriptpubkey_address",
];

/// What the reference's answer to `init` carries that ours leaves to the `want` parts' state, or
/// does not send at all (`rbfSummary`, which `rbfLatestSummary` brings, and `conversions`).
const INIT_OMITTED: &[&str] = &[
    ".mempoolInfo",
    ".vBytesPerSecond",
    ".mempool-blocks",
    ".transactions",
    ".fees",
    ".rbfSummary",
    ".conversions",
    ".blocks",
    // `null`, as `/api/v1/backend-info` serves them: private, or a node call.
    ".backendInfo.hostname",
    ".backendInfo.coreVersion",
    ".backendInfo.osVersion",
];

#[tokio::test]
async fn every_message_has_the_reference_shape() {
    let r = reference();
    let mock = Mock::new();
    let server = Server::start(&mock, |_| {});
    mock.send(&[coin(1)], 1, 2_000, 200);
    server.settle().await;
    let ctx = &server.ctx;

    // `stats`: the node's mempool info and the newest transactions from the engines, the fees and
    // the difficulty adjustment from the routes' own serializers.
    let id: Txid = "ab".repeat(32).parse().unwrap();
    latest(&ctx.v1, [(id, 1_794_480_209, 396, 110, 87_794)].into_iter());
    let sample = sample(engine::history::unix_now() / 60 * 60, 85_320);
    crate::statistics::sampled(&ctx.history.latest, &ctx.hub, &sample);
    let mut stats = stats(ctx).unwrap();
    let rates = engine::fees::Rates {
        levels: [2_533, 1_834, 1_293, 200],
        minimum: 100,
    };
    stats["fees"] = serde_json::to_value(api_v1::precise(&rates)).unwrap();
    let block = |height, time| engine::difficulty::Block {
        height,
        time,
        bits: bitcoin::CompactTarget::from_consensus(0x1702_6dcc),
    };
    let period = engine::difficulty::Period::new(
        &bitcoin::params::MAINNET,
        975_531,
        1_794_471_896,
        block(973_728, 1_793_301_298),
        Some(block(971_712, 1_792_000_000)),
    )
    .unwrap();
    let answer = crate::difficulty::Answer {
        period,
        tip: BlockHash::all_zeros(),
        computed: SystemTime::now(),
    };
    stats["da"] = serde_json::to_value(api_v1::difficulty(&answer, SystemTime::now())).unwrap();
    ctx.difficulty.set(answer);
    // A replacement for the feeds: one signalling transaction replaced by another.
    ctx.track
        .restore_replacements(vec![replaced(1, 9, 18, 558, true, Some(32))]);

    let blocks = crate::ws::fees::Blocks {
        blocks: Arc::new([crate::ws::fees::MempoolBlock {
            size: 1_604_991,
            vsize: 997_918,
            txs: 2_810,
            fees: 2_866_563,
            median: 2_032,
            range: vec![1_549, 1_896, 2_008, 2_841, 3_605, 4_997, 63_103],
        }]),
        tip: None,
        stale: false,
        at: SystemTime::now(),
    };
    let tx_state = TxState::Mempool {
        time: 1,
        fee: 1_085,
        vsize: 216,
        position: Some(Position {
            placed: Placed {
                block: 0,
                rate: 5_023,
                vsize: 216,
                fee: 1_085,
                flags: 0,
            },
            ahead_vsize: 1_078,
            ahead_txs: 3,
        }),
    };
    let confirmed = TxState::Confirmed {
        height: 1,
        hash: BlockHash::all_zeros(),
    };
    // A drawn block: its list, then a change with a transaction added, one removed and one whose
    // rate changed.
    let (tracker, projector) = ctx.track.engines().unwrap();
    let block = Arc::clone(&projector.current().blocks[0]);
    // NO_RBF and V2, so the rows' flags are seen to be the record's.
    let placed = |rate| Placed {
        block: 0,
        rate,
        vsize: 141,
        fee: 300,
        flags: 0x0a,
    };
    let (gone, added) = (
        Txid::from_byte_array([1; 32]),
        Txid::from_byte_array([2; 32]),
    );
    let mut old = ProjectedBlock::clone(&block);
    old.txs[0].1.rate = 1_000;
    old.txs.push((gone, placed(2_000)));
    let mut new = ProjectedBlock::clone(&block);
    new.txs.push((added, placed(2_000)));
    let drawn = whole(tracker, 0, 1, &block);
    let (delta, _) = changes(tracker, 0, 2, &old, &new).unwrap();
    let d = |path: &str| delta.pointer(&format!("/projected-block-transactions/delta/{path}"));
    assert_eq!(d("added/0/0"), Some(&json!(added)));
    assert_eq!(d("added/0/5"), Some(&json!(0x0a)));
    assert_eq!(d("changed/0/0"), Some(&json!(block.txs[0].0)));
    assert_eq!(d("changed/0/2"), Some(&json!(block.txs[0].1.flags)));
    // Flags that change alone, as context bits will, are a change too.
    let mut flagged = ProjectedBlock::clone(&block);
    flagged.txs[0].1.flags ^= 1 << 47;
    let (moved, _) = changes(tracker, 0, 3, &block, &flagged).unwrap();
    assert_eq!(
        moved["projected-block-transactions"]["delta"]["changed"],
        json!([[
            block.txs[0].0,
            f64::from(block.txs[0].1.rate) / 1000.0,
            flagged.txs[0].1.flags,
            0
        ]])
    );

    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(ctx, &c_conn);
    send(&mut s, &json!({"action": "ping"}));
    send(&mut s, &json!({"action": "init"}));
    let flood: Vec<String> = (0..3).map(|i| format!("x{i}")).collect();
    send(&mut s, &json!({"track-addresses": flood}));
    let replies = c.all();
    let mut feeds = Client::new();
    let feeds_conn = Arc::clone(&feeds.conn);
    let mut fs = Session::new(ctx, &feeds_conn);
    send(
        &mut fs,
        &json!({"track-rbf": "all", "track-rbf-summary": true}),
    );
    Feeds::default().step(ctx, true, Instant::now());
    let rbf = feeds.all();

    let ours = [
        ("pong", replies[0].clone()),
        ("init", replies[1].clone()),
        ("stats", stats),
        (
            "mempool-blocks",
            json!({"mempool-blocks": api_v1::mempool_blocks(&blocks)}),
        ),
        (
            "blocks",
            json!({"blocks": [crate::v1_blocks::tests::sample()]}),
        ),
        ("block", json!({"block": crate::v1_blocks::tests::sample()})),
        ("txPosition", tx_message(&id, &tx_state, &[0]).unwrap()),
        ("txConfirmed", tx_message(&id, &confirmed, &[0]).unwrap()),
        (
            "block-transactions",
            json!({"block-transactions": [esplora_tx()]}),
        ),
        ("track-addresses-error", replies[2].clone()),
        ("live-2h-chart", live_chart(&sample)),
        ("projected-block-transactions", drawn),
        ("projected-block-transactions:delta", delta),
        ("rbfLatest", rbf[0].clone()),
        ("rbfLatestSummary", rbf[1].clone()),
    ];
    let mut wrong = Vec::new();
    for (name, msg) in &ours {
        let omitted = if *name == "init" {
            INIT_OMITTED
        } else {
            OMITTED
        };
        conforms(msg, &r[name], "", omitted, &mut wrong);
    }
    assert_eq!(wrong, Vec::<String>::new());
    // A drawn transaction is an array, compared above by its first element only: its length too.
    let len = |m: &Value, path: &str| m.pointer(path).and_then(Value::as_array).map(Vec::len);
    for path in [
        "/projected-block-transactions/blockTransactions/0",
        "/projected-block-transactions/delta/added/0",
        "/projected-block-transactions/delta/changed/0",
    ] {
        let name = if path.contains("delta") {
            "projected-block-transactions:delta"
        } else {
            "projected-block-transactions"
        };
        let ours = ours.iter().find(|(n, _)| *n == name).unwrap();
        assert_eq!(len(&ours.1, path), len(&r[name], path), "{path}");
        assert!(len(&ours.1, path).is_some(), "{path}");
    }
    // Every recorded reference message is checked.
    let names: HashSet<&str> = ours.iter().map(|(n, _)| *n).collect();
    let recorded: HashSet<&str> = r
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .filter(|k| *k != "observed")
        .collect();
    assert_eq!(names, recorded);
}

/// A mempool history sample at minute `time` with `in_vsize` entering over the minute before.
fn sample(time: u64, in_vsize: u64) -> engine::history::Point {
    let mut sums = engine::history::Totals {
        count: 73_078,
        vsize: 33_945_214,
        fees: 5_597_327,
        min_fee: 100,
        ..Default::default()
    };
    sums.bands.stored[0] = 33_000_000;
    sums.bands.stored[4] = 900_000;
    sums.bands.stored[9] = 45_214;
    sums.flow.in_vsize = in_vsize;
    engine::history::Point {
        time,
        samples: 1,
        sums,
    }
}

/// The `live-2h-chart` message `sampled` sends for `p`, read off a subscriber.
fn live_chart(p: &engine::history::Point) -> Value {
    let ctx = context("127.0.0.1:1", false, |_| {});
    let mut c = Client::new();
    let conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &conn);
    send(
        &mut s,
        &json!({"action": "want", "data": ["live-2h-chart"]}),
    );
    crate::statistics::sampled(&ctx.history.latest, &ctx.hub, p);
    let mut all = c.all();
    assert_eq!(all.len(), 1);
    all.remove(0)
}

#[tokio::test]
async fn each_sample_is_the_statistics_point_sent_once_to_every_subscriber() {
    let dir = std::env::temp_dir().join(format!("rbitcoin-space-g1-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let ctx = crate::ws::track::tests::context_in(
        "127.0.0.1:1",
        "http://127.0.0.1:1",
        false,
        Some(dir.to_str().unwrap()),
        |_| {},
    );
    let (mut rxs, conns): (Vec<_>, Vec<_>) = (0..3)
        .map(|_| {
            let c = Client::new();
            (c.rx, c.conn)
        })
        .unzip();
    let mut sessions = Vec::new();
    for conn in &conns {
        let mut s = Session::new(&ctx, conn);
        send(
            &mut s,
            &json!({"action": "want", "data": ["live-2h-chart", "stats"]}),
        );
        sessions.push(s);
    }
    let mut other = Client::new();
    let other_conn = Arc::clone(&other.conn);
    let mut o = Session::new(&ctx, &other_conn);
    send(&mut o, &json!({"action": "want", "data": ["stats"]}));
    // Only what `live-2h-chart` sends: `stats` is published by `run`, which is not running.
    let chart_frames = |rxs: &mut Vec<mpsc::Receiver<Frame>>| {
        rxs.iter_mut()
            .map(|rx| std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>())
            .collect::<Vec<_>>()
    };

    // Before the first sample: no chart message on `want`, as on the reference, and no rate.
    assert!(chart_frames(&mut rxs).iter().all(Vec::is_empty));
    assert!(stats(&ctx).is_none_or(|s| s.get("vBytesPerSecond").is_none()));

    // A sample is stored and written: every subscriber gets the same frame, encoded once, and it
    // is the point the HTTP route now lists first.
    let now = engine::history::unix_now() / 60 * 60;
    let p = sample(now, 85_320);
    let store = &ctx.blocks.as_ref().unwrap().store;
    engine::history::record(store, p, now).await.unwrap();
    crate::statistics::sampled(&ctx.history.latest, &ctx.hub, &p);
    let got = chart_frames(&mut rxs);
    assert!(got.iter().all(|f| f.len() == 1), "one message each");
    let first = got[0][0].as_bytes();
    assert!(
        got.iter()
            .all(|f| f[0].as_bytes().as_ptr() == first.as_ptr())
    );
    let msg = decode(&got[0][0]);
    let res = crate::statistics::statistics(State(Arc::clone(&ctx)), Path("2h".to_owned())).await;
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    // Byte for byte the point the route lists, field order included: `[<point>]` with one row.
    let http = std::str::from_utf8(&body).unwrap();
    let frame = got[0][0].as_bytes();
    assert_eq!(
        std::str::from_utf8(&frame[frame.len() - (body.len() + 16)..]).unwrap(),
        format!(r#"{{"live-2h-chart":{}}}"#, &http[1..http.len() - 1])
    );
    assert_eq!(
        msg,
        json!({"live-2h-chart": {
            "added": now, "count": 73_078, "vbytes_per_second": 1_422,
            "mempool_byte_weight": 135_780_856, "total_fee": 5_597_327, "min_fee": 0.1,
            "vsizes": [33_000_000, 900_000, 0, 0, 0, 0, 0, 0, 45_214, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        }})
    );
    assert_eq!(other.all(), Vec::<Value>::new());

    // `vBytesPerSecond` is that minute's inflow, whole vbytes a second…
    assert_eq!(stats(&ctx).unwrap()["vBytesPerSecond"], json!(1_422));
    // …while the sample is at most two minutes old; then it is left out, not zeroed.
    let old = sample(now - 3 * 60, 85_320);
    crate::statistics::sampled(&ctx.history.latest, &ctx.hub, &old);
    assert!(stats(&ctx).is_none_or(|s| s.get("vBytesPerSecond").is_none()));
    drop((sessions, o));
    drop(ctx);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn without_a_data_directory_the_chart_is_wanted_but_never_comes() {
    // No store, so no sampler: `live-2h-chart` is accepted and silent, and `stats` has no rate.
    let mock = Mock::new();
    let server = Server::start(&mock, |_| {});
    mock.send(&[coin(1)], 1, 2_000, 200);
    server.settle().await;
    let ctx = &server.ctx;
    assert!(ctx.blocks.is_none());
    let mut c = Client::new();
    let conn = Arc::clone(&c.conn);
    let mut s = Session::new(ctx, &conn);
    send(
        &mut s,
        &json!({"action": "want", "data": ["live-2h-chart"]}),
    );
    assert_eq!(ctx.hub.subscribers(Topic::V1LiveChart), 1);
    let st = stats(ctx).unwrap();
    assert!(st.get("mempoolInfo").is_some());
    assert!(st.get("vBytesPerSecond").is_none());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(c.all(), Vec::<Value>::new());
}

#[tokio::test]
async fn following_and_stopping_fast_leaves_no_reads_waiting_on_the_node() {
    let history = History::default();
    history.delay.store(500, Ordering::Relaxed);
    let url = history.start().await;
    let ctx = context_at("127.0.0.1:1", &url, false, |l| {
        l.tracked_addresses_total = 100
    });
    let c = Client::new();
    let mut s = Session::new(&ctx, &c.conn);
    // Forty addresses followed and dropped while the node takes half a second a read, each
    // given time to reach the node: the reads already sent keep their turn until the node
    // answers, so it never works on more than two at once, and those waiting are never sent.
    for n in 1..=40 {
        send(&mut s, &json!({"track-address": address(n)}));
        tokio::time::sleep(Duration::from_millis(20)).await;
        send(&mut s, &json!({"track-address": "stop"}));
    }
    assert_eq!(ctx.v1.followed(), 0);
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let reads = history.reads.load(Ordering::Relaxed);
    assert!(reads <= 4, "{reads} reads reached the node");
    assert!(history.most.load(Ordering::Relaxed) <= 2);
    assert_eq!(history.running.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn an_address_history_the_node_will_not_finish_is_not_read_again() {
    let history = History::default();
    history.delay.store(300, Ordering::Relaxed);
    let url = history.start().await;
    let ctx = context_with("127.0.0.1:1", &url, false, None, |c| {
        c.limits.history_timeout = Duration::from_millis(100);
    });
    let c = Client::new();
    let mut s = Session::new(&ctx, &c.conn);
    // The first read runs past the history deadline, as on an address too large to serve.
    send(&mut s, &json!({"track-address": address(1)}));
    history.reads_reach(1).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    send(&mut s, &json!({"track-address": "stop"}));
    // Followed again, by this socket or another: the node is not asked again.
    send(&mut s, &json!({"track-address": address(1)}));
    // An address the HTTP routes learned is too large is never asked at all.
    let sh = node::esplora::ScriptHash::from_electrum(script_of(&address(2)));
    ctx.api
        .verdicts
        .learn(sh, None, Verdict::TooLarge(None), std::time::Instant::now());
    send(&mut s, &json!({"track-addresses": [address(2)]}));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(history.reads.load(Ordering::Relaxed), 1);
    assert_eq!(ctx.v1.followed(), 2);
}

/// A page the node refuses for size teaches the size, as on the HTTP routes: the address is not
/// read again, and the size is known.
#[tokio::test]
async fn an_address_page_refused_for_size_is_remembered() {
    let history = History::default();
    history.refuse.store(true, Ordering::Relaxed);
    let url = history.start().await;
    let ctx = context_with("127.0.0.1:1", &url, false, None, |_| {});
    let c = Client::new();
    let mut s = Session::new(&ctx, &c.conn);
    send(&mut s, &json!({"track-address": address(3)}));
    history.reads_reach(1).await;
    let sh = node::esplora::ScriptHash::from_electrum(script_of(&address(3)));
    let deadline = Instant::now() + WAIT;
    while ctx
        .api
        .verdicts
        .size(sh, std::time::Instant::now())
        .is_none()
    {
        assert!(Instant::now() < deadline, "the refusal was not remembered");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        ctx.api.verdicts.size(sh, std::time::Instant::now()),
        Some(node::esplora::ScriptSize {
            creates: 52_000,
            cap: 10_000
        })
    );
    send(&mut s, &json!({"track-address": "stop"}));
    send(&mut s, &json!({"track-address": address(3)}));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(history.reads.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn table_blocks_go_out_once_each_in_order_and_a_reorg_sends_the_list() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    let blk = |h: u32, fork: &str| json!({"id": format!("{fork}{h}"), "height": h, "extras": {}});
    let list = |hs: std::ops::RangeInclusive<u32>, fork: &str| -> Vec<Value> {
        hs.map(|h| blk(h, fork)).collect()
    };
    let want = json!({"action": "want", "data": ["blocks"]});
    from_table(&ctx, list(1..=8, "a"));
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut cs = Session::new(&ctx, &c_conn);
    send(&mut cs, &want);
    assert_eq!(c.all(), [json!({"blocks": list(1..=8, "a")})]);

    // Two rows written at once: each block once, oldest first.
    from_table(&ctx, list(3..=10, "a"));
    assert_eq!(
        c.all(),
        [
            json!({"block": blk(9, "a")}),
            json!({"block": blk(10, "a")})
        ]
    );
    // The same blocks again, the tip rated since: nothing is sent, a new socket gets the rates.
    let mut rated = list(3..=10, "a");
    rated[7]["extras"]["medianFee"] = json!(1.5);
    from_table(&ctx, rated.clone());
    assert_eq!(c.all(), Vec::<Value>::new());
    let mut d = Client::new();
    let d_conn = Arc::clone(&d.conn);
    let mut ds = Session::new(&ctx, &d_conn);
    send(&mut ds, &want);
    assert_eq!(d.all(), [json!({"blocks": rated})]);

    // The last two replaced: the list goes out whole, never a block of the old branch again.
    let mut fork = list(3..=8, "a");
    fork.extend(list(9..=10, "b"));
    from_table(&ctx, fork.clone());
    assert_eq!(c.all(), [json!({"blocks": fork.clone()})]);
    // An empty table changes nothing.
    from_table(&ctx, Vec::new());
    assert_eq!(c.all(), Vec::<Value>::new());
    assert_eq!(lock(&ctx.v1.blocks).back(), fork.last());
}

// Drawings: `track-mempool-block`.

const DRAWING: &str = "projected-block-transactions";

/// A client's copy of one drawn block, built only from the messages, as the reference's frontend
/// would: txid to `[fee, vsize, rate, flags]`. Every message must be one `sequence` above the last.
#[derive(Default, Debug, PartialEq)]
struct Drawn {
    sequence: Option<u64>,
    txs: HashMap<String, Value>,
    /// The last message was the whole list.
    whole: bool,
}

impl Drawn {
    fn apply(&mut self, msg: &Value) {
        let m = &msg[DRAWING];
        let sequence = m["sequence"].as_u64().unwrap();
        if let Some(prev) = self.sequence {
            assert_eq!(sequence, prev + 1, "{msg}");
        }
        self.whole = m.get("blockTransactions").is_some();
        if let Some(rows) = m.get("blockTransactions") {
            self.txs = rows
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    (
                        r[0].as_str().unwrap().to_owned(),
                        json!([r[1], r[2], r[4], r[5]]),
                    )
                })
                .collect();
        } else {
            assert!(self.sequence.is_some(), "a change before the list: {msg}");
            let d = &m["delta"];
            for t in d["removed"].as_array().unwrap() {
                assert!(self.txs.remove(t.as_str().unwrap()).is_some(), "{msg}");
            }
            for r in d["added"].as_array().unwrap() {
                let old = self.txs.insert(
                    r[0].as_str().unwrap().to_owned(),
                    json!([r[1], r[2], r[4], r[5]]),
                );
                assert!(old.is_none(), "{msg}");
            }
            for c in d["changed"].as_array().unwrap() {
                let t = self.txs.get_mut(c[0].as_str().unwrap()).unwrap();
                (t[2], t[3]) = (c[1].clone(), c[2].clone());
                assert_eq!(c[3], json!(0));
            }
        }
        self.sequence = Some(sequence);
    }

    /// Applies every drawing message the client has; returns how many.
    fn follow(&mut self, c: &mut Client) -> usize {
        let all: Vec<Value> = c
            .all()
            .into_iter()
            .filter(|m| m.get(DRAWING).is_some())
            .collect();
        for m in &all {
            self.apply(m);
        }
        all.len()
    }
}

/// Projected block `i` now, as a [`Drawn`] holds it.
fn projected_block(server: &Server, i: usize) -> HashMap<String, Value> {
    server
        .projector
        .current()
        .blocks
        .get(i)
        .map_or_else(HashMap::new, |b| {
            b.txs
                .iter()
                .map(|(t, p)| {
                    (
                        t.to_string(),
                        json!([p.fee, p.vsize, f64::from(p.rate) / 1000.0, p.flags]),
                    )
                })
                .collect()
        })
}

/// Waits until the client's copy is exactly projected block `i`.
async fn until_drawn(c: &mut Client, d: &mut Drawn, server: &Server, i: usize) {
    let deadline = Instant::now() + WAIT;
    loop {
        d.follow(c);
        if d.sequence.is_some() && d.txs == projected_block(server, i) {
            return;
        }
        assert!(Instant::now() < deadline, "never drawn: {d:?}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_drawn_block_is_its_list_then_its_changes_each_one_sequence_higher() {
    let mock = Mock::new();
    let server = Server::start(&mock, |_| {});
    let a = mock.send(&[coin(1)], 2, 2_000, 200);
    let b = mock.send(&[coin(2)], 1, 500, 100);
    server.settle().await;
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(&server.ctx, &c_conn);
    send(&mut s, &json!({"track-mempool-block": 0}));

    // The whole list, in the reference's rows: txid, fee, vsize, value, rate, flags, first seen.
    let first = c.next(DRAWING).await;
    let rows = first[DRAWING]["blockTransactions"].as_array().unwrap();
    let (tracker, _) = server.ctx.track.engines().unwrap();
    let info = tracker.read(|m| m.get(&a).cloned()).unwrap();
    assert_eq!(info.flags, engine::flags::NO_RBF | engine::flags::V2);
    assert_eq!(first[DRAWING]["index"], json!(0));
    assert_eq!(
        rows[0],
        json!([
            a,
            2_000,
            200,
            info.value.to_sat(),
            10.0,
            info.flags,
            mock.get(a).time
        ])
    );
    assert_eq!(rows[1][0], json!(b.to_string()));
    let mut d = Drawn::default();
    d.apply(&first);
    until_drawn(&mut c, &mut d, &server, 0).await;

    // Added, then changed (a child pays for `b`), then removed (mined): each a change, one
    // sequence higher, and the copy is the block each time.
    mock.send(&[coin(3)], 1, 3_000, 150);
    server.settle().await;
    until_drawn(&mut c, &mut d, &server, 0).await;
    let child = mock.send(&[bitcoin::OutPoint::new(b, 0)], 1, 10_000, 100);
    mock.join(&[&[b, child]]);
    server.settle().await;
    until_drawn(&mut c, &mut d, &server, 0).await;
    assert_eq!(d.txs[&b.to_string()][2], json!(52.5));
    // Many small changes, each its own message.
    for n in 10..40 {
        mock.send(&[coin(n)], 1, 1_000, 100);
        server.settle().await;
        until_drawn(&mut c, &mut d, &server, 0).await;
    }

    // A socket that joins late gets the list and at most 16 changes since, and from then on the
    // same messages: its sequence rises by one too, and its copy is the same.
    let mut late = Client::new();
    let late_conn = Arc::clone(&late.conn);
    let mut ls = Session::new(&server.ctx, &late_conn);
    send(&mut ls, &json!({"track-mempool-block": 0}));
    let mut ld = Drawn::default();
    ld.apply(&late.next(DRAWING).await);
    assert!(ld.follow(&mut late) <= MAX_APPENDED);
    until_drawn(&mut late, &mut ld, &server, 0).await;
    mock.mine(&[a]);
    server.settle().await;
    until_drawn(&mut c, &mut d, &server, 0).await;
    until_drawn(&mut late, &mut ld, &server, 0).await;
    assert!(!d.txs.contains_key(&a.to_string()));
    assert!(!d.whole);
    // A block that takes most of it: the whole list again, still one sequence higher.
    let most: Vec<Txid> = server.projector.current().blocks[0].txs[1..]
        .iter()
        .map(|(t, _)| *t)
        .collect();
    mock.mine(&most);
    server.settle().await;
    until_drawn(&mut c, &mut d, &server, 0).await;
    until_drawn(&mut late, &mut ld, &server, 0).await;
    assert!(d.whole);
    assert_eq!(ld, d);
}

#[tokio::test]
async fn a_new_block_replaces_the_last_and_a_negative_index_stops_it() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &c_conn);
    let drawing = |i| ctx.hub.subscribers(Topic::V1ProjectedTxs(i));
    send(&mut s, &json!({"track-mempool-block": 0}));
    send(&mut s, &json!({"track-mempool-block": 3}));
    assert_eq!((drawing(0), drawing(3)), (0, 1));
    // Not a number: nothing, and the block stays.
    for quiet in [json!("1"), json!(1.5), json!(null), json!([1])] {
        send(&mut s, &json!({ "track-mempool-block": quiet }));
    }
    assert_eq!(drawing(3), 1);
    assert_eq!(c.all(), Vec::<Value>::new());
    send(&mut s, &json!({"track-mempool-block": -1}));
    assert_eq!(drawing(3), 0);
    // A block without a topic: the last, which holds the rest of the mempool, and beyond.
    send(&mut s, &json!({"track-mempool-block": 2}));
    for n in [7, 8, 255, 256, i64::MAX] {
        send(&mut s, &json!({"track-mempool-block": n}));
    }
    assert_eq!(drawing(2), 0);
    let error = json!({"track-mempool-block-error": "projected blocks 0 to 6 are served"});
    assert_eq!(c.all(), vec![error; 5]);
}

#[tokio::test]
async fn asking_again_for_the_block_drawn_sends_its_frames_again_at_most_once_an_interval() {
    let mock = Mock::new();
    let server = Server::start(&mock, |_| {});
    mock.send(&[coin(1)], 1, 2_000, 200);
    server.settle().await;
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(&server.ctx, &c_conn);
    send(&mut s, &json!({"track-mempool-block": 0}));
    let first = tokio::time::timeout(WAIT, c.rx.recv())
        .await
        .unwrap()
        .unwrap();
    // The reference's frontend, lost: thousands of the same request. None is answered within
    // the interval, and after it one is, with the frames already encoded: the same bytes.
    let l = WsLimits {
        mempool_interval: Duration::from_millis(500),
        ..limits()
    };
    let ask = r#"{"track-mempool-block":0}"#;
    for _ in 0..10_000 {
        assert_eq!(s.handle(ask, &l), Ok(()));
    }
    assert!(c.rx.try_recv().is_err());
    tokio::time::sleep(Duration::from_millis(500)).await;
    for _ in 0..10_000 {
        assert_eq!(s.handle(ask, &l), Ok(()));
    }
    let again: Vec<Frame> = std::iter::from_fn(|| c.rx.try_recv().ok()).collect();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].as_bytes().as_ptr(), first.as_bytes().as_ptr());
}

#[tokio::test]
async fn nothing_is_encoded_for_a_block_nobody_draws() {
    let mock = Mock::new();
    let server = Server::start(&mock, |_| {});
    mock.send(&[coin(1)], 1, 2_000, 200);
    server.settle().await;
    // What the topic stores, read by a socket that joins the hub directly and leaves at once.
    let stored = || {
        let (tx, mut rx) = mpsc::channel(64);
        let conn = Arc::new(Conn::test(4_000_000, tx));
        server.ctx.hub.subscribe(Topic::V1ProjectedTxs(0), &conn);
        server
            .ctx
            .hub
            .unsubscribe(Topic::V1ProjectedTxs(0), conn.id);
        std::iter::from_fn(|| rx.try_recv().ok()).count()
    };
    assert_eq!(stored(), 0);
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(&server.ctx, &c_conn);
    send(&mut s, &json!({"track-mempool-block": 0}));
    c.next(DRAWING).await;
    assert_eq!(stored(), 1);
    // Stopped: the next projection forgets it, and changes are not encoded.
    send(&mut s, &json!({"track-mempool-block": -1}));
    mock.send(&[coin(2)], 1, 2_000, 200);
    server.settle().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(stored(), 0);
    assert_eq!(c.all(), Vec::<Value>::new());
}

#[tokio::test]
async fn a_drawing_on_another_block_than_the_last_one_sent_waits_for_it() {
    let mock = Mock::new();
    let server = Server::start(&mock, |_| {});
    mock.send(&[coin(1)], 1, 2_000, 200);
    server.settle().await;
    let ctx = &server.ctx;
    // The last `block` sent is not the one the projection is on.
    let other = BlockHash::from_byte_array([7; 32]);
    from_table(ctx, vec![json!({"id": other, "height": 1})]);
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(ctx, &c_conn);
    send(&mut s, &json!({"track-mempool-block": 0}));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.all(), Vec::<Value>::new());
    // Its `block` goes out: the drawing follows it at once.
    let tip = mock.tip().hash;
    from_table(ctx, vec![json!({"id": tip, "height": 2})]);
    tokio::time::timeout(Duration::from_millis(500), c.next(DRAWING))
        .await
        .unwrap();
}

/// A replacement: transaction `n` (weight `weight`, paying `fee`, signalling when `rbf`) replaced
/// by transaction `by`, which pays `by_fee` and weighs 651.
fn replaced(n: u8, by: u8, fee: u64, weight: u32, rbf: bool, by_fee: Option<u64>) -> Link {
    let facts = |fee, weight: u32, rbf| crate::replacements::Facts {
        fee,
        vsize: weight.div_ceil(4),
        weight,
        value: 42_000,
        time: 1_794_761_565 + u32::from(n),
        rbf,
    };
    Link {
        txid: Txid::from_byte_array([n; 32]),
        by: Txid::from_byte_array([by; 32]),
        seen: 1_794_761_598 + u64::from(n),
        tx: facts(fee, weight, rbf),
        by_tx: by_fee.map(|f| facts(f, 651, true)),
        mined: crate::replacements::Mined::No,
    }
}

/// The frame's payload as sent, byte for byte.
fn payload(f: &Frame) -> Vec<u8> {
    let b = f.as_bytes();
    let at = match b[1] & 0x7F {
        126 => 4,
        127 => 10,
        _ => 2,
    };
    b[at..].to_vec()
}

#[tokio::test]
async fn the_replacement_feeds_send_what_the_routes_serve_then_each_change() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    // 1 replaced by 9, signalling; 2 and 3 both replaced by 8, and 3 did not signal (full RBF).
    ctx.track.restore_replacements(vec![
        replaced(1, 9, 18, 558, true, Some(32)),
        replaced(2, 8, 152, 6_019, false, Some(180)),
        replaced(3, 8, 330, 305, true, Some(180)),
    ]);
    let (mut all, mut full) = (Client::new(), Client::new());
    let (all_conn, full_conn) = (Arc::clone(&all.conn), Arc::clone(&full.conn));
    let (mut a, mut f) = (
        Session::new(&ctx, &all_conn),
        Session::new(&ctx, &full_conn),
    );
    send(
        &mut a,
        &json!({"track-rbf": "all", "track-rbf-summary": true}),
    );
    send(&mut f, &json!({"track-rbf": "fullRbf"}));
    // Nothing is encoded before a socket asks, so there is no list stored yet: the producer sends.
    assert!(all.all().is_empty() && full.all().is_empty());
    let mut feeds = Feeds::default();
    feeds.step(&ctx, false, Instant::now());

    // `rbfLatest` is the routes' body, byte for byte, in one more key.
    let body = |full_rbf| ctx.track.with_replacements(|r| ctx.trees.get(r, full_rbf));
    let framed = |b: &[u8]| [br#"{"rbfLatest":"#.as_slice(), b, b"}"].concat();
    let mut got = Vec::new();
    while let Ok(m) = all.rx.try_recv() {
        got.push(m);
    }
    assert_eq!(got.len(), 2);
    assert_eq!(payload(&got[0]), framed(&body(false)));
    let trees: Value = serde_json::from_slice(&body(false)).unwrap();
    assert_eq!(trees.as_array().unwrap().len(), 2);
    // The full-RBF feed holds only the tree where something did not signal.
    let only = full.rx.try_recv().unwrap();
    assert_eq!(payload(&only), framed(&body(true)));
    let full_trees: Value = serde_json::from_slice(&body(true)).unwrap();
    assert_eq!(full_trees.as_array().unwrap().len(), 1);
    assert_eq!(full_trees[0]["tx"]["txid"], "08".repeat(32));

    // The summary: the newest of each tree, what it directly replaced summed, as the reference,
    // in its field order.
    let order = br#"{"rbfLatestSummary":[{"txid":"0808"#;
    assert!(payload(&got[1]).starts_with(order));
    assert_eq!(
        decode(&got[1]),
        json!({"rbfLatestSummary": [
            {"txid": "08".repeat(32), "mined": false, "fullRbf": true,
             "oldFee": 482, "oldVsize": 1_581, "newFee": 180, "newVsize": 162.75},
            {"txid": "09".repeat(32), "mined": false, "fullRbf": false,
             "oldFee": 18, "oldVsize": 139.5, "newFee": 32, "newVsize": 162.75},
        ]})
    );

    // Nothing again until the record changes; then the whole lists again, on the tick.
    feeds.step(&ctx, true, Instant::now());
    assert!(all.all().is_empty() && full.all().is_empty());
    ctx.track
        .restore_replacements(vec![replaced(4, 7, 100, 400, true, Some(200))]);
    feeds.step(&ctx, true, Instant::now());
    let again = all.all();
    assert_eq!(again.len(), 2);
    assert_eq!(again[0]["rbfLatest"].as_array().unwrap().len(), 3);
    assert_eq!(again[1]["rbfLatestSummary"][0]["txid"], "07".repeat(32));
    // The full-RBF list did not change, but the record did: sent again, as the reference does.
    assert_eq!(full.all().len(), 1);

    // A socket arriving now gets the stored lists at once, without the producer.
    let mut late = Client::new();
    let late_conn = Arc::clone(&late.conn);
    let mut l = Session::new(&ctx, &late_conn);
    send(&mut l, &json!({"track-rbf": "all"}));
    assert_eq!(late.all(), vec![again[0].clone()]);
}

#[tokio::test]
async fn a_feed_stops_and_switches_as_the_reference_frontend_asks() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    ctx.track
        .restore_replacements(vec![replaced(1, 9, 18, 558, true, Some(32))]);
    let mut c = Client::new();
    let conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &conn);
    let mut feeds = Feeds::default();
    let mut t = Instant::now();
    let mut change = |n: u8, feeds: &mut Feeds| {
        ctx.track
            .restore_replacements(vec![replaced(n, n + 100, 10, 400, true, Some(20))]);
        // Past the interval, so a socket starting a feed is answered without the tick.
        t += Duration::from_secs(3);
        feeds.step(&ctx, true, t);
    };
    // What the frontend sends leaving `/rbf` ("stop") and the home page (`false`), and anything
    // else that is not a feed's name.
    for (start, stop) in [
        (json!({"track-rbf": "all"}), json!({"track-rbf": "stop"})),
        (json!({"track-rbf": "fullRbf"}), json!({"track-rbf": false})),
        (
            json!({"track-rbf-summary": true}),
            json!({"track-rbf-summary": false}),
        ),
        (
            json!({"track-rbf-summary": true}),
            json!({"track-rbf-summary": "stop"}),
        ),
    ] {
        send(&mut s, &start);
        change(2, &mut feeds);
        assert_eq!(c.all().len(), 1, "{start}");
        send(&mut s, &stop);
        change(3, &mut feeds);
        assert!(c.all().is_empty(), "{stop}");
        for t in FEEDS {
            assert_eq!(ctx.hub.subscribers(t), 0);
        }
    }
    // Nobody follows: the stored lists are gone and nothing is encoded for nobody.
    let version = feeds.version;
    change(4, &mut feeds);
    assert_eq!(version, [None; 3]);
    assert_eq!(feeds.version, [None; 3]);
    // Switching from all to full RBF leaves the first feed.
    send(&mut s, &json!({"track-rbf": "all"}));
    send(&mut s, &json!({"track-rbf": "fullRbf"}));
    assert_eq!(ctx.hub.subscribers(Topic::V1Rbf(false)), 0);
    assert_eq!(ctx.hub.subscribers(Topic::V1Rbf(true)), 1);
}

#[tokio::test]
async fn a_flood_of_feed_requests_sends_the_list_at_most_once_an_interval() {
    let interval = Duration::from_millis(200);
    let ctx = context("127.0.0.1:1", true, |l| l.mempool_interval = interval);
    ctx.track
        .restore_replacements(vec![replaced(1, 9, 18, 558, true, Some(32))]);
    let l = WsLimits {
        mempool_interval: interval,
        ..limits()
    };
    let mut c = Client::new();
    let conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &conn);
    let mut feeds = Feeds::default();
    let start = Instant::now();
    s.handle(r#"{"track-rbf":"all"}"#, &l).unwrap();
    feeds.step(&ctx, false, start);
    assert_eq!(c.all().len(), 1);
    // The same request again and again: the stored list at most once an interval, by reference.
    for _ in 0..1_000 {
        s.handle(r#"{"track-rbf":"all"}"#, &l).unwrap();
    }
    assert!(c.all().is_empty());
    tokio::time::sleep(l.mempool_interval).await;
    for _ in 0..1_000 {
        s.handle(r#"{"track-rbf":"all"}"#, &l).unwrap();
    }
    assert_eq!(c.all().len(), 1);
    // The producer: a socket starting a feed between ticks sends nothing more within an interval
    // of the last list; the tick does.
    ctx.track
        .restore_replacements(vec![replaced(2, 8, 18, 558, true, Some(32))]);
    feeds.step(&ctx, false, start + Duration::from_millis(100));
    assert!(c.all().is_empty());
    feeds.step(&ctx, true, start + Duration::from_millis(100));
    assert_eq!(c.all().len(), 1);
}

#[tokio::test]
async fn init_carries_the_difficulty_figures_once_the_server_has_them() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    let mut c = Client::new();
    let conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &conn);
    send(&mut s, &json!({"action": "init"}));
    let init = c.all().remove(0);
    assert_eq!(init.get("da"), None);
    assert_eq!(init["backend"], "esplora");

    let block = |height, time| engine::difficulty::Block {
        height,
        time,
        bits: bitcoin::CompactTarget::from_consensus(0x1702_6dcc),
    };
    let period = engine::difficulty::Period::new(
        &bitcoin::params::MAINNET,
        975_531,
        1_794_471_896,
        block(973_728, 1_793_301_298),
        Some(block(971_712, 1_792_000_000)),
    )
    .unwrap();
    ctx.difficulty.set(crate::difficulty::Answer {
        period,
        tip: BlockHash::all_zeros(),
        computed: SystemTime::now(),
    });
    send(&mut s, &json!({"action": "init"}));
    let init = c.all().remove(0);
    // The `stats` part's `da`, from the same figures.
    let stats = stats(&ctx).unwrap();
    assert_eq!(init["da"]["nextRetargetHeight"], 975_744);
    assert_eq!(
        init["da"].as_object().unwrap().keys().collect::<Vec<_>>(),
        stats["da"].as_object().unwrap().keys().collect::<Vec<_>>()
    );
    // The fields that do not move with the clock.
    for k in [
        "nextRetargetHeight",
        "remainingBlocks",
        "previousRetarget",
        "previousTime",
    ] {
        assert_eq!(init["da"][k], stats["da"][k], "{k}");
    }
}

#[tokio::test]
async fn the_summary_sums_everything_replaced_beyond_the_trees_bound() {
    let ctx = context("127.0.0.1:1", true, |_| {});
    // One transaction replacing 120 at once: more than a tree holds (`MAX_TREE`, 100).
    let links: Vec<Link> = (1..=120)
        .map(|n| replaced(n, 200, 10, 400, true, Some(5_000)))
        .collect();
    ctx.track.restore_replacements(links);
    let mut c = Client::new();
    let conn = Arc::clone(&c.conn);
    let mut s = Session::new(&ctx, &conn);
    send(&mut s, &json!({"track-rbf-summary": true}));
    Feeds::default().step(&ctx, true, Instant::now());
    let summary = c.all().remove(0);
    assert_eq!(summary["rbfLatestSummary"][0]["oldFee"], 1_200);
    assert_eq!(summary["rbfLatestSummary"][0]["oldVsize"], 12_000);
}
