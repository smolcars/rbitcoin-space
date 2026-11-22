//! Topics, their subscribers and snapshots, and the `blocks` feed from Electrum.

use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use bitcoin::BlockHash;
use node::electrum::{self, Tip};
use node::esplora::{Esplora, Route};
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::watch;

use logging::events::{BlockUnavailable, WsClientsDropped, WsFanout};

use super::{Close, Conn, Frame, Sockets, Topic};
use crate::NetworkContext;
use crate::config::Network;

/// How often a new block is asked for at first while the node's Esplora has not caught up with
/// its Electrum announcement (docs/RBITCOIN.md): at most one request per interval.
const BLOCK_RETRY: Duration = Duration::from_millis(25);
/// The longest wait between two requests for a block served late.
const BLOCK_RETRY_MAX: Duration = Duration::from_secs(1);

/// What a new subscriber to a topic is sent first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Snapshot {
    /// This message is the topic's current state.
    Replace,
    /// The current state is unknown until the next `Replace`.
    Clear,
    /// This message changes nothing a new subscriber needs.
    Keep,
    /// This message is a change to the current state: a new subscriber gets it after the state
    /// and the changes appended before it. [`Hub::set_snapshot`] folds them into a new state.
    Append,
}

/// The result of one [`Hub::publish`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fanout {
    pub subscribers: usize,
    pub dropped_slow: usize,
    pub elapsed: Duration,
}

/// One network's topics.
#[derive(Debug)]
pub struct Hub {
    network: Network,
    sockets: Arc<Sockets>,
    topics: Mutex<HashMap<Topic, TopicState>>,
    /// Clients dropped for each limit, by close code, for [`WsClientsDropped`].
    dropped: Mutex<HashMap<u16, u64>>,
    /// The block the `blocks` topic last announced; `None` after a reorg or a `resync`.
    announced: watch::Sender<Option<BlockHash>>,
    /// Held while a block is announced, and while a decision taken on [`Hub::announced`] is
    /// sent, so the two never cross.
    order: Mutex<()>,
}

#[derive(Debug, Default)]
struct TopicState {
    subscribers: HashMap<u64, Arc<Conn>>,
    /// The current state, then the changes appended since: what a new subscriber is sent.
    snapshot: Vec<Frame>,
}

impl Hub {
    pub fn new(network: Network, sockets: Arc<Sockets>) -> Self {
        Self {
            network,
            sockets,
            topics: Mutex::default(),
            dropped: Mutex::default(),
            announced: watch::Sender::new(None),
            order: Mutex::new(()),
        }
    }

    /// The block the `blocks` topic last announced, set once its `block` message is queued to
    /// every subscriber; `None` while the topic does not know the tip.
    pub fn announced(&self) -> watch::Receiver<Option<BlockHash>> {
        self.announced.subscribe()
    }

    /// Sends a `blocks` message with `send`, and records `block` as the block now announced.
    pub(crate) fn announce_tip(&self, block: Option<BlockHash>, send: impl FnOnce()) {
        let _order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        send();
        self.announced.send_replace(block);
    }

    /// Runs `f` on the block announced now, with no block announced until it returns: the
    /// messages `f` sends land on the side of every `block` message that `f` saw.
    pub(crate) fn in_block_order<R>(&self, f: impl FnOnce(Option<BlockHash>) -> R) -> R {
        let _order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        f(*self.announced.borrow())
    }

    fn topics(&self) -> std::sync::MutexGuard<'_, HashMap<Topic, TopicState>> {
        self.topics.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds `conn` and queues the topic's snapshot to it. Under the same lock as [`Hub::publish`],
    /// so the snapshot always comes before the changes that follow it.
    pub(crate) fn subscribe(&self, topic: Topic, conn: &Arc<Conn>) {
        let mut topics = self.topics();
        let state = topics.entry(topic).or_default();
        state.subscribers.insert(conn.id, Arc::clone(conn));
        for frame in &state.snapshot {
            conn.send(frame.clone());
        }
    }

    /// Makes `frame` the topic's whole current state for new subscribers, without sending it to
    /// anyone: for folding appended changes into one state.
    pub fn set_snapshot(&self, topic: Topic, frame: Frame) {
        self.topics().entry(topic).or_default().snapshot = vec![frame];
    }

