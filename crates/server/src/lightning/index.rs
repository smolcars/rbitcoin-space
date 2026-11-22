//! What the node, channel, search and ranking routes read (`docs/LIGHTNING.md`, "Routes"): an
//! [`Index`] of the verified graph, rebuilt every [`EVERY`] while the graph is synced, and the
//! funding txids the peer never learns, asked of the node in the background.
//!
//! The graph is copied [`CHUNK`] entries per hold of its lock, so gossip never waits more than a
//! millisecond or so for it, and indexed off the lock on a blocking thread that never sees the peer. Requests read
//! the finished index through an `Arc` and never touch the graph, the peer or the node.

use std::sync::atomic::Ordering;
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

use engine::lightning::{self as store_ln, Announcement, GraphChannel, GraphNode, Index, Past};
use engine::store::Store;
use logging::events::{LightningFundingFailed, LightningIndexBuilt, LightningIndexFailed};

use super::Lightning;
use crate::pages::clean_alias;
use ln::Peer;

/// How often the index is rebuilt: how far an answer can lag the graph, plus a build.
pub(crate) const EVERY: Duration = Duration::from_secs(30);
/// How soon a first index is tried again while the graph is not synced yet.
const FIRST_TRY: Duration = Duration::from_secs(5);
/// Graph entries copied per hold of its lock.
pub(crate) const CHUNK: usize = 2_000;

