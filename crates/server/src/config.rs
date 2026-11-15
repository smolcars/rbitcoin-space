//! Process configuration, read once from the environment at startup. `docs/CONFIG.md` lists every variable.

use std::fmt;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use axum::http::HeaderName;

/// A chain the server can serve. Mainnet is at the root, the others under their own path prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Network {
    Mainnet,
    Signet,
    Testnet4,
    /// BIP 95. rust-bitcoin and LDK have no such network: it takes testnet4's address forms.
    Testnet5,
    Regtest,
}

impl Network {
    pub const ALL: [Self; 5] = [
        Self::Mainnet,
        Self::Signet,
        Self::Testnet4,
        Self::Testnet5,
        Self::Regtest,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Mainnet => "mainnet",
            Self::Signet => "signet",
            Self::Testnet4 => "testnet4",
            Self::Testnet5 => "testnet5",
            Self::Regtest => "regtest",
        }
    }

    /// The `chain` a node of this network reports in `getblockchaininfo`.
    pub fn rpc_chain(self) -> &'static str {
        match self {
            Self::Mainnet => "main",
            Self::Signet => "signet",
            Self::Testnet4 => "testnet4",
            Self::Testnet5 => "testnet5",
            Self::Regtest => "regtest",
        }
    }

    /// Where this network's pages and APIs are mounted: `""` for mainnet, `"/signet"` and so on.
    pub fn path_prefix(self) -> &'static str {
        match self {
            Self::Mainnet => "",
            Self::Signet => "/signet",
            Self::Testnet4 => "/testnet4",
            Self::Testnet5 => "/testnet5",
            Self::Regtest => "/regtest",
        }
    }

    fn env_prefix(self) -> &'static str {
        match self {
            Self::Mainnet => "MAINNET",
            Self::Signet => "SIGNET",
            Self::Testnet4 => "TESTNET4",
            Self::Testnet5 => "TESTNET5",
            Self::Regtest => "REGTEST",
        }
    }

    /// The network as LDK names it; `None` where LDK has no such network.
    pub fn ln(self) -> Option<ln::Network> {
        match self {
            Self::Mainnet => Some(ln::Network::Bitcoin),
            Self::Signet => Some(ln::Network::Signet),
            Self::Testnet4 => Some(ln::Network::Testnet4),
            Self::Testnet5 => None,
            Self::Regtest => Some(ln::Network::Regtest),
        }
    }
}

/// A value that must never reach a log line, error or response. `Debug` prints a placeholder and
/// there is no `Display`, so the only way to read it is to call [`Secret::expose`] on purpose.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Where the node's Esplora REST server listens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EsploraEndpoint {
    /// `http://` base URL, without a trailing slash.
    Http(String),
    /// Absolute path of a unix socket.
    Unix(PathBuf),
}

/// JSON-RPC endpoint with HTTP Basic credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcEndpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Secret,
}

/// Everything needed to reach one network's node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkConfig {
    pub network: Network,
    pub rpc: RpcEndpoint,
    pub esplora: EsploraEndpoint,
    /// Electrum TCP address as `host:port`.
    pub electrum: String,
    /// Whether the mempool tracker and projected blocks run (`{NET}_MEMPOOL_ENABLED`). They poll
    /// the node about once a second.
    pub mempool: bool,
    /// The Lightning gossip peer, when `{NET}_LIGHTNING_ENABLED` is `true`.
    pub lightning: Option<LightningConfig>,
    /// The Bark server VTXOs are looked up on (`{NET}_BARK_URL`, docs/ARK.md); unset is off.
    pub bark: Option<bark::Endpoint>,
}

/// The network's Lightning gossip peer (docs/LIGHTNING.md). Its files live in
/// `<DATA_DIR>/lightning/<network>/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LightningConfig {
    /// `{NET}_LIGHTNING_PEERS`: whom to dial, in order of preference. Mainnet and signet have defaults.
    pub peers: Vec<ln::PeerAddr>,
    /// `{NET}_LIGHTNING_MAX_PEERS`: connections kept open at once.
    pub max_peers: usize,
    /// `{NET}_LIGHTNING_MAX_CHANNELS`: the graph's ceiling, which bounds its memory.
    pub max_channels: usize,
}

/// Most peers `{NET}_LIGHTNING_PEERS` takes, and the highest `{NET}_LIGHTNING_MAX_CHANNELS`.
const MAX_LIGHTNING_PEERS: usize = 64;
const MAX_LIGHTNING_CHANNELS: usize = 1_000_000;

/// Bounds on what clients can make the server do (SECURITY.md rules 6 and 7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    pub max_body_bytes: usize,
    /// Also how long a connection may take to send request headers, or sit idle between requests.
    pub request_timeout: Duration,
    pub max_connections: usize,
    pub max_requests: usize,
    pub client_connections: u32,
    pub client_requests: u32,
    pub client_rate_per_sec: u32,
    pub client_burst: u32,
    pub max_tracked_clients: usize,
    /// Who may name the client's address in a header. `None`: always the socket peer.
    pub trusted_proxy: Option<TrustedProxy>,
    /// Memory budget of each network's block summary cache (`BLOCK_SUMMARY_CACHE_MB`).
    pub summary_cache_bytes: usize,
    /// How long a page of address history may take the node before the client is told it timed
    /// out (docs/API.md, "Very large addresses"). Fixed; a field so tests can shorten it.
    pub history_timeout: Duration,
    /// Memory budget of each network's kept answers (`ANSWER_CACHE_MB`, `crate::answers`).
    pub answer_cache_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_body_bytes: 16 * 1024,
            request_timeout: Duration::from_secs(10),
            max_connections: 1024,
            max_requests: 256,
            client_connections: 64,
            // Derived from the frontend's cold page loads: docs/CONFIG.md, "Per-client defaults".
            client_requests: 48,
            client_rate_per_sec: 20,
            client_burst: 120,
            max_tracked_clients: 65_536,
            trusted_proxy: None,
            summary_cache_bytes: 32 << 20,
            // Ordinary pages take 0.3 to 0.5 s on mainnet; every slower one measured took over 10 s.
            history_timeout: Duration::from_secs(5),
            answer_cache_bytes: 32 << 20,
        }
    }
}

/// An IP address or CIDR prefix, as `TRUSTED_PROXIES` lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IpNet {
    addr: IpAddr,
    prefix: u8,
}

