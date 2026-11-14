//! Every event the server can record. `docs/LOGGING.md` lists them all; a test fails when one
//! here is missing there.
//!
//! Field rules: snake_case, units in the name (`duration_ms`, `bytes`), the same name for the same
//! thing everywhere. An optional field that does not apply is left out of the line. No field may
//! hold a password, a credentialed URL, or a raw request path or query.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::{Event, Level};

/// `event!(Type, "name", Level)`, or `event!(Type, "name", Info, keep)` for an `info` event the
/// ceiling never drops: only one whose rate the code fixes, whatever clients do.
macro_rules! event {
    ($ty:ident $(<$lt:lifetime>)?, $name:literal, $level:ident) => {
        impl$(<$lt>)? Event for $ty $(<$lt>)? {
            const NAME: &'static str = $name;
            const LEVEL: Level = Level::$level;
        }
    };
    ($ty:ident $(<$lt:lifetime>)?, $name:literal, Info, keep) => {
        impl$(<$lt>)? Event for $ty $(<$lt>)? {
            const NAME: &'static str = $name;
            const LEVEL: Level = Level::Info;
            const KEEP: bool = true;
        }
    };
}

// Lifecycle.

/// The server parsed its configuration and is about to listen. Non-secret settings only.
#[derive(Debug, Serialize)]
pub struct ServerStarting<'a> {
    pub version: &'a str,
    /// The commit the binary was built from, or `unknown` (docs/DEPLOY.md, "Health").
    pub revision: &'a str,
    pub listen_addr: String,
    pub web_dir: String,
    pub networks: Vec<&'a str>,
    pub log_format: &'a str,
    pub log_level: &'a str,
    pub log_requests: &'a str,
    pub log_client_addr: bool,
    pub log_max_bytes_per_sec: u64,
    pub broadcast_enabled: bool,
    pub max_body_bytes: usize,
    pub request_timeout_secs: u64,
    pub max_connections: usize,
    pub max_concurrent_requests: usize,
    pub client_max_connections: u32,
    pub client_max_concurrent_requests: u32,
    pub client_rate_per_sec: u32,
    pub client_burst: u32,
    pub max_tracked_clients: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_proxy_header: Option<&'a str>,
    /// `TRUSTED_PROXIES` as prefixes; set exactly when `trusted_proxy_header` is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_proxies: Option<Vec<String>>,
    pub ws_max_sockets: usize,
    pub ws_client_max_sockets: u32,
    pub ws_v1_max_sockets: usize,
    pub ws_v1_client_max_sockets: u32,
    pub ws_max_message_bytes: usize,
    pub ws_messages_per_sec: u32,
    pub ws_max_subscriptions: usize,
    pub ws_send_queue: usize,
    pub ws_idle_timeout_secs: u64,
    pub ws_max_block_subscriptions: usize,
    pub ws_mempool_interval_ms: u64,
    pub ws_block_wait_secs: u64,
    pub ws_latest_txs: usize,
    pub ws_max_tracked_txs: usize,
    pub ws_max_tracked_addresses: usize,
    pub ws_tracked_txs_total: usize,
    pub ws_tracked_addresses_total: usize,
    pub ws_position_interval_ms: u64,
    pub replacements_kept: usize,
    pub block_summary_cache_mb: usize,
    pub answer_cache_mb: usize,
    /// Left out when `DATA_DIR` is unset and the server runs without a store.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    pub backfill_enabled: bool,
    pub backfill_busy_percent: u32,
    pub backfill_fee_rate_depth: u32,
    pub ledger_max_addresses: usize,
    pub ledger_discover: bool,
    pub ledger_max_history_rows: u64,
}
event!(ServerStarting<'a>, "server_starting", Info, keep);

/// One network is enabled, with the node endpoints it uses. The RPC password is never here and
/// the Esplora URL cannot hold credentials (config refuses them).
#[derive(Debug, Serialize)]
pub struct NetworkEnabled<'a> {
    pub network: &'a str,
    /// `host:port` of the JSON-RPC listener.
    pub rpc_addr: String,
    /// Esplora base URL or unix socket path.
    pub esplora: String,
    pub electrum_addr: &'a str,
    /// Whether the mempool tracker and projected blocks run (`{NET}_MEMPOOL_ENABLED`).
    pub mempool: bool,
    /// Whether the Lightning gossip peer runs (`{NET}_LIGHTNING_ENABLED`).
    pub lightning: bool,
}
event!(NetworkEnabled<'a>, "network_enabled", Info, keep);

/// No network is configured: only the frontend and `/healthz` are served.
#[derive(Debug, Serialize)]
pub struct NoNetworks {}
event!(NoNetworks, "no_networks", Warn);

/// `WEB_DIR` has no `index.html`, so pages will 404.
#[derive(Debug, Serialize)]
pub struct WebDirMissing {
    pub web_dir: String,
}
event!(WebDirMissing, "web_dir_missing", Warn);

/// The listener is bound; `addr` shows the real port when `LISTEN_ADDR` asked for port 0.
#[derive(Debug, Serialize)]
pub struct Listening {
    pub addr: String,
}
event!(Listening, "listening", Info, keep);

/// A shutdown signal arrived; in-flight requests get up to the request timeout to finish.
#[derive(Debug, Serialize)]
pub struct ShutdownRequested {
    /// `sigterm` or `ctrl_c`.
    pub signal: &'static str,
}
event!(ShutdownRequested, "shutdown_requested", Info, keep);

/// The server stopped serving and the process is exiting normally.
#[derive(Debug, Serialize)]
pub struct ServerStopped {}
event!(ServerStopped, "server_stopped", Info, keep);

/// The configuration is invalid; the process exits. `error` names the variable, never its value.
#[derive(Debug, Serialize)]
pub struct ConfigInvalid<'a> {
    pub error: &'a str,
}
event!(ConfigInvalid<'a>, "config_invalid", Error);

/// The listen address could not be bound; the process exits.
#[derive(Debug, Serialize)]
pub struct ListenFailed {
    pub addr: String,
    pub error: String,
}
event!(ListenFailed, "listen_failed", Error);

/// Code panicked. In a request handler the client gets a 500 and the server keeps running.
#[derive(Debug, Serialize)]
pub struct Panic<'a> {
    pub message: &'a str,
    /// `file:line` in our source.
    pub location: &'a str,
    pub thread: &'a str,
}
event!(Panic<'a>, "panic", Error);

/// Events were dropped: the queue was full (the output fell behind) or they were over the
/// ceiling. Written by the writer itself, at most once a second, the first at once.
#[derive(Debug, Serialize)]
pub struct LogEventsDropped<'a> {
    pub count: u64,
    pub queue_full: u64,
    pub over_budget: u64,
    /// By event name; at most one entry per event type.
    pub events: &'a BTreeMap<&'static str, u64>,
}
event!(LogEventsDropped<'a>, "log_events_dropped", Warn);

/// Connections closed at accept because their address had `CLIENT_MAX_CONNECTIONS` open. The
/// client sees only a reset, with no response to log. Written at a total of 1, 2, 4, 8…
#[derive(Debug, Serialize)]
pub struct ConnectionsRefused {
    pub total: u64,
}
event!(ConnectionsRefused, "connections_refused", Warn);

/// Accepting a connection failed, usually because the process is out of file descriptors: new
/// clients wait in the listen queue until one closes. Written at a total of 1, 2, 4, 8…
#[derive(Debug, Serialize)]
pub struct AcceptFailed {
    pub error: String,
    pub total: u64,
}
event!(AcceptFailed, "accept_failed", Warn);

/// Requests that named a client address in `X-Forwarded-For`, `X-Real-IP` or `Forwarded` but came
/// from a peer outside `TRUSTED_PROXIES`, so the header was ignored and the peer counted as the
/// client: a proxy in front that is not trusted puts every visitor in one allowance. Written at a
/// total of 1, 2, 4, 8…
#[derive(Debug, Serialize)]
pub struct ProxyHeaderIgnored {
    /// The first of the three headers the request had, in lower case.
    pub header: &'static str,
    /// The peer, the address `TRUSTED_PROXIES` is missing if it is a proxy. Only with
    /// `LOG_CLIENT_ADDR=true`, since without a proxy in front it is a visitor's; else null.
    pub peer: Option<String>,
    /// Whether `TRUSTED_PROXIES` is set at all.
    pub trusted_proxies_set: bool,
    pub total: u64,
}
event!(ProxyHeaderIgnored, "proxy_header_ignored", Warn);

// HTTP.

/// One HTTP request, written when its response head is ready.
#[derive(Debug, Serialize)]
pub struct HttpRequest<'a> {
    /// Also sent to the client in the `X-Request-Id` response header.
    pub request_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<&'static str>,
    pub method: &'a str,
    /// The matched route template, e.g. `/signet/api/{*rest}`; `frontend` for pages and files.
    /// Never the raw path: that would record which address or transaction was looked up.
    pub route: &'a str,
    pub status: u16,
    /// Until the response head was ready; body streaming is not included.
    pub duration_ms: f64,
    /// Response body size, when known up front.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// Which limit refused the request, if one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<&'static str>,
    /// `/api` pass-through: the named Esplora route, e.g. `tx_status`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<&'static str>,
    /// `/api` pass-through: `upstream`, `coalesced` or `hot`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    /// `/api` pass-through: time of this request's own upstream call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_ms: Option<f64>,
    /// `/api` pass-through: why the upstream call got no answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_error: Option<&'static str>,
    /// The address the limiter keys on (IPv6 as its /64). Only with `LOG_CLIENT_ADDR=true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
}
event!(HttpRequest<'a>, "http_request", Info);

/// Requests a limit refused, summed over a window instead of one `http_request` each. Written at
/// the end of each minute that had any. Its size is fixed whatever the number of clients.
#[derive(Debug, Serialize)]
pub struct RequestsRefused<'a> {
    /// Seconds the counts cover.
    pub window_secs: u64,
    pub total: u64,
    /// Of `total`, the first of each reason after a quiet window, passed on to be written as their
    /// own `http_request` (which `LOG_REQUESTS` or the ceiling may still leave out).
    pub logged: u64,
    /// By the `refused` label of `http_request`; one entry per label at most.
    pub reasons: &'a BTreeMap<&'static str, u64>,
    /// By route class: `api`, `app`, `ws`, `health` or `pages`.
    pub routes: &'a BTreeMap<&'static str, u64>,
    /// Distinct client addresses, estimated in fixed memory: exact to a few percent up to tens
    /// of thousands.
    pub clients: u64,
    /// Refusals of the most refused client, counted in fixed memory: a lower bound, exact for a
    /// client that stands out. Near `total`: one address is refused (an attacker, or every user
    /// seen as one); small: many are.
    pub top_client_refused: u64,
    /// That client's address, only with `LOG_CLIENT_ADDR=true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_client: Option<String>,
    /// Refused requests that carried a forwarding header (`X-Forwarded-For`, `X-Real-IP`,
    /// `Forwarded`) from a peer not in `TRUSTED_PROXIES`, so the header was ignored. Most of
    /// the refusals: a proxy in front that is not configured as trusted.
    pub untrusted_forwarded: u64,
    /// Refused requests keyed to a trusted proxy's own address, because its header was missing
    /// or unreadable. Most of the refusals: the proxy does not set the header configured.
    pub proxy_keyed: u64,
}
event!(RequestsRefused<'a>, "requests_refused", Warn);

// Node clients.

/// The Electrum connection is up: handshake done, subscriptions restored.
#[derive(Debug, Serialize)]
pub struct ElectrumConnected<'a> {
    pub network: &'static str,
    /// The node's `server.version` software string.
    pub server: &'a str,
    pub protocol: &'a str,
}
event!(ElectrumConnected<'a>, "electrum_connected", Info, keep);

/// A ready Electrum connection was lost; the client reconnects with backoff.
#[derive(Debug, Serialize)]
pub struct ElectrumDisconnected {
    pub network: &'static str,
}
event!(ElectrumDisconnected, "electrum_disconnected", Warn);

/// Connection attempts keep failing. Written at the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct ElectrumUnreachable {
    pub network: &'static str,
    pub attempts: u32,
}
event!(ElectrumUnreachable, "electrum_unreachable", Warn);

