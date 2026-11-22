//! JSON-RPC client for rbitcoin: a fixed set of typed, read-only methods.
//!
//! No caller outside this module can name an RPC method or pass raw parameters: each method
//! below sends one fixed method name with typed parameters. There are no write methods;
//! broadcast goes through Esplora (`SECURITY.md` rule 4).
//!
//! Every call is bounded by [`Limits`]: a timeout, a response-size cap, and a cap on our own
//! in-flight calls, kept well under the node's 16-slot work queue. If the queue is full anyway
//! the node answers 503 and the call fails with [`Error::Busy`]: back off and retry later.
//!
//! The password is turned into the `Authorization` header once, in [`Rpc::new`], and that
//! header is marked sensitive. No field, `Debug` output or error holds it.

pub mod model;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use bitcoin::{BlockHash, OutPoint, Transaction, Txid};
use hyper::header::HeaderValue;
use hyper::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::http::{self, Endpoint, Transport};
use model::{
    Block, BlockHeader, BlockStats, BlockTemplate, BlockTotals, BlockchainInfo, ChainTip,
    ChunkPoint, Cluster, MempoolEntry, MempoolInfo, MiningInfo, NetworkInfo, PrevoutBlock,
    PrevoutSpend, RawMempool, SmartFee,
};

/// Longest node error message we keep.
const MAX_MESSAGE: usize = 512;

/// Most outpoints [`Rpc::tx_spending_prevout`] takes in one call: about 85 KB of request.
pub const MAX_PREVOUTS: usize = 1000;

/// Most txids [`Rpc::mempool_entries`] and [`Rpc::raw_transactions`] take in one call.
/// A mainnet batch of 1,000 raw transactions measured 5 MB and 305 ms.
pub const MAX_BATCH: usize = 1000;

/// What went wrong with an RPC call, in terms a caller can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The host or port given to [`Rpc::new`] is not usable.
    Config(&'static str),
    /// 401 or 403: the node refused the user and password.
    Auth,
    /// The node answered with a JSON-RPC error, for example `-5` for a transaction that is
    /// not in the mempool, or `-8` for a height past the tip.
    Rpc { code: i64, message: String },
    /// 503: the node's RPC work queue is full. Back off.
    Busy,
    /// Connection failure, or an HTTP status that carried no JSON-RPC error.
    Unavailable(String),
    /// The call did not complete within the configured timeout, waiting for a local slot
    /// included.
    Timeout,
    /// The response body exceeded the configured size cap.
    ResponseTooBig,
    /// More inputs than one call takes, such as over [`MAX_PREVOUTS`] outpoints. Nothing was sent.
    RequestTooBig,
    /// The response did not decode into the expected type.
    Decode(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(m) => write!(f, "invalid rpc endpoint: {m}"),
            Self::Auth => f.write_str("rpc authentication failed"),
            Self::Rpc { code, message } => write!(f, "rpc error {code}: {message}"),
            Self::Busy => f.write_str("rpc work queue full"),
            Self::Unavailable(m) => write!(f, "rpc unavailable: {m}"),
            Self::Timeout => f.write_str("rpc request timed out"),
            Self::ResponseTooBig => f.write_str("rpc response too big"),
            Self::RequestTooBig => f.write_str("rpc request too big"),
            Self::Decode(m) => write!(f, "rpc response did not decode: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<http::Error> for Error {
    fn from(e: http::Error) -> Self {
        match e {
            http::Error::Config(m) => Self::Config(m),
            http::Error::Unavailable(m) => Self::Unavailable(m),
            http::Error::Timeout => Self::Timeout,
            http::Error::ResponseTooBig => Self::ResponseTooBig,
        }
    }
}

/// Bounds on every call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Covers waiting for a local slot, then connecting, the request and reading the body.
    pub timeout: Duration,
    /// Fits `getrawmempool` for a full 300 MB mempool, and `getblocktemplate`.
    pub max_response_bytes: usize,
    /// Our calls in flight at once. The node holds 16 and answers 503 beyond that.
    pub max_concurrent: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            max_response_bytes: 64 << 20,
            max_concurrent: 4,
        }
    }
}

