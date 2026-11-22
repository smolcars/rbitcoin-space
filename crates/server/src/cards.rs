//! Link preview pictures for transaction and block pages (docs/FRONTEND.md, "Link previews"):
//! `GET {network}/app/card/tx/{txid}.png` and `GET {network}/app/card/block/{height or hash}.png`,
//! drawn by the `card` crate from what the server already holds.
//!
//! A page's head names its card without asking anything, so a card can be asked for a
//! transaction that does not exist, while the node is down, or past the limits here. Each of
//! those answers the site's one static picture with a short cache, never an error: a link never
//! loses its picture. An id that does not parse is a plain 404, as its page would be.
//!
//! What one card costs, at most (SECURITY.md rules 8 and 11):
//! - a transaction in the mempool: the tracker's and projector's read locks, briefly, on a
//!   blocking thread, and one block-table read for the newest blocks. No node call.
//! - any other transaction: one Esplora `/tx/{txid}` read, shared with identical reads in flight
//!   through the pass-through's call sharing, and one block-table read.
//! - a block: two block-table reads (its row, then its neighbours). No node call; a block the
//!   table does not hold gets the static picture.
//!
//! [`DRAWS`] cards are built at once, server-wide, each given [`BUILD_WAIT`] for its reads: past
//! either, the static picture. Each is drawn on a blocking thread (about 20 ms) and kept, by
//! bytes, in [`Kept`]. A client past its own allowance is refused before any of this, as on
//! every `/app` route (SECURITY.md rule 7).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Extension;
use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::HeaderValue;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, Txid};
use card::{Card, Layers, Strip, Subject, Tile, TxState};
use engine::blocks::{Miner, Row};
use node::esplora::Route;
use tokio::sync::{OnceCell, Semaphore};

use crate::config::Network;
use crate::{ApiError, NetworkContext, esplora};

/// Cards being built at once, server-wide: their node and store reads and their drawing.
pub const DRAWS: usize = 2;
/// Drawn cards kept, by bytes: about 65 cards of 60 KB.
const KEPT_BYTES: usize = 4 << 20;
/// A card that can change: an unconfirmed transaction, or a block near the tip whose strip
/// moves with each new block. Also the static picture's, so a card replaces it soon.
const LIVE: Duration = Duration::from_secs(60);
const LIVE_HEADER: &str = "public, max-age=60";
/// A block at least [`BURIED`] deep, and its transactions: only a new pool list changes them.
const SETTLED: Duration = Duration::from_secs(86_400);
const SETTLED_HEADER: &str = "public, max-age=86400";
/// As deep as the block table's own zone, past which no reorg reaches (`engine::blocks::ZONE`).
const BURIED: u32 = engine::blocks::ZONE;

/// Mined blocks in the strip beside the projected ones, and without them.
const BESIDE_PROJECTED: u32 = 5;
const MINED_ALONE: u32 = 8;
/// The strip's last tile runs off the card's edge, so the subject, ringed, is never drawn in it.
const CUT: u32 = 1;
/// Projected blocks in the strip.
const PROJECTED: usize = 3;
/// Longest a card's reads may take, well inside the request timeout: past it, the static picture.
const BUILD_WAIT: Duration = Duration::from_secs(3);

/// The cards' shared state, one for the server.
pub struct Cards {
    /// The site's static link preview picture, read at start from the built frontend.
    fallback: Option<Bytes>,
    slots: Semaphore,
    kept: Mutex<Kept>,
    /// Cards being built now, which identical requests wait for instead of building again.
    building: Mutex<HashMap<Key, Building>>,
}

/// One build's answer, shared by every request for the same card while it runs.
type Flight = OnceCell<Option<(Bytes, &'static str)>>;

/// A build in the map, and the requests waiting on it, counted under the map's lock.
struct Building {
    flight: Arc<Flight>,
    waiting: usize,
}

impl std::fmt::Debug for Cards {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cards").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Key {
    Tx(Network, Txid),
    Block(Network, BlockId),
}

/// A block as its page names it: by height or by hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum BlockId {
    Height(u32),
    Hash(BlockHash),
}

