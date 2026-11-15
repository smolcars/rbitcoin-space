//! A gossip-only Lightning peer. It connects out to a few public nodes, receives the gossip that
//! describes the public channel graph, and keeps that graph in memory and on disk. It opens no
//! channel, accepts none (every channel message is answered with an error), holds no funds,
//! listens for no inbound connection, does not announce itself and relays nothing.
//! Design and numbers: `docs/LIGHTNING.md`.
//!
//! **Every channel in the graph was checked against the chain** by this process: its funding
//! output exists, is unspent, is at least six blocks deep and pays the two-of-two script of the
//! announced keys. Its capacity ([`ChannelInfo::capacity_sats`]) is that output's value. Channels
//! still being checked, or refused, are not in the graph; [`Status::validation`] counts them.
//! Lookups go to rbitcoin's output-by-position routes through a [`Chain`], batched and
//! rate-limited.
//!
//! **Closed channels leave the graph** when the block that spends their funding output arrives.
//! Opens and closes, each close with how it happened ([`CloseKind`]), are kept as a history:
//! [`Peer::history`] streams it and [`Peer::recent`] keeps the newest records.
//!
//! ```no_run
//! # async fn f() -> std::io::Result<()> {
//! use ln::{Config, Peer};
//! let config = Config::new(ln::Network::Bitcoin, "/var/lib/rbitcoin-space/ln".into());
//! let chain = node::esplora::Esplora::new("http://127.0.0.1:3000").map_err(std::io::Error::other)?;
//! let (peer, _loaded) = Peer::start(config, chain)?;
//! let mut events = peer.events();
//! let channels = peer.read(|g| g.channels().len());
//! peer.shutdown().await?;
//! # Ok(()) }
//! ```

mod chain;
mod closes;
mod gossip;
mod inbound;
mod log;
mod pace;
mod peer;
mod socket;
mod store;

#[cfg(test)]
mod tests;

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

pub use lightning::bitcoin::Network;
pub use lightning::bitcoin::secp256k1::PublicKey;
pub use lightning::ln::msgs::SocketAddress;
pub use lightning::routing::gossip::{
    ChannelInfo, ChannelUpdateInfo, NodeAlias, NodeAnnouncementInfo, NodeId, NodeInfo,
    ReadOnlyNetworkGraph,
};
pub use lightning::util::logger::Level;

pub use chain::Chain;
pub use closes::{
    BlockRef, CloseKind, Closed, Closes, History, Opened, Record, classify, funding_program,
    revoked,
};
pub use inbound::inbound_fee;
pub use log::LdkRecord;
pub use peer::Peer;
pub use store::GraphLoad;

/// Where chain validation stands. Every channel in the graph is verified; the rest are counted here.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Validation {
    /// Channels in the graph. Each one's funding output was found by this process: unspent, at
    /// least six blocks deep, paying the announced keys. Its capacity is the output's value.
    pub verified: usize,
    /// Channels from the graph file not yet sent for checking: they are checked again after a
    /// restart, and are not in the graph until then.
    pub unchecked: usize,
    /// Announcements waiting for a lookup or in one.
    pub pending: usize,
    /// Announcements whose funding output is not yet six blocks deep. Checked again once it is.
    pub early: usize,
    pub rejected: Rejected,
    /// The graph file is fully replayed, and every lookup that waited at the previous check has
    /// been answered since. Not "nothing pending": a peer that keeps sending new channels keeps
    /// the queue from ever emptying. Early announcements do not count: they wait for blocks.
    pub caught_up: bool,
    /// Failed requests to the node in a row; 0 while it answers.
    pub node_failures: u32,
    /// Requests sent to the node since start, and funding outputs asked for in them.
    pub requests: u64,
    pub outputs: u64,
}

