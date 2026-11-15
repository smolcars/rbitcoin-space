//! The verified graph as the Lightning routes read it: a copy of the live graph, with what the
//! store adds (each node's oldest funding and its closes), indexed once per build, so a node page,
//! a channel page, a search or a ranking never walks the graph (`docs/LIGHTNING.md`, "Routes").
//! The server takes the copy from the peer and builds an [`Index`] off its lock.

use std::collections::{BTreeMap, HashMap};

use super::DAY;

/// Nodes kept in each ranking.
pub const RANKED: usize = 100;

/// What one node charges to forward over one channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Parts per million of the amount.
    pub fee_rate: u32,
    pub base_fee_msat: u32,
    pub cltv_delta: u16,
    pub min_htlc_msat: u64,
    pub max_htlc_msat: u64,
    pub enabled: bool,
    /// The update's own timestamp, Unix seconds.
    pub last_update: u32,
    /// lnd's inbound fee, when the update carries one.
    pub inbound: Option<Inbound>,
}

/// An inbound fee: what a node adds to, or with a negative value takes off, the fee of a payment
/// that reaches it over the channel. lnd's extension; usually a discount.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inbound {
    pub base_fee_msat: i32,
    /// Parts per million.
    pub fee_rate: i32,
}

/// A verified channel in the live graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphChannel {
    pub scid: u64,
    /// Node one and node two, as announced.
    pub nodes: [[u8; 33]; 2],
    /// Sats: the funding output's value.
    pub capacity: u64,
    /// What each node charges: `policies[0]` is node one's. `None` until it sent one.
    pub policies: [Option<Policy>; 2],
}

impl GraphChannel {
    /// Some direction can forward: it has a policy and it is enabled.
    pub fn active(&self) -> bool {
        self.policies.iter().flatten().any(|p| p.enabled)
    }

    /// The newer policy's timestamp.
    pub fn last_update(&self) -> Option<u32> {
        self.policies.iter().flatten().map(|p| p.last_update).max()
    }

    /// 0 for node one, 1 for node two.
    pub fn side(&self, node: &[u8; 33]) -> Option<usize> {
        self.nodes.iter().position(|n| n == node)
    }
}

/// What a node announced. Every field is the node's own claim: the alias in particular is any
/// 32 bytes it chose, another node's name included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    /// As LDK prints it: up to the first NUL, control characters replaced by U+FFFD.
    pub alias: String,
    pub color: [u8; 3],
    /// `host:port`, as announced.
    pub addresses: Vec<String>,
    /// Feature flags, little-endian bytes as LDK holds them: bit 0 is the low bit of byte 0.
    pub features: Vec<u8>,
    pub last_update: u32,
}

/// A node in the live graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNode {
    pub id: [u8; 33],
    pub announcement: Option<Announcement>,
}

/// What the store knows of a node beyond the live graph.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NodePast {
    /// The oldest funding block time of its channels we hold, open or closed.
    pub first_seen: u64,
    /// Closed channels by kind: cooperative, force, penalty (a breach), other.
    pub closed: [u32; 4],
}

/// The store's part of an index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Past {
    pub nodes: HashMap<[u8; 33], NodePast>,
    /// The oldest statistics row: when our history starts.
    pub start: Option<u64>,
    /// Every stored channel's funding block time, by short channel id.
    pub funded: Vec<(u64, u64)>,
}

/// One stored channel of a node, for its history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    /// Funding and closing block times.
    pub open: u64,
    pub close: Option<u64>,
    pub capacity: u64,
}

/// A node with its open channels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub id: [u8; 33],
    pub announcement: Option<Announcement>,
    /// Sats over its open channels.
    pub capacity: u64,
    /// Open channels that can forward.
    pub active: u32,
    pub past: Option<NodePast>,
    /// Its place among the nodes held by capacity and by open channels, 1 the largest, ties
    /// broken as the rankings break them.
    pub rank: [u32; 2],
    /// Indices into [`Index`]'s channels: largest first, then by short channel id.
    channels: Vec<u32>,
    /// The alias, lowercased: what a search matches.
    key: String,
}

impl Node {
    pub fn alias(&self) -> Option<&str> {
        self.announcement.as_ref().map(|a| a.alias.as_str())
    }

