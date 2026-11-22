//! Following one transaction or one address: the `tx:<txid>` and `address:<address>` topics
//! (`docs/WS.md`), and the replacement record they share with `/app`.
//!
//! A transaction's state comes from memory only: the mempool tracker's records and removal
//! reasons, the projected blocks' positions, and the record of recent replacements. Following it
//! never asks the node anything. An address is one shared, reference-counted Electrum
//! subscription per network, whatever the number of sockets following it (SECURITY.md rule 10).
//!
//! Every message of these topics is the topic's whole state, so a client keeps the last one.
//! A tracked item lives while a socket subscribes to it; the last unsubscribe forgets it, its
//! stored message and, for an address, the node's subscription.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use bitcoin::{BlockHash, Txid};
use engine::mempool::{Delta, Removal, Tracker};
use engine::projected::{Position, Projector};
use logging::events::{ReplacementsChecked, TrackingRefused, TrackingSummary};
use node::electrum::{self, ScriptHash, Status};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::{Conn, Frame, Hub, Snapshot, Topic};
use crate::config::{Limits, Network, WsLimits};
use crate::esplora::HeavyShare;
use crate::limits::Clients;
use crate::replacements::{Batch, Facts, Kept, Link, MAX_LINKS, Mined, Replacements, Sides};
use crate::{ApiError, esplora};
use engine::replacements::{Answer, Ask, Lookup};

/// The `/app` answer while the network's mempool engine is switched off.
pub const MEMPOOL_OFF: ApiError =
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "mempool is switched off");
/// The `/app` answer before the tracker's first complete cycle.
pub const MEMPOOL_SYNCING: ApiError =
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "mempool is syncing");
/// How often a network with anything tracked writes a `tracking_summary` line.
const SUMMARY_EVERY: Duration = Duration::from_secs(60);

/// A tracked topic's name as a client writes it, parsed strictly: `tx:` and 64 lowercase hex
/// digits, or `address:` and an address of this network or a public key. Returns the topic and its
/// name as the server writes it (bech32 and a key's hex in lower case).
pub fn parse(name: &str, network: Network) -> Option<(Topic, String)> {
    if let Some(hex) = name.strip_prefix("tx:") {
        if !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return None;
        }
        let txid = esplora::txid(hex).ok()?;
        return Some((Topic::Tx(txid), name.to_owned()));
    }
    let payee = esplora::payee(name.strip_prefix("address:")?, network).ok()?;
    let sh = ScriptHash::from_script(&payee.script_pubkey());
    Some((Topic::Address(sh), format!("address:{payee}")))
}

/// Whether `topic` follows a transaction or an address, in either protocol: those go through
/// [`Tracking`], the rest straight to the hub.
pub(crate) fn tracked(topic: Topic) -> bool {
    matches!(
        topic,
        Topic::Tx(_)
            | Topic::Address(_)
            | Topic::V1Tx(_)
            | Topic::V1Address(_)
            | Topic::V1Addresses(_)
    )
}

/// Settings that bound tracking, from [`WsLimits`].
#[derive(Debug, Clone, Copy)]
struct Bounds {
    txs_total: usize,
    addresses_total: usize,
    position_interval: Duration,
}

/// One network's tracked transactions and addresses.
pub struct Tracking {
    network: Network,
    hub: Arc<Hub>,
    electrum: Option<electrum::Client>,
    mempool: bool,
    bounds: Bounds,
    engines: OnceLock<(Tracker, Projector)>,
    /// Each client's budget for new node work from the sockets: an address subscription the
    /// network does not hold yet, or an `/api/v1/ws` address's first history read. Its own
    /// table, with the address routes' numbers (SECURITY.md rule 11).
    follows: Arc<Clients>,
    state: Mutex<State>,
    /// A transaction is newly followed: [`follow_txs`] says its state now.
    wake: Notify,
    /// Asked before the node is asked to watch an address; none in tests without a server.
    gate: OnceLock<Arc<dyn AddressGate>>,
}