impl IpNet {
    /// `192.0.2.1`, `192.0.2.0/24`, `2001:db8::1` or `2001:db8::/32`. A prefix of 0 is refused:
    /// trusting every address is the same as trusting the header from anyone.
    pub fn parse(s: &str) -> Option<Self> {
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) if p.bytes().all(|b| b.is_ascii_digit()) => (a, p.parse().ok()?),
            Some(_) => return None,
            None => (s, u8::MAX),
        };
        let addr = addr.parse::<IpAddr>().ok()?.to_canonical();
        let bits = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = if prefix == u8::MAX { bits } else { prefix };
        (1..=bits)
            .contains(&prefix)
            .then_some(Self { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = u32::MAX << (32 - u32::from(self.prefix));
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = u128::MAX << (128 - u32::from(self.prefix));
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

impl fmt::Display for IpNet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// Who may name the client's address in a header: only connections from `proxies`
/// (`TRUSTED_PROXY_HEADER` and `TRUSTED_PROXIES`, docs/CONFIG.md).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedProxy {
    pub header: HeaderName,
    pub proxies: Vec<IpNet>,
}

impl TrustedProxy {
    pub fn trusts(&self, ip: IpAddr) -> bool {
        self.proxies.iter().any(|n| n.contains(ip))
    }
}

/// Which requests get an `http_request` event (`LOG_REQUESTS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestLog {
    All,
    /// Status 400 and above, which includes every refusal.
    Failures,
    Off,
}

impl RequestLog {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Failures => "failures",
            Self::Off => "off",
        }
    }
}

/// Bounds on WebSocket connections (SECURITY.md rule 9). `docs/CONFIG.md` explains each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsLimits {
    pub max_sockets: usize,
    pub client_max_sockets: u32,
    /// Sockets open at once on the mempool.space-shaped `/api/v1/ws`, a pool apart from
    /// `max_sockets`, so other sites' pages cannot take our own pages' slots.
    pub v1_max_sockets: usize,
    /// `/api/v1/ws` sockets per client, counted apart from `client_max_sockets`.
    pub v1_client_max_sockets: u32,
    pub max_message_bytes: usize,
    pub messages_per_sec: u32,
    pub max_subscriptions: usize,
    pub send_queue: usize,
    pub idle_timeout: Duration,
    /// Projected blocks' transaction topics one socket may hold at once.
    pub max_block_subscriptions: usize,
    /// Least time between two messages of one mempool topic.
    pub mempool_interval: Duration,
    /// Transactions in the `transactions` topic's list.
    pub latest_txs: usize,
    /// `tx:<txid>` topics one socket may hold, counted inside `max_subscriptions`.
    pub max_tracked_txs: usize,
    /// `address:<address>` topics one socket may hold, counted inside `max_subscriptions`.
    pub max_tracked_addresses: usize,
    /// Distinct transactions followed at once, per network.
    pub tracked_txs_total: usize,
    /// Distinct addresses followed at once, per network: each is one Electrum subscription.
    pub tracked_addresses_total: usize,
    /// Least time between two messages of a followed transaction that only moved inside its
    /// projected block.
    pub position_interval: Duration,
    /// Replacements remembered per network, oldest out first.
    pub replacements_kept: usize,
    /// How long a new block announced by its header is waited for before clients are told to
    /// resync instead.
    pub block_wait: Duration,
}

impl Default for WsLimits {
    fn default() -> Self {
        Self {
            max_sockets: 1024,
            client_max_sockets: 16,
            v1_max_sockets: 256,
            v1_client_max_sockets: 4,
            max_message_bytes: 1024,
            messages_per_sec: 10,
            max_subscriptions: 8,
            send_queue: 64,
            idle_timeout: Duration::from_secs(60),
            max_block_subscriptions: 2,
            mempool_interval: Duration::from_secs(2),
            latest_txs: 10,
            max_tracked_txs: 4,
            max_tracked_addresses: 2,
            tracked_txs_total: 10_000,
            tracked_addresses_total: 1_000,
            position_interval: Duration::from_secs(10),
            replacements_kept: 10_000,
            block_wait: Duration::from_secs(60),
        }
    }
}

/// The address ledger (`docs/CONFIG.md`, "Very large addresses").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LedgerConfig {
    /// `LEDGER_MAX_ADDRESSES`: addresses tracked per network; the least recently viewed goes.
    pub max_addresses: usize,
    /// `LEDGER_DISCOVER`: look for large addresses in each block, without waiting for a reader.
    pub discover: bool,
    /// `LEDGER_MAX_HISTORY_ROWS`: transactions kept per network in the kept addresses' whole
    /// histories; the least recently viewed address's history goes. `0` keeps none.
    pub max_history_rows: u64,
}

impl Default for LedgerConfig {
    fn default() -> Self {
        Self {
            max_addresses: 1000,
            discover: true,
            max_history_rows: 10_000_000,
        }
    }
}

/// The block table's backfill (`docs/CONFIG.md`, "Block table").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backfill {
    /// `BACKFILL_ENABLED`. Off pauses it: the next start resumes where the table says.
    pub enabled: bool,
    /// `BACKFILL_BUSY_PERCENT`, 1 to 100.
    pub busy_percent: u32,
    /// `BACKFILL_FEE_RATE_DEPTH`: blocks below the tip that get fee rates.
    pub fee_rate_depth: u32,
}