    /// Open channels.
    pub fn open(&self) -> usize {
        self.channels.len()
    }

    /// The alias, lowercased: what a search matches. Empty without one.
    pub fn alias_key(&self) -> &str {
        &self.key
    }
}

/// One of a node's open channels, as [`Index::links`] gives it.
#[derive(Debug, Clone, Copy)]
pub struct Link<'a> {
    pub channel: &'a GraphChannel,
    /// The funding block time, once the store has it.
    pub funded: Option<u64>,
    /// The node at the other end, and its place in the index: equal for the same peer.
    pub peer: Option<&'a Node>,
    pub peer_at: u32,
}

/// A ranking of nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rank {
    /// Most capacity first.
    Capacity,
    /// Most open channels first.
    Channels,
    /// Oldest first funding first.
    Age,
}

/// One bar of a node's fee histogram: policies whose fee rate falls in `bucket` (ppm, `None` for
/// channels with no policy that way), and the channels' capacity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bucket {
    pub bucket: Option<u64>,
    pub count: u64,
    pub capacity: u64,
}

/// One point of a node's past: its open channels and their capacity at `time`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodePoint {
    pub time: u64,
    pub channels: u64,
    pub capacity: u64,
}

/// The graph indexed for reading. Built whole and never changed: a newer graph is a new index.
#[derive(Debug, Clone, Default)]
pub struct Index {
    /// By public key.
    nodes: Vec<Node>,
    /// By short channel id.
    channels: Vec<GraphChannel>,
    /// Each channel's funding block time, in `channels`' order: `None` before the store has it.
    funded: Vec<Option<u64>>,
    /// Each channel's two nodes as indices into `nodes`, in `channels`' order.
    ends: Vec<[u32; 2]>,
    /// The top [`RANKED`] nodes by capacity, channels and age, as indices into `nodes`.
    ranked: [Vec<u32>; 3],
    /// When our history starts (the oldest statistics row).
    pub start: Option<u64>,
}

fn at(i: usize) -> u32 {
    u32::try_from(i).unwrap_or(u32::MAX)
}

impl Index {
    /// Indexes a copy of the graph. Channels named twice count once; a node left without a
    /// channel (it lost its last one while the copy was taken) is left out, as the graph would,
    /// and a channel whose node was not copied gets a node without an announcement.
    pub fn build(nodes: Vec<GraphNode>, mut channels: Vec<GraphChannel>, past: &Past) -> Self {
        channels.sort_unstable_by_key(|c| c.scid);
        channels.dedup_by_key(|c| c.scid);
        let mut announced: HashMap<[u8; 33], Option<Announcement>> =
            nodes.into_iter().map(|n| (n.id, n.announcement)).collect();
        let mut ids: Vec<[u8; 33]> = channels.iter().flat_map(|c| c.nodes).collect();
        ids.sort_unstable();
        ids.dedup();
        let mut nodes: Vec<Node> = ids
            .into_iter()
            .map(|id| {
                let announcement = announced.remove(&id).flatten();
                Node {
                    id,
                    key: announcement
                        .as_ref()
                        .map(|a| a.alias.to_lowercase())
                        .unwrap_or_default(),
                    announcement,
                    capacity: 0,
                    active: 0,
                    past: past.nodes.get(&id).copied(),
                    rank: [0; 2],
                    channels: Vec::new(),
                }
            })
            .collect();
        let mut ends = Vec::with_capacity(channels.len());
        for (i, c) in channels.iter().enumerate() {
            let mut end = [u32::MAX; 2];
            for (e, id) in end.iter_mut().zip(&c.nodes) {
                if let Ok(n) = nodes.binary_search_by(|n| n.id.cmp(id)) {
                    *e = at(n);
                    let Some(n) = nodes.get_mut(n) else { continue };
                    n.channels.push(at(i));
                    n.capacity += c.capacity;
                    n.active += u32::from(c.active());
                }
            }
            ends.push(end);
        }
        let cap = |i: &u32| channels.get(*i as usize).map_or(0, |c| c.capacity);
        for n in &mut nodes {
            n.channels
                .sort_unstable_by(|a, b| cap(b).cmp(&cap(a)).then(a.cmp(b)));
        }
        let rank = |r: Rank| {
            let mut all: Vec<u32> = (0..nodes.len()).map(at).collect();
            // Sort keys; ties go to the lower public key, which is each node's place in `nodes`.
            let key = |i: &u32| {
                nodes.get(*i as usize).map_or((0, 0, u64::MAX), |n| {
                    let open = n.open() as u64;
                    let first = n.past.map_or(u64::MAX, |p| p.first_seen);
                    match r {
                        Rank::Capacity => (u64::MAX - n.capacity, u64::MAX - open, 0),
                        Rank::Channels => (u64::MAX - open, u64::MAX - n.capacity, 0),
                        Rank::Age => (first, 0, 0),
                    }
                })
            };
            if r == Rank::Age {
                all.retain(|i| nodes.get(*i as usize).is_some_and(|n| n.past.is_some()));
            }
            all.sort_unstable_by_key(|i| (key(i), *i));
            all
        };
        let mut ranked = [rank(Rank::Capacity), rank(Rank::Channels), rank(Rank::Age)];
        for (side, list) in ranked.iter().take(2).enumerate() {
            for (place, i) in list.iter().enumerate() {
                if let Some(r) = nodes
                    .get_mut(*i as usize)
                    .and_then(|n| n.rank.get_mut(side))
                {
                    *r = at(place + 1);
                }
            }
        }
        ranked.iter_mut().for_each(|r| r.truncate(RANKED));
        let funded = channels
            .iter()
            .map(|c| {
                let i = past.funded.binary_search_by_key(&c.scid, |f| f.0).ok()?;
                past.funded.get(i).map(|f| f.1)
            })
            .collect();
        Self {
            nodes,
            channels,
            funded,
            ends,
            ranked,
            start: past.start,
        }
    }