    /// Forgets the topic's stored state, keeping its subscribers: new ones are sent nothing.
    pub(super) fn clear(&self, topic: Topic) {
        if let Some(state) = self.topics().get_mut(&topic) {
            state.snapshot.clear();
        }
    }

    /// Subscribers of `topic` now.
    pub fn subscribers(&self, topic: Topic) -> usize {
        self.topics().get(&topic).map_or(0, |s| s.subscribers.len())
    }

    /// The network this hub serves.
    pub(crate) fn sockets(&self) -> &Sockets {
        &self.sockets
    }

    pub fn network(&self) -> Network {
        self.network
    }

    /// Forgets a topic and its stored state: for a tracked item nobody follows any more.
    pub(super) fn remove(&self, topic: Topic) {
        self.topics().remove(&topic);
    }

    pub(super) fn unsubscribe(&self, topic: Topic, id: u64) {
        if let Some(state) = self.topics().get_mut(&topic) {
            state.subscribers.remove(&id);
        }
    }

    /// Queues `frame` to every subscriber of `topic`: one reference-count increment and one
    /// non-blocking queue push each. A subscriber whose queue is full is closed as too slow.
    pub fn publish(&self, topic: Topic, frame: &Frame, snapshot: Snapshot) -> Fanout {
        let started = Instant::now();
        let mut topics = self.topics();
        let state = topics.entry(topic).or_default();
        match snapshot {
            Snapshot::Replace => state.snapshot = vec![frame.clone()],
            Snapshot::Clear => state.snapshot.clear(),
            Snapshot::Keep => {}
            Snapshot::Append => state.snapshot.push(frame.clone()),
        }
        let dropped_slow = state
            .subscribers
            .values()
            .filter(|conn| !conn.send(frame.clone()))
            .count();
        Fanout {
            subscribers: state.subscribers.len(),
            dropped_slow,
            elapsed: started.elapsed(),
        }
    }

    /// Counts a client dropped for `reason`; logged when the count reaches a power of two.
    pub(super) fn dropped(&self, reason: Close) {
        let total = {
            let mut dropped = self.dropped.lock().unwrap_or_else(PoisonError::into_inner);
            let n = dropped.entry(reason.code).or_default();
            *n += 1;
            *n
        };
        if total.is_power_of_two() {
            logging::emit(&WsClientsDropped {
                network: self.network.name(),
                reason: reason.label,
                total,
            });
        }
    }

    /// [`Hub::publish`] for a message caused by a node notification received at `since`.
    pub(crate) fn announce(
        &self,
        topic: Topic,
        kind: &'static str,
        msg: &Value,
        snapshot: Snapshot,
        since: Instant,
    ) {
        let frame = Frame::text(msg.to_string().as_bytes());
        let fanout = self.publish(topic, &frame, snapshot);
        logging::emit(&WsFanout {
            network: self.network.name(),
            topic: topic.name(),
            kind,
            subscribers: fanout.subscribers,
            open: self.sockets.open(),
            bytes: frame.len(),
            dropped_slow: fanout.dropped_slow,
            duration_ms: since.elapsed().as_secs_f64() * 1000.0,
            fanout_ms: fanout.elapsed.as_secs_f64() * 1000.0,
        });
    }
}

/// Feeds the `blocks` topic from the network's Electrum events until they end. One task per
/// network; the only upstream work is one fetch loop for the oldest block announced and not sent
/// yet, whatever the client count. Events are taken while a block is waited for, so a reorg drops
/// a block that left the chain instead of waiting it out.
pub async fn feed(
    ctx: Arc<NetworkContext>,
    mut events: tokio::sync::broadcast::Receiver<electrum::Event>,
) {
    let mut f = Feed::default();
    // The first tip may have been announced before `events` was taken.
    if let Some(tip) = ctx.electrum.tip() {
        f.announced(tip, Instant::now());
    }
    loop {
        f.fetch_front(&ctx);
        tokio::select! {
            event = events.recv() => {
                let since = Instant::now();
                match event {
                    Ok(electrum::Event::Block(tip)) => f.announced(tip, since),
                    Ok(electrum::Event::Reorg { fork_height }) => f.reorg(&ctx, fork_height, since),
                    Ok(electrum::Event::Resynced) | Err(RecvError::Lagged(_)) => f.resynced(&ctx, since),
                    Ok(electrum::Event::Status { .. }) => {}
                    Err(RecvError::Closed) => return,
                }
            }
            (hash, block) = fetched(&mut f.fetch) => f.complete(&ctx, hash, block),
        }
    }
}

