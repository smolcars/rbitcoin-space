// The regtest test prints what it checked, as its proof.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::print_stdout
)]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bitcoin::hashes::{Hash, sha256d};
use bitcoin::{Amount, ScriptBuf};
use node::rpc::model::{PrevoutIn, PrevoutOut, PrevoutTx, ScriptHexText};

use super::*;
use crate::store::Options as StoreOptions;

/// A store in a fresh temporary directory, removed when dropped. `reopen` stands for a restart.
struct Temp {
    dir: PathBuf,
    store: Option<Store>,
}

impl Temp {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "rbitcoin-space-ledger-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir, "regtest", StoreOptions::default()).unwrap();
        Self {
            dir,
            store: Some(store),
        }
    }

    fn store(&self) -> &Store {
        self.store.as_ref().unwrap()
    }

    async fn reopen(&mut self) {
        if let Some(s) = self.store.take() {
            s.close().await;
        }
        self.store = Some(Store::open(&self.dir, "regtest", StoreOptions::default()).unwrap());
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        drop(self.store.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A deterministic generator, so a failing run can be replayed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Scripts: the first `TRACKABLE` may be tracked, the rest never are.
const TRACKABLE: usize = 5;
const SCRIPTS: usize = 8;

fn hex(i: usize) -> String {
    format!("0014{:040x}", i + 1)
}

fn script(i: usize) -> ScriptBuf {
    ScriptBuf::from_hex(&hex(i)).unwrap()
}

fn sh(i: usize) -> ScriptHash {
    ScriptHash::from_script(&script(i))
}

fn out(i: usize, sats: u64) -> PrevoutOut {
    PrevoutOut {
        value: Amount::from_sat(sats),
        script_pub_key: ScriptHexText { hex: hex(i) },
    }
}

type Hook = Box<dyn FnOnce(&Fake) + Send>;

/// A chain the tests rewrite at will, and the node's answers computed from it by plain counting.
struct Fake {
    chain: Mutex<Vec<PrevoutBlock>>,
    /// Every block ever made, by hash: the node still serves a block that left the chain.
    all: Mutex<Vec<PrevoutBlock>>,
    calls: AtomicUsize,
    refuse: Mutex<HashSet<String>>,
    variant: AtomicUsize,
    /// Run once, inside the next `totals` call: the chain moving while a seed is under way.
    during_totals: Mutex<Option<Hook>>,
    /// History pages asked, and how many of the next ones fail.
    pages: AtomicUsize,
    fail_pages: AtomicUsize,
    /// Whole history lists asked; how many of the next ones fail; whether they are refused; rows
    /// left out of each (a list that does not match the totals); and a hook run after the first
    /// batch of the next one.
    lists: AtomicUsize,
    fail_lists: AtomicUsize,
    refuse_lists: std::sync::atomic::AtomicBool,
    short_lists: AtomicUsize,
    during_list: Mutex<Option<Hook>>,
    /// Blocks at or above this height fail to read.
    fail_blocks_from: std::sync::atomic::AtomicU32,
}

impl Fake {
    fn new(blocks: u32, rng: &mut Rng) -> Self {
        let f = Self {
            chain: Mutex::new(Vec::new()),
            all: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
            refuse: Mutex::new(HashSet::new()),
            variant: AtomicUsize::new(0),
            during_totals: Mutex::new(None),
            pages: AtomicUsize::new(0),
            fail_pages: AtomicUsize::new(0),
            lists: AtomicUsize::new(0),
            fail_lists: AtomicUsize::new(0),
            refuse_lists: std::sync::atomic::AtomicBool::new(false),
            short_lists: AtomicUsize::new(0),
            during_list: Mutex::new(None),
            fail_blocks_from: std::sync::atomic::AtomicU32::new(u32::MAX),
        };
        // Genesis pays nobody we track, as on every real chain.
        f.push_txs(Vec::new());
        for _ in 1..blocks {
            f.push(rng);
        }
        f
    }

    fn tip(&self) -> u32 {
        u32::try_from(self.chain.lock().unwrap().len()).unwrap() - 1
    }

    /// A new block on the tip, with up to six random transactions.
    fn push(&self, rng: &mut Rng) {
        let n = rng.below(7);
        let txs = (0..n)
            .map(|_| {
                let vin = (0..rng.below(3))
                    .map(|_| PrevoutIn {
                        prevout: Some(out(
                            usize::try_from(rng.below(SCRIPTS as u64)).unwrap(),
                            1 + rng.below(1_000_000),
                        )),
                    })
                    .collect();
                let vout = (0..1 + rng.below(3))
                    .map(|_| {
                        out(
                            usize::try_from(rng.below(SCRIPTS as u64)).unwrap(),
                            1 + rng.below(1_000_000),
                        )
                    })
                    .collect();
                (vin, vout)
            })
            .collect();
        self.push_txs(txs);
    }

    fn push_txs(&self, txs: Vec<(Vec<PrevoutIn>, Vec<PrevoutOut>)>) {
        let variant = self.variant.fetch_add(1, Ordering::SeqCst);
        let mut chain = self.chain.lock().unwrap();
        let height = u32::try_from(chain.len()).unwrap();
        let hash = BlockHash::from_byte_array(
            sha256d::Hash::hash(format!("block {height} {variant}").as_bytes()).to_byte_array(),
        );
        // The coinbase pays the script past every other, never tracked.
        let mut tx = vec![PrevoutTx {
            txid: Txid::from_byte_array(
                sha256d::Hash::hash(format!("cb {height} {variant}").as_bytes()).to_byte_array(),
            ),
            vin: vec![PrevoutIn { prevout: None }],
            vout: vec![out(SCRIPTS, 50)],
        }];
        for (i, (vin, vout)) in txs.into_iter().enumerate() {
            tx.push(PrevoutTx {
                txid: Txid::from_byte_array(
                    sha256d::Hash::hash(format!("tx {height} {variant} {i}").as_bytes())
                        .to_byte_array(),
                ),
                vin,
                vout,
            });
        }
        let block = PrevoutBlock {
            hash,
            height,
            time: 1_700_000_000 + height * 600,
            previousblockhash: chain.last().map(|b| b.hash),
            tx,
        };
        self.all.lock().unwrap().push(block.clone());
        chain.push(block);
    }

    /// Takes the top `depth` blocks off the chain.
    fn pop(&self, depth: u32) {
        let mut chain = self.chain.lock().unwrap();
        let keep = chain.len() - depth as usize;
        chain.truncate(keep);
    }

    /// The node's totals for script `i` at `height`, by counting.
    fn oracle(&self, i: usize, height: u32) -> Totals {
        let chain = self.chain.lock().unwrap();
        let h = hex(i);
        let mut t = Totals::default();
        for b in chain.iter().take(height as usize + 1) {
            for tx in &b.tx {
                let mut touched = false;
                for p in tx.vin.iter().filter_map(|i| i.prevout.as_ref()) {
                    if p.script_pub_key.hex == h {
                        t.spent_count += 1;
                        t.spent_sum += p.value.to_sat();
                        touched = true;
                    }
                }
                for o in &tx.vout {
                    if o.script_pub_key.hex == h {
                        t.funded_count += 1;
                        t.funded_sum += o.value.to_sat();
                        touched = true;
                    }
                }
                t.tx_count += u64::from(touched);
            }
        }
        t
    }

    /// The node's history of script `i` at `height`, newest first.
    fn history(&self, i: usize, height: u32) -> Vec<TxRow> {
        let chain = self.chain.lock().unwrap();
        let h = hex(i);
        let mut rows = Vec::new();
        for b in chain.iter().take(height as usize + 1) {
            for (pos, tx) in b.tx.iter().enumerate() {
                let spent: i64 = tx
                    .vin
                    .iter()
                    .filter_map(|i| i.prevout.as_ref())
                    .filter(|p| p.script_pub_key.hex == h)
                    .map(|p| i64::try_from(p.value.to_sat()).unwrap())
                    .sum();
                let funded: i64 = tx
                    .vout
                    .iter()
                    .filter(|o| o.script_pub_key.hex == h)
                    .map(|o| i64::try_from(o.value.to_sat()).unwrap())
                    .sum();
                let touched = tx
                    .vin
                    .iter()
                    .filter_map(|i| i.prevout.as_ref())
                    .any(|p| p.script_pub_key.hex == h)
                    || tx.vout.iter().any(|o| o.script_pub_key.hex == h);
                if touched {
                    rows.push(TxRow {
                        txid: tx.txid,
                        height: b.height,
                        position: u32::try_from(pos).unwrap(),
                        value: funded - spent,
                        time: b.time,
                    });
                }
            }
        }
        rows.reverse();
        rows
    }

    fn height_of(&self, hash: BlockHash) -> Option<u32> {
        let chain = self.chain.lock().unwrap();
        chain.iter().find(|b| b.hash == hash).map(|b| b.height)
    }
}

impl Source for Fake {
    async fn height(&self) -> Result<u32, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.tip())
    }

    async fn at(&self, height: u32) -> Result<Option<At>, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let chain = self.chain.lock().unwrap();
        Ok(chain.get(height as usize).map(|b| At {
            height,
            hash: b.hash,
            time: b.time,
        }))
    }

    async fn block(&self, hash: BlockHash) -> Result<PrevoutBlock, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let all = self.all.lock().unwrap();
        all.iter()
            .find(|b| b.hash == hash)
            .filter(|b| b.height < self.fail_blocks_from.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| SourceError::Failed("no such block".into()))
    }

    async fn totals(
        &self,
        script: &Script,
        at: BlockHash,
    ) -> Result<Result<Totals, Option<ScriptSize>>, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let i = (0..SCRIPTS)
            .find(|i| script == self::script(*i).as_script())
            .unwrap();
        if self.refuse.lock().unwrap().contains(&hex(i)) {
            return Ok(Err(Some(ScriptSize {
                creates: 20_000,
                cap: 10_000,
            })));
        }
        let height = self
            .height_of(at)
            .ok_or_else(|| SourceError::Failed("not on the chain".into()))?;
        let t = self.oracle(i, height);
        let hook = self.during_totals.lock().unwrap().take();
        if let Some(hook) = hook {
            hook(self);
        }
        Ok(Ok(t))
    }

    async fn page(&self, script: &Script, at: BlockHash) -> Result<Vec<TxSummary>, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.pages.fetch_add(1, Ordering::SeqCst);
        let fail = self.fail_pages.load(Ordering::SeqCst);
        if fail > 0 {
            self.fail_pages.store(fail - 1, Ordering::SeqCst);
            return Err(SourceError::Busy);
        }
        let i = (0..SCRIPTS)
            .find(|i| script == self::script(*i).as_script())
            .unwrap();
        let height = self
            .height_of(at)
            .ok_or_else(|| SourceError::Failed("not on the chain".into()))?;
        // The node lists a block's rows in an order of its own: reversed here.
        let mut rows = self.history(i, height);
        rows.sort_by(|a, b| b.height.cmp(&a.height).then(a.position.cmp(&b.position)));
        Ok(rows
            .into_iter()
            .take(25)
            .map(|r| TxSummary {
                txid: r.txid,
                value: r.value,
                height: r.height,
                time: u64::from(r.time),
                tx_position: Some(r.position),
            })
            .collect())
    }

    async fn history(
        &self,
        script: &Script,
        at: At,
        rows: tokio::sync::mpsc::Sender<Vec<HistoryRow>>,
    ) -> Result<Result<(), Option<ScriptSize>>, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.lists.fetch_add(1, Ordering::SeqCst);
        if self.refuse_lists.load(Ordering::SeqCst) {
            return Ok(Err(Some(ScriptSize {
                creates: 20_000,
                cap: 10_000,
            })));
        }
        let fail = self.fail_lists.load(Ordering::SeqCst);
        if fail > 0 {
            self.fail_lists.store(fail - 1, Ordering::SeqCst);
            return Err(SourceError::Busy);
        }
        let i = (0..SCRIPTS)
            .find(|i| script == self::script(*i).as_script())
            .unwrap();
        if self.height_of(at.hash) != Some(at.height) {
            return Err(SourceError::Failed("asof not on chain".into()));
        }
        let mut list = listed(self, i, at.height);
        let short = self.short_lists.load(Ordering::SeqCst);
        if short > 0 {
            self.short_lists.store(short - 1, Ordering::SeqCst);
            list.pop();
        }
        // In batches of three, as the real one streams them.
        for (n, batch) in list.chunks(3).enumerate() {
            if rows.send(batch.to_vec()).await.is_err() {
                return Err(SourceError::Failed("stopped".into()));
            }
            if n == 0 {
                let hook = self.during_list.lock().unwrap().take();
                if let Some(hook) = hook {
                    hook(self);
                }
                // Lets the writer and a concurrent follow run.
                for _ in 0..10 {
                    tokio::task::yield_now().await;
                }
            }
        }
        Ok(Ok(()))
    }
}