/// Channels refused by validation since start, by reason. A channel id is looked up at most once
/// while its result is cached ([`Config::cache_ttl`]), so a channel announced again is not counted
/// again until then.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rejected {
    /// No output at the announced position: an invented channel.
    pub missing: u64,
    /// The output exists but is spent: a closed channel still being gossiped.
    pub spent: u64,
    /// The output does not pay the announced keys' two-of-two script. Counted per announcement.
    pub wrong_script: u64,
    /// Announced for another chain. Counted per announcement.
    pub wrong_chain: u64,
    /// Not yet six blocks deep while [`Config::max_early`] announcements already waited.
    pub shallow: u64,
    /// Refused unchecked because [`Config::max_pending`] lookups were already queued. Peers ask
    /// for the channel again at their next channel-range sync.
    pub queue_full: u64,
}

impl Rejected {
    pub fn total(&self) -> u64 {
        self.missing
            + self.spent
            + self.wrong_script
            + self.wrong_chain
            + self.shallow
            + self.queue_full
    }
}

/// A public Lightning node to connect to: its key and a clearnet address. Written
/// `<pubkey>@<ip>:<port>`. Tor-only nodes cannot be reached: the peer makes plain TCP connections.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct PeerAddr {
    pub node_id: PublicKey,
    pub addr: SocketAddr,
}

impl FromStr for PeerAddr {
    type Err = &'static str;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (key, addr) = s.split_once('@').ok_or("expected <pubkey>@<ip>:<port>")?;
        Ok(Self {
            node_id: key.parse().map_err(|_| "invalid node public key")?,
            addr: addr
                .parse()
                .map_err(|_| "invalid address: an IP and a port")?,
        })
    }
}

impl fmt::Debug for PeerAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl fmt::Display for PeerAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}@{}", self.node_id, self.addr)
    }
}

/// Peers dialled by default on mainnet; how they were chosen is in `docs/LIGHTNING.md`.
const MAINNET_PEERS: &[&str] = &[
    // CoinGate
    "0242a4ae0c5bef18048fbecf995094b74bfb0f7391418d71ed394784373f41e4f3@3.124.63.44:9735",
    // NiceHash
    "037659a0ac8eb3b8d0a720114efc861d3a940382dcfa1403746b4f8f6b2e8810ba@34.78.139.195:9735",
    // ACINQ
    "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735",
    // 1ML
    "0217890e3aad8d35bc054f43acc00084b25229ecff0ab68debd82883ad65ee8266@66.109.24.41:9735",
    // Bitfinex: two nodes on one host
    "033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025@34.65.85.39:9735",
    "03cde60a6323f7122d5178255766e38114b4722ede08f7c9e0c5df9b912cc201d6@34.65.85.39:9745",
];

/// Peers dialled by default on the default signet; how they were chosen is in `docs/LIGHTNING.md`.
const SIGNET_PEERS: &[&str] = &[
    // lndus1-signet.dev.zaphq.io
    "0244bb7ba2392ab2d493ad04ad4afcd482ca44a2bfe5b42bcc830bfe00e5b08082@34.138.100.228:9735",
    // lndeu1-signet.dev.zaphq.io
    "03adf6efe5346d455172c750a655b07fb85be4f50f5b555f9f91a853a6b448c3bf@34.74.81.232:9735",
];

/// The default peers for `network`: fixed lists on mainnet and signet, none elsewhere.
pub fn default_peers(network: Network) -> Vec<PeerAddr> {
    let list = match network {
        Network::Bitcoin => MAINNET_PEERS,
        Network::Signet => SIGNET_PEERS,
        _ => &[],
    };
    list.iter().filter_map(|s| s.parse().ok()).collect()
}