type Fetch = Pin<Box<dyn Future<Output = Option<Value>> + Send>>;

/// What the feed remembers between events.
#[derive(Default)]
struct Feed {
    /// The newest block announced, so a repeated tip is not taken twice.
    last: Option<BlockHash>,
    /// Blocks announced and not sent yet, oldest first, with when Electrum announced each.
    pending: VecDeque<(Tip, Instant)>,
    /// The fetch of the oldest of them.
    fetch: Option<(BlockHash, Fetch)>,
    /// Blocks in a row the node did not serve in time.
    failures: u32,
}

impl Feed {
    fn announced(&mut self, tip: Tip, since: Instant) {
        if self.last == Some(tip.hash) {
            return;
        }
        self.last = Some(tip.hash);
        self.pending.push_back((tip, since));
    }

    /// Starts fetching the oldest block waited for, unless that fetch is already running.
    fn fetch_front(&mut self, ctx: &NetworkContext) {
        let Some((tip, since)) = self.pending.front() else {
            self.fetch = None;
            return;
        };
        if self.fetch.as_ref().is_some_and(|(h, _)| *h == tip.hash) {
            return;
        }
        let deadline = *since + ctx.sockets.limits.block_wait;
        let fetch = fetch_block(ctx.esplora.clone(), tip.hash, *since, deadline);
        self.fetch = Some((tip.hash, Box::pin(fetch)));
    }

    /// The fetch of `hash` ended: its `block` message, or a `resync` when the node did not serve it.
    fn complete(&mut self, ctx: &NetworkContext, hash: BlockHash, block: Option<Value>) {
        self.fetch = None;
        if self.pending.front().is_none_or(|(t, _)| t.hash != hash) {
            return;
        }
        let Some((tip, since)) = self.pending.pop_front() else {
            return;
        };
        let Some(block) = block else {
            self.failures = self.failures.saturating_add(1);
            if self.failures.is_power_of_two() {
                logging::emit(&BlockUnavailable {
                    network: ctx.config.network.name(),
                    height: tip.height,
                    hash: hash.to_string(),
                    failures: self.failures,
                });
            }
            // Blocks after it cannot be served before it. A later subscriber must learn it
            // missed them, not get the block before.
            self.pending.clear();
            ctx.hub
                .announce_tip(None, || resync(ctx, since, Snapshot::Replace));
            // The block table takes it on its own retries, whenever the node serves it. No
            // summary: subscribers were told to resync, not given the block.
            if let Some(t) = &ctx.blocks {
                t.wake.notify_one();
            }
            return;
        };
        self.failures = 0;
        let msg = json!({ "topic": "blocks", "type": "block", "block": block });
        ctx.hub.announce_tip(Some(hash), || {
            ctx.hub
                .announce(Topic::Blocks, "block", &msg, Snapshot::Replace, since);
            super::v1::block(ctx, &block);
        });
        ctx.summaries.new_tip(hash, since);
    }

    /// Events may have been missed, a reorg among them: blocks still waited for may have left the
    /// chain, so they are dropped, and the block table checks the chain on its own.
    fn resynced(&mut self, ctx: &NetworkContext, since: Instant) {
        self.last = None;
        let dropped = !self.pending.is_empty();
        self.pending.clear();
        // The last block is still a fair snapshot; a newer tip arrives as a `block`.
        resync(ctx, since, Snapshot::Keep);
        if dropped && let Some(t) = &ctx.blocks {
            t.wake.notify_one();
        }
    }