impl Default for Backfill {
    fn default() -> Self {
        Self {
            enabled: true,
            busy_percent: 50,
            // About a year of blocks.
            fee_rate_depth: 52_560,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: SocketAddr,
    /// `WEB_DIR`: the built frontend. `None` (set to the empty string) serves no frontend.
    pub web_dir: Option<PathBuf>,
    /// `DATA_DIR`: where each network's SQLite file lives. `None` runs without a store.
    pub data_dir: Option<PathBuf>,
    pub backfill: Backfill,
    pub ledger: LedgerConfig,
    /// Enabled networks, in [`Network::ALL`] order.
    pub networks: Vec<NetworkConfig>,
    pub limits: Limits,
    pub ws: WsLimits,
    /// Whether `POST /api/tx` is served (`BROADCAST_ENABLED`).
    pub broadcast: bool,
    pub log_requests: RequestLog,
    /// Whether request events carry the client address (`LOG_CLIENT_ADDR`).
    pub log_client_addr: bool,
    /// Whether the CSP allows Cloudflare's Web Analytics beacon (`CLOUDFLARE_WEB_ANALYTICS`).
    pub cloudflare_web_analytics: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Parses configuration from a variable lookup. An empty value counts as unset, except `WEB_DIR`.
    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let var = |name: &str| get(name).filter(|v| !v.is_empty());

        let listen = match var("LISTEN_ADDR") {
            None => SocketAddr::from(([127, 0, 0, 1], 8080)),
            Some(v) => v
                .parse()
                .map_err(|_| "LISTEN_ADDR is not a socket address".to_owned())?,
        };
        let ledger = LedgerConfig {
            max_addresses: positive(
                &var,
                "LEDGER_MAX_ADDRESSES",
                LedgerConfig::default().max_addresses,
            )
            .ok()
            .filter(|n| *n <= 100_000)
            .ok_or("LEDGER_MAX_ADDRESSES must be a whole number from 1 to 100000")?,
            discover: match var("LEDGER_DISCOVER").as_deref() {
                None | Some("true") => true,
                Some("false") => false,
                Some(_) => return Err("LEDGER_DISCOVER must be true or false".into()),
            },
            max_history_rows: match var("LEDGER_MAX_HISTORY_ROWS") {
                None => LedgerConfig::default().max_history_rows,
                Some(v) => v
                    .parse::<u64>()
                    .ok()
                    .filter(|n| *n <= 1_000_000_000)
                    .ok_or("LEDGER_MAX_HISTORY_ROWS must be a whole number from 0 to 1000000000")?,
            },
        };
        // Unlike every other variable, an empty `WEB_DIR` is not unset: it turns the frontend off.
        let web_dir = match get("WEB_DIR") {
            None => Some("web/dist".into()),
            Some(v) => (!v.is_empty()).then(|| PathBuf::from(v)),
        };
        let data_dir = var("DATA_DIR").map(PathBuf::from);
        let b = Backfill::default();
        let backfill = Backfill {
            enabled: match var("BACKFILL_ENABLED").as_deref() {
                None | Some("true") => true,
                Some("false") => false,
                Some(_) => return Err("BACKFILL_ENABLED must be true or false".into()),
            },
            busy_percent: positive(&var, "BACKFILL_BUSY_PERCENT", b.busy_percent)
                .ok()
                .filter(|p| *p <= 100)
                .ok_or("BACKFILL_BUSY_PERCENT must be a whole number from 1 to 100")?,
            fee_rate_depth: match var("BACKFILL_FEE_RATE_DEPTH") {
                None => b.fee_rate_depth,
                Some(v) => v
                    .parse()
                    .map_err(|_| "BACKFILL_FEE_RATE_DEPTH must be a whole number of blocks")?,
            },
        };

        let mut networks = Vec::new();
        for network in Network::ALL {
            if let Some(n) = network_config(network, &var)? {
                if n.lightning.is_some() && data_dir.is_none() {
                    return Err(format!(
                        "{}_LIGHTNING_ENABLED needs DATA_DIR: the peer keeps its graph and history there",
                        network.env_prefix()
                    ));
                }
                networks.push(n);
            }
        }

        let d = Limits::default();
        let trusted_proxy = trusted_proxy(&var)?;
        let limits = Limits {
            max_body_bytes: positive(&var, "MAX_BODY_BYTES", d.max_body_bytes)?,
            request_timeout: Duration::from_secs(positive(
                &var,
                "REQUEST_TIMEOUT_SECS",
                d.request_timeout.as_secs(),
            )?),
            max_connections: positive(&var, "MAX_CONNECTIONS", d.max_connections)?,
            max_requests: positive(&var, "MAX_CONCURRENT_REQUESTS", d.max_requests)?,
            client_connections: positive(&var, "CLIENT_MAX_CONNECTIONS", d.client_connections)?,
            client_requests: positive(&var, "CLIENT_MAX_CONCURRENT_REQUESTS", d.client_requests)?,
            client_rate_per_sec: positive(&var, "CLIENT_RATE_PER_SEC", d.client_rate_per_sec)?,
            client_burst: positive(&var, "CLIENT_BURST", d.client_burst)?,
            max_tracked_clients: positive(&var, "MAX_TRACKED_CLIENTS", d.max_tracked_clients)?,
            trusted_proxy,
            summary_cache_bytes: positive(
                &var,
                "BLOCK_SUMMARY_CACHE_MB",
                d.summary_cache_bytes >> 20,
            )?
            .checked_mul(1 << 20)
            .filter(|b| *b <= 1 << 40)
            .ok_or("BLOCK_SUMMARY_CACHE_MB must be at most 1048576")?,
            history_timeout: d.history_timeout,
            answer_cache_bytes: positive(&var, "ANSWER_CACHE_MB", d.answer_cache_bytes >> 20)?
                .checked_mul(1 << 20)
                .filter(|b| *b <= 1 << 40)
                .ok_or("ANSWER_CACHE_MB must be at most 1048576")?,
        };
        // Semaphore permits are u32 and tokio caps them lower still; keep well inside both.
        if limits.max_connections > 1 << 20 || limits.max_requests > 1 << 20 {
            return Err(
                "MAX_CONNECTIONS and MAX_CONCURRENT_REQUESTS must be at most 1048576".into(),
            );
        }

        let w = WsLimits::default();
        let ws = WsLimits {
            max_sockets: positive(&var, "WS_MAX_SOCKETS", w.max_sockets)?,
            client_max_sockets: positive(&var, "WS_CLIENT_MAX_SOCKETS", w.client_max_sockets)?,
            v1_max_sockets: positive(&var, "WS_V1_MAX_SOCKETS", w.v1_max_sockets)?,
            v1_client_max_sockets: positive(
                &var,
                "WS_V1_CLIENT_MAX_SOCKETS",
                w.v1_client_max_sockets,
            )?,
            max_message_bytes: positive(&var, "WS_MAX_MESSAGE_BYTES", w.max_message_bytes)?,
            messages_per_sec: positive(&var, "WS_MESSAGES_PER_SEC", w.messages_per_sec)?,
            max_subscriptions: positive(&var, "WS_MAX_SUBSCRIPTIONS", w.max_subscriptions)?,
            send_queue: positive(&var, "WS_SEND_QUEUE", w.send_queue)?,
            idle_timeout: Duration::from_secs(positive(
                &var,
                "WS_IDLE_TIMEOUT_SECS",
                w.idle_timeout.as_secs(),
            )?),
            max_block_subscriptions: positive(
                &var,
                "WS_MAX_BLOCK_SUBSCRIPTIONS",
                w.max_block_subscriptions,
            )?,
            mempool_interval: Duration::from_millis(positive(
                &var,
                "WS_MEMPOOL_INTERVAL_MS",
                u64::try_from(w.mempool_interval.as_millis()).unwrap_or(u64::MAX),
            )?),
            latest_txs: positive(&var, "WS_LATEST_TXS", w.latest_txs)?,
            max_tracked_txs: positive(&var, "WS_MAX_TRACKED_TXS", w.max_tracked_txs)?,
            max_tracked_addresses: positive(
                &var,
                "WS_MAX_TRACKED_ADDRESSES",
                w.max_tracked_addresses,
            )?,
            tracked_txs_total: positive(&var, "WS_TRACKED_TXS_TOTAL", w.tracked_txs_total)?,
            tracked_addresses_total: positive(
                &var,
                "WS_TRACKED_ADDRESSES_TOTAL",
                w.tracked_addresses_total,
            )?,
            position_interval: Duration::from_millis(positive(
                &var,
                "WS_POSITION_INTERVAL_MS",
                u64::try_from(w.position_interval.as_millis()).unwrap_or(u64::MAX),
            )?),
            replacements_kept: positive(&var, "REPLACEMENTS_KEPT", w.replacements_kept)?,
            block_wait: Duration::from_secs(positive(
                &var,
                "WS_BLOCK_WAIT_SECS",
                w.block_wait.as_secs(),
            )?),
        };
        // Each address is one of the Electrum client's 10,000 subscriptions.
        if ws.tracked_txs_total > 1 << 20
            || ws.tracked_addresses_total > 10_000
            || ws.replacements_kept > 1 << 20
            || !(1_000..=600_000).contains(&ws.position_interval.as_millis())
        {
            return Err("WS_TRACKED_TXS_TOTAL and REPLACEMENTS_KEPT must be at most 1048576, \
                 WS_TRACKED_ADDRESSES_TOTAL at most 10000 and WS_POSITION_INTERVAL_MS 1000 to 600000"
                .into());
        }
        if !(1..=600).contains(&ws.block_wait.as_secs()) {
            return Err("WS_BLOCK_WAIT_SECS must be 1 to 600".into());
        }
        if !(100..=60_000).contains(&ws.mempool_interval.as_millis()) || ws.latest_txs > 100 {
            return Err(
                "WS_MEMPOOL_INTERVAL_MS must be 100 to 60000 and WS_LATEST_TXS at most 100".into(),
            );
        }
        for (name, value, max) in [
            ("WS_MAX_SOCKETS", ws.max_sockets, 1 << 20),
            ("WS_V1_MAX_SOCKETS", ws.v1_max_sockets, 1 << 20),
            ("WS_SEND_QUEUE", ws.send_queue, 1 << 16),
            ("WS_MAX_MESSAGE_BYTES", ws.max_message_bytes, 1 << 20),
        ] {
            if value > max {
                return Err(format!("{name} must be at most {max}"));
            }
        }

        let broadcast = match var("BROADCAST_ENABLED").as_deref() {
            None | Some("true") => true,
            Some("false") => false,
            Some(_) => return Err("BROADCAST_ENABLED must be true or false".into()),
        };

        let log_requests = match var("LOG_REQUESTS").as_deref() {
            None | Some("all") => RequestLog::All,
            Some("failures") => RequestLog::Failures,
            Some("off") => RequestLog::Off,
            Some(_) => return Err("LOG_REQUESTS must be all, failures or off".into()),
        };
        let log_client_addr = match var("LOG_CLIENT_ADDR").as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            Some(_) => return Err("LOG_CLIENT_ADDR must be true or false".into()),
        };
        let cloudflare_web_analytics = match var("CLOUDFLARE_WEB_ANALYTICS").as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            Some(_) => return Err("CLOUDFLARE_WEB_ANALYTICS must be true or false".into()),
        };