/// A block page's id, parsed as the page parses it: a height of 1 to 10 digits within `u32`,
/// else a block hash.
pub(crate) fn block_id(s: &str) -> Option<BlockId> {
    match crate::pages::height(s) {
        Ok(h) => Some(BlockId::Height(h)),
        Err(()) => esplora::block_hash(s).ok().map(BlockId::Hash),
    }
}

impl std::fmt::Display for BlockId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Height(h) => write!(f, "{h}"),
            Self::Hash(h) => write!(f, "{h}"),
        }
    }
}

struct Entry {
    png: Bytes,
    until: Instant,
    header: &'static str,
    used: u64,
}

/// Drawn cards until they expire, the least recently used dropped first past [`KEPT_BYTES`].
#[derive(Default)]
struct Kept {
    map: HashMap<Key, Entry>,
    bytes: usize,
    clock: u64,
}

impl Kept {
    fn get(&mut self, key: &Key, now: Instant) -> Option<(Bytes, &'static str)> {
        self.clock += 1;
        let clock = self.clock;
        match self.map.get_mut(key) {
            Some(e) if e.until > now => {
                e.used = clock;
                Some((e.png.clone(), e.header))
            }
            Some(_) => {
                if let Some(e) = self.map.remove(key) {
                    self.bytes -= e.png.len();
                }
                None
            }
            None => None,
        }
    }

    fn put(&mut self, key: Key, png: Bytes, life: Duration, header: &'static str, now: Instant) {
        if png.len() > KEPT_BYTES {
            return;
        }
        self.clock += 1;
        if let Some(old) = self.map.remove(&key) {
            self.bytes -= old.png.len();
        }
        while self.bytes + png.len() > KEPT_BYTES {
            let Some(oldest) = self
                .map
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(e) = self.map.remove(&oldest) {
                self.bytes -= e.png.len();
            }
        }
        self.bytes += png.len();
        self.map.insert(
            key,
            Entry {
                png,
                until: now + life,
                header,
                used: self.clock,
            },
        );
    }
}