/// The live graph, read under its lock: the peer, or a graph built by a test.
pub(crate) trait GraphRead {
    fn read_graph<R>(&self, f: impl FnOnce(&ln::ReadOnlyNetworkGraph<'_>) -> R) -> R;
}

impl GraphRead for ln::Peer {
    fn read_graph<R>(&self, f: impl FnOnce(&ln::ReadOnlyNetworkGraph<'_>) -> R) -> R {
        self.read(f)
    }
}

fn key(id: &ln::NodeId) -> Option<[u8; 33]> {
    id.as_slice().try_into().ok()
}

fn policy(u: &ln::ChannelUpdateInfo) -> store_ln::Policy {
    store_ln::Policy {
        fee_rate: u.fees.proportional_millionths,
        base_fee_msat: u.fees.base_msat,
        cltv_delta: u.cltv_expiry_delta,
        min_htlc_msat: u.htlc_minimum_msat,
        max_htlc_msat: u.htlc_maximum_msat,
        enabled: u.enabled,
        last_update: u.last_update,
        // LDK keeps the signed update, extra data and all, when that data is at most 1,024 bytes.
        inbound: u
            .last_update_message
            .as_ref()
            .and_then(|m| ln::inbound_fee(&m.contents.excess_data))
            .map(|(base_fee_msat, fee_rate)| store_ln::Inbound {
                base_fee_msat,
                fee_rate,
            }),
    }
}

fn channel(scid: u64, c: &ln::ChannelInfo) -> Option<GraphChannel> {
    Some(GraphChannel {
        scid,
        nodes: [key(&c.node_one)?, key(&c.node_two)?],
        capacity: c.capacity_sats.unwrap_or(0),
        policies: [
            c.one_to_two.as_ref().map(policy),
            c.two_to_one.as_ref().map(policy),
        ],
    })
}

fn node(id: &ln::NodeId, n: &ln::NodeInfo) -> Option<GraphNode> {
    Some(GraphNode {
        id: key(id)?,
        announcement: n.announcement_info.as_ref().map(|a| Announcement {
            // Cleaned once, here, for every route and page title: LDK's printing (up to the first
            // NUL, control and format characters as U+FFFD), then the page's own cleaning. At most
            // 32 bytes of gossip, so at most 96 bytes here; empty when no name is left.
            alias: clean_alias(&a.alias().to_string()).unwrap_or_default(),
            color: a.rgb(),
            addresses: a.addresses().iter().map(ToString::to_string).collect(),
            features: a.features().le_flags().to_vec(),
            last_update: a.last_update(),
        }),
    })
}

/// A copy of the graph, and the longest the graph's lock was held for it.
pub(crate) struct Copy {
    pub nodes: Vec<GraphNode>,
    pub channels: Vec<GraphChannel>,
    pub longest_hold: Duration,
}

/// Copies the graph [`CHUNK`] entries at a time, releasing its lock between chunks. Gossip that
/// lands in between is copied or not; an entry gone by its chunk is skipped, and the index makes
/// sense of the rest ([`Index::build`]).
pub(crate) fn copy(g: &impl GraphRead) -> Copy {
    let mut longest_hold = Duration::ZERO;
    let mut timed = |f: &mut dyn FnMut(&ln::ReadOnlyNetworkGraph<'_>)| {
        g.read_graph(|graph| {
            let started = Instant::now();
            f(graph);
            longest_hold = longest_hold.max(started.elapsed());
        });
    };
    let (mut scids, mut ids) = (Vec::new(), Vec::new());
    timed(&mut |g| {
        scids = g.channels().unordered_keys().copied().collect();
        ids = g.nodes().unordered_keys().copied().collect();
    });
    let mut channels = Vec::with_capacity(scids.len());
    for chunk in scids.chunks(CHUNK) {
        timed(&mut |g| {
            channels.extend(chunk.iter().filter_map(|s| channel(*s, g.channel(*s)?)));
        });
    }
    let mut nodes = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(CHUNK) {
        timed(&mut |g| nodes.extend(chunk.iter().filter_map(|id| node(id, g.node(id)?))));
    }
    Copy {
        nodes,
        channels,
        longest_hold,
    }
}

/// Keeps `l`'s index current while the peer runs: every [`EVERY`], if the graph is synced, a
/// [`round`]. A graph that is not synced is never indexed, so a route never answers from a
/// half-loaded graph.
pub(crate) async fn keep(
    peer: Arc<ln::Peer>,
    store: Arc<Store>,
    l: Arc<Lightning>,
    hub: Arc<crate::ws::Hub>,
    network: &'static str,
) {
    let status = peer.status();
    let mut past = None;
    let mut run = None;
    loop {
        if status.borrow().synced {
            round(&*peer, &store, &l, network, &mut past, Index::build).await;
            // After the build, never inside it: the fee history's writes do not delay an index.
            let fees = super::fees::round(&l, &store, &mut run).await;
            if let Some(index) = l.index() {
                let started = Instant::now();
                // Live once the close-watcher has caught up, every record it sent is stored and a
                // fee round stored all it found: what a catch-up found must be in the table, which
                // the feed fills from, not on its way to it.
                let caught_up = l.feed_live()
                    || (status.borrow().closes.caught_up
                        && run.is_some_and(|(_, fees_live)| fees_live)
                        && peer.recent(l.seq.load(Ordering::Relaxed)).is_empty());
                super::feed::round(&l, &store, &hub, &index, fees, caught_up).await;
                let us = started.elapsed().as_micros().try_into().unwrap_or(u64::MAX);
                l.feed_us.store(us, Ordering::Relaxed);
            }
        }
        let wait = if l.index().is_some() {
            EVERY
        } else {
            FIRST_TRY
        };
        tokio::time::sleep(wait).await;
    }
}

/// The store's past and the index's records and statistics counts when it was read.
pub(crate) type Kept = Option<((u64, u64), Arc<Past>)>;

/// One build of the index of a synced graph: the store's past, read again only after new history
/// or statistics rows, then a copy of the graph indexed on a blocking thread by `build`. A failed
/// read keeps the last past for this build, and the next round reads again. Failures are counted
/// in `l` and reported at the 1st, 2nd, 4th… in a row; while there is no index they show as
/// [`Lightning::state`] `failed`.
pub(crate) async fn round(
    g: &impl GraphRead,
    store: &Store,
    l: &Lightning,
    network: &'static str,
    past: &mut Kept,
    build: fn(Vec<GraphNode>, Vec<GraphChannel>, &Past) -> Index,
) {
    let seen = (
        l.records.load(Ordering::Relaxed),
        l.written.load(Ordering::Acquire),
    );
    let mut failed = None;
    if past.as_ref().is_none_or(|(s, _)| *s != seen) {
        match store_ln::past(store).await {
            Ok(p) => *past = Some((seen, Arc::new(p))),
            Err(e) => failed = Some(("past", e.label())),
        }
    }
    if let Some((_, p)) = past {
        // The copy runs here, about 11 ms on mainnet, so no other task ever holds the
        // peer: at shutdown the owner gets it back whole and stops it in order.
        let started = Instant::now();
        let c = copy(g);
        let copied = started.elapsed();
        let p = Arc::clone(p);
        let built = tokio::task::spawn_blocking(move || {
            let index = build(c.nodes, c.channels, &p);
            (index, copied, started.elapsed(), c.longest_hold)
        })
        .await;
        match built {
            Ok((index, copied, took, hold)) => {
                let first = l.index().is_none();
                if first {
                    // One read of the whole graph, as a snapshot takes, once per start.
                    let sums = g.read_graph(super::totals);
                    let time = store_ln::unix_now();
                    *l.live.lock().unwrap_or_else(PoisonError::into_inner) =
                        Some(store_ln::Point {
                            time,
                            samples: 1,
                            sums,
                        });
                }
                let (nodes, channels) = index.len();
                l.set_index(index);
                l.index_ms.store(
                    took.as_micros().try_into().unwrap_or(u64::MAX),
                    Ordering::Relaxed,
                );
                let recovered = failed.is_none() && l.index_failures.load(Ordering::Relaxed) > 0;
                if first || recovered {
                    logging::emit(&LightningIndexBuilt {
                        network,
                        nodes,
                        channels,
                        copy_ms: copied.as_secs_f64() * 1000.0,
                        longest_hold_ms: hold.as_secs_f64() * 1000.0,
                        duration_ms: took.as_secs_f64() * 1000.0,
                    });
                }
            }
            // A panic in the build is a bug; it ends only this build.
            Err(_) => failed = failed.or(Some(("build", "panicked"))),
        }
    }
    match failed {
        Some((stage, error)) => {
            let failures = l
                .index_failures
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1);
            if failures.is_power_of_two() {
                logging::emit(&LightningIndexFailed {
                    network,
                    stage,
                    error,
                    failures,
                });
            }
        }
        None => l.index_failures.store(0, Ordering::Relaxed),
    }
}

/// While validation has lookups waiting, the filler checks again this often: they go first.
const FUNDING_YIELD: Duration = Duration::from_secs(1);
/// Rows read, and txids stored, per round.
const FUNDING_BATCH: usize = 300;
/// How long a caught-up filler waits before looking for new channels.
const FUNDING_IDLE: Duration = Duration::from_secs(60);

/// Asks the node for each stored channel's funding txid (`/block/:hash/txid/:index`, one small
/// request per channel, once), so a transaction's channels are found by index. Runs in the
/// background through the peer's gate (one request to the node at a time for all of Lightning),
/// and only while validation has no lookup waiting; requests never wait for it.
pub(crate) async fn fill_funding(
    chain: node::esplora::Esplora,
    peer: Arc<Peer>,
    store: Arc<Store>,
    l: Arc<Lightning>,
    network: &'static str,
) {
    let mut after = 0;
    let mut failures = 0u32;
    loop {
        let rows = store_ln::unfunded(&store, after, FUNDING_BATCH)
            .await
            .unwrap_or_default();
        let Some(&(last, _)) = rows.last() else {
            after = 0;
            tokio::time::sleep(FUNDING_IDLE).await;
            continue;
        };
        let mut found = Vec::with_capacity(rows.len());
        let status = peer.status();
        for (scid, hash) in rows {
            while status.borrow().validation.pending > 0 {
                tokio::time::sleep(FUNDING_YIELD).await;
            }
            let index = u32::try_from(scid >> 16 & 0xff_ffff).unwrap_or(0);
            match peer.paced(chain.block_txid(hash, index)).await {
                Ok(t) => {
                    found.push((scid, hash, t.value));
                    failures = 0;
                }
                // The block left the chain: the history will move the row; skip it this round.
                Err(node::esplora::Error::NotFound) => {}
                Err(e) => {
                    failures = failures.saturating_add(1);
                    if failures.is_power_of_two() {
                        logging::emit(&LightningFundingFailed {
                            network,
                            error: e.label(),
                            failures,
                        });
                    }
                    let backoff = 1u64 << failures.min(7).saturating_sub(1);
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    break;
                }
            }
        }
        let stored = found.len() as u64;
        // A full write queue or a failure loses only this round's answers: asked again later.
        if !found.is_empty() && store_ln::set_funding(&store, found).await.is_ok() {
            l.funded.fetch_add(stored, Ordering::Relaxed);
        }
        if failures == 0 {
            after = last;
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]

    use std::cell::Cell;
    use std::time::{SystemTime, UNIX_EPOCH};

    use lightning::bitcoin::Network;
    use lightning::bitcoin::constants::ChainHash;
    use lightning::ln::msgs::{SocketAddress, UnsignedChannelUpdate, UnsignedNodeAnnouncement};
    use lightning::routing::gossip::{NetworkGraph, NodeAlias, NodeId};
    use lightning::types::features::{ChannelFeatures, NodeFeatures};
    use lightning::util::logger::{Logger, Record};

    use super::*;

    struct Quiet;
    impl Logger for Quiet {
        fn log(&self, _: Record) {}
    }

    fn id(n: u32) -> NodeId {
        let mut k = [2; 33];
        k[1..5].copy_from_slice(&n.to_be_bytes());
        NodeId::from_slice(&k).unwrap()
    }

    fn now() -> u32 {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        u32::try_from(t.as_secs()).unwrap()
    }

    /// A graph that, between two reads, lets gossip write: here, a channel is closed after every
    /// read. Had a read kept the lock, the write would wait for it forever on this one thread.
    struct Busy {
        graph: NetworkGraph<&'static Quiet>,
        reads: Cell<u64>,
    }

    impl GraphRead for Busy {
        fn read_graph<R>(&self, f: impl FnOnce(&ln::ReadOnlyNetworkGraph<'_>) -> R) -> R {
            let r = self.graph.read_only();
            let out = f(&r);
            drop(r);
            let n = self.reads.get();
            self.reads.set(n + 1);
            self.graph.channel_failed_permanent((1_000 + n) << 40);
            out
        }
    }

    /// Mainnet's size, with one node announced and one channel's policy set.
    fn graph() -> Busy {
        static LOG: Quiet = Quiet;
        let graph = NetworkGraph::new(Network::Bitcoin, &LOG);
        for c in 0..36_000u32 {
            let scid = u64::from(c) << 40;
            let (a, b) = (id(c % 50), id(50 + c % 13_550));
            graph
                .add_channel_from_partial_announcement(
                    scid,
                    Some(100_000 + u64::from(c)),
                    u64::from(now()),
                    ChannelFeatures::empty(),
                    a,
                    b,
                )
                .unwrap();
        }
        let mut alias = [0; 32];
        let name = "<b>x</b>\x07\x1b[31m e\u{301}\u{301}\u{301}".as_bytes();
        alias[..name.len()].copy_from_slice(name);
        graph
            .update_node_from_unsigned_announcement(&UnsignedNodeAnnouncement {
                features: NodeFeatures::empty(),
                timestamp: now(),
                node_id: id(7),
                rgb: [1, 2, 3],
                alias: NodeAlias(alias),
                addresses: vec![SocketAddress::TcpIpV4 {
                    addr: [127, 0, 0, 1],
                    port: 9735,
                }],
                excess_address_data: Vec::new(),
                excess_data: Vec::new(),
            })
            .unwrap();
        graph
            .update_channel_unsigned(&UnsignedChannelUpdate {
                chain_hash: ChainHash::using_genesis_block(Network::Bitcoin),
                short_channel_id: 7 << 40,
                timestamp: now(),
                message_flags: 1,
                channel_flags: 1,
                cltv_expiry_delta: 144,
                htlc_minimum_msat: 1_000,
                htlc_maximum_msat: 100_000_000,
                fee_base_msat: 1_000,
                fee_proportional_millionths: 250,
                excess_data: Vec::new(),
            })
            .unwrap();
        Busy {
            graph,
            reads: Cell::new(0),
        }
    }

    #[test]
    fn the_graph_is_copied_in_short_holds_that_let_gossip_write_between_them() {
        let g = graph();
        let c = copy(&g);
        // Keys once, then 18 chunks of channels and 7 of nodes.
        assert_eq!(g.reads.get(), 1 + 18 + 7);
        // Channels closed between chunks are left out, or copied if their chunk came first.
        assert!(
            c.channels.len() < 36_000 && c.channels.len() > 35_970,
            "{}",
            c.channels.len()
        );
        let seven = c.channels.iter().find(|x| x.scid == 7 << 40).unwrap();
        assert_eq!(seven.capacity, 100_007);
        assert_eq!(seven.policies[0], None);
        let p = seven.policies[1].unwrap();
        assert_eq!(
            (p.fee_rate, p.base_fee_msat, p.cltv_delta, p.enabled),
            (250, 1_000, 144, true)
        );
        let n = c
            .nodes
            .iter()
            .find(|n| n.id[1..5] == 7u32.to_be_bytes())
            .unwrap();
        let a = n.announcement.as_ref().unwrap();
        // Markup stays text; control characters are LDK's replacement character; a run of
        // combining marks keeps two, as on the page.
        assert_eq!(a.alias, "<b>x</b>\u{fffd}\u{fffd}[31m e\u{301}\u{301}");
        assert_eq!(a.addresses, ["127.0.0.1:9735"]);
        assert_eq!(a.color, [1, 2, 3]);
        // The copy builds into an index without the graph.
        let index = Index::build(c.nodes, c.channels, &Past::default());
        assert_eq!(index.search("<b>", 10).len(), 1);
        assert_eq!(index.len().0, 13_600);
    }

    #[derive(Clone)]
    struct Capture(Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// The events logged so far for `network`. The logger is global, so each test names its own
    /// network and finds its own lines.
    fn logged(network: &str) -> Vec<serde_json::Value> {
        static CAPTURE: std::sync::OnceLock<Capture> = std::sync::OnceLock::new();
        let c = CAPTURE.get_or_init(|| {
            let c = Capture(Arc::default());
            let settings = logging::Settings {
                format: logging::Format::Json,
                level: logging::Level::Debug,
                max_bytes_per_sec: logging::DEFAULT_MAX_BYTES_PER_SEC,
            };
            assert!(logging::init(settings, c.clone()));
            c
        });
        logging::flush(Duration::from_secs(5));
        let raw = String::from_utf8(c.0.lock().unwrap().clone()).unwrap();
        raw.lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .filter(|v| v["network"] == network)
            .collect()
    }

    /// A store and a Lightning side whose peer reports a synced graph of a few channels.
    fn synced(name: &str) -> (Arc<Store>, Lightning, Busy, std::path::PathBuf) {
        static LOG: Quiet = Quiet;
        // Starts the logger: what is emitted before it is lost.
        logged(name);
        let dir = std::env::temp_dir().join(format!("index-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir, "regtest", engine::store::Options::default()).unwrap();
        let config = crate::config::LightningConfig {
            peers: Vec::new(),
            max_peers: 1,
            max_channels: 100,
        };
        let l = Lightning::new(&config, &dir, crate::config::Network::Regtest);
        let status = ln::Status {
            validation: ln::Validation::default(),
            closes: ln::Closes::default(),
            synced: true,
            nodes: 4,
            channels: 3,
            at_ceiling: false,
            peers: Vec::new(),
        };
        l.set(super::super::Phase::Running(
            tokio::sync::watch::channel(status).1,
        ));
        let graph = NetworkGraph::new(Network::Bitcoin, &LOG);
        for c in 0..3u32 {
            graph
                .add_channel_from_partial_announcement(
                    u64::from(c) << 40,
                    Some(100_000),
                    u64::from(now()),
                    ChannelFeatures::empty(),
                    id(c),
                    id(c + 10),
                )
                .unwrap();
        }
        let g = Busy {
            graph,
            reads: Cell::new(0),
        };
        (Arc::new(store), l, g, dir)
    }

    async fn sql(store: &Store, sql: &'static str) {
        store
            .write(move |s| {
                s.prepare(sql)?.execute([])?;
                Ok(())
            })
            .await
            .unwrap();
    }

    /// A failed read of the store's past is reported with the store's error, and with no index
    /// the graph shows as `failed`, not `synced` or "still syncing"; the next round that reads it
    /// builds the index and the state is `synced` again.
    #[tokio::test]
    async fn a_failed_read_of_the_past_is_reported_and_shown_until_a_build_works() {
        let (store, l, g, dir) = synced("past");
        sql(&store, "DROP TABLE ln_statistics").await;
        let mut past = None;
        round(&g, &store, &l, "index_past", &mut past, Index::build).await;
        assert!(l.index().is_none());
        assert_eq!(l.state(), "failed");
        let failed = logged("index_past");
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert_eq!(failed[0]["event"], "lightning_index_failed");
        assert_eq!(
            (
                &failed[0]["stage"],
                &failed[0]["error"],
                &failed[0]["failures"]
            ),
            (&"past".into(), &"other".into(), &1.into())
        );

        sql(
            &store,
            "CREATE TABLE ln_statistics (level INTEGER, time INTEGER)",
        )
        .await;
        round(&g, &store, &l, "index_past", &mut past, Index::build).await;
        assert_eq!(l.index().unwrap().len().1, 3);
        assert_eq!(l.state(), "synced");
        assert!(!l.index_failing());
        let events = logged("index_past");
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[1]["event"], "lightning_index_built");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn panics(_: Vec<GraphNode>, _: Vec<GraphChannel>, _: &Past) -> Index {
        panic!("a bug in the build")
    }

    /// A build that panics ends only that build: it is reported, the graph shows as `failed`
    /// while there is no index, and the next build serves it.
    #[tokio::test]
    async fn a_panicking_build_is_reported_and_the_next_one_serves() {
        let (store, l, g, dir) = synced("build");
        let mut past = None;
        round(&g, &store, &l, "index_build", &mut past, panics).await;
        assert!(l.index().is_none());
        assert_eq!(l.state(), "failed");
        let failed = logged("index_build");
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert_eq!(
            (
                &failed[0]["event"],
                &failed[0]["stage"],
                &failed[0]["error"]
            ),
            (
                &"lightning_index_failed".into(),
                &"build".into(),
                &"panicked".into()
            )
        );
        round(&g, &store, &l, "index_build", &mut past, Index::build).await;
        assert_eq!(l.state(), "synced");
        assert_eq!(logged("index_build")[1]["event"], "lightning_index_built");
        let _ = std::fs::remove_dir_all(dir);
    }
}