    /// Nodes and channels held.
    pub fn len(&self) -> (usize, usize) {
        (self.nodes.len(), self.channels.len())
    }

    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
    }

    pub fn node(&self, id: &[u8; 33]) -> Option<&Node> {
        let i = self.nodes.binary_search_by(|n| n.id.cmp(id)).ok()?;
        self.nodes.get(i)
    }

    pub fn channel(&self, scid: u64) -> Option<&GraphChannel> {
        let i = self.channels.binary_search_by_key(&scid, |c| c.scid).ok()?;
        self.channels.get(i)
    }

    /// Every channel, by short channel id.
    pub fn channels(&self) -> &[GraphChannel] {
        &self.channels
    }

    /// A node's open channels, largest first.
    pub fn channels_of<'a>(&'a self, n: &'a Node) -> impl Iterator<Item = &'a GraphChannel> {
        n.channels
            .iter()
            .filter_map(|i| self.channels.get(*i as usize))
    }

    /// A node's open channels, largest first, each with its funding time and the node at its
    /// other end: no lookups, so a request can read every one of a large node's channels.
    pub fn links<'a>(&'a self, n: &'a Node) -> impl Iterator<Item = Link<'a>> {
        let me = self.nodes.binary_search_by(|x| x.id.cmp(&n.id)).ok();
        n.channels.iter().filter_map(move |i| {
            let i = *i as usize;
            let channel = self.channels.get(i)?;
            let [a, b] = self.ends.get(i).copied().unwrap_or([u32::MAX; 2]);
            let other = if me == Some(a as usize) { b } else { a };
            Some(Link {
                channel,
                funded: self.funded.get(i).copied().flatten(),
                peer: self.nodes.get(other as usize),
                peer_at: other,
            })
        })
    }

    /// The top [`RANKED`] nodes.
    pub fn ranking(&self, r: Rank) -> impl Iterator<Item = &Node> {
        let [capacity, channels, age] = &self.ranked;
        let list = match r {
            Rank::Capacity => capacity,
            Rank::Channels => channels,
            Rank::Age => age,
        };
        list.iter().filter_map(|i| self.nodes.get(*i as usize))
    }

    /// At most `max` nodes: those whose public key starts with `q` (hex, any case), in key order,
    /// then those whose alias contains `q` (any case), most capacity first. Costs a binary search
    /// and one pass over the aliases (at most 32 bytes each), whatever `q` is.
    pub fn search(&self, q: &str, max: usize) -> Vec<&Node> {
        let q = q.to_lowercase();
        let mut found: Vec<&Node> = Vec::new();
        if q.len() <= 66 && q.bytes().all(|b| b.is_ascii_hexdigit()) {
            let prefix = |n: &Node| hex_prefix(&n.id, q.len());
            let from = self.nodes.partition_point(|n| prefix(n) < q);
            found.extend(
                self.nodes
                    .get(from..)
                    .unwrap_or_default()
                    .iter()
                    .take_while(|n| prefix(n) == q)
                    .take(max),
            );
        }
        let mut named: Vec<&Node> = self
            .nodes
            .iter()
            .filter(|n| n.key.contains(&q) && !found.iter().any(|f| f.id == n.id))
            .collect();
        named.sort_unstable_by(|a, b| b.capacity.cmp(&a.capacity).then(a.id.cmp(&b.id)));
        found.extend(named);
        found.truncate(max);
        found
    }

    /// The fee rates others charge to forward into `n` (incoming) and that `n` charges
    /// (outgoing), bucketed, over its open channels.
    pub fn fees(&self, n: &Node) -> [Vec<Bucket>; 2] {
        let mut sides: [BTreeMap<Option<u64>, Bucket>; 2] = Default::default();
        for c in self.channels_of(n) {
            let Some(own) = c.side(&n.id) else { continue };
            let [one, two] = c.policies;
            let (theirs, mine) = if own == 0 { (two, one) } else { (one, two) };
            for (side, policy) in sides.iter_mut().zip([theirs, mine]) {
                let bucket = policy.map(|p| bucket(p.fee_rate));
                let b = side.entry(bucket).or_insert(Bucket {
                    bucket,
                    count: 0,
                    capacity: 0,
                });
                b.count += 1;
                b.capacity += c.capacity;
            }
        }
        sides.map(|s| s.into_values().collect())
    }
}