/// Updates may have been missed (a reconnect, or a tip jump too far to follow); derived state
/// is refreshed.
#[derive(Debug, Serialize)]
pub struct ElectrumResynced {
    pub network: &'static str,
}
event!(ElectrumResynced, "electrum_resynced", Info, keep);

/// Lines from the node that were not valid JSON-RPC and were skipped. Written when the total
/// reaches 1, 2, 4, 8…
#[derive(Debug, Serialize)]
pub struct ElectrumLinesSkipped {
    pub network: &'static str,
    pub total: u64,
}
event!(ElectrumLinesSkipped, "electrum_lines_skipped", Warn);

/// Blocks above `fork_height` left the best chain.
#[derive(Debug, Serialize)]
pub struct ChainReorg {
    pub network: &'static str,
    pub fork_height: u32,
}
event!(ChainReorg, "chain_reorg", Info, keep);

/// The node refused our RPC user and password. Clients see only "unavailable"; the operator must
/// fix `{NET}_RPC_USER` or `{NET}_RPC_PASSWORD`. Written at startup and whenever a check finds it
/// newly refused.
#[derive(Debug, Serialize)]
pub struct RpcAuthFailed {
    pub network: &'static str,
}
event!(RpcAuthFailed, "rpc_auth_failed", Error);

/// The node's RPC answered for another chain than the network it is configured as: the `{NET}_*`
/// variables point at the wrong node. Written at startup and whenever a check finds it anew.
#[derive(Debug, Serialize)]
pub struct RpcWrongNetwork<'a> {
    pub network: &'static str,
    /// `getblockchaininfo`'s `chain`, cut to 16 characters.
    pub node_chain: &'a str,
}
event!(RpcWrongNetwork<'a>, "rpc_wrong_network", Error);

/// The readiness check could not reach the node's RPC: at the 1st, 2nd, 4th, 8th… check in a row.
#[derive(Debug, Serialize)]
pub struct RpcUnreachable {
    pub network: &'static str,
    /// `timeout`, `unavailable`, `busy` or `decode`.
    pub error: &'static str,
    pub failures: u32,
}
event!(RpcUnreachable, "rpc_unreachable", Warn);

/// The node's RPC answered and accepted our credentials: the first check, or the first after
/// failures.
#[derive(Debug, Serialize)]
pub struct RpcReachable {
    pub network: &'static str,
    /// The node's best height.
    pub height: u32,
    /// Checks that failed before this one.
    pub failures: u32,
}
event!(RpcReachable, "rpc_reachable", Info, keep);

/// The node answers address and scripthash lookups (`--sh-index`). Written at the first answer
/// and when it changes; asked at startup and on every Electrum reconnect.
#[derive(Debug, Serialize)]
pub struct AddressIndexOn {
    pub network: &'static str,
}
event!(AddressIndexOn, "address_index_on", Info, keep);

/// The node runs without its address index (`--sh-index`): address pages and the address and
/// scripthash routes answer 503 until it is turned on. Written at the first answer and when it
/// changes.
#[derive(Debug, Serialize)]
pub struct AddressIndexOff {
    pub network: &'static str,
}
event!(AddressIndexOff, "address_index_off", Warn);

// WebSocket hub.

/// A socket closed. Debug level: one per socket. Clients dropped for a limit are also summarised
/// by [`WsClientsDropped`] at the default level.
#[derive(Debug, Serialize)]
pub struct WsClosed {
    pub network: &'static str,
    /// `app` for `/app/ws`, `v1` for the mempool.space-shaped `/api/v1/ws`.
    pub api: &'static str,
    /// The close code sent, or 1006 when the connection dropped without a close frame.
    pub code: u16,
    /// Why, as a fixed label: `client_closed`, `shutdown`, `too_slow`, `idle`, …
    pub reason: &'static str,
    /// How long the socket was open.
    pub duration_ms: f64,
    /// Sockets still open, on every network.
    pub open: usize,
}
event!(WsClosed, "ws_closed", Debug);

/// Clients disconnected for breaking one limit. Written when the count for that reason on that
/// network reaches 1, 2, 4, 8…
#[derive(Debug, Serialize)]
pub struct WsClientsDropped {
    pub network: &'static str,
    /// `too_slow`, `idle`, `rate`, `too_big`, `bad_message`, `too_many_subscriptions`,
    /// `protocol_error`, `binary` or `invalid_utf8`.
    pub reason: &'static str,
    pub total: u64,
}
event!(WsClientsDropped, "ws_clients_dropped", Warn);

/// WebSocket upgrades refused because their `Origin` is not this site's. Written when the count on
/// that network reaches 1, 2, 4, 8…, with the latest refused pair, so a proxy that rewrites `Host`
/// shows up at once. Both fields are client-sent text, cut to 100 characters.
#[derive(Debug, Serialize)]
pub struct WsOriginRefused {
    pub network: &'static str,
    pub origin: String,
    pub host: String,
    pub total: u64,
}
event!(WsOriginRefused, "ws_origin_refused", Warn);

/// One message sent to every subscriber of a topic.
#[derive(Debug, Serialize)]
pub struct WsFanout {
    pub network: &'static str,
    pub topic: &'static str,
    /// The message's `type`: `block`, `summary`, `reorg`, `resync`.
    pub kind: &'static str,
    pub subscribers: usize,
    /// Sockets open on every network.
    pub open: usize,
    /// Frame size; every subscriber shares these bytes.
    pub bytes: usize,
    /// Subscribers whose send queue was full, now being disconnected.
    pub dropped_slow: usize,
    /// From the node's notification to the last subscriber's queue, upstream fetch included.
    pub duration_ms: f64,
    /// The queueing part of `duration_ms`.
    pub fanout_ms: f64,
}
event!(WsFanout, "ws_fanout", Info, keep);

/// A new block's JSON could not be fetched from Esplora, so subscribers were told to resync.
/// Written at the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct BlockUnavailable {
    pub network: &'static str,
    pub height: u32,
    pub hash: String,
    pub failures: u32,
}
event!(BlockUnavailable, "block_unavailable", Warn);

// Block summaries.

/// One block's summary was computed from the node. Debug: up to a few a second under load.
#[derive(Debug, Serialize)]
pub struct BlockSummaryComputed {
    pub network: &'static str,
    pub height: u32,
    /// Transactions in the block, the coinbase included.
    pub txs: usize,
    /// The block's serialized size.
    pub block_bytes: u64,
    /// Size of the per-transaction records kept in the cache.
    pub bytes: usize,
    /// The node calls alone.
    pub node_ms: f64,
    /// From the start, the wait for a computation slot included.
    pub duration_ms: f64,
    /// `request` (a client asked) or `new_block` (computed ahead of demand).
    pub cause: &'static str,
    /// What listed the transactions: `summary_route` or `getblock`.
    pub source: &'static str,
}
event!(BlockSummaryComputed, "block_summary_computed", Debug);

/// Which source lists a network's blocks for the summaries, the audit and the backfill: at
/// startup and on every reconnect, and when a block's answer changes it.
#[derive(Debug, Serialize)]
pub struct BlockTxsSource {
    pub network: &'static str,
    /// `summary_route` or `getblock`.
    pub source: &'static str,
    /// `probe`, `answered` or `refused`.
    pub reason: &'static str,
}
event!(BlockTxsSource, "block_txs_source", Info);

/// The summary route failed for a block, which `getblock` listed instead. At a total of 1, 2, 4,
/// 8… per network.
#[derive(Debug, Serialize)]
pub struct BlockTxsFellBack {
    pub network: &'static str,
    /// `not_found`, `unavailable`, `too_big`, `malformed` or `mismatch`; the latest.
    pub reason: &'static str,
    pub total: u64,
}
event!(BlockTxsFellBack, "block_txs_fell_back", Warn);

/// A block we watched arrive was compared with the block we expected on its parent
/// (`docs/MEMPOOL.md`, "Block audits"). Once per block.
#[derive(Debug, Serialize)]
pub struct BlockAudited {
    pub network: &'static str,
    pub height: u32,
    /// Percent, rounded down to two decimals.
    pub match_rate: f64,
    pub expected_txs: u32,
    pub matched_txs: u32,
    pub missing_txs: u32,
    pub displaced_txs: u32,
    pub fresh_txs: u32,
    pub conflicted_txs: u32,
    pub added_txs: u32,
    pub unseen_txs: u32,
    /// From the start of the audit, the wait for the projection on the new block included.
    pub duration_ms: f64,
}
event!(BlockAudited, "block_audited", Info, keep);

/// A new block got no audit. Once per block.
#[derive(Debug, Serialize)]
pub struct BlockAuditSkipped {
    pub network: &'static str,
    pub height: u32,
    /// `no_projection`, `stale`, `superseded` or `store`.
    pub reason: &'static str,
}
event!(BlockAuditSkipped, "block_audit_skipped", Info, keep);

/// Computing summaries failed at the node. Written at the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct BlockSummaryFailed {
    pub network: &'static str,
    /// `busy`, `timeout`, `unavailable`, `response_too_big` or `decode`.
    pub error: &'static str,
    pub failures: u32,
}
event!(BlockSummaryFailed, "block_summary_failed", Warn);

/// A summary was computed again after failures.
#[derive(Debug, Serialize)]
pub struct BlockSummariesRecovered {
    pub network: &'static str,
    pub failures: u32,
}
event!(
    BlockSummariesRecovered,
    "block_summaries_recovered",
    Info,
    keep
);

