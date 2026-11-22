#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use super::*;
use bitcoin::block::Version;
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::{CompactTarget, TxMerkleNode, Txid};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpListener;
use tokio::net::tcp::OwnedReadHalf;
use tokio::sync::broadcast::error::RecvError;

const WAIT: Duration = Duration::from_secs(5);

struct Mock {
    listener: TcpListener,
}

impl Mock {
    async fn start() -> (Mock, Config) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = Config::new(listener.local_addr().unwrap().to_string());
        config.request_timeout = Duration::from_secs(2);
        config.ping_interval = Duration::from_secs(600);
        config.max_reconnect_delay = Duration::from_millis(200);
        (Mock { listener }, config)
    }

    async fn accept(&self) -> Peer {
        let (stream, _) = timeout(WAIT, self.listener.accept())
            .await
            .unwrap()
            .unwrap();
        let (rd, wr) = stream.into_split();
        Peer {
            lines: BufReader::new(rd).lines(),
            wr,
        }
    }
}

struct Peer {
    lines: Lines<BufReader<OwnedReadHalf>>,
    wr: OwnedWriteHalf,
}

impl Peer {
    async fn recv(&mut self) -> Value {
        let line = timeout(WAIT, self.lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn expect(&mut self, method: &str) -> Value {
        let req = self.recv().await;
        assert_eq!(req["method"], method, "{req}");
        req
    }

    async fn send_raw(&mut self, bytes: &[u8]) {
        self.wr.write_all(bytes).await.unwrap();
    }

    async fn send(&mut self, msg: Value) {
        self.send_raw(format!("{msg}\n").as_bytes()).await;
    }

    async fn reply(&mut self, req: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": req["id"], "result": result}))
            .await;
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await;
    }

    async fn handshake(&mut self, height: u32, tip: &Header) {
        let req = self.expect("server.version").await;
        assert_eq!(req["params"], json!(["rbitcoin.space", ["1.4", "1.6"]]));
        self.reply(&req, json!(["rbitcoin-electrs 0.9.1 electrumx", "1.6"]))
            .await;
        let req = self.expect("blockchain.headers.subscribe").await;
        self.reply(&req, tip_json(height, tip)).await;
    }
}

fn header(prev: BlockHash, nonce: u32) -> Header {
    Header {
        version: Version::TWO,
        prev_blockhash: prev,
        merkle_root: TxMerkleNode::all_zeros(),
        time: 1_767_225_600,
        bits: CompactTarget::from_consensus(0x207f_ffff),
        nonce,
    }
}

/// Headers at heights 0.. building on `prev`.
fn chain(prev: BlockHash, len: u32, salt: u32) -> Vec<Header> {
    let mut out: Vec<Header> = Vec::new();
    for i in 0..len {
        let prev = out.last().map_or(prev, Header::block_hash);
        out.push(header(prev, salt * 1000 + i));
    }
    out
}

fn tip_json(height: u32, header: &Header) -> Value {
    json!({"height": height, "hex": serialize_hex(header)})
}

fn sh(byte: u8) -> ScriptHash {
    ScriptHash([byte; 32])
}

fn op(byte: u8) -> OutPoint {
    OutPoint {
        txid: Txid::from_byte_array([byte; 32]),
        vout: 1,
    }
}

fn status(byte: u8) -> String {
    format!("{byte:02x}").repeat(32)
}

async fn next(events: &mut broadcast::Receiver<Event>) -> Event {
    timeout(WAIT, events.recv()).await.unwrap().unwrap()
}

/// A connected client whose initial tip event has been consumed.
async fn connected(
    config: Config,
    mock: &Mock,
) -> (Client, Peer, broadcast::Receiver<Event>, Vec<Header>) {
    let client = Client::spawn(config);
    let mut events = client.events();
    let mut peer = mock.accept().await;
    let headers = chain(BlockHash::all_zeros(), 3, 0);
    peer.handshake(2, &headers[2]).await;
    match next(&mut events).await {
        Event::Block(tip) => assert_eq!((tip.height, tip.hash), (2, headers[2].block_hash())),
        other => panic!("{other:?}"),
    }
    (client, peer, events, headers)
}

#[tokio::test]
async fn out_of_order_replies_and_interleaved_notifications() {
    let (mock, config) = Mock::start().await;
    let (client, mut peer, mut events, headers) = connected(config, &mock).await;
    assert_eq!(client.server_version().unwrap().protocol, "1.6");

    let c = client.clone();
    let balance = tokio::spawn(async move { c.balance(&sh(1)).await });
    let first = peer.recv().await;
    let c = client.clone();
    let fee = tokio::spawn(async move { c.estimate_fee(2).await });
    let second = peer.recv().await;
    assert_eq!(first["method"], "blockchain.scripthash.get_balance");
    assert_eq!(second["method"], "blockchain.estimatefee");

    // Answer the second first, with pushes in between.
    let next_block = header(headers[2].block_hash(), 7);
    peer.notify(
        "blockchain.headers.subscribe",
        json!([tip_json(3, &next_block)]),
    )
    .await;
    peer.reply(&second, json!(-1)).await;
    peer.notify(
        "blockchain.scripthash.subscribe",
        json!([sh(9).to_string(), status(9)]),
    )
    .await;
    peer.notify("server.something_new", json!([])).await;
    let tip = BlockHash::from_byte_array([3; 32]);
    peer.send(
        json!({"id": first["id"], "result": {"confirmed": 5, "unconfirmed": -2},
        "chain_tip": tip.to_string(), "chain_tip_height": 3}),
    )
    .await;

    assert_eq!(fee.await.unwrap(), Ok(None));
    let stamped = balance.await.unwrap().unwrap();
    assert_eq!(
        stamped.value,
        Balance {
            confirmed: 5,
            unconfirmed: -2
        }
    );
    assert_eq!(
        (stamped.chain_tip, stamped.chain_tip_height),
        (Some(tip), Some(3))
    );
    match next(&mut events).await {
        Event::Block(t) => assert_eq!((t.height, t.hash), (3, next_block.block_hash())),
        other => panic!("{other:?}"),
    }
    assert_eq!(client.tip().unwrap().height, 3);
    // The status for a topic nobody holds was dropped.
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn subscriptions_are_shared_counted_and_capped() {
    let (mock, mut config) = Mock::start().await;
    config.max_subscriptions = 2;
    let (client, mut peer, mut events, _) = connected(config, &mock).await;

    let c = client.clone();
    let first = tokio::spawn(async move { c.subscribe(Topic::ScriptHash(sh(1))).await });
    let req = peer.expect("blockchain.scripthash.subscribe").await;
    assert_eq!(req["params"], json!([sh(1).to_string()]));
    peer.reply(&req, json!(status(1))).await;
    let first = first.await.unwrap().unwrap();
    assert_eq!(first.status(), Some(Status::ScriptHash(Some(status(1)))));

    // A second holder of the same topic costs nothing upstream.
    let second = client.subscribe(Topic::ScriptHash(sh(1))).await.unwrap();

    let c = client.clone();
    let outpoint = tokio::spawn(async move { c.subscribe(Topic::Outpoint(op(2))).await });
    let req = peer.expect("blockchain.outpoint.subscribe").await;
    assert_eq!(req["params"], json!([op(2).txid.to_string(), 1]));
    peer.reply(
        &req,
        json!({"txid": op(2).txid.to_string(), "vout": 1, "spent": false}),
    )
    .await;
    let outpoint = outpoint.await.unwrap().unwrap();
    assert_eq!(
        outpoint.status(),
        Some(Status::Outpoint(OutpointStatus::Unspent))
    );

    let refused = client.subscribe(Topic::ScriptHash(sh(3))).await;
    assert_eq!(refused.err(), Some(Error::SubscriptionLimit { max: 2 }));

    // Pushes reach consumers once per change, whatever the number of holders.
    let spender = Txid::from_byte_array([4; 32]);
    let spent = json!({"spent": true, "height": 0, "spending_txid": spender.to_string()});
    let params = json!([op(2).txid.to_string(), 1, spent]);
    peer.notify("blockchain.outpoint.subscribe", params.clone())
        .await;
    peer.notify("blockchain.outpoint.subscribe", params).await;
    let changed = Status::Outpoint(OutpointStatus::SpentInMempool {
        spending_txid: spender,
    });
    assert_eq!(
        next(&mut events).await,
        Event::Status {
            topic: Topic::Outpoint(op(2)),
            status: changed
        }
    );

    // The upstream subscription goes with the last handle, not before.
    drop(first);
    drop(second);
    let req = peer.recv().await;
    assert_eq!(req["method"], "blockchain.scripthash.unsubscribe", "{req}");
    assert_eq!(req["params"], json!([sh(1).to_string()]));
    peer.reply(&req, json!(true)).await;

    // Its slot is free again, and late pushes for it are ignored.
    peer.notify(
        "blockchain.scripthash.subscribe",
        json!([sh(1).to_string(), status(5)]),
    )
    .await;
    let c = client.clone();
    let third = tokio::spawn(async move { c.subscribe(Topic::ScriptHash(sh(3))).await });
    let req = peer.expect("blockchain.scripthash.subscribe").await;
    peer.reply(&req, Value::Null).await;
    assert_eq!(
        third.await.unwrap().unwrap().status(),
        Some(Status::ScriptHash(None))
    );
    assert!(events.try_recv().is_err());
    drop(outpoint);
}

#[tokio::test]
async fn reconnect_restores_subscriptions_then_resyncs() {
    let (mock, config) = Mock::start().await;
    let (client, mut peer, mut events, headers) = connected(config, &mock).await;
    let mut held = Vec::new();
    for (topic, result) in [
        (Topic::ScriptHash(sh(1)), json!(status(1))),
        (Topic::Outpoint(op(2)), json!({"spent": false})),
    ] {
        let c = client.clone();
        let task = tokio::spawn(async move { c.subscribe(topic).await });
        let req = peer.recv().await;
        peer.reply(&req, result).await;
        held.push(task.await.unwrap().unwrap());
    }

    // A request in flight when the connection drops fails instead of hanging.
    let c = client.clone();
    let stranded = tokio::spawn(async move { c.mempool_info().await });
    peer.expect("mempool.get_info").await;
    drop(peer);
    assert_eq!(stranded.await.unwrap(), Err(Error::Disconnected));

    let mut peer = mock.accept().await;
    peer.handshake(2, &headers[2]).await;
    for _ in 0..2 {
        let req = peer.recv().await;
        match req["method"].as_str().unwrap() {
            "blockchain.scripthash.subscribe" => peer.reply(&req, json!(status(7))).await,
            // A refusal on restore leaves that topic unwatched, not silently stale.
            "blockchain.outpoint.subscribe" => {
                let error = json!({"code": 1, "message": "too many outpoint subscriptions"});
                peer.send(json!({"id": req["id"], "error": error})).await;
            }
            other => panic!("{other}"),
        }
    }
    // Only the status that moved is reported, then the all-clear.
    let moved = Status::ScriptHash(Some(status(7)));
    assert_eq!(
        next(&mut events).await,
        Event::Status {
            topic: Topic::ScriptHash(sh(1)),
            status: moved
        }
    );
    assert_eq!(next(&mut events).await, Event::Resynced);
    assert_eq!(held[0].status(), Some(Status::ScriptHash(Some(status(7)))));

    // The new connection serves requests.
    let c = client.clone();
    let info = tokio::spawn(async move { c.mempool_info().await });
    let req = peer.expect("mempool.get_info").await;
    peer.reply(
        &req,
        json!({"mempoolminfee": 1e-6, "minrelaytxfee": 1e-6, "incrementalrelayfee": 1e-6}),
    )
    .await;
    assert_eq!(info.await.unwrap().unwrap().minrelaytxfee, 1e-6);

    // The refused topic is asked for again by its next subscriber.
    assert_eq!(held[1].status(), None);
    let c = client.clone();
    let again = tokio::spawn(async move { c.subscribe(Topic::Outpoint(op(2))).await });
    let req = peer.expect("blockchain.outpoint.subscribe").await;
    peer.reply(&req, json!({"spent": false})).await;
    again.await.unwrap().unwrap();
    assert_eq!(
        held[1].status(),
        Some(Status::Outpoint(OutpointStatus::Unspent))
    );
}

#[tokio::test]
async fn restoring_more_topics_than_request_slots_does_not_time_out() {
    let (mock, mut config) = Mock::start().await;
    config.max_in_flight = 1;
    config.request_timeout = Duration::from_millis(300);
    let (client, mut peer, mut events, headers) = connected(config, &mock).await;
    let mut held = Vec::new();
    for i in 1..=3 {
        let c = client.clone();
        let task = tokio::spawn(async move { c.subscribe(Topic::ScriptHash(sh(i))).await });
        let req = peer.recv().await;
        peer.reply(&req, Value::Null).await;
        held.push(task.await.unwrap().unwrap());
    }
    drop(peer);

    // Each reply is in time, but all three together take longer than one timeout.
    let mut peer = mock.accept().await;
    peer.handshake(2, &headers[2]).await;
    for _ in 0..3 {
        let req = peer.expect("blockchain.scripthash.subscribe").await;
        sleep(Duration::from_millis(150)).await;
        peer.reply(&req, Value::Null).await;
    }
    assert_eq!(next(&mut events).await, Event::Resynced);
}

#[tokio::test]
async fn unanswered_request_times_out_and_the_connection_survives() {
    let (mock, mut config) = Mock::start().await;
    config.request_timeout = Duration::from_millis(200);
    let (client, mut peer, _events, _) = connected(config, &mock).await;

    let c = client.clone();
    let slow = tokio::spawn(async move { c.fee_histogram().await });
    let late = peer.expect("mempool.get_fee_histogram").await;
    assert_eq!(slow.await.unwrap(), Err(Error::Timeout));
    peer.reply(&late, json!([[1.0, 100]])).await;

    let c = client.clone();
    let again = tokio::spawn(async move { c.fee_histogram().await });
    let req = peer.expect("mempool.get_fee_histogram").await;
    peer.reply(&req, json!([[2.5, 1000], [1, 5000]])).await;
    assert_eq!(again.await.unwrap(), Ok(vec![(2.5, 1000), (1.0, 5000)]));
}

#[tokio::test]
async fn malformed_lines_are_skipped_and_oversized_ones_reconnect() {
    let (mock, mut config) = Mock::start().await;
    config.max_line_bytes = 4096;
    let (client, mut peer, mut events, headers) = connected(config, &mock).await;

    let c = client.clone();
    let header_req = tokio::spawn(async move { c.block_header(2).await });
    let req = peer.expect("blockchain.block.header").await;
    peer.send_raw(b"not json\n[1,2]\n{\"id\":\"x\"}\n\xff\xfe\n{\"method\":7}\n")
        .await;
    peer.notify(
        "blockchain.headers.subscribe",
        json!([{"height": 9, "hex": "00"}]),
    )
    .await;
    peer.notify("blockchain.scripthash.subscribe", json!([1, 2, 3]))
        .await;
    peer.notify("blockchain.outpoint.subscribe", json!(["zz", -1, null]))
        .await;
    // A reply of the wrong shape fails that request only.
    peer.reply(&req, json!({"not": "a header"})).await;
    assert!(matches!(header_req.await.unwrap(), Err(Error::Protocol(_))));
    // The five bad lines and three bad notifications are counted for the server's log.
    let health = client.health().borrow().clone();
    assert_eq!((health.ready, health.skipped_lines), (true, 8));

    let c = client.clone();
    let header_req = tokio::spawn(async move { c.block_header(2).await });
    let req = peer.expect("blockchain.block.header").await;
    peer.reply(&req, json!(serialize_hex(&headers[2]))).await;
    assert_eq!(header_req.await.unwrap(), Ok(headers[2]));
    let c = client.clone();
    let failing = tokio::spawn(async move { c.features().await });
    let req = peer.expect("server.features").await;
    peer.send(json!({"id": req["id"], "error": {"code": -32601, "message": "nope"}}))
        .await;
    assert_eq!(
        failing.await.unwrap(),
        Err(Error::Server {
            code: -32601,
            message: "nope".into()
        })
    );

    // A line past the cap, even without its newline, drops the connection.
    peer.send_raw(&vec![b' '; 5000]).await;
    let mut peer = mock.accept().await;
    peer.handshake(2, &headers[2]).await;
    assert_eq!(next(&mut events).await, Event::Resynced);
}

#[tokio::test]
async fn slow_consumer_lags_without_blocking_the_reader() {
    let (mock, mut config) = Mock::start().await;
    config.event_capacity = 4;
    let (client, mut peer, mut events, _) = connected(config, &mock).await;
    let c = client.clone();
    let sub = tokio::spawn(async move { c.subscribe(Topic::ScriptHash(sh(1))).await });
    let req = peer.recv().await;
    peer.reply(&req, Value::Null).await;
    let _sub = sub.await.unwrap().unwrap();

    for i in 0..200u8 {
        let params = json!([sh(1).to_string(), status(i)]);
        peer.notify("blockchain.scripthash.subscribe", params).await;
    }
    let c = client.clone();
    let info = tokio::spawn(async move { c.estimate_fee(1).await });
    let req = peer.expect("blockchain.estimatefee").await;
    peer.reply(&req, json!(0.00001)).await;
    assert_eq!(info.await.unwrap(), Ok(Some(0.00001)));

    assert!(matches!(events.recv().await, Err(RecvError::Lagged(_))));
    // What is left is the newest few.
    let last = Status::ScriptHash(Some(status(199)));
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    assert_eq!(seen.len(), 4);
    assert_eq!(
        seen.last(),
        Some(&Event::Status {
            topic: Topic::ScriptHash(sh(1)),
            status: last
        })
    );
}

#[tokio::test]
async fn tip_follows_gaps_and_reorgs() {
    let (mock, config) = Mock::start().await;
    let (client, mut peer, mut events, a) = connected(config, &mock).await;
    let block = |e: Event| match e {
        Event::Block(t) => (t.height, t.hash),
        other => panic!("{other:?}"),
    };

    // A competing block at height 2 replaces a[2].
    let b = chain(a[1].block_hash(), 4, 1);
    peer.notify("blockchain.headers.subscribe", json!([tip_json(2, &b[0])]))
        .await;
    let req = peer.expect("blockchain.block.headers").await;
    assert_eq!(req["params"], json!([0, 3]));
    let hexes: Vec<String> = [a[0], a[1], b[0]].iter().map(serialize_hex).collect();
    peer.reply(&req, json!({"count": 3, "headers": hexes, "max": 2016}))
        .await;
    assert_eq!(next(&mut events).await, Event::Reorg { fork_height: 1 });
    assert_eq!(block(next(&mut events).await), (2, b[0].block_hash()));

    // Three blocks at once: the two skipped ones are filled in, in order.
    // This reply uses the protocol 1.4 shape.
    peer.notify("blockchain.headers.subscribe", json!([tip_json(5, &b[3])]))
        .await;
    let req = peer.expect("blockchain.block.headers").await;
    assert_eq!(req["params"], json!([0, 6]));
    let hex: String = [a[0], a[1], b[0], b[1], b[2], b[3]]
        .iter()
        .map(serialize_hex)
        .collect();
    peer.reply(&req, json!({"count": 6, "hex": hex, "max": 2016}))
        .await;
    for (height, h) in [(3, b[1]), (4, b[2]), (5, b[3])] {
        assert_eq!(block(next(&mut events).await), (height, h.block_hash()));
    }
    assert_eq!(client.tip().unwrap().hash, b[3].block_hash());

    // The same tip again is not news.
    peer.notify("blockchain.headers.subscribe", json!([tip_json(5, &b[3])]))
        .await;
    let next_block = header(b[3].block_hash(), 1);
    peer.notify(
        "blockchain.headers.subscribe",
        json!([tip_json(6, &next_block)]),
    )
    .await;
    assert_eq!(block(next(&mut events).await), (6, next_block.block_hash()));

    // A rollback to a block we already have: no new blocks, but the tip moves back.
    peer.notify("blockchain.headers.subscribe", json!([tip_json(5, &b[3])]))
        .await;
    let req = peer.expect("blockchain.block.headers").await;
    peer.reply(&req, json!({"count": 6, "hex": hex, "max": 2016}))
        .await;
    assert_eq!(next(&mut events).await, Event::Reorg { fork_height: 5 });
    assert_eq!(client.tip().unwrap().hash, b[3].block_hash());

    // A tip with nothing in common with ours: consumers are told to start over.
    let other = chain(BlockHash::from_byte_array([9; 32]), 2, 2);
    peer.notify(
        "blockchain.headers.subscribe",
        json!([tip_json(300, &other[1])]),
    )
    .await;
    let req = peer.expect("blockchain.block.headers").await;
    assert_eq!(req["params"], json!([157, 144]));
    peer.reply(
        &req,
        json!({"count": 1, "headers": [serialize_hex(&other[0])], "max": 2016}),
    )
    .await;
    assert_eq!(next(&mut events).await, Event::Resynced);
    assert_eq!(block(next(&mut events).await), (300, other[1].block_hash()));

    // A hostile height at the top of the range, with too many headers, does not stop tracking.
    peer.notify(
        "blockchain.headers.subscribe",
        json!([tip_json(u32::MAX, &other[0])]),
    )
    .await;
    let req = peer.expect("blockchain.block.headers").await;
    assert_eq!(req["params"], json!([u32::MAX - 143, 144]));
    let flood = vec![serialize_hex(&other[1]); 145];
    peer.reply(&req, json!({"count": 145, "headers": flood, "max": 2016}))
        .await;
    assert_eq!(next(&mut events).await, Event::Resynced);
    assert_eq!(
        block(next(&mut events).await),
        (u32::MAX, other[0].block_hash())
    );
    peer.notify(
        "blockchain.headers.subscribe",
        json!([tip_json(301, &other[1])]),
    )
    .await;
    let req = peer.expect("blockchain.block.headers").await;
    peer.reply(
        &req,
        json!({"count": 1, "headers": [serialize_hex(&other[1])], "max": 2016}),
    )
    .await;
    assert_eq!(next(&mut events).await, Event::Resynced);
}

#[tokio::test]
async fn health_tracks_ready_lost_and_failed_attempts() {
    let (mock, config) = Mock::start().await;
    let (client, peer, _events, _) = connected(config, &mock).await;
    let health = client.health();
    let wait_for = |want: fn(&Health) -> bool| {
        let mut rx = health.clone();
        async move {
            timeout(WAIT, rx.wait_for(want))
                .await
                .unwrap()
                .unwrap()
                .clone()
        }
    };
    assert_eq!(
        wait_for(|h| h.ready).await,
        Health {
            ready: true,
            failures: 0,
            skipped_lines: 0
        }
    );
    // Lost with nothing listening: not ready, then attempts in a row pile up.
    drop(mock);
    drop(peer);
    let lost = wait_for(|h| !h.ready).await;
    assert!(lost.failures <= 1, "{lost:?}");
    let failing = wait_for(|h| h.failures >= 3).await;
    assert!(!failing.ready);
}

/// Read-only requests and live events against a real node. Never runs in CI:
/// `ELECTRUM_ADDR=host:port cargo test -p node live_node -- --ignored --nocapture`.
/// Optional: `WATCH_SCRIPTHASH`, `WATCH_OUTPOINT` (`txid:vout`, comma-separated) and `WATCH_SECS`.
#[tokio::test]
#[ignore = "needs a running node"]
#[allow(clippy::print_stdout)] // a manual probe: printing is its output
async fn live_node() {
    let addr = std::env::var("ELECTRUM_ADDR").expect("ELECTRUM_ADDR");
    let client = Client::spawn(Config::new(addr));
    let mut events = client.events();
    let tip = match next(&mut events).await {
        Event::Block(tip) => tip,
        other => panic!("{other:?}"),
    };
    println!("server.version     {:?}", client.server_version().unwrap());
    println!("tip                {} {}", tip.height, tip.hash);
    let features = client.features().await.unwrap();
    println!(
        "server.features    genesis {} protocol {}..{} chain_tip {}",
        features.genesis_hash, features.protocol_min, features.protocol_max, features.chain_tip
    );
    println!(
        "block.header       {}",
        client.block_header(tip.height).await.unwrap().block_hash()
    );
    let headers = client
        .block_headers(tip.height.saturating_sub(2), 3)
        .await
        .unwrap();
    println!(
        "block.headers      {:?}",
        headers.iter().map(Header::block_hash).collect::<Vec<_>>()
    );
    println!(
        "mempool.get_info   {:?}",
        client.mempool_info().await.unwrap()
    );
    let histogram = client.fee_histogram().await.unwrap();
    println!(
        "fee_histogram      {} bands, first {:?}",
        histogram.len(),
        histogram.first()
    );
    println!(
        "estimatefee(1)     {:?}",
        client.estimate_fee(1).await.unwrap()
    );
    let coinbase = client.block_header(1).await.unwrap();
    println!("block 1 hash       {}", coinbase.block_hash());

    let mut held = Vec::new();
    if let Ok(sh) = std::env::var("WATCH_SCRIPTHASH") {
        let sh: ScriptHash = sh.parse().unwrap();
        let history = client.history(&sh).await.unwrap();
        println!(
            "get_history        {} rows, chain_tip {:?} at {:?}",
            history.value.len(),
            history.chain_tip,
            history.chain_tip_height
        );
        println!(
            "get_balance        {:?}",
            client.balance(&sh).await.unwrap()
        );
        let sub = client.subscribe(Topic::ScriptHash(sh)).await.unwrap();
        println!("subscribed         {:?}", sub.status());
        held.push(sub);
    }
    for op in std::env::var("WATCH_OUTPOINT")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
    {
        let op: OutPoint = op.parse().unwrap();
        println!(
            "outpoint.get_status {op} {:?}",
            client.outpoint_status(&op).await.unwrap()
        );
        let sub = client.subscribe(Topic::Outpoint(op)).await.unwrap();
        println!("subscribed         {:?}", sub.status());
        held.push(sub);
    }
    let secs = std::env::var("WATCH_SECS").map_or(0, |s| s.parse().unwrap());
    let until = tokio::time::Instant::now() + Duration::from_secs(secs);
    while let Ok(event) = tokio::time::timeout_at(until, events.recv()).await {
        match event {
            Ok(Event::Block(tip)) => println!("event Block        {} {}", tip.height, tip.hash),
            other => println!("event              {other:?}"),
        }
    }
}

#[test]
fn scripthash_of_a_script() {
    // The example from the Electrum protocol docs: P2PKH of 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.
    let script =
        bitcoin::ScriptBuf::from_hex("76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac").unwrap();
    assert_eq!(
        ScriptHash::from_script(&script).to_string(),
        "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161"
    );
    assert!("xyz".parse::<ScriptHash>().is_err());
}

/// Replies recorded from rbitcoin v0.9.1 on the regtest scenario chain (docs/REGTEST.md).
const RECORDED: &str = include_str!("../../../../fixtures/electrum/regtest.json");

#[tokio::test]
async fn parses_replies_recorded_from_rbitcoin() {
    let recorded: Vec<Value> = serde_json::from_str(RECORDED).unwrap();
    let replies: Vec<Value> = recorded
        .iter()
        .filter(|r| r["protocol"] == "1.6")
        .cloned()
        .collect();
    let (mock, config) = Mock::start().await;
    let client = Client::spawn(config);
    let mut events = client.events();
    let mut peer = mock.accept().await;
    let server = tokio::spawn(async move {
        loop {
            let req = peer.recv().await;
            let found = replies
                .iter()
                .find(|r| r["method"] == req["method"] && r["params"] == req["params"]);
            let mut reply = found.unwrap_or_else(|| panic!("not recorded: {req}"))["reply"].clone();
            reply["id"] = req["id"].clone();
            peer.send(reply).await;
        }
    });

    let txid = |s: &str| s.parse::<Txid>().unwrap();
    let block_106: BlockHash = "2ac64444e3172ee94aeeff3b09014b1d69b4daeccddac025d493332d54f6f145"
        .parse()
        .unwrap();
    let tip_110: BlockHash = "3fa932c75119e4a4f4c4f5f43afe8fec03c5f3bc9b84fbadd1e96dd34bc6654d"
        .parse()
        .unwrap();
    match next(&mut events).await {
        Event::Block(tip) => assert_eq!((tip.height, tip.hash), (110, tip_110)),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        client.server_version().unwrap().server,
        "rbitcoin-electrs 0.9.1 electrumx"
    );
    let features = client.features().await.unwrap();
    assert!(features.chain_tip);
    assert_eq!(features.protocol_max, "1.6");
    assert_eq!(
        client.block_header(106).await.unwrap().block_hash(),
        block_106
    );
    let headers = client.block_headers(105, 2).await.unwrap();
    assert_eq!(headers[1].block_hash(), block_106);
    assert_eq!(headers[1].prev_blockhash, headers[0].block_hash());
    assert_eq!(client.mempool_info().await.unwrap().minrelaytxfee, 1e-6);
    assert_eq!(client.fee_histogram().await.unwrap().len(), 3);
    assert_eq!(client.estimate_fee(1).await.unwrap(), None);

    let script_types = txid("44c64894ca2125fb361f286005f8e27d1c1846bfe00c692925ab4d6844721bbd");
    let cpfp_parent = txid("7621473f23691b3acc681cada96b25a64e64ff298d8f95fd4818855ea886abbd");
    let cpfp_child = txid("ad853f8771d8e8f764d362723b23fe758654432f52da63baa993ffc66af93f51");
    let consolidation = txid("f8580c086f549b53145643e6b846d617aef17305ec2af34125e41faa74bfd787");
    let status = |txid, vout| {
        let client = client.clone();
        async move {
            client
                .outpoint_status(&OutPoint { txid, vout })
                .await
                .unwrap()
        }
    };
    assert_eq!(
        status(script_types, 1).await,
        OutpointStatus::SpentConfirmed
    );
    assert_eq!(
        status(cpfp_parent, 0).await,
        OutpointStatus::SpentInMempool {
            spending_txid: cpfp_child
        }
    );
    assert_eq!(status(consolidation, 0).await, OutpointStatus::Unspent);

    let p2wpkh: ScriptHash = recorded
        .iter()
        .find(|r| r["method"] == "blockchain.scripthash.get_history")
        .unwrap()["params"][0]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let history = client.history(&p2wpkh).await.unwrap();
    assert_eq!(
        (history.chain_tip, history.chain_tip_height),
        (Some(tip_110), Some(110))
    );
    assert!(
        history
            .value
            .iter()
            .any(|row| row.tx_hash == consolidation && row.height == 106)
    );
    assert!(
        history
            .value
            .iter()
            .any(|row| row.tx_hash == cpfp_child && row.height == -1 && row.fee.is_some())
    );
    let balance = client.balance(&p2wpkh).await.unwrap();
    assert_eq!(balance.chain_tip, Some(tip_110));
    assert!(balance.value.confirmed > 0 && balance.value.unconfirmed > 0);
    let sub = client.subscribe(Topic::ScriptHash(p2wpkh)).await.unwrap();
    assert!(matches!(sub.status(), Some(Status::ScriptHash(Some(_)))));
    let outpoint = client
        .subscribe(Topic::Outpoint(OutPoint {
            txid: consolidation,
            vout: 0,
        }))
        .await
        .unwrap();
    assert_eq!(
        outpoint.status(),
        Some(Status::Outpoint(OutpointStatus::Unspent))
    );
    server.abort();

    // Protocol 1.4 sends the same headers as one hex string.
    let old = recorded
        .iter()
        .find(|r| r["protocol"] == "1.4" && r["method"] == "blockchain.block.headers")
        .unwrap();
    assert_eq!(
        types::parse_headers(&old["reply"]["result"]).unwrap(),
        headers
    );
}