        Ok(Self {
            listen,
            web_dir,
            data_dir,
            backfill,
            ledger,
            networks,
            limits,
            ws,
            broadcast,
            log_requests,
            log_client_addr,
            cloudflare_web_analytics,
        })
    }
}

/// Most entries `TRUSTED_PROXIES` takes; a deployment has a handful of proxies.
const MAX_TRUSTED_PROXIES: usize = 64;

/// `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXIES`: both or neither. A header without the addresses
/// allowed to send it would let every client choose its own address (SECURITY.md rule 7).
fn trusted_proxy(var: &dyn Fn(&str) -> Option<String>) -> Result<Option<TrustedProxy>, String> {
    let (header, proxies) = match (var("TRUSTED_PROXY_HEADER"), var("TRUSTED_PROXIES")) {
        (None, None) => return Ok(None),
        (Some(_), None) => {
            return Err(
                "TRUSTED_PROXY_HEADER is set without TRUSTED_PROXIES: also name the \
                        addresses of the proxies allowed to send it"
                    .into(),
            );
        }
        (None, Some(_)) => {
            return Err(
                "TRUSTED_PROXIES is set without TRUSTED_PROXY_HEADER: also name the \
                        header those proxies write the client address to"
                    .into(),
            );
        }
        (Some(h), Some(p)) => (h, p),
    };
    let header = HeaderName::try_from(header.as_str())
        .map_err(|_| "TRUSTED_PROXY_HEADER is not a valid header name".to_owned())?;
    let proxies = proxies
        .split(',')
        .map(|p| IpNet::parse(p.trim()))
        .collect::<Option<Vec<_>>>()
        .filter(|p| !p.is_empty() && p.len() <= MAX_TRUSTED_PROXIES)
        .ok_or(
            "TRUSTED_PROXIES must be a comma-separated list of at most 64 IP addresses or \
                CIDR prefixes, none of them /0",
        )?;
    Ok(Some(TrustedProxy { header, proxies }))
}

fn positive<T>(var: &dyn Fn(&str) -> Option<String>, name: &str, default: T) -> Result<T, String>
where
    T: std::str::FromStr + PartialOrd + Default,
{
    let Some(v) = var(name) else {
        return Ok(default);
    };
    match v.parse::<T>() {
        Ok(n) if n > T::default() => Ok(n),
        _ => Err(format!("{name} must be a positive integer")),
    }
}