/// Requests for uncached summaries were refused. Written when the count for that reason on that
/// network reaches 1, 2, 4, 8…
#[derive(Debug, Serialize)]
pub struct BlockSummariesRefused {
    pub network: &'static str,
    /// `summary_busy` (the network's queue is full) or `route_rate` (one client's limit).
    pub reason: &'static str,
    pub total: u64,
}
event!(BlockSummariesRefused, "block_summaries_refused", Warn);

// Derived data.

/// The difficulty-adjustment answer was recomputed for a new tip: once per block (and reorg) per
/// network. After failures, this line is the recovery.
#[derive(Debug, Serialize)]
pub struct DifficultyComputed {
    pub network: &'static str,
    pub height: u32,
    pub next_retarget_height: u32,
    /// Expected change at the next retarget, in percent, as of this computation.
    pub difficulty_change: f64,
    /// The node fetches.
    pub duration_ms: f64,
}
event!(DifficultyComputed, "difficulty_computed", Info, keep);

/// The difficulty-adjustment answer could not be recomputed; the last one is still served.
/// Written at the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct DifficultyRefreshFailed {
    pub network: &'static str,
    /// The tip the refresh was for.
    pub height: u32,
    /// `timeout`, `unavailable`, `response_too_big`, `decode`, `not_found`, `wrong_height` or
    /// `invalid_bits`. A moved tip is [`DifficultyRetried`] instead.
    pub error: &'static str,
    pub failures: u32,
}
event!(DifficultyRefreshFailed, "difficulty_refresh_failed", Warn);

/// A refresh read blocks stamped with a newer tip than the one it was computing (a block or reorg
/// in between), so it starts again. Expected during a burst of blocks: at the 1st, 2nd, 4th, 8th…
/// in a row.
#[derive(Debug, Serialize)]
pub struct DifficultyRetried {
    pub network: &'static str,
    /// The tip the refresh was for.
    pub height: u32,
    pub retries: u32,
}
event!(DifficultyRetried, "difficulty_refresh_retried", Debug);
// The store and the block table.

/// A network's SQLite file could not be opened; that network runs without a store.
#[derive(Debug, Serialize)]
pub struct StoreOpenFailed {
    pub network: &'static str,
    /// Names the file and the cause; never data from a client.
    pub error: String,
}
event!(StoreOpenFailed, "store_open_failed", Error);

/// A store from before files recorded their chain holds a block row the node does not have at
/// that height: it was written for another chain. Its writes are refused until the server is
/// restarted with the file moved aside.
#[derive(Debug, Serialize)]
pub struct StoreWrongChain {
    pub network: &'static str,
    /// The height of the row that is not on the node's chain.
    pub height: u32,
}
event!(StoreWrongChain, "store_wrong_chain", Error);

/// A store from before files recorded their chain has no block row deep enough in the node's
/// chain to check, so its writes wait. Written once; checked again at each RPC check.
#[derive(Debug, Serialize)]
pub struct StoreChainUnverified {
    pub network: &'static str,
    /// The file's lowest block row.
    pub height: u32,
    /// The node's tip.
    pub node_height: u32,
}
event!(StoreChainUnverified, "store_chain_unverified", Warn);

/// A schema migration was applied while opening the file.
#[derive(Debug, Serialize)]
pub struct StoreMigrationApplied<'a> {
    pub network: &'static str,
    pub migration: &'a str,
    pub duration_ms: f64,
}
event!(
    StoreMigrationApplied<'a>,
    "store_migration_applied",
    Info,
    keep
);

/// One write held the writer for a second or more.
#[derive(Debug, Serialize)]
pub struct StoreSlowWrite {
    pub network: &'static str,
    pub duration_ms: f64,
    /// Writes waiting behind it.
    pub queue_depth: usize,
}
event!(StoreSlowWrite, "store_slow_write", Warn);

/// SQLite refused a write: at the 1st, 2nd, 4th, 8th… in a row.
#[derive(Debug, Serialize)]
pub struct StoreWriteFailed<'a> {
    pub network: &'static str,
    /// `disk_full`, `read_only`, `corrupt`, `busy`, `io` or `other`.
    pub error: &'static str,
    /// SQLite's own message. Operator-only: never in an answer.
    pub sqlite: &'a str,
    pub failures: u32,
}
event!(StoreWriteFailed<'a>, "store_write_failed", Warn);

/// A write committed after `failures` in a row had failed.
#[derive(Debug, Serialize)]
pub struct StoreWriteRecovered {
    pub network: &'static str,
    pub failures: u32,
}
event!(StoreWriteRecovered, "store_write_recovered", Info, keep);

/// A read ran past its time limit and was stopped.
#[derive(Debug, Serialize)]
pub struct StoreReadTimedOut {
    pub network: &'static str,
    /// Which read: a fixed label from the store's `Read`.
    pub read: &'static str,
    pub limit_ms: u64,
}
event!(StoreReadTimedOut, "store_read_timed_out", Warn);

/// A read failed in SQLite or panicked: at the 1st, 2nd, 4th, 8th… failure of that read in a
/// row, whichever task asked.
#[derive(Debug, Serialize)]
pub struct StoreReadFailed<'a> {
    pub network: &'static str,
    /// Which read: a fixed label from the store's `Read`.
    pub read: &'static str,
    /// `disk_full`, `read_only`, `corrupt`, `busy`, `io`, `other` or `panicked`.
    pub error: &'static str,
    /// SQLite's own message, empty for a panic. Operator-only: never in an answer.
    pub sqlite: &'a str,
    pub failures: u32,
}
event!(StoreReadFailed<'a>, "store_read_failed", Warn);

/// A read worked after `failures` of the same read in a row had failed.
#[derive(Debug, Serialize)]
pub struct StoreReadRecovered {
    pub network: &'static str,
    pub read: &'static str,
    pub failures: u32,
}
event!(StoreReadRecovered, "store_read_recovered", Info, keep);

/// The newest rows of the block table were checked against a new tip. Debug: once per block.
#[derive(Debug, Serialize)]
pub struct BlockRowsFollowed {
    pub network: &'static str,
    pub tip: u32,
    /// Rows added or replaced, and rows given fee rates.
    pub written: usize,
    pub rated: usize,
    pub duration_ms: f64,
}
event!(BlockRowsFollowed, "block_rows_followed", Debug);

/// The address ledger followed new blocks for its tracked addresses. Debug: once per block.
#[derive(Debug, Serialize)]
pub struct LedgerFollowed {
    pub network: &'static str,
    /// The ledger's tip afterwards; `None` once nothing is tracked.
    pub tip: Option<u32>,
    pub applied: u32,
    pub undone: u32,
    /// Addresses dropped because a reorg took the block they were seeded at.
    pub dropped: usize,
    /// A reorg deeper than the ledger keeps: every address was dropped.
    pub reset: bool,
    /// Addresses whose totals changed.
    pub changed: usize,
    pub duration_ms: f64,
}
event!(LedgerFollowed, "ledger_followed", Debug);

/// Following blocks for the ledger failed, at the 1st, 2nd, 4th… failure in a row.
#[derive(Debug, Serialize)]
pub struct LedgerFollowFailed {
    pub network: &'static str,
    pub error: &'static str,
    pub failures: u32,
}
event!(LedgerFollowFailed, "ledger_follow_failed", Warn);

/// An address was added up and is tracked from now on.
#[derive(Debug, Serialize)]
pub struct LedgerSeeded {
    pub network: &'static str,
    /// Electrum scripthash, as shown.
    pub scripthash: String,
    /// The block its totals are exact at.
    pub height: u32,
    /// Whether the node's newest history page was kept too.
    pub page: bool,
    /// Addresses dropped to make room.
    pub evicted: usize,
    /// `reader`, `discovery`, or `answer` (a totals answer the guard learned from).
    pub via: &'static str,
    pub duration_ms: f64,
}
event!(LedgerSeeded, "ledger_seeded", Info);

/// Whether the node's Esplora socket adds up totals above its `--max-sh-creates`, so seeds of
/// addresses above the cap ask it: at startup and on every reconnect, on a socket only.
#[derive(Debug, Serialize)]
pub struct LedgerTotalsRoute {
    pub network: &'static str,
    pub uncapped: bool,
}
event!(LedgerTotalsRoute, "ledger_totals_route", Info);

/// The node refused to add an address up: its `--max-sh-creates` is in force. Said once until a
/// seed works again.
#[derive(Debug, Serialize)]
pub struct LedgerSeedRefused {
    pub network: &'static str,
    /// Transactions paying the address, and the node's cap, as its refusal gave them.
    pub creates: Option<u64>,
    pub cap: Option<u64>,
}
event!(LedgerSeedRefused, "ledger_seed_refused", Info);

/// A seed failed, at the 1st, 2nd, 4th… failure in a row; it is tried again later.
#[derive(Debug, Serialize)]
pub struct LedgerSeedFailed {
    pub network: &'static str,
    pub error: &'static str,
    pub failures: u32,
    pub duration_ms: f64,
}
event!(LedgerSeedFailed, "ledger_seed_failed", Warn);

/// A kept address's newest transactions were filled with the node's page before its seed block,
/// or found not to take one. Once per address.
#[derive(Debug, Serialize)]
pub struct LedgerFilled {
    pub network: &'static str,
    pub scripthash: String,
    /// The seed block the page was pinned to.
    pub height: u32,
    /// `joined`, `full` (the window holds rows since the seed only) or `gap` (rows since the seed
    /// may be missing).
    pub outcome: &'static str,
    /// Rows the page added to the window.
    pub rows: usize,
    pub duration_ms: f64,
}
event!(LedgerFilled, "ledger_filled", Info);

/// A fill failed, at the 1st, 2nd, 4th… failure of that address; it is tried again later.
#[derive(Debug, Serialize)]
pub struct LedgerFillFailed {
    pub network: &'static str,
    pub scripthash: String,
    pub error: &'static str,
    pub failures: u32,
    pub duration_ms: f64,
}
event!(LedgerFillFailed, "ledger_fill_failed", Warn);

/// A kept address's whole history was asked of the node, once: kept, refused or too large for
/// the bound.
#[derive(Debug, Serialize)]
pub struct LedgerHistory {
    pub network: &'static str,
    pub scripthash: String,
    /// `whole` (kept), `refused` (the node's `--max-sh-creates` is in force for it) or
    /// `too_large` (more transactions than `LEDGER_MAX_HISTORY_ROWS`: not asked).
    pub outcome: &'static str,
    /// The block the node's list was pinned to.
    pub height: u32,
    pub rows: u64,
    /// Other addresses' histories dropped to make room.
    pub evicted: usize,
    pub duration_ms: f64,
}
event!(LedgerHistory, "ledger_history", Info);

/// Taking a kept address's whole history failed, at the 1st, 2nd, 4th… failure of that address;
/// nothing of it was kept, and it is tried again later.
#[derive(Debug, Serialize)]
pub struct LedgerHistoryFailed {
    pub network: &'static str,
    pub scripthash: String,
    pub error: &'static str,
    pub failures: u32,
    pub duration_ms: f64,
}
event!(LedgerHistoryFailed, "ledger_history_failed", Warn);

/// Blocks made the kept histories outgrow `LEDGER_MAX_HISTORY_ROWS`: the least recently viewed
/// addresses' histories were dropped.
#[derive(Debug, Serialize)]
pub struct LedgerHistoryBound {
    pub network: &'static str,
    pub dropped: usize,
}
event!(LedgerHistoryBound, "ledger_history_bound", Info);

/// Discovery checked the size of a script a block paid often. At most `CHECKS_PER_HOUR` an hour.
#[derive(Debug, Serialize)]
pub struct LedgerChecked {
    pub network: &'static str,
    pub scripthash: String,
    /// `small`, `large`, `too_large` (the node refused it) or `unknown`.
    pub size: &'static str,
    pub duration_ms: f64,
}
event!(LedgerChecked, "ledger_checked", Debug);

/// Rows described blocks a reorg took off the best chain; they were replaced or removed.
#[derive(Debug, Serialize)]
pub struct BlockRowsReorged {
    pub network: &'static str,
    /// The highest height whose row still agreed.
    pub fork_height: u32,
    pub stale: usize,
}
event!(BlockRowsReorged, "block_rows_reorged", Info, keep);

/// Filling the block table failed; it is retried after a pause. At the 1st, 2nd, 4th, 8th…
/// failure in a row.
#[derive(Debug, Serialize)]
pub struct BlockRowsFailed {
    pub network: &'static str,
    /// `follow`, or the backfill's `tip`, `totals` or `rates`.
    pub task: &'static str,
    /// `busy`, `too_big`, `node` or `store`.
    pub error: &'static str,
    pub failures: u32,
}
event!(BlockRowsFailed, "block_rows_failed", Warn);

/// Filling the block table worked again after failures.
#[derive(Debug, Serialize)]
pub struct BlockRowsRecovered {
    pub network: &'static str,
    /// `follow` or `backfill`.
    pub task: &'static str,
    pub failures: u32,
}
event!(BlockRowsRecovered, "block_rows_recovered", Info, keep);

/// Where the backfill stands: every minute while it works, and when it has caught up.
#[derive(Debug, Serialize)]
pub struct BlockBackfillProgress {
    pub network: &'static str,
    pub tip: u32,
    /// Rows in the table, and how many have fee rates. Left out when the count failed or timed
    /// out, rather than repeating the last one as if nothing had moved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rated: Option<u64>,
    pub totals_done: bool,
    pub rates_done: bool,
    /// Since the server started: rows added, rows rated, time spent working and bytes read.
    pub totals_written: u64,
    pub rates_written: u64,
    pub busy_ms: u64,
    pub bytes: u64,
}
event!(BlockBackfillProgress, "block_backfill_progress", Info, keep);

// The live mempool.

/// The mempool tracker's first complete cycle: the initial sync.
#[derive(Debug, Serialize)]
pub struct MempoolSynced {
    pub network: &'static str,
    /// From start, failed attempts included.
    pub duration_ms: f64,
    pub txs: usize,
    /// Response bytes read from the node, and calls made.
    pub bytes: u64,
    pub calls: u32,
}
event!(MempoolSynced, "mempool_synced", Info, keep);

/// The live mempool over the last minute, once a minute per network: the tracker's cycles, the
/// projected blocks' updates and what the WebSocket topics sent.
#[derive(Debug, Serialize)]
pub struct MempoolSummary {
    pub network: &'static str,
    /// Transactions tracked now.
    pub txs: usize,
    pub cycles: u32,
    /// Probes that found nothing changed and skipped the listing.
    pub skipped: u32,
    pub added: u64,
    pub confirmed: u64,
    pub replaced: u64,
    pub evicted: u64,
    pub vanished: u64,
    /// The tracker's node calls and response bytes.
    pub node_calls: u64,
    pub node_bytes: u64,
    pub cycle_ms_max: f64,
    pub updates: u32,
    /// The projector's cluster requests, clusters asked and response bytes.
    pub cluster_calls: u64,
    pub clusters_asked: u64,
    pub cluster_bytes: u64,
    pub pack_ms_max: f64,
    /// Whether the projection is stale now.
    pub stale: bool,
    /// Messages published on the mempool topics, their encoded size, and the bytes queued to
    /// subscribers (size times subscribers).
    pub ws_messages: u64,
    pub ws_bytes: u64,
    pub ws_sent_bytes: u64,
    pub ws_dropped_slow: u64,
    pub fanout_ms_max: f64,
}
event!(MempoolSummary, "mempool_summary", Info, keep);

/// A tracker cycle failed and nothing from it was published. At the 1st, 2nd, 4th, 8th…
/// failure in a row.
#[derive(Debug, Serialize)]
pub struct MempoolPollFailed {
    pub network: &'static str,
    /// `busy`, `timeout`, `unavailable`, `response_too_big`, `decode`, `auth` or `failed`.
    pub error: &'static str,
    pub failures: u32,
    pub retry_in_ms: u64,
}
event!(MempoolPollFailed, "mempool_poll_failed", Warn);

/// A tracker cycle succeeded after `failures` in a row.
#[derive(Debug, Serialize)]
pub struct MempoolRecovered {
    pub network: &'static str,
    pub failures: u32,
}
event!(MempoolRecovered, "mempool_recovered", Info, keep);

/// The node's `mempool_sequence` went backwards: it restarted.
#[derive(Debug, Serialize)]
pub struct MempoolSequenceRegressed {
    pub network: &'static str,
    pub from: u64,
    pub to: u64,
}
event!(MempoolSequenceRegressed, "mempool_sequence_regressed", Warn);

/// A cluster request for the projected blocks failed; the projection is stale until one
/// succeeds. At the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct ProjectionFetchFailed {
    pub network: &'static str,
    /// As for `mempool_poll_failed`.
    pub error: &'static str,
    pub failures: u32,
    /// Transactions waiting to be asked about.
    pub pending: usize,
    pub retry_in_ms: u64,
}
event!(ProjectionFetchFailed, "projection_fetch_failed", Warn);