impl std::fmt::Debug for Tracking {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tracking")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

struct State {
    txs: HashMap<Txid, TxEntry>,
    addresses: HashMap<ScriptHash, AddrEntry>,
    replacements: Replacements,
    /// The last tracker delta folded into `txs`' removal reasons. A view read at another
    /// `seq` does not match them, so nothing is published from it.
    applied: u64,
    /// Distinguishes an address entry from a later one for the same script.
    next_gen: u64,
    /// The `replacements` topic has been told the record's version.
    record_said: bool,
    stats: Stats,
}

/// Counted since the last `tracking_summary` line.
#[derive(Default)]
struct Stats {
    subscribed: u64,
    refused: u64,
    messages: u64,
    bytes: u64,
    address_errors: u64,
    /// Refusals for a full server since start, by kind, for [`TrackingRefused`].
    refused_txs: u64,
    refused_addresses: u64,
}

struct TxEntry {
    /// Sockets subscribed.
    refs: usize,
    /// Why it last left the mempool, from the tracker's stream, while it is out of it.
    gone: Option<Removal>,
    /// What the topic last said, and when.
    sent: Option<(Shown, Instant)>,
}

struct AddrEntry {
    /// Sockets subscribed. An entry with none is kept while `pending`, so a node request in
    /// flight still counts against `WS_TRACKED_ADDRESSES_TOTAL`.
    refs: usize,
    /// A [`watch`] for it is running.
    pending: bool,
    /// The topic's name as sent.
    name: Arc<str>,
    epoch: u64,
    /// The node's subscription; `None` until it answers or after it refused.
    sub: Option<electrum::Subscription>,
    /// What the topic last said; `None` while waiting for the node.
    state: Option<AddrState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AddrState {
    /// The node watches it. Its Electrum status: a hash of the address's history (`None` for no
    /// history), so it changes whenever a payment enters the mempool or confirms.
    Watching(Option<String>),
    /// The node is unreachable; asked again when the connection is back.
    Unavailable,
    /// The node refused: `too_large`, `no_index`, `server_full` or `refused`.
    Refused(&'static str),
    /// The server's own ledger keeps it, exact at this block; the node is not asked to watch it.
    Ledger(u32),
}

/// What the server decided before asking the node to watch a script (`crate::ledger::Guard`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Known to be small: the node watches it.
    Watch,
    /// The ledger keeps it, exact at this height.
    Ledger(u32),
    /// Large and not kept: no live signal, as for the node's own refusal.
    TooLarge,
    /// Its size could not be learned now: asked again shortly.
    Later,
}

/// Decides, before the node is asked to watch a script, whether it may be: watching makes the
/// node join the script's whole history.
pub trait AddressGate: Send + Sync {
    fn decide(
        &self,
        sh: ScriptHash,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Decision> + Send + '_>>;
}

/// How long a script whose size could not be learned waits before it is asked again.
const GATE_RETRY: Duration = Duration::from_secs(10);

/// A transaction's state as the topic says it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TxState {
    /// `position` is `None` for the moment between the tracker seeing it and the projected
    /// blocks placing it.
    Mempool {
        time: u32,
        fee: u64,
        vsize: u32,
        position: Option<Position>,
    },
    /// The chain of replacements from this one, oldest first, and whether it was cut.
    Replaced(Vec<Link>, bool),
    Confirmed {
        height: u32,
        hash: BlockHash,
    },
    /// Evicted, expired, or dropped for a reason the node does not report.
    Evicted,
    /// Not in the mempool and nothing recorded: confirmed before we were asked, never seen, or
    /// gone while we were not looking.
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
struct Shown {
    state: TxState,
    stale: bool,
    /// Projected blocks, so a client knows which one means "beyond".
    blocks: usize,
}

impl Shown {
    /// Equal but for where it waits: how much is ahead of it, or which later block it is in. A
    /// shuffle, sent at most once per `WS_POSITION_INTERVAL_MS`. Entering or leaving the next
    /// block, or a new effective rate, is news and goes out at once. On mainnet a transaction in
    /// the large class of equal chunks at the bottom moves between later blocks every few
    /// seconds; that is the projection's noise, not something a reader needs each time.
    fn shuffled(&self, other: &Self) -> bool {
        let TxState::Mempool {
            position: Some(b), ..
        } = &other.state
        else {
            return false;
        };
        let mut s = self.clone();
        let TxState::Mempool {
            position: Some(a), ..
        } = &mut s.state
        else {
            return false;
        };
        if a.placed.block != b.placed.block && (a.placed.block == 0 || b.placed.block == 0) {
            return false;
        }
        (a.ahead_vsize, a.ahead_txs, a.placed.block) = (b.ahead_vsize, b.ahead_txs, b.placed.block);
        s == *other
    }
}

/// Why a tracked topic was not subscribed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Declined {
    /// The network follows `WS_TRACKED_TXS_TOTAL` or `WS_TRACKED_ADDRESSES_TOTAL` already.
    Full,
    /// The client is starting new address follows faster than its budget.
    Rate,
}

/// The refusal summary's reason, and `/app/ws`'s, for a follow over the client's budget.
pub const FOLLOW_RATE: &str = "follow_rate";

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Tracking {
    pub fn new(
        network: Network,
        hub: Arc<Hub>,
        electrum: Option<electrum::Client>,
        mempool: bool,
        limits: &WsLimits,
        client_limits: &Limits,
    ) -> Self {
        let share = HeavyShare::of(client_limits);
        Self {
            follows: Clients::with_rate(
                share.per_sec,
                share.burst,
                client_limits.max_tracked_clients,
            ),
            network,
            hub,
            electrum,
            mempool,
            bounds: Bounds {
                txs_total: limits.tracked_txs_total,
                addresses_total: limits.tracked_addresses_total,
                position_interval: limits.position_interval,
            },
            engines: OnceLock::new(),
            wake: Notify::new(),
            gate: OnceLock::new(),
            state: Mutex::new(State {
                txs: HashMap::new(),
                addresses: HashMap::new(),
                replacements: Replacements::new(limits.replacements_kept),
                applied: 0,
                next_gen: 0,
                record_said: false,
                stats: Stats::default(),
            }),
        }
    }

    pub fn hub(&self) -> &Hub {
        &self.hub
    }

    pub fn mempool_enabled(&self) -> bool {
        self.mempool
    }

    /// The running engines, once [`super::mempool::run`] attached them.
    pub fn engines(&self) -> Option<&(Tracker, Projector)> {
        self.engines.get()
    }

    pub(crate) fn attach(&self, tracker: &Tracker, projector: &Projector) {
        let _ = self.engines.set((tracker.clone(), projector.clone()));
    }

    pub fn with_replacements<R>(&self, f: impl FnOnce(&Replacements) -> R) -> R {
        f(&lock(&self.state).replacements)
    }

    /// Puts back links recorded before (from the store), oldest first.
    #[cfg(test)]
    pub(crate) fn restore_replacements(&self, links: Vec<Link>) {
        self.restore_kept(links.into_iter().map(|l| (l, Sides::default())).collect());
    }

    /// [`Self::restore_replacements`] with what each link keeps beside its figures.
    pub(crate) fn restore_kept(&self, links: Vec<(Link, Sides)>) {
        let mut st = lock(&self.state);
        for (l, s) in links {
            st.replacements.restore_with(l, s);
        }
    }

    /// Transactions and addresses tracked now.
    pub fn tracked(&self) -> (usize, usize) {
        let st = lock(&self.state);
        (st.txs.len(), st.addresses.len())
    }

    /// Adds `conn` to a tracked topic and queues its state to it. Beyond the server's total for
    /// that kind, or an address the node is not asked about yet past the client's budget, `conn`
    /// is sent a `refused` message instead (on `/app/ws`; the caller answers on `/api/v1/ws`)
    /// and nothing is subscribed. An address's `name` is always `address:<address>`, whichever
    /// protocol asks first: it names the `/app` messages.
    pub(super) fn subscribe(
        self: &Arc<Self>,
        topic: Topic,
        name: &str,
        conn: &Arc<Conn>,
    ) -> Result<(), Declined> {
        let mut st = lock(&self.state);
        match topic {
            Topic::Tx(txid) | Topic::V1Tx(txid) => {
                if !st.txs.contains_key(&txid) && st.txs.len() >= self.bounds.txs_total {
                    st.stats.refused += 1;
                    st.stats.refused_txs += 1;
                    self.refuse(conn, topic, name, "tx", st.stats.refused_txs);
                    return Err(Declined::Full);
                }
                let entry = st.txs.entry(txid).or_insert(TxEntry {
                    refs: 0,
                    gone: None,
                    sent: None,
                });
                entry.refs += 1;
                if entry.refs == 1 {
                    st.stats.subscribed += 1;
                    if self.mempool {
                        // Its state comes from the feed, which reads the engines off this thread
                        // and in step with the removal reasons it has folded in.
                        self.wake.notify_one();
                    } else {
                        let msg = json!({ "topic": tx_name(&txid), "type": "off" });
                        self.publish(&mut st, Topic::Tx(txid), &msg);
                    }
                }
            }
            Topic::Address(sh) | Topic::V1Address(sh) | Topic::V1Addresses(sh) => {
                if !st.addresses.contains_key(&sh)
                    && st.addresses.len() >= self.bounds.addresses_total
                {
                    st.stats.refused += 1;
                    st.stats.refused_addresses += 1;
                    self.refuse(conn, topic, name, "address", st.stats.refused_addresses);
                    return Err(Declined::Full);
                }
                if let Some(e) = st.addresses.get_mut(&sh) {
                    // The node is watching it, or still being asked (an entry nobody follows is
                    // kept until it answers): nothing new for the node, so nothing is charged.
                    e.refs += 1;
                    if e.refs == 1 {
                        st.stats.subscribed += 1;
                    }
                } else {
                    let path = if topic == Topic::Address(sh) {
                        "/app/ws"
                    } else {
                        "/api/v1/ws"
                    };
                    if !self.charge(conn, path) {
                        if topic == Topic::Address(sh) {
                            let msg =
                                json!({ "topic": name, "type": "refused", "reason": FOLLOW_RATE });
                            conn.send(Frame::text(msg.to_string().as_bytes()));
                        }
                        return Err(Declined::Rate);
                    }
                    st.next_gen += 1;
                    let epoch = st.next_gen;
                    st.addresses.insert(
                        sh,
                        AddrEntry {
                            refs: 1,
                            pending: true,
                            name: name.into(),
                            epoch,
                            sub: None,
                            state: None,
                        },
                    );
                    st.stats.subscribed += 1;
                    tokio::spawn(watch(Arc::clone(self), sh, epoch));
                }
            }
            _ => return Err(Declined::Full),
        }
        // Under the same lock as every publish of these topics, so the state queued here is
        // always followed by the changes after it.
        self.hub.subscribe(topic, conn);
        Ok(())
    }

    pub(super) fn unsubscribe(&self, topic: Topic, id: u64) {
        let mut st = lock(&self.state);
        self.hub.unsubscribe(topic, id);
        let last = match topic {
            Topic::Tx(t) | Topic::V1Tx(t) => st.txs.get_mut(&t).is_some_and(|e| {
                e.refs = e.refs.saturating_sub(1);
                e.refs == 0
            }),
            Topic::Address(sh) | Topic::V1Address(sh) | Topic::V1Addresses(sh) => {
                st.addresses.get_mut(&sh).is_some_and(|e| {
                    e.refs = e.refs.saturating_sub(1);
                    e.refs == 0
                })
            }
            _ => false,
        };
        if last {
            // Every hub topic sharing the entry is forgotten with it.
            let topics = match topic {
                Topic::Tx(t) | Topic::V1Tx(t) => {
                    st.txs.remove(&t);
                    vec![Topic::Tx(t), Topic::V1Tx(t)]
                }
                Topic::Address(sh) | Topic::V1Address(sh) | Topic::V1Addresses(sh) => {
                    // Dropping the entry drops its Electrum handle: the node stops watching. One
                    // with a request in flight stays until it ends, still counted against the total.
                    if st.addresses.get(&sh).is_some_and(|e| !e.pending) {
                        st.addresses.remove(&sh);
                    }
                    vec![
                        Topic::Address(sh),
                        Topic::V1Address(sh),
                        Topic::V1Addresses(sh),
                    ]
                }
                _ => return,
            };
            for t in topics {
                self.hub.remove(t);
            }
        }
    }

    /// Takes one token of `conn`'s client's budget for new node work. Without one, the refusal is
    /// counted in the summary, never logged on its own (SECURITY.md rule 22).
    pub(super) fn charge(&self, conn: &Conn, path: &str) -> bool {
        let Err(r) = self.follows.take(conn.who.client) else {
            return true;
        };
        let reason = match r.reason {
            "route_rate" => FOLLOW_RATE,
            other => other,
        };
        self.hub.sockets().refusals.count(reason, path, conn.who);
        false
    }

    fn refuse(&self, conn: &Conn, topic: Topic, name: &str, kind: &'static str, total: u64) {
        // `/api/v1/ws` names no topics: its session answers in its own shape.
        if matches!(topic, Topic::Tx(_) | Topic::Address(_)) {
            let msg = json!({ "topic": name, "type": "refused", "reason": "server_full" });
            conn.send(Frame::text(msg.to_string().as_bytes()));
        }
        if total.is_power_of_two() {
            logging::emit(&TrackingRefused {
                network: self.network.name(),
                kind,
                reason: "server_full",
                total,
            });
        }
    }

    /// Tells the `replacements` topic the record's version, so a page listing replacements asks
    /// for them again when it changes.
    fn say_record(&self, st: &mut State) {
        st.record_said = true;
        let msg = json!({
            "topic": "replacements",
            "type": "replacements",
            "version": st.replacements.version(),
        });
        self.publish(st, Topic::Replacements, &msg);
    }

    fn publish(&self, st: &mut State, topic: Topic, msg: &Value) {
        let frame = Frame::text(msg.to_string().as_bytes());
        st.stats.messages += 1;
        st.stats.bytes += frame.len() as u64;
        self.hub.publish(topic, &frame, Snapshot::Replace);
    }

    // Transactions.

    /// What the engines hold for `txids`. It can wait for a pack of the projected blocks, so it
    /// runs on a blocking thread and never under the tracking lock. `None` before the engines
    /// are attached or before the tracker's first cycle: nothing honest can be said yet.
    fn view(&self, txids: &[Txid]) -> Option<View> {
        let (tracker, projector) = self.engines.get()?;
        let infos: Option<(u64, Vec<(Txid, Record)>)> = tracker.read(|m| {
            m.tip()?;
            Some((
                m.seq(),
                txids
                    .iter()
                    .filter_map(|t| {
                        Some((*t, m.get(t).map(|i| (i.time, i.fee.to_sat(), i.vsize))?))
                    })
                    .collect(),
            ))
        });
        let (seq, infos) = infos?;
        let p = projector.current();
        Some(View {
            seq,
            asked: txids.iter().copied().collect(),
            stale: p.stale,
            blocks: p.blocks.len(),
            starts: p
                .blocks
                .iter()
                .scan(0u64, |at, b| {
                    let start = *at;
                    *at += b.summary.vsize;
                    Some(start)
                })
                .collect(),
            txs: infos
                .into_iter()
                .map(|(t, i)| (t, (i, projector.position(&t))))
                .collect(),
        })
    }

    /// Folds one tracker delta in: the record follows the delta's window of blocks, every
    /// replacement goes into it, and each tracked transaction that left or came back has its
    /// reason set or cleared. Returns whether a reason or the record changed, and the record's
    /// changes, for the store.
    fn apply(&self, d: &Delta, tracker: &Tracker) -> (bool, Batch) {
        let mut st = lock(&self.state);
        st.applied = d.seq;
        let seen = unix_now();
        let version = st.replacements.version();
        let new = st.replacements.follow(&d.blocks);
        // A reorg moved the record: said at once, like a confirmation.
        let mut moved = st.replacements.version() != version;
        for (txid, info) in &d.replaced {
            let Ok(i) = d.removed.binary_search_by_key(txid, |(t, _)| *t) else {
                continue;
            };
            let Some((_, Removal::Replaced { by })) = d.removed.get(i) else {
                continue;
            };
            let by_info = d
                .added
                .binary_search_by_key(by, |(t, _)| *t)
                .ok()
                .and_then(|i| d.added.get(i))
                .map(|(_, i)| i.clone())
                .or_else(|| tracker.read(|m| m.get(by).cloned()));
            // The tracker names as a replacement only what entered the mempool in this cycle or
            // sits in one of the window's blocks.
            let block = d.blocks.iter().find(|b| b.contains(by));
            let mined = block.map_or(Mined::No, |b| Mined::In(Some((b.height, b.hash))));
            let link = Link {
                txid: *txid,
                by: *by,
                seen,
                tx: Facts::of(info),
                by_tx: by_info.as_ref().map(Facts::of),
                mined,
            };
            st.replacements.insert_with(
                link,
                Sides::of(info, by_info.as_ref(), block.map(|b| (&**b, by))),
            );
        }
        for (txid, reason) in &d.removed {
            if let Removal::Confirmed { height, block } = reason {
                st.replacements.confirmed(txid, *height, *block);
            }
            if let Some(e) = st.txs.get_mut(txid) {
                e.gone = Some(*reason);
                moved = true;
            }
        }
        for (txid, _) in &d.added {
            st.replacements.returned(txid);
            if let Some(e) = st.txs.get_mut(txid) {
                e.gone = None;
                moved = true;
            }
        }
        // The original won: it is confirmed, no longer replaced.
        for (txid, height, block) in st.replacements.originals(&new) {
            if let Some(e) = st.txs.get_mut(&txid) {
                e.gone = Some(Removal::Confirmed { height, block });
                moved = true;
            }
        }
        // The first delta says the record as it stands, for new subscribers; then each change.
        if st.replacements.version() != version || !st.record_said {
            self.say_record(&mut st);
        }
        (moved, st.replacements.take_changes())
    }

    /// The node reads the record's check needs next, if any ([`Replacements::asks`]).
    fn asks(&self) -> Option<(u64, Vec<Ask>)> {
        lock(&self.state).replacements.asks()
    }

    /// Folds a check's answers into the record. Returns whether it changed, and its changes.
    fn answers(&self, epoch: u64, answers: &[(Ask, Option<Answer>)]) -> (bool, Batch) {
        let mut st = lock(&self.state);
        let version = st.replacements.version();
        st.replacements.answers(epoch, answers);
        let changed = st.replacements.version() != version;
        if changed {
            self.say_record(&mut st);
        }
        (changed, st.replacements.take_changes())
    }

    /// Starting over from the tracker's state at `seq`, after losing our place in its stream:
    /// reasons may be out of date, so forget them.
    fn lost_place(&self, seq: u64) {
        let mut st = lock(&self.state);
        st.applied = seq;
        for e in st.txs.values_mut() {
            e.gone = None;
        }
    }

    /// Blocks above `fork_height` left the best chain: a confirmation in one of them no longer
    /// holds. The tracker re-adds what the node takes back into its mempool; the rest is unknown.
    /// `0` when the chain's continuity was lost (a reconnect, a reorg deeper than Electrum
    /// follows, a lost event): no remembered confirmation can be vouched for.
    fn reorged(&self, fork_height: u32) {
        let mut forgot = false;
        for e in lock(&self.state).txs.values_mut() {
            if matches!(e.gone, Some(Removal::Confirmed { height, .. }) if height > fork_height) {
                e.gone = None;
                // Said again by the feed's next pass for new entries, whatever else moves.
                e.sent = None;
                forgot = true;
            }
        }
        if forgot {
            self.wake.notify_one();
        }
    }

    /// Publishes every tracked transaction whose state changed, or with `new_only` those not
    /// said yet. A shuffle waits until `WS_POSITION_INTERVAL_MS` after the last message. Returns
    /// what is left to say.
    async fn publish_txs(self: &Arc<Self>, new_only: bool) -> Left {
        let txids: Vec<Txid> = lock(&self.state)
            .txs
            .iter()
            .filter(|(_, e)| !new_only || e.sent.is_none())
            .map(|(t, _)| *t)
            .collect();
        if txids.is_empty() {
            return Left::Nothing;
        }
        let me = Arc::clone(self);
        let Ok(Some(view)) = tokio::task::spawn_blocking(move || me.view(&txids)).await else {
            return Left::Nothing;
        };
        let now = Instant::now();
        let interval = self.bounds.position_interval;
        let mut waiting = false;
        let mut out = Vec::new();
        let mut st = lock(&self.state);
        // The tracker moved on from the deltas folded in, or they from it: a transaction could
        // read as present when it has left, or gone without its reason. Try again shortly.
        if view.seq != st.applied {
            return Left::Again;
        }
        let State {
            txs, replacements, ..
        } = &mut *st;
        for (txid, e) in txs.iter_mut() {
            // Followed since the view was read, or already said.
            if !view.asked.contains(txid) || new_only && e.sent.is_some() {
                continue;
            }
            let shown = view.shown(txid, e.gone, replacements);
            let send = match &e.sent {
                None => true,
                Some((last, _)) if *last == shown => false,
                Some((last, at)) if last.shuffled(&shown) => {
                    let due = now.duration_since(*at) >= interval;
                    waiting |= !due;
                    due
                }
                Some(_) => true,
            };
            if send {
                let v1 = super::v1::tx_message(txid, &shown.state, &view.starts);
                out.push((*txid, tx_message(txid, &shown), v1));
                e.sent = Some((shown, now));
            }
        }
        for (txid, msg, v1) in out {
            self.publish(&mut st, Topic::Tx(txid), &msg);
            match v1 {
                Some(v1) => self.publish(&mut st, Topic::V1Tx(txid), &v1),
                // A state the reference has no message for: a later subscriber is told nothing.
                None => self.hub.clear(Topic::V1Tx(txid)),
            }
        }
        if waiting {
            Left::Shuffle
        } else {
            Left::Nothing
        }
    }

    // Addresses.

    fn address_message(&self, st: &mut State, sh: ScriptHash) {
        let Some(e) = st.addresses.get(&sh) else {
            return;
        };
        let Some(state) = &e.state else {
            return;
        };
        let fields = match state {
            AddrState::Watching(status) => json!({ "state": "watching", "status": status }),
            AddrState::Unavailable => json!({ "state": "unavailable" }),
            AddrState::Refused(reason) => json!({ "state": "refused", "reason": reason }),
            AddrState::Ledger(height) => json!({ "state": "ledger", "height": height }),
        };
        let msg = merge(json!({ "topic": &*e.name, "type": "address" }), fields);
        self.publish(st, Topic::Address(sh), &msg);
    }

    pub fn set_gate(&self, gate: Arc<dyn AddressGate>) {
        let _ = self.gate.set(gate);
    }

    /// The ledger's totals for a script changed, or it began keeping it: followers are told the
    /// new height, and the node's subscription, if any, is dropped.
    pub fn ledger_changed(&self, sh: ScriptHash, height: u32) {
        let mut st = lock(&self.state);
        let Some(e) = st.addresses.get_mut(&sh) else {
            return;
        };
        if e.pending {
            return;
        }
        e.sub = None;
        e.state = Some(AddrState::Ledger(height));
        self.address_message(&mut st, sh);
    }

    /// A status the node pushed for a script.
    fn address_status(&self, sh: ScriptHash, status: Option<String>) {
        let mut st = lock(&self.state);
        let Some(e) = st.addresses.get_mut(&sh) else {
            return;
        };
        let next = Some(AddrState::Watching(status));
        if e.sub.is_none() || e.state == next {
            return;
        }
        e.state = next;
        self.address_message(&mut st, sh);
    }

    /// The Electrum connection is lost: every address is `unavailable` until it is back. The
    /// client keeps the subscriptions and restores them on reconnect.
    fn addresses_down(&self) {
        let mut st = lock(&self.state);
        let mut changed = Vec::new();
        for (sh, e) in &mut st.addresses {
            if matches!(e.state, Some(AddrState::Watching(_))) {
                e.state = Some(AddrState::Unavailable);
                changed.push(*sh);
            }
        }
        for sh in changed {
            self.address_message(&mut st, sh);
        }
    }

    /// After a reconnect or a lost event: re-read every status, and ask again for the addresses
    /// the node could not be reached for.
    fn refresh_addresses(self: &Arc<Self>) {
        let mut st = lock(&self.state);
        let mut changed = Vec::new();
        let mut retry = Vec::new();
        for (sh, e) in &mut st.addresses {
            match (&e.sub, &e.state) {
                (Some(sub), _) => {
                    let next = match sub.status() {
                        Some(Status::ScriptHash(s)) => AddrState::Watching(s),
                        // The node no longer watches it (it refused a re-subscribe): ask again,
                        // whatever was said meanwhile, so its answer reaches the client.
                        _ => {
                            if !e.pending {
                                e.sub = None;
                                retry.push((*sh, e.epoch));
                            }
                            AddrState::Unavailable
                        }
                    };
                    if e.state.as_ref() != Some(&next) {
                        e.state = Some(next);
                        changed.push(*sh);
                    }
                }
                (None, Some(AddrState::Unavailable)) if !e.pending => {
                    retry.push((*sh, e.epoch));
                }
                _ => {}
            }
        }
        for sh in changed {
            self.address_message(&mut st, sh);
        }
        for (sh, epoch) in retry {
            if let Some(e) = st.addresses.get_mut(&sh) {
                e.pending = true;
            }
            tokio::spawn(watch(Arc::clone(self), sh, epoch));
        }
    }

    /// One `tracking_summary` line, if anything is tracked or happened since the last.
    fn summary(&self) {
        let mut st = lock(&self.state);
        let recorded = st.replacements.take_recorded();
        let s = std::mem::take(&mut st.stats);
        st.stats.refused_txs = s.refused_txs;
        st.stats.refused_addresses = s.refused_addresses;
        let (txs, addresses) = (st.txs.len(), st.addresses.len());
        if txs + addresses == 0 && s.subscribed == 0 && s.refused == 0 && recorded == 0 {
            return;
        }
        logging::emit(&TrackingSummary {
            network: self.network.name(),
            txs,
            addresses,
            subscribed: s.subscribed,
            refused: s.refused,
            messages: s.messages,
            bytes: s.bytes,
            address_errors: s.address_errors,
            replacements: st.replacements.len(),
            replaced: recorded,
        });
    }
}

/// The topic's name for a transaction.
fn tx_name(txid: &Txid) -> String {
    format!("tx:{txid}")
}

/// A mempool transaction's own figures from the tracker: accept time, fee, vsize.
type Record = (u32, u64, u32);

/// The engines' view of some transactions at one moment.
struct View {
    /// The tracker delta it reflects.
    seq: u64,
    asked: HashSet<Txid>,
    stale: bool,
    blocks: usize,
    /// The vsize ahead of each projected block, for `/api/v1/ws`'s position inside its block.
    starts: Vec<u64>,
    /// Those in the mempool: time, fee, vsize, and the position if placed yet.
    txs: HashMap<Txid, (Record, Option<Position>)>,
}

impl View {
    /// What is known about `txid`: in the mempool, or why it left.
    fn shown(&self, txid: &Txid, gone: Option<Removal>, replacements: &Replacements) -> Shown {
        Shown {
            state: state(txid, self.txs.get(txid).copied(), gone, replacements),
            stale: self.stale,
            blocks: self.blocks,
        }
    }
}

fn state(
    txid: &Txid,
    held: Option<(Record, Option<Position>)>,
    gone: Option<Removal>,
    replacements: &Replacements,
) -> TxState {
    if let Some(((time, fee, vsize), position)) = held {
        return TxState::Mempool {
            time,
            fee,
            vsize,
            position,
        };
    }
    let replaced = |by: Option<Txid>| {
        let (chain, cut) = replacements.chain(txid);
        match (chain.is_empty(), by) {
            (false, _) => Some(TxState::Replaced(chain, cut)),
            // Pushed out of the record since: what we still know, and the record from there on.
            (true, Some(by)) => {
                let (rest, cut) = replacements.chain(&by);
                let mut chain = vec![Link {
                    txid: *txid,
                    by,
                    seen: 0,
                    tx: Facts::default(),
                    by_tx: None,
                    mined: Mined::No,
                }];
                chain.extend(rest.into_iter().filter(|l| l.txid != *txid));
                let cut = cut || chain.len() > MAX_LINKS;
                chain.truncate(MAX_LINKS);
                Some(TxState::Replaced(chain, cut))
            }
            (true, None) => None,
        }
    };
    match gone {
        Some(Removal::Confirmed { height, block }) => TxState::Confirmed {
            height,
            hash: block,
        },
        Some(Removal::Replaced { by }) => replaced(Some(by)).unwrap_or(TxState::Evicted),
        Some(Removal::Evicted) => TxState::Evicted,
        None => replaced(None).unwrap_or(TxState::Unknown),
    }
}

/// Sat per 1,000 vB, rounded down.
fn rate(fee: u64, vsize: u32) -> u64 {
    fee.saturating_mul(1000) / u64::from(vsize.max(1))
}

/// `head` with the fields of `more` added.
fn merge(mut head: Value, more: Value) -> Value {
    if let (Value::Object(h), Value::Object(m)) = (&mut head, more) {
        h.extend(m);
    }
    head
}

fn tx_message(txid: &Txid, s: &Shown) -> Value {
    let fields = match &s.state {
        TxState::Mempool {
            time,
            fee,
            vsize,
            position,
        } => json!({
            "state": "mempool",
            "time": time,
            "fee": fee,
            "vsize": vsize,
            "rate": rate(*fee, *vsize),
            "position": position.map(|p| json!({
                "block": p.placed.block,
                "blocks": s.blocks,
                "effective_rate": p.placed.rate,
                "ahead_vsize": p.ahead_vsize,
                "ahead_txs": p.ahead_txs,
            })),
        }),
        TxState::Replaced(chain, cut) => json!({
            "state": "replaced",
            "by": chain.first().map(|l| l.by),
            "chain": chain
                .iter()
                // A link known only from the tracker's reason has no figures.
                .map(|l| if l.tx.vsize == 0 { json!({ "txid": l.txid, "by": l.by }) } else { l.json() })
                .collect::<Vec<_>>(),
            "truncated": cut,
        }),
        TxState::Confirmed { height, hash } => {
            json!({ "state": "confirmed", "height": height, "hash": hash })
        }
        TxState::Evicted => json!({ "state": "evicted" }),
        TxState::Unknown => json!({ "state": "unknown" }),
    };
    merge(
        json!({ "topic": tx_name(txid), "type": "tx", "stale": s.stale }),
        fields,
    )
}

/// Asks the node to watch an address, and says what it answered. An entry released meanwhile is
/// not revived: dropping the answer's handle releases the node's subscription again.
async fn watch(track: Arc<Tracking>, sh: ScriptHash, epoch: u64) {
    // Asked of the gate again after a pause for as long as its size cannot be learned and anyone
    // still follows it.
    loop {
        let decision = match track.gate.get() {
            Some(gate) => gate.decide(sh).await,
            None => Decision::Watch,
        };
        if decision == Decision::Watch {
            break;
        }
        if !not_watched(&track, sh, epoch, decision) {
            return;
        }
        tokio::time::sleep(GATE_RETRY).await;
    }
    let answer = track
        .electrum
        .as_ref()
        .map(|client| client.subscribe(electrum::Topic::ScriptHash(sh)));
    let answer = match answer {
        Some(a) => Some(a.await),
        None => None,
    };
    let mut st = lock(&track.state);
    let Some(e) = st.addresses.get_mut(&sh).filter(|e| e.epoch == epoch) else {
        return;
    };
    e.pending = false;
    // Everyone left while the node was asked: release it now.
    if e.refs == 0 {
        st.addresses.remove(&sh);
        return;
    }
    let failed = match answer {
        Some(Ok(sub)) => {
            let status = match sub.status() {
                Some(Status::ScriptHash(s)) => s,
                _ => None,
            };
            e.sub = Some(sub);
            e.state = Some(AddrState::Watching(status));
            false
        }
        Some(Err(err)) => {
            e.state = Some(refusal(&err));
            true
        }
        None => {
            e.state = Some(AddrState::Unavailable);
            true
        }
    };
    if failed {
        st.stats.address_errors += 1;
    }
    track.address_message(&mut st, sh);
}

/// Records a decision not to ask the node to watch `sh`. `true` when it is to be asked again
/// shortly: the entry stays pending meanwhile, so it keeps its place and is not asked twice.
fn not_watched(track: &Tracking, sh: ScriptHash, epoch: u64, decision: Decision) -> bool {
    let mut st = lock(&track.state);
    let Some(e) = st.addresses.get_mut(&sh).filter(|e| e.epoch == epoch) else {
        return false;
    };
    if e.refs == 0 {
        st.addresses.remove(&sh);
        return false;
    }
    e.state = Some(match decision {
        Decision::Ledger(h) => AddrState::Ledger(h),
        Decision::TooLarge => AddrState::Refused("too_large"),
        Decision::Watch | Decision::Later => AddrState::Unavailable,
    });
    e.pending = decision == Decision::Later;
    track.address_message(&mut st, sh);
    e_pending(&st, sh)
}

fn e_pending(st: &State, sh: ScriptHash) -> bool {
    st.addresses.get(&sh).is_some_and(|e| e.pending)
}

/// What a failed Electrum subscribe means for the client.
fn refusal(e: &electrum::Error) -> AddrState {
    match e {
        electrum::Error::SubscriptionLimit { .. } => AddrState::Refused("server_full"),
        // rbitcoin answers code 1 with "scripthash index disabled", or "scripthash join
        // exceeds --max-sh-creates (N creates, cap M)" for an address with too much history.
        electrum::Error::Server { message, .. } => {
            if message.contains("index disabled") {
                AddrState::Refused("no_index")
            } else if message.contains("max-sh-creates") {
                AddrState::Refused("too_large")
            } else {
                AddrState::Refused("refused")
            }
        }
        electrum::Error::Disconnected
        | electrum::Error::Timeout
        | electrum::Error::Overloaded
        | electrum::Error::Protocol(_) => AddrState::Unavailable,
    }
}

/// How long a check the node could not answer waits before it is tried again.
pub(crate) const CHECK_RETRY: Duration = Duration::from_secs(30);

/// Follows the engines for the tracked transactions: the tracker's stream for removal reasons
/// and replacements, the projected blocks for positions. Reconsiders every followed
/// transaction at most once per `WS_MEMPOOL_INTERVAL_MS`, and a newly followed one at once. One
/// task per network, whatever the number of subscribers.
///
/// It also runs the replacement record's checks after a reorg, through `lookup`, one at a time
/// and off this loop: a check that fails is tried again after [`CHECK_RETRY`].
pub(crate) async fn follow_txs<L: Lookup + Clone + 'static>(
    track: Arc<Tracking>,
    interval: Duration,
    kept: Option<Kept>,
    lookup: L,
) {
    let Some((tracker, projector)) = track.engines.get().cloned() else {
        return;
    };
    let mut restore = kept.as_ref();
    let mut check: Option<tokio::task::JoinHandle<_>> = None;
    let mut retry = Instant::now();
    loop {
        let (seq, mut deltas) = tracker.subscribe(|m| m.seq());
        // After subscribing, so a replacement seen meanwhile waits in the stream; before the
        // first delta is folded in, so restored links stay older than new ones.
        if let Some(k) = restore.take() {
            k.restore(&track).await;
        }
        // Its lock is held through a pack: take it on a blocking thread.
        let p = projector.clone();
        let Ok((_, mut projections)) = tokio::task::spawn_blocking(move || p.subscribe()).await
        else {
            return;
        };
        track.lost_place(seq);
        let (mut dirty, mut next) = (true, Instant::now());
        loop {
            tokio::select! {
                // Deltas first, so a publish sees the removal reasons of what has left.
                biased;
                d = deltas.recv() => match d {
                    Ok(d) => {
                        // A confirmation, replacement or return is said at once, not at the
                        // next interval: a block's confirmations go out with its projection.
                        let (moved, batch) = track.apply(&d, &tracker);
                        if moved {
                            next = Instant::now();
                        }
                        if let Some(k) = &kept {
                            k.send(batch);
                        }
                        dirty = true;
                    }
                    Err(RecvError::Lagged(_)) => break,
                    Err(RecvError::Closed) => return,
                },
                r = async {
                    match check.as_mut() {
                        Some(c) => c.await,
                        None => std::future::pending().await,
                    }
                }, if check.is_some() => {
                    check = None;
                    if let Ok((epoch, answers)) = r {
                        let answers: Vec<(Ask, Option<Answer>)> = answers;
                        let failed = answers.iter().any(|(_, a)| a.is_none());
                        let (changed, batch) = track.answers(epoch, &answers);
                        logging::emit(&ReplacementsChecked {
                            network: track.network.name(),
                            reads: answers.len(),
                            failed,
                            changed,
                        });
                        if let Some(k) = &kept {
                            k.send(batch);
                        }
                        if changed {
                            dirty = true;
                            next = Instant::now();
                        }
                        if failed {
                            retry = Instant::now() + CHECK_RETRY;
                        }
                    }
                },
                () = tokio::time::sleep_until(retry), if check.is_none() && retry > Instant::now() => {},
                p = projections.recv() => match p {
                    Ok(_) | Err(RecvError::Lagged(_)) => dirty = true,
                    Err(RecvError::Closed) => return,
                },
                () = track.wake.notified() => {
                    dirty |= track.publish_txs(true).await != Left::Nothing;
                }
                () = tokio::time::sleep_until(next), if dirty => {
                    let left = track.publish_txs(false).await;
                    dirty = left != Left::Nothing;
                    // A view ahead of the deltas folded in is tried again once they are in, not
                    // an interval later: it may hold a confirmation.
                    next = Instant::now() + if left == Left::Again { AGAIN } else { interval };
                }
            }
            if check.is_none()
                && Instant::now() >= retry
                && let Some((epoch, asks)) = track.asks()
            {
                let l = lookup.clone();
                check = Some(tokio::spawn(async move {
                    (epoch, engine::replacements::ask(&l, &asks).await)
                }));
            }
        }
    }
}

/// What [`Tracking::publish_txs`] left to say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Left {
    Nothing,
    /// A position shuffle, until `WS_POSITION_INTERVAL_MS` after the last message.
    Shuffle,
    /// Everything: the view was read at another tracker delta than the reasons folded in.
    Again,
}