impl Cards {
    /// `web_dir` holds the built frontend, whose `/assets` has the static picture.
    pub fn new(web_dir: Option<&Path>) -> Self {
        let fallback = web_dir
            .and_then(|d| std::fs::read(d.join(crate::pages::IMAGE.trim_start_matches('/'))).ok())
            .map(Bytes::from);
        Self {
            fallback,
            slots: Semaphore::new(DRAWS),
            kept: Mutex::default(),
            building: Mutex::default(),
        }
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, Kept> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The static picture, as a card that could not be drawn now; a 404 on a server with no
    /// frontend, which has no pages to name a card either.
    fn fallback(&self) -> Response {
        match &self.fallback {
            Some(png) => png_response(png.clone(), LIVE_HEADER),
            None => ApiError::NOT_FOUND.into_response(),
        }
    }

    /// The kept card, or one built by `build` and kept; the static picture when none can be.
    /// Requests for the same card share one build (SECURITY.md rule 8): the first takes a slot
    /// and the rest wait for its answer.
    async fn serve<F>(&self, key: Key, build: F) -> Response
    where
        F: Future<Output = Option<(Card, bool)>>,
    {
        if let Some((png, header)) = self.kept().get(&key, Instant::now()) {
            return png_response(png, header);
        }
        let flight = Waiting::new(self, &key);
        let drawn = flight
            .cell()
            .get_or_init(|| self.build(key.clone(), build))
            .await;
        match drawn {
            Some((png, header)) => png_response(png.clone(), header),
            None => self.fallback(),
        }
    }

    fn building(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Building>> {
        self.building.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// One card built in a slot, drawn and kept; `None` when it cannot be now.
    async fn build<F>(&self, key: Key, build: F) -> Option<(Bytes, &'static str)>
    where
        F: Future<Output = Option<(Card, bool)>>,
    {
        let _slot = self.slots.try_acquire().ok()?;
        let (card, settled) = tokio::time::timeout(BUILD_WAIT, build).await.ok()??;
        let png = tokio::task::spawn_blocking(move || card::draw(&card))
            .await
            .ok()?;
        let png = Bytes::from(png);
        let (life, header) = if settled {
            (SETTLED, SETTLED_HEADER)
        } else {
            (LIVE, LIVE_HEADER)
        };
        self.kept()
            .put(key, png.clone(), life, header, Instant::now());
        Some((png, header))
    }
}

/// One request's hold on a card being built. However the request ends, finished or cancelled
/// (a timeout drops it mid-build), the last one out removes the build from `building`, so an
/// abandoned build leaves nothing behind and a finished one is not reused once kept.
struct Waiting<'a> {
    cards: &'a Cards,
    key: Key,
    flight: Arc<Flight>,
}

impl<'a> Waiting<'a> {
    fn new(cards: &'a Cards, key: &Key) -> Self {
        let mut building = cards.building();
        let build = building.entry(key.clone()).or_insert_with(|| Building {
            flight: Arc::new(OnceCell::new()),
            waiting: 0,
        });
        build.waiting += 1;
        let flight = Arc::clone(&build.flight);
        drop(building);
        Self {
            cards,
            key: key.clone(),
            flight,
        }
    }

    fn cell(&self) -> &Flight {
        &self.flight
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut building = self.cards.building();
        let Some(build) = building
            .get_mut(&self.key)
            .filter(|b| Arc::ptr_eq(&b.flight, &self.flight))
        else {
            return;
        };
        build.waiting = build.waiting.saturating_sub(1);
        if build.waiting == 0 || self.flight.initialized() {
            building.remove(&self.key);
        }
    }
}

fn png_response(png: Bytes, cache: &'static str) -> Response {
    (
        [
            (CONTENT_TYPE, HeaderValue::from_static("image/png")),
            (CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        Body::from(png),
    )
        .into_response()
}

fn file_id(file: &str) -> Option<&str> {
    file.strip_suffix(".png")
}

fn network(n: Network) -> card::Network {
    match n {
        Network::Mainnet => card::Network::Mainnet,
        Network::Signet => card::Network::Signet,
        Network::Testnet4 => card::Network::Testnet4,
        Network::Testnet5 => card::Network::Testnet5,
        Network::Regtest => card::Network::Regtest,
    }
}

/// An id's bytes in the order it is written.
fn id<H: Hash<Bytes = [u8; 32]>>(h: H) -> card::Id {
    let mut b = h.to_byte_array();
    b.reverse();
    card::Id(b)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// `GET /app/card/tx/{txid}.png`
pub async fn tx(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(cards): Extension<Arc<Cards>>,
    UrlPath(file): UrlPath<String>,
) -> Response {
    let Some(txid) = file_id(&file).and_then(|s| esplora::txid(s).ok()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let key = Key::Tx(ctx.config.network, txid);
    cards.serve(key, build_tx(&ctx, txid)).await
}

/// `GET /app/card/block/{height or hash}.png`, the ids the block page takes.
pub async fn block(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(cards): Extension<Arc<Cards>>,
    UrlPath(file): UrlPath<String>,
) -> Response {
    let Some(id) = file_id(&file).and_then(block_id) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let key = Key::Block(ctx.config.network, id);
    cards.serve(key, build_block(&ctx, id)).await
}

/// What the mempool engines hold for a card, read on a blocking thread: the projector's lock
/// can be held for a pack of up to about 170 ms on mainnet.
#[derive(Default)]
struct Live {
    /// Fee, outputs summed and weight, when the tracker has the transaction.
    tx: Option<(u64, u64, u64)>,
    /// Its projected block.
    block: Option<u8>,
    /// Every projected block's bands and virtual size; empty when the engine is off.
    projected: Vec<([u64; 12], u64)>,
}

async fn live(ctx: &Arc<NetworkContext>, txid: Option<Txid>) -> Live {
    let ctx = Arc::clone(ctx);
    tokio::task::spawn_blocking(move || {
        let Some((tracker, projector)) = ctx.track.engines() else {
            return Live::default();
        };
        let tx = txid.and_then(|t| {
            tracker.read(|m| {
                m.get(&t)
                    .map(|i| (i.fee.to_sat(), i.value.to_sat(), u64::from(i.weight)))
            })
        });
        let block = txid
            .filter(|_| tx.is_some())
            .and_then(|t| projector.position(&t))
            .map(|p| p.placed.block);
        let projected = projector
            .current()
            .blocks
            .iter()
            .map(|b| (b.summary.bands, b.summary.vsize))
            .collect();
        Live {
            tx,
            block,
            projected,
        }
    })
    .await
    .unwrap_or_default()
}

/// The fields of Esplora's transaction a card reads.
#[derive(serde::Deserialize)]
struct NodeTx {
    fee: Option<u64>,
    weight: Option<u64>,
    vout: Vec<NodeOut>,
    status: NodeStatus,
}

#[derive(serde::Deserialize)]
struct NodeOut {
    value: u64,
}

#[derive(serde::Deserialize)]
struct NodeStatus {
    confirmed: bool,
    block_height: Option<u32>,
    block_time: Option<u64>,
}

async fn build_tx(ctx: &Arc<NetworkContext>, txid: Txid) -> Option<(Card, bool)> {
    let live = live(ctx, Some(txid)).await;
    let (tx, height) = match live.tx {
        Some((fee, amount, weight)) => (
            card::Tx {
                id: id(txid),
                amount,
                fee,
                weight,
                state: TxState::Unconfirmed { drawn: unix_now() },
            },
            None,
        ),
        None => {
            let (t, _) = esplora::json::<NodeTx>(ctx, Route::Tx(txid)).await.ok()?;
            let amount = t.vout.iter().fold(0u64, |s, o| s.saturating_add(o.value));
            let (state, height) = match (t.status.confirmed, t.status.block_height) {
                (true, Some(h)) => (
                    TxState::Confirmed {
                        time: t.status.block_time.unwrap_or(0),
                    },
                    Some(h),
                ),
                _ => (TxState::Unconfirmed { drawn: unix_now() }, None),
            };
            (
                card::Tx {
                    id: id(txid),
                    amount,
                    fee: t.fee.unwrap_or(0),
                    weight: t.weight.unwrap_or(0),
                    state,
                },
                height,
            )
        }
    };
    let tip = tip(ctx, height);
    let (strip, settled) = strip(ctx, &live, tip, height).await?;
    let card = Card {
        network: network(ctx.config.network),
        subject: Subject::Tx(tx),
        strip,
    };
    Some((card, settled))
}

async fn build_block(ctx: &Arc<NetworkContext>, id: BlockId) -> Option<(Card, bool)> {
    let store = &ctx.blocks.as_ref()?.store;
    let row = match id {
        BlockId::Height(h) => engine::blocks::by_height(store, h).await,
        BlockId::Hash(h) => engine::blocks::by_hash(store, h).await,
    }
    .ok()
    .flatten()?;
    let tip = tip(ctx, Some(row.height));
    let live = if tip.saturating_sub(row.height) < BESIDE_PROJECTED - CUT {
        live(ctx, None).await
    } else {
        Live::default()
    };
    let (strip, settled) = strip(ctx, &live, tip, Some(row.height)).await?;
    let settled = settled && row.rates.is_some();
    let block = card::Block {
        id: id_of(&row),
        height: row.height,
        time: row.time,
        miner: Miner::of(&row.coinbase).name,
        tx_count: row.tx_count,
        median: row.rates.and_then(|r| r.fee_rate).map(|r| r.median),
        fees: row.fees,
    };
    let card = Card {
        network: network(ctx.config.network),
        subject: Subject::Block(block),
        strip,
    };
    Some((card, settled))
}

fn id_of(row: &Row) -> card::Id {
    id(row.hash)
}

/// The chain's tip as the node last announced it, never below the subject's own height.
fn tip(ctx: &NetworkContext, height: Option<u32>) -> u32 {
    let announced = ctx.electrum.tip().map(|t| t.height);
    match (announced, height) {
        (Some(t), Some(h)) => t.max(h),
        (Some(t), None) => t,
        (None, h) => h.unwrap_or(0),
    }
}

/// The strip ([`plan`]) with its blocks' layers, and whether the card is settled: its block
/// buried, so the strip can no longer change, and every block in it rated. `None` when the
/// strip cannot be drawn ([`drawable`]).
async fn strip(
    ctx: &NetworkContext,
    live: &Live,
    tip: u32,
    height: Option<u32>,
) -> Option<(Strip, bool)> {
    let plan = plan(tip, height, !live.projected.is_empty(), live.block);
    let rows = mined(ctx, plan.top, plan.count).await;
    let mut tiles: Vec<Tile> = plan
        .slots
        .iter()
        .map(|&slot| Tile::Projected {
            slot,
            layers: live
                .projected
                .get(usize::from(slot))
                .map(|(bands, vsize)| Layers::new(bands, *vsize as f64 / 1e6)),
        })
        .collect();
    for h in plan.heights() {
        let layers = rows.get(&h).and_then(|r| {
            r.rates
                .map(|rated| Layers::new(&rated.fee_bands.list(), r.weight as f64 / 4e6))
        });
        tiles.push(Tile::Mined { height: h, layers });
    }
    let ring = match height {
        Some(h) => tiles
            .iter()
            .position(|t| matches!(t, Tile::Mined { height, .. } if *height == h)),
        None => plan.ring,
    };
    if !drawable(plan.now, &tiles) {
        return None;
    }
    // Buried, and every block drawn whole.
    let settled = height.is_some_and(|h| tip.saturating_sub(h) >= BURIED) && rated(&tiles);
    let strip = Strip {
        tiles,
        now: plan.now,
        ring,
        marker: ring.is_some(),
    };
    Some((strip, settled))
}

/// Whether every tile is a mined block with its fee rates.
fn rated(tiles: &[Tile]) -> bool {
    tiles.iter().all(|t| {
        matches!(
            t,
            Tile::Mined {
                layers: Some(_),
                ..
            }
        )
    })
}

/// Whether a strip is worth drawing. Away from the tip (no tip's line), a block without fee
/// rates is older than the rates the table keeps, or still waits for the backfill: it would be
/// an empty tile for good, so the card gives way to the site's picture. At the tip a new block
/// lacks its rates only for a moment, and the card is drawn again within the minute.
fn drawable(now: bool, tiles: &[Tile]) -> bool {
    now || rated(tiles)
}

/// Which blocks a strip shows.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    /// The projected blocks, left to right; none without a projection or away from the tip.
    slots: Vec<u8>,
    /// The ringed projected tile, for an unconfirmed transaction.
    ring: Option<usize>,
    /// The newest mined block shown, and how many down from it.
    top: u32,
    count: u32,
    /// The tip's line before the first mined tile.
    now: bool,
}

impl Plan {
    fn heights(&self) -> impl Iterator<Item = u32> {
        (self.top.saturating_sub(self.count - 1)..=self.top).rev()
    }
}

/// The strip's blocks for a subject at `height` (`None`: unconfirmed) on a chain whose tip is
/// `tip`, with or without a projection, the transaction in projected block `waits_in`.
///
/// - Near the tip (unconfirmed, or among the newest four blocks) with a projection: three
///   projected blocks, the tip's line, [`BESIDE_PROJECTED`] mined.
/// - Without projected blocks (no projection, or a block further down): the newest
///   [`MINED_ALONE`] after the tip's line while the subject is among the first seven, else the
///   subject with three newer and four older neighbours and no line.
/// - The subject is never in a strip's last tile, which the card's edge cuts ([`CUT`]).
/// - An unconfirmed transaction is ringed in its projected block. Past the first three, its own
///   block takes the third tile, labelled with its wait. Without a projection, no ring.
fn plan(tip: u32, height: Option<u32>, projection: bool, waits_in: Option<u8>) -> Plan {
    let near = height.is_none_or(|h| tip.saturating_sub(h) < BESIDE_PROJECTED - CUT);
    if near && projection {
        let mut slots: Vec<u8> = (0..PROJECTED as u8).collect();
        let mut ring = None;
        if let (None, Some(b)) = (height, waits_in) {
            if usize::from(b) >= PROJECTED
                && let Some(last) = slots.last_mut()
            {
                *last = b;
            }
            ring = slots.iter().position(|s| *s == b);
        }
        return Plan {
            slots,
            ring,
            top: tip,
            count: BESIDE_PROJECTED,
            now: true,
        };
    }
    let (top, now) = match height {
        Some(h) if tip.saturating_sub(h) >= MINED_ALONE - CUT => {
            (h.saturating_add(3).min(tip), false)
        }
        _ => (tip, true),
    };
    Plan {
        slots: Vec::new(),
        ring: None,
        top,
        count: MINED_ALONE,
        now,
    }
}

/// The block table's rows from `top` down, `count` of them, by height; empty without a table.
async fn mined(ctx: &NetworkContext, top: u32, count: u32) -> HashMap<u32, Row> {
    let Some(table) = &ctx.blocks else {
        return HashMap::new();
    };
    engine::blocks::page(&table.store, Some(top.saturating_add(1)), count)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.height.saturating_add(count) > top)
        .map(|r| (r.height, r))
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_strip_shows_the_tip_or_the_subjects_neighbours() {
        let tip = 976_200;
        let heights = |p: &Plan| p.heights().collect::<Vec<_>>();
        // A block at the tip, the engine on: three projected, the line, the newest five.
        let p = plan(tip, Some(tip), true, None);
        assert_eq!(
            (p.slots.clone(), p.ring, p.now),
            (vec![0, 1, 2], None, true)
        );
        assert_eq!(heights(&p), (976_196..=tip).rev().collect::<Vec<_>>());
        // Three down is still near; four is not, as the fifth tile is cut by the card's edge.
        assert_eq!(plan(tip, Some(tip - 3), true, None).slots.len(), 3);
        let p = plan(tip, Some(tip - 4), true, None);
        assert!(p.slots.is_empty() && p.now);
        assert_eq!(heights(&p), (976_193..=tip).rev().collect::<Vec<_>>());
        // Six down is the last among the newest eight; seven down has its neighbours.
        let p = plan(tip, Some(tip - 6), true, None);
        assert!(p.now && p.top == tip);
        let p = plan(tip, Some(tip - 7), false, None);
        assert!(!p.now);
        assert_eq!(heights(&p), (976_189..=976_196).rev().collect::<Vec<_>>());
        // Buried: three newer, it, four older, and no line.
        let p = plan(tip, Some(900_000), true, None);
        assert!(p.slots.is_empty() && !p.now);
        assert_eq!(heights(&p), (899_996..=900_003).rev().collect::<Vec<_>>());
        // The engine off: never projected blocks, the newest eight at the tip.
        let p = plan(tip, Some(tip), false, None);
        assert!(p.slots.is_empty() && p.now && p.top == tip && p.count == 8);
    }

    #[test]
    fn the_subject_is_never_in_the_tile_the_cards_edge_cuts() {
        let tip = 976_200;
        for projection in [true, false] {
            for depth in 0..=30 {
                let p = plan(tip, Some(tip - depth), projection, None);
                let at = p.heights().position(|h| h == tip - depth);
                assert!(
                    at.is_some_and(|at| at + 1 < p.heights().count()),
                    "{depth} deep, projection {projection}: tile {at:?} of {}",
                    p.count
                );
            }
        }
    }

    #[test]
    fn away_from_the_tip_a_block_without_fee_rates_gives_way_to_the_sites_picture() {
        let layers = || Layers::new(&[1; 12], 1.0);
        let tile = |height, rated: bool| Tile::Mined {
            height,
            layers: rated.then(layers),
        };
        let whole: Vec<Tile> = (0..8).map(|h| tile(h, true)).collect();
        let gap: Vec<Tile> = (0..8).map(|h| tile(h, h != 7)).collect();
        // Every block rated: drawn, wherever it is.
        assert!(drawable(false, &whole) && drawable(true, &whole));
        // One block without rates: no card away from the tip, an empty tile for now at it.
        assert!(!drawable(false, &gap));
        assert!(drawable(true, &gap));
        // Projected blocks are only ever drawn at the tip.
        let projected = [Tile::Projected {
            slot: 0,
            layers: None,
        }];
        assert!(drawable(true, &projected) && !rated(&projected));
    }

    #[test]
    fn an_unconfirmed_transaction_is_ringed_where_it_waits() {
        let tip = 976_200;
        assert_eq!(plan(tip, None, true, Some(0)).ring, Some(0));
        assert_eq!(plan(tip, None, true, Some(2)).ring, Some(2));
        // Past the first three: its own block in the third tile.
        let p = plan(tip, None, true, Some(6));
        assert_eq!((p.slots, p.ring), (vec![0, 1, 6], Some(2)));
        // Not placed yet, or no projection: no ring.
        assert_eq!(plan(tip, None, true, None).ring, None);
        let p = plan(tip, None, false, Some(0));
        assert_eq!((p.ring, p.slots.len(), p.now), (None, 0, true));
    }

    #[test]
    fn a_young_chain_has_no_heights_below_zero() {
        let p = plan(2, Some(1), false, None);
        assert_eq!(p.heights().collect::<Vec<_>>(), vec![2, 1, 0]);
        let p = plan(0, None, true, None);
        assert_eq!(p.heights().collect::<Vec<_>>(), vec![0]);
    }

    #[tokio::test]
    async fn a_build_every_request_left_leaves_nothing_behind_and_a_waiter_takes_over() {
        let cards = Cards::new(None);
        let key = |n: u32| Key::Block(Network::Mainnet, BlockId::Height(n));
        // Requests for distinct cards, each cancelled mid-build.
        for n in 0..5 {
            let never = std::future::pending::<Option<(Card, bool)>>();
            let r =
                tokio::time::timeout(Duration::from_millis(5), cards.serve(key(n), never)).await;
            assert!(r.is_err());
        }
        assert!(cards.building().is_empty());
        // Two for one card: the first cancelled, the second still waits on the same build, and
        // takes it over; then the map empties.
        let first = cards.serve(key(9), std::future::pending());
        let second = cards.serve(key(9), async { None });
        let (cancelled, answered) = tokio::join!(
            tokio::time::timeout(Duration::from_millis(5), first),
            second
        );
        assert!(cancelled.is_err());
        assert_eq!(answered.status(), axum::http::StatusCode::NOT_FOUND);
        assert!(cards.building().is_empty());
    }

    /// The order that left a shared `/api` call behind for good (#88): a request's handle on the
    /// build outlives its hold. Counted in the map, the build still goes with its last waiter.
    #[test]
    fn a_build_goes_with_its_last_waiter_though_a_handle_outlives_it() {
        let cards = Cards::new(None);
        let key = Key::Block(Network::Mainnet, BlockId::Height(1));
        let (a, b) = (Waiting::new(&cards, &key), Waiting::new(&cards, &key));
        let handle = Arc::clone(&a.flight);
        drop(a);
        assert_eq!(cards.building().len(), 1, "B still waits on it");
        drop(b);
        assert!(cards.building().is_empty());
        drop(handle);
    }

    #[test]
    fn kept_cards_expire_and_the_oldest_used_goes_first_past_the_bytes() {
        let mut k = Kept::default();
        let now = Instant::now();
        let key = |n: u32| Key::Block(Network::Mainnet, BlockId::Height(n));
        let png = |n: usize| Bytes::from(vec![0u8; n]);
        k.put(key(1), png(KEPT_BYTES / 2), LIVE, LIVE_HEADER, now);
        k.put(key(2), png(KEPT_BYTES / 2), LIVE, LIVE_HEADER, now);
        assert!(k.get(&key(1), now).is_some());
        // Over the bytes: 2 was used longest ago.
        k.put(key(3), png(10), LIVE, LIVE_HEADER, now);
        assert!(k.get(&key(2), now).is_none());
        assert!(k.get(&key(1), now).is_some() && k.get(&key(3), now).is_some());
        assert!(k.bytes <= KEPT_BYTES);
        // Expired.
        assert!(
            k.get(&key(3), now + LIVE + Duration::from_secs(1))
                .is_none()
        );
        assert_eq!(k.bytes, KEPT_BYTES / 2);
        // Larger than the whole cache: not kept.
        k.put(key(4), png(KEPT_BYTES + 1), LIVE, LIVE_HEADER, now);
        assert!(k.get(&key(4), now).is_none());
    }
}