/// The projection is current again after failed cluster requests.
#[derive(Debug, Serialize)]
pub struct ProjectionRecovered {
    pub network: &'static str,
    pub failures: u32,
}
event!(ProjectionRecovered, "projection_recovered", Info, keep);

/// A new block's way through the live mempool, from the node's announcement: when the tracker
/// dropped what it confirmed, when the mempool topics were sent on it, and how much the
/// once-a-block refresh of every cluster then corrected. Once per block, at that refresh.
#[derive(Debug, Serialize)]
pub struct MempoolBlock {
    pub network: &'static str,
    pub height: u32,
    /// `block` (from the block's own transactions) or `listing` (the next poll caught it).
    pub path: &'static str,
    pub confirmed: usize,
    pub replaced: usize,
    pub tracker_ms: f64,
    pub sent_ms: f64,
    /// The tracker's node calls and response bytes for the block, on the `block` path.
    pub node_calls: u32,
    pub node_bytes: u64,
    pub refresh_ms: f64,
    pub refresh_set: usize,
    pub refresh_removed: usize,
    pub refresh_bytes: u64,
}
event!(MempoolBlock, "mempool_block", Info, keep);

/// The projector fell behind the tracker and rebuilt from a fresh snapshot.
#[derive(Debug, Serialize)]
pub struct ProjectionResynced {
    pub network: &'static str,
    pub txs: usize,
}
event!(ProjectionResynced, "projection_resynced", Warn);

/// Once a minute per network: the fee recommendations now, in sat per 1,000 vB, and where they
/// came from (`projected`, `node`, or `none` when nothing could be served).
#[derive(Debug, Serialize)]
pub struct FeesSummary {
    pub network: &'static str,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub medium: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_rush: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<u32>,
    pub inflow_minutes: usize,
    pub ws_messages: u64,
}
event!(FeesSummary, "fees_summary", Info, keep);

/// Our own recommendations stopped and the node's estimates (or nothing) are served instead.
/// `reason` is `warming_up`, `stale` or `engine_off`.
#[derive(Debug, Serialize)]
pub struct FeesFallbackStarted {
    pub network: &'static str,
    pub reason: &'static str,
}
event!(FeesFallbackStarted, "fees_fallback_started", Info, keep);

/// Our own recommendations are served again, after `duration_ms` of fallback.
#[derive(Debug, Serialize)]
pub struct FeesFallbackEnded {
    pub network: &'static str,
    pub duration_ms: u64,
}
event!(FeesFallbackEnded, "fees_fallback_ended", Info, keep);

/// Once a day per network, at midnight UTC: how the fee recommendations served over the day
/// before fared against the blocks that followed (docs/MEMPOOL.md, "The score the server keeps").
#[derive(Debug, Serialize)]
pub struct FeesScore {
    pub network: &'static str,
    /// Unix seconds: the start of the day scored.
    pub day: u64,
    pub levels: Vec<FeesScoreLevel>,
    /// Samples of the day when the node's estimates, or nothing, were served instead of ours.
    pub not_ours: usize,
    /// Writes to the store dropped or failed since the last line: samples kept in memory only.
    pub unsaved: u64,
}
event!(FeesScore, "fees_score", Info, keep);

/// One level of a [`FeesScore`]. The share met and the overpay are left out when fewer than
/// `min_blocks` blocks decided the level's samples.
#[derive(Debug, Serialize)]
pub struct FeesScoreLevel {
    /// `high`, `medium`, `low` or `no_rush`. Not `level`: that names the line's level.
    pub name: &'static str,
    pub scored: usize,
    /// Distinct blocks that decided them: the number of outcomes.
    pub blocks: usize,
    pub min_blocks: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub met_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub met_low_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub met_high_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overpay_sat_vb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortfall_sat_vb: Option<f64>,
    /// Left out: the horizon reached into an outage, has not finished, or had no clearing rate.
    pub outage: usize,
    pub unfinished: usize,
    pub no_clearing: usize,
}

/// A reader of the tracker's or the projector's change stream fell behind and started over
/// from a snapshot. At a total of 1, 2, 4, 8… per network and source.
#[derive(Debug, Serialize)]
pub struct MempoolSubscriberLagged {
    pub network: &'static str,
    /// `tracker` or `projector`.
    pub source: &'static str,
    pub missed: u64,
    pub total: u64,
}
event!(MempoolSubscriberLagged, "mempool_subscriber_lagged", Warn);
// Mining.

/// Every block row's pool was recomputed because the pool list or its rules changed (also on
/// the first start after the upgrade that added the column). Mining routes answer once it is done.
#[derive(Debug, Serialize)]
pub struct PoolsReattributed {
    pub network: &'static str,
    pub rows: u64,
    /// Rows whose pool changed.
    pub changed: u64,
    pub duration_ms: f64,
}
event!(PoolsReattributed, "pools_reattributed", Info, keep);