/// `Ok(None)` when none of the network's variables are set; an error when only some are.
fn network_config(
    network: Network,
    var: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<NetworkConfig>, String> {
    let p = network.env_prefix();
    let names = [
        "RPC_HOST",
        "RPC_PORT",
        "RPC_USER",
        "RPC_PASSWORD",
        "ESPLORA_URL",
        "ELECTRUM_ADDR",
    ]
    .map(|suffix| format!("{p}_{suffix}"));
    let values = names.clone().map(|n| var(&n));
    let missing: Vec<&str> = names
        .iter()
        .zip(&values)
        .filter(|(_, v)| v.is_none())
        .map(|(n, _)| n.as_str())
        .collect();
    if missing.len() == names.len() {
        if var(&format!("{p}_BARK_URL")).is_some() {
            return Err(format!(
                "{p}_BARK_URL is set but {} is not configured",
                network.name()
            ));
        }
        return Ok(None);
    }
    if !missing.is_empty() {
        return Err(format!(
            "{} is partly configured; also set {}",
            network.name(),
            missing.join(", ")
        ));
    }
    let [
        Some(host),
        Some(port),
        Some(user),
        Some(password),
        Some(esplora),
        Some(electrum),
    ] = values
    else {
        return Err(format!("{} is partly configured", network.name()));
    };

    if !is_host(&host) {
        return Err(format!("{p}_RPC_HOST is not a host name or IP address"));
    }
    if user.contains(':') {
        return Err(format!("{p}_RPC_USER cannot contain ':'"));
    }
    let port = parse_port(&port).ok_or_else(|| format!("{p}_RPC_PORT is not a port number"))?;
    let esplora = parse_esplora(&esplora).ok_or_else(|| {
        format!(
            "{p}_ESPLORA_URL must be a plain http URL without credentials, or an absolute unix socket path"
        )
    })?;
    if !matches!(host_port(&electrum), Some((_, Some(_)))) {
        return Err(format!("{p}_ELECTRUM_ADDR must be host:port"));
    }
    let mempool = match var(&format!("{p}_MEMPOOL_ENABLED")).as_deref() {
        None | Some("true") => true,
        Some("false") => false,
        Some(_) => return Err(format!("{p}_MEMPOOL_ENABLED must be true or false")),
    };
    let lightning = match var(&format!("{p}_LIGHTNING_ENABLED")).as_deref() {
        None | Some("false") => None,
        Some("true") => Some(lightning_config(network, var)?),
        Some(_) => return Err(format!("{p}_LIGHTNING_ENABLED must be true or false")),
    };

    let bark = var(&format!("{p}_BARK_URL"))
        .map(|u| bark::Endpoint::parse(&u).map_err(|e| format!("{p}_BARK_URL {e}")))
        .transpose()?;

    Ok(Some(NetworkConfig {
        network,
        rpc: RpcEndpoint {
            host,
            port,
            user,
            password: Secret(password),
        },
        esplora,
        electrum,
        mempool,
        lightning,
        bark,
    }))
}

fn lightning_config(
    network: Network,
    var: &dyn Fn(&str) -> Option<String>,
) -> Result<LightningConfig, String> {
    let p = network.env_prefix();
    let Some(chain) = network.ln() else {
        return Err(format!(
            "{p}_LIGHTNING_ENABLED cannot be true: LDK, the Lightning library, does not know {}",
            network.name()
        ));
    };
    let d = ln::Config::new(chain, PathBuf::new());
    let peers = match var(&format!("{p}_LIGHTNING_PEERS")) {
        None => d.peers,
        Some(list) => list
            .split(',')
            .map(|s| s.trim().parse::<ln::PeerAddr>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("{p}_LIGHTNING_PEERS: {e}"))?,
    };
    if peers.is_empty() || peers.len() > MAX_LIGHTNING_PEERS {
        return Err(format!(
            "{p}_LIGHTNING_PEERS must list 1 to 64 peers as <pubkey>@<ip>:<port>, comma-separated \
             (only mainnet and signet have defaults)"
        ));
    }
    let max_peers = positive(var, &format!("{p}_LIGHTNING_MAX_PEERS"), d.max_peers)?;
    let max_channels = positive(var, &format!("{p}_LIGHTNING_MAX_CHANNELS"), d.max_channels)?;
    if max_peers > MAX_LIGHTNING_PEERS || max_channels > MAX_LIGHTNING_CHANNELS {
        return Err(format!(
            "{p}_LIGHTNING_MAX_PEERS must be at most 64 and {p}_LIGHTNING_MAX_CHANNELS at most 1000000"
        ));
    }
    Ok(LightningConfig {
        peers,
        max_peers,
        max_channels,
    })
}

fn parse_port(s: &str) -> Option<u16> {
    s.parse().ok().filter(|&p| p != 0)
}

/// A DNS name, an IP address, or a bracketed IPv6 address; nothing that could carry a path or userinfo.
fn is_host(s: &str) -> bool {
    if let Some(v6) = s.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        return v6.parse::<Ipv6Addr>().is_ok();
    }
    let dns_name = s.len() <= 253
        && s.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        });
    s.parse::<IpAddr>().is_ok() || dns_name
}

/// Splits `host[:port]`. An IPv6 host must be bracketed here, or its colons would read as a port.
fn host_port(s: &str) -> Option<(&str, Option<u16>)> {
    let (host, port) = match s.rfind(']') {
        Some(end) => {
            let (host, rest) = s.split_at(end + 1);
            match rest.strip_prefix(':') {
                Some(port) => (host, Some(port)),
                None if rest.is_empty() => (host, None),
                None => return None,
            }
        }
        None => match s.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (s, None),
        },
    };
    let port = match port {
        Some(p) => Some(parse_port(p)?),
        None => None,
    };
    is_host(host).then_some((host, port))
}