/// How soon a publish whose view missed the deltas folded in is tried again.
const AGAIN: Duration = Duration::from_millis(25);

/// Follows the network's Electrum events for the tracked addresses, and writes the minute's
/// `tracking_summary`. One task per network.
pub async fn follow_addresses(
    track: Arc<Tracking>,
    mut events: tokio::sync::broadcast::Receiver<electrum::Event>,
    mut health: tokio::sync::watch::Receiver<electrum::Health>,
) {
    let mut tick = tokio::time::interval_at(Instant::now() + SUMMARY_EVERY, SUMMARY_EVERY);
    let mut ready = health.borrow_and_update().ready;
    loop {
        tokio::select! {
            e = events.recv() => match e {
                Ok(electrum::Event::Status {
                    topic: electrum::Topic::ScriptHash(sh),
                    status: Status::ScriptHash(s),
                }) => track.address_status(sh, s),
                Ok(electrum::Event::Resynced | electrum::Event::Block(_))
                | Err(RecvError::Lagged(_)) => {
                    if !matches!(e, Ok(electrum::Event::Block(_))) {
                        track.reorged(0);
                    }
                    // Read now: a reconnect's `Resynced` can come before its health change.
                    if health.borrow().ready {
                        track.refresh_addresses();
                    }
                }
                Ok(electrum::Event::Reorg { fork_height }) => track.reorged(fork_height),
                Ok(electrum::Event::Status { .. }) => {}
                Err(RecvError::Closed) => return,
            },
            r = health.changed() => {
                if r.is_err() {
                    return;
                }
                let now = health.borrow_and_update().ready;
                match (ready, now) {
                    (true, false) => track.addresses_down(),
                    // The first connection sends no `Resynced`: ask for what could not be.
                    (false, true) => track.refresh_addresses(),
                    _ => {}
                }
                ready = now;
            }
            _ = tick.tick() => track.summary(),
        }
    }
}

#[cfg(test)]
// The block audit tests reuse its mock node.
pub(crate) mod tests;