/// The block table's running totals were filled for the rows stored before they existed, once,
/// on the first start after the upgrade that added them. Reads scan the table until then.
#[derive(Debug, Serialize)]
pub struct BlockTotalsFilled {
    pub network: &'static str,
    /// Heights the fill went over.
    pub heights: u64,
    pub writes: u64,
    pub duration_ms: f64,
    /// The longest single write, waiting for the writer included.
    pub longest_write_ms: f64,
}
event!(BlockTotalsFilled, "block_totals_filled", Info, keep);

/// The mining answers were recomputed because the block table changed: once a block per
/// network, and at most once a minute while the backfill adds rows.
#[derive(Debug, Serialize)]
pub struct MiningRefreshed {
    pub network: &'static str,
    pub tip: u32,
    /// The lowest height of the history the answers cover.
    pub from: u32,
    pub answers: usize,
    pub duration_ms: f64,
}
event!(MiningRefreshed, "mining_refreshed", Debug);

/// Mining answers could not be computed from the block table; the last ones are still served.
/// Written at the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct MiningFailed {
    pub network: &'static str,
    /// `reattribute`, `refresh` or `request`.
    pub task: &'static str,
    /// `timed_out` (a read ran past the store's limit) or `store`.
    pub error: &'static str,
    pub failures: u32,
}
event!(MiningFailed, "mining_failed", Warn);

// Mempool history.

/// Rows of mempool history aged into coarser ones: minutes into hours, hours into days. About
/// once an hour per network while sampling.
#[derive(Debug, Serialize)]
pub struct MempoolHistoryRolledUp {
    pub network: &'static str,
    pub minutes: usize,
    pub hours: usize,
    /// The whole write: the minute's sample and the roll-up.
    pub duration_ms: f64,
}
event!(
    MempoolHistoryRolledUp,
    "mempool_history_rolled_up",
    Info,
    keep
);

/// Minutes left out of the mempool history, at the 1st, 2nd, 4th, 8th… in a row: `syncing`,
/// `stale`, `lagged`, `late`, `store_busy` or `store_failed`, for the latest.
#[derive(Debug, Serialize)]
pub struct MempoolHistorySkipped {
    pub network: &'static str,
    pub reason: &'static str,
    pub skipped: u32,
}
event!(MempoolHistorySkipped, "mempool_history_skipped", Info, keep);

/// A minute was sampled again after `skipped` in a row were not.
#[derive(Debug, Serialize)]
pub struct MempoolHistoryResumed {
    pub network: &'static str,
    pub skipped: u32,
}
event!(MempoolHistoryResumed, "mempool_history_resumed", Info, keep);

/// The mempool history could not be read for a request: `timed_out` past the store's read
/// limit, or `store`. At the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct MempoolHistoryFailed {
    pub network: &'static str,
    pub error: &'static str,
    pub failures: u32,
}
event!(MempoolHistoryFailed, "mempool_history_failed", Warn);

// Following transactions and addresses. Never a txid or an address: the log must not record
// what people look at.

/// One minute of the `tx:` and `address:` topics on one network, written while anything is
/// followed or happened.
#[derive(Debug, Serialize)]
pub struct TrackingSummary {
    pub network: &'static str,
    /// Followed now.
    pub txs: usize,
    pub addresses: usize,
    /// New transactions and addresses followed in the minute, refused for a full server, the
    /// messages sent and their bytes (encoded once), and addresses the node would not watch.
    pub subscribed: u64,
    pub refused: u64,
    pub messages: u64,
    pub bytes: u64,
    pub address_errors: u64,
    /// The replacement record's size now, and replacements recorded in the minute.
    pub replacements: usize,
    pub replaced: u64,
}
event!(TrackingSummary, "tracking_summary", Info, keep);

/// A socket was refused a transaction or address because the network follows its total already.
/// At a total of 1, 2, 4, 8… per kind and network.
#[derive(Debug, Serialize)]
pub struct TrackingRefused {
    pub network: &'static str,
    /// `tx` or `address`.
    pub kind: &'static str,
    /// `server_full`.
    pub reason: &'static str,
    pub total: u64,
}
event!(TrackingRefused, "tracking_refused", Warn);

/// The replacement record was put back from the store when the mempool engine started.
#[derive(Debug, Serialize)]
pub struct ReplacementsRestored {
    pub network: &'static str,
    pub links: usize,
    pub duration_ms: u64,
}
event!(ReplacementsRestored, "replacements_restored", Info, keep);

/// The replacement record asked the node where replacements are after a reorg: one line per
/// batch of reads (docs/MEMPOOL.md, "Following a transaction").
#[derive(Debug, Serialize)]
pub struct ReplacementsChecked {
    pub network: &'static str,
    /// Reads made, the failed one included.
    pub reads: usize,
    /// The node could not answer one; tried again later.
    pub failed: bool,
    /// Replacements whose state the answers changed.
    pub changed: bool,
}
event!(ReplacementsChecked, "replacements_checked", Info, keep);

/// The replacement record could not be read from or written to the store. At the 1st, 2nd, 4th,
/// 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct ReplacementsStoreFailed {
    pub network: &'static str,
    /// `restore` or `write`.
    pub task: &'static str,
    /// `queue_full`, `timed_out` or `store`.
    pub error: &'static str,
    /// Links in the write that was lost.
    pub links: usize,
    pub failures: u64,
}
event!(ReplacementsStoreFailed, "replacements_store_failed", Warn);
// Lightning (docs/LIGHTNING.md). No event carries gossip content (an alias, an address a node
// announced): peers are named as configured, channels by their short channel id. LDK's own log
// lines may quote what a peer sent; they stay in one escaped, bounded field.

