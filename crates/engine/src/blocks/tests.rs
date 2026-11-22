#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bitcoin::hashes::Hash;
use bitcoin::{
    Amount, BlockHash, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxMerkleNode, TxOut,
    Witness, absolute, transaction,
};
use node::rpc::model::BlockTotals;
use tokio::sync::watch;

use super::*;
use crate::store::{Options as StoreOptions, Store};

// Fixtures.

fn hash(branch: u8, height: u32) -> BlockHash {
    let mut b = [0u8; 32];
    b[0] = branch;
    b[1..5].copy_from_slice(&height.to_le_bytes());
    BlockHash::from_byte_array(b)
}

fn coinbase(tag: &[u8], outs: &[(u64, Vec<u8>)]) -> Transaction {
    Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::null(),
            script_sig: ScriptBuf::from_bytes(tag.to_vec()),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: outs
            .iter()
            .map(|(v, s)| TxOut {
                value: Amount::from_sat(*v),
                script_pubkey: ScriptBuf::from_bytes(s.clone()),
            })
            .collect(),
    }
}

/// A chain's block: `branch` tells apart blocks at one height on different branches.
fn header(branch: u8, height: u32, prev_branch: u8) -> Header {
    Header {
        id: hash(branch, height),
        height,
        version: 4,
        timestamp: 1_700_000_000 + u64::from(height) * 600,
        tx_count: 1 + height % 50,
        size: 1000 + u64::from(height),
        weight: 4000 + u64::from(height),
        merkle_root: TxMerkleNode::all_zeros(),
        previousblockhash: height.checked_sub(1).map(|p| hash(prev_branch, p)),
        mediantime: 0,
        nonce: 0,
        bits: 0,
        difficulty: f64::from(height) + 0.5,
    }
}

fn mock_row(h: &Header) -> Row {
    let totals = BlockTotals {
        totalfee: Amount::from_sat(u64::from(h.height) * 10),
        subsidy: Amount::from_sat(5_000_000_000),
        total_weight: 3000,
    };
    let tag = format!("/pool {}/", h.id.as_byte_array()[0]).into_bytes();
    let tx = coinbase(
        &tag,
        &[(5_000_000_000 + u64::from(h.height) * 10, vec![0x51; 22])],
    );
    Row::new(h, &totals, &tx)
}

fn mock_facts(height: u32, hash: BlockHash) -> Facts {
    let r = f64::from(height) / 10.0;
    Facts {
        id: hash,
        height,
        tx_count: 1 + height as usize % 50,
        fees: u64::from(height) * 10,
        vsize: 10 * u64::from(height),
        weight: 3000,
        fee_rate: Some(Rates {
            min: r,
            p10: r,
            p25: r,
            median: r,
            p75: r,
            p90: r,
            max: r,
        }),
        fee_bands: crate::projected::Bands::new([u64::from(height); 12]),
        miner: Miner::UNKNOWN,
        sv2: false,
    }
}

/// A node with one best chain that tests can rewrite, counting calls and calls in flight.
#[derive(Default)]
struct Mock {
    chain: Mutex<Vec<Header>>,
    /// Fail this many calls with `Busy`.
    busy: AtomicUsize,
    delay: Duration,
    calls: AtomicUsize,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    /// Every height `rows` was asked for, in order.
    asked: Mutex<Vec<u32>>,
    facts_asked: Mutex<Vec<u32>>,
    /// When each call started, for back-off timing.
    starts: Mutex<Vec<tokio::time::Instant>>,
    /// Before the `headers` call with this number (counting from 1), rewrite the chain as
    /// `set_chain` would: the tip moving mid-read.
    switch: Mutex<Option<(usize, u32, u32, u8)>>,
    headers_calls: AtomicUsize,
    /// Counted as a reorg write in every `rows` call: follow replacing rows meanwhile.
    bump: Mutex<Option<Reorgs>>,
    pruneheight: Mutex<Option<u32>>,
    prune_before_rows: Mutex<Option<u32>>,
    prune_before_facts: Mutex<Option<u32>>,
    /// One entry per call, oldest first: the error that call fails with, if any.
    row_failures: Mutex<VecDeque<Option<Error>>>,
    state_failures: Mutex<VecDeque<Option<SourceError>>>,
}

impl Mock {
    fn new(len: u32) -> Arc<Self> {
        let m = Arc::new(Self::default());
        m.set_chain(0, len, 0);
        m
    }

    /// Keeps heights below `from` and puts blocks of `branch` from `from` up to `len - 1`.
    fn set_chain(&self, from: u32, len: u32, branch: u8) {
        let mut chain = self.chain.lock().unwrap();
        chain.truncate(from as usize);
        for h in from..len {
            let prev = chain
                .last()
                .map_or(branch, |p: &Header| p.id.as_byte_array()[0]);
            chain.push(header(branch, h, prev));
        }
    }

    fn block(&self, height: u32) -> Header {
        self.chain.lock().unwrap()[height as usize].clone()
    }

    fn prune_before_read(&self, pending: &Mutex<Option<u32>>) -> Option<u32> {
        let mut pruned = self.pruneheight.lock().unwrap();
        if let Some(height) = pending.lock().unwrap().take() {
            *pruned = Some(height);
        }
        *pruned
    }

    async fn enter(&self) -> Result<Guard<'_>, SourceError> {
        self.starts
            .lock()
            .unwrap()
            .push(tokio::time::Instant::now());
        self.calls.fetch_add(1, Ordering::SeqCst);
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(now, Ordering::SeqCst);
        let guard = Guard(&self.in_flight);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        if self
            .busy
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |b| b.checked_sub(1))
            .is_ok()
        {
            return Err(SourceError::Busy);
        }
        Ok(guard)
    }
}

struct Guard<'a>(&'a AtomicUsize);

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Source for Arc<Mock> {
    async fn chain_state(&self) -> Result<(u32, Option<u32>), SourceError> {
        let _g = self.enter().await?;
        if let Some(error) = self.state_failures.lock().unwrap().pop_front().flatten() {
            return Err(error);
        }
        let tip = self.chain.lock().unwrap().len() as u32 - 1;
        Ok((tip, *self.pruneheight.lock().unwrap()))
    }

    async fn headers(&self, top: Option<u32>) -> Result<Vec<Header>, SourceError> {
        let _g = self.enter().await?;
        let n = self.headers_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let switch = *self.switch.lock().unwrap();
        if let Some((at, from, len, branch)) = switch
            && at == n
        {
            self.set_chain(from, len, branch);
        }
        let chain = self.chain.lock().unwrap();
        let tip = chain.len() as u32 - 1;
        let top = top.map_or(tip, |t| t.min(tip));
        Ok((top.saturating_sub(9)..=top)
            .rev()
            .map(|h| chain[h as usize].clone())
            .collect())
    }

    async fn rows(&self, headers: &[Header]) -> Result<Vec<Row>, Error> {
        let _g = self.enter().await?;
        assert!(headers.len() <= backfill::BATCH, "a batch the node refuses");
        if let Some(r) = &*self.bump.lock().unwrap() {
            r.bump();
        }
        self.asked
            .lock()
            .unwrap()
            .extend(headers.iter().map(|h| h.height));
        let pruned = self.prune_before_read(&self.prune_before_rows);
        if let Some(error) = self.row_failures.lock().unwrap().pop_front().flatten() {
            return Err(error);
        }
        if let Some(pruned) = pruned
            && let Some(header) = headers.iter().find(|h| h.height <= pruned)
        {
            return Err(Error::Pruned(header.height));
        }
        Ok(headers.iter().map(mock_row).collect())
    }

    async fn facts(&self, height: u32, hash: BlockHash) -> Result<Option<Facts>, Error> {
        let _g = self.enter().await?;
        let chain = self.chain.lock().unwrap();
        let Some(h) = chain.iter().find(|h| h.id == hash) else {
            return Ok(None);
        };
        assert_eq!(height, h.height);
        self.facts_asked.lock().unwrap().push(height);
        if self
            .prune_before_read(&self.prune_before_facts)
            .is_some_and(|pruned| height <= pruned)
        {
            return Err(Error::Pruned(height));
        }
        Ok(Some(mock_facts(h.height, hash)))
    }
}