/// Settings. [`Config::new`] fills in the defaults.
#[derive(Clone, Debug)]
pub struct Config {
    pub network: Network,
    /// Holds the identity seed and the graph file. Created if missing.
    pub data_dir: PathBuf,
    /// Nodes to connect to, in order of preference. A peer that keeps failing gives its slot to
    /// the next one. Peers come only from here, never from gossip.
    pub peers: Vec<PeerAddr>,
    /// Connections kept open at once.
    pub max_peers: usize,
    /// Most channels the graph will hold; announcements of new channels beyond it are refused
    /// and [`Event::CeilingReached`] is sent. Nodes are bounded by twice this.
    pub max_channels: usize,
    /// First retry delay after a failed or lost connection; doubles per failure up to `backoff_max`.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub connect_timeout: Duration,
    /// How often a changed graph is written to disk. It is also written at shutdown.
    pub save_every: Duration,
    /// How often [`Event::Stats`] is sent.
    pub stats_every: Duration,
    /// Initial sync counts as done once no new channel has arrived for this long.
    pub sync_settle: Duration,
    /// LDK records below this level are not formatted or sent.
    pub log_level: Level,
    /// Most LDK records sent per second; the rest are counted in [`Event::LdkSuppressed`].
    pub log_per_second: u32,
    /// Least time between the starts of two requests to the node, for all of Lightning:
    /// validation (100 outputs a request), the close-watcher and the server's funding txids go
    /// through one gate, one request at a time. After each, the node is also left alone three
    /// times as long as it took, so a slow node is asked less (`docs/LIGHTNING.md`, Load on the
    /// node).
    pub lookup_interval: Duration,
    /// Announcements waiting for a lookup. At this many, gossip from peers waits (LDK stops
    /// reading from them) until lookups drain; nothing is dropped.
    pub max_pending: usize,
    /// Announcements held because their funding output is not yet six blocks deep.
    pub max_early: usize,
    /// Signature checks one peer's gossip may cost a second, on average: a channel announcement
    /// counts eight (four now, four again when a lookup answers it), an update or node
    /// announcement one. A peer may run 60 s ahead (an initial dump fits); past that it is not
    /// read until it is back within the rate, so it cannot keep a core busy.
    pub checks_per_sec: u32,
    /// Lookup results kept, found or not, so a channel announced again is not looked up again.
    pub cache_entries: usize,
    /// How long a lookup result is kept.
    pub cache_ttl: Duration,
    /// History records kept for [`Peer::recent`], and the room of [`Peer::history`]'s stream.
    pub history: usize,
    /// How often the close-watcher asks the node for its tip.
    pub tip_every: Duration,
}

impl Config {
    pub fn new(network: Network, data_dir: PathBuf) -> Self {
        Self {
            network,
            data_dir,
            peers: default_peers(network),
            max_peers: 3,
            max_channels: 100_000,
            backoff_min: Duration::from_secs(2),
            backoff_max: Duration::from_secs(600),
            connect_timeout: Duration::from_secs(10),
            save_every: Duration::from_secs(600),
            stats_every: Duration::from_secs(10),
            sync_settle: Duration::from_secs(30),
            log_level: Level::Info,
            log_per_second: 20,
            lookup_interval: Duration::from_millis(250),
            max_pending: 5_000,
            checks_per_sec: 5_000,
            max_early: 1_000,
            cache_entries: 100_000,
            cache_ttl: Duration::from_secs(3600),
            history: 10_000,
            tip_every: Duration::from_secs(10),
        }
    }
}

/// Something in the graph changed: read it again with [`Peer::read`]. An entry no longer in the
/// graph was removed. A receiver that lags has missed changes and should rescan the graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Channel(u64),
    Node(NodeId),
}

/// The peer's state now. Updated every second.
#[derive(Clone, Debug)]
pub struct Status {
    pub validation: Validation,
    pub closes: Closes,
    /// The graph is complete enough to show: validation is caught up, and the graph came from a
    /// recent file or every channel a peer listed was requested (for at most ten minutes after the
    /// first peer connected) and no new channel has arrived for [`Config::sync_settle`].
    pub synced: bool,
    pub nodes: usize,
    pub channels: usize,
    pub at_ceiling: bool,
    pub peers: Vec<PeerStatus>,
}

#[derive(Clone, Debug)]
pub struct PeerStatus {
    pub peer: PeerAddr,
    pub connected: bool,
    /// Failed or short-lived connections in a row.
    pub failures: u32,
}

