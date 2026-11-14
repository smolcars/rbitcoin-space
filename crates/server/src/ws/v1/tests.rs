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
use engine::projected::{Placed, Position};
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
        json!({"action": "init"}),
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
async fn every_part_a_transaction_and_two_addresses_fit_the_subscription_cap() {
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
    let wanted = [
        Topic::V1Blocks,
        Topic::V1Stats,
        Topic::V1MempoolBlocks,
        Topic::V1LiveChart,
    ]
    .map(|t| ctx.hub.subscribers(t));
    assert_eq!(wanted, [1, 1, 1, 1]);
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
        self.pages
            .lock()
            .unwrap()
            .insert(sh.to_string(), json!(txs));
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
/// of the same JSON type, and each of its keys we leave out is named in `omitted` (as
/// `path.key`). A reference `null` matches any type: it says nothing about the type. Arrays are
/// compared by their first element.
fn conforms(ours: &Value, reference: &Value, path: &str, omitted: &[&str], out: &mut Vec<String>) {
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

fn esplora(name: &str) -> Value {
    let text = match name {
        "block" => include_str!("../../../../../fixtures/esplora/mainnet/block.json"),
        _ => include_str!("../../../../../fixtures/esplora/mainnet/tx-segwit-opreturn.json"),
    };
    serde_json::from_str(text).unwrap()
}

/// What the reference sends that we do not, by message: each is listed in `docs/WS.md`.
const OMITTED: &[&str] = &[
    // Not node settings rbitcoin reports.
    ".mempoolInfo.permitbaremultisig",
    ".mempoolInfo.maxdatacarriersize",
    ".mempoolInfo.optimal",
    // rbitcoin's node reports it; the reference's node did not.
    ".mempoolInfo.fullrbf",
    // The block is the node's Esplora JSON: no extras, and only best-chain blocks are sent.
    ".blocks[].stale",
    ".blocks[].extras",
    ".block.stale",
    ".block.extras",
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
            },
            ahead_vsize: 1_078,
            ahead_txs: 3,
        }),
    };
    let confirmed = TxState::Confirmed {
        height: 1,
        hash: BlockHash::all_zeros(),
    };
    let mut c = Client::new();
    let c_conn = Arc::clone(&c.conn);
    let mut s = Session::new(ctx, &c_conn);
    send(&mut s, &json!({"action": "ping"}));
    let flood: Vec<String> = (0..3).map(|i| format!("x{i}")).collect();
    send(&mut s, &json!({"track-addresses": flood}));
    let replies = c.all();

    let ours = [
        ("pong", replies[0].clone()),
        ("stats", stats),
        (
            "mempool-blocks",
            json!({"mempool-blocks": api_v1::mempool_blocks(&blocks)}),
        ),
        ("blocks", json!({"blocks": [esplora("block")]})),
        ("block", json!({"block": esplora("block")})),
        ("txPosition", tx_message(&id, &tx_state, &[0]).unwrap()),
        ("txConfirmed", tx_message(&id, &confirmed, &[0]).unwrap()),
        (
            "block-transactions",
            json!({"block-transactions": [esplora("tx")]}),
        ),
        ("track-addresses-error", replies[1].clone()),
        ("live-2h-chart", live_chart(&sample)),
    ];
    let mut wrong = Vec::new();
    for (name, msg) in &ours {
        conforms(msg, &r[name], "", OMITTED, &mut wrong);
    }
    assert_eq!(wrong, Vec::<String>::new());
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
    let sh = script_of(&address(2)).to_string().parse().unwrap();
    ctx.api
        .verdicts
        .learn(sh, None, Verdict::TooLarge(None), std::time::Instant::now());
    send(&mut s, &json!({"track-addresses": [address(2)]}));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(history.reads.load(Ordering::Relaxed), 1);
    assert_eq!(ctx.v1.followed(), 2);
}