    /// Every block above `fork_height` left the best chain: those waited for are dropped.
    fn reorg(&mut self, ctx: &NetworkContext, fork_height: u32, since: Instant) {
        self.last = None;
        self.pending.retain(|(t, _)| t.height <= fork_height);
        let msg = json!({ "topic": "blocks", "type": "reorg", "fork_height": fork_height });
        ctx.hub.announce_tip(None, || {
            ctx.hub
                .announce(Topic::Blocks, "reorg", &msg, Snapshot::Clear, since);
            super::v1::reorg(ctx);
        });
    }
}

/// The running fetch's block, when it ends; never while there is none.
async fn fetched(fetch: &mut Option<(BlockHash, Fetch)>) -> (BlockHash, Option<Value>) {
    match fetch {
        Some((hash, f)) => (*hash, f.await),
        None => std::future::pending().await,
    }
}

fn resync(ctx: &NetworkContext, since: Instant, snapshot: Snapshot) {
    let tip = ctx
        .electrum
        .tip()
        .map(|t| json!({ "height": t.height, "hash": t.hash }));
    let msg = json!({ "topic": "blocks", "type": "resync", "tip": tip });
    ctx.hub
        .announce(Topic::Blocks, "resync", &msg, snapshot, since);
}

/// The block's Esplora JSON, checked to be the block we asked for, fetched until `deadline`.
/// The node can announce a block before it serves it (docs/RBITCOIN.md): asked every
/// [`BLOCK_RETRY`] at first, then every eighth of the time waited so far, at most every
/// [`BLOCK_RETRY_MAX`], so a late block costs at most about 90 requests over a minute and is sent
/// at most an eighth later than it could be. The full fetch doubles as the existence check: a
/// missing block is a short 404, and the answer is about 500 bytes.
async fn fetch_block(
    esplora: Esplora,
    hash: BlockHash,
    since: Instant,
    deadline: Instant,
) -> Option<Value> {
    let id = hash.to_string();
    let once = || async {
        let raw = esplora.raw(&Route::Block(hash)).await.ok()?;
        if !raw.status.is_success() {
            return None;
        }
        let block = serde_json::from_slice::<Value>(&raw.body).ok()?;
        (block.get("id").and_then(Value::as_str) == Some(id.as_str())).then_some(block)
    };
    tokio::time::timeout_at(deadline.into(), retry(once, since.into()))
        .await
        .ok()
}

/// `once`'s first answer, asked again after each miss on [`fetch_block`]'s schedule. It times the
/// wait from `since` on tokio's clock, so that a paused test steps through the schedule.
async fn retry<T, F: Future<Output = Option<T>>>(
    once: impl Fn() -> F,
    since: tokio::time::Instant,
) -> T {
    loop {
        let started = tokio::time::Instant::now();
        if let Some(found) = once().await {
            return found;
        }
        let wait = (since.elapsed() / 8).clamp(BLOCK_RETRY, BLOCK_RETRY_MAX);
        tokio::time::sleep_until(started + wait).await;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use tokio::time::Instant;

    use super::retry;

    /// docs/WS.md: a block the node has not served yet is asked for again every 25 ms for the first
    /// 200 ms, then after an eighth of the time waited, at most a second apart.
    #[tokio::test(start_paused = true)]
    async fn a_late_block_is_asked_for_again_after_an_eighth_of_the_wait() {
        let since = Instant::now();
        let asks = Mutex::new(Vec::new());
        retry(
            || async {
                let mut asks = asks.lock().unwrap();
                asks.push(since.elapsed());
                // The count ends a loop that asks again without waiting, which never reaches 12 s.
                (since.elapsed() >= Duration::from_secs(12) || asks.len() == 200).then_some(())
            },
            since,
        )
        .await;
        let asks = asks.into_inner().unwrap();
        assert_eq!(asks[0], Duration::ZERO);
        for ask in asks.windows(2) {
            let wait = (ask[0] / 8).clamp(Duration::from_millis(25), Duration::from_secs(1));
            // A tokio timer fires on the first millisecond at or past its deadline.
            assert!(
                (wait..wait + Duration::from_millis(1)).contains(&(ask[1] - ask[0])),
                "asked at {:?}, then at {:?}",
                ask[0],
                ask[1]
            );
        }
        assert_eq!(
            asks[asks.len() - 1] - asks[asks.len() - 2],
            Duration::from_secs(1)
        );
    }
}