/// The gossip peer started for a network: its settings and what it loaded from its graph file.
#[derive(Debug, Serialize)]
pub struct LightningStarted<'a> {
    pub network: &'static str,
    /// Peers configured, and connections kept open at once.
    pub peers: usize,
    pub max_peers: usize,
    pub max_channels: usize,
    /// `fresh` (no file), `loaded` or `unreadable` (replaced at the next save).
    pub graph: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_channels: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_nodes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_bytes: Option<u64>,
    /// Time since the graph was last caught up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_age_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_ms: Option<f64>,
    /// Why an unreadable file was unreadable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'a str>,
}
event!(LightningStarted<'a>, "lightning_started", Info, keep);

/// The gossip peer could not start (`stage` `start`: no store, an unusable data directory or
/// node key) or stopped on its own (`run`). The rest of the server keeps running.
#[derive(Debug, Serialize)]
pub struct LightningFailed<'a> {
    pub network: &'static str,
    pub stage: &'static str,
    pub error: &'a str,
}
event!(LightningFailed<'a>, "lightning_failed", Error);

/// The gossip peer stopped at shutdown, having written its graph (`graph_bytes`) or not (`error`).
#[derive(Debug, Serialize)]
pub struct LightningStopped<'a> {
    pub network: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'a str>,
    pub duration_ms: f64,
}
event!(LightningStopped<'a>, "lightning_stopped", Info, keep);

/// A Lightning peer, as configured (`<pubkey>@<ip>:<port>`), completed the handshake.
#[derive(Debug, Serialize)]
pub struct LightningPeerConnected {
    pub network: &'static str,
    pub peer: String,
}
event!(
    LightningPeerConnected,
    "lightning_peer_connected",
    Info,
    keep
);

/// A connected Lightning peer went away; it is dialled again after a backoff.
#[derive(Debug, Serialize)]
pub struct LightningPeerLost {
    pub network: &'static str,
    pub peer: String,
    pub connected_secs: u64,
}
event!(LightningPeerLost, "lightning_peer_lost", Info, keep);

/// A Lightning peer named only other chains in its `init` (a mainnet node in a signet list, say):
/// it was disconnected and is redialled after the backoff. Once per peer. `peer` is its key.
#[derive(Debug, Serialize)]
pub struct LightningPeerWrongChain {
    pub network: &'static str,
    pub peer: String,
}
event!(LightningPeerWrongChain, "lightning_peer_wrong_chain", Warn);

/// Dialling a Lightning peer failed (TCP, timeout or handshake): at the 1st, 2nd, 4th, 8th…
/// failure in a row.
#[derive(Debug, Serialize)]
pub struct LightningPeerUnreachable {
    pub network: &'static str,
    pub peer: String,
    pub failures: u32,
}
event!(LightningPeerUnreachable, "lightning_peer_unreachable", Warn);

/// The graph is complete enough to show: from peers, or from a recent file checked again.
#[derive(Debug, Serialize)]
pub struct LightningSynced {
    pub network: &'static str,
    pub after_ms: f64,
    pub nodes: usize,
    pub channels: usize,
    pub from_disk: bool,
}
event!(LightningSynced, "lightning_synced", Info, keep);

/// Once a minute while the peer runs: the graph, validation, the close-watcher, the node load
/// both cause, and what was stored. Counts are since start unless named otherwise.
#[derive(Debug, Serialize)]
pub struct LightningSummary {
    pub network: &'static str,
    pub synced: bool,
    pub peers: usize,
    pub nodes: usize,
    pub channels: usize,
    /// Validation: channels waiting to be checked, waiting for depth, and refused.
    pub unchecked: usize,
    pub pending: usize,
    pub early: usize,
    pub rejected: u64,
    /// Funding-output requests to the node and outputs asked for, and failures in a row.
    pub lookup_requests: u64,
    pub lookup_outputs: u64,
    pub lookup_failures: u32,
    /// The close-watcher: newest block read, outputs watched, channels waiting for the catch-up,
    /// blocks read, requests, failures in a row, and closes by kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_height: Option<u32>,
    pub watched: usize,
    pub catch_up: usize,
    pub blocks_read: u64,
    pub close_requests: u64,
    pub close_failures: u32,
    pub cooperative: u64,
    pub force: u64,
    pub penalty: u64,
    pub other: u64,
    pub reorgs: u64,
    /// Gossip received per second over the last ten seconds, and in all.
    pub messages_per_sec: f64,
    pub gossip_bytes: u64,
    /// Batches of listed channels a peer withheld: a graph missing channels some peer has.
    pub withheld_batches: u64,
    /// History records stored and the last one's sequence number.
    pub history_records: u64,
    pub history_seq: u64,
    /// The last index build, and funding txids learned since start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_ms: Option<f64>,
    pub funding_txids: u64,
}
event!(LightningSummary, "lightning_summary", Info, keep);

/// The first index of the synced graph was built: the routes for nodes, channels, search and
/// rankings answer from now on. Later builds, every 30 s, show in `lightning_summary`.
#[derive(Debug, Serialize)]
pub struct LightningIndexBuilt {
    pub network: &'static str,
    pub nodes: usize,
    pub channels: usize,
    /// Copying the graph, and the longest the graph's lock was held for one chunk of it.
    pub copy_ms: f64,
    pub longest_hold_ms: f64,
    pub duration_ms: f64,
}
event!(LightningIndexBuilt, "lightning_index_built", Info);

/// The index could not be built: at the 1st, 2nd, 4th, 8th… failure in a row.
#[derive(Debug, Serialize)]
pub struct LightningIndexFailed {
    pub network: &'static str,
    /// `past` (the store's read of every channel) or `build`.
    pub stage: &'static str,
    /// The store's error label for `past`; `panicked` for `build`.
    pub error: &'static str,
    pub failures: u32,
}
event!(LightningIndexFailed, "lightning_index_failed", Warn);

/// A funding-txid request to the node failed; retried after a backoff. At the 1st, 2nd, 4th…
/// failure in a row.
#[derive(Debug, Serialize)]
pub struct LightningFundingFailed {
    pub network: &'static str,
    /// A fixed label: `timeout`, `unavailable`, `refused`, `not_found`, `malformed`, `too_big`,
    /// `chain_moved` or `config`. Never the node's own text.
    pub error: &'static str,
    pub failures: u32,
}
event!(LightningFundingFailed, "lightning_funding_failed", Warn);

/// The graph reached its ceiling (`{NET}_LIGHTNING_MAX_CHANNELS`); new channels are refused.
#[derive(Debug, Serialize)]
pub struct LightningCeilingReached {
    pub network: &'static str,
    pub channels: usize,
}
event!(LightningCeilingReached, "lightning_ceiling_reached", Warn);

/// The graph file was written.
#[derive(Debug, Serialize)]
pub struct LightningGraphSaved {
    pub network: &'static str,
    pub bytes: u64,
    pub duration_ms: f64,
}
event!(LightningGraphSaved, "lightning_graph_saved", Debug);

/// The graph file could not be written; retried at the next period.
#[derive(Debug, Serialize)]
pub struct LightningSaveFailed<'a> {
    pub network: &'static str,
    pub error: &'a str,
}
event!(LightningSaveFailed<'a>, "lightning_save_failed", Warn);

/// Channels without an update for two weeks left the graph, with nodes left without a channel.
#[derive(Debug, Serialize)]
pub struct LightningPruned {
    pub network: &'static str,
    pub channels: usize,
    pub nodes: usize,
}
event!(LightningPruned, "lightning_pruned", Info, keep);

/// A funding-output request to the node failed; retried after a backoff. At the 1st, 2nd, 4th…
/// failure in a row, with the announcements waiting.
#[derive(Debug, Serialize)]
pub struct LightningLookupFailed {
    pub network: &'static str,
    /// A fixed label: `timeout`, `unavailable`, `refused`, `not_found`, `malformed`, `too_big`,
    /// `chain_moved` or `config`. Never the node's own text.
    pub error: &'static str,
    pub failures: u32,
    pub pending: usize,
}
event!(LightningLookupFailed, "lightning_lookup_failed", Warn);

/// A close-watcher request to the node failed; retried after a backoff. At the 1st, 2nd, 4th…
/// failure in a row.
#[derive(Debug, Serialize)]
pub struct LightningWatchFailed {
    pub network: &'static str,
    /// A fixed label: `timeout`, `unavailable`, `refused`, `not_found`, `malformed`, `too_big`,
    /// `chain_moved` or `config`. Never the node's own text.
    pub error: &'static str,
    pub failures: u32,
}
event!(LightningWatchFailed, "lightning_watch_failed", Warn);

/// Blocks the close-watcher had read left the best chain; what they recorded was undone.
#[derive(Debug, Serialize)]
pub struct LightningReorg {
    pub network: &'static str,
    pub fork_height: u32,
    pub disconnected: u32,
}
event!(LightningReorg, "lightning_reorg", Warn);

/// The close-watcher did not read blocks `from` (exclusive) to `to` and checks every watched
/// output instead.
#[derive(Debug, Serialize)]
pub struct LightningWatchReset {
    pub network: &'static str,
    pub from: u32,
    pub to: u32,
    pub rechecked: usize,
}
event!(LightningWatchReset, "lightning_watch_reset", Warn);

/// A channel's funding output was spent: one line per close, with how.
#[derive(Debug, Serialize)]
pub struct LightningChannelClosed {
    pub network: &'static str,
    /// `<height>x<index>x<output>`.
    pub channel: String,
    /// `cooperative`, `force`, `penalty` or `other`.
    pub kind: &'static str,
    pub height: u32,
    /// Sats; absent for a penalty, which names only the sweep.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee: Option<u64>,
}
event!(
    LightningChannelClosed,
    "lightning_channel_closed",
    Info,
    keep
);

/// The history store fell further behind than the peer keeps: `missed` records were never seen.
/// The open channels were stored again from the peer's current set; closes among the missed
/// records are lost.
#[derive(Debug, Serialize)]
pub struct LightningHistoryGap {
    pub network: &'static str,
    pub missed: u64,
    pub open: usize,
}
event!(LightningHistoryGap, "lightning_history_gap", Warn);

/// Storing history records failed (`busy`: the write queue was full; `store`); retried after a
/// backoff. At the 1st, 2nd, 4th… failure in a row. `shutdown`: the records still waiting at
/// shutdown could not be stored in time.
#[derive(Debug, Serialize)]
pub struct LightningHistoryFailed {
    pub network: &'static str,
    pub error: &'static str,
    pub failures: u32,
    pub waiting: usize,
}
event!(LightningHistoryFailed, "lightning_history_failed", Warn);

/// History records were stored again after failures.
#[derive(Debug, Serialize)]
pub struct LightningHistoryResumed {
    pub network: &'static str,
    pub failures: u32,
}
event!(
    LightningHistoryResumed,
    "lightning_history_resumed",
    Info,
    keep
);

/// A ten-minute statistics snapshot was stored, with `skipped` slots missed before it.
#[derive(Debug, Serialize)]
pub struct LightningStatsStored {
    pub network: &'static str,
    pub time: u64,
    pub channels: u64,
    pub nodes: u64,
    pub capacity: u64,
    pub skipped: u32,
    pub rolled_minutes: usize,
    pub rolled_hours: usize,
    pub duration_ms: f64,
}
event!(LightningStatsStored, "lightning_stats_stored", Info, keep);

/// Snapshots were not taken: `syncing`, `late`, `store_busy` or `store_failed`. At the 1st,
/// 2nd, 4th… in a row.
#[derive(Debug, Serialize)]
pub struct LightningStatsSkipped {
    pub network: &'static str,
    pub reason: &'static str,
    pub skipped: u32,
}
event!(LightningStatsSkipped, "lightning_stats_skipped", Info, keep);

/// A line from LDK's own logger. `message` is LDK's text, at most 512 bytes, and may quote what
/// a peer sent.
#[derive(Debug, Serialize)]
pub struct LightningLdkRecord<'a> {
    pub network: &'static str,
    pub ldk_level: &'static str,
    pub module: &'a str,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    pub message: &'a str,
}
event!(LightningLdkRecord<'a>, "lightning_ldk_record", Debug);

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use std::time::UNIX_EPOCH;

    use serde_json::Value;

    use super::*;
    use crate::Format;

    /// One line per event type, in both formats.
    fn samples() -> Vec<(&'static str, Vec<u8>, Vec<u8>)> {
        fn both<E: Event>(e: &E) -> (&'static str, Vec<u8>, Vec<u8>) {
            let at = UNIX_EPOCH;
            (
                E::NAME,
                crate::format::line(e, Format::Json, at),
                crate::format::line(e, Format::Text, at),
            )
        }
        let n = "signet";
        vec![
            both(&ServerStarting {
                version: "0.1.0",
                revision: "2912d6f0c3a1e4b5d6c7e8f9a0b1c2d3e4f5a6b7",
                listen_addr: "127.0.0.1:0".into(),
                web_dir: "web/dist".into(),
                networks: vec![n],
                log_format: "json",
                log_level: "info",
                log_requests: "all",
                log_client_addr: false,
                log_max_bytes_per_sec: 262_144,
                broadcast_enabled: true,
                max_body_bytes: 1,
                request_timeout_secs: 1,
                max_connections: 1,
                max_concurrent_requests: 1,
                client_max_connections: 1,
                client_max_concurrent_requests: 1,
                client_rate_per_sec: 1,
                client_burst: 1,
                max_tracked_clients: 1,
                trusted_proxy_header: Some("x-real-ip"),
                trusted_proxies: Some(vec!["127.0.0.1/32".into()]),
                ws_max_sockets: 1,
                ws_client_max_sockets: 1,
                ws_v1_max_sockets: 1,
                ws_v1_client_max_sockets: 1,
                ws_max_message_bytes: 1,
                ws_messages_per_sec: 1,
                ws_max_subscriptions: 1,
                ws_send_queue: 1,
                ws_idle_timeout_secs: 1,
                ws_max_block_subscriptions: 1,
                ws_mempool_interval_ms: 1,
                ws_block_wait_secs: 1,
                ws_latest_txs: 1,
                ws_max_tracked_txs: 1,
                ws_max_tracked_addresses: 1,
                ws_tracked_txs_total: 1,
                ws_tracked_addresses_total: 1,
                ws_position_interval_ms: 1,
                replacements_kept: 1,
                block_summary_cache_mb: 1,
                answer_cache_mb: 1,
                data_dir: Some("data".into()),
                backfill_enabled: true,
                backfill_busy_percent: 50,
                backfill_fee_rate_depth: 52_560,
                ledger_max_addresses: 1000,
                ledger_discover: true,
                ledger_max_history_rows: 10_000_000,
            }),
            both(&NetworkEnabled {
                network: n,
                rpc_addr: "node.example:1".into(),
                esplora: "http://node.example:2".into(),
                electrum_addr: "node.example:3",
                mempool: true,
                lightning: false,
            }),
            both(&NoNetworks {}),
            both(&WebDirMissing {
                web_dir: "web/dist".into(),
            }),
            both(&Listening {
                addr: "127.0.0.1:1".into(),
            }),
            both(&ShutdownRequested { signal: "sigterm" }),
            both(&ServerStopped {}),
            both(&ConfigInvalid { error: "bad" }),
            both(&ListenFailed {
                addr: "127.0.0.1:1".into(),
                error: "in use".into(),
            }),
            both(&Panic {
                message: "boom",
                location: "a.rs:1",
                thread: "main",
            }),
            both(&LogEventsDropped {
                count: 3,
                queue_full: 1,
                over_budget: 2,
                events: &BTreeMap::from([("http_request", 2), ("ws_closed", 1)]),
            }),
            both(&RequestsRefused {
                window_secs: 60,
                total: 5,
                logged: 1,
                reasons: &BTreeMap::from([("client_rate", 4), ("origin", 1)]),
                routes: &BTreeMap::from([("api", 4), ("ws", 1)]),
                clients: 2,
                top_client_refused: 4,
                top_client: Some("192.0.2.1".into()),
                untrusted_forwarded: 0,
                proxy_keyed: 0,
            }),
            both(&HttpRequest {
                request_id: "00ff",
                network: Some(n),
                method: "GET",
                route: "/signet/api/{*rest}",
                status: 200,
                duration_ms: 0.412,
                bytes: Some(10),
                refused: None,
                endpoint: Some("tx_status"),
                source: Some("upstream"),
                upstream_ms: Some(0.3),
                upstream_error: None,
                client: None,
            }),
            both(&ElectrumConnected {
                network: n,
                server: "rbitcoin",
                protocol: "1.6",
            }),
            both(&ElectrumDisconnected { network: n }),
            both(&ElectrumUnreachable {
                network: n,
                attempts: 4,
            }),
            both(&ElectrumResynced { network: n }),
            both(&ElectrumLinesSkipped {
                network: n,
                total: 2,
            }),
            both(&ChainReorg {
                network: n,
                fork_height: 9,
            }),
            both(&WsClosed {
                network: n,
                api: "v1",
                code: 4003,
                reason: "too_slow",
                duration_ms: 1500.0,
                open: 7,
            }),
            both(&WsClientsDropped {
                network: n,
                reason: "rate",
                total: 4,
            }),
            both(&WsOriginRefused {
                network: n,
                origin: "https://evil.example".into(),
                host: "explorer.example".into(),
                total: 2,
            }),
            both(&RpcAuthFailed { network: n }),
            both(&RpcWrongNetwork {
                network: n,
                node_chain: "main",
            }),
            both(&ConnectionsRefused { total: 8 }),
            both(&AcceptFailed {
                error: "Too many open files (os error 24)".into(),
                total: 2,
            }),
            both(&ProxyHeaderIgnored {
                header: "x-real-ip",
                peer: Some("172.18.0.1".into()),
                trusted_proxies_set: false,
                total: 1,
            }),
            both(&RpcUnreachable {
                network: n,
                error: "timeout",
                failures: 4,
            }),
            both(&RpcReachable {
                network: n,
                height: 975_523,
                failures: 4,
            }),
            both(&AddressIndexOn { network: n }),
            both(&AddressIndexOff { network: n }),
            both(&DifficultyRetried {
                network: n,
                height: 975_523,
                retries: 2,
            }),
            both(&WsFanout {
                network: n,
                topic: "blocks",
                kind: "block",
                subscribers: 2,
                open: 3,
                bytes: 1200,
                dropped_slow: 0,
                duration_ms: 4.2,
                fanout_ms: 0.05,
            }),
            both(&BlockUnavailable {
                network: n,
                height: 9,
                hash: "00".repeat(32),
                failures: 1,
            }),
            both(&BlockSummaryComputed {
                network: n,
                height: 9,
                txs: 4200,
                block_bytes: 1_600_000,
                bytes: 84_008,
                node_ms: 640.5,
                duration_ms: 650.1,
                cause: "request",
                source: "getblock",
            }),
            both(&BlockTxsSource {
                network: n,
                source: "summary_route",
                reason: "probe",
            }),
            both(&BlockTxsFellBack {
                network: n,
                reason: "not_found",
                total: 1,
            }),
            both(&BlockAudited {
                network: n,
                height: 9,
                match_rate: 99.87,
                expected_txs: 3100,
                matched_txs: 2900,
                missing_txs: 3,
                displaced_txs: 40,
                fresh_txs: 150,
                conflicted_txs: 7,
                added_txs: 60,
                unseen_txs: 1,
                duration_ms: 12.5,
            }),
            both(&BlockAuditSkipped {
                network: n,
                height: 9,
                reason: "no_projection",
            }),
            both(&BlockSummaryFailed {
                network: n,
                error: "timeout",
                failures: 2,
            }),
            both(&BlockSummariesRecovered {
                network: n,
                failures: 3,
            }),
            both(&BlockSummariesRefused {
                network: n,
                reason: "summary_busy",
                total: 8,
            }),
            both(&DifficultyComputed {
                network: n,
                height: 975_523,
                next_retarget_height: 975_744,
                difficulty_change: -6.9,
                duration_ms: 12.5,
            }),
            both(&DifficultyRefreshFailed {
                network: n,
                height: 975_523,
                error: "timeout",
                failures: 2,
            }),
            both(&StoreOpenFailed {
                network: n,
                error: "data/signet.sqlite is corrupt".into(),
            }),
            both(&StoreWrongChain {
                network: n,
                height: 0,
            }),
            both(&StoreChainUnverified {
                network: n,
                height: 900_000,
                node_height: 1_000,
            }),
            both(&StoreMigrationApplied {
                network: n,
                migration: "0001_blocks.sql",
                duration_ms: 1.5,
            }),
            both(&StoreSlowWrite {
                network: n,
                duration_ms: 1200.0,
                queue_depth: 3,
            }),
            both(&StoreWriteFailed {
                network: n,
                error: "disk_full",
                sqlite: "database or disk is full",
                failures: 4,
            }),
            both(&StoreWriteRecovered {
                network: n,
                failures: 9,
            }),
            both(&StoreReadTimedOut {
                network: n,
                read: "block_counts",
                limit_ms: 2000,
            }),
            both(&StoreReadFailed {
                network: n,
                read: "lightning_index",
                error: "io",
                sqlite: "disk I/O error",
                failures: 2,
            }),
            both(&StoreReadRecovered {
                network: n,
                read: "lightning_index",
                failures: 3,
            }),
            both(&BlockRowsFollowed {
                network: n,
                tip: 9,
                written: 1,
                rated: 1,
                duration_ms: 40.0,
            }),
            both(&LedgerFollowed {
                network: n,
                tip: Some(9),
                applied: 1,
                undone: 0,
                dropped: 0,
                reset: false,
                changed: 2,
                duration_ms: 30.0,
            }),
            both(&LedgerFollowFailed {
                network: n,
                error: "node",
                failures: 1,
            }),
            both(&LedgerSeeded {
                network: n,
                scripthash: "00".repeat(32),
                height: 9,
                page: true,
                evicted: 0,
                via: "reader",
                duration_ms: 8000.0,
            }),
            both(&LedgerTotalsRoute {
                network: n,
                uncapped: true,
            }),
            both(&LedgerSeedRefused {
                network: n,
                creates: Some(20_000),
                cap: Some(10_000),
            }),
            both(&LedgerSeedFailed {
                network: n,
                error: "timeout",
                failures: 1,
                duration_ms: 900_000.0,
            }),
            both(&LedgerFilled {
                network: n,
                scripthash: "00".repeat(32),
                height: 9,
                outcome: "joined",
                rows: 25,
                duration_ms: 100_000.0,
            }),
            both(&LedgerFillFailed {
                network: n,
                scripthash: "00".repeat(32),
                error: "node_busy",
                failures: 1,
                duration_ms: 3.0,
            }),
            both(&LedgerHistory {
                network: n,
                scripthash: "00".repeat(32),
                outcome: "whole",
                height: 9,
                rows: 1_908_560,
                evicted: 0,
                duration_ms: 18_500.0,
            }),
            both(&LedgerHistoryFailed {
                network: n,
                scripthash: "00".repeat(32),
                error: "timeout",
                failures: 1,
                duration_ms: 900_000.0,
            }),
            both(&LedgerHistoryBound {
                network: n,
                dropped: 1,
            }),
            both(&LedgerChecked {
                network: n,
                scripthash: "00".repeat(32),
                size: "small",
                duration_ms: 120.0,
            }),
            both(&BlockRowsReorged {
                network: n,
                fork_height: 8,
                stale: 1,
            }),
            both(&BlockRowsFailed {
                network: n,
                task: "totals",
                error: "busy",
                failures: 4,
            }),
            both(&BlockRowsRecovered {
                network: n,
                task: "backfill",
                failures: 4,
            }),
            both(&BlockBackfillProgress {
                network: n,
                tip: 9,
                rows: Some(5),
                rated: Some(2),
                totals_done: false,
                rates_done: false,
                totals_written: 5,
                rates_written: 2,
                busy_ms: 1000,
                bytes: 4096,
            }),
            both(&MempoolSynced {
                network: n,
                duration_ms: 10_400.0,
                txs: 54_509,
                bytes: 252_000_000,
                calls: 229,
            }),
            both(&MempoolSummary {
                network: n,
                txs: 55_000,
                cycles: 40,
                skipped: 2,
                added: 400,
                confirmed: 3_500,
                replaced: 3,
                evicted: 10,
                vanished: 1,
                node_calls: 200,
                node_bytes: 150_000_000,
                cycle_ms_max: 440.0,
                updates: 40,
                cluster_calls: 45,
                clusters_asked: 700,
                cluster_bytes: 340_000,
                pack_ms_max: 172.0,
                stale: false,
                ws_messages: 300,
                ws_bytes: 900_000,
                ws_sent_bytes: 9_000_000,
                ws_dropped_slow: 0,
                fanout_ms_max: 0.4,
            }),
            both(&MempoolPollFailed {
                network: n,
                error: "unavailable",
                failures: 4,
                retry_in_ms: 16_000,
            }),
            both(&MempoolRecovered {
                network: n,
                failures: 5,
            }),
            both(&MempoolSequenceRegressed {
                network: n,
                from: 110_704,
                to: 54_650,
            }),
            both(&ProjectionFetchFailed {
                network: n,
                error: "busy",
                failures: 2,
                pending: 30,
                retry_in_ms: 4_000,
            }),
            both(&ProjectionRecovered {
                network: n,
                failures: 2,
            }),
            both(&ProjectionResynced {
                network: n,
                txs: 55_000,
            }),
            both(&FeesSummary {
                network: n,
                source: "projected",
                high: Some(2_001),
                medium: Some(1_031),
                low: Some(126),
                no_rush: Some(121),
                minimum: Some(100),
                inflow_minutes: 30,
                ws_messages: 28,
            }),
            both(&FeesFallbackStarted {
                network: n,
                reason: "stale",
            }),
            both(&FeesFallbackEnded {
                network: n,
                duration_ms: 12_000,
            }),
            both(&FeesScore {
                network: n,
                day: 1_763_078_400,
                levels: vec![
                    FeesScoreLevel {
                        name: "high",
                        scored: 2_225,
                        blocks: 121,
                        min_blocks: 30,
                        met_pct: Some(84.6),
                        met_low_pct: Some(77.1),
                        met_high_pct: Some(90.2),
                        overpay_sat_vb: Some(1.11),
                        shortfall_sat_vb: Some(0.84),
                        outage: 0,
                        unfinished: 2,
                        no_clearing: 0,
                    },
                    FeesScoreLevel {
                        name: "no_rush",
                        scored: 0,
                        blocks: 0,
                        min_blocks: 30,
                        met_pct: None,
                        met_low_pct: None,
                        met_high_pct: None,
                        overpay_sat_vb: None,
                        shortfall_sat_vb: None,
                        outage: 0,
                        unfinished: 2_880,
                        no_clearing: 0,
                    },
                ],
                not_ours: 10,
                unsaved: 0,
            }),
            both(&MempoolBlock {
                network: n,
                height: 975_530,
                path: "block",
                confirmed: 3_502,
                replaced: 3,
                tracker_ms: 120.5,
                sent_ms: 160.25,
                node_calls: 2,
                node_bytes: 1_600_000,
                refresh_ms: 700.0,
                refresh_set: 12,
                refresh_removed: 0,
                refresh_bytes: 6_000_000,
            }),
            both(&MempoolSubscriberLagged {
                network: n,
                source: "tracker",
                missed: 3,
                total: 1,
            }),
            both(&PoolsReattributed {
                network: n,
                rows: 7850,
                changed: 7790,
                duration_ms: 80.5,
            }),
            both(&BlockTotalsFilled {
                network: n,
                heights: 975_672,
                writes: 98,
                duration_ms: 6_400.0,
                longest_write_ms: 140.0,
            }),
            both(&MiningRefreshed {
                network: n,
                tip: 975_525,
                from: 967_676,
                answers: 12,
                duration_ms: 40.2,
            }),
            both(&MiningFailed {
                network: n,
                task: "refresh",
                error: "timed_out",
                failures: 1,
            }),
            both(&MempoolHistoryRolledUp {
                network: n,
                minutes: 60,
                hours: 0,
                duration_ms: 1.2,
            }),
            both(&MempoolHistorySkipped {
                network: n,
                reason: "stale",
                skipped: 4,
            }),
            both(&MempoolHistoryResumed {
                network: n,
                skipped: 5,
            }),
            both(&MempoolHistoryFailed {
                network: n,
                error: "store",
                failures: 1,
            }),
            both(&ReplacementsRestored {
                network: n,
                links: 9_812,
                duration_ms: 31,
            }),
            both(&ReplacementsChecked {
                network: n,
                reads: 2,
                failed: false,
                changed: true,
            }),
            both(&ReplacementsStoreFailed {
                network: n,
                task: "write",
                error: "queue_full",
                links: 3,
                failures: 1,
            }),
            both(&TrackingSummary {
                network: n,
                txs: 12,
                addresses: 2,
                subscribed: 30,
                refused: 0,
                messages: 410,
                bytes: 120_000,
                address_errors: 0,
                replacements: 812,
                replaced: 9,
            }),
            both(&TrackingRefused {
                network: n,
                kind: "tx",
                reason: "server_full",
                total: 1,
            }),
            both(&LightningStarted {
                network: n,
                peers: 6,
                max_peers: 3,
                max_channels: 100_000,
                graph: "loaded",
                graph_channels: Some(36_000),
                graph_nodes: Some(13_000),
                graph_bytes: Some(32_000_000),
                graph_age_secs: Some(600),
                load_ms: Some(70.0),
                error: None,
            }),
            both(&LightningFailed {
                network: n,
                stage: "start",
                error: "Permission denied (os error 13)",
            }),
            both(&LightningStopped {
                network: n,
                graph_bytes: Some(32_000_000),
                error: None,
                duration_ms: 140.0,
            }),
            both(&LightningPeerConnected {
                network: n,
                peer: "02aa@203.0.113.1:9735".into(),
            }),
            both(&LightningPeerLost {
                network: n,
                peer: "02aa@203.0.113.1:9735".into(),
                connected_secs: 30,
            }),
            both(&LightningPeerUnreachable {
                network: n,
                peer: "02aa@203.0.113.1:9735".into(),
                failures: 4,
            }),
            both(&LightningPeerWrongChain {
                network: n,
                peer: "02aa".into(),
            }),
            both(&LightningSynced {
                network: n,
                after_ms: 84_000.0,
                nodes: 13_000,
                channels: 36_000,
                from_disk: false,
            }),
            both(&LightningSummary {
                network: n,
                synced: true,
                peers: 3,
                nodes: 13_000,
                channels: 36_000,
                unchecked: 0,
                pending: 0,
                early: 2,
                rejected: 1,
                lookup_requests: 165,
                lookup_outputs: 36_227,
                lookup_failures: 0,
                close_height: Some(975_000),
                watched: 36_000,
                catch_up: 0,
                blocks_read: 13,
                close_requests: 388,
                close_failures: 0,
                cooperative: 26,
                force: 1,
                penalty: 0,
                other: 0,
                reorgs: 0,
                messages_per_sec: 4.5,
                gossip_bytes: 50_000_000,
                withheld_batches: 0,
                history_records: 36_250,
                history_seq: 36_250,
                index_ms: Some(41.5),
                funding_txids: 36_000,
            }),
            both(&LightningIndexBuilt {
                network: n,
                nodes: 13_600,
                channels: 36_250,
                copy_ms: 12.0,
                longest_hold_ms: 0.4,
                duration_ms: 40.0,
            }),
            both(&LightningIndexFailed {
                network: n,
                stage: "past",
                error: "io",
                failures: 4,
            }),
            both(&LightningFundingFailed {
                network: n,
                error: "unavailable",
                failures: 1,
            }),
            both(&LightningCeilingReached {
                network: n,
                channels: 100_000,
            }),
            both(&LightningGraphSaved {
                network: n,
                bytes: 32_000_000,
                duration_ms: 140.0,
            }),
            both(&LightningSaveFailed {
                network: n,
                error: "No space left on device (os error 28)",
            }),
            both(&LightningPruned {
                network: n,
                channels: 12,
                nodes: 3,
            }),
            both(&LightningLookupFailed {
                network: n,
                error: "timeout",
                failures: 2,
                pending: 5_000,
            }),
            both(&LightningWatchFailed {
                network: n,
                error: "timeout",
                failures: 1,
            }),
            both(&LightningReorg {
                network: n,
                fork_height: 974_999,
                disconnected: 1,
            }),
            both(&LightningWatchReset {
                network: n,
                from: 974_980,
                to: 975_000,
                rechecked: 36_000,
            }),
            both(&LightningChannelClosed {
                network: n,
                channel: "800000x5x0".into(),
                kind: "cooperative",
                height: 975_000,
                capacity: Some(1_000_000),
                fee: Some(1_410),
            }),
            both(&LightningHistoryGap {
                network: n,
                missed: 120,
                open: 36_000,
            }),
            both(&LightningHistoryFailed {
                network: n,
                error: "busy",
                failures: 1,
                waiting: 2_000,
            }),
            both(&LightningHistoryResumed {
                network: n,
                failures: 3,
            }),
            both(&LightningStatsStored {
                network: n,
                time: 1_800_000_000,
                channels: 36_000,
                nodes: 13_000,
                capacity: 323_100_000_000,
                skipped: 1,
                rolled_minutes: 6,
                rolled_hours: 0,
                duration_ms: 3.2,
            }),
            both(&LightningStatsSkipped {
                network: n,
                reason: "syncing",
                skipped: 1,
            }),
            // LDK's text can quote a peer: it stays inside its field whatever it holds.
            both(&LightningLdkRecord {
                network: n,
                ldk_level: "warn",
                module: "lightning::ln::peer_handler",
                line: 1200,
                peer: Some("02aa".into()),
                message: "alias=\"x\"\nlevel=error event=\"forged\" \u{2028}\u{1b}[31m",
            }),
        ]
    }

    /// Names declared in this file, read from its source so a new event cannot be missed.
    fn declared() -> Vec<&'static str> {
        // rustfmt may wrap a long `event!(` call over several lines.
        include_str!("events.rs")
            .split("\nevent!(")
            .skip(1)
            .filter_map(|l| l.split('"').nth(1))
            .collect()
    }

    #[test]
    fn every_event_has_a_sample_and_a_unique_name() {
        let mut names: Vec<_> = samples().iter().map(|s| s.0).collect();
        let mut declared = declared();
        names.sort_unstable();
        declared.sort_unstable();
        assert_eq!(names, declared, "add a sample for each new event");
        names.dedup();
        assert_eq!(names.len(), declared.len(), "event names must be unique");
        for name in names {
            assert!(
                name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
                "{name} is not snake_case"
            );
        }
    }

    #[test]
    fn every_event_is_one_json_line_with_the_required_keys() {
        for (name, json, text) in samples() {
            let json = String::from_utf8(json).unwrap();
            assert_eq!(json.matches('\n').count(), 1, "{json}");
            let v: Value = serde_json::from_str(&json).unwrap();
            let prefix = format!(
                r#"{{"ts":"1970-01-01T00:00:00.000Z","level":"{}","event":"{name}""#,
                v["level"].as_str().unwrap()
            );
            assert!(json.starts_with(&prefix), "{json}");
            // A field named like a header key would repeat it and make the line ambiguous.
            for key in ["\"ts\":", "\"level\":", "\"event\":"] {
                assert_eq!(json.matches(key).count(), 1, "{json}");
            }
            let text = String::from_utf8(text).unwrap();
            assert_eq!(text.matches('\n').count(), 1, "{text}");
            assert!(text.contains(&format!(" {name}")), "{text}");
        }
    }

    #[test]
    fn a_progress_line_without_a_count_leaves_the_counts_out() {
        let line = crate::format::line(
            &BlockBackfillProgress {
                network: "mainnet",
                tip: 9,
                rows: None,
                rated: None,
                totals_done: false,
                rates_done: false,
                totals_written: 5,
                rates_written: 2,
                busy_ms: 1000,
                bytes: 4096,
            },
            Format::Json,
            UNIX_EPOCH,
        );
        let v: Value = serde_json::from_slice(&line).unwrap();
        assert!(v.get("rows").is_none() && v.get("rated").is_none(), "{v}");
        assert_eq!(v["tip"], 9);
    }

    /// Every server-wide setting in docs/CONFIG.md is in `server_starting`, under its own name
    /// in lower case. Per-network ones are in `network_enabled` and `lightning_started`.
    #[test]
    fn server_starting_lists_every_setting() {
        let (_, json, _) = samples().swap_remove(0);
        let v: Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(v["event"], "server_starting");
        let config = include_str!("../../../docs/CONFIG.md");
        let mut checked = 0;
        for line in config.lines() {
            let Some(name) = line.strip_prefix("| `").and_then(|l| l.split('`').next()) else {
                continue;
            };
            if name.starts_with('{')
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            {
                continue;
            }
            assert!(
                v.get(name.to_ascii_lowercase()).is_some(),
                "{name} is a setting in docs/CONFIG.md but not in server_starting"
            );
            checked += 1;
        }
        assert!(checked > 40, "{checked}");
    }

    #[test]
    fn every_event_is_in_the_catalogue() {
        let doc = include_str!("../../../docs/LOGGING.md");
        for name in declared() {
            assert!(
                doc.contains(&format!("| `{name}` |")),
                "{name} is missing from the catalogue in docs/LOGGING.md"
            );
        }
    }

    #[test]
    fn every_level_matches_the_catalogue() {
        let doc = include_str!("../../../docs/LOGGING.md");
        for (name, json, _) in samples() {
            let v: Value = serde_json::from_slice(&json).unwrap();
            let level = v["level"].as_str().unwrap();
            assert!(
                doc.contains(&format!("| `{name}` | {level} |")),
                "{name} is {level} in the code but not in the catalogue in docs/LOGGING.md"
            );
        }
    }
}