fn parse_esplora(s: &str) -> Option<EsploraEndpoint> {
    if s.starts_with('/') {
        return Some(EsploraEndpoint::Unix(PathBuf::from(s)));
    }
    // The node speaks plain HTTP; the client has no TLS.
    let rest = s.strip_prefix("http://")?;
    let authority = rest.split('/').next().unwrap_or_default();
    // Credentials in the URL would end up in logs; whitespace and control bytes have no place in a URL.
    let ok = host_port(authority).is_some()
        && node::esplora::Endpoint::parse(s).is_ok()
        && !s
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control());
    ok.then(|| EsploraEndpoint::Http(s.trim_end_matches('/').to_owned()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn parse(vars: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Config::from_vars(|k| map.get(k).cloned())
    }

    fn signet() -> Vec<(&'static str, &'static str)> {
        vec![
            ("SIGNET_RPC_HOST", "node.example"),
            ("SIGNET_RPC_PORT", "38332"),
            ("SIGNET_RPC_USER", "u"),
            ("SIGNET_RPC_PASSWORD", "hunter2-very-secret"),
            ("SIGNET_ESPLORA_URL", "http://node.example:3002/"),
            ("SIGNET_ELECTRUM_ADDR", "node.example:60601"),
        ]
    }

    #[test]
    fn defaults_with_nothing_set() {
        let c = parse(&[]).unwrap();
        assert_eq!(c.listen.to_string(), "127.0.0.1:8080");
        assert_eq!(c.web_dir, Some("web/dist".into()));
        assert!(c.networks.is_empty());
        assert_eq!(c.limits, Limits::default());
    }

    #[test]
    fn a_fully_set_network_is_enabled() {
        let c = parse(&signet()).unwrap();
        assert_eq!(c.networks.len(), 1);
        let n = &c.networks[0];
        assert_eq!(n.network, Network::Signet);
        assert_eq!(n.rpc.port, 38332);
        assert_eq!(n.rpc.password.expose(), "hunter2-very-secret");
        assert_eq!(
            n.esplora,
            EsploraEndpoint::Http("http://node.example:3002".into())
        );
        assert!(n.mempool, "the mempool engine is on by default");
        let mut v = signet();
        v.push(("SIGNET_MEMPOOL_ENABLED", "false"));
        assert!(!parse(&v).unwrap().networks[0].mempool);
        v.pop();
        v.push(("SIGNET_MEMPOOL_ENABLED", "off"));
        assert!(parse(&v).unwrap_err().contains("SIGNET_MEMPOOL_ENABLED"));
    }

    /// `signet()` moved to another network's prefix, plus `extra`.
    fn renamed(net: &str, extra: &[(&str, &str)]) -> Vec<(String, String)> {
        signet()
            .into_iter()
            .chain(extra.iter().copied())
            .map(|(k, v)| (k.replace("SIGNET", net), v.to_owned()))
            .collect()
    }

    fn parse_owned(v: &[(String, String)]) -> Result<Config, String> {
        parse(
            &v.iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn lightning_is_off_unless_switched_on_and_needs_a_data_dir_and_peers() {
        assert_eq!(parse(&signet()).unwrap().networks[0].lightning, None);
        let peer = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut v = signet();
        v.push(("SIGNET_LIGHTNING_ENABLED", "true"));
        assert!(parse(&v).unwrap_err().contains("DATA_DIR"));
        let peers = format!("{peer}@203.0.113.1:9735, {peer}@[2001:db8::1]:9735");
        let mut with_peers = v.clone();
        with_peers.push(("SIGNET_LIGHTNING_PEERS", &peers));
        assert!(parse(&with_peers).unwrap_err().contains("DATA_DIR"));
        with_peers.push(("DATA_DIR", "/var/lib/x"));
        let l = parse(&with_peers).unwrap().networks[0]
            .lightning
            .clone()
            .unwrap();
        // An explicit list replaces the defaults entirely.
        assert_eq!(l.peers.len(), 2);
        assert!(l.peers.iter().all(|p| p.node_id.to_string() == peer));
        assert_eq!((l.max_peers, l.max_channels), (3, 100_000));
        for bad in [
            ("SIGNET_LIGHTNING_ENABLED", "yes"),
            ("SIGNET_LIGHTNING_PEERS", "02aa@203.0.113.1:9735"),
            ("SIGNET_LIGHTNING_PEERS", "node.example:9735"),
            ("SIGNET_LIGHTNING_MAX_PEERS", "0"),
            ("SIGNET_LIGHTNING_MAX_PEERS", "65"),
            ("SIGNET_LIGHTNING_MAX_CHANNELS", "1000001"),
        ] {
            let mut v = with_peers.clone();
            v.push(bad);
            assert!(parse(&v).unwrap_err().contains(bad.0), "{bad:?}");
        }
        // Mainnet and signet dial their default peers when none are named; testnet4 and regtest
        // have none and refuse to start.
        let on = [
            ("SIGNET_LIGHTNING_ENABLED", "true"),
            ("DATA_DIR", "/var/lib/x"),
        ];
        for (net, defaults) in [
            ("MAINNET", ln::default_peers(ln::Network::Bitcoin)),
            ("SIGNET", ln::default_peers(ln::Network::Signet)),
        ] {
            let c = parse_owned(&renamed(net, &on)).unwrap();
            let l = c.networks[0].lightning.clone().unwrap();
            assert!(!defaults.is_empty());
            assert_eq!(l.peers, defaults, "{net}");
        }
        for net in ["TESTNET4", "REGTEST"] {
            let e = parse_owned(&renamed(net, &on)).unwrap_err();
            assert!(
                e.contains(&format!("{net}_LIGHTNING_PEERS must list 1 to 64 peers")),
                "{e}"
            );
        }
        // LDK has no Testnet 5: refused whatever peers are named.
        let mut t5 = renamed("TESTNET5", &on);
        t5.push((
            "TESTNET5_LIGHTNING_PEERS".into(),
            format!("{peer}@203.0.113.1:9735"),
        ));
        let e = parse_owned(&t5).unwrap_err();
        assert!(
            e.contains("TESTNET5_LIGHTNING_ENABLED cannot be true") && e.contains("testnet5"),
            "{e}"
        );
        // Without Lightning it is a network like the others.
        let c = parse_owned(&renamed("TESTNET5", &[])).unwrap();
        assert_eq!(c.networks[0].network, Network::Testnet5);
        assert_eq!(c.networks[0].network.path_prefix(), "/testnet5");
    }

    #[test]
    fn unix_socket_esplora() {
        let mut v = signet();
        v[4].1 = "/run/rbitcoin/esplora.sock";
        let c = parse(&v).unwrap();
        assert_eq!(
            c.networks[0].esplora,
            EsploraEndpoint::Unix("/run/rbitcoin/esplora.sock".into())
        );
    }

    #[test]
    fn ip_literals_and_ports_are_accepted() {
        let mut v = signet();
        v[0].1 = "::1";
        v[4].1 = "http://[::1]:3002/api";
        v[5].1 = "[::1]:60601";
        assert!(parse(&v).is_ok());
        v[0].1 = "[2001:db8::1]";
        v[4].1 = "http://192.0.2.1";
        v[5].1 = "192.0.2.1:50001";
        assert!(parse(&v).is_ok());
    }

    #[test]
    fn half_set_network_names_what_is_missing() {
        let mut v = signet();
        v.remove(3);
        let e = parse(&v).unwrap_err();
        assert!(e.contains("signet is partly configured"), "{e}");
        assert!(e.contains("SIGNET_RPC_PASSWORD"), "{e}");
        // Empty counts as unset.
        let mut v = signet();
        v[2].1 = "";
        assert!(parse(&v).unwrap_err().contains("SIGNET_RPC_USER"));
    }

    #[test]
    fn invalid_values_are_refused_without_echoing_them() {
        let cases = [
            (1, "0"),
            (1, "99999"),
            (0, "host/path"),
            (0, "user@host"),
            (4, "ftp://x"),
            (4, "https://node.example"),
            (4, "http://node.example:3000/?x=1"),
            (4, "http://user:pw@host"),
            (4, "relative/socket"),
            (4, "http://"),
            (5, "no-port"),
            (5, "host:0"),
            (5, "[[bad:42"),
            (5, "::1:50001"),
            (0, ":::["),
            (0, "a..b"),
            (4, "http://node.example:99999"),
            (4, "http://[::1"),
        ];
        for (i, bad) in cases {
            let mut v = signet();
            v[i].1 = bad;
            let e = parse(&v).unwrap_err();
            assert!(e.contains(v[i].0), "{bad}: {e}");
            assert!(!e.contains(bad), "{bad} echoed in {e}");
        }
    }

    #[test]
    fn limits_parse_and_must_be_positive() {
        let c = parse(&[
            ("MAX_BODY_BYTES", "1024"),
            ("REQUEST_TIMEOUT_SECS", "3"),
            ("CLIENT_RATE_PER_SEC", "5"),
        ])
        .unwrap();
        assert_eq!(c.limits.max_body_bytes, 1024);
        assert_eq!(c.limits.request_timeout, Duration::from_secs(3));
        assert_eq!(c.limits.client_rate_per_sec, 5);
        for bad in ["0", "-1", "abc", "1.5"] {
            let e = parse(&[("CLIENT_BURST", bad)]).unwrap_err();
            assert!(e.contains("CLIENT_BURST"), "{e}");
        }
        assert!(parse(&[]).unwrap().broadcast);
        assert!(!parse(&[("BROADCAST_ENABLED", "false")]).unwrap().broadcast);
        assert!(parse(&[("BROADCAST_ENABLED", "no")]).is_err());
        let c = parse(&[]).unwrap();
        assert_eq!(
            (c.log_requests, c.log_client_addr),
            (RequestLog::All, false)
        );
        let c = parse(&[("LOG_REQUESTS", "failures"), ("LOG_CLIENT_ADDR", "true")]).unwrap();
        assert_eq!(
            (c.log_requests, c.log_client_addr),
            (RequestLog::Failures, true)
        );
        assert!(parse(&[("LOG_REQUESTS", "some")]).is_err());
        assert!(parse(&[("LOG_CLIENT_ADDR", "yes")]).is_err());
        assert!(!parse(&[]).unwrap().cloudflare_web_analytics);
        assert!(
            parse(&[("CLOUDFLARE_WEB_ANALYTICS", "true")])
                .unwrap()
                .cloudflare_web_analytics
        );
        assert!(parse(&[("CLOUDFLARE_WEB_ANALYTICS", "yes")]).is_err());
        assert!(parse(&[("MAX_CONNECTIONS", "99999999")]).is_err());
        assert_eq!(parse(&[]).unwrap().ws, WsLimits::default());
        let c = parse(&[("WS_SEND_QUEUE", "3"), ("WS_IDLE_TIMEOUT_SECS", "2")]).unwrap();
        assert_eq!(
            (c.ws.send_queue, c.ws.idle_timeout),
            (3, Duration::from_secs(2))
        );
        assert!(parse(&[("WS_MAX_SUBSCRIPTIONS", "0")]).is_err());
        let c = parse(&[
            ("WS_MAX_BLOCK_SUBSCRIPTIONS", "1"),
            ("WS_MEMPOOL_INTERVAL_MS", "500"),
            ("WS_LATEST_TXS", "25"),
        ])
        .unwrap();
        assert_eq!(
            (
                c.ws.max_block_subscriptions,
                c.ws.mempool_interval,
                c.ws.latest_txs
            ),
            (1, Duration::from_millis(500), 25)
        );
        for (k, bad) in [
            ("WS_MEMPOOL_INTERVAL_MS", "99"),
            ("WS_MEMPOOL_INTERVAL_MS", "60001"),
            ("WS_LATEST_TXS", "101"),
            ("WS_MAX_BLOCK_SUBSCRIPTIONS", "0"),
        ] {
            assert!(parse(&[(k, bad)]).is_err(), "{k}={bad}");
        }
        assert!(parse(&[("WS_SEND_QUEUE", "99999999")]).is_err());
        let c = parse(&[
            ("WS_MAX_TRACKED_TXS", "2"),
            ("WS_MAX_TRACKED_ADDRESSES", "1"),
            ("WS_TRACKED_TXS_TOTAL", "50"),
            ("WS_TRACKED_ADDRESSES_TOTAL", "5"),
            ("WS_POSITION_INTERVAL_MS", "3000"),
            ("REPLACEMENTS_KEPT", "7"),
        ])
        .unwrap();
        assert_eq!(
            (
                c.ws.max_tracked_txs,
                c.ws.max_tracked_addresses,
                c.ws.tracked_txs_total,
                c.ws.tracked_addresses_total,
                c.ws.position_interval,
                c.ws.replacements_kept
            ),
            (2, 1, 50, 5, Duration::from_secs(3), 7)
        );
        for (k, bad) in [
            ("WS_MAX_TRACKED_TXS", "0"),
            ("WS_TRACKED_ADDRESSES_TOTAL", "10001"),
            ("WS_TRACKED_TXS_TOTAL", "2000000"),
            ("REPLACEMENTS_KEPT", "0"),
            ("WS_POSITION_INTERVAL_MS", "999"),
            ("WS_POSITION_INTERVAL_MS", "600001"),
        ] {
            assert!(parse(&[(k, bad)]).is_err(), "{k}={bad}");
        }
        assert_eq!(parse(&[]).unwrap().limits.summary_cache_bytes, 32 << 20);
        let c = parse(&[("BLOCK_SUMMARY_CACHE_MB", "64")]).unwrap();
        assert_eq!(c.limits.summary_cache_bytes, 64 << 20);
        for bad in ["0", "-1", "2000000", "1.5"] {
            assert!(parse(&[("BLOCK_SUMMARY_CACHE_MB", bad)]).is_err(), "{bad}");
            assert!(parse(&[("ANSWER_CACHE_MB", bad)]).is_err(), "{bad}");
        }
        assert_eq!(parse(&[]).unwrap().limits.answer_cache_bytes, 32 << 20);
        let c = parse(&[("ANSWER_CACHE_MB", "8")]).unwrap();
        assert_eq!(c.limits.answer_cache_bytes, 8 << 20);
        let mut vars = signet();
        vars.retain(|(k, _)| *k != "SIGNET_RPC_USER");
        vars.push(("SIGNET_RPC_USER", "a:b"));
        assert!(parse(&vars).unwrap_err().contains("SIGNET_RPC_USER"));
        let c = parse(&[]).unwrap();
        assert_eq!((c.data_dir, c.backfill), (None, Backfill::default()));
        let c = parse(&[
            ("DATA_DIR", "/var/lib/x"),
            ("BACKFILL_ENABLED", "false"),
            ("BACKFILL_BUSY_PERCENT", "100"),
            ("BACKFILL_FEE_RATE_DEPTH", "0"),
        ])
        .unwrap();
        assert_eq!(c.data_dir.unwrap(), PathBuf::from("/var/lib/x"));
        assert_eq!(
            c.backfill,
            Backfill {
                enabled: false,
                busy_percent: 100,
                fee_rate_depth: 0
            }
        );
        for (k, bad) in [
            ("BACKFILL_ENABLED", "yes"),
            ("BACKFILL_BUSY_PERCENT", "0"),
            ("BACKFILL_BUSY_PERCENT", "101"),
            ("BACKFILL_FEE_RATE_DEPTH", "-1"),
            ("BACKFILL_FEE_RATE_DEPTH", "1.5"),
        ] {
            assert!(parse(&[(k, bad)]).unwrap_err().contains(k), "{k}={bad}");
        }
        let e = parse(&[("LISTEN_ADDR", "pasted-secret")]).unwrap_err();
        assert!(!e.contains("pasted-secret"), "{e}");
    }

    #[test]
    fn a_proxy_header_needs_the_proxies_allowed_to_send_it() {
        let c = parse(&[
            ("TRUSTED_PROXY_HEADER", "X-Real-IP"),
            ("TRUSTED_PROXIES", "127.0.0.1, 172.16.0.0/12,::1 ,fd00::/8"),
        ])
        .unwrap();
        let t = c.limits.trusted_proxy.unwrap();
        assert_eq!(t.header, "x-real-ip");
        let shown: Vec<String> = t.proxies.iter().map(ToString::to_string).collect();
        assert_eq!(
            shown,
            ["127.0.0.1/32", "172.16.0.0/12", "::1/128", "fd00::/8"]
        );
        for (ip, trusted) in [
            ("127.0.0.1", true),
            ("::ffff:127.0.0.1", true),
            ("127.0.0.2", false),
            ("172.31.255.1", true),
            ("172.32.0.1", false),
            ("::1", true),
            ("fdab::9", true),
            ("2001:db8::1", false),
        ] {
            assert_eq!(t.trusts(ip.parse().unwrap()), trusted, "{ip}");
        }
        // One without the other is refused, naming what is missing.
        let e = parse(&[("TRUSTED_PROXY_HEADER", "X-Real-IP")]).unwrap_err();
        assert!(e.contains("without TRUSTED_PROXIES"), "{e}");
        let e = parse(&[("TRUSTED_PROXIES", "127.0.0.1")]).unwrap_err();
        assert!(e.contains("without TRUSTED_PROXY_HEADER"), "{e}");
        let with = |h: &str, p: &str| parse(&[("TRUSTED_PROXY_HEADER", h), ("TRUSTED_PROXIES", p)]);
        assert!(
            with("bad header", "127.0.0.1")
                .unwrap_err()
                .contains("TRUSTED_PROXY_HEADER")
        );
        for bad in [
            "0.0.0.0/0",
            "::/0",
            "127.0.0.1/33",
            "::1/129",
            "127.0.0.1/",
            "127.0.0.1/+8",
            "localhost",
            "127.0.0.1,,::1",
            "10.0.0.0/8 extra",
            &vec!["10.0.0.1"; 65].join(","),
        ] {
            let e = with("X-Real-IP", bad).unwrap_err();
            assert!(
                e.contains("TRUSTED_PROXIES") && !e.contains(bad),
                "{bad}: {e}"
            );
        }
    }

    #[test]
    fn an_out_of_range_websocket_limit_names_only_itself() {
        for (name, value) in [
            ("WS_SEND_QUEUE", "65537"),
            ("WS_MAX_SOCKETS", "1048577"),
            ("WS_MAX_MESSAGE_BYTES", "1048577"),
        ] {
            let e = parse(&[(name, value)]).unwrap_err();
            assert!(e.starts_with(name), "{e}");
            for other in ["WS_SEND_QUEUE", "WS_MAX_SOCKETS", "WS_MAX_MESSAGE_BYTES"] {
                assert!(other == name || !e.contains(other), "{e}");
            }
        }
    }

    #[test]
    fn debug_output_never_contains_the_password() {
        let c = parse(&signet()).unwrap();
        let s = format!("{c:?} {:#?}", c.networks);
        assert!(!s.contains("hunter2"), "{s}");
        assert!(s.contains("redacted"));
    }

    #[test]
    fn bark_url() {
        let c = parse(&signet()).unwrap();
        assert_eq!(c.networks[0].bark, None);
        let mut v = signet();
        v.push(("SIGNET_BARK_URL", "https://ark.signet.2nd.dev"));
        let c = parse(&v).unwrap();
        assert!(c.networks[0].bark.is_some());
        for bad in [
            "ark.signet.2nd.dev",
            "https://u:p@ark.example",
            "https://ark.example/x",
        ] {
            let mut v = signet();
            v.push(("SIGNET_BARK_URL", bad));
            let e = parse(&v).unwrap_err();
            assert!(e.contains("SIGNET_BARK_URL") && !e.contains(bad), "{e}");
        }
        let e = parse(&[("MAINNET_BARK_URL", "https://ark.second.tech")]).unwrap_err();
        assert!(e.contains("MAINNET_BARK_URL is set but"), "{e}");
    }
}