/// A fee rate's histogram bucket: exact under 10 ppm, then rounded down to its tens, hundreds,
/// and thousands from 1,000 on.
pub fn bucket(rate: u32) -> u64 {
    let r = u64::from(rate);
    let step = match r {
        0..10 => 1,
        10..100 => 10,
        100..1_000 => 100,
        _ => 1_000,
    };
    r / step * step
}

/// The first `len` hex digits of `id`, lowercase.
fn hex_prefix(id: &[u8; 33], len: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    id.iter()
        .flat_map(|b| [b >> 4, b & 15])
        .take(len)
        .filter_map(|d| HEX.get(usize::from(d)).copied().map(char::from))
        .collect()
}

/// A node's open channels and their capacity at each UTC midnight from `start`, and at `now`,
/// oldest first, from its stored channels. Before `start` the store does not know the channels
/// that closed, so the series begins there. With `changes`, also at each block time after the
/// first midnight where a channel opened or closed, so a chart can step where the change was.
pub fn node_series(spans: &[Span], start: Option<u64>, now: u64, changes: bool) -> Vec<NodePoint> {
    let mut events: Vec<(u64, i64, i64)> = Vec::with_capacity(2 * spans.len());
    for s in spans {
        let cap = i64::try_from(s.capacity).unwrap_or(i64::MAX);
        events.push((s.open, 1, cap));
        if let Some(c) = s.close {
            events.push((c, -1, -cap));
        }
    }
    events.sort_unstable();
    let first = start.map_or(now, |s| s.div_ceil(DAY) * DAY);
    let mut times: Vec<u64> = (0..)
        .map(|d| first + d * DAY)
        .take_while(|t| *t < now)
        .chain([now])
        .collect();
    if changes {
        times.extend(
            events
                .iter()
                .map(|e| e.0)
                .filter(|t| *t > first && *t < now),
        );
        times.sort_unstable();
        times.dedup();
    }
    let (mut next, mut channels, mut capacity) = (0, 0i64, 0i64);
    times
        .into_iter()
        .map(|time| {
            while let Some(&(_, n, c)) = events.get(next).filter(|e| e.0 <= time) {
                channels += n;
                capacity += c;
                next += 1;
            }
            NodePoint {
                time,
                channels: u64::try_from(channels).unwrap_or(0),
                capacity: u64::try_from(capacity).unwrap_or(0),
            }
        })
        .collect()
}