/// Which block [`Rpc::block_stats`] reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum BlockRef {
    Height(u32),
    Hash(BlockHash),
}

/// A client for one node's JSON-RPC listener. Cheap to clone; clones share the connection
/// pool and the concurrency limit.
#[derive(Clone)]
pub struct Rpc {
    transport: Transport,
    slots: Arc<Semaphore>,
    timeout: Duration,
    /// `host:port`, for `Debug`.
    authority: Arc<str>,
}

impl fmt::Debug for Rpc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Rpc")
            .field("authority", &self.authority)
            .finish_non_exhaustive()
    }
}

impl Rpc {
    /// `host`, `port`, `user` and `password` are `{NET}_RPC_*`. Authenticates with HTTP Basic,
    /// which rbitcoin accepts when it runs with `--rpc-cookie-file`.
    pub fn new(host: &str, port: u16, user: &str, password: &str) -> Result<Self, Error> {
        Self::with_limits(host, port, user, password, Limits::default())
    }

    pub fn with_limits(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        limits: Limits,
    ) -> Result<Self, Error> {
        let host = host.trim();
        if host.is_empty() || host.contains(['/', '@', '?', '#']) {
            return Err(Error::Config("bad host"));
        }
        // A bare IPv6 address needs brackets in a URL.
        let authority = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        if user.contains(':') {
            return Err(Error::Config("the user name cannot contain ':'"));
        }
        if limits.max_concurrent == 0 {
            return Err(Error::Config("max_concurrent must be at least 1"));
        }
        let mut basic = String::from("Basic ");
        base64(format!("{user}:{password}").as_bytes(), &mut basic);
        let header = HeaderValue::try_from(basic)
            .map_err(|_| Error::Config("credentials do not fit in a header"))?;
        let endpoint = Endpoint::Tcp {
            origin: format!("http://{authority}"),
            base_path: String::new(),
        };
        Ok(Self {
            transport: Transport::new(&endpoint, limits.timeout, limits.max_response_bytes)
                .with_authorization(header),
            slots: Arc::new(Semaphore::new(limits.max_concurrent)),
            timeout: limits.timeout,
            authority: authority.into(),
        })
    }

    /// Response body bytes this client and its clones have read, for cost accounting.
    pub fn bytes_received(&self) -> u64 {
        self.transport.bytes_received()
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: &'static str,
        params: impl Serialize,
    ) -> Result<T, Error> {
        let body = serde_json::to_vec(&Request {
            jsonrpc: "1.0",
            id: 0,
            method,
            params,
        })
        .map_err(|_| Error::Config("request did not encode"))?;
        let (status, body) = self.post(body).await?;
        decode(status, &body)
    }

