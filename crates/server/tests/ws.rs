//! The WebSocket hub end to end: the server on port 0 against a scripted Electrum server and a
//! mock Esplora, driven by a raw WebSocket client. Nothing here reaches a real node.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    // The bound tests print what they measured, for docs/WS.md.
    clippy::print_stderr
)]

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use bitcoin::block::{Header, Version};
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, CompactTarget, TxMerkleNode};
use logging::{Format, Level, Settings};
use rbitcoin_space::{App, Config, WsLimits};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(5);

// The node side.

/// Block JSON the mock Esplora serves, by hash. Unknown hashes are a 404.
type Blocks = Arc<Mutex<HashMap<String, Value>>>;

/// How many times the mock Esplora answered 404, by hash; under `"served"`, how many blocks it
/// served.
type Misses = Arc<Mutex<HashMap<String, u32>>>;

async fn mock_esplora(blocks: Blocks, misses: Misses) -> String {
    async fn block(
        Path(hash): Path<String>,
        State((blocks, misses)): State<(Blocks, Misses)>,
    ) -> impl IntoResponse {
        match blocks.lock().unwrap().get(&hash) {
            Some(b) => {
                *misses.lock().unwrap().entry("served".into()).or_default() += 1;
                (StatusCode::OK, b.to_string()).into_response()
            }
            None => {
                *misses.lock().unwrap().entry(hash).or_default() += 1;
                (StatusCode::NOT_FOUND, "Block not found").into_response()
            }
        }
    }
    // The ten newest by height, newest first, as the node's `/blocks` answers.
    async fn recent(State((blocks, _)): State<(Blocks, Misses)>) -> impl IntoResponse {
        let mut all: Vec<Value> = blocks.lock().unwrap().values().cloned().collect();
        all.sort_by_key(|b| std::cmp::Reverse(b["height"].as_u64()));
        all.truncate(10);
        Value::Array(all).to_string()
    }
    // Address history pages, counted under one key: the node's work for `/api/v1/ws` follows.
    async fn history(State((_, misses)): State<(Blocks, Misses)>) -> impl IntoResponse {
        *misses.lock().unwrap().entry("history".into()).or_default() += 1;
        "[]"
    }
    // An address's totals, asked before the node is asked to watch it: small, so it may be.
    async fn totals(State((_, misses)): State<(Blocks, Misses)>) -> impl IntoResponse {
        *misses.lock().unwrap().entry("totals".into()).or_default() += 1;
        let zero = r#"{"funded_txo_count":1,"funded_txo_sum":1,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":1}"#;
        format!(r#"{{"chain_stats":{zero},"mempool_stats":{zero}}}"#)
    }
    let app = axum::Router::new()
        .route("/block/{hash}", get(block))
        .route("/blocks", get(recent))
        .route("/scripthash/{hash}", get(totals))
        .route("/scripthash/{hash}/txs", get(history))
        .with_state((blocks, misses));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    url
}

/// One connection from the server's Electrum client.
struct Peer {
    lines: Lines<BufReader<OwnedReadHalf>>,
    wr: OwnedWriteHalf,
}

impl Peer {
    async fn accept(listener: &TcpListener) -> Peer {
        let (stream, _) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        let (rd, wr) = stream.into_split();
        Peer {
            lines: BufReader::new(rd).lines(),
            wr,
        }
    }

    async fn expect(&mut self, method: &str) -> Value {
        let line = timeout(WAIT, self.lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let req: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(req["method"], method, "{req}");
        req
    }

    async fn send(&mut self, msg: Value) {
        self.wr
            .write_all(format!("{msg}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn reply(&mut self, req: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": req["id"], "result": result}))
            .await;
    }

    async fn handshake(&mut self, height: u32, tip: &Header) {
        let req = self.expect("server.version").await;
        self.reply(&req, json!(["rbitcoin-electrs 0.9.1", "1.6"]))
            .await;
        let req = self.expect("blockchain.headers.subscribe").await;
        self.reply(&req, tip_json(height, tip)).await;
    }

    async fn push_tip(&mut self, height: u32, tip: &Header) {
        self.send(
            json!({"jsonrpc": "2.0", "method": "blockchain.headers.subscribe",
            "params": [tip_json(height, tip)]}),
        )
        .await;
    }
}

fn tip_json(height: u32, header: &Header) -> Value {
    json!({"height": height, "hex": serialize_hex(header)})
}

fn chain(prev: BlockHash, len: u32, salt: u32) -> Vec<Header> {
    let mut out: Vec<Header> = Vec::new();
    for i in 0..len {
        out.push(Header {
            version: Version::TWO,
            prev_blockhash: out.last().map_or(prev, Header::block_hash),
            merkle_root: TxMerkleNode::all_zeros(),
            time: 1_767_225_600,
            bits: CompactTarget::from_consensus(0x207f_ffff),
            nonce: salt * 1000 + i,
        });
    }
    out
}

/// A running server with its mocks. Headers `h[i]` sit at height `i`; `h[2]` is the first tip.
struct Harness {
    addr: String,
    electrum: TcpListener,
    peer: Peer,
    blocks: Blocks,
    misses: Misses,
    stop: Option<oneshot::Sender<()>>,
    served: tokio::task::JoinHandle<()>,
    sockets: Arc<rbitcoin_space::ws::Sockets>,
    h: Vec<Header>,
}

impl Harness {
    async fn start(ws: WsLimits) -> Harness {
        Self::start_with(ws, Duration::from_secs(2)).await
    }

    async fn start_with(ws: WsLimits, request_timeout: Duration) -> Harness {
        Self::start_vars(ws, request_timeout, &[]).await
    }

    async fn start_vars(
        ws: WsLimits,
        request_timeout: Duration,
        extra: &[(&str, &str)],
    ) -> Harness {
        let blocks = Blocks::default();
        let misses = Misses::default();
        let esplora = mock_esplora(Arc::clone(&blocks), Arc::clone(&misses)).await;
        let electrum = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let vars: HashMap<String, String> = [
            ("REGTEST_RPC_HOST", "127.0.0.1".to_owned()),
            ("REGTEST_RPC_PORT", "1".to_owned()),
            ("REGTEST_RPC_USER", "u".to_owned()),
            ("REGTEST_RPC_PASSWORD", "p".to_owned()),
            ("REGTEST_ESPLORA_URL", esplora),
            (
                "REGTEST_ELECTRUM_ADDR",
                electrum.local_addr().unwrap().to_string(),
            ),
        ]
        .into_iter()
        .chain(extra.iter().map(|(k, v)| (*k, (*v).to_owned())))
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        let mut config = Config::from_vars(|k| vars.get(k).cloned()).unwrap();
        config.ws = ws;
        config.limits.request_timeout = request_timeout;
        // Out of the way of the socket limits under test, unless the test sets its own.
        if !extra.iter().any(|(k, _)| k.starts_with("CLIENT_")) {
            config.limits.client_burst = 10_000;
            config.limits.client_rate_per_sec = 10_000;
        }

        let h = chain(BlockHash::all_zeros(), 3, 0);
        for (height, header) in h.iter().enumerate() {
            add_block(&blocks, height as u32, header);
        }
        capture();
        let app = App::new(&config);
        let sockets = Arc::clone(app.sockets());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let (stop, stopped) = oneshot::channel::<()>();
        let served = tokio::spawn(app.serve(listener, async {
            let _ = stopped.await;
        }));
        let mut peer = Peer::accept(&electrum).await;
        peer.handshake(2, &h[2]).await;
        // Wait until the first tip's block is fetched and is the snapshot a subscriber gets.
        let deadline = Instant::now() + WAIT;
        loop {
            let mut probe = Ws::connect(&addr, "/regtest/app/ws").await;
            probe.json().await;
            probe
                .send(json!({"op": "subscribe", "topics": ["blocks"]}))
                .await;
            if timeout(Duration::from_millis(100), probe.json())
                .await
                .is_ok()
            {
                break;
            }
            assert!(Instant::now() < deadline, "no snapshot");
        }
        while sockets.open() > 0 {
            assert!(Instant::now() < deadline, "probe never closed");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        Harness {
            addr,
            electrum,
            peer,
            blocks,
            misses,
            stop: Some(stop),
            served,
            sockets,
            h,
        }
    }

    async fn connect(&self) -> Ws {
        Ws::connect(&self.addr, "/regtest/app/ws").await
    }

    fn misses(&self, header: &Header) -> u32 {
        let hash = header.block_hash().to_string();
        self.misses.lock().unwrap().get(&hash).copied().unwrap_or(0)
    }

    /// Pushes a new tip whose block the mock Esplora knows.
    async fn mine(&mut self, height: u32, header: &Header) {
        add_block(&self.blocks, height, header);
        self.peer.push_tip(height, header).await;
    }
}

fn add_block(blocks: &Blocks, height: u32, header: &Header) {
    let id = header.block_hash().to_string();
    let block = json!({"id": id, "height": height,
        "previousblockhash": header.prev_blockhash.to_string(), "tx_count": 1});
    blocks.lock().unwrap().insert(id, block);
}

// The log. It is global, so every test here shares one capture and looks for lines only it
// can produce.

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

/// Waits until a logged event matches `f`, and returns it.
async fn logged(f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        logging::flush(Duration::from_secs(1));
        let raw = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
        if let Some(v) = raw
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find(|v| f(v))
        {
            return v;
        }
        assert!(Instant::now() < deadline, "not logged");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// The browser side.

/// A minimal WebSocket client that sends exactly what a test tells it to and never answers
/// pings on its own.
struct Ws {
    stream: TcpStream,
}

#[derive(Debug, PartialEq)]
enum Msg {
    Text(Vec<u8>),
    Ping,
    Close(u16, String),
    Other(u8),
}

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

impl Ws {
    async fn connect(addr: &str, path: &str) -> Ws {
        Self::connect_stream(TcpStream::connect(addr).await.unwrap(), path)
            .await
            .unwrap()
    }

    /// The upgrade request; `Err` carries the status line of a refusal.
    async fn connect_stream(stream: TcpStream, path: &str) -> Result<Ws, String> {
        Self::upgrade(stream, path, "Host: test\r\n").await
    }

    /// An upgrade with `headers` (each ending `\r\n`) in place of the usual `Host`.
    async fn upgrade(mut stream: TcpStream, path: &str, headers: &str) -> Result<Ws, String> {
        let head = Self::head(&mut stream, path, headers).await;
        if !head.starts_with("HTTP/1.1 101") {
            return Err(head.lines().next().unwrap_or_default().to_owned());
        }
        assert!(
            head.contains("sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
            "{head}"
        );
        Ok(Ws { stream })
    }

    /// Sends an upgrade request with `headers` and reads the response head, byte by byte so
    /// nothing after it is consumed.
    async fn head(stream: &mut TcpStream, path: &str, headers: &str) -> String {
        let req = format!(
            "GET {path} HTTP/1.1\r\n{headers}Upgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut b = [0u8];
            if timeout(WAIT, stream.read_exact(&mut b))
                .await
                .unwrap()
                .is_err()
            {
                break;
            }
            head.push(b[0]);
        }
        String::from_utf8(head).unwrap()
    }

    /// A refused upgrade's status line and its `http_request` line. Every test in this binary
    /// logs to one capture, so the line is found by the request id the response carries. Only
    /// the first refusal of each reason is written whole (`crate::refusals`).
    async fn refused(mut stream: TcpStream, headers: &str) -> (String, Value) {
        let head = Self::head(&mut stream, "/regtest/app/ws", headers).await;
        let id = head
            .lines()
            .find_map(|l| l.strip_prefix("x-request-id: "))
            .unwrap_or_else(|| panic!("no request id: {head}"))
            .to_owned();
        let line = logged(|v| v["event"] == "http_request" && v["request_id"] == id.as_str()).await;
        (head.lines().next().unwrap_or_default().to_owned(), line)
    }

    async fn send_raw(&mut self, bytes: &[u8]) {
        let _ = self.stream.write_all(bytes).await;
    }

    async fn send_frame(&mut self, b0: u8, payload: &[u8]) {
        self.send_raw(&masked(b0, payload)).await;
    }

    async fn send(&mut self, msg: Value) {
        self.send_frame(0x81, msg.to_string().as_bytes()).await;
    }

    /// The next frame, with its raw bytes.
    async fn recv_raw(&mut self) -> (Msg, Vec<u8>) {
        let mut head = [0u8; 2];
        timeout(WAIT, self.stream.read_exact(&mut head))
            .await
            .expect("timed out waiting for a frame")
            .expect("connection closed");
        assert_eq!(head[1] & 0x80, 0, "server frames are not masked");
        let len = match head[1] & 0x7F {
            126 => u64::from(self.stream.read_u16().await.unwrap()),
            127 => self.stream.read_u64().await.unwrap(),
            n => u64::from(n),
        };
        let mut payload = vec![0u8; len as usize];
        self.stream.read_exact(&mut payload).await.unwrap();
        let msg = match head[0] {
            0x81 => Msg::Text(payload.clone()),
            0x89 => Msg::Ping,
            0x88 => Msg::Close(
                u16::from_be_bytes([payload[0], payload[1]]),
                String::from_utf8(payload[2..].to_vec()).unwrap(),
            ),
            b => Msg::Other(b),
        };
        (msg, payload)
    }

    /// The next text frame as JSON and its exact payload bytes, skipping pings.
    async fn json_raw(&mut self) -> (Value, Vec<u8>) {
        loop {
            match self.recv_raw().await.0 {
                Msg::Text(t) => return (serde_json::from_slice(&t).unwrap(), t),
                Msg::Ping => {}
                other => panic!("expected text, got {other:?}"),
            }
        }
    }

    async fn json(&mut self) -> Value {
        self.json_raw().await.0
    }

    /// Reads until the close frame and returns its code and reason.
    async fn close_code(&mut self) -> (u16, String) {
        loop {
            if let Msg::Close(code, reason) = self.recv_raw().await.0 {
                return (code, reason);
            }
        }
    }

    async fn subscribe_blocks(&mut self) -> Value {
        self.send(json!({"op": "subscribe", "topics": ["blocks"]}))
            .await;
        self.json().await
    }
}

fn masked(b0: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![b0];
    match payload.len() {
        n if n < 126 => out.push(0x80 | n as u8),
        n if n <= 0xFFFF => {
            out.push(0x80 | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(0x80 | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    let key = [1, 2, 3, 4];
    out.extend_from_slice(&key);
    out.extend(payload.iter().zip(key.iter().cycle()).map(|(b, k)| b ^ k));
    out
}

fn limits() -> WsLimits {
    WsLimits::default()
}

// The tests.

#[tokio::test]
async fn greeting_then_snapshot_then_each_block_once_with_identical_bytes() {
    let mut s = Harness::start(limits()).await;
    let mut a = s.connect().await;
    let hello = a.json().await;
    assert_eq!(
        hello,
        json!({"type": "hello", "v": 1, "network": "regtest",
            "tip": {"height": 2, "hash": s.h[2].block_hash().to_string()}})
    );
    // Subscribing first sends the current state: the tip's block.
    let snapshot = a.subscribe_blocks().await;
    assert_eq!(snapshot["topic"], "blocks");
    assert_eq!(snapshot["type"], "block");
    assert_eq!(snapshot["block"]["height"], 2);

    let mut b = s.connect().await;
    b.json().await;
    b.subscribe_blocks().await;

    let next = chain(s.h[2].block_hash(), 1, 1)[0];
    s.mine(3, &next).await;
    let (msg, a_bytes) = a.json_raw().await;
    let (_, b_bytes) = b.json_raw().await;
    assert_eq!(a_bytes, b_bytes);
    assert_eq!(msg["block"]["id"], next.block_hash().to_string());
    assert_eq!(msg["block"]["height"], 3);
    // One fan-out of one frame; its payload is over 125 bytes, so the header is 4 bytes.
    let bytes = a_bytes.len() + 4;
    let fanout =
        logged(|v| v["event"] == "ws_fanout" && v["bytes"] == bytes && v["subscribers"] == 2).await;
    assert_eq!(fanout["network"], "regtest");
    assert_eq!(fanout["kind"], "block");
    assert_eq!(fanout["dropped_slow"], 0);

    // Nothing else was queued: the next message is the answer to a ping.
    for ws in [&mut a, &mut b] {
        ws.send(json!({"op": "ping"})).await;
        assert_eq!(ws.json().await, json!({"type": "pong"}));
    }
    // After unsubscribing, blocks stop.
    a.send(json!({"op": "unsubscribe", "topics": ["blocks"]}))
        .await;
    let after = chain(next.block_hash(), 1, 2)[0];
    s.mine(4, &after).await;
    assert_eq!(b.json().await["block"]["height"], 4);
    a.send(json!({"op": "ping"})).await;
    assert_eq!(a.json().await, json!({"type": "pong"}));
}

#[tokio::test]
async fn reorg_resync_and_missing_blocks_are_announced() {
    let mut s = Harness::start(WsLimits {
        block_wait: Duration::from_secs(2),
        ..limits()
    })
    .await;
    let mut ws = s.connect().await;
    ws.json().await;
    ws.subscribe_blocks().await;

    // A competing block at height 2 replaces h[2].
    let fork = chain(s.h[1].block_hash(), 1, 7)[0];
    s.mine(2, &fork).await;
    let req = s.peer.expect("blockchain.block.headers").await;
    let hexes: Vec<String> = [s.h[0], s.h[1], fork].iter().map(serialize_hex).collect();
    s.peer
        .reply(&req, json!({"count": 3, "headers": hexes, "max": 2016}))
        .await;
    assert_eq!(
        ws.json().await,
        json!({"topic": "blocks", "type": "reorg", "fork_height": 1})
    );
    let msg = ws.json().await;
    assert_eq!(msg["type"], "block");
    assert_eq!(msg["block"]["id"], fork.block_hash().to_string());

    // A block Esplora never serves: after `block_wait` of asking less and less often, clients
    // are told to resync instead.
    let unknown = chain(fork.block_hash(), 1, 8)[0];
    let pushed = Instant::now();
    s.peer.push_tip(3, &unknown).await;
    let msg = ws.json().await;
    let waited = pushed.elapsed();
    assert_eq!(msg["type"], "resync");
    assert_eq!(msg["tip"]["height"], 3);
    assert!(waited >= Duration::from_secs(2), "{waited:?}");
    // Every 25 ms for the first 200 ms, then every eighth of the time waited: about 28 in 2 s.
    let misses = s.misses(&unknown);
    assert!((2..=40).contains(&misses), "{misses} requests");
    // A later subscriber gets that resync as the snapshot, not the block before it.
    let mut late = s.connect().await;
    late.json().await;
    assert_eq!(late.subscribe_blocks().await, msg);

    // The node connection drops and comes back: the client reconnects and clients resync.
    s.peer.wr.shutdown().await.unwrap();
    s.peer = Peer::accept(&s.electrum).await;
    s.peer.handshake(3, &unknown).await;
    let msg = ws.json().await;
    assert_eq!(
        msg,
        json!({"topic": "blocks", "type": "resync",
            "tip": {"height": 3, "hash": unknown.block_hash().to_string()}})
    );
}

#[tokio::test]
async fn a_block_esplora_serves_late_still_arrives_as_a_block() {
    let mut s = Harness::start(limits()).await;
    let mut clients = Vec::new();
    for _ in 0..3 {
        let mut ws = s.connect().await;
        ws.json().await;
        ws.subscribe_blocks().await;
        clients.push(ws);
    }
    // Electrum announces the tip before Esplora can serve it, as rbitcoin does.
    let next = chain(s.h[2].block_hash(), 1, 9)[0];
    let pushed = Instant::now();
    s.peer.push_tip(3, &next).await;
    let deadline = Instant::now() + WAIT;
    while s.misses(&next) < 3 {
        assert!(Instant::now() < deadline, "never asked for the block");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    add_block(&s.blocks, 3, &next);
    for ws in &mut clients {
        let msg = ws.json().await;
        assert_eq!(msg["type"], "block");
        assert_eq!(msg["block"]["id"], next.block_hash().to_string());
    }
    let elapsed = pushed.elapsed();
    // One retry loop, whatever the number of clients: at most one request per 25 ms.
    let misses = s.misses(&next);
    let most = u32::try_from(elapsed.as_millis() / 25).unwrap() + 1;
    assert!(
        (2..=most).contains(&misses),
        "{misses} requests in {elapsed:?}"
    );
}

/// Waits for the hub to have asked Esplora for `header`'s block at least `n` times.
async fn asked(s: &Harness, header: &Header, n: u32) {
    let deadline = Instant::now() + WAIT;
    while s.misses(header) < n {
        assert!(Instant::now() < deadline, "never asked for the block");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_block_goes_out_whenever_the_node_serves_it_within_the_bound() {
    let mut s = Harness::start(limits()).await;
    let mut ws = s.connect().await;
    ws.json().await;
    ws.subscribe_blocks().await;
    let mut prev = s.h[2];
    // Served at once, after half a second, and after five seconds: longer than the old
    // three-second bound, which turned such a block into a `resync`.
    for (i, delay) in [0u64, 500, 5_000].into_iter().enumerate() {
        let height = 3 + i as u32;
        let next = chain(prev.block_hash(), 1, 20 + i as u32)[0];
        if delay == 0 {
            add_block(&s.blocks, height, &next);
        }
        s.peer.push_tip(height, &next).await;
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            add_block(&s.blocks, height, &next);
        }
        let msg = timeout(Duration::from_secs(10), ws.json()).await.unwrap();
        assert_eq!(msg["type"], "block", "{msg}");
        assert_eq!(msg["block"]["id"], next.block_hash().to_string());
        prev = next;
    }
    // Nothing else came: no `resync`, no second copy.
    ws.send(json!({"op": "ping"})).await;
    assert_eq!(ws.json().await, json!({"type": "pong"}));
}

#[tokio::test]
async fn a_burst_served_late_goes_out_in_order_and_a_subscriber_meanwhile_misses_nothing() {
    let mut s = Harness::start(limits()).await;
    let mut early = s.connect().await;
    early.json().await;
    early.subscribe_blocks().await;
    // Three blocks announced one after another, none served yet. (Pushed faster, the client
    // would take only the newest and ask the node for the headers between.)
    let burst = chain(s.h[2].block_hash(), 3, 30);
    for (i, h) in burst.iter().enumerate() {
        s.peer.push_tip(3 + i as u32, h).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Only the oldest is asked for until it is served.
    asked(&s, &burst[0], 2).await;
    assert_eq!(s.misses(&burst[1]), 0);
    // A subscriber now gets the last block sent; the burst follows as for everyone.
    let mut late = s.connect().await;
    late.json().await;
    assert_eq!(late.subscribe_blocks().await["block"]["height"], 2);
    // The node serves them out of order; they go out in order, each once.
    add_block(&s.blocks, 5, &burst[2]);
    add_block(&s.blocks, 4, &burst[1]);
    add_block(&s.blocks, 3, &burst[0]);
    for ws in [&mut early, &mut late] {
        for (i, h) in burst.iter().enumerate() {
            let msg = ws.json().await;
            assert_eq!(msg["type"], "block");
            assert_eq!(msg["block"]["id"], h.block_hash().to_string());
            assert_eq!(msg["block"]["height"], 3 + i as u64);
        }
        ws.send(json!({"op": "ping"})).await;
        assert_eq!(ws.json().await, json!({"type": "pong"}));
    }
}

#[tokio::test]
async fn a_block_replaced_before_the_node_serves_it_is_never_sent() {
    let mut s = Harness::start(limits()).await;
    let mut ws = s.connect().await;
    ws.json().await;
    ws.subscribe_blocks().await;
    // Block A at height 3 is announced but never served.
    let a = chain(s.h[2].block_hash(), 1, 40)[0];
    s.peer.push_tip(3, &a).await;
    asked(&s, &a, 2).await;
    // B replaces it, and B's child follows: the node switches branches.
    let b = chain(s.h[2].block_hash(), 2, 41);
    s.peer.push_tip(4, &b[1]).await;
    let req = s.peer.expect("blockchain.block.headers").await;
    let hexes: Vec<String> = [s.h[0], s.h[1], s.h[2], b[0], b[1]]
        .iter()
        .map(serialize_hex)
        .collect();
    s.peer
        .reply(&req, json!({"count": 5, "headers": hexes, "max": 2016}))
        .await;
    assert_eq!(
        ws.json().await,
        json!({"topic": "blocks", "type": "reorg", "fork_height": 2})
    );
    // A is no longer asked for; B's blocks go out once served, without waiting A out.
    let stopped = s.misses(&a);
    add_block(&s.blocks, 3, &b[0]);
    add_block(&s.blocks, 4, &b[1]);
    for (i, h) in b.iter().enumerate() {
        let msg = timeout(Duration::from_secs(1), ws.json()).await.unwrap();
        assert_eq!(msg["type"], "block");
        assert_eq!(msg["block"]["id"], h.block_hash().to_string());
        assert_eq!(msg["block"]["height"], 3 + i as u64);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        s.misses(&a) <= stopped + 1,
        "{} after {stopped}",
        s.misses(&a)
    );
    ws.send(json!({"op": "ping"})).await;
    assert_eq!(ws.json().await, json!({"type": "pong"}));
}

#[tokio::test]
async fn a_block_waited_for_across_a_node_reconnect_is_dropped_not_sent() {
    let mut s = Harness::start(limits()).await;
    let mut ws = s.connect().await;
    ws.json().await;
    ws.subscribe_blocks().await;
    // Block A is announced but not served, and then the connection to the node drops: events
    // may have been missed, a reorg among them, so A may no longer be on the chain.
    let a = chain(s.h[2].block_hash(), 1, 50)[0];
    s.peer.push_tip(3, &a).await;
    asked(&s, &a, 2).await;
    s.peer.wr.shutdown().await.unwrap();
    s.peer = Peer::accept(&s.electrum).await;
    s.peer.handshake(3, &a).await;
    assert_eq!(ws.json().await["type"], "resync");
    // Served now, A is not sent as a best-chain block: clients refetch on the resync instead.
    let stopped = s.misses(&a);
    add_block(&s.blocks, 3, &a);
    tokio::time::sleep(Duration::from_millis(300)).await;
    ws.send(json!({"op": "ping"})).await;
    assert_eq!(ws.json().await, json!({"type": "pong"}));
    assert!(
        s.misses(&a) <= stopped + 1,
        "{} after {stopped}",
        s.misses(&a)
    );
}

#[tokio::test]
async fn each_message_limit_closes_with_its_code() {
    let ws_limits = WsLimits {
        max_message_bytes: 64,
        messages_per_sec: 5,
        ..limits()
    };
    let s = Harness::start(ws_limits).await;
    let cases: Vec<(&[u8], u16)> = vec![
        (&[0x81], 1009),       // a text frame over 64 bytes, refused from its header
        (&[0x82], 1003),       // binary
        (&[0x81, 0xFF], 1007), // invalid UTF-8
        (&[0x81, b'{'], 4000), // not JSON
        (&[0x01, b'x'], 1002), // a new message inside a fragmented one
    ];
    for (bytes, code) in cases {
        let mut ws = s.connect().await;
        ws.json().await;
        match (code, bytes) {
            (1009, _) => ws.send_frame(0x81, &[b' '; 65]).await,
            (1002, _) => {
                ws.send_frame(0x01, b"{").await;
                ws.send_frame(0x81, b"}").await;
            }
            (_, [b0, rest @ ..]) => ws.send_frame(*b0, rest).await,
            _ => unreachable!(),
        }
        assert_eq!(ws.close_code().await.0, code, "{bytes:?}");
    }

    // Unknown topic, unmasked frame.
    let mut ws = s.connect().await;
    ws.json().await;
    ws.send(json!({"op": "subscribe", "topics": ["mempool-everything"]}))
        .await;
    assert_eq!(ws.close_code().await, (4000, "bad message".to_owned()));
    let mut ws = s.connect().await;
    ws.json().await;
    ws.send_raw(&[0x81, 0x01, b'x']).await;
    assert_eq!(ws.close_code().await.0, 1002);

    // A fragmented message is reassembled, and its total size is capped too.
    let mut ws = s.connect().await;
    ws.json().await;
    ws.send_frame(0x01, br#"{"op":"#).await;
    ws.send_frame(0x80, br#""ping"}"#).await;
    assert_eq!(ws.json().await, json!({"type": "pong"}));
    ws.send_frame(0x01, &[b' '; 40]).await;
    ws.send_frame(0x80, &[b' '; 40]).await;
    assert_eq!(ws.close_code().await.0, 1009);

    // Five messages a second are fine; a burst past that is not.
    let mut ws = s.connect().await;
    ws.json().await;
    for _ in 0..5 {
        ws.send(json!({"op": "ping"})).await;
    }
    for _ in 0..5 {
        assert_eq!(ws.json().await, json!({"type": "pong"}));
    }
    ws.send(json!({"op": "ping"})).await;
    assert_eq!(
        ws.close_code().await,
        (4002, "too many messages".to_owned())
    );

    // A client close is answered with a close.
    let mut ws = s.connect().await;
    ws.json().await;
    ws.send_frame(0x88, &1000u16.to_be_bytes()).await;
    assert_eq!(ws.close_code().await.0, 1000);
}

#[tokio::test]
async fn socket_caps_refuse_the_upgrade() {
    let s = Harness::start(WsLimits {
        max_sockets: 3,
        client_max_sockets: 2,
        ..limits()
    })
    .await;
    let connect = |addr: String| async move {
        let stream = TcpStream::connect(addr).await.unwrap();
        Ws::connect_stream(stream, "/regtest/app/ws").await
    };
    let _a = connect(s.addr.clone()).await.unwrap();
    let b = connect(s.addr.clone()).await.unwrap();
    // The request log says which cap refused it, as for every other limit.
    let (status, refused) =
        Ws::refused(TcpStream::connect(&s.addr).await.unwrap(), "Host: test\r\n").await;
    assert_eq!(status, "HTTP/1.1 429 Too Many Requests");
    assert_eq!(refused["status"], 429);
    assert_eq!(refused["refused"], "client_sockets");
    assert_eq!(refused["route"], "/regtest/app/ws");
    // Another address (127.0.0.2 is loopback on Linux; macOS needs an alias) has its own cap,
    // but the total of 3 still applies.
    let other = TcpSocket::new_v4().unwrap();
    if other.bind("127.0.0.2:0".parse().unwrap()).is_ok() {
        let other_addr = s.addr.clone();
        let stream = other.connect(other_addr.parse().unwrap()).await.unwrap();
        let _c = Ws::connect_stream(stream, "/regtest/app/ws").await.unwrap();
        let other = TcpSocket::new_v4().unwrap();
        other.bind("127.0.0.2:0".parse().unwrap()).unwrap();
        let stream = other.connect(s.addr.parse().unwrap()).await.unwrap();
        let (status, refused) = Ws::refused(stream, "Host: test\r\n").await;
        assert_eq!(status, "HTTP/1.1 503 Service Unavailable");
        assert_eq!(refused["status"], 503);
        assert_eq!(refused["refused"], "server_sockets");
    }
    // A closed socket frees its slot.
    drop(b);
    let deadline = Instant::now() + WAIT;
    while connect(s.addr.clone()).await.is_err() {
        assert!(Instant::now() < deadline, "slot never freed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Not an upgrade, or a bad key: 400 before any slot is taken.
    let mut stream = TcpStream::connect(&s.addr).await.unwrap();
    stream
        .write_all(b"GET /regtest/app/ws HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).await.unwrap();
    assert!(reply.starts_with("HTTP/1.1 400"), "{reply}");
    assert!(reply.contains("websocket upgrade required"), "{reply}");
}

#[tokio::test]
async fn a_slow_reader_is_dropped_while_others_keep_receiving() {
    let mut s = Harness::start(WsLimits {
        send_queue: 2,
        ..limits()
    })
    .await;
    // Big blocks, and a slow client with a tiny receive window, so its buffers fill fast.
    let pad = "x".repeat(256 * 1024);
    let slow_socket = TcpSocket::new_v4().unwrap();
    slow_socket.set_recv_buffer_size(4096).unwrap();
    let stream = slow_socket.connect(s.addr.parse().unwrap()).await.unwrap();
    let mut slow = Ws::connect_stream(stream, "/regtest/app/ws").await.unwrap();
    slow.json().await;
    slow.subscribe_blocks().await;
    let mut fast = s.connect().await;
    fast.json().await;
    fast.subscribe_blocks().await;

    let blocks = chain(s.h[2].block_hash(), 40, 3);
    for (i, header) in blocks.iter().enumerate() {
        let height = 3 + i as u32;
        let id = header.block_hash().to_string();
        s.blocks
            .lock()
            .unwrap()
            .insert(id.clone(), json!({"id": id, "height": height, "pad": pad}));
        s.peer.push_tip(height, header).await;
        // The fast client gets every block, in order, while the slow one falls behind.
        assert_eq!(fast.json().await["block"]["height"], height);
    }
    let dropped = logged(|v| v["event"] == "ws_clients_dropped" && v["reason"] == "too_slow").await;
    assert_eq!(dropped["total"], 1, "the slow client is dropped once");
    logged(|v| v["event"] == "ws_closed" && v["code"] == 4003).await;
    drop(slow);
}

#[tokio::test]
async fn quiet_clients_are_pinged_then_closed() {
    let s = Harness::start(WsLimits {
        idle_timeout: Duration::from_secs(1),
        ..limits()
    })
    .await;
    // Before the server opens the socket, so the close can never come sooner than the timeout.
    let started = Instant::now();
    let mut silent = s.connect().await;
    let mut polite = s.connect().await;
    silent.json().await;
    polite.json().await;
    // Answering every ping keeps a socket open across several idle periods.
    let polite = tokio::spawn(async move {
        let mut pings = 0;
        while started.elapsed() < Duration::from_millis(3500) {
            if let Ok((Msg::Ping, _)) = timeout(Duration::from_millis(100), polite.recv_raw()).await
            {
                pings += 1;
                polite.send_frame(0x8A, b"").await;
            }
        }
        polite.send(json!({"op": "ping"})).await;
        assert_eq!(polite.json().await, json!({"type": "pong"}));
        pings
    });
    assert_eq!(silent.recv_raw().await.0, Msg::Ping);
    assert_eq!(silent.close_code().await, (4004, "idle timeout".to_owned()));
    // Never before the idle timeout. How late is the watchdog's tick plus however long a busy
    // machine takes to run it, which no bound here can know; the ping before the close shows the
    // watchdog ran on time.
    let closed_after = started.elapsed();
    assert!(closed_after >= Duration::from_secs(1), "{closed_after:?}");
    assert!(polite.await.unwrap() >= 3);
}

// Several workers, so connection tasks and `serve` race as they do in the binary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_closes_sockets_within_the_deadline() {
    let mut s = Harness::start_with(limits(), Duration::from_secs(1)).await;
    let mut reading = s.connect().await;
    reading.json().await;
    // Never reads and never answers the close: shutdown must not wait on it past the deadline.
    let mut stubborn = s.connect().await;
    stubborn.json().await;

    s.stop.take().unwrap().send(()).unwrap();
    assert_eq!(
        reading.close_code().await,
        (1001, "server shutting down".to_owned())
    );
    timeout(Duration::from_secs(3), &mut s.served)
        .await
        .expect("shutdown overran its deadline")
        .unwrap();
    // Every socket's task has ended and released its slot, not only the wait.
    assert_eq!(s.sockets.open(), 0);
    assert_eq!(stubborn.close_code().await.0, 1001);
}

#[tokio::test]
async fn mempool_topics_poll_a_dead_node_quietly_and_cap_block_subscriptions() {
    // The RPC port is closed: the tracker retries with backoff and nothing is published.
    let s = Harness::start(limits()).await;
    let failed = logged(|v| v["event"] == "mempool_poll_failed" && v["network"] == "regtest").await;
    assert_eq!(failed["error"], "unavailable");
    let mut ws = s.connect().await;
    ws.json().await;
    ws.send(json!({"op": "subscribe",
        "topics": ["mempool", "projected", "transactions", "projected-txs:0", "projected-txs:6"]}))
        .await;
    ws.send(json!({"op": "ping"})).await;
    assert_eq!(
        ws.json().await,
        json!({"type": "pong"}),
        "no state before the first cycle"
    );
    ws.send(json!({"op": "subscribe", "topics": ["projected-txs:1"]}))
        .await;
    assert_eq!(
        ws.close_code().await,
        (4001, "too many subscriptions".into())
    );
}

#[tokio::test]
async fn the_mempool_switch_turns_the_topics_off() {
    let s = Harness::start_vars(
        limits(),
        Duration::from_secs(2),
        &[("REGTEST_MEMPOOL_ENABLED", "false")],
    )
    .await;
    let mut ws = s.connect().await;
    ws.json().await;
    ws.send(json!({"op": "subscribe", "topics": ["mempool", "projected-txs:3"]}))
        .await;
    assert_eq!(ws.json().await, json!({"topic": "mempool", "type": "off"}));
    assert_eq!(
        ws.json().await,
        json!({"topic": "projected-txs:3", "type": "off"})
    );
}

#[tokio::test]
async fn only_this_site_may_open_a_socket_from_a_browser() {
    let s = Harness::start(limits()).await;
    let up = |headers: &'static str| {
        let addr = s.addr.clone();
        async move {
            let stream = TcpStream::connect(addr).await.unwrap();
            Ws::upgrade(stream, "/regtest/app/ws", headers).await
        }
    };
    // The app's own page, as the browser tests and a reverse proxy that passes Host send it.
    let port = s.addr.rsplit(':').next().unwrap().to_owned();
    let own = format!("Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n");
    let stream = TcpStream::connect(&s.addr).await.unwrap();
    let mut ws = Ws::upgrade(stream, "/regtest/app/ws", &own).await.unwrap();
    assert_eq!(ws.json().await["type"], "hello");
    assert!(
        up("Host: explorer.example\r\nOrigin: https://explorer.example\r\n")
            .await
            .is_ok()
    );
    // Not a browser: no Origin at all.
    assert!(up("Host: test\r\n").await.is_ok());
    // Another site's page: refused before it takes a socket slot, and said so in the log.
    let evil = "Host: explorer.example\r\nOrigin: https://evil.example\r\n";
    let stream = TcpStream::connect(&s.addr).await.unwrap();
    let (status, refused) = Ws::refused(stream, evil).await;
    assert_eq!(status, "HTTP/1.1 403 Forbidden");
    assert_eq!(refused["status"], 403);
    assert_eq!(refused["refused"], "origin");
    for headers in [
        "Host: explorer.example\r\nOrigin: null\r\n",
        "Host: 127.0.0.1:1\r\nOrigin: http://127.0.0.1:2\r\n",
    ] {
        assert_eq!(
            up(headers).await.err().unwrap(),
            "HTTP/1.1 403 Forbidden",
            "{headers}"
        );
    }
    // Another test refuses an origin too; only this one sends this host.
    let event = logged(|v| {
        v["event"] == "ws_origin_refused" && v["host"] == "explorer.example" && v["total"] == 1
    })
    .await;
    assert_eq!(event["origin"], "https://evil.example");
}

#[tokio::test]
async fn hostile_frames_and_upgrades_close_with_their_codes() {
    // The cases of the acceptance check's abuse script that the tests above do not already pin.
    let s = Harness::start(limits()).await;
    let many_topics = json!({"op": "subscribe", "topics": vec!["blocks"; 10_000]}).to_string();
    let deep = format!("{}{}", "[".repeat(500), "]".repeat(500));
    let mut huge_length = vec![0x81, 0xFF];
    huge_length.extend_from_slice(&(u64::MAX >> 1).to_be_bytes());
    let cases: Vec<(&str, Vec<u8>, u16)> = vec![
        ("reserved bits", masked(0xF1, br#"{"op":"ping"}"#), 1002),
        ("opcode 3", masked(0x83, b"x"), 1002),
        ("fragmented ping", masked(0x09, b"x"), 1002),
        ("continuation first", masked(0x80, b"x"), 1002),
        ("length 2^63 - 1", huge_length, 1009),
        ("10,000 topics", masked(0x81, many_topics.as_bytes()), 1009),
        ("deep JSON", masked(0x81, deep.as_bytes()), 4000),
        (
            "prototype key",
            masked(0x81, br#"{"op":"subscribe","topics":["__proto__"]}"#),
            4000,
        ),
        ("unknown op", masked(0x81, br#"{"op":"x"}"#), 4000),
    ];
    for (name, bytes, code) in cases {
        let mut ws = s.connect().await;
        ws.json().await;
        ws.send_raw(&bytes).await;
        assert_eq!(ws.close_code().await.0, code, "{name}");
    }
    // Subscribing to the same topic more times than the subscription cap is one subscription:
    // the ping after them is answered, not a close.
    let mut ws = s.connect().await;
    ws.json().await;
    for _ in 0..9 {
        ws.send(json!({"op": "subscribe", "topics": ["blocks"]}))
            .await;
    }
    ws.send(json!({"op": "ping"})).await;
    loop {
        match ws.recv_raw().await.0 {
            Msg::Close(code, _) => panic!("closed with {code}"),
            Msg::Text(t) if t == br#"{"type":"pong"}"# => break,
            _ => {}
        }
    }
    // Upgrades with a missing key, a key that is not 16 bytes of base64, or another version: 400.
    for head in [
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13",
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: !!!!\r\nSec-WebSocket-Version: 13",
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 12",
    ] {
        let mut stream = TcpStream::connect(&s.addr).await.unwrap();
        let req = format!(
            "GET /regtest/app/ws HTTP/1.1\r\nHost: t\r\nConnection: close\r\n{head}\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply).await;
        assert!(reply.starts_with("HTTP/1.1 400"), "{head}: {reply}");
    }
}

// The mempool.space-shaped socket at `/api/v1/ws`.

impl Harness {
    async fn v1(&self) -> Ws {
        Ws::connect(&self.addr, "/regtest/api/v1/ws").await
    }

    async fn v1_from(&self, origin: &str) -> Result<Ws, String> {
        let stream = TcpStream::connect(&self.addr).await.unwrap();
        let headers = format!("Host: test\r\nOrigin: {origin}\r\n");
        Ws::upgrade(stream, "/regtest/api/v1/ws", &headers).await
    }
}

impl Ws {
    /// The next message that has `key`, skipping the others (`stats`, `mempool-blocks`).
    async fn with_key(&mut self, key: &str) -> Value {
        loop {
            let v = self.json().await;
            if v.get(key).is_some() {
                return v;
            }
        }
    }
}

#[tokio::test]
async fn v1_want_then_blocks_in_the_reference_shape() {
    let mut s = Harness::start(limits()).await;
    let mut ws = s.v1().await;
    // No greeting: the first frame is the answer to the first message.
    ws.send(json!({"action": "ping"})).await;
    assert_eq!(ws.json().await, json!({"pong": true}));
    // The node's recent blocks are read once, after the first block: a socket that wanted
    // them before has the tip alone, then the whole list when it is read.
    let mut probe = s.v1().await;
    probe
        .send(json!({"action": "want", "data": ["blocks"]}))
        .await;
    let list = loop {
        let list = probe.with_key("blocks").await["blocks"].clone();
        if list.as_array().unwrap().len() == 3 {
            break list;
        }
    };
    // Oldest first, ending at the tip, each the node's own JSON.
    let heights: Vec<u64> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["height"].as_u64().unwrap())
        .collect();
    assert_eq!(heights, [0, 1, 2]);
    assert_eq!(
        list[2],
        s.blocks.lock().unwrap()[&s.h[2].block_hash().to_string()]
    );

    ws.send(json!({"action": "want", "data": ["blocks", "stats", "mempool-blocks", "nonsense"]}))
        .await;
    assert_eq!(ws.with_key("blocks").await["blocks"], list);
    let next = chain(s.h[2].block_hash(), 1, 7)[0];
    s.mine(3, &next).await;
    let block = ws.with_key("block").await;
    let id = next.block_hash().to_string();
    assert_eq!(block, json!({"block": s.blocks.lock().unwrap()[&id]}));
    // A later subscriber's list ends at the new block.
    let mut late = s.v1().await;
    late.send(json!({"action": "want", "data": ["blocks"]}))
        .await;
    let list = late.with_key("blocks").await;
    let list = list["blocks"].as_array().unwrap().clone();
    assert_eq!(list.last().unwrap()["id"], id.as_str());
    assert!(list.len() <= 8);
    // Wanting nothing stops the blocks.
    ws.send(json!({"action": "want", "data": []})).await;
    let after = chain(next.block_hash(), 1, 8)[0];
    s.mine(4, &after).await;
    late.with_key("block").await;
    ws.send(json!({"action": "ping"})).await;
    assert_eq!(ws.with_key("pong").await, json!({"pong": true}));
}

#[tokio::test]
async fn v1_sockets_have_their_own_allowance_and_any_origin() {
    let s = Harness::start(WsLimits {
        max_sockets: 3,
        client_max_sockets: 2,
        v1_max_sockets: 3,
        v1_client_max_sockets: 2,
        ..limits()
    })
    .await;
    // Another site's page may open the public socket, up to its own allowance.
    let _a = s.v1_from("https://evil.example").await.unwrap();
    let _b = s.v1_from("https://evil.example").await.unwrap();
    assert_eq!(
        s.v1_from("https://evil.example").await.err().unwrap(),
        "HTTP/1.1 429 Too Many Requests"
    );
    let refused =
        logged(|v| v["event"] == "http_request" && v["refused"] == "v1_client_sockets").await;
    assert_eq!(refused["route"], "/regtest/api/v1/ws");
    // Our own pages still have every one of theirs, and other sites still cannot use them.
    let _c = s.connect().await;
    let _d = s.connect().await;
    let stream = TcpStream::connect(&s.addr).await.unwrap();
    assert_eq!(
        Ws::connect_stream(stream, "/regtest/app/ws")
            .await
            .err()
            .unwrap(),
        "HTTP/1.1 429 Too Many Requests"
    );
    let stream = TcpStream::connect(&s.addr).await.unwrap();
    let evil = "Host: test\r\nOrigin: https://evil.example\r\n";
    assert_eq!(
        Ws::upgrade(stream, "/regtest/app/ws", evil)
            .await
            .err()
            .unwrap(),
        "HTTP/1.1 403 Forbidden"
    );
    assert_eq!(s.sockets.open(), 4);
}

#[tokio::test]
async fn v1_messages_are_answered_like_the_reference_within_our_limits() {
    let s = Harness::start(WsLimits {
        max_message_bytes: 256,
        messages_per_sec: 5,
        ..limits()
    })
    .await;
    // Not JSON closes, as on the reference.
    let mut ws = s.v1().await;
    ws.send_frame(0x81, b"hello").await;
    assert_eq!(ws.close_code().await, (4000, "bad message".to_owned()));
    // JSON it does not understand is left unanswered and the socket stays; the heavy topics
    // say they are not served.
    let mut ws = s.v1().await;
    for m in [
        json!([1, 2]),
        json!({"bogus": 1}),
        json!({"action": "want", "data": "blocks"}),
        json!({"track-tx": "zz"}),
    ] {
        ws.send(m).await;
    }
    ws.send(json!({"track-mempool": true})).await;
    assert_eq!(
        ws.json().await,
        json!({"track-mempool-error": "not served by this server"})
    );
    // Too big, from the frame header.
    let mut ws = s.v1().await;
    ws.send_frame(0x81, &[b' '; 257]).await;
    assert_eq!(ws.close_code().await.0, 1009);
    // A flood.
    let mut ws = s.v1().await;
    for _ in 0..6 {
        ws.send(json!({"action": "ping"})).await;
    }
    assert_eq!(
        ws.close_code().await,
        (4002, "too many messages".to_owned())
    );
    let closed =
        logged(|v| v["event"] == "ws_closed" && v["api"] == "v1" && v["code"] == 4002).await;
    assert_eq!(closed["network"], "regtest");
}

#[tokio::test]
async fn v1_a_slow_reader_is_dropped_while_others_keep_receiving() {
    let mut s = Harness::start(WsLimits {
        send_queue: 2,
        ..limits()
    })
    .await;
    let pad = "x".repeat(256 * 1024);
    let slow_socket = TcpSocket::new_v4().unwrap();
    slow_socket.set_recv_buffer_size(4096).unwrap();
    let stream = slow_socket.connect(s.addr.parse().unwrap()).await.unwrap();
    let mut slow = Ws::connect_stream(stream, "/regtest/api/v1/ws")
        .await
        .unwrap();
    slow.send(json!({"action": "want", "data": ["blocks"]}))
        .await;
    let mut fast = s.v1().await;
    fast.send(json!({"action": "want", "data": ["blocks"]}))
        .await;
    fast.with_key("blocks").await;

    let blocks = chain(s.h[2].block_hash(), 40, 9);
    for (i, header) in blocks.iter().enumerate() {
        let height = 3 + i as u32;
        let id = header.block_hash().to_string();
        let prev = header.prev_blockhash.to_string();
        s.blocks.lock().unwrap().insert(
            id.clone(),
            json!({"id": id, "height": height, "previousblockhash": prev, "pad": pad}),
        );
        s.peer.push_tip(height, header).await;
        assert_eq!(fast.with_key("block").await["block"]["height"], height);
    }
    logged(|v| v["event"] == "ws_closed" && v["api"] == "v1" && v["code"] == 4003).await;
    drop(slow);
}

/// Every line logged so far.
fn all_logged() -> Vec<Value> {
    logging::flush(Duration::from_secs(1));
    let raw = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    raw.lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[tokio::test]
async fn refused_upgrades_and_oversized_messages_write_a_bounded_log() {
    const UPGRADES: usize = 200;
    const MESSAGES: usize = 40;
    let mut s = Harness::start(WsLimits {
        client_max_sockets: 1,
        max_message_bytes: 64,
        ..limits()
    })
    .await;
    let _held = s.connect().await;
    for _ in 0..UPGRADES {
        let stream = TcpStream::connect(&s.addr).await.unwrap();
        assert!(Ws::connect_stream(stream, "/regtest/app/ws").await.is_err());
    }
    drop(_held);
    for _ in 0..MESSAGES {
        let deadline = Instant::now() + WAIT;
        let mut ws = loop {
            let stream = TcpStream::connect(&s.addr).await.unwrap();
            if let Ok(ws) = Ws::connect_stream(stream, "/regtest/app/ws").await {
                break ws;
            }
            assert!(Instant::now() < deadline, "the slot was never freed");
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        ws.json().await;
        ws.send_frame(0x81, &[b' '; 65]).await;
        assert_eq!(ws.close_code().await.0, 1009);
    }
    s.stop.take().unwrap().send(()).unwrap();
    timeout(WAIT, &mut s.served).await.unwrap().unwrap();

    // Counted in one summary, written at shutdown; at most one refusal line per server.
    let lines = all_logged();
    let summary = lines
        .iter()
        .find(|v| {
            v["event"] == "requests_refused"
                && v["reasons"]["client_sockets"].as_u64() >= Some(UPGRADES as u64)
        })
        .expect("a summary of the refused upgrades");
    assert_eq!(summary["routes"]["ws"], summary["total"]);
    assert_eq!(summary["clients"], 1);
    // Other tests in this binary refuse sockets too, each on its own server: one line each.
    let refused = lines
        .iter()
        .filter(|v| v["event"] == "http_request" && v["refused"] == "client_sockets")
        .count();
    assert!(refused <= 3, "{refused} refused upgrades written");
    // Oversized messages: a line at the 1st, 2nd, 4th… drop, never one each. Other tests drop
    // two at most, so the lines past a total of 2 are this server's: 4, 8, 16 and 32 of 40.
    let totals: Vec<u64> = lines
        .iter()
        .filter(|v| v["event"] == "ws_clients_dropped" && v["reason"] == "too_big")
        .map(|v| v["total"].as_u64().unwrap())
        .collect();
    assert!(totals.iter().all(|t| t.is_power_of_two()), "{totals:?}");
    assert_eq!(totals.iter().filter(|t| **t > 2).count(), 4, "{totals:?}");
}

/// A regtest address of its own for each `n`: a made-up witness script hash.
fn address(n: u32) -> String {
    let mut bytes = [7u8; 32];
    bytes[..4].copy_from_slice(&n.to_be_bytes());
    let script = bitcoin::ScriptBuf::new_p2wsh(&bitcoin::WScriptHash::from_byte_array(bytes));
    bitcoin::Address::from_script(&script, bitcoin::Network::Regtest)
        .unwrap()
        .to_string()
}

/// Answers the Electrum peer's address subscribes until `until`, and counts them: the node's work.
async fn count_subscribes(peer: &mut Peer, until: Instant) -> usize {
    let mut subscribes = 0;
    while let Ok(Ok(Some(line))) =
        tokio::time::timeout_at(until.into(), peer.lines.next_line()).await
    {
        let req: Value = serde_json::from_str(&line).unwrap();
        match req["method"].as_str().unwrap() {
            "blockchain.scripthash.subscribe" => {
                subscribes += 1;
                peer.reply(&req, Value::Null).await;
            }
            _ => peer.reply(&req, json!(true)).await,
        }
    }
    subscribes
}

/// One client address with as many sockets as it may open, each following two fresh addresses
/// in every message at the full message rate for `secs`: on `/app/ws` subscribe two, then
/// unsubscribe them; on `/api/v1/ws` a new `track-addresses` pair, which replaces the last.
/// Returns the sockets.
async fn follow_flood(addr: String, path: &'static str, secs: u64) -> Vec<Ws> {
    let app = path.ends_with("app/ws");
    let mut sent = Vec::new();
    for i in 0..if app { 16 } else { 4 } {
        let mut ws = Ws::connect(&addr, path).await;
        sent.push(tokio::spawn(async move {
            let end = Instant::now() + Duration::from_secs(secs);
            let mut n = 0;
            while Instant::now() < end {
                let pair = [address(i << 16 | n), address(i << 16 | (n + 1))];
                n += 2;
                if app {
                    let topics = pair.map(|a| format!("address:{a}"));
                    ws.send(json!({"op": "subscribe", "topics": topics})).await;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    ws.send(json!({"op": "unsubscribe", "topics": topics}))
                        .await;
                } else {
                    ws.send(json!({"track-addresses": pair})).await;
                }
                // One message each 100 ms: exactly `WS_MESSAGES_PER_SEC`, never over it.
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            ws
        }));
    }
    let mut out = Vec::new();
    for t in sent {
        out.push(t.await.unwrap());
    }
    out
}

/// Floods `path` from one client address for three seconds with the default per-client
/// limits, and returns the node's work: subscribes and history reads, the time taken, the
/// sockets and the server.
async fn flood(path: &'static str) -> (usize, usize, f64, Vec<Ws>, Harness) {
    const SECS: u64 = 3;
    // A `CLIENT_` variable keeps the default per-client limits, which the budget comes from.
    let mut s =
        Harness::start_vars(limits(), Duration::from_secs(2), &[("CLIENT_BURST", "120")]).await;
    let started = Instant::now();
    let flood = tokio::spawn(follow_flood(s.addr.clone(), path, SECS));
    let subscribes = count_subscribes(&mut s.peer, started + Duration::from_secs(SECS + 1)).await;
    let socks = flood.await.unwrap();
    let elapsed = started.elapsed().as_secs_f64();
    let reads = s
        .misses
        .lock()
        .unwrap()
        .get("history")
        .copied()
        .unwrap_or(0) as usize;
    eprintln!(
        "{path}: {subscribes} subscribes and {reads} history reads in {elapsed:.1} s from one client address"
    );
    // 30 at once, then 2 a second (docs/CONFIG.md, "Address and batch routes").
    assert!(
        (subscribes + reads) as f64 <= 30.0 + 2.0 * elapsed + 1.0,
        "{subscribes} subscribes and {reads} reads in {elapsed:.1} s"
    );
    (subscribes, reads, elapsed, socks, s)
}

/// The refusals were counted in the summary written at shutdown, never one line each.
async fn refusals_summarised(mut s: Harness) {
    s.stop.take().unwrap().send(()).unwrap();
    timeout(WAIT, &mut s.served).await.unwrap().unwrap();
    let summary = logged(|v| {
        v["event"] == "requests_refused" && v["reasons"]["follow_rate"].as_u64() > Some(0)
    })
    .await;
    assert!(summary["routes"]["ws"].as_u64() > Some(0), "{summary}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_client_starts_new_address_follows_only_at_its_budget() {
    let (subscribes, _, _, mut socks, s) = flood("/regtest/app/ws").await;
    assert!(subscribes >= 30, "the budget's burst is served");
    // Each socket is still open and usable, and was told why.
    for ws in &mut socks {
        ws.send(json!({"op": "ping"})).await;
        loop {
            let v = ws.json().await;
            if v["type"] == "pong" {
                break;
            }
            assert!(
                v["type"] == "hello"
                    || v["type"] == "address"
                    || (v["type"] == "refused" && v["reason"] == "follow_rate"),
                "{v}"
            );
        }
    }
    drop(socks);
    refusals_summarised(s).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v1_one_client_starts_new_address_follows_only_at_its_budget() {
    let (subscribes, reads, _, mut socks, s) = flood("/regtest/api/v1/ws").await;
    // A first follow is a subscribe and a history read: two of the client's tokens.
    assert!(subscribes > 0 && reads > 0);
    for ws in &mut socks {
        ws.send(json!({"action": "ping"})).await;
        loop {
            let v = ws.json().await;
            if v == json!({"pong": true}) {
                break;
            }
            assert_eq!(
                v,
                json!({"track-addresses-error": "too many new addresses from this client; retry in a moment"})
            );
        }
    }
    drop(socks);
    refusals_summarised(s).await;
}

/// A client that never reads but keeps pinging, so it is never idle, on a busy feed: once its
/// buffers are full the server's writes stall, and it is dropped within `REQUEST_TIMEOUT_SECS`
/// of that, whatever its send queue still holds (docs/WS.md, "Close codes").
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_never_reads_but_pings_is_dropped_once_its_writes_stall() {
    let timeout_secs = 2;
    let mut s = Harness::start_with(limits(), Duration::from_secs(timeout_secs)).await;
    let sock = TcpSocket::new_v4().unwrap();
    sock.set_recv_buffer_size(4096).unwrap();
    let stream = sock.connect(s.addr.parse().unwrap()).await.unwrap();
    let mut ws = Ws::connect_stream(stream, "/regtest/app/ws").await.unwrap();
    ws.send(json!({"op": "subscribe", "topics": ["blocks"]}))
        .await;
    let pinging = tokio::spawn(async move {
        loop {
            ws.send(json!({"op": "ping"})).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    });
    let pad = "x".repeat(256 * 1024);
    let started = Instant::now();
    let served = || s.misses.lock().unwrap().get("served").copied().unwrap_or(0);
    let blocks = chain(s.h[2].block_hash(), 400, 5);
    for (i, header) in blocks.iter().enumerate() {
        if s.sockets.open() == 0 {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(30), "never dropped");
        let height = 3 + i as u32;
        let id = header.block_hash().to_string();
        s.blocks
            .lock()
            .unwrap()
            .insert(id.clone(), json!({"id": id, "height": height, "pad": pad}));
        // Each next tip once the hub has fetched this one, so every block goes out whole. Pushed on
        // a timer instead, a machine slow enough for the hub to fall behind turned the feed into
        // small `resync` messages that never filled the buffers.
        let before = served();
        s.peer.push_tip(height, header).await;
        while served() == before && s.sockets.open() > 0 {
            assert!(started.elapsed() < Duration::from_secs(30), "never dropped");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    pinging.abort();
    // Dropped, though its pings keep it from ever being idle. How soon depends on how fast the
    // machine fills the buffers before the write timeout starts, so only the 30 s guard above.
    assert_eq!(s.sockets.open(), 0, "dropped");
}
