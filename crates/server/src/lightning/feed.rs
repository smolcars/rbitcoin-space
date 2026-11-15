//! The Lightning overview's live feed (`docs/LIGHTNING.md`, "The overview"): channels opened,
//! channels closed and fee changes, pushed on the `lightning-feed` topic once per index build and
//! kept, the newest [`KEPT`] of each kind, for `GET /app/lightning/feed` and new subscribers.
//!
//! Opens and closes come from the history as it is stored, fee changes from the fee round. Only
//! what the store did not already hold counts, and nothing before the first index after a start,
//! so a restart's replay of every channel is never pushed as news.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{Arc, PoisonError};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::routing::get;
use engine::lightning::fees::{FeeRecord, Fees};
use engine::lightning::{self as store_ln, Change, Index, Kind};
use engine::store::Store;
use serde_json::{Value, json};

use super::nodes::{Answer, graph, inbound_json, query};
use super::{Lightning, hex, json_response, scid_text};
use crate::NetworkContext;
use crate::ws::{Frame, Hub, Snapshot, Topic};

/// Events of each kind kept: what the route answers and a new subscriber is sent first, about
/// as many rows as the page shows.
pub(crate) const KEPT: usize = 20;
/// Events of each kind sent in one frame; the rest are counted in `more`.
pub(crate) const SENT: usize = 50;
/// Opens and closes waiting for the next build; past it the oldest are counted as left out.
const WAITING: usize = 1_000;

/// What happened to a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum What {
    Opened {
        height: u32,
    },
    Closed {
        height: u32,
        kind: Kind,
    },
    /// `side` 0 is node one's policy.
    Fee {
        side: u8,
        before: Fees,
        after: Fees,
    },
}