    /// One JSON-RPC array of `method` calls, one per item of `params`: one HTTP request and one
    /// node work-queue slot. Each answer is the call's own result or error, in input order.
    async fn batch<T: DeserializeOwned, P: Serialize>(
        &self,
        method: &'static str,
        params: impl ExactSizeIterator<Item = P>,
    ) -> Result<Vec<Result<T, Error>>, Error> {
        let n = params.len();
        if n > MAX_BATCH {
            return Err(Error::RequestTooBig);
        }
        if n == 0 {
            return Ok(Vec::new());
        }
        let calls: Vec<Request<P>> = params
            .enumerate()
            .map(|(id, params)| Request {
                // JSON-RPC 2.0 defines batches; 1.0 has none.
                jsonrpc: "2.0",
                id,
                method,
                params,
            })
            .collect();
        let body =
            serde_json::to_vec(&calls).map_err(|_| Error::Config("request did not encode"))?;
        let (status, body) = self.post(body).await?;
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(Error::Auth),
            StatusCode::SERVICE_UNAVAILABLE => return Err(Error::Busy),
            _ => {}
        }
        let answers: Vec<Answer<T>> = match serde_json::from_slice(&body) {
            Ok(a) => a,
            // Not an array of answers: a whole-request failure, read like a single call's.
            Err(e) => {
                return Err(decode::<serde::de::IgnoredAny>(status, &body)
                    .err()
                    .unwrap_or(Error::Decode(e.to_string())));
            }
        };
        let mut out: Vec<Option<Result<T, Error>>> =
            std::iter::repeat_with(|| None).take(n).collect();
        for a in answers {
            let result = match a {
                Answer { error: Some(e), .. } => Err(Error::Rpc {
                    code: e.code,
                    message: truncate(e.message),
                }),
                Answer {
                    result: Some(r), ..
                } => Ok(r),
                _ => Err(Error::Decode("no result and no error".into())),
            };
            match out.get_mut(a.id) {
                Some(slot @ None) => *slot = Some(result),
                _ => return Err(Error::Decode("batch answer ids do not match".into())),
            }
        }
        out.into_iter()
            .map(|r| r.ok_or_else(|| Error::Decode("batch answer missing".into())))
            .collect()
    }

    /// Sends one JSON-RPC body within the slot limit and the timeout.
    async fn post(&self, body: Vec<u8>) -> Result<(StatusCode, bytes::Bytes), Error> {
        let started = tokio::time::Instant::now();
        let _slot = tokio::time::timeout(self.timeout, self.slots.acquire())
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Unavailable("client closed".into()))?;
        // The slot wait counts against the same timeout.
        let left = self.timeout.saturating_sub(started.elapsed());
        let res = tokio::time::timeout(
            left,
            self.transport
                .send(Method::POST, "/", Some((body.into(), "application/json"))),
        )
        .await
        .map_err(|_| Error::Timeout)??;
        Ok((res.status, res.body))
    }

    // Chain.

    /// `getblockchaininfo`.
    pub async fn blockchain_info(&self) -> Result<BlockchainInfo, Error> {
        self.call("getblockchaininfo", NO_PARAMS).await
    }

    /// `getblockheader`, verbose. Unknown hash: `Rpc { code: -5 }`.
    pub async fn block_header(&self, hash: BlockHash) -> Result<BlockHeader, Error> {
        self.call("getblockheader", (hash, true)).await
    }

    /// `getblock` with verbosity 2: every transaction's txid, fee and size. About 11 MB for a
    /// full mainnet block. Unknown hash: `Rpc { code: -5 }`.
    pub async fn block(&self, hash: BlockHash) -> Result<Block, Error> {
        self.call("getblock", (hash, 2)).await
    }

    /// `getblock` with verbosity 3: every output and every input's spent output, with values and
    /// scripts ([`PrevoutBlock`]). Larger than verbosity 2 (604 KB for a 156-transaction signet
    /// block). Unknown hash: `Rpc { code: -5 }`.
    pub async fn block_with_prevouts(&self, hash: BlockHash) -> Result<PrevoutBlock, Error> {
        self.call("getblock", (hash, 3)).await
    }

    /// `getblockhash`. Past the tip: `Rpc { code: -8 }`.
    pub async fn block_hash(&self, height: u32) -> Result<BlockHash, Error> {
        self.call("getblockhash", [height]).await
    }

    /// `getblockstats` with every stat. Past the tip: `Rpc { code: -8 }`.
    pub async fn block_stats(&self, block: BlockRef) -> Result<BlockStats, Error> {
        self.call("getblockstats", [block]).await
    }

    /// [`BlockTotals`] for each block, in one batch of at most [`MAX_BATCH`]. The node works
    /// through a batch one call after another in one slot, so keep a batch's total time well
    /// under the timeout. An unknown hash answers `Err(Rpc { code: -5 })` in its slot.
    pub async fn block_totals(
        &self,
        hashes: &[BlockHash],
    ) -> Result<Vec<Result<BlockTotals, Error>>, Error> {
        const STATS: [&str; 3] = ["totalfee", "subsidy", "total_weight"];
        self.batch("getblockstats", hashes.iter().map(|h| (h, STATS)))
            .await
    }

    /// `getchaintips`.
    pub async fn chain_tips(&self) -> Result<Vec<ChainTip>, Error> {
        self.call("getchaintips", NO_PARAMS).await
    }

    /// `getdifficulty`.
    pub async fn difficulty(&self) -> Result<f64, Error> {
        self.call("getdifficulty", NO_PARAMS).await
    }

    /// `getnetworkhashps` over the `blocks` blocks ending at `height` (the tip when `None`).
    /// `blocks == 0` means since the last difficulty change.
    pub async fn network_hash_ps(&self, blocks: u32, height: Option<u32>) -> Result<f64, Error> {
        let height = height.map_or(-1, i64::from);
        self.call("getnetworkhashps", (blocks, height)).await
    }

    /// `getmininginfo`.
    pub async fn mining_info(&self) -> Result<MiningInfo, Error> {
        self.call("getmininginfo", NO_PARAMS).await
    }

    // Mempool.

    /// `getmempoolinfo`.
    pub async fn mempool_info(&self) -> Result<MempoolInfo, Error> {
        self.call("getmempoolinfo", NO_PARAMS).await
    }

    /// `getrawmempool` as a txid list with its `mempool_sequence`. The verbose form is
    /// deliberately missing: on mainnet it takes seconds and tens of megabytes.
    pub async fn raw_mempool(&self) -> Result<RawMempool, Error> {
        self.call("getrawmempool", (false, true)).await
    }

    /// `getmempoolentry`. Not in the mempool: `Rpc { code: -5 }`.
    pub async fn mempool_entry(&self, txid: Txid) -> Result<MempoolEntry, Error> {
        self.call("getmempoolentry", [txid]).await
    }

    /// `getmempoolentry` for each txid, in one batch of at most [`MAX_BATCH`]. A txid no longer
    /// in the mempool answers `Err(Rpc { code: -5 })` in its slot.
    pub async fn mempool_entries(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Result<MempoolEntry, Error>>, Error> {
        self.batch("getmempoolentry", txids.iter().map(|t| [t]))
            .await
    }

    /// `getrawtransaction` (not verbose) for each txid, in one batch of at most [`MAX_BATCH`].
    /// Finds mempool and confirmed transactions; an unknown txid answers `Err(Rpc { code: -5 })`.
    pub async fn raw_transactions(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Result<Transaction, Error>>, Error> {
        let hex: Vec<Result<String, Error>> = self
            .batch("getrawtransaction", txids.iter().map(|t| (t, false)))
            .await?;
        Ok(hex
            .into_iter()
            .map(|r| {
                r.and_then(|h| {
                    bitcoin::consensus::encode::deserialize_hex(&h)
                        .map_err(|e| Error::Decode(e.to_string()))
                })
            })
            .collect())
    }

    /// `getmempoolcluster`: the cluster `txid` is in. Not in the mempool: `Rpc { code: -5 }`.
    pub async fn mempool_cluster(&self, txid: Txid) -> Result<Cluster, Error> {
        self.call("getmempoolcluster", [txid]).await
    }

    /// `getmempoolcluster` for each txid, in one batch of at most [`MAX_BATCH`]. A txid no longer
    /// in the mempool answers `Err(Rpc { code: -5 })` in its slot.
    pub async fn mempool_clusters(
        &self,
        txids: &[Txid],
    ) -> Result<Vec<Result<Cluster, Error>>, Error> {
        self.batch("getmempoolcluster", txids.iter().map(|t| [t]))
            .await
    }

    /// `getmempoolancestors`: the in-mempool ancestors of `txid`, without it.
    /// Not in the mempool: `Rpc { code: -5 }`.
    pub async fn mempool_ancestors(&self, txid: Txid) -> Result<Vec<Txid>, Error> {
        self.call("getmempoolancestors", (txid, false)).await
    }

    /// `getmempooldescendants`: the in-mempool descendants of `txid`, without it.
    /// Not in the mempool: `Rpc { code: -5 }`.
    pub async fn mempool_descendants(&self, txid: Txid) -> Result<Vec<Txid>, Error> {
        self.call("getmempooldescendants", (txid, false)).await
    }

    /// `getmempoolfeeratediagram`: every mining chunk in the mempool, in mining order.
    pub async fn mempool_feerate_diagram(&self) -> Result<Vec<ChunkPoint>, Error> {
        self.call("getmempoolfeeratediagram", NO_PARAMS).await
    }

    /// `gettxspendingprevout`: the mempool spender of each outpoint, in the order given.
    /// At most [`MAX_PREVOUTS`] outpoints, else [`Error::RequestTooBig`].
    pub async fn tx_spending_prevout(
        &self,
        outpoints: &[OutPoint],
    ) -> Result<Vec<PrevoutSpend>, Error> {
        #[derive(Serialize)]
        struct Prevout {
            txid: Txid,
            vout: u32,
        }
        if outpoints.len() > MAX_PREVOUTS {
            return Err(Error::RequestTooBig);
        }
        let prevouts: Vec<Prevout> = outpoints
            .iter()
            .map(|o| Prevout {
                txid: o.txid,
                vout: o.vout,
            })
            .collect();
        self.call("gettxspendingprevout", [prevouts]).await
    }

    // Template and fees.

    /// `getblocktemplate` in template mode. Asks for the `segwit` and `signet` rules: signet
    /// requires the second and the other networks ignore it.
    pub async fn block_template(&self) -> Result<BlockTemplate, Error> {
        #[derive(Serialize)]
        struct Request {
            mode: &'static str,
            rules: [&'static str; 2],
        }
        let req = Request {
            mode: "template",
            rules: ["segwit", "signet"],
        };
        self.call("getblocktemplate", [req]).await
    }

    /// `estimatesmartfee` for a confirmation target in blocks.
    pub async fn estimate_smart_fee(&self, target: u16) -> Result<SmartFee, Error> {
        self.call("estimatesmartfee", [target]).await
    }

    // Node.

    /// `getnetworkinfo`.
    pub async fn network_info(&self) -> Result<NetworkInfo, Error> {
        self.call("getnetworkinfo", NO_PARAMS).await
    }
}

/// Serializes as `[]`.
const NO_PARAMS: [u8; 0] = [];

#[derive(Serialize)]
struct Request<P> {
    jsonrpc: &'static str,
    id: usize,
    method: &'static str,
    params: P,
}

/// One answer of a batch.
#[derive(Deserialize)]
struct Answer<T> {
    id: usize,
    result: Option<T>,
    error: Option<RpcError>,
}

/// One JSON-RPC response. `result` is decoded straight into `T`; nothing else is buffered.
#[derive(Deserialize)]
struct Envelope<T> {
    result: Option<T>,
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

/// Maps one HTTP answer to the call's result. The node sends JSON-RPC errors with 404 or 500.
fn decode<T: DeserializeOwned>(status: StatusCode, body: &[u8]) -> Result<T, Error> {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(Error::Auth),
        StatusCode::SERVICE_UNAVAILABLE => return Err(Error::Busy),
        _ => {}
    }
    match serde_json::from_slice::<Envelope<T>>(body) {
        Ok(Envelope { error: Some(e), .. }) => Err(Error::Rpc {
            code: e.code,
            message: truncate(e.message),
        }),
        Ok(Envelope {
            result: Some(r), ..
        }) if status == StatusCode::OK => Ok(r),
        _ if status != StatusCode::OK => Err(Error::Unavailable(format!("HTTP {status}"))),
        Ok(_) => Err(Error::Decode("no result and no error".into())),
        Err(e) => Err(Error::Decode(e.to_string())),
    }
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_MESSAGE {
        let mut end = MAX_MESSAGE;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

/// Standard base64 with padding, for the Basic credentials.
fn base64(input: &[u8], out: &mut String) {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let sym = |n: u32| char::from(ALPHABET.get((n & 63) as usize).copied().unwrap_or(b'='));
    for chunk in input.chunks(3) {
        let b = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = (b(0) << 16) | (b(1) << 8) | b(2);
        out.push(sym(n >> 18));
        out.push(sym(n >> 12));
        out.push(if chunk.len() > 1 { sym(n >> 6) } else { '=' });
        out.push(if chunk.len() > 2 { sym(n) } else { '=' });
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        for (input, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
            ("Aladdin:open sesame", "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="),
        ] {
            let mut out = String::new();
            base64(input.as_bytes(), &mut out);
            assert_eq!(out, want);
        }
    }

    #[test]
    fn statuses_and_envelopes() {
        let ok = StatusCode::OK;
        assert_eq!(
            decode::<u32>(ok, br#"{"result":7,"error":null,"id":0}"#),
            Ok(7)
        );
        assert_eq!(
            decode::<u32>(
                StatusCode::INTERNAL_SERVER_ERROR,
                br#"{"result":null,"error":{"code":-5,"message":"Transaction not in mempool"},"id":0}"#
            ),
            Err(Error::Rpc {
                code: -5,
                message: "Transaction not in mempool".into()
            })
        );
        assert_eq!(
            decode::<u32>(StatusCode::UNAUTHORIZED, b"Unauthorized"),
            Err(Error::Auth)
        );
        assert_eq!(
            decode::<u32>(
                StatusCode::SERVICE_UNAVAILABLE,
                b"Work queue depth exceeded"
            ),
            Err(Error::Busy)
        );
        assert_eq!(
            decode::<u32>(StatusCode::BAD_GATEWAY, b"<html>"),
            Err(Error::Unavailable("HTTP 502 Bad Gateway".into()))
        );
        for bad in [
            &br#"{"result":null,"error":null,"id":0}"#[..],
            br#"{"result":"x","error":null,"id":0}"#,
            b"",
            b"\xff",
            br#"{"result":7"#,
        ] {
            assert!(matches!(decode::<u32>(ok, bad), Err(Error::Decode(_))));
        }
        let long = format!(
            r#"{{"result":null,"error":{{"code":-1,"message":"{}"}},"id":0}}"#,
            "é".repeat(400)
        );
        let Err(Error::Rpc { message, .. }) = decode::<u32>(ok, long.as_bytes()) else {
            unreachable!()
        };
        assert_eq!(message.len(), MAX_MESSAGE);
    }

    #[test]
    fn config_is_checked_and_debug_hides_credentials() {
        let rpc = Rpc::new("127.0.0.1", 8332, "rpcuser", "hunter2-secret").unwrap();
        let debug = format!("{rpc:?}");
        // Exact on purpose (SECURITY.md rule 4): a field added to what `Debug` prints is looked
        // at here, whatever form it prints the credentials in.
        assert_eq!(debug, r#"Rpc { authority: "127.0.0.1:8332", .. }"#);
        // Neither credential, nor the header made of them.
        for secret in [
            "rpcuser",
            "hunter2-secret",
            "Basic",
            "cnBjdXNlcjpodW50ZXIyLXNlY3JldA",
        ] {
            assert!(!debug.contains(secret), "{debug}");
        }
        assert!(Rpc::new("::1", 8332, "u", "p").is_ok());
        assert!(Rpc::new("", 8332, "u", "p").is_err());
        assert!(Rpc::new("host/path", 8332, "u", "p").is_err());
        assert!(Rpc::new("user@host", 8332, "u", "p").is_err());
        assert!(Rpc::new("host", 8332, "a:b", "p").is_err());
        assert!(Rpc::new("host", 8332, "u", "line\nbreak").is_ok());
        let limits = Limits {
            max_concurrent: 0,
            ..Limits::default()
        };
        assert!(Rpc::with_limits("host", 8332, "u", "p", limits).is_err());
    }
}