use node::esplora::model::TxSummary;

/// Script `i`'s whole history at `height` in the node's list order: height, then txid bytes.
fn listed(fake: &Fake, i: usize, height: u32) -> Vec<HistoryRow> {
    let mut rows: Vec<HistoryRow> = fake
        .history(i, height)
        .into_iter()
        .map(|r| HistoryRow {
            height: r.height,
            txid: r.txid,
        })
        .collect();
    rows.sort_unstable_by_key(node::electrum::history::order);
    rows
}

/// The whole history the ledger keeps for `i`, in the node's list order, read straight from the
/// table.
async fn kept_history(store: &Store, i: usize) -> Vec<HistoryRow> {
    kept_history_of(store, sh(i)).await
}

async fn kept_history_of(store: &Store, sh: ScriptHash) -> Vec<HistoryRow> {
    store
        .read(Read::Ledger, move |sql| {
            let mut stmt = sql.prepare(concat!(
                "SELECT h.height, h.txid FROM ledger_history h JOIN ledger_scripts s ",
                "ON h.hid = s.hid WHERE s.sh = ?1 ORDER BY h.height, h.txid"
            ))?;
            let rows = stmt
                .query_map(crate::store::params![sh.to_byte_array()], |r| {
                    let b: Vec<u8> = r.get(1)?;
                    Ok(HistoryRow {
                        height: r.get(0)?,
                        txid: Txid::from_byte_array(<[u8; 32]>::try_from(b.as_slice()).unwrap()),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

/// Every row the history table holds, for every script.
async fn history_table_rows(store: &Store) -> i64 {
    store
        .read(Read::Ledger, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM ledger_history")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap()
}

/// Every script whose history is whole against the oracle at the ledger's tip.
async fn check_history(store: &Store, fake: &Fake, label: &str) {
    for i in 0..TRACKABLE {
        let Some(t) = tracked(store, sh(i)).await.unwrap() else {
            continue;
        };
        if let History::Whole { .. } = t.history {
            assert_eq!(
                kept_history(store, i).await,
                listed(fake, i, t.at.height),
                "{label}: script {i}: history at {}",
                t.at.height
            );
        }
    }
}

/// Every tracked script against the oracle at the ledger's tip: totals, the tip itself, the
/// newest transactions as an exact prefix of the history, and the chart's last point.
async fn check(store: &Store, fake: &Fake, label: &str) {
    for i in 0..TRACKABLE {
        let Some(v) = view(store, sh(i)).await.unwrap() else {
            continue;
        };
        let at = v.tracked.at;
        let chain_at = fake.chain.lock().unwrap()[at.height as usize].hash;
        assert_eq!(at.hash, chain_at, "{label}: script {i}: tip off the chain");
        assert_eq!(
            v.tracked.totals,
            fake.oracle(i, at.height),
            "{label}: script {i} at {}",
            at.height
        );
        let history = fake.history(i, at.height);
        assert!(v.txs.len() <= WINDOW, "{label}");
        assert_eq!(
            v.txs,
            history[..v.txs.len()],
            "{label}: script {i}: rows not the newest history"
        );
        let last = v.points.last().unwrap();
        assert_eq!(last.balance, v.tracked.totals.balance(), "{label}: point");
        assert!(last.height <= at.height, "{label}");
        for p in &v.points {
            assert!(
                p.height >= v.tracked.seeded_height,
                "{label}: point before tracking"
            );
            assert_eq!(
                p.balance,
                fake.oracle(i, p.height).balance(),
                "{label}: script {i}: point at {}",
                p.height
            );
        }
    }
}

#[tokio::test]
async fn seeded_scripts_follow_the_chain_through_random_reorgs_and_restarts() {
    for seed_value in [1_u64, 7, 42, 99] {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ seed_value);
        let fake = Fake::new(30, &mut rng);
        let mut t = Temp::new();
        for step in 0..250 {
            match rng.below(100) {
                0..60 => fake.push(&mut rng),
                60..70 => {
                    let depth = 1 + u32::try_from(rng.below(4)).unwrap();
                    fake.pop(depth);
                    for _ in 0..depth + u32::try_from(rng.below(2)).unwrap() {
                        fake.push(&mut rng);
                    }
                }
                70..85 => {
                    let i = usize::try_from(rng.below(TRACKABLE as u64)).unwrap();
                    let page = rng.below(2) == 0;
                    match seed(t.store(), &fake, &script(i), page, TRACKABLE, step).await {
                        Ok(_) | Err(Error::Moved) => {}
                        Err(e) => panic!("seed: {e}"),
                    }
                }
                85..88 => {
                    let i = usize::try_from(rng.below(TRACKABLE as u64)).unwrap();
                    match fill(t.store(), &fake, sh(i)).await {
                        Ok(_) | Err(Error::Moved) => {}
                        Err(e) => panic!("fill: {e}"),
                    }
                }
                88..90 => t.reopen().await,
                _ => {}
            }
            follow(t.store(), &fake).await.unwrap();
            check(t.store(), &fake, &format!("seed {seed_value} step {step}")).await;
        }
        assert!(count(t.store()).await.unwrap() > 0);
    }
}

#[tokio::test]
async fn with_nothing_tracked_the_node_is_not_asked() {
    let mut rng = Rng(5);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    let f = follow(t.store(), &fake).await.unwrap();
    assert_eq!(f, Followed::default());
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_seed_catches_up_with_blocks_that_came_while_the_node_added_up() {
    let mut rng = Rng(11);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    seed(t.store(), &fake, &script(0), true, 10, 0)
        .await
        .unwrap();
    follow(t.store(), &fake).await.unwrap();
    // Two blocks arrive and are followed before script 1 is seeded.
    let store = t.store();
    let mut r2 = Rng(12);
    fake.push(&mut r2);
    let funded = vec![(vec![], vec![out(1, 777)])];
    fake.push_txs(funded);
    follow(store, &fake).await.unwrap();
    // Anchored one block below the ledger's tip: that block is applied to script 1 alone.
    let seeded = seed(store, &fake, &script(1), true, 10, 0).await.unwrap();
    assert!(matches!(seeded, Seeded::Tracked { page: true, .. }));
    check(store, &fake, "after the catch-up").await;
    let v = view(store, sh(1)).await.unwrap().unwrap();
    assert_eq!(v.tracked.at.height, fake.tip());
    assert_eq!(v.txs.first().unwrap().value, 777);
}

#[tokio::test]
async fn a_tip_that_moves_during_the_seed_is_caught_up_in_the_same_seed() {
    let mut rng = Rng(21);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    follow(t.store(), &fake).await.unwrap();
    let store = t.store();
    // The block lands and is followed while the node adds script 1 up.
    *fake.during_totals.lock().unwrap() = Some(Box::new(|f: &Fake| {
        f.push_txs(vec![(vec![], vec![out(1, 5)])]);
    }));
    let one = script(1);
    let pending = seed(store, &fake, &one, false, 10, 0);
    tokio::pin!(pending);
    let seeded = loop {
        tokio::select! {
            s = &mut pending => break s.unwrap(),
            () = tokio::task::yield_now() => { follow(store, &fake).await.unwrap(); }
        }
    };
    assert!(matches!(seeded, Seeded::Tracked { .. }));
    follow(store, &fake).await.unwrap();
    check(store, &fake, "moved during the seed").await;
}

#[tokio::test]
async fn a_script_seeded_at_a_block_that_leaves_the_chain_is_dropped() {
    let mut rng = Rng(31);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    for _ in 0..5 {
        fake.push(&mut rng);
    }
    follow(t.store(), &fake).await.unwrap();
    seed(t.store(), &fake, &script(1), false, 10, 0)
        .await
        .unwrap();
    let seeded_at = tracked(t.store(), sh(1))
        .await
        .unwrap()
        .unwrap()
        .seeded_height;
    // A reorg two blocks deep takes the block script 1 was pinned to.
    fake.pop(fake.tip() - seeded_at + 1);
    fake.push(&mut rng);
    fake.push(&mut rng);
    fake.push(&mut rng);
    let f = follow(t.store(), &fake).await.unwrap();
    assert_eq!(f.dropped, 1);
    assert!(f.changed.contains(&sh(1)));
    assert!(tracked(t.store(), sh(1)).await.unwrap().is_none());
    assert!(tracked(t.store(), sh(0)).await.unwrap().is_some());
    check(t.store(), &fake, "after the reorg").await;
}

#[tokio::test]
async fn a_reorg_deeper_than_the_undo_depth_drops_everything() {
    let mut rng = Rng(41);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    for _ in 0..UNDO_DEPTH + 5 {
        fake.push(&mut rng);
    }
    follow(t.store(), &fake).await.unwrap();
    check(t.store(), &fake, "before").await;
    fake.pop(UNDO_DEPTH + 2);
    for _ in 0..UNDO_DEPTH + 3 {
        fake.push(&mut rng);
    }
    let f = follow(t.store(), &fake).await.unwrap();
    assert!(f.reset);
    assert_eq!(f.tip, None);
    assert_eq!(count(t.store()).await.unwrap(), 0);
    // Seeded again, it is exact.
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    follow(t.store(), &fake).await.unwrap();
    check(t.store(), &fake, "seeded again").await;
}

/// The node with a seed of another script run inside the next block read: between `follow`
/// reading the block and writing it.
struct SeedDuringBlock {
    fake: Arc<Fake>,
    store: Arc<Store>,
    next: Mutex<Option<usize>>,
}

impl Source for SeedDuringBlock {
    async fn height(&self) -> Result<u32, SourceError> {
        self.fake.height().await
    }
    async fn at(&self, height: u32) -> Result<Option<At>, SourceError> {
        self.fake.at(height).await
    }
    async fn block(&self, hash: BlockHash) -> Result<PrevoutBlock, SourceError> {
        let next = self.next.lock().unwrap().take();
        if let Some(i) = next {
            let s = seed(&self.store, &*self.fake, &script(i), false, 10, 0)
                .await
                .unwrap();
            assert!(matches!(s, Seeded::Tracked { .. }));
        }
        self.fake.block(hash).await
    }
    async fn totals(
        &self,
        script: &Script,
        at: BlockHash,
    ) -> Result<Result<Totals, Option<ScriptSize>>, SourceError> {
        self.fake.totals(script, at).await
    }
    async fn page(&self, script: &Script, at: BlockHash) -> Result<Vec<TxSummary>, SourceError> {
        self.fake.page(script, at).await
    }

    async fn history(
        &self,
        script: &Script,
        at: At,
        rows: tokio::sync::mpsc::Sender<Vec<HistoryRow>>,
    ) -> Result<Result<(), Option<ScriptSize>>, SourceError> {
        Source::history(&*self.fake, script, at, rows).await
    }
}

#[tokio::test]
async fn a_script_seeded_while_a_block_is_read_gets_that_block() {
    let mut rng = Rng(81);
    let fake = Arc::new(Fake::new(10, &mut rng));
    let mut dir = Temp::new();
    let store = Arc::new(dir.store.take().unwrap());
    seed(&store, &*fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    follow(&store, &*fake).await.unwrap();
    // The next block pays script 1, which is seeded after that block is read, before it is written.
    fake.push_txs(vec![(vec![], vec![out(1, 4_321)])]);
    let source = SeedDuringBlock {
        fake: Arc::clone(&fake),
        store: Arc::clone(&store),
        next: Mutex::new(Some(1)),
    };
    follow(&store, &source).await.unwrap();
    check(&store, &fake, "seeded during a block").await;
    let v = view(&store, sh(1)).await.unwrap().unwrap();
    assert_eq!(v.tracked.at.height, fake.tip());
    assert_eq!(v.txs.first().map(|r| r.value), Some(4_321));
}

/// The node with a reorg to a shorter chain, followed, inside the next totals call: the ledger's
/// tip falls below the seed's anchor while the seed waits for the node.
struct ShortenDuringTotals {
    fake: Arc<Fake>,
    store: Arc<Store>,
    by: Mutex<Option<u32>>,
}

impl Source for ShortenDuringTotals {
    async fn height(&self) -> Result<u32, SourceError> {
        self.fake.height().await
    }
    async fn at(&self, height: u32) -> Result<Option<At>, SourceError> {
        self.fake.at(height).await
    }
    async fn block(&self, hash: BlockHash) -> Result<PrevoutBlock, SourceError> {
        self.fake.block(hash).await
    }
    async fn totals(
        &self,
        script: &Script,
        at: BlockHash,
    ) -> Result<Result<Totals, Option<ScriptSize>>, SourceError> {
        let t = self.fake.totals(script, at).await;
        let by = self.by.lock().unwrap().take();
        if let Some(by) = by {
            self.fake.pop(by);
            follow(&self.store, &*self.fake).await.unwrap();
        }
        t
    }
    async fn page(&self, script: &Script, at: BlockHash) -> Result<Vec<TxSummary>, SourceError> {
        self.fake.page(script, at).await
    }

    async fn history(
        &self,
        script: &Script,
        at: At,
        rows: tokio::sync::mpsc::Sender<Vec<HistoryRow>>,
    ) -> Result<Result<(), Option<ScriptSize>>, SourceError> {
        Source::history(&*self.fake, script, at, rows).await
    }
}

#[tokio::test]
async fn a_seed_whose_anchor_is_undone_below_the_tip_is_moved_not_a_panic() {
    let mut rng = Rng(111);
    let fake = Arc::new(Fake::new(20, &mut rng));
    let mut dir = Temp::new();
    let store = Arc::new(dir.store.take().unwrap());
    seed(&store, &*fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    for _ in 0..3 {
        fake.push(&mut rng);
    }
    follow(&store, &*fake).await.unwrap();
    // Anchored one below the tip; three blocks leave while the node adds it up.
    let source = ShortenDuringTotals {
        fake: Arc::clone(&fake),
        store: Arc::clone(&store),
        by: Mutex::new(Some(3)),
    };
    let r = seed(&store, &source, &script(1), false, 10, 0).await;
    assert!(matches!(r, Err(Error::Moved)), "{r:?}");
    assert!(tracked(&store, sh(1)).await.unwrap().is_none());
    check(&store, &fake, "after the shortening").await;
}

#[tokio::test]
async fn reorgs_up_to_the_undo_depth_are_undone_and_deeper_ones_reset() {
    for (depth, reset) in [
        (UNDO_DEPTH - 1, false),
        (UNDO_DEPTH, false),
        (UNDO_DEPTH + 1, true),
    ] {
        let mut rng = Rng(91 + u64::from(depth));
        let fake = Fake::new(10, &mut rng);
        let t = Temp::new();
        seed(t.store(), &fake, &script(0), false, 10, 0)
            .await
            .unwrap();
        for _ in 0..UNDO_DEPTH + 20 {
            fake.push(&mut rng);
        }
        follow(t.store(), &fake).await.unwrap();
        fake.pop(depth);
        for _ in 0..=depth {
            fake.push(&mut rng);
        }
        let f = follow(t.store(), &fake).await.unwrap();
        assert_eq!(f.reset, reset, "depth {depth}");
        if !reset {
            assert_eq!(f.undone, depth);
        }
        check(t.store(), &fake, &format!("depth {depth}")).await;
    }
}

#[tokio::test]
async fn a_refused_seed_tracks_nothing() {
    let mut rng = Rng(51);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    fake.refuse.lock().unwrap().insert(hex(2));
    let s = seed(t.store(), &fake, &script(2), true, 10, 0)
        .await
        .unwrap();
    assert_eq!(
        s,
        Seeded::Refused(Some(ScriptSize {
            creates: 20_000,
            cap: 10_000
        }))
    );
    assert_eq!(count(t.store()).await.unwrap(), 0);
    assert!(matches!(
        seed(t.store(), &fake, &script(3), false, 10, 0)
            .await
            .unwrap(),
        Seeded::Tracked { .. }
    ));
    assert_eq!(
        seed(t.store(), &fake, &script(3), false, 10, 0)
            .await
            .unwrap(),
        Seeded::Already
    );
}

#[tokio::test]
async fn a_full_ledger_drops_the_least_recently_viewed() {
    let mut rng = Rng(61);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    for (i, now) in [(0, 100), (1, 200)] {
        seed(t.store(), &fake, &script(i), false, 2, now)
            .await
            .unwrap();
    }
    // Script 0 was viewed after script 1 was seeded: 1 is now the least recent.
    touch(t.store(), sh(0), 300).await.unwrap();
    let s = seed(t.store(), &fake, &script(2), false, 2, 400)
        .await
        .unwrap();
    assert!(matches!(s, Seeded::Tracked { evicted: 1, .. }));
    assert!(tracked(t.store(), sh(1)).await.unwrap().is_none());
    assert!(tracked(t.store(), sh(0)).await.unwrap().is_some());
    assert!(tracked(t.store(), sh(2)).await.unwrap().is_some());
    fake.push(&mut rng);
    follow(t.store(), &fake).await.unwrap();
    check(t.store(), &fake, "after eviction").await;
}

#[tokio::test]
async fn the_newest_rows_stay_at_the_window_even_from_one_block() {
    let mut rng = Rng(71);
    let fake = Fake::new(5, &mut rng);
    let t = Temp::new();
    seed(t.store(), &fake, &script(0), true, 10, 0)
        .await
        .unwrap();
    // 150 transactions paying it in one block, then 150 spending from it in the next.
    fake.push_txs((0..150).map(|_| (vec![], vec![out(0, 10)])).collect());
    fake.push_txs(
        (0..150)
            .map(|_| {
                (
                    vec![PrevoutIn {
                        prevout: Some(out(0, 10)),
                    }],
                    vec![out(5, 9)],
                )
            })
            .collect(),
    );
    follow(t.store(), &fake).await.unwrap();
    let v = view(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(v.txs.len(), WINDOW);
    check(t.store(), &fake, "window").await;
    fake.push_txs((0..300).map(|_| (vec![], vec![out(0, 1)])).collect());
    follow(t.store(), &fake).await.unwrap();
    let v = view(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(v.txs.len(), WINDOW);
    assert!(v.txs.iter().all(|r| r.height == fake.tip()));
    check(t.store(), &fake, "one big block").await;
}

/// A malformed node answer is an error, never a panic or a wrong total.
#[test]
fn totals_out_of_range_are_refused() {
    let block = PrevoutBlock {
        hash: BlockHash::all_zeros(),
        height: 1,
        time: 0,
        previousblockhash: None,
        tx: vec![PrevoutTx {
            txid: Txid::all_zeros(),
            vin: vec![],
            vout: vec![
                PrevoutOut {
                    value: Amount::from_sat(u64::MAX),
                    script_pub_key: ScriptHexText { hex: hex(0) },
                },
                PrevoutOut {
                    value: Amount::from_sat(1),
                    script_pub_key: ScriptHexText {
                        hex: hex(0).to_ascii_uppercase(),
                    },
                },
            ],
        }],
    };
    let map = HashMap::from([(hex(0), sh(0))]);
    assert!(matches!(effects(&block, &map), Err(Error::OutOfRange)));
}

// Against a real rbitcoin on regtest (docs/REGTEST.md), the property above with the node's own
// totals as the oracle:
//   REGTEST_PROJECT=<name> dev/regtest/regtest.py scenario
//   eval "$(REGTEST_PROJECT=<name> dev/regtest/regtest.py env | sed 's/^/export /')"
//   REGTEST_PROJECT=<name> cargo test -p engine -- --ignored --nocapture ledger::tests::regtest::<test>
// One test at a time, each after a fresh `scenario`: they mine and reorg the same node.
mod regtest {
    use super::*;
    use node::esplora::{Esplora, ScriptRef};
    use node::rpc::{Limits, Rpc};
    use std::time::Duration;

    fn regtest(args: &[&str]) -> String {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let out = std::process::Command::new("python3")
            .arg(root.join("dev/regtest/regtest.py"))
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    fn var(k: &str) -> String {
        std::env::var(k).unwrap()
    }

    fn source() -> NodeSource {
        let limits = Limits {
            timeout: Duration::from_secs(60),
            max_concurrent: 1,
            ..Limits::default()
        };
        NodeSource {
            rpc: Rpc::with_limits(
                &var("REGTEST_RPC_HOST"),
                var("REGTEST_RPC_PORT").parse().unwrap(),
                &var("REGTEST_RPC_USER"),
                &var("REGTEST_RPC_PASSWORD"),
                limits,
            )
            .unwrap(),
            esplora: Esplora::new(&var("REGTEST_ESPLORA_URL")).unwrap(),
            electrum: var("REGTEST_ELECTRUM_ADDR"),
            uncapped: Default::default(),
        }
    }

    fn rpc_call(method: &str, params: serde_json::Value) {
        let url = format!(
            "http://{}:{}/",
            var("REGTEST_RPC_HOST"),
            var("REGTEST_RPC_PORT")
        );
        let body =
            serde_json::json!({"jsonrpc": "1.0", "id": 1, "method": method, "params": params})
                .to_string();
        let out = std::process::Command::new("curl")
            .args([
                "-s",
                "-u",
                &format!(
                    "{}:{}",
                    var("REGTEST_RPC_USER"),
                    var("REGTEST_RPC_PASSWORD")
                ),
                "-d",
                &body,
                &url,
            ])
            .output()
            .unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(text.contains(r#""error":null"#), "{method}: {text}");
    }

    /// Every tracked script against the node at the ledger's tip: totals, and the newest
    /// transactions as an exact prefix of the node's own history pages.
    async fn check_node(store: &Store, node: &NodeSource, scripts: &[ScriptBuf], label: &str) {
        let mut checked = 0;
        for s in scripts {
            let Some(v) = view(store, ScriptHash::from_script(s)).await.unwrap() else {
                continue;
            };
            let at = v.tracked.at;
            assert_eq!(
                node.at(at.height).await.unwrap().map(|a| a.hash),
                Some(at.hash),
                "{label}: the ledger's tip is not the node's"
            );
            let r = ScriptRef::ScriptHash(ScriptHash::from_script(s));
            let stats = node
                .esplora
                .script_stats(r.clone(), Some(at.hash))
                .await
                .unwrap();
            assert_eq!(stats.tip.map(|t| t.hash), Some(at.hash));
            assert_eq!(
                v.tracked.totals,
                Totals::from(stats.value.chain_stats),
                "{label}: {s:?} at {}",
                at.height
            );
            // Pages until one reaches below the window's oldest block, then in block order: the
            // node lists a block's rows in an order of its own.
            let floor = v.txs.last().map_or(u32::MAX, |r| r.height);
            let mut history: Vec<TxRow> = Vec::new();
            let mut last = None;
            while !v.txs.is_empty() && history.last().is_none_or(|r| r.height >= floor) {
                let page = node
                    .esplora
                    .script_txs_summary(r.clone(), last, Some(at.hash))
                    .await
                    .unwrap()
                    .value;
                let Some(l) = page.last() else { break };
                last = Some(l.txid);
                history.extend(page.into_iter().map(|p| TxRow {
                    txid: p.txid,
                    height: p.height,
                    position: p.tx_position.unwrap(),
                    value: p.value,
                    time: u32::try_from(p.time).unwrap(),
                }));
            }
            history.sort_unstable_by_key(|r| std::cmp::Reverse((r.height, r.position)));
            assert_eq!(v.txs, history[..v.txs.len()], "{label}: rows");
            assert_eq!(v.points.last().unwrap().balance, v.tracked.totals.balance());
            checked += 1;
        }
        println!("{label}: {checked} scripts equal the node's totals and history");
    }

    fn mine(n: u32) {
        regtest(&["mine", &n.to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "regtest: needs a node from dev/regtest (see the comment above)"]
    async fn the_ledger_equals_the_node_across_reorgs_restarts_and_downtime() {
        let node = source();
        // The scenario's addresses (docs/REGTEST.md).
        let addr = |k: &str| {
            match k {
                "miner" => "bcrt1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqseac85",
                "p2wpkh" => "bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s",
                "p2tr" => "bcrt1pz9ml8p3h96z9hlvz0esm3uwdq9pxssmykz209jrg57znrdvx5y0shy3atk",
                _ => "2ND8PB9RrfCaAcjfjP1Y6nAgFd9zWHYX4DN",
            }
            .to_owned()
        };
        let script_of = |a: &str| {
            a.parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
                .unwrap()
                .require_network(bitcoin::Network::Regtest)
                .unwrap()
                .script_pubkey()
        };
        let scripts: Vec<ScriptBuf> = ["miner", "p2wpkh", "p2tr", "p2sh"]
            .iter()
            .map(|k| script_of(&addr(k)))
            .collect();
        let mut t = Temp::new();

        // Seeded at the node's tip, with the history page.
        for s in &scripts[..2] {
            let r = seed(t.store(), &node, s, true, 10, 0).await.unwrap();
            assert!(matches!(r, Seeded::Tracked { page: true, .. }), "{r:?}");
        }
        follow(t.store(), &node).await.unwrap();
        check_node(t.store(), &node, &scripts, "seeded").await;

        // Payments in and out (the miner script pays, its change comes back), two blocks.
        regtest(&["send", &addr("p2wpkh"), "150000"]);
        regtest(&["send", &addr("p2tr"), "250000"]);
        mine(1);
        regtest(&["send", &addr("p2wpkh"), "50000"]);
        mine(1);
        let f = follow(t.store(), &node).await.unwrap();
        assert_eq!(f.applied, 2);
        check_node(t.store(), &node, &scripts, "two blocks").await;

        // A third script joins with the ledger already running: its catch-up block is applied
        // to it alone.
        let r = seed(t.store(), &node, &scripts[2], true, 10, 0)
            .await
            .unwrap();
        assert!(matches!(r, Seeded::Tracked { .. }));
        check_node(t.store(), &node, &scripts, "joined").await;

        // A reorg three blocks deep, with the payments in the blocks that leave.
        regtest(&["send", &addr("p2wpkh"), "70000"]);
        regtest(&["send", &addr("p2tr"), "80000"]);
        mine(3);
        follow(t.store(), &node).await.unwrap();
        check_node(t.store(), &node, &scripts, "before the reorg").await;
        let height = node.height().await.unwrap();
        let fork = node.at(height - 2).await.unwrap().unwrap();
        rpc_call(
            "invalidateblock",
            serde_json::json!([fork.hash.to_string()]),
        );
        for _ in 0..4 {
            rpc_call("generateblock", serde_json::json!(["raw(51)", []]));
        }
        let f = follow(t.store(), &node).await.unwrap();
        assert_eq!((f.undone, f.applied), (3, 4), "{f:?}");
        check_node(t.store(), &node, &scripts, "after the reorg").await;
        // The payments return from the mempool in the next block.
        mine(1);
        follow(t.store(), &node).await.unwrap();
        check_node(t.store(), &node, &scripts, "payments mined again").await;

        // A restart mid-way: the store closes with blocks unfollowed, and opens again.
        regtest(&["send", &addr("p2sh"), "90000"]);
        mine(1);
        t.reopen().await;
        follow(t.store(), &node).await.unwrap();
        check_node(t.store(), &node, &scripts, "after a restart").await;

        // Down while blocks came and a reorg happened: caught up from the store on the way back.
        let store = t.store.take().unwrap();
        store.close().await;
        // The ledger's own tip leaves the chain, with the two blocks it had applied below it.
        let height = node.height().await.unwrap();
        let fork = node.at(height - 1).await.unwrap().unwrap();
        rpc_call(
            "invalidateblock",
            serde_json::json!([fork.hash.to_string()]),
        );
        regtest(&["send", &addr("p2wpkh"), "11000"]);
        regtest(&["send", &addr("p2tr"), "12000"]);
        mine(4);
        t.store = Some(Store::open(&t.dir, "regtest", StoreOptions::default()).unwrap());
        let f = follow(t.store(), &node).await.unwrap();
        assert_eq!((f.undone, f.applied), (2, 4), "{f:?}");
        check_node(t.store(), &node, &scripts, "caught up after downtime").await;
        // And the fourth, seeded last, from the same state.
        seed(t.store(), &node, &scripts[3], true, 10, 0)
            .await
            .unwrap();
        mine(1);
        follow(t.store(), &node).await.unwrap();
        check_node(t.store(), &node, &scripts, "all four").await;
    }

    /// Scripts taken from a totals answer, without a page, then filled: the list equals the
    /// node's own history, below and above the seed block, and stays so across a reorg.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "regtest: needs a node from dev/regtest (see the comment above)"]
    async fn scripts_seeded_from_an_answer_are_filled_with_the_nodes_history() {
        let node = source();
        let p2wpkh = "bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s";
        let miner = "bcrt1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqseac85";
        let scripts: Vec<ScriptBuf> = [miner, p2wpkh]
            .iter()
            .map(|a| {
                a.parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
                    .unwrap()
                    .require_network(bitcoin::Network::Regtest)
                    .unwrap()
                    .script_pubkey()
            })
            .collect();
        let t = Temp::new();
        for s in &scripts {
            let at = anchor(t.store(), &node).await.unwrap();
            let totals = node.totals(s, at.hash).await.unwrap().unwrap();
            let r = adopt(t.store(), &node, s, totals, at.hash, at.height, 10, 0)
                .await
                .unwrap();
            assert!(matches!(r, Seeded::Tracked { page: false, .. }), "{r:?}");
        }
        // Blocks since the seed, paying both.
        regtest(&["send", p2wpkh, "33000"]);
        mine(1);
        regtest(&["send", p2wpkh, "44000"]);
        mine(1);
        follow(t.store(), &node).await.unwrap();
        check_node(t.store(), &node, &scripts, "seeded from answers").await;
        for s in &scripts {
            let f = fill(t.store(), &node, ScriptHash::from_script(s))
                .await
                .unwrap();
            println!("filled: {f:?}");
            assert!(
                matches!(f, Filled::Joined { rows, .. } if rows > 0),
                "{f:?}"
            );
            let v = view(t.store(), ScriptHash::from_script(s))
                .await
                .unwrap()
                .unwrap();
            assert!(before_seed(&v) > 0 && v.txs.len() > before_seed(&v));
        }
        check_node(t.store(), &node, &scripts, "filled").await;
        // A reorg two blocks deep, above the seed block.
        let height = node.height().await.unwrap();
        let fork = node.at(height - 1).await.unwrap().unwrap();
        rpc_call(
            "invalidateblock",
            serde_json::json!([fork.hash.to_string()]),
        );
        for _ in 0..3 {
            rpc_call("generateblock", serde_json::json!(["raw(51)", []]));
        }
        let f = follow(t.store(), &node).await.unwrap();
        assert_eq!((f.undone, f.applied), (2, 3), "{f:?}");
        check_node(t.store(), &node, &scripts, "filled, after a reorg").await;
        mine(1);
        follow(t.store(), &node).await.unwrap();
        check_node(t.store(), &node, &scripts, "payments mined again").await;
        for s in &scripts {
            assert_eq!(
                fill(t.store(), &node, ScriptHash::from_script(s))
                    .await
                    .unwrap(),
                Filled::Nothing
            );
        }
    }

    /// The node's own history of `s` at the ledger's tip, two ways: its Electrum list, and its
    /// Esplora chain pages read newest first to the end and turned round. Both must be the same.
    async fn node_history(store: &Store, node: &NodeSource, s: &ScriptBuf) -> Vec<HistoryRow> {
        let sh = ScriptHash::from_script(s);
        let at = tracked(store, sh).await.unwrap().unwrap().at;
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let listing = node.history(s, at, tx);
        let collect = async move {
            let mut all = Vec::new();
            while let Some(b) = rx.recv().await {
                all.extend(b);
            }
            all
        };
        let (r, listed) = tokio::join!(listing, collect);
        r.unwrap().unwrap();
        let mut paged = Vec::new();
        let mut last = None;
        loop {
            let page = node
                .esplora
                .script_txs_chain(ScriptRef::ScriptHash(sh), last, Some(at.hash))
                .await
                .unwrap()
                .value;
            let Some(l) = page.last() else { break };
            last = Some(l.txid);
            paged.extend(page.iter().map(|t| HistoryRow {
                height: t.status.block_height.unwrap(),
                txid: t.txid,
            }));
        }
        paged.reverse();
        assert_eq!(listed, paged, "the node's list and its pages disagree");
        listed
    }

    async fn check_whole(store: &Store, node: &NodeSource, scripts: &[ScriptBuf], label: &str) {
        for s in scripts {
            let sh = ScriptHash::from_script(s);
            let t = tracked(store, sh).await.unwrap().unwrap();
            assert!(matches!(t.history, History::Whole { .. }), "{label}");
            let kept = kept_history_of(store, sh).await;
            let theirs = node_history(store, node, s).await;
            assert_eq!(kept, theirs, "{label}: {s:?}");
            assert_eq!(kept.len() as u64, t.totals.tx_count, "{label}");
            // Rows that share a block show the order within it.
            let shared = kept
                .windows(2)
                .filter(|w| w[0].height == w[1].height)
                .count();
            println!(
                "{label}: {} rows equal the node's list and its pages ({shared} share a block)",
                kept.len()
            );
        }
    }

    /// Whole histories taken from the node's list and kept from blocks equal the node's own
    /// history, its list and its pages alike, through payments, several to one address in a block,
    /// and a reorg.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "regtest: needs a node from dev/regtest (see the comment above)"]
    async fn whole_histories_equal_the_nodes_across_a_reorg() {
        let node = source();
        let p2wpkh = "bcrt1qw5puevk8wgy5t9d2qjg6frpfmesuqnnpx95u7s";
        let miner = "bcrt1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqseac85";
        let scripts: Vec<ScriptBuf> = [miner, p2wpkh]
            .iter()
            .map(|a| {
                a.parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
                    .unwrap()
                    .require_network(bitcoin::Network::Regtest)
                    .unwrap()
                    .script_pubkey()
            })
            .collect();
        let t = Temp::new();
        for s in &scripts {
            seed(t.store(), &node, s, false, 10, 0).await.unwrap();
        }
        mine(1);
        follow(t.store(), &node).await.unwrap();
        for s in &scripts {
            let r = history(
                t.store(),
                &node,
                ScriptHash::from_script(s),
                1_000_000,
                NOBODY,
                NOW,
            )
            .await
            .unwrap();
            assert!(matches!(r, Historied::Whole { .. }), "{r:?}");
        }
        check_whole(t.store(), &node, &scripts, "taken").await;
        // Several payments to one address in one block, then another.
        for sats in ["21000", "22000", "23000", "24000"] {
            regtest(&["send", p2wpkh, sats]);
        }
        mine(1);
        regtest(&["send", p2wpkh, "25000"]);
        mine(1);
        follow(t.store(), &node).await.unwrap();
        check_whole(t.store(), &node, &scripts, "followed").await;
        // A reorg two blocks deep, taking those payments back to the mempool.
        let height = node.height().await.unwrap();
        let fork = node.at(height - 1).await.unwrap().unwrap();
        rpc_call(
            "invalidateblock",
            serde_json::json!([fork.hash.to_string()]),
        );
        for _ in 0..3 {
            rpc_call("generateblock", serde_json::json!(["raw(51)", []]));
        }
        let f = follow(t.store(), &node).await.unwrap();
        assert_eq!((f.undone, f.applied), (2, 3), "{f:?}");
        check_whole(t.store(), &node, &scripts, "after the reorg").await;
        mine(1);
        follow(t.store(), &node).await.unwrap();
        check_whole(t.store(), &node, &scripts, "mined again").await;
    }
}

#[tokio::test]
async fn totals_already_held_are_adopted_when_their_block_is_the_ledgers() {
    let mut rng = Rng(101);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    // Nothing tracked: any block of the node's chain will do.
    let at = fake.at(15).await.unwrap().unwrap();
    let s = adopt(
        t.store(),
        &fake,
        &script(0),
        fake.oracle(0, 15),
        at.hash,
        15,
        10,
        0,
    )
    .await
    .unwrap();
    assert!(matches!(s, Seeded::Tracked { page: false, .. }));
    follow(t.store(), &fake).await.unwrap();
    check(t.store(), &fake, "adopted into an empty ledger").await;
    // Tracked: a block the ledger holds is adopted, with the blocks since applied to it alone.
    fake.push(&mut rng);
    fake.push(&mut rng);
    follow(t.store(), &fake).await.unwrap();
    let held = fake.tip() - 1;
    let at = fake.at(held).await.unwrap().unwrap();
    let s = adopt(
        t.store(),
        &fake,
        &script(1),
        fake.oracle(1, held),
        at.hash,
        held,
        10,
        0,
    )
    .await
    .unwrap();
    assert!(matches!(s, Seeded::Tracked { .. }));
    check(t.store(), &fake, "adopted below the tip").await;
    // A block the ledger does not hold, or another block at its height, is not adopted.
    fake.push(&mut rng);
    let ahead = fake.tip();
    let at = fake.at(ahead).await.unwrap().unwrap();
    let r = adopt(
        t.store(),
        &fake,
        &script(2),
        fake.oracle(2, ahead),
        at.hash,
        ahead,
        10,
        0,
    )
    .await;
    assert!(matches!(r, Err(Error::Moved)));
    let r = adopt(
        t.store(),
        &fake,
        &script(2),
        Totals::default(),
        BlockHash::all_zeros(),
        held,
        10,
        0,
    )
    .await;
    assert!(matches!(r, Err(Error::Moved)));
    assert!(tracked(t.store(), sh(2)).await.unwrap().is_none());
}

#[test]
fn the_scripts_paid_most_are_counted_once_a_transaction() {
    let tx = |outs: Vec<PrevoutOut>| PrevoutTx {
        txid: Txid::all_zeros(),
        vin: vec![],
        vout: outs,
    };
    let op_return = PrevoutOut {
        value: Amount::ZERO,
        script_pub_key: ScriptHexText {
            hex: "6a04deadbeef".into(),
        },
    };
    let block = PrevoutBlock {
        hash: BlockHash::all_zeros(),
        height: 1,
        time: 0,
        previousblockhash: None,
        tx: vec![
            tx(vec![out(0, 1), out(0, 2), out(1, 1), op_return.clone()]),
            tx(vec![out(0, 1), out(1, 1), op_return.clone()]),
            tx(vec![out(0, 1), op_return]),
            tx(vec![out(2, 1)]),
        ],
    };
    let got: Vec<(String, u32)> = paid_most(&block, 5)
        .into_iter()
        .map(|(s, n)| (s.to_hex_string(), n))
        .collect();
    assert_eq!(got, vec![(hex(0), 3), (hex(1), 2)]);
    assert_eq!(paid_most(&block, 1).len(), 1);
}

/// Seeds script `i` as a totals answer does: the node's totals at a block the ledger holds, no
/// history page.
async fn answer(store: &Store, fake: &Fake, i: usize) -> Seeded {
    let at = anchor(store, fake).await.unwrap();
    adopt(
        store,
        fake,
        &script(i),
        fake.oracle(i, at.height),
        at.hash,
        at.height,
        10,
        0,
    )
    .await
    .unwrap()
}

fn pays(i: usize, n: usize) -> Vec<(Vec<PrevoutIn>, Vec<PrevoutOut>)> {
    (0..n).map(|_| (vec![], vec![out(i, 1_000)])).collect()
}

/// Rows at or below the seed block: what a page added.
fn before_seed(v: &View) -> usize {
    v.txs
        .iter()
        .filter(|r| r.height <= v.tracked.seeded_height)
        .count()
}

fn pages(fake: &Fake) -> usize {
    fake.pages.load(Ordering::SeqCst)
}

/// A fake chain on which script 0 was paid in ten blocks before the seed.
fn paid_before(seed: u64) -> (Rng, Fake) {
    let mut rng = Rng(seed);
    let fake = Fake::new(20, &mut rng);
    for _ in 0..10 {
        fake.push_txs(pays(0, 1));
    }
    (rng, fake)
}

#[tokio::test]
async fn a_script_seeded_from_an_answer_is_filled_once_across_restarts() {
    let (mut rng, fake) = paid_before(201);
    let mut t = Temp::new();
    assert!(matches!(
        answer(t.store(), &fake, 0).await,
        Seeded::Tracked { page: false, .. }
    ));
    assert!(
        !view(t.store(), sh(0))
            .await
            .unwrap()
            .unwrap()
            .tracked
            .filled
    );
    assert_eq!(unfilled(t.store()).await.unwrap(), vec![sh(0)]);
    // Blocks since the seed pay it, and a restart comes before the fill.
    fake.push_txs(pays(0, 3));
    fake.push(&mut rng);
    follow(t.store(), &fake).await.unwrap();
    t.reopen().await;
    let f = fill(t.store(), &fake, sh(0)).await.unwrap();
    assert!(
        matches!(f, Filled::Joined { rows, .. } if rows > 0),
        "{f:?}"
    );
    check(t.store(), &fake, "filled").await;
    let v = view(t.store(), sh(0)).await.unwrap().unwrap();
    assert!(v.tracked.filled);
    assert!(before_seed(&v) > 0);
    assert!(v.txs.len() > before_seed(&v));
    assert!(unfilled(t.store()).await.unwrap().is_empty());
    // Never asked again, nor after another restart.
    assert_eq!(
        fill(t.store(), &fake, sh(0)).await.unwrap(),
        Filled::Nothing
    );
    t.reopen().await;
    assert_eq!(
        fill(t.store(), &fake, sh(0)).await.unwrap(),
        Filled::Nothing
    );
    assert_eq!(pages(&fake), 1);
    fake.push_txs(pays(0, 2));
    follow(t.store(), &fake).await.unwrap();
    check(t.store(), &fake, "a block after the fill").await;
}

#[tokio::test]
async fn a_fill_stays_exact_across_reorgs_before_and_after_it() {
    let (mut rng, fake) = paid_before(211);
    let t = Temp::new();
    answer(t.store(), &fake, 0).await;
    for _ in 0..3 {
        fake.push_txs(pays(0, 2));
    }
    follow(t.store(), &fake).await.unwrap();
    // Two blocks paying it leave before the fill: its rows and its count since the seed fall
    // together.
    fake.pop(2);
    fake.push(&mut rng);
    fake.push_txs(pays(0, 1));
    fake.push(&mut rng);
    follow(t.store(), &fake).await.unwrap();
    let f = fill(t.store(), &fake, sh(0)).await.unwrap();
    assert!(matches!(f, Filled::Joined { .. }), "{f:?}");
    check(t.store(), &fake, "filled after a reorg").await;
    // And after it: the page's rows lie below every block undone.
    fake.pop(3);
    for _ in 0..4 {
        fake.push_txs(pays(0, 1));
    }
    follow(t.store(), &fake).await.unwrap();
    check(t.store(), &fake, "a reorg after the fill").await;
    assert!(before_seed(&view(t.store(), sh(0)).await.unwrap().unwrap()) > 0);
}

#[tokio::test]
async fn a_window_full_since_the_seed_takes_no_page() {
    let (_, fake) = paid_before(221);
    let t = Temp::new();
    answer(t.store(), &fake, 0).await;
    fake.push_txs(pays(0, WINDOW + 10));
    follow(t.store(), &fake).await.unwrap();
    assert!(matches!(
        fill(t.store(), &fake, sh(0)).await.unwrap(),
        Filled::Skipped { reason: "full", .. }
    ));
    assert_eq!(pages(&fake), 0);
    assert!(
        view(t.store(), sh(0))
            .await
            .unwrap()
            .unwrap()
            .tracked
            .filled
    );
    check(t.store(), &fake, "full").await;
}

#[tokio::test]
async fn a_window_cut_then_shortened_by_a_reorg_takes_no_page() {
    let (mut rng, fake) = paid_before(231);
    let t = Temp::new();
    answer(t.store(), &fake, 0).await;
    // Cut at the window, then a block of its rows undone: fewer than the window, with a gap.
    fake.push_txs(pays(0, WINDOW + 10));
    fake.push_txs(pays(0, 5));
    follow(t.store(), &fake).await.unwrap();
    fake.pop(1);
    fake.push(&mut rng);
    follow(t.store(), &fake).await.unwrap();
    let v = view(t.store(), sh(0)).await.unwrap().unwrap();
    assert!(v.txs.len() < WINDOW);
    assert!(matches!(
        fill(t.store(), &fake, sh(0)).await.unwrap(),
        Filled::Skipped { reason: "gap", .. }
    ));
    assert_eq!(pages(&fake), 0);
    check(t.store(), &fake, "cut").await;
}

#[tokio::test]
async fn a_failed_page_is_tried_again_and_then_filled() {
    let (_, fake) = paid_before(241);
    let t = Temp::new();
    // The seed's own page fails: it is tracked without it.
    fake.fail_pages.store(2, Ordering::SeqCst);
    let s = seed(t.store(), &fake, &script(0), true, 10, 0)
        .await
        .unwrap();
    assert!(matches!(s, Seeded::Tracked { page: false, .. }), "{s:?}");
    let r = fill(t.store(), &fake, sh(0)).await;
    assert!(matches!(r, Err(Error::Source(SourceError::Busy))), "{r:?}");
    let v = view(t.store(), sh(0)).await.unwrap().unwrap();
    assert!(!v.tracked.filled);
    assert_eq!(before_seed(&v), 0);
    let f = fill(t.store(), &fake, sh(0)).await.unwrap();
    assert!(
        matches!(f, Filled::Joined { rows, .. } if rows > 0),
        "{f:?}"
    );
    assert_eq!(pages(&fake), 3);
    check(t.store(), &fake, "filled on the retry").await;
}

#[tokio::test]
async fn a_page_whose_rows_overlap_the_kept_ones_adds_each_row_once() {
    let (_, fake) = paid_before(251);
    let t = Temp::new();
    answer(t.store(), &fake, 0).await;
    fake.push_txs(pays(0, 2));
    fake.push_txs(pays(0, 1));
    follow(t.store(), &fake).await.unwrap();
    let seeded = view(t.store(), sh(0))
        .await
        .unwrap()
        .unwrap()
        .tracked
        .seeded_height;
    let seed_hash = fake.at(seeded).await.unwrap().unwrap().hash;
    // The node's page at the tip rather than the seed block: rows kept since the seed are in it.
    let tip = fake.at(fake.tip()).await.unwrap().unwrap();
    let rows = page_rows(fake.page(&script(0), tip.hash).await.unwrap(), tip.height).unwrap();
    assert!(rows.iter().any(|r| r.height > seeded));
    let f = t
        .store()
        .write(move |sql| db::fill(sql, sh(0), seeded, Some((seed_hash, &rows))))
        .await
        .unwrap();
    assert!(matches!(f, Filled::Joined { .. }), "{f:?}");
    let v = view(t.store(), sh(0)).await.unwrap().unwrap();
    let distinct: HashSet<Txid> = v.txs.iter().map(|r| r.txid).collect();
    assert_eq!(distinct.len(), v.txs.len());
    check(t.store(), &fake, "overlap").await;
}

/// The store as an older server left it: `0014_ledger_fill.sql`'s backfill run again over scripts
/// whose new columns are cleared.
async fn as_before_the_upgrade(store: &Store) {
    store
        .write(|sql| {
            sql.prepare("UPDATE ledger_scripts SET seeded_tx_count = NULL, filled = 0")?
                .execute([])?;
            let text: &'static str = include_str!("../store/migrations/0014_ledger_fill.sql");
            for stmt in text.split(';').filter(|s| s.contains("UPDATE")) {
                sql.prepare(stmt)?.execute([])?;
            }
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn scripts_kept_before_the_upgrade_are_filled_when_the_undo_record_proves_no_gap() {
    let (mut rng, fake) = paid_before(261);
    let t = Temp::new();
    // Script 0 from an answer; script 1 with its page; both a few blocks old.
    answer(t.store(), &fake, 0).await;
    fake.push_txs(vec![(vec![], vec![out(0, 5), out(1, 6)])]);
    follow(t.store(), &fake).await.unwrap();
    seed(t.store(), &fake, &script(1), true, 10, 0)
        .await
        .unwrap();
    fake.push_txs(pays(0, 2));
    fake.push(&mut rng);
    follow(t.store(), &fake).await.unwrap();
    as_before_the_upgrade(t.store()).await;
    // Script 1 held its page's rows: done. Script 0 is filled.
    assert_eq!(unfilled(t.store()).await.unwrap(), vec![sh(0)]);
    let before = pages(&fake);
    let f = fill(t.store(), &fake, sh(0)).await.unwrap();
    assert!(
        matches!(f, Filled::Joined { rows, .. } if rows > 0),
        "{f:?}"
    );
    assert_eq!(pages(&fake), before + 1);
    check(t.store(), &fake, "upgraded").await;
}

#[tokio::test]
async fn a_script_kept_before_the_upgrade_past_the_undo_record_takes_no_page() {
    let (mut rng, fake) = paid_before(271);
    let t = Temp::new();
    answer(t.store(), &fake, 0).await;
    for _ in 0..UNDO_DEPTH + 5 {
        fake.push(&mut rng);
    }
    follow(t.store(), &fake).await.unwrap();
    as_before_the_upgrade(t.store()).await;
    assert!(matches!(
        fill(t.store(), &fake, sh(0)).await.unwrap(),
        Filled::Skipped { reason: "gap", .. }
    ));
    assert_eq!(pages(&fake), 0);
    check(t.store(), &fake, "too old").await;
}

#[tokio::test]
async fn a_seed_block_older_than_the_ledgers_chain_is_the_nodes_below_its_tip() {
    let (_, fake) = paid_before(281);
    let t = Temp::new();
    answer(t.store(), &fake, 0).await;
    fake.push_txs(pays(0, 1));
    for _ in 0..UNDO_DEPTH + 5 {
        fake.push_txs(Vec::new());
    }
    follow(t.store(), &fake).await.unwrap();
    let f = fill(t.store(), &fake, sh(0)).await.unwrap();
    assert!(
        matches!(f, Filled::Joined { rows, .. } if rows > 0),
        "{f:?}"
    );
    let v = view(t.store(), sh(0)).await.unwrap().unwrap();
    assert!(v.tracked.seeded_height + UNDO_DEPTH < v.tracked.at.height);
    assert!(before_seed(&v) > 0);
    check(t.store(), &fake, "old seed block").await;
}

/// No bound worth the name, for tests that are not about it.
const ROWS: u64 = 1_000_000;
/// A `viewing` time no script has been viewed at or after: nothing is kept from being dropped.
const NOBODY: u64 = i64::MAX as u64;
/// When a list is taken, in tests that do not look at it.
const NOW: u64 = 1_800_000_000;

#[tokio::test]
async fn whole_histories_follow_the_chain_through_random_reorgs_and_restarts() {
    for seed_value in [3_u64, 8, 51] {
        let mut rng = Rng(0x51_7cc1_b727_220a ^ seed_value);
        let fake = Fake::new(30, &mut rng);
        let mut t = Temp::new();
        let mut whole = 0;
        for step in 0..250 {
            match rng.below(100) {
                0..55 => fake.push(&mut rng),
                55..65 => {
                    let depth = 1 + u32::try_from(rng.below(4)).unwrap();
                    fake.pop(depth);
                    for _ in 0..depth + u32::try_from(rng.below(2)).unwrap() {
                        fake.push(&mut rng);
                    }
                }
                65..78 => {
                    let i = usize::try_from(rng.below(TRACKABLE as u64)).unwrap();
                    match seed(t.store(), &fake, &script(i), false, TRACKABLE, step).await {
                        Ok(_) | Err(Error::Moved) => {}
                        Err(e) => panic!("seed: {e}"),
                    }
                }
                78..92 => {
                    let i = usize::try_from(rng.below(TRACKABLE as u64)).unwrap();
                    // Sometimes a block lands, or the tip is replaced, while the list streams in.
                    let hook: Option<Hook> = match rng.below(3) {
                        0 => Some(Box::new(|f: &Fake| f.push_txs(pays(0, 2)))),
                        1 => Some(Box::new(|f: &Fake| {
                            f.pop(1);
                            f.push_txs(pays(1, 1));
                            f.push_txs(pays(0, 1));
                        })),
                        _ => None,
                    };
                    *fake.during_list.lock().unwrap() = hook;
                    let pending = history(t.store(), &fake, sh(i), ROWS, NOBODY, NOW);
                    tokio::pin!(pending);
                    let r = loop {
                        tokio::select! {
                            r = &mut pending => break r,
                            () = tokio::task::yield_now() => {
                                follow(t.store(), &fake).await.unwrap();
                            }
                        }
                    };
                    *fake.during_list.lock().unwrap() = None;
                    match r {
                        Ok(Historied::Whole { .. }) => whole += 1,
                        Ok(_) | Err(Error::Moved) => {}
                        Err(e) => panic!("history: {e}"),
                    }
                }
                92..95 => t.reopen().await,
                _ => {}
            }
            if rng.below(10) == 0 {
                // A restart between taking a history and following blocks.
                t.reopen().await;
                history_restarted(t.store()).await.unwrap();
            }
            follow(t.store(), &fake).await.unwrap();
            let label = format!("seed {seed_value} step {step}");
            check(t.store(), &fake, &label).await;
            check_history(t.store(), &fake, &label).await;
        }
        assert!(whole > 3, "seed {seed_value}: only {whole} whole histories");
    }
}

#[tokio::test]
async fn a_reorg_below_the_lists_block_while_it_streams_starts_it_again() {
    let mut rng = Rng(201);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 5));
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    fake.push_txs(pays(0, 2));
    fake.push_txs(pays(1, 1));
    fake.push_txs(pays(0, 1));
    follow(t.store(), &fake).await.unwrap();
    // Two blocks leave, taking the list's block with them (one below the tip), after its first
    // batch; the seed block stays.
    *fake.during_list.lock().unwrap() = Some(Box::new(|f: &Fake| {
        f.pop(2);
        f.push_txs(pays(0, 3));
        f.push_txs(pays(0, 1));
        f.push_txs(vec![]);
    }));
    let pending = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW);
    tokio::pin!(pending);
    let r = loop {
        tokio::select! {
            r = &mut pending => break r,
            () = tokio::task::yield_now() => { follow(t.store(), &fake).await.unwrap(); }
        }
    };
    assert!(matches!(r, Err(Error::Moved)), "{r:?}");
    assert_eq!(history_table_rows(t.store()).await, 0);
    let s = tracked(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(s.history, History::None);
    // Taken again, it is whole and exact.
    follow(t.store(), &fake).await.unwrap();
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    assert!(matches!(r, Historied::Whole { .. }), "{r:?}");
    check_history(t.store(), &fake, "taken again").await;
    assert!(!kept_history(t.store(), 0).await.is_empty());
}

#[tokio::test]
async fn a_restart_while_a_list_is_taken_drops_it_and_it_is_taken_again() {
    let mut rng = Rng(211);
    let fake = Fake::new(20, &mut rng);
    let mut t = Temp::new();
    fake.push_txs(pays(0, 4));
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    follow(t.store(), &fake).await.unwrap();
    // Begun, a batch stored, then the process ends.
    let tip = tracked(t.store(), sh(0)).await.unwrap().unwrap().at;
    let rows = listed(&fake, 0, tip.height);
    t.store()
        .write(move |sql| {
            let db::Begun::Taking { hid, .. } =
                db::history_begin(sql, sh(0), tip, tip.height, &[], ROWS, NOBODY)?
            else {
                panic!("not begun");
            };
            db::history_rows(sql, sh(0), hid, &rows[..2])?;
            Ok(())
        })
        .await
        .unwrap();
    t.reopen().await;
    // Blocks are followed before the restart is noticed: the half list is never served.
    fake.push_txs(pays(0, 2));
    follow(t.store(), &fake).await.unwrap();
    let s = tracked(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(s.history, History::Taking);
    history_restarted(t.store()).await.unwrap();
    assert_eq!(history_table_rows(t.store()).await, 0);
    assert_eq!(
        unhistoried(t.store()).await.unwrap(),
        vec![(sh(0), History::None, None)]
    );
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    assert!(matches!(r, Historied::Whole { .. }), "{r:?}");
    // And a restart after it is whole keeps it, through more blocks and a reorg.
    t.reopen().await;
    history_restarted(t.store()).await.unwrap();
    fake.push_txs(pays(0, 3));
    follow(t.store(), &fake).await.unwrap();
    fake.pop(1);
    fake.push_txs(pays(0, 1));
    follow(t.store(), &fake).await.unwrap();
    check_history(t.store(), &fake, "after restarts").await;
    assert_eq!(
        kept_history(t.store(), 0).await.len(),
        listed(&fake, 0, fake.tip()).len()
    );
    assert!(unhistoried(t.store()).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_list_leaves_nothing_and_is_taken_on_the_next_try() {
    let mut rng = Rng(221);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 4));
    answer(t.store(), &fake, 0).await;
    follow(t.store(), &fake).await.unwrap();
    fake.fail_lists.store(1, Ordering::SeqCst);
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW).await;
    assert!(matches!(r, Err(Error::Source(SourceError::Busy))), "{r:?}");
    // A list a row short of the totals is not kept either.
    fake.short_lists.store(1, Ordering::SeqCst);
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW).await;
    assert!(matches!(r, Err(Error::Mismatch)), "{r:?}");
    assert_eq!(history_table_rows(t.store()).await, 0);
    let s = tracked(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(s.history, History::None);
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    let Historied::Whole { rows, .. } = r else {
        panic!("{r:?}")
    };
    assert_eq!(rows, s.totals.tx_count);
    let s = tracked(t.store(), sh(0)).await.unwrap().unwrap();
    assert!(matches!(s.history, History::Whole { .. }));
    // Asked once: never again.
    let lists = fake.lists.load(Ordering::SeqCst);
    assert_eq!(
        history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
            .await
            .unwrap(),
        Historied::Nothing
    );
    assert_eq!(fake.lists.load(Ordering::SeqCst), lists);
    check_history(t.store(), &fake, "after a failure").await;
}

#[tokio::test]
async fn a_refused_list_leaves_the_newest_page_to_the_fill() {
    let mut rng = Rng(231);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 4));
    answer(t.store(), &fake, 0).await;
    fake.push_txs(pays(0, 1));
    follow(t.store(), &fake).await.unwrap();
    fake.refuse_lists.store(true, Ordering::SeqCst);
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    assert_eq!(
        r,
        Historied::Refused(Some(ScriptSize {
            creates: 20_000,
            cap: 10_000
        }))
    );
    let s = tracked(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(s.history, History::Refused);
    assert_eq!(history_table_rows(t.store()).await, 0);
    // The fill takes the newest page instead, and the list may be asked again later.
    assert_eq!(unfilled(t.store()).await.unwrap(), vec![sh(0)]);
    assert!(matches!(
        fill(t.store(), &fake, sh(0)).await.unwrap(),
        Filled::Joined { .. }
    ));
    assert_eq!(
        unhistoried(t.store()).await.unwrap(),
        vec![(sh(0), History::Refused, None)]
    );
    fake.refuse_lists.store(false, Ordering::SeqCst);
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    assert!(matches!(r, Historied::Whole { .. }), "{r:?}");
    check_history(t.store(), &fake, "after a refusal").await;
}

#[tokio::test]
async fn the_bound_drops_the_least_recently_viewed_history() {
    let mut rng = Rng(241);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 4));
    fake.push_txs(pays(1, 4));
    fake.push_txs(pays(2, 4));
    fake.push_txs(pays(3, 30));
    for (i, now) in [(0, 100), (1, 200), (2, 300), (3, 400)] {
        seed(t.store(), &fake, &script(i), false, 10, now)
            .await
            .unwrap();
    }
    follow(t.store(), &fake).await.unwrap();
    let count_of = |i: usize| {
        let t = &t;
        async move {
            tracked(t.store(), sh(i))
                .await
                .unwrap()
                .unwrap()
                .totals
                .tx_count
        }
    };
    let (c0, c1, c2, c3) = (
        count_of(0).await,
        count_of(1).await,
        count_of(2).await,
        count_of(3).await,
    );
    // Room for two of the first three.
    let max = (c0 + c1).max(c1 + c2).max(c0 + c2);
    assert!(c0 + c1 + c2 > max, "{c0} {c1} {c2}");
    for i in [0, 1] {
        assert!(matches!(
            history(t.store(), &fake, sh(i), max, NOBODY, NOW)
                .await
                .unwrap(),
            Historied::Whole { evicted: 0, .. }
        ));
    }
    // Script 0 viewed since: script 1 is the least recently viewed and leaves for script 2.
    touch(t.store(), sh(0), 500).await.unwrap();
    let r = history(t.store(), &fake, sh(2), max, NOBODY, NOW)
        .await
        .unwrap();
    assert!(matches!(r, Historied::Whole { evicted: 1, .. }), "{r:?}");
    let s1 = tracked(t.store(), sh(1)).await.unwrap().unwrap();
    assert_eq!(s1.history, History::Dropped);
    assert!(kept_history(t.store(), 1).await.is_empty());
    let held = i64::try_from(c0 + c2).unwrap();
    assert_eq!(history_table_rows(t.store()).await, held);
    // Dropped, it may be taken again (when viewed, the server decides), with when it was taken;
    // meanwhile it takes the newest page.
    assert!(
        unhistoried(t.store())
            .await
            .unwrap()
            .contains(&(sh(1), History::Dropped, Some(NOW)))
    );
    assert!(unfilled(t.store()).await.unwrap().contains(&sh(1)));
    // Larger than the whole bound: not asked at all.
    assert!(c3 > max, "{c3} {max}");
    let lists = fake.lists.load(Ordering::SeqCst);
    assert_eq!(
        history(t.store(), &fake, sh(3), max, NOBODY, NOW)
            .await
            .unwrap(),
        Historied::TooLarge
    );
    assert_eq!(fake.lists.load(Ordering::SeqCst), lists);
    assert_eq!(
        tracked(t.store(), sh(3)).await.unwrap().unwrap().history,
        History::TooLarge
    );
    assert_eq!(history_table_rows(t.store()).await, held);
    // Blocks make the kept ones grow past the bound: the least recently viewed leaves.
    fake.push_txs(pays(0, 2));
    fake.push_txs(pays(2, 2));
    follow(t.store(), &fake).await.unwrap();
    assert_eq!(bound(t.store(), c0 + c2 + 1, NOBODY).await.unwrap(), 1);
    assert_eq!(
        tracked(t.store(), sh(2)).await.unwrap().unwrap().history,
        History::Dropped
    );
    check_history(t.store(), &fake, "within the bound").await;
    assert_eq!(bound(t.store(), c0 + c2 + 1, NOBODY).await.unwrap(), 0);
}

#[tokio::test]
async fn a_dropped_script_takes_its_history_rows_with_it() {
    let mut rng = Rng(251);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 4));
    fake.push_txs(pays(1, 4));
    seed(t.store(), &fake, &script(0), false, 1, 100)
        .await
        .unwrap();
    follow(t.store(), &fake).await.unwrap();
    history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    assert!(history_table_rows(t.store()).await > 0);
    // A ledger of one: seeding script 1 drops script 0, and its rows.
    seed(t.store(), &fake, &script(1), false, 1, 200)
        .await
        .unwrap();
    assert_eq!(history_table_rows(t.store()).await, 0);
}

#[tokio::test]
async fn a_reorg_through_the_lists_block_keeps_the_whole_history_whole() {
    let mut rng = Rng(261);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 3));
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    fake.push_txs(pays(0, 2));
    fake.push_txs(pays(0, 2));
    follow(t.store(), &fake).await.unwrap();
    // Pinned one below the tip.
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    let Historied::Whole { height, .. } = r else {
        panic!("{r:?}")
    };
    assert_eq!(height, fake.tip() - 1);
    // Both the list's block and the tip leave, for blocks that pay it differently.
    fake.pop(2);
    fake.push_txs(pays(0, 1));
    fake.push_txs(pays(0, 4));
    fake.push_txs(pays(0, 1));
    follow(t.store(), &fake).await.unwrap();
    check_history(t.store(), &fake, "through the list's block").await;
    assert_eq!(
        kept_history(t.store(), 0).await.len(),
        listed(&fake, 0, fake.tip()).len()
    );
}

#[tokio::test]
async fn a_list_that_outgrows_the_bound_while_it_streams_is_dropped() {
    let mut rng = Rng(271);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 8));
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    follow(t.store(), &fake).await.unwrap();
    let n = tracked(t.store(), sh(0))
        .await
        .unwrap()
        .unwrap()
        .totals
        .tx_count;
    // Exactly the bound when it begins; a block paying it lands while it streams.
    *fake.during_list.lock().unwrap() = Some(Box::new(|f: &Fake| f.push_txs(pays(0, 1))));
    let pending = history(t.store(), &fake, sh(0), n, NOBODY, NOW);
    tokio::pin!(pending);
    let r = loop {
        tokio::select! {
            r = &mut pending => break r,
            () = tokio::task::yield_now() => {
                follow(t.store(), &fake).await.unwrap();
                bound(t.store(), n, NOBODY).await.unwrap();
            }
        }
    };
    assert!(
        matches!(r, Ok(Historied::TooLarge) | Err(Error::Moved)),
        "{r:?}"
    );
    assert_eq!(history_table_rows(t.store()).await, 0);
    assert_eq!(
        tracked(t.store(), sh(0)).await.unwrap().unwrap().history,
        History::Dropped
    );
}

#[tokio::test]
async fn a_list_longer_than_the_totals_is_stopped_before_it_is_all_stored() {
    let mut rng = Rng(281);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 8));
    // The ledger counts fewer transactions than the node will list.
    let at = anchor(t.store(), &fake).await.unwrap();
    let mut totals = fake.oracle(0, at.height);
    totals.tx_count -= 4;
    adopt(
        t.store(),
        &fake,
        &script(0),
        totals,
        at.hash,
        at.height,
        10,
        0,
    )
    .await
    .unwrap();
    let r = history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW).await;
    assert!(matches!(r, Err(Error::Mismatch)), "{r:?}");
    assert_eq!(history_table_rows(t.store()).await, 0);
    assert_eq!(
        tracked(t.store(), sh(0)).await.unwrap().unwrap().history,
        History::None
    );
}

#[tokio::test]
async fn blocks_applied_before_a_failed_catch_up_count_against_the_bound() {
    let mut rng = Rng(301);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 3));
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    follow(t.store(), &fake).await.unwrap();
    history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    let n = tracked(t.store(), sh(0))
        .await
        .unwrap()
        .unwrap()
        .totals
        .tx_count;
    // Down for three blocks paying it; the catch-up applies two and fails on the third.
    for _ in 0..3 {
        fake.push_txs(pays(0, 2));
    }
    fake.fail_blocks_from.store(fake.tip(), Ordering::SeqCst);
    assert!(follow(t.store(), &fake).await.is_err());
    let grown = tracked(t.store(), sh(0))
        .await
        .unwrap()
        .unwrap()
        .totals
        .tx_count;
    assert_eq!(grown, n + 4);
    // The rows the two blocks committed are over a bound that held before them.
    assert_eq!(bound(t.store(), n + 1, NOBODY).await.unwrap(), 1);
    assert_eq!(history_table_rows(t.store()).await, 0);
    assert_eq!(
        tracked(t.store(), sh(0)).await.unwrap().unwrap().history,
        History::Dropped
    );
}

#[tokio::test]
async fn a_whole_history_pages_as_the_node_does() {
    let mut rng = Rng(291);
    let fake = Fake::new(20, &mut rng);
    let t = Temp::new();
    fake.push_txs(pays(0, 6));
    seed(t.store(), &fake, &script(0), false, 10, 0)
        .await
        .unwrap();
    seed(t.store(), &fake, &script(1), false, 10, 0)
        .await
        .unwrap();
    fake.push_txs(pays(0, 4));
    fake.push_txs(pays(1, 1));
    follow(t.store(), &fake).await.unwrap();
    // Not whole yet: nothing is paged.
    assert_eq!(
        history_page(t.store(), sh(0), None, None, 3).await.unwrap(),
        PageRead::NotWhole
    );
    history(t.store(), &fake, sh(0), ROWS, NOBODY, NOW)
        .await
        .unwrap();
    fake.push_txs(pays(0, 2));
    follow(t.store(), &fake).await.unwrap();
    // Pages of three, newest first, each after the last row of the one before: the whole list
    // turned round.
    let mut want = listed(&fake, 0, fake.tip());
    want.reverse();
    let mut got = Vec::new();
    let mut after = None;
    loop {
        let PageRead::Page { at, rows } = history_page(t.store(), sh(0), None, after, 3)
            .await
            .unwrap()
        else {
            panic!("not a page")
        };
        assert_eq!(at.height, fake.tip());
        let Some(last) = rows.last().copied() else {
            break;
        };
        assert!(rows.len() <= 3);
        after = Some(last);
        got.extend(rows);
    }
    assert_eq!(got, want);
    // As of an older block the ledger holds: only rows up to it.
    let old = fake.tip() - 2;
    let old_hash = fake.chain.lock().unwrap()[old as usize].hash;
    let PageRead::Page { at, rows } = history_page(t.store(), sh(0), Some(old_hash), None, 100)
        .await
        .unwrap()
    else {
        panic!("not a page")
    };
    assert_eq!(at.height, old);
    let mut older = listed(&fake, 0, old);
    older.reverse();
    assert_eq!(rows, older);
    // A block it does not hold, a cursor not in this history or above the block asked.
    assert_eq!(
        history_page(t.store(), sh(0), Some(BlockHash::all_zeros()), None, 3)
            .await
            .unwrap(),
        PageRead::AsofNotKept
    );
    let stranger = HistoryRow {
        height: want[0].height,
        txid: Txid::all_zeros(),
    };
    assert_eq!(
        history_page(t.store(), sh(0), None, Some(stranger), 3)
            .await
            .unwrap(),
        PageRead::CursorMissing
    );
    assert_eq!(
        history_page(t.store(), sh(0), Some(old_hash), Some(want[0]), 3)
            .await
            .unwrap(),
        PageRead::CursorMissing
    );
    assert_eq!(
        history_page(t.store(), sh(1), None, None, 3).await.unwrap(),
        PageRead::NotWhole
    );
}

#[tokio::test]
async fn a_dropped_history_is_taken_again_and_one_viewed_lately_is_never_the_one_dropped() {
    let mut rng = Rng(311);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    for i in 0..3 {
        fake.push_txs(pays(i, 4));
    }
    for (i, viewed) in [(0, 100), (1, 200), (2, 300)] {
        seed(t.store(), &fake, &script(i), false, 10, viewed)
            .await
            .unwrap();
    }
    follow(t.store(), &fake).await.unwrap();
    let count_of = |i: usize| {
        let t = &t;
        async move {
            tracked(t.store(), sh(i))
                .await
                .unwrap()
                .unwrap()
                .totals
                .tx_count
        }
    };
    let (c0, c1, c2) = (count_of(0).await, count_of(1).await, count_of(2).await);
    // Room for two of the three.
    let max = (c0 + c1).max(c1 + c2).max(c0 + c2);
    for (i, now) in [(0, 1000), (1, 1001)] {
        let r = history(t.store(), &fake, sh(i), max, NOBODY, now)
            .await
            .unwrap();
        assert!(matches!(r, Historied::Whole { evicted: 0, .. }), "{r:?}");
    }
    // Script 2 is viewed: room is made from the least recently viewed, script 0.
    let r = history(t.store(), &fake, sh(2), max, NOBODY, 1002)
        .await
        .unwrap();
    assert!(matches!(r, Historied::Whole { evicted: 1, .. }), "{r:?}");
    let s0 = tracked(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(
        (s0.history, s0.history_taken),
        (History::Dropped, Some(1000))
    );
    // Viewed again, it is taken again; script 1, the least recently viewed now, makes room.
    touch(t.store(), sh(0), 400).await.unwrap();
    let r = history(t.store(), &fake, sh(0), max, NOBODY, 2000)
        .await
        .unwrap();
    assert!(matches!(r, Historied::Whole { evicted: 1, .. }), "{r:?}");
    let s0 = tracked(t.store(), sh(0)).await.unwrap().unwrap();
    assert_eq!(s0.history_taken, Some(2000));
    assert_eq!(
        tracked(t.store(), sh(1)).await.unwrap().unwrap().history,
        History::Dropped
    );
    check_history(t.store(), &fake, "taken again").await;
    // Scripts 0 and 2 both viewed at or after 300: neither is dropped for script 1, which waits.
    let lists = fake.lists.load(Ordering::SeqCst);
    let r = history(t.store(), &fake, sh(1), max, 300, 3000)
        .await
        .unwrap();
    assert_eq!(r, Historied::NoRoom);
    assert_eq!(fake.lists.load(Ordering::SeqCst), lists, "not asked");
    assert_eq!(
        tracked(t.store(), sh(1)).await.unwrap().unwrap().history,
        History::Dropped
    );
    // Blocks push the two over the bound: while both are viewed, neither is dropped.
    fake.push_txs(pays(0, 3));
    fake.push_txs(pays(2, 3));
    follow(t.store(), &fake).await.unwrap();
    assert_eq!(bound(t.store(), c0 + c2, 300).await.unwrap(), 0);
    // Once the readers have gone, the least recently viewed goes.
    assert_eq!(bound(t.store(), c0 + c2, 500).await.unwrap(), 1);
    assert_eq!(
        tracked(t.store(), sh(2)).await.unwrap().unwrap().history,
        History::Dropped
    );
}

#[tokio::test]
async fn no_room_drops_nothing_when_the_viewed_ones_would_still_be_in_the_way() {
    let mut rng = Rng(321);
    let fake = Fake::new(10, &mut rng);
    let t = Temp::new();
    for i in 0..3 {
        fake.push_txs(pays(i, 4));
    }
    for (i, viewed) in [(0, 100), (1, 500), (2, 600)] {
        seed(t.store(), &fake, &script(i), false, 10, viewed)
            .await
            .unwrap();
    }
    follow(t.store(), &fake).await.unwrap();
    let mut n = Vec::new();
    for i in 0..3 {
        n.push(
            tracked(t.store(), sh(i))
                .await
                .unwrap()
                .unwrap()
                .totals
                .tx_count,
        );
    }
    // Room for all three only without the bound below; 0 and 1 are whole.
    let max = n[0] + n[1] + n[2] - 1;
    for i in [0, 1] {
        history(t.store(), &fake, sh(i), max, NOBODY, NOW)
            .await
            .unwrap();
    }
    // Script 1 is viewed (at 500): dropping script 0 alone could not make room for script 2
    // when the bound is just under script 1 and 2 together.
    let tight = n[1] + n[2] - 1;
    let r = history(t.store(), &fake, sh(2), tight, 400, NOW)
        .await
        .unwrap();
    assert_eq!(r, Historied::NoRoom);
    for i in [0, 1] {
        assert!(
            matches!(
                tracked(t.store(), sh(i)).await.unwrap().unwrap().history,
                History::Whole { .. }
            ),
            "script {i} kept"
        );
    }
    check_history(t.store(), &fake, "nothing dropped").await;
}