impl What {
    fn slot(self) -> usize {
        match self {
            Self::Opened { .. } => 0,
            Self::Closed { .. } => 1,
            Self::Fee { .. } => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Event {
    /// The funding or closing block's time, or the channel update's own; never later than when
    /// it was found.
    pub time: u64,
    pub scid: u64,
    pub nodes: [[u8; 33]; 2],
    pub capacity: u64,
    pub what: What,
    /// Filled from the index when the event is sent: gossip, served as plain strings.
    pub aliases: [Option<String>; 2],
}

impl Event {
    fn new(time: u64, o: &store_ln::Open, what: What) -> Self {
        Self {
            time: time.min(store_ln::unix_now()),
            scid: o.scid,
            nodes: [o.node_one, o.node_two],
            capacity: o.capacity,
            what,
            aliases: [None, None],
        }
    }

    /// One event per stored change that wrote a row: an open or close the table did not hold.
    /// A penalty names only its channel: [`Event::penalty`] takes the stored row.
    pub(crate) fn from_change(c: &Change) -> Option<Self> {
        match c {
            Change::Opened(o) => Some(Self::new(
                o.block.time,
                o,
                What::Opened {
                    height: o.block.height,
                },
            )),
            Change::Closed(o, c) => Some(Self::new(
                c.block.time,
                o,
                What::Closed {
                    height: c.block.height,
                    kind: c.kind,
                },
            )),
            _ => None,
        }
    }

    /// A breach swept: a close of kind penalty, at the sweep's block.
    pub(crate) fn penalty(c: &store_ln::Channel, p: &store_ln::Penalty) -> Self {
        Self::new(
            p.block.time,
            &c.open,
            What::Closed {
                height: p.block.height,
                kind: Kind::Penalty,
            },
        )
    }

    /// A fee change of an open channel the index holds.
    pub(crate) fn fee(
        index: &Index,
        scid: u64,
        side: u8,
        before: FeeRecord,
        after: FeeRecord,
    ) -> Option<Self> {
        let c = index.channel(scid)?;
        Some(Self {
            time: u64::from(after.time).min(store_ln::unix_now()),
            scid,
            nodes: c.nodes,
            capacity: c.capacity,
            what: What::Fee {
                side,
                before: before.fees,
                after: after.fees,
            },
            aliases: [None, None],
        })
    }

    fn key(&self) -> (usize, u64, u64, u8) {
        let side = match self.what {
            What::Fee { side, .. } => side,
            _ => 0,
        };
        (self.what.slot(), self.time, self.scid, side)
    }

    fn json(&self) -> Value {
        let node = |i: usize| {
            json!({
                "id": self.nodes.get(i).map(|k| hex(k)),
                "alias": self.aliases.get(i).cloned().flatten(),
            })
        };
        let mut v = json!({
            "time": self.time,
            "id": scid_text(self.scid),
            "scid": self.scid.to_string(),
            "capacity": self.capacity,
            "node_one": node(0),
            "node_two": node(1),
        });
        let extra = match self.what {
            What::Opened { height } => json!({ "event": "opened", "height": height }),
            What::Closed { height, kind } => {
                json!({ "event": "closed", "height": height, "kind": kind.label() })
            }
            What::Fee {
                side,
                before,
                after,
            } => json!({
                "event": "fee",
                "by": if side == 0 { "node_one" } else { "node_two" },
                "before": fees_json(before),
                "after": fees_json(after),
            }),
        };
        if let (Some(v), Value::Object(extra)) = (v.as_object_mut(), extra) {
            v.extend(extra);
        }
        v
    }
}

fn fees_json(f: Fees) -> Value {
    json!({
        "fee_rate": f.fee_rate,
        "base_fee_msat": f.base_fee_msat,
        "inbound_fee": inbound_json(f.inbound),
    })
}

/// Newest first, then by channel, so a list is the same whatever order it was found in.
fn newest_first(v: &mut [Event]) {
    v.sort_unstable_by(|a, b| b.time.cmp(&a.time).then(a.key().cmp(&b.key())));
}

/// What the feed holds: whether it is live, the opens and closes stored since the last build,
/// and the newest events of each kind.
#[derive(Debug, Default)]
pub(crate) struct Feed {
    live: bool,
    waiting: VecDeque<Event>,
    /// Opens and closes dropped from `waiting` since the last build.
    dropped: u64,
    kept: [Vec<Event>; 3],
    /// The kept events as `GET /app/lightning/feed` answers them.
    answer: Option<Bytes>,
}

impl Feed {
    /// Takes a change the history just stored that wrote a row, if it is an open or a close.
    pub(crate) fn wait_for(&mut self, c: &Change) {
        if let Some(e) = Event::from_change(c) {
            self.wait(e);
        }
    }

    /// Takes an open or close the history just stored, while the feed is live.
    pub(crate) fn wait(&mut self, e: Event) {
        if !self.live {
            return;
        }
        if self.waiting.len() == WAITING {
            self.waiting.pop_front();
            self.dropped += 1;
        }
        self.waiting.push_back(e);
    }

    /// Adds `events` to the kept ones: the newest [`KEPT`] of each kind, each event once.
    fn keep(&mut self, events: &[Event]) {
        for e in events {
            let Some(kept) = self.kept.get_mut(e.what.slot()) else {
                continue;
            };
            if !kept.iter().any(|k| k.key() == e.key()) {
                kept.push(e.clone());
            }
        }
        for kept in &mut self.kept {
            newest_first(kept);
            kept.truncate(KEPT);
        }
    }

    fn all(&self) -> Vec<Value> {
        let mut all: Vec<Event> = self.kept.iter().flatten().cloned().collect();
        newest_first(&mut all);
        all.iter().map(Event::json).collect()
    }
}

/// What one build sends: at most [`SENT`] of each kind, newest first, and how many were left out.
pub(crate) fn frame_events(mut events: Vec<Event>, dropped: u64) -> (Vec<Event>, u64) {
    newest_first(&mut events);
    let mut counts = [0usize; 3];
    let mut left = dropped;
    events.retain(|e| {
        let n = counts.get_mut(e.what.slot());
        match n {
            Some(n) if *n < SENT => {
                *n += 1;
                true
            }
            _ => {
                left += 1;
                false
            }
        }
    });
    (events, left)
}

fn names(index: &Index, events: &mut [Event]) {
    for e in events {
        for (alias, id) in e.aliases.iter_mut().zip(&e.nodes) {
            *alias = index.node(id).and_then(|n| n.alias()).map(str::to_owned);
        }
    }
}

/// The newest opens, closes and fee changes the store holds, for the feed's first state after a
/// start: three indexed reads and one per direction asked.
async fn stored(
    l: &Lightning,
    store: &Store,
    index: &Index,
) -> Result<Vec<Event>, engine::store::Error> {
    let mut out = Vec::new();
    for c in store_ln::opened(store, KEPT).await? {
        out.extend(Event::from_change(&Change::Opened(c.open)));
    }
    // A sweep can come long after its close: the newest sweeps are read apart.
    let closed = store_ln::closed(store, KEPT).await?;
    for c in closed
        .into_iter()
        .chain(store_ln::penalties(store, KEPT).await?)
    {
        match (c.close, c.penalty) {
            (_, Some(p)) => out.push(Event::penalty(&c, &p)),
            (Some(close), None) => out.extend(Event::from_change(&Change::Closed(c.open, close))),
            (None, None) => {}
        }
    }
    let dirs = l
        .fees
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .newest_changed(KEPT);
    let records = store_ln::fees::newest(store, dirs.clone(), KEPT).await?;
    for ((scid, side), r) in dirs.into_iter().zip(&records) {
        for w in r.windows(2) {
            if let [after, before] = w {
                out.extend(Event::fee(index, scid, side, *before, *after));
            }
        }
    }
    Ok(out)
}

/// One build's turn, after the fee round. The first once the close-watcher has caught up
/// (`caught_up`) fills the feed from the store and goes live, so what a restart's catch-up finds
/// is kept but never pushed; later ones send what was found since, in one frame, and keep it.
/// `fees` are the fee round's changes.
pub(crate) async fn round(
    l: &Lightning,
    store: &Store,
    hub: &Hub,
    index: &Index,
    fees: Vec<Event>,
    caught_up: bool,
) {
    let was_live = {
        let mut f = l.feed.lock().unwrap_or_else(PoisonError::into_inner);
        let was = f.live;
        f.live |= caught_up;
        was
    };
    if !was_live {
        if !caught_up {
            return;
        }
        // Live before the read: what the history stores meanwhile is sent at the next build, and
        // kept once. A failed read leaves the feed to fill with live events.
        let mut events = stored(l, store, index).await.unwrap_or_default();
        names(index, &mut events);
        keep(l, hub, &events);
        return;
    }
    let (mut events, dropped) = {
        let mut f = l.feed.lock().unwrap_or_else(PoisonError::into_inner);
        let waiting: Vec<Event> = f.waiting.drain(..).collect();
        (waiting, std::mem::take(&mut f.dropped))
    };
    events.extend(fees);
    if events.is_empty() && dropped == 0 {
        return;
    }
    let (mut send, left) = frame_events(events, dropped);
    names(index, &mut send);
    let msg = json!({
        "topic": Topic::LightningFeed.name(),
        "type": "events",
        "events": send.iter().map(Event::json).collect::<Vec<_>>(),
        "more": left,
    });
    // Appended to the state until `keep` folds it in: a subscriber in between gets it too.
    hub.publish(
        Topic::LightningFeed,
        &Frame::text(msg.to_string().as_bytes()),
        Snapshot::Append,
    );
    l.feed_events
        .fetch_add(send.len() as u64, Ordering::Relaxed);
    l.feed_left_out.fetch_add(left, Ordering::Relaxed);
    keep(l, hub, &send);
}

/// Keeps `events`, and makes the kept ones the route's answer and the topic's state.
fn keep(l: &Lightning, hub: &Hub, events: &[Event]) {
    let mut f = l.feed.lock().unwrap_or_else(PoisonError::into_inner);
    f.keep(events);
    let all = f.all();
    f.answer = serde_json::to_vec(&json!({ "events": all }))
        .ok()
        .map(Bytes::from);
    drop(f);
    let state = json!({ "topic": Topic::LightningFeed.name(), "type": "recent", "events": all });
    hub.set_snapshot(
        Topic::LightningFeed,
        Frame::text(state.to_string().as_bytes()),
    );
}

impl Lightning {
    pub(crate) fn feed_live(&self) -> bool {
        self.feed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .live
    }

    fn feed_answer(&self) -> Option<Bytes> {
        self.feed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .answer
            .clone()
    }
}

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new().route("/app/lightning/feed", get(app_feed))
}

/// `GET /app/lightning/feed`: the newest opens, closes and fee changes, [`KEPT`] of each kind,
/// newest first, from memory.
async fn app_feed(State(ctx): State<Arc<NetworkContext>>, RawQuery(raw): RawQuery) -> Answer {
    query(raw.as_deref(), &[], true)?;
    let (_, l, _) = graph(&ctx)?;
    let body = l
        .feed_answer()
        .unwrap_or_else(|| Bytes::from_static(br#"{"events":[]}"#));
    Ok(json_response(body, "lightning_feed", "no-cache"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]

    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use bitcoin::BlockHash;
    use bitcoin::hashes::Hash;
    use engine::lightning::fees::{self, FeeRecord};
    use engine::lightning::{
        Announcement, Block, Close, GraphChannel, GraphNode, Inbound, Open, Past, Policy,
    };
    use engine::store::Options;
    use tokio::sync::mpsc;

    use super::*;
    use crate::config::{LightningConfig, Network, WsLimits};
    use crate::ws::{Conn, Sockets};

    const S: u64 = 800_000 << 40 | 5 << 16;
    const T: u32 = 1_700_000_000;

    fn key(n: u8) -> [u8; 33] {
        [n; 33]
    }

    fn open(scid: u64) -> Open {
        Open {
            scid,
            node_one: key(2),
            node_two: key(3),
            capacity: 1_000_000,
            block: Block {
                height: u32::try_from(scid >> 40).unwrap(),
                hash: BlockHash::from_byte_array([1; 32]),
                time: u64::from(T),
            },
        }
    }

    fn priced(fee_rate: u32, time: u32, inbound: Option<Inbound>) -> Policy {
        Policy {
            fee_rate,
            base_fee_msat: 1_000,
            cltv_delta: 80,
            min_htlc_msat: 1,
            max_htlc_msat: 1_000_000,
            enabled: true,
            last_update: time,
            inbound,
        }
    }

    fn record(fee_rate: u32, time: u32, inbound: Option<Inbound>) -> FeeRecord {
        FeeRecord {
            time,
            fees: priced(fee_rate, time, inbound).fees(),
        }
    }

    /// The channel `S` between 2 ("<b>two</b>", an alias that must stay text) and 3, node one's
    /// policy charging `fee_rate` since `time`.
    fn index(fee_rate: u32, time: u32) -> Index {
        let node = GraphNode {
            id: key(2),
            announcement: Some(Announcement {
                alias: "<b>two</b>".into(),
                color: [0; 3],
                addresses: Vec::new(),
                features: Vec::new(),
                last_update: T,
            }),
        };
        let c = GraphChannel {
            scid: S,
            nodes: [key(2), key(3)],
            capacity: 1_000_000,
            policies: [Some(priced(fee_rate, time, None)), None],
        };
        Index::build(vec![node], vec![c], &Past::default())
    }

    #[test]
    fn events_carry_what_a_row_shows() {
        let o = open(S);
        let e = Event::from_change(&Change::Opened(o)).unwrap();
        let v = e.json();
        assert_eq!(v["event"], "opened");
        assert_eq!(v["id"], "800000x5x0");
        assert_eq!(v["scid"], S.to_string());
        assert_eq!(
            (v["height"].as_u64(), v["capacity"].as_u64()),
            (Some(800_000), Some(1_000_000))
        );
        assert_eq!(v["node_one"]["id"], "02".repeat(33));
        assert_eq!(v["time"], u64::from(T));
        for kind in [Kind::Cooperative, Kind::Force, Kind::Penalty, Kind::Other] {
            let c = Close {
                block: Block {
                    height: 800_010,
                    hash: BlockHash::from_byte_array([2; 32]),
                    time: u64::from(T) + 60,
                },
                txid: bitcoin::Txid::from_byte_array([3; 32]),
                kind,
                fee: None,
            };
            let v = Event::from_change(&Change::Closed(o, c)).unwrap().json();
            assert_eq!(
                (v["event"].as_str(), v["kind"].as_str()),
                (Some("closed"), Some(kind.label()))
            );
            assert_eq!(v["height"], 800_010);
        }
        // A breach, at the sweep's block.
        let p = store_ln::Penalty {
            block: Block {
                height: 800_020,
                hash: BlockHash::from_byte_array([4; 32]),
                time: u64::from(T) + 600,
            },
            txid: bitcoin::Txid::from_byte_array([5; 32]),
        };
        let c = store_ln::Channel {
            open: o,
            close: None,
            penalty: Some(p),
            funding_txid: None,
        };
        let v = Event::penalty(&c, &p).json();
        assert_eq!(
            (v["kind"].as_str(), v["height"].as_u64()),
            (Some("penalty"), Some(800_020))
        );
        // Nothing else stored is an event.
        assert!(Event::from_change(&Change::CloseUndone(S)).is_none());

        // Fee changes, with and without an inbound fee; never dated after now.
        let i = index(100, T);
        let inbound = Inbound {
            base_fee_msat: -1_000,
            fee_rate: -50,
        };
        let e = Event::fee(
            &i,
            S,
            0,
            record(100, T, None),
            record(200, T + 10, Some(inbound)),
        )
        .unwrap();
        let v = e.json();
        assert_eq!(
            (v["event"].as_str(), v["by"].as_str()),
            (Some("fee"), Some("node_one"))
        );
        assert_eq!(v["before"]["fee_rate"], 100);
        assert_eq!(v["before"]["inbound_fee"], Value::Null);
        assert_eq!(v["after"]["fee_rate"], 200);
        assert_eq!(v["after"]["inbound_fee"]["fee_rate"], -50);
        assert_eq!(v["after"]["inbound_fee"]["base_fee_msat"], -1_000);
        let future = Event::fee(&i, S, 1, record(1, T, None), record(2, u32::MAX, None)).unwrap();
        assert!(future.time <= store_ln::unix_now());
        assert_eq!(future.json()["by"], "node_two");
        assert!(Event::fee(&i, S + 1, 0, record(1, T, None), record(2, T, None)).is_none());
    }

    #[test]
    fn a_frame_holds_the_newest_fifty_of_each_kind_and_counts_the_rest() {
        let i = index(100, T);
        let mut events: Vec<Event> = (0..120u32)
            .map(|n| Event::fee(&i, S, 0, record(1, T, None), record(2, T + n, None)).unwrap())
            .collect();
        events.push(Event::from_change(&Change::Opened(open(S))).unwrap());
        let (sent, left) = frame_events(events, 3);
        assert_eq!(sent.len(), SENT + 1, "the open is not crowded out");
        assert_eq!(left, 70 + 3);
        assert_eq!(sent[0].time, u64::from(T + 119), "newest first");

        // What is kept for the route and new subscribers is fewer: the newest 20 of each kind.
        let mut f = Feed::default();
        f.keep(&sent);
        let all = f.all();
        assert_eq!(all.len(), KEPT + 1);
        assert_eq!(all[0]["time"], u64::from(T + 119));

        // Waiting opens and closes are bounded too, and nothing is taken before the feed is live.
        let mut f = Feed::default();
        f.wait_for(&Change::Opened(open(S)));
        assert!(f.waiting.is_empty());
        f.live = true;
        for n in 0..WAITING as u64 + 5 {
            f.wait_for(&Change::Opened(open(S + n)));
        }
        assert_eq!((f.waiting.len(), f.dropped), (WAITING, 5));
    }

    fn temp() -> (PathBuf, Store) {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "rbitcoin-space-ln-feed-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir, "regtest", Options::default()).unwrap();
        (dir, store)
    }

    fn payload(f: &Frame) -> Value {
        let b = f.as_bytes();
        let head = match b[1] {
            126 => 4,
            127 => 10,
            _ => 2,
        };
        serde_json::from_slice(&b[head..]).unwrap()
    }

    /// A restart's catch-up is kept but never pushed; a later build's change reaches a subscriber
    /// as one frame, and a new subscriber gets the kept events first.
    #[tokio::test]
    async fn a_subscriber_gets_one_frame_per_build_and_nothing_from_the_catch_up() {
        let (dir, store) = temp();
        let l = Arc::new(Lightning::new(
            &LightningConfig {
                peers: Vec::new(),
                max_peers: 1,
                max_channels: 10,
            },
            &dir,
            Network::Regtest,
        ));
        store_ln::apply(&store, vec![Change::Opened(open(S))])
            .await
            .unwrap();
        // Before the restart node one charged 50; while the server was down it moved to 100.
        fees::record(&store, vec![(S, 0, record(50, T - 10, None))], 1, 2)
            .await
            .unwrap();
        l.set_index(index(100, T + 5));
        let hub = Hub::new(
            Network::Regtest,
            Sockets::new(&WsLimits::default(), Duration::from_secs(1)),
        );
        let (tx, mut rx) = mpsc::channel(8);
        let conn = Arc::new(Conn::test(1, tx));
        hub.subscribe(Topic::LightningFeed, &conn);

        // The first round catches up: the change is stored, kept, and pushed to nobody.
        let mut run = None;
        let first = super::super::fees::round(&l, &store, &mut run).await;
        assert!(first.is_empty());
        // Stored before the feed was live: a restart's replay, not news.
        l.feed
            .lock()
            .unwrap()
            .wait_for(&Change::Opened(open(S + 1)));
        round(&l, &store, &hub, &l.index().unwrap(), first.clone(), false).await;
        assert!(
            l.feed_answer().is_none(),
            "not live while the close-watcher catches up"
        );
        round(&l, &store, &hub, &l.index().unwrap(), first, true).await;
        assert!(rx.try_recv().is_err(), "nothing pushed at the first build");
        let kept: Value = serde_json::from_slice(&l.feed_answer().unwrap()).unwrap();
        let kinds: Vec<&str> = kept["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["fee", "opened"], "newest first, from the store");

        // The next build finds a change: one frame, with the alias as plain text.
        l.set_index(index(200, T + 30));
        let fees = super::super::fees::round(&l, &store, &mut run).await;
        assert_eq!(fees.len(), 1);
        round(&l, &store, &hub, &l.index().unwrap(), fees, true).await;
        let v = payload(&rx.try_recv().unwrap());
        assert_eq!(
            (v["topic"].as_str(), v["type"].as_str()),
            (Some("lightning-feed"), Some("events"))
        );
        assert_eq!(v["more"], 0);
        let e = &v["events"][0];
        assert_eq!(
            (
                e["before"]["fee_rate"].as_u64(),
                e["after"]["fee_rate"].as_u64()
            ),
            (Some(100), Some(200))
        );
        assert_eq!(e["node_one"]["alias"], "<b>two</b>");
        assert!(rx.try_recv().is_err(), "one frame per build");

        // A build with nothing new sends nothing.
        round(&l, &store, &hub, &l.index().unwrap(), Vec::new(), true).await;
        assert!(rx.try_recv().is_err());

        // A new subscriber is sent the kept events.
        let (tx, mut rx) = mpsc::channel(8);
        hub.subscribe(Topic::LightningFeed, &Arc::new(Conn::test(2, tx)));
        let v = payload(&rx.try_recv().unwrap());
        assert_eq!(v["type"], "recent");
        assert_eq!(v["events"].as_array().unwrap().len(), 3);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