/// A store in a fresh temporary directory, removed when dropped.
struct Temp {
    dir: PathBuf,
    store: Arc<Store>,
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp() -> Temp {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rbitcoin-space-blocks-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Arc::new(Store::open(&dir, "regtest", StoreOptions::default()).unwrap());
    Temp { dir, store }
}

async fn insert(store: &Store, rows: Vec<Row>) {
    store
        .write(move |sql| {
            let mut s = sql.prepare(db::REPLACE)?;
            for r in &rows {
                db::write_row(&mut s, r)?;
            }
            Ok(())
        })
        .await
        .unwrap();
}

/// Every row, oldest first.
async fn all(store: &Store) -> Vec<Row> {
    let mut out = Vec::new();
    let mut below = None;
    loop {
        let p = page(store, below, MAX_PAGE).await.unwrap();
        let Some(last) = p.last() else { break };
        below = Some(last.height);
        out.extend(p);
    }
    out.reverse();
    out
}

// Rows.

#[test]
fn a_row_keeps_bounded_coinbase_data_and_its_totals() {
    let long_tag = vec![0xab; 150];
    let outs = vec![
        (0, vec![0x6a, 0x24]),       // witness commitment: no value, not a payout
        (1000, vec![0x51; 200]),     // too long to be an address
        (2000, vec![0x00, 0x14, 1]), // kept
    ];
    let mut outs = outs;
    for i in 0..10 {
        outs.push((10 + i, vec![0x76, i as u8]));
    }
    let tx = coinbase(&long_tag, &outs);
    let h = header(0, 5, 0);
    let totals = BlockTotals {
        totalfee: Amount::from_sat(77),
        subsidy: Amount::from_sat(50),
        total_weight: 1234,
    };
    let row = Row::new(&h, &totals, &tx);
    assert_eq!(row.coinbase.tag, vec![0xab; MAX_TAG]);
    assert_eq!(row.coinbase.payouts.len(), MAX_PAYOUTS);
    assert_eq!(row.coinbase.payouts[0].as_bytes(), [0x00, 0x14, 1]);
    assert_eq!(row.reward, 1000 + 2000 + (10..20).sum::<u64>());
    assert_eq!((row.fees, row.subsidy, row.paying_weight), (77, 50, 1234));
    assert_eq!(
        (row.tx_count, row.size, row.weight),
        (h.tx_count, h.size, h.weight)
    );
    assert_eq!(row.facts(), None, "no facts before the rates are known");

    let encoded = row.coinbase.encode_payouts();
    assert_eq!(Coinbase::decode_payouts(&encoded), row.coinbase.payouts);
    // A truncated blob loses only its last entry, and never panics.
    assert_eq!(
        Coinbase::decode_payouts(&encoded[..encoded.len() - 1]).len(),
        MAX_PAYOUTS - 1
    );
    assert!(Coinbase::decode_payouts(&[200]).is_empty());
}

#[test]
fn a_rated_row_gives_the_facts_the_route_serves() {
    let h = header(0, 7, 0);
    let mut row = mock_row(&h);
    let f = mock_facts(7, h.id);
    row.rates = Some(Rated::from(&f));
    row.paying_weight = f.weight;
    let mut want = f;
    want.vsize = want.fee_bands.stored.iter().sum();
    want.tx_count = row.tx_count as usize;
    assert_eq!(row.facts(), Some(want));
    // The miner comes from the stored coinbase: a listed tag names its pool.
    row.coinbase.tag = b"\x03\x01\x02\x03/ViaBTC/".to_vec();
    let named = row.facts().unwrap();
    assert_eq!(named.miner.slug, "viabtc");
    assert!(!named.sv2);
    // So does the Stratum V2 mark: the stored tag is the whole script (mainnet 976,280's).
    row.coinbase.tag = ScriptBuf::from_hex(
        "0398e50e1a5376322f4d415241f09f87baf09f87b8f09f87baf09f87b82f2f\
         14020000140000000000000000000005cf0007c4fa",
    )
    .unwrap()
    .into_bytes();
    let marked = row.facts().unwrap();
    assert!(marked.sv2);
    assert_eq!(marked.miner.slug, "marapool");
}

// Reading.

#[tokio::test]
async fn rows_round_trip_and_read_by_height_hash_and_page() {
    let t = temp();
    let mut rows: Vec<Row> = (0..30).map(|h| mock_row(&header(0, h, 0))).collect();
    rows[3].rates = Some(Rated {
        fee_rate: None,
        fee_bands: crate::projected::Bands::default(),
    });
    rows[4].rates = Some(Rated::from(&mock_facts(4, rows[4].hash)));
    // As a block rated before the lowest band was split: its split reads back unknown.
    rows[5].rates = Some(Rated {
        fee_rate: None,
        fee_bands: crate::projected::Bands {
            stored: [5; 10],
            split: None,
        },
    });
    insert(&t.store, rows.clone()).await;
    let old = by_height(&t.store, 5).await.unwrap().unwrap();
    assert_eq!(old, rows[5]);
    let json = serde_json::to_value(old.facts().unwrap()).unwrap();
    assert_eq!(json["fee_bands"], serde_json::json!(vec![5; 10]));
    let json =
        serde_json::to_value(by_height(&t.store, 4).await.unwrap().unwrap().facts()).unwrap();
    assert_eq!(json["fee_bands"], serde_json::json!(vec![4; 12]));

    assert_eq!(
        by_height(&t.store, 4).await.unwrap().as_ref(),
        Some(&rows[4])
    );
    assert_eq!(
        by_height(&t.store, 3).await.unwrap().as_ref(),
        Some(&rows[3])
    );
    assert_eq!(by_height(&t.store, 30).await.unwrap(), None);
    assert_eq!(
        by_hash(&t.store, rows[9].hash).await.unwrap().as_ref(),
        Some(&rows[9])
    );
    let got = by_hashes(&t.store, vec![rows[2].hash, hash(9, 9), rows[1].hash])
        .await
        .unwrap();
    assert_eq!(
        got,
        vec![Some(rows[2].clone()), None, Some(rows[1].clone())]
    );

    let first = page(&t.store, None, 10).await.unwrap();
    assert_eq!(
        first.iter().map(|r| r.height).collect::<Vec<_>>(),
        (20..30).rev().collect::<Vec<_>>()
    );
    let next = page(&t.store, Some(20), 10).await.unwrap();
    assert_eq!(next[0].height, 19);
    assert_eq!(page(&t.store, Some(0), 10).await.unwrap(), vec![]);
    assert_eq!(
        page(&t.store, None, 5000).await.unwrap().len(),
        30,
        "capped, not refused"
    );

    let from = rows[5].time;
    let to = rows[8].time;
    assert_eq!(
        heights_between(&t.store, from, to).await.unwrap(),
        Some((5, 8))
    );
    assert_eq!(heights_between(&t.store, 0, 1).await.unwrap(), None);
}

#[tokio::test]
async fn periods_sum_and_average_per_day_and_per_n_blocks() {
    let t = temp();
    // 300 blocks, 600 s apart: 144 per day, starting mid-day.
    let mut rows: Vec<Row> = (0..300).map(|h| mock_row(&header(0, h, 0))).collect();
    for r in rows.iter_mut().filter(|r| r.height % 2 == 0) {
        r.rates = Some(Rated::from(&mock_facts(r.height, r.hash)));
    }
    insert(&t.store, rows.clone()).await;

    let by_100 = periods(&t.store, 0, 299, Period::Blocks(100))
        .await
        .unwrap();
    assert_eq!(by_100.len(), 3);
    let b = &by_100[1];
    let span = &rows[100..200];
    assert_eq!(
        (b.key, b.blocks, b.first_height, b.last_height),
        (1, 100, 100, 199)
    );
    assert_eq!(b.fees, span.iter().map(|r| r.fees).sum::<u64>());
    assert_eq!(b.reward, span.iter().map(|r| r.reward).sum::<u64>());
    assert_eq!(b.subsidy, 100 * 5_000_000_000);
    assert_eq!(
        b.tx_count,
        span.iter().map(|r| u64::from(r.tx_count)).sum::<u64>()
    );
    assert_eq!(b.size, span.iter().map(|r| r.size).sum::<u64>());
    assert_eq!((b.first_time, b.last_time), (span[0].time, span[99].time));
    assert_eq!(b.difficulty, 150.0);
    assert_eq!(b.rated, 50);
    // Only even heights are rated: their rates average to (100 + 198) / 2 / 10.
    assert!((b.fee_rate.unwrap().median - 14.9).abs() < 1e-9);

    let days = periods(&t.store, 0, 299, Period::Day).await.unwrap();
    assert_eq!(days.iter().map(|d| d.blocks).sum::<u32>(), 300);
    for d in &days {
        assert_eq!(d.first_time / 86_400, d.key as u64);
        assert_eq!(d.last_time / 86_400, d.key as u64);
    }
    assert!(days.windows(2).all(|w| w[0].key < w[1].key), "oldest first");
    let part = periods(&t.store, 10, 19, Period::Blocks(0)).await.unwrap();
    assert_eq!(part.len(), 10, "n is at least 1");
    assert!(
        periods(&t.store, 400, 500, Period::Day)
            .await
            .unwrap()
            .is_empty()
    );
}

// Following the tip.

#[tokio::test]
async fn follow_fills_the_zone_and_rates_the_newest() {
    let t = temp();
    let node = Mock::new(150);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!(
        (f.tip, f.written, f.stale, f.fork, f.rated),
        (149, 100, 0, None, 10)
    );
    let rows = all(&t.store).await;
    assert_eq!(rows.first().unwrap().height, 50);
    assert_eq!(rows.len(), 100);
    assert!(rows.iter().all(|r| r.rates.is_some() == (r.height >= 140)));
    assert_eq!(rows.last().unwrap(), &{
        let mut r = mock_row(&node.block(149));
        r.rates = Some(Rated::from(&mock_facts(149, r.hash)));
        r
    });

    // Nothing new: nothing written, and no fee rates asked again.
    let asked = node.facts_asked.lock().unwrap().len();
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.written, f.stale, f.rated), (0, 0, 0));
    assert_eq!(node.facts_asked.lock().unwrap().len(), asked);

    // One new block.
    node.set_chain(150, 151, 0);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.tip, f.written, f.rated), (150, 1, 1));
}

#[tokio::test]
async fn a_reorg_replaces_the_rows_above_the_fork_once() {
    let t = temp();
    let node = Mock::new(150);
    follow(&t.store, &node, &Reorgs::default()).await.unwrap();

    // Blocks 141..149 are replaced by a longer branch up to 152.
    node.set_chain(141, 153, 1);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.tip, f.stale, f.fork, f.written), (152, 9, Some(140), 12));
    let rows = all(&t.store).await;
    let chain = node.chain.lock().unwrap().clone();
    for r in &rows {
        assert_eq!(
            r.hash, chain[r.height as usize].id,
            "row {} is stale",
            r.height
        );
    }
    let heights: Vec<u32> = rows.iter().map(|r| r.height).collect();
    assert_eq!(
        heights,
        (50..=152).collect::<Vec<_>>(),
        "no gaps, no duplicates"
    );
    assert!(
        rows.iter()
            .filter(|r| r.height > 142)
            .all(|r| r.rates.is_some())
    );

    // A shorter branch: the rows above its tip go.
    node.set_chain(145, 147, 2);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.tip, f.fork), (146, Some(144)));
    assert_eq!(f.stale, 8, "two replaced, six removed");
    let rows = all(&t.store).await;
    assert_eq!(rows.last().unwrap().height, 146);
    assert_eq!(rows.last().unwrap().hash, hash(2, 146));
}

#[tokio::test]
async fn a_reorg_deeper_than_the_zone_is_walked_to_its_fork() {
    let t = temp();
    let node = Mock::new(400);
    // Rows for the whole chain, as after a backfill.
    let rows: Vec<Row> = (0..400).map(|h| mock_row(&node.block(h))).collect();
    insert(&t.store, rows).await;

    node.set_chain(150, 400, 3);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.stale, f.fork), (250, Some(149)));
    let chain = node.chain.lock().unwrap().clone();
    for r in all(&t.store).await {
        assert_eq!(r.hash, chain[r.height as usize].id);
    }
}

#[tokio::test]
async fn a_reorg_below_the_zone_is_found_across_missing_heights() {
    let t = temp();
    let node = Mock::new(400);
    insert(
        &t.store,
        (0..400).map(|h| mock_row(&node.block(h))).collect(),
    )
    .await;
    // While the server was down: blocks from 390 replaced, the tip now 550.
    node.set_chain(390, 551, 4);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.tip, f.stale, f.fork), (550, 10, Some(389)));
    let chain = node.chain.lock().unwrap().clone();
    let rows = all(&t.store).await;
    for r in &rows {
        assert_eq!(
            r.hash, chain[r.height as usize].id,
            "row {} is stale",
            r.height
        );
    }
    // 400..450 are left to the backfill.
    assert_eq!(rows.len(), 400 + 100);
    // Nothing stale now: the next call stops at the first stored row below the zone.
    let calls = node.calls.load(Ordering::SeqCst);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.stale, f.written), (0, 0));
    assert_eq!(
        node.calls.load(Ordering::SeqCst) - calls,
        12,
        "ten zone pages, one below, and the tip again"
    );
}