/// Gossip counts since start.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub channel_announcements: u64,
    pub node_announcements: u64,
    pub channel_updates: u64,
    /// Encoded size of all gossip messages received.
    pub bytes: u64,
    pub accepted: u64,
    pub duplicate: u64,
    /// Waiting for a funding-output lookup: announcements, and updates and node announcements of
    /// channels being checked. They enter the graph when the lookup succeeds.
    pub held: u64,
    /// Refused by LDK: invalid signature, unknown channel, older than what we have, malformed,
    /// funding output not found.
    pub rejected: u64,
    /// Oversized node announcements kept with at most 8 distinct addresses and no unknown fields.
    pub trimmed: u64,
    /// Refused for being larger than any real gossip message, even after trimming.
    pub oversize: u64,
    /// New channels refused because the graph is at [`Config::max_channels`].
    pub over_ceiling: u64,
    /// Requested batches of listed channels a peer ended, or let time out, still owing some: the
    /// channels owed are asked of another peer that listed them.
    pub withheld: u64,
}

impl Totals {
    pub fn messages(&self) -> u64 {
        self.channel_announcements + self.node_announcements + self.channel_updates
    }
}

#[derive(Clone, Debug)]
pub struct Stats {
    pub nodes: usize,
    pub channels: usize,
    pub peers: usize,
    /// Channels a peer listed that are still to be requested from it.
    pub pending_channels: usize,
    pub validation: Validation,
    pub totals: Totals,
    /// Gossip messages and their bytes per second since the previous `Stats`.
    pub messages_per_sec: f64,
    pub bytes_per_sec: f64,
}

/// What happened, as data. The library does not log; the server turns these into log events.
/// Events sent before a receiver subscribes are not seen by it; [`Status`] is the state.
#[derive(Clone, Debug)]
pub enum Event {
    /// Sent every [`Config::stats_every`].
    Stats(Stats),
    /// [`Status::synced`] became true. `after` runs from start.
    Synced {
        after: Duration,
        nodes: usize,
        channels: usize,
        from_disk: bool,
    },
    /// The handshake with a peer completed.
    PeerConnected(PeerAddr),
    /// A connected peer went away. It is redialled after a backoff.
    PeerDisconnected {
        peer: PeerAddr,
        connected_for: Duration,
    },
    /// A peer's `init` named only other chains (a mainnet node in a signet list, say): it was
    /// disconnected, and is redialled after the backoff like an unreachable one. Sent once per
    /// peer.
    PeerWrongChain(PublicKey),
    /// A connection attempt failed: TCP, timeout or handshake. `failures` is the count in a row.
    PeerUnreachable {
        peer: PeerAddr,
        failures: u32,
    },
    /// A new channel was refused because the graph holds [`Config::max_channels`]. Sent once each
    /// time the ceiling is reached.
    CeilingReached {
        channels: usize,
    },
    GraphSaved {
        bytes: u64,
        duration: Duration,
    },
    GraphSaveFailed {
        error: String,
    },
    /// Channels without an update for two weeks were dropped, with nodes left without channels.
    Pruned {
        channels: usize,
        nodes: usize,
    },
    /// A record from LDK's own logger.
    Ldk(LdkRecord),
    /// LDK records held back by the rate limit.
    LdkSuppressed {
        count: u64,
    },
    /// A request to the node for funding outputs failed. It is retried after a backoff (1 s,
    /// doubling to 60 s); `pending` announcements wait meanwhile.
    LookupFailed {
        failures: u32,
        /// A fixed label: `timeout`, `unavailable`, `refused`, `malformed` and the others of
        /// `node::esplora::Error::label`.
        error: &'static str,
        pending: usize,
    },
    /// A request of the close-watcher failed. It is retried after a backoff (1 s, doubling to
    /// 60 s); nothing is lost meanwhile.
    CloseWatchFailed {
        failures: u32,
        /// A fixed label, as for [`Event::LookupFailed`], or `chain_moved` when the chain
        /// changed under a read.
        error: &'static str,
    },
    /// Blocks the close-watcher had read left the best chain; what they did was undone.
    Reorg {
        fork: u32,
        disconnected: u32,
    },
    /// The close-watcher did not read blocks `from` (exclusive) to `to`: more than ten new ones,
    /// or a reorg deeper than its window. `rechecked` watched channels go to the catch-up.
    CloseWatchReset {
        from: u32,
        to: u32,
        rechecked: usize,
    },
}