#[tokio::test]
async fn a_reorg_of_any_depth_is_repaired_in_one_call() {
    let t = temp();
    let node = Mock::new(3000);
    insert(
        &t.store,
        (0..3000).map(|h| mock_row(&node.block(h))).collect(),
    )
    .await;
    node.set_chain(100, 3000, 6);
    let f = follow(&t.store, &node, &Reorgs::default()).await.unwrap();
    assert_eq!((f.stale, f.fork), (2900, Some(99)));
    let chain = node.chain.lock().unwrap().clone();
    for r in all(&t.store).await {
        assert_eq!(r.hash, chain[r.height as usize].id);
    }
}

#[tokio::test]
async fn a_chain_that_moves_mid_read_writes_nothing() {
    let t = temp();
    let node = Mock::new(400);
    let rows: Vec<Row> = (0..400).map(|h| mock_row(&node.block(h))).collect();
    insert(&t.store, rows.clone()).await;
    node.set_chain(390, 400, 7);
    // The first page below the zone is read from another chain, which forked at 150.
    *node.switch.lock().unwrap() = Some((11, 150, 400, 8));
    let reorgs = Reorgs::default();
    assert!(matches!(
        follow(&t.store, &node, &reorgs).await,
        Err(Error::Moved)
    ));
    assert_eq!(all(&t.store).await, rows, "nothing written");
    assert_eq!(reorgs.seen(), 0);
    let f = follow(&t.store, &node, &reorgs).await.unwrap();
    assert_eq!((f.stale, f.fork), (250, Some(149)));
    assert_eq!(reorgs.seen(), 1);
}

#[tokio::test]
async fn a_backfill_batch_read_before_a_reorg_write_is_dropped() {
    let t = temp();
    let node = Mock::new(400);
    let reorgs = Reorgs::default();
    *node.bump.lock().unwrap() = Some(reorgs.clone());
    let step = backfill::totals_step(&t.store, &node, 0, 299, &reorgs)
        .await
        .unwrap();
    assert_eq!(step, (Some(299), 0), "the same heights again next step");
    assert!(all(&t.store).await.is_empty());
    *node.bump.lock().unwrap() = None;
    let step = backfill::totals_step(&t.store, &node, 0, 299, &reorgs)
        .await
        .unwrap();
    assert_eq!(step, (Some(249), 50));
}

#[tokio::test]
async fn a_backfill_batch_never_lands_above_stale_rows() {
    let t = temp();
    let node = Mock::new(400);
    insert(
        &t.store,
        (0..400).map(|h| mock_row(&node.block(h))).collect(),
    )
    .await;
    // A reorg from 390 that follow has not seen yet; the backfill reads the new chain.
    node.set_chain(390, 552, 9);
    let reorgs = Reorgs::default();
    let mut cursor = Some(450);
    let mut steps = 0;
    while let Some(c) = cursor {
        cursor = backfill::totals_step(&t.store, &node, 0, c, &reorgs)
            .await
            .unwrap()
            .0;
        steps += 1;
        assert!(steps < 100);
    }
    let chain = node.chain.lock().unwrap().clone();
    let rows = all(&t.store).await;
    assert_eq!(rows.len(), 451);
    for r in &rows {
        assert_eq!(
            r.hash, chain[r.height as usize].id,
            "row {} is stale",
            r.height
        );
    }
}

#[tokio::test]
async fn a_backfill_batch_never_spans_stale_rows_between_gaps() {
    let t = temp();
    let node = Mock::new(651);
    let a = |r: std::ops::Range<u32>| r.map(|h| mock_row(&node.block(h))).collect::<Vec<_>>();
    insert(&t.store, [a(0..400), a(420..520), a(551..651)].concat()).await;
    node.set_chain(410, 652, 10);
    let reorgs = Reorgs::default();
    let mut cursor = Some(550);
    let mut steps = 0;
    while let Some(c) = cursor {
        cursor = backfill::totals_step(&t.store, &node, 0, c, &reorgs)
            .await
            .unwrap()
            .0;
        steps += 1;
        assert!(steps < 500);
    }
    let chain = node.chain.lock().unwrap().clone();
    for r in all(&t.store).await.iter().filter(|r| r.height <= 550) {
        assert_eq!(
            r.hash, chain[r.height as usize].id,
            "row {} is stale",
            r.height
        );
    }
}

// Backfill.

fn options(observer: Arc<dyn Fn(&Event) + Send + Sync>) -> Options {
    Options {
        busy_percent: 100,
        fee_rate_depth: 150,
        observer,
        reorgs: Reorgs::default(),
    }
}

fn start(
    store: &Arc<Store>,
    node: &Arc<Mock>,
    options: Options,
) -> (tokio::task::JoinHandle<()>, watch::Receiver<Progress>) {
    let (tx, rx) = watch::channel(Progress::default());
    let (store, node) = (store.clone(), node.clone());
    let task = tokio::spawn(async move { backfill(store, node, options, &tx).await });
    (task, rx)
}

async fn until_done(rx: &mut watch::Receiver<Progress>) -> Progress {
    rx.wait_for(|p| p.totals_done && p.rates_done && p.tip > 0)
        .await
        .unwrap()
        .clone()
}

#[tokio::test(start_paused = true)]
async fn backfill_fills_every_row_below_the_zone_and_rates_the_recent_ones() {
    let t = temp();
    let node = Mock::new(400);
    let (task, mut rx) = start(&t.store, &node, options(Arc::new(|_| {})));
    let p = until_done(&mut rx).await;
    task.abort();
    assert_eq!((p.tip, p.totals_written, p.rates_written), (399, 300, 51));
    let rows = all(&t.store).await;
    assert_eq!(
        rows.iter().map(|r| r.height).collect::<Vec<_>>(),
        (0..300).collect::<Vec<_>>()
    );
    for r in &rows {
        assert_eq!(r.rates.is_some(), r.height >= 249, "{}", r.height);
    }
    // Newest first: the first batch asked was the one just below the zone.
    assert_eq!(node.asked.lock().unwrap()[0], 299);
    assert_eq!(node.max_in_flight.load(Ordering::SeqCst), 1);
    // Rated newest first too.
    let facts = node.facts_asked.lock().unwrap().clone();
    assert!(facts.windows(2).all(|w| w[0] > w[1]));
}

#[tokio::test]
async fn pruned_backfill_clips_both_tiers_and_keeps_stored_rows() {
    let t = temp();
    let node = Mock::new(400);
    *node.pruneheight.lock().unwrap() = Some(280);
    let mut rated = mock_row(&node.block(279));
    rated.rates = Some(Rated::from(&mock_facts(rated.height, rated.hash)));
    let unrated = mock_row(&node.block(280));
    insert(&t.store, vec![rated.clone(), unrated.clone()]).await;

    let (task, mut rx) = start(&t.store, &node, options(no_backfill_failures()));
    let p = tokio::time::timeout(Duration::from_secs(5), until_done(&mut rx))
        .await
        .unwrap();
    task.abort();

    assert_eq!((p.totals_written, p.rates_written), (19, 19));
    let expected = (281..=299).rev().collect::<Vec<_>>();
    assert_eq!(*node.asked.lock().unwrap(), expected);
    assert_eq!(*node.facts_asked.lock().unwrap(), expected);
    let rows = all(&t.store).await;
    assert_eq!(rows[..2], [rated, unrated]);
    assert!(rows[2..].iter().all(|r| r.rates.is_some()));
}

fn no_backfill_failures() -> Arc<dyn Fn(&Event) + Send + Sync> {
    Arc::new(|event| {
        if let Event::Failed { tier, error, .. } = event {
            panic!("{tier}: {error}");
        }
    })
}

#[tokio::test]
async fn pruned_backfill_replans_a_totals_batch_after_the_watermark_advances() {
    let t = temp();
    let node = Mock::new(400);
    *node.pruneheight.lock().unwrap() = Some(260);
    *node.prune_before_rows.lock().unwrap() = Some(280);

    let (task, mut rx) = start(&t.store, &node, options(no_backfill_failures()));
    let p = tokio::time::timeout(Duration::from_secs(5), until_done(&mut rx))
        .await
        .unwrap();
    task.abort();

    assert_eq!((p.totals_written, p.rates_written), (19, 19));
    let expected = (261..=299)
        .rev()
        .chain((281..=299).rev())
        .collect::<Vec<_>>();
    assert_eq!(*node.asked.lock().unwrap(), expected);
}

#[tokio::test]
async fn pruned_backfill_replans_rates_after_the_watermark_advances() {
    let t = temp();
    let node = Mock::new(400);
    *node.pruneheight.lock().unwrap() = Some(299);
    *node.prune_before_facts.lock().unwrap() = Some(302);
    let original = (300..=302)
        .map(|h| mock_row(&node.block(h)))
        .collect::<Vec<_>>();
    insert(&t.store, original.clone()).await;

    let (task, mut rx) = start(&t.store, &node, options(no_backfill_failures()));
    let p = tokio::time::timeout(Duration::from_secs(5), until_done(&mut rx))
        .await
        .unwrap();
    task.abort();

    assert_eq!((p.totals_written, p.rates_written), (0, 0));
    assert_eq!(*node.facts_asked.lock().unwrap(), [302]);
    assert_eq!(all(&t.store).await, original);
}

#[tokio::test(start_paused = true)]
async fn pruned_backfill_reports_and_retries_errors_in_the_retained_range() {
    for error in [
        Error::from(SourceError::Failed("upstream request failed".into())),
        Error::Pruned(299),
    ] {
        let t = temp();
        let node = Mock::new(400);
        *node.pruneheight.lock().unwrap() = Some(280);
        *node.prune_before_rows.lock().unwrap() = Some(281);
        let message = error.to_string();
        *node.row_failures.lock().unwrap() = [Some(error)].into();
        let (observer, seen) = streak();
        let (task, mut rx) = start(&t.store, &node, options(observer));
        let p = until_done(&mut rx).await;
        task.abort();

        assert_eq!((p.totals_written, p.rates_written), (18, 18));
        assert_eq!(
            *seen.lock().unwrap(),
            [(Some("totals"), message, 1), (None, String::new(), 1)]
        );
    }
}

type Seen = Arc<Mutex<Vec<(Option<&'static str>, String, u32)>>>;
type Observer = Arc<dyn Fn(&Event) + Send + Sync>;

/// An observer recording each failure (tier, error, streak) and recovery (`None`, "", streak).
fn streak() -> (Observer, Seen) {
    let seen = Seen::default();
    let observer = Arc::new({
        let seen = seen.clone();
        move |e: &Event| match e {
            Event::Failed {
                tier,
                error,
                failures,
            } => seen
                .lock()
                .unwrap()
                .push((Some(*tier), error.to_string(), *failures)),
            Event::Recovered { failures } => {
                seen.lock().unwrap().push((None, String::new(), *failures));
            }
            Event::Progress { .. } => {}
        }
    });
    (observer, seen)
}

#[tokio::test(start_paused = true)]
async fn a_pruned_replan_keeps_the_failure_streak_until_a_narrowed_step_succeeds() {
    let t = temp();
    let node = Mock::new(400);
    *node.pruneheight.lock().unwrap() = Some(260);
    *node.prune_before_rows.lock().unwrap() = Some(280);
    let busy = || Some(Error::from(SourceError::Busy));
    // Busy, then pruned at 280 (confirmed: a replan), then busy again in the narrowed range.
    *node.row_failures.lock().unwrap() = [busy(), None, busy()].into();
    let (observer, seen) = streak();
    let (task, mut rx) = start(&t.store, &node, options(observer));
    let p = until_done(&mut rx).await;
    task.abort();

    assert_eq!((p.totals_written, p.rates_written), (19, 19));
    let (wide, narrow) = ((261..=299).rev(), (281..=299).rev());
    let asked = [wide.clone(), wide, narrow.clone(), narrow];
    let asked = asked.into_iter().flatten().collect::<Vec<_>>();
    assert_eq!(*node.asked.lock().unwrap(), asked);
    let busy = Error::from(SourceError::Busy).to_string();
    assert_eq!(
        *seen.lock().unwrap(),
        [
            (Some("totals"), busy.clone(), 1),
            (Some("totals"), busy, 2),
            (None, String::new(), 2),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_failed_prune_check_reports_its_own_error_and_keeps_the_cursor() {
    let t = temp();
    let node = Mock::new(400);
    *node.pruneheight.lock().unwrap() = Some(260);
    *node.prune_before_rows.lock().unwrap() = Some(280);
    let down = SourceError::Failed("status unavailable".into());
    // The start's check succeeds; the one after the pruned read fails.
    *node.state_failures.lock().unwrap() = [None, Some(down.clone())].into();
    let (observer, seen) = streak();
    let (task, mut rx) = start(&t.store, &node, options(observer));
    let p = until_done(&mut rx).await;
    task.abort();

    assert_eq!((p.totals_written, p.rates_written), (19, 19));
    let wide = (261..=299).rev();
    let asked = [wide.clone(), wide, (281..=299).rev()];
    let asked = asked.into_iter().flatten().collect::<Vec<_>>();
    assert_eq!(*node.asked.lock().unwrap(), asked);
    assert_eq!(
        *seen.lock().unwrap(),
        [
            (Some("tip"), Error::from(down).to_string(), 1),
            (None, String::new(), 1),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_lower_watermark_at_the_same_tip_reopens_both_tiers() {
    let t = temp();
    let node = Mock::new(400);
    *node.pruneheight.lock().unwrap() = Some(280);
    let mut rated = mock_row(&node.block(270));
    rated.rates = Some(Rated::from(&mock_facts(rated.height, rated.hash)));
    let below = mock_row(&node.block(240));
    insert(&t.store, vec![below.clone(), rated.clone()]).await;

    let (task, mut rx) = start(&t.store, &node, options(no_backfill_failures()));
    let p = until_done(&mut rx).await;
    assert_eq!((p.tip, p.totals_written, p.rates_written), (399, 19, 19));
    node.asked.lock().unwrap().clear();
    node.facts_asked.lock().unwrap().clear();
    *node.pruneheight.lock().unwrap() = Some(250);
    let p = rx
        .wait_for(|p| p.totals_written > 19 && p.totals_done && p.rates_done)
        .await
        .unwrap()
        .clone();
    task.abort();

    assert_eq!((p.tip, p.totals_written, p.rates_written), (399, 48, 48));
    let reopened = (271..=280)
        .rev()
        .chain((251..=269).rev())
        .collect::<Vec<_>>();
    assert_eq!(*node.asked.lock().unwrap(), reopened);
    assert_eq!(*node.facts_asked.lock().unwrap(), reopened);
    let rows = all(&t.store).await;
    assert_eq!(rows.len(), 50);
    assert_eq!(rows[0], below);
    assert_eq!(rows.iter().find(|r| r.height == 270), Some(&rated));
    assert!(rows[1..].iter().all(|r| r.rates.is_some()));
}

#[tokio::test(start_paused = true)]
async fn a_count_that_times_out_is_reported_as_not_counted() {
    let t = temp();
    *t.store.time_out.lock().unwrap() = Some(crate::store::Read::BlockCounts);
    let node = Mock::new(400);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let saw = seen.clone();
    let observer: Arc<dyn Fn(&Event) + Send + Sync> = Arc::new(move |e| {
        if let Event::Progress { progress, counted } = e {
            saw.lock().unwrap().push((*counted, progress.rows));
        }
    });
    let (task, mut rx) = start(&t.store, &node, options(observer));
    until_done(&mut rx).await;
    task.abort();
    let seen = seen.lock().unwrap().clone();
    // The line that marks the end was sent, without claiming a count it does not have.
    assert!(!seen.is_empty());
    assert!(seen.iter().all(|s| *s == (false, 0)), "{seen:?}");

    // Counting again: the next line carries the real numbers.
    *t.store.time_out.lock().unwrap() = None;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let saw = seen.clone();
    let observer: Arc<dyn Fn(&Event) + Send + Sync> = Arc::new(move |e| {
        if let Event::Progress { progress, counted } = e {
            saw.lock().unwrap().push((*counted, progress.rows));
        }
    });
    node.set_chain(400, 405, 0);
    let (task, mut rx) = start(&t.store, &node, options(observer));
    rx.wait_for(|p| p.rows > 0).await.unwrap();
    task.abort();
    assert!(seen.lock().unwrap().iter().any(|s| s.0 && s.1 >= 300));
}

#[tokio::test(start_paused = true)]
async fn an_interrupted_backfill_resumes_without_redoing_work() {
    let t = temp();
    let node = Mock::new(2000);
    let (task, mut rx) = start(&t.store, &node, options(Arc::new(|_| {})));
    rx.wait_for(|p| p.totals_written >= 500).await.unwrap();
    task.abort();
    let _ = task.await;
    let before: Vec<u32> = all(&t.store).await.iter().map(|r| r.height).collect();
    assert!(before.len() >= 500 && before.len() < 1900);
    let asked_before = node.asked.lock().unwrap().len();

    // As after a restart: a new task, with a new tip meanwhile.
    node.set_chain(2000, 2005, 0);
    let (task, mut rx) = start(&t.store, &node, options(Arc::new(|_| {})));
    until_done(&mut rx).await;
    task.abort();
    let asked_after = node.asked.lock().unwrap()[asked_before..].to_vec();
    for h in &asked_after {
        assert!(!before.contains(h), "height {h} was fetched again");
    }
    let rows = all(&t.store).await;
    assert_eq!(rows.len(), 1905);
}

#[tokio::test(start_paused = true)]
async fn a_busy_node_gets_a_growing_pause_and_a_quiet_one_a_gentle_pace() {
    let t = temp();
    let node = Arc::new(Mock {
        busy: AtomicUsize::new(4),
        delay: Duration::from_millis(100),
        ..Mock::default()
    });
    node.set_chain(0, 300, 0);
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let observer: Arc<dyn Fn(&Event) + Send + Sync> = Arc::new(move |e| {
        let label = match e {
            Event::Failed { failures, .. } => format!("failed {failures}"),
            Event::Recovered { failures } => format!("recovered {failures}"),
            Event::Progress { .. } => return,
        };
        seen.lock().unwrap().push(label);
    });
    let options = Options {
        busy_percent: 25,
        fee_rate_depth: 0,
        observer,
        reorgs: Reorgs::default(),
    };
    let (task, mut rx) = start(&t.store, &node, options);
    let p = until_done(&mut rx).await;
    task.abort();
    assert_eq!(
        *events.lock().unwrap(),
        [
            "failed 1",
            "failed 2",
            "failed 3",
            "failed 4",
            "recovered 4"
        ]
    );
    // The first five calls were refused or succeeded after 5, 10, 20 and 40 s of back-off.
    let starts = node.starts.lock().unwrap().clone();
    let gaps: Vec<u64> = starts
        .windows(2)
        .take(4)
        .map(|w| (w[1] - w[0]).as_secs())
        .collect();
    assert_eq!(gaps, [5, 10, 20, 40]);
    // At 25% the node is idle three times as long as it is busy.
    let span = *starts.last().unwrap() - starts[4];
    // The last step's own pause comes after the last call, so allow one step (six calls).
    assert!(
        span + Duration::from_millis(600) >= p.busy * 3,
        "{span:?} for {:?} busy",
        p.busy
    );
    assert_eq!(node.max_in_flight.load(Ordering::SeqCst), 1);
}

/// A table the size of mainnet's (975,000 rows, the last year rated) with realistic rows, then
/// the reads the charts and the block list make. Run with
/// `cargo test --release -p engine -- --ignored --nocapture read_benchmark`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a benchmark: about a minute in release"]
#[allow(clippy::print_stdout)]
async fn read_benchmark() {
    use std::time::Instant;
    const ROWS: u32 = 975_000;
    const YEAR: u32 = 52_560;
    let t = temp();
    let started = Instant::now();
    for chunk in (0..ROWS).collect::<Vec<_>>().chunks(10_000) {
        let rows: Vec<Row> = chunk
            .iter()
            .map(|&h| {
                // A 40 to 70 byte tag and two payouts, as today's coinbases mostly have.
                let tag: Vec<u8> = (0..40 + h % 31).map(|i| (h ^ i) as u8).collect();
                let pay = vec![
                    (
                        312_500_000,
                        vec![0x00, 0x14].into_iter().chain([h as u8; 20]).collect(),
                    ),
                    (1, vec![0xa9, 0x14].into_iter().chain([7; 21]).collect()),
                ];
                let tx = coinbase(&tag, &pay);
                let mut hd = header(0, h, 0);
                hd.timestamp = 1_231_006_505 + u64::from(h) * 600 + u64::from(h % 7) * 60;
                hd.tx_count = 1 + h % 5000;
                hd.size = 1_500_000 + u64::from(h % 100_000);
                hd.weight = 3_990_000 + u64::from(h % 9000);
                hd.difficulty = 1.3e14 * f64::from(h) / f64::from(ROWS);
                let totals = BlockTotals {
                    totalfee: Amount::from_sat(u64::from(h) * 37 % 9_000_000),
                    subsidy: Amount::from_sat(312_500_000),
                    total_weight: 3_989_000,
                };
                let mut row = Row::new(&hd, &totals, &tx);
                if h >= ROWS - YEAR {
                    row.rates = Some(Rated::from(&mock_facts(h, row.hash)));
                }
                row
            })
            .collect();
        t.store
            .write(move |sql| {
                let mut s = sql.prepare(db::INSERT_NEW)?;
                for r in &rows {
                    db::write_row(&mut s, r)?;
                }
                Ok(())
            })
            .await
            .unwrap();
    }
    let filled = started.elapsed();
    let size: u64 = std::fs::read_dir(&t.dir)
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    println!(
        "filled {ROWS} rows in {filled:?}: {:.0} MB, {:.0} bytes a row",
        size as f64 / 1e6,
        size as f64 / f64::from(ROWS)
    );

    let time = |label: &str, d: std::time::Duration| {
        println!("{label}: {:.2} ms", d.as_secs_f64() * 1000.0)
    };
    for _ in 0..3 {
        let s = Instant::now();
        let days = periods(&t.store, ROWS - YEAR, ROWS - 1, Period::Day)
            .await
            .unwrap();
        time(
            &format!("one-year daily aggregate ({} days)", days.len()),
            s.elapsed(),
        );
        let s = Instant::now();
        let all = periods(&t.store, 0, ROWS - 1, Period::Blocks(2016))
            .await
            .unwrap();
        time(
            &format!("all history per 2016 blocks ({} buckets)", all.len()),
            s.elapsed(),
        );
        let s = Instant::now();
        let p = page(&t.store, None, 15).await.unwrap();
        time(&format!("newest page of {}", p.len()), s.elapsed());
        let s = Instant::now();
        let p = page(&t.store, Some(400_000), 100).await.unwrap();
        time(
            &format!("a page of {} deep in history", p.len()),
            s.elapsed(),
        );
        let s = Instant::now();
        let r = by_hash(&t.store, hash(0, 123_456)).await.unwrap();
        assert!(r.is_some());
        time("one row by hash", s.elapsed());
        let s = Instant::now();
        let to = 1_231_006_505 + u64::from(ROWS) * 600;
        let range = heights_between(&t.store, to - 365 * 86_400, to)
            .await
            .unwrap();
        time(&format!("a year's heights by time {range:?}"), s.elapsed());
        let s = Instant::now();
        let c = t
            .store
            .read(crate::store::Read::BlockCounts, db::counts)
            .await
            .unwrap();
        time(&format!("row counts {c:?}"), s.elapsed());
    }
}

// The mining reads (`mining.rs`).

const FOUNDRY: u16 = 88;
const ANTPOOL: u16 = 61;

/// A block at `height` stamped `time`, mined with `tag`, at `difficulty`.
fn mined(height: u32, time: u64, tag: &[u8], difficulty: f64) -> Row {
    let mut hd = header(0, height, 0);
    hd.timestamp = time;
    hd.difficulty = difficulty;
    let totals = BlockTotals {
        totalfee: Amount::from_sat(1000 + u64::from(height)),
        subsidy: Amount::from_sat(312_500_000),
        total_weight: 3000,
    };
    Row::new(&hd, &totals, &coinbase(tag, &[(312_501_000, vec![0x51])]))
}

fn count(counts: &[PoolCount], pool: u16) -> u32 {
    counts
        .iter()
        .find(|c| c.pool == pool)
        .map_or(0, |c| c.blocks)
}

#[tokio::test]
async fn span_reaches_down_to_the_first_missing_height() {
    let t = temp();
    assert_eq!(span(&t.store).await.unwrap(), None);
    // More rows than one read of the walk takes, with holes at 3 and 12,000.
    let rows: Vec<Row> = (0..25_000)
        .filter(|h| *h != 3 && *h != 12_000)
        .map(|h| mined(h, 1_000 + u64::from(h) * 600, b"", 1.0))
        .collect();
    insert(&t.store, rows).await;
    let s = span(&t.store).await.unwrap().unwrap();
    assert_eq!((s.tip, s.from), (24_999, 12_001));
    assert_eq!(s.tip_hash, hash(0, 24_999));
    assert_eq!(
        (s.tip_time, s.from_time),
        (1_000 + 24_999 * 600, 1_000 + 12_001 * 600)
    );
    insert(&t.store, vec![mined(12_000, 1, b"", 1.0)]).await;
    assert_eq!(span(&t.store).await.unwrap().unwrap().from, 4);
    insert(&t.store, vec![mined(3, 1, b"", 1.0)]).await;
    assert_eq!(span(&t.store).await.unwrap().unwrap().from, 0);
    assert_eq!(row_counts(&t.store).await.unwrap(), (25_000, 0));
}

#[tokio::test]
async fn pools_are_attributed_on_write_and_redone_when_the_list_changes() {
    let t = temp();
    let tags: [&[u8]; 4] = [
        b"\x03\x01\x02Foundry USA Pool #x/",
        b"/AntPool/",
        b"\xff\xfejunk",
        b"",
    ];
    let rows = (0..8)
        .map(|h| mined(h, 1_000 + u64::from(h), tags[h as usize % 4], 1.0))
        .collect();
    insert(&t.store, rows).await;
    let counts = pool_counts(&t.store, 0, 7).await.unwrap();
    assert_eq!(
        counts
            .iter()
            .map(|c| (c.pool, c.blocks))
            .collect::<Vec<_>>(),
        [
            (crate::mining::pools::UNKNOWN, 4),
            (ANTPOOL, 2),
            (FOUNDRY, 2)
        ],
        "most blocks first, then by id"
    );
    // A fresh table is stamped with the list on its first pass; nothing else to do after.
    let pools = crate::mining::pools::list();
    assert_eq!(
        reattribute(&t.store, pools)
            .await
            .unwrap()
            .map(|r| r.changed),
        Some(0)
    );
    assert_eq!(reattribute(&t.store, pools).await.unwrap(), None);
    // Rows from before the pool column, or from another list, are redone.
    t.store
        .write(|sql| {
            sql.prepare("UPDATE blocks SET pool = 0")?.execute([])?;
            sql.prepare("UPDATE pool_list SET version = 'old'")?
                .execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        count(&pool_counts(&t.store, 0, 7).await.unwrap(), FOUNDRY),
        0
    );
    let r = reattribute(&t.store, pools).await.unwrap().unwrap();
    assert_eq!((r.rows, r.changed), (8, 4));
    assert_eq!(pool_counts(&t.store, 0, 7).await.unwrap(), counts);
    assert_eq!(reattribute(&t.store, pools).await.unwrap(), None);
    // Empty blocks and rewards are counted per pool.
    let c = pool_counts(&t.store, 0, 0).await.unwrap();
    assert_eq!(
        (c[0].empty, c[0].reward),
        (u32::from(header(0, 0, 0).tx_count == 1), 312_501_000)
    );
}

#[tokio::test]
async fn a_reorg_rewrites_pools_and_sums() {
    let t = temp();
    let rows = (0..10)
        .map(|h| mined(h, 1_000 + u64::from(h), b"Foundry USA Pool", 1.0))
        .collect();
    insert(&t.store, rows).await;
    assert_eq!(
        count(&pool_counts(&t.store, 0, 9).await.unwrap(), FOUNDRY),
        10
    );
    let before = periods(&t.store, 0, 9, Period::Blocks(5)).await.unwrap();
    // Heights 5 to 9 replaced by another branch, mined by AntPool with other fees.
    let branch: Vec<Row> = (5..10)
        .map(|h| {
            let mut r = mined(h, 1_000 + u64::from(h), b"/AntPool/", 1.0);
            r.hash = hash(1, h);
            r.fees += 1_000_000;
            r
        })
        .collect();
    insert(&t.store, branch).await;
    let counts = pool_counts(&t.store, 0, 9).await.unwrap();
    assert_eq!((count(&counts, FOUNDRY), count(&counts, ANTPOOL)), (5, 5));
    let after = periods(&t.store, 0, 9, Period::Blocks(5)).await.unwrap();
    assert_eq!(after[0], before[0]);
    assert_eq!(after[1].fees, before[1].fees + 5_000_000);
    let page = pool_page(&t.store, ANTPOOL, 0, 9, 10).await.unwrap();
    assert_eq!(
        page.iter().map(|r| r.height).collect::<Vec<_>>(),
        [8, 7, 6, 5]
    );
    assert_eq!(page[0].hash, hash(1, 8));
    assert!(pool_page(&t.store, ANTPOOL, 7, 9, 10).await.unwrap().len() == 2);
}

#[tokio::test]
async fn retargets_work_and_times() {
    let t = temp();
    // Three periods at difficulty 1, 2 and 3, a block every 600 s.
    let rows = (0..=4032)
        .map(|h| mined(h, 10_000 + u64::from(h) * 600, b"", f64::from(h / 2016 + 1)))
        .collect();
    insert(&t.store, rows).await;
    let r = retargets(&t.store, 0, 0, 4032).await.unwrap();
    assert_eq!(
        r.iter()
            .map(|r| (r.height, r.difficulty, r.previous))
            .collect::<Vec<_>>(),
        [(2016, 2.0, 1.0), (4032, 3.0, 2.0)]
    );
    assert_eq!(r[0].time, 10_000 + 2016 * 600);
    assert_eq!(retargets(&t.store, 0, 2017, 4031).await.unwrap(), []);
    // A retarget whose previous period is not stored is left out.
    t.store
        .write(|sql| {
            sql.prepare("DELETE FROM blocks WHERE height = 2016")?
                .execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(retargets(&t.store, 0, 0, 4032).await.unwrap().len(), 0);
    // Nor one whose previous period lies below the caller's floor.
    let r = retargets(&t.store, 2017, 2017, 4032).await.unwrap();
    assert!(
        r.is_empty(),
        "4032 is measured against 2016, below the floor"
    );

    // The work of heights 11..=20 over the time from 10 to 20.
    let w = work(&t.store, 10, 20).await.unwrap().unwrap();
    assert_eq!((w.blocks, w.difficulty_sum), (10, 10.0));
    assert_eq!(w.max_time - w.min_time, 6000);
    assert_eq!(work(&t.store, 10, 10).await.unwrap(), None);

    assert_eq!(at_or_before(&t.store, 0, 9_999).await.unwrap(), None);
    let b = at_or_before(&t.store, 0, 10_000 + 7 * 600 + 599)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((b.0, b.1, b.2), (7, hash(0, 7), 10_000 + 7 * 600));
    assert_eq!(
        at_or_before(&t.store, 0, u64::MAX)
            .await
            .unwrap()
            .unwrap()
            .0,
        4032
    );

    // Rows below the floor never answer, whatever their timestamps.
    insert(
        &t.store,
        vec![mined(5000, 10_000 + 7 * 600 + 300, b"", 1.0)],
    )
    .await;
    assert_eq!(
        at_or_before(&t.store, 0, 10_000 + 7 * 600 + 599)
            .await
            .unwrap()
            .unwrap()
            .0,
        5000
    );
    assert_eq!(
        at_or_before(&t.store, 10, 10_000 + 7 * 600 + 599)
            .await
            .unwrap()
            .unwrap()
            .0,
        5000
    );
    assert_eq!(
        at_or_before(&t.store, 5001, 10_000 + 7 * 600 + 599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        first_since(&t.store, 0, 10_000 + 7 * 600 + 1)
            .await
            .unwrap(),
        Some(8)
    );
    assert_eq!(
        first_since(&t.store, 4000, 10_000 + 7 * 600 + 1)
            .await
            .unwrap(),
        Some(4000)
    );
    assert_eq!(first_since(&t.store, 0, u64::MAX).await.unwrap(), None);
    t.store
        .write(|sql| {
            sql.prepare("DELETE FROM blocks WHERE height = 5000")?
                .execute([])?;
            Ok(())
        })
        .await
        .unwrap();

    // Weeks start on Monday: 1970-01-05 00:00 UTC is 345,600.
    let w = pool_weeks(&t.store, 0, 4032).await.unwrap();
    assert!(
        w.iter()
            .all(|(start, pool, _)| (start - WEEK_OFFSET).is_multiple_of(WEEK) && *pool == 0)
    );
    assert_eq!(w.iter().map(|x| x.2).sum::<u32>(), 4032);
}

/// Fills `$MINING_BENCH_DIR/regtest.sqlite` (a temporary directory otherwise) with 975,000
/// mainnet-like rows ending now, the last year rated, mined by the list's pools in a skewed
/// share, and times the mining reads and a full re-attribution. Run with
/// `MINING_BENCH_DIR=<dir> cargo test --release -p engine -- --ignored --nocapture mining_benchmark`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "fills a 300 MB table; a benchmark, not a test"]
#[allow(clippy::print_stdout)] // A benchmark's report.
async fn mining_benchmark() {
    use std::time::{Instant, SystemTime};
    const ROWS: u32 = 975_000;
    let (dir, store) = match std::env::var_os("MINING_BENCH_DIR") {
        Some(d) => {
            let d = PathBuf::from(d);
            let s = Arc::new(Store::open(&d, "regtest", StoreOptions::default()).unwrap());
            (None, s)
        }
        None => {
            let t = temp();
            let s = Arc::clone(&t.store);
            (Some(t), s)
        }
    };
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let started = Instant::now();
    fill_mainnet_like(&store, ROWS, now).await;
    println!(
        "filled {ROWS} rows, attributing each, in {:?}",
        started.elapsed()
    );
    let list = crate::mining::pools::list();
    let ms = |s: Instant| s.elapsed().as_secs_f64() * 1000.0;
    for _ in 0..3 {
        let s = Instant::now();
        let sp = span(&store).await.unwrap().unwrap();
        let t_span = ms(s);
        let s = Instant::now();
        let c = pool_counts(&store, 0, ROWS - 1).await.unwrap();
        let t_all = ms(s);
        let s = Instant::now();
        pool_counts(&store, ROWS - 1008, ROWS - 1).await.unwrap();
        let t_week = ms(s);
        let s = Instant::now();
        let w = pool_weeks(&store, 0, ROWS - 1).await.unwrap();
        let t_weeks = ms(s);
        let s = Instant::now();
        let d = periods(&store, 0, ROWS - 1, Period::Day).await.unwrap();
        let t_days = ms(s);
        let s = Instant::now();
        retargets(&store, 0, 0, ROWS - 1).await.unwrap();
        let t_ret = ms(s);
        let s = Instant::now();
        pool_page(&store, c[0].pool, 0, ROWS, 100).await.unwrap();
        let t_page = ms(s);
        println!(
            "span {t_span:.1} ms (from {}); pool counts: all {t_all:.1} ms ({} pools), a week \
             {t_week:.2} ms; pools by week, all {t_weeks:.1} ms ({} rows); days, all {t_days:.1} \
             ms ({}); retargets {t_ret:.2} ms; a pool's page {t_page:.2} ms",
            sp.from,
            c.len(),
            w.len(),
            d.len()
        );
    }
    store
        .write(|sql| {
            sql.prepare("UPDATE pool_list SET version = 'old'")?
                .execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    let s = Instant::now();
    let r = reattribute(&store, list).await.unwrap().unwrap();
    println!(
        "re-attributed {} rows ({} changed) in {:.0} ms",
        r.rows,
        r.changed,
        ms(s)
    );
    drop(dir);
}

/// Writes `rows` mainnet-like rows ending at `now`, the last year rated, mined by the list's
/// pools in a skewed share, in writes of 10,000.
async fn fill_mainnet_like(store: &Store, rows: u32, now: u64) {
    const YEAR: u32 = 52_560;
    let list = crate::mining::pools::list();
    // Twenty pools by their first tag, the first taking the most blocks; every 50th unknown.
    let tags: Vec<Vec<u8>> = list.all()[1..]
        .iter()
        .filter_map(|p| p.tags.first())
        .take(20)
        .map(|t| t.as_bytes().to_vec())
        .collect();
    for chunk in (0..rows).collect::<Vec<_>>().chunks(10_000) {
        let tags = tags.clone();
        let batch: Vec<Row> = chunk
            .iter()
            .map(|&h| {
                let mut tag = vec![3, h as u8, (h >> 8) as u8, (h >> 16) as u8];
                if h % 50 != 0 {
                    let pick = (h.wrapping_mul(2_654_435_761) >> 16) % 210;
                    // 20 + 19 + … : pool i gets a share falling with i.
                    let mut i = 0usize;
                    let mut acc = 0u32;
                    while i < 19 && acc + 20 - i as u32 <= pick {
                        acc += 20 - i as u32;
                        i += 1;
                    }
                    tag.extend_from_slice(&tags[i]);
                }
                tag.extend((0..30).map(|i| (h ^ i) as u8));
                let pay = vec![(
                    312_500_000,
                    vec![0x00, 0x14].into_iter().chain([h as u8; 20]).collect(),
                )];
                let mut hd = header(0, h, 0);
                hd.timestamp = now - 300 - u64::from(rows - 1 - h) * 600 + u64::from(h % 7) * 60;
                hd.tx_count = 1 + h % 5000;
                hd.size = 1_500_000 + u64::from(h % 100_000);
                hd.weight = 3_990_000 + u64::from(h % 9000);
                hd.difficulty =
                    1.5e14 * (f64::from(h / 2016 + 1) / f64::from(rows / 2016 + 1)).powi(3);
                let totals = BlockTotals {
                    totalfee: Amount::from_sat(u64::from(h) * 37 % 9_000_000),
                    subsidy: Amount::from_sat(312_500_000),
                    total_weight: 3_989_000,
                };
                let mut row = Row::new(&hd, &totals, &coinbase(&tag, &pay));
                if h >= rows.saturating_sub(YEAR) {
                    row.rates = Some(Rated::from(&mock_facts(h, row.hash)));
                }
                row
            })
            .collect();
        store
            .write(move |sql| {
                let mut s = sql.prepare(db::INSERT_NEW)?;
                for r in &batch {
                    db::write_row(&mut s, r)?;
                }
                Ok(())
            })
            .await
            .unwrap();
    }
}

/// Times every read that runs on a schedule or per block, on the store in
/// `$TABLE_BENCH_DIR/$TABLE_BENCH_NET.sqlite` (a copy of a real one, or filled with
/// `$TABLE_BENCH_ROWS` mainnet-like rows when empty), alone or, with `TABLE_BENCH_WRITER=1`,
/// while a writer commits 10,000-row writes back to back. Run with
/// `TABLE_BENCH_DIR=<dir> cargo test --release -p engine -- --ignored --nocapture table_reads_benchmark`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "reads a store of mainnet's size; a benchmark, not a test"]
#[allow(clippy::print_stdout)] // A benchmark's report.
async fn table_reads_benchmark() {
    use std::time::{Instant, SystemTime};
    let dir = PathBuf::from(std::env::var_os("TABLE_BENCH_DIR").expect("TABLE_BENCH_DIR"));
    let net = std::env::var("TABLE_BENCH_NET").unwrap_or_else(|_| "regtest".into());
    let store = Arc::new(Store::open(&dir, &net, StoreOptions::default()).unwrap());
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    if top(&store).await.unwrap().is_none() {
        let rows: u32 = std::env::var("TABLE_BENCH_ROWS").map_or(975_000, |r| r.parse().unwrap());
        let s = Instant::now();
        fill_mainnet_like(&store, rows, now).await;
        println!("filled {rows} rows in {:?}", s.elapsed());
    }
    let writer = std::env::var_os("TABLE_BENCH_WRITER").map(|_| {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            loop {
                store
                    .write(|sql| {
                        sql.prepare("CREATE TABLE IF NOT EXISTS bench_load (x BLOB)")?
                            .execute([])?;
                        sql.prepare("DELETE FROM bench_load")?.execute([])?;
                        let mut s =
                            sql.prepare("INSERT INTO bench_load VALUES (randomblob(300))")?;
                        for _ in 0..10_000 {
                            s.execute([])?;
                        }
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
        })
    });
    if !totals_ready(&store).await.unwrap() {
        // What a reader meets meanwhile: the scan, while the fill writes.
        let tip = top(&store).await.unwrap().unwrap().0;
        let fill = tokio::spawn({
            let store = Arc::clone(&store);
            async move { fill_totals(&store).await.unwrap().unwrap() }
        });
        while !fill.is_finished() {
            let s = Instant::now();
            pool_counts(&store, 0, tip).await.unwrap();
            println!(
                "during the fill, pool_counts all: {:.1} ms",
                s.elapsed().as_secs_f64() * 1000.0
            );
        }
        let f = fill.await.unwrap();
        println!(
            "filled the totals: {} heights in {} writes, {:?}, the longest write {:?}",
            f.heights, f.writes, f.elapsed, f.longest
        );
    }
    let tip = top(&store).await.unwrap().unwrap().0;
    let tip_time = by_height(&store, tip).await.unwrap().unwrap().time;
    let back = |days: u64| tip_time - days * 86_400;
    let since = |t: u64| {
        let store = Arc::clone(&store);
        async move { first_since(&store, 0, t).await.unwrap().unwrap_or(tip) }
    };
    let (y1, y2, y3, m6) = (
        since(back(365)).await,
        since(back(730)).await,
        since(back(1095)).await,
        since(back(180)).await,
    );
    macro_rules! time {
        ($label:expr, $e:expr) => {{
            let mut t = Vec::new();
            for _ in 0..5 {
                let s = Instant::now();
                std::hint::black_box($e);
                t.push(s.elapsed().as_secs_f64() * 1000.0);
            }
            let first = t[0];
            t.sort_by(f64::total_cmp);
            println!(
                "{:<34} first {:>8.2} ms  median {:>8.2} ms  max {:>8.2} ms",
                $label, first, t[2], t[4]
            );
        }};
    }
    let node = Mock::new(tip + 1);
    time!("span", span(&store).await.unwrap());
    time!("row_counts", row_counts(&store).await.unwrap());
    time!(
        "backfill pass on a new tip",
        backfill::totals_step(&store, &node, 0, tip - ZONE, &Reorgs::default())
            .await
            .unwrap()
    );
    time!(
        "pool_counts all",
        pool_counts(&store, 0, tip).await.unwrap()
    );
    time!(
        "pool_counts 3y",
        pool_counts(&store, y3, tip).await.unwrap()
    );
    time!(
        "pool_counts week",
        pool_counts(&store, tip - 1007, tip).await.unwrap()
    );
    time!("pool_weeks all", pool_weeks(&store, 0, tip).await.unwrap());
    time!("pool_weeks 3y", pool_weeks(&store, y3, tip).await.unwrap());
    time!(
        "periods day all",
        periods(&store, 0, tip, Period::Day).await.unwrap()
    );
    time!(
        "periods day 3y",
        periods(&store, y3, tip, Period::Day).await.unwrap()
    );
    time!(
        "periods 1008 all",
        periods(&store, 0, tip, Period::Blocks(1008)).await.unwrap()
    );
    time!(
        "periods 216 3y",
        periods(&store, y3, tip, Period::Blocks(216)).await.unwrap()
    );
    time!(
        "periods 144 2y",
        periods(&store, y2, tip, Period::Blocks(144)).await.unwrap()
    );
    time!(
        "periods 72 1y",
        periods(&store, y1, tip, Period::Blocks(72)).await.unwrap()
    );
    time!(
        "periods 36 6m",
        periods(&store, m6, tip, Period::Blocks(36)).await.unwrap()
    );
    time!(
        "first_since 3y",
        first_since(&store, 0, back(1095)).await.unwrap()
    );
    time!("retargets all", retargets(&store, 0, 0, tip).await.unwrap());
    time!("work 1008", work(&store, tip - 1008, tip).await.unwrap());
    time!(
        "audit pool_health all",
        crate::audit::pool_health(&store, 0, tip).await.unwrap()
    );
    // A new block, written as `follow` writes it (its totals settled in the same write), then
    // rated, then removed again.
    let row = by_height(&store, tip).await.unwrap().unwrap();
    let mut next = row.clone();
    next.height = tip + 1;
    next.hash = hash(9, tip + 1);
    next.time += 600;
    time!("a new block's write", {
        write_rows(&store, db::REPLACE, vec![next.clone()]).await;
    });
    let rated = next.rates.unwrap_or(Rated {
        fee_rate: None,
        fee_bands: crate::projected::Bands {
            stored: [0; 10],
            split: None,
        },
    });
    time!("rating it", {
        store
            .write(move |sql| {
                Ok(db::rate_row(
                    &mut sql.prepare(db::RATE)?,
                    tip + 1,
                    &next.hash,
                    &rated,
                )?)
            })
            .await
            .unwrap();
    });
    store
        .write(move |sql| {
            sql.prepare("DELETE FROM blocks WHERE height > ?1")?
                .execute(crate::store::params![tip])?;
            Ok(())
        })
        .await
        .unwrap();
    if let Some(w) = writer {
        w.abort();
    }
}

// The running totals (`totals.rs`).

use crate::store::OptionalExtension;
use db::get;

/// A xorshift generator: the same sequence for a seed, with no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// A block at `height` on branch `branch` with everything the totals sum drawn at random: a time
/// that may run before its parent's, an empty block now and then, one of a few pools or none,
/// a distinct difficulty, and fee rates or not.
fn random_row(rng: &mut Rng, branch: u8, height: u32) -> Row {
    const TAGS: [&[u8]; 4] = [b"Foundry USA Pool", b"/AntPool/", b"/ViaBTC/", b"nobody"];
    let mut hd = header(branch, height, branch);
    hd.timestamp = 1_700_000_000 + u64::from(height) * 600 + rng.below(14_400) - 7_200;
    hd.tx_count = if rng.below(8) == 0 {
        1
    } else {
        1 + rng.below(3000) as u32
    };
    hd.size = rng.below(2_000_000);
    hd.weight = rng.below(4_000_000);
    hd.difficulty = 1e10 * (1.0 + rng.below(1 << 40) as f64 / (1u64 << 40) as f64);
    let totals = BlockTotals {
        totalfee: Amount::from_sat(rng.below(50_000_000)),
        subsidy: Amount::from_sat(312_500_000),
        total_weight: 3_000_000,
    };
    let tag = TAGS[rng.below(4) as usize];
    let mut row = Row::new(
        &hd,
        &totals,
        &coinbase(tag, &[(312_500_000 + rng.below(1000), vec![0x51])]),
    );
    if rng.below(2) == 0 {
        row.rates = Some(random_rates(rng, hd.tx_count));
    }
    row
}

fn random_rates(rng: &mut Rng, tx_count: u32) -> Rated {
    let mut r: [f64; 7] = std::array::from_fn(|_| rng.below(1 << 30) as f64 / 1e6);
    r.sort_by(f64::total_cmp);
    Rated {
        fee_rate: (tx_count > 1).then_some(Rates {
            min: r[0],
            p10: r[1],
            p25: r[2],
            median: r[3],
            p75: r[4],
            p90: r[5],
            max: r[6],
        }),
        fee_bands: crate::projected::Bands {
            stored: std::array::from_fn(|_| rng.below(100_000)),
            split: None,
        },
    }
}

async fn write_rows(store: &Store, stmt: &'static str, rows: Vec<Row>) {
    store
        .write(move |sql| {
            let mut s = sql.prepare(stmt)?;
            for r in &rows {
                db::write_row(&mut s, r)?;
            }
            Ok(())
        })
        .await
        .unwrap();
}

/// Every total against a scan of the rows: the stored buckets one by one, and each read over
/// ranges drawn from `rng`.
async fn assert_totals_match(store: &Store, rng: &mut Rng, step: &str) {
    let seed = rng.next();
    let step = step.to_owned();
    store
        .read(crate::store::Read::Blocks, move |sql| {
            let mut rng = Rng(seed | 1);
            sql.prepare("BEGIN")?.execute([])?;
            let dirty: i64 = sql
                .prepare("SELECT count(*) FROM totals_dirty")?
                .query_row([], |r| r.get(0))?;
            assert_eq!(dirty, 0, "{step}: dirty buckets committed");
            // Every stored bucket is a scan's, and every scan's bucket is stored.
            for kind in [0, 18, 36, 72, 144, 216, 1008] {
                let mut stmt = sql.prepare(
                    "SELECT key, blocks, first_height, last_height, first_time, last_time, \
                     tx_count, size, weight, fees, subsidy, reward, difficulty, rated, fee_min, \
                     fee_p10, fee_p25, fee_median, fee_p75, fee_p90, fee_max FROM block_totals \
                     WHERE kind = ?1 ORDER BY key",
                )?;
                let stored: Vec<Bucket> = stmt
                    .query_map(crate::store::params![kind], db::read_bucket)?
                    .collect::<Result<_, _>>()?;
                let scanned = db::periods_scan(sql, 0, u32::MAX, kind)?;
                assert_eq!(stored, scanned, "{step}: kind {kind}");
            }
            for (kind, grouped) in [(1008, "height / 1008"), (7, "(time - 345600) / 604800")] {
                let stored: Vec<(i64, i64, i64, i64, i64)> = sql
                    .prepare(
                        "SELECT key, pool, blocks, empty, reward FROM pool_totals \
                         WHERE kind = ?1 ORDER BY key, pool",
                    )?
                    .query_map(crate::store::params![kind], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                    })?
                    .collect::<Result<_, _>>()?;
                let scan = if grouped.starts_with('h') {
                    "SELECT height / 1008 AS k, pool, count(*), sum(tx_count = 1), sum(reward) \
                     FROM blocks GROUP BY k, pool ORDER BY k, pool"
                } else {
                    "SELECT (time - 345600) / 604800 AS k, pool, count(*), sum(tx_count = 1), \
                     sum(reward) FROM blocks GROUP BY k, pool ORDER BY k, pool"
                };
                let scanned: Vec<(i64, i64, i64, i64, i64)> = sql
                    .prepare(scan)?
                    .query_map([], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                    })?
                    .collect::<Result<_, _>>()?;
                assert_eq!(stored, scanned, "{step}: pools by {grouped}");
            }
            let (max, times): (Option<u32>, Option<(i64, i64)>) = sql
                .prepare("SELECT max(height), min(time), max(time) FROM blocks")?
                .query_row([], |r| {
                    let t: Option<i64> = r.get(1)?;
                    Ok((r.get(0)?, t.map(|t| (t, r.get(2).unwrap_or(t)))))
                })?;
            let Some(max) = max else { return Ok(()) };
            let heights: Vec<u32> = sql
                .prepare("SELECT height FROM blocks ORDER BY height")?
                .query_map([], |r| get(r, 0))?
                .collect::<Result<_, _>>()?;
            let present: std::collections::HashSet<u32> = heights.iter().copied().collect();
            assert_eq!(
                totals::counts(sql)?.map(|c| c.0),
                Some(heights.len() as u64),
                "{step}: row count"
            );
            let mut ranges = vec![(0, u32::MAX)];
            for _ in 0..2 {
                let a = rng.below(u64::from(max) + 2) as u32;
                let b = a + rng.below(u64::from(max) + 2 - u64::from(a)) as u32;
                ranges.push((a, b));
            }
            for &(a, b) in &ranges {
                let kind = [18, 36, 72, 144, 216][rng.below(5) as usize];
                for kind in [0, 1008, kind] {
                    assert_eq!(
                        totals::periods(sql, a, b, kind)?,
                        Some(db::periods_scan(sql, a, b, kind)?),
                        "{step}: periods by {kind} over {a}..={b}"
                    );
                }
                assert_eq!(
                    totals::pool_counts(sql, a, b)?,
                    Some(mining::pool_counts_scan(sql, a, b)?),
                    "{step}: pool counts over {a}..={b}"
                );
                assert_eq!(
                    totals::pool_weeks(sql, a, b)?,
                    Some(mining::pool_weeks_scan(sql, a, b)?),
                    "{step}: pool weeks over {a}..={b}"
                );
                if let Some((lo, hi)) = times {
                    let t = lo - 86_400 + rng.below((hi - lo + 2 * 86_400) as u64) as i64;
                    assert_eq!(
                        totals::first_since(sql, a, t as u64)?,
                        Some(mining::first_since_scan(sql, a, t, i64::MAX)?),
                        "{step}: first since {t} from {a}"
                    );
                }
                // Every height above what `below_full` returns has a row.
                let hi = b.min(max + 5);
                let top = totals::below_full(sql, hi)?.unwrap();
                let from = top.map_or(0, |t| t + 1);
                assert!(
                    (from..=hi).all(|h| present.contains(&h)),
                    "{step}: heights {from}..={hi} skipped but not all stored"
                );
            }
            // `full_from`: every height from it to the top is stored.
            let full = totals::full_from(sql, max)?.unwrap();
            assert!(
                (full..=max).all(|h| present.contains(&h)),
                "{step}: full from {full}"
            );
            Ok(())
        })
        .await
        .unwrap();
}

/// A long random run of what happens to the block table: new tips, old blocks backfilled out of
/// order, blocks rated later, reorgs that remove and replace rows, stale rows deleted, pools
/// re-identified, restarts. After every step each total equals a scan of the rows.
#[tokio::test]
async fn totals_equal_a_scan_through_every_kind_of_change() {
    let dir = std::env::temp_dir().join(format!("rbitcoin-space-totals-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut store = Store::open(&dir, "regtest", StoreOptions::default()).unwrap();
    // `TOTALS_STEPS` and `TOTALS_SEED` run a longer or another sequence by hand.
    let env = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u64>().ok());
    let mut rng = Rng(env("TOTALS_SEED").unwrap_or(0x5eed_1234_abcd_ef01) | 1);
    let steps = env("TOTALS_STEPS").unwrap_or(30);
    let mut tip = 0u32;
    let mut branch = 0u8;
    // Old blocks, newest first and with gaps, as a backfill leaves them.
    let old: Vec<Row> = (0..2400)
        .filter(|h| h % 97 != 5)
        .map(|h| random_row(&mut rng, 0, h))
        .collect();
    write_rows(&store, db::INSERT_NEW, old).await;
    tip = tip.max(2399);
    assert_totals_match(&store, &mut rng, "start").await;
    for step in 0..steps {
        let what = rng.below(8);
        let label = format!("step {step} ({what})");
        match what {
            // New blocks on the tip, written as follow writes them.
            0 | 1 => {
                let n = 1 + rng.below(30) as u32;
                let rows = (tip + 1..=tip + n)
                    .map(|h| random_row(&mut rng, branch, h))
                    .collect();
                write_rows(&store, db::REPLACE, rows).await;
                tip += n;
            }
            // The backfill fills old heights, or skips existing ones.
            2 => {
                let lo = rng.below(u64::from(tip)) as u32;
                let rows = (lo..(lo + 60).min(tip))
                    .map(|h| random_row(&mut rng, branch, h))
                    .collect();
                write_rows(&store, db::INSERT_NEW, rows).await;
            }
            // Rows rated after they were written.
            3 => {
                let picks: Vec<(u32, Rated)> = (0..20)
                    .map(|_| {
                        let h = rng.below(u64::from(tip) + 1) as u32;
                        (h, random_rates(&mut rng, 2))
                    })
                    .collect();
                store
                    .write(move |sql| {
                        let mut s = sql.prepare(db::RATE)?;
                        for (h, rated) in &picks {
                            let hash: Option<[u8; 32]> = sql
                                .prepare("SELECT hash FROM blocks WHERE height = ?1")?
                                .query_row(crate::store::params![h], |r| r.get(0))
                                .optional()?;
                            if let Some(hash) = hash {
                                db::rate_row(&mut s, *h, &BlockHash::from_byte_array(hash), rated)?;
                            }
                        }
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            // A reorg: the rows above a fork go, and a branch replaces them, maybe shorter.
            4 => {
                let depth = 1 + rng.below(150) as u32;
                let fork = tip.saturating_sub(depth);
                branch = branch.wrapping_add(1);
                let len = depth.saturating_sub(rng.below(3) as u32);
                let rows: Vec<Row> = (fork + 1..=fork + len)
                    .map(|h| random_row(&mut rng, branch, h))
                    .collect();
                store
                    .write(move |sql| {
                        sql.prepare("DELETE FROM blocks WHERE height > ?1")?
                            .execute(crate::store::params![fork + len])?;
                        let mut s = sql.prepare(db::REPLACE)?;
                        for r in &rows {
                            db::write_row(&mut s, r)?;
                        }
                        Ok(())
                    })
                    .await
                    .unwrap();
                tip = fork + len;
            }
            // The backfill deletes a stale row.
            5 => {
                let h = rng.below(u64::from(tip)) as u32;
                store
                    .write(move |sql| {
                        let hash: Option<[u8; 32]> = sql
                            .prepare("SELECT hash FROM blocks WHERE height = ?1")?
                            .query_row(crate::store::params![h], |r| r.get(0))
                            .optional()?;
                        if let Some(hash) = hash {
                            db::delete_row(sql, h, &BlockHash::from_byte_array(hash))?;
                        }
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            // A new pool list names some blocks' pools differently, as `reattribute` writes it.
            6 => {
                let lo = rng.below(u64::from(tip)) as u32;
                let pool = rng.below(150) as u16;
                store
                    .write(move |sql| {
                        let rows: Vec<(u32, Vec<u8>)> = sql
                            .prepare(
                                "SELECT height, hash FROM blocks WHERE height BETWEEN ?1 AND ?2",
                            )?
                            .query_map(crate::store::params![lo, lo + 400], |r| {
                                Ok((get(r, 0)?, r.get(1)?))
                            })?
                            .collect::<Result<_, _>>()?;
                        let mut s = sql.prepare(
                            "UPDATE blocks SET pool = ?1 WHERE height = ?2 AND hash = ?3",
                        )?;
                        for (h, hash) in rows.iter().step_by(3) {
                            s.execute(crate::store::params![pool, h, hash])?;
                        }
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            // A restart.
            _ => {
                store.close().await;
                store = Store::open(&dir, "regtest", StoreOptions::default()).unwrap();
            }
        }
        assert_totals_match(&store, &mut rng, &label).await;
    }
    store.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// A table filled before the totals existed is totalled afterwards, a chunk at a time, while
/// other writes go on; reads scan until then, and then the totals equal a scan.
#[tokio::test]
async fn totals_are_filled_for_rows_stored_before_them() {
    let dir =
        std::env::temp_dir().join(format!("rbitcoin-space-totals-fill-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let before = &crate::store::MIGRATIONS[..9];
    assert_eq!(before.last().unwrap().0, "0009_chain.sql");
    let store = Store::open_with(&dir, "regtest", StoreOptions::default(), before).unwrap();
    let mut rng = Rng(0x0fed_cba9_8765_4321);
    let rows: Vec<Row> = (0..3000)
        .filter(|h| h % 501 != 7)
        .map(|h| random_row(&mut rng, 0, h))
        .collect();
    // The insert as a store at 0009 ran it, before the lowest band's split columns (0012): the
    // split's two parameters stay numbered, unused.
    let insert_0009: &'static str = Box::leak(
        db::INSERT_NEW
            .replace(", band0_12_15, band0_15_20", "")
            .replace("?32, ?33, ?34)", "?34)")
            .into_boxed_str(),
    );
    write_rows(&store, insert_0009, rows).await;
    store.close().await;

    let store = Store::open(&dir, "regtest", StoreOptions::default()).unwrap();
    assert!(!totals_ready(&store).await.unwrap());
    // Until the fill is done, every read scans, and says so by having no totals to give.
    store
        .read(crate::store::Read::Blocks, |sql| {
            assert_eq!(totals::periods(sql, 0, 2999, 0)?, None);
            assert_eq!(totals::counts(sql)?, None);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(row_counts(&store).await.unwrap().0, 2994);
    // Between the fill's writes: a new tip, a restart, a reorg across heights already filled and
    // not yet, a later rating and a stale row's deletion.
    assert_eq!(totals::fill_step(&store, 700).await.unwrap(), Some(700));
    write_rows(
        &store,
        db::REPLACE,
        (3000..3020).map(|h| random_row(&mut rng, 0, h)).collect(),
    )
    .await;
    assert_eq!(totals::fill_step(&store, 700).await.unwrap(), Some(700));
    store.close().await;
    let store = Store::open(&dir, "regtest", StoreOptions::default()).unwrap();
    assert!(!totals_ready(&store).await.unwrap());
    write_rows(
        &store,
        db::REPLACE,
        (1500..1700).map(|h| random_row(&mut rng, 1, h)).collect(),
    )
    .await;
    let rated = random_rates(&mut rng, 2);
    store
        .write(move |sql| {
            db::rate_row(&mut sql.prepare(db::RATE)?, 100, &hash(0, 100), &rated)?;
            db::delete_row(sql, 200, &hash(0, 200))?;
            Ok(())
        })
        .await
        .unwrap();
    let filled = totals::fill_by(&store, 700).await.unwrap().unwrap();
    assert_eq!((filled.heights, filled.writes), (1600, 3));
    assert!(totals_ready(&store).await.unwrap());
    assert_eq!(totals::fill_by(&store, 700).await.unwrap(), None);
    assert_totals_match(&store, &mut rng, "filled").await;
    store.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}
