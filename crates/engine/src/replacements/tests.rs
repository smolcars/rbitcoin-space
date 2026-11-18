#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use bitcoin::hashes::Hash;

use super::db;
use super::*;
use crate::store::{Options, Store};

fn id(n: u8) -> Txid {
    Txid::from_byte_array([n; 32])
}

fn facts(n: u8, rbf: bool) -> Facts {
    Facts {
        fee: 100 * u64::from(n),
        vsize: 200,
        weight: 797,
        value: 5000 + u64::from(n),
        time: 1_700_000_000 + u32::from(n),
        rbf,
    }
}

/// `a` replaced by `b`, both signalling.
fn link(a: u8, b: u8) -> Link {
    Link {
        txid: id(a),
        by: id(b),
        seen: u64::from(a),
        tx: Facts {
            fee: 100,
            vsize: 200,
            ..facts(a, true)
        },
        by_tx: Some(Facts {
            fee: 300,
            ..facts(b, true)
        }),
        mined: Mined::No,
    }
}

fn block(n: u8) -> BlockHash {
    BlockHash::from_byte_array([n; 32])
}

fn mined(t: &Node) -> bool {
    matches!(t.mined, Mined::In(_))
}

fn txids(links: &[Link]) -> Vec<Txid> {
    links.iter().map(|l| l.txid).collect()
}

/// A tree as (txid, what it replaced), depth first.
fn shape(n: &Node) -> Vec<(Txid, Vec<Txid>)> {
    let mut out = vec![(n.txid, n.replaces.iter().map(|c| c.txid).collect())];
    for c in &n.replaces {
        out.extend(shape(c));
    }
    out
}

#[test]
fn chains_run_both_ways_and_stop_at_a_loop() {
    let mut r = Replacements::new(100);
    for (a, b) in [(1, 2), (2, 3), (3, 4), (9, 4)] {
        r.insert(link(a, b));
    }
    assert_eq!(txids(&r.chain(&id(1)).0), vec![id(1), id(2), id(3)]);
    assert_eq!(r.chain(&id(4)), (Vec::new(), false));
    let (back, more) = r.earlier(&id(4));
    assert!(!more);
    assert_eq!(back.len(), 4);
    assert_eq!(back[0].txid, id(3));
    // 1 came back (a miner took it) and replaced 4: what replaced 1 before no longer stands, so
    // every member has one newest end, 1, and there is one tree.
    r.insert(link(4, 1));
    assert_eq!(r.chain(&id(1)), (Vec::new(), false));
    assert_eq!(txids(&r.chain(&id(2)).0), vec![id(2), id(3), id(4)]);
    for t in [1, 2, 3, 4, 9] {
        assert_eq!(r.root(&id(t)), id(1), "{t}");
    }
    assert_eq!(r.recent(25, false).len(), 1);
    assert_eq!(
        link(1, 2).json()["rate"],
        json!(500),
        "100 sat over 200 vB is 0.5 sat/vB"
    );
    let mut unknown = link(1, 2);
    unknown.by_tx = None;
    assert_eq!(unknown.json()["by_rate"], Value::Null);
}

#[test]
fn a_replacement_undone_by_a_block_leaves_one_newest_end() {
    // B replaced A in our mempool, then a miner confirmed A, which replaced B.
    let mut r = Replacements::new(10);
    r.insert(link(1, 2));
    r.insert(link(2, 1));
    assert_eq!((r.root(&id(1)), r.root(&id(2))), (id(1), id(1)));
    let trees = r.recent(25, false);
    assert_eq!(trees.len(), 1);
    assert_eq!(
        shape(&trees[0]),
        vec![(id(1), vec![id(2)]), (id(2), vec![])]
    );
    // The same order read back from the store gives the same record.
    let mut again = Replacements::new(10);
    again.restore(link(1, 2));
    again.restore(link(2, 1));
    assert_eq!(again.tree(&id(2)), r.tree(&id(2)));
}

/// B replaced A in our mempool, then a miner confirmed A: the tracker no longer held A, so the
/// new link names A without figures, as it does a replacement straight from a block.
fn won_after_all() -> Link {
    Link {
        by_tx: None,
        mined: Mined::In(Some((7, block(7)))),
        ..link(2, 1)
    }
}

#[test]
fn the_original_confirmed_after_all_keeps_its_figures() {
    let mut r = Replacements::new(10);
    r.insert(link(1, 2));
    let recorded = r.insert(won_after_all());
    let a = link(1, 2).tx;
    assert_eq!(recorded.by_tx, Some(a), "what the store is given");
    let tree = r.tree(&id(2)).unwrap();
    assert_eq!(
        (tree.txid, tree.tx, tree.time),
        (id(1), Some(a), u64::from(a.time))
    );
    assert!(mined(&tree));
    assert_eq!(r.facts(&id(1)), Some(a));
    assert_eq!(r.chain(&id(2)).0[0].json()["by_fee"], a.fee);
    // A replacement that was never replaced itself still has none.
    let mut other = Replacements::new(10);
    other.insert(won_after_all());
    assert_eq!(other.tree(&id(2)).unwrap().tx, None);
}

/// A record put back from `store`, as at a start.
async fn reopen(store: &Store) -> Replacements {
    let mut r = Replacements::new(10);
    for l in db::load(store, 10).await.unwrap() {
        r.restore(l);
    }
    r
}

#[tokio::test]
async fn the_figures_kept_survive_a_restart_on_either_side_of_the_block() {
    let t = temp();
    let write = |l: Link| vec![Change::Link(l)];
    // Restarted between the replacement and the block: the record put back holds A's figures.
    let mut r = Replacements::new(10);
    db::write(&t.store, vec![write(r.insert(link(1, 2)))], 10)
        .await
        .unwrap();
    let mut r2 = reopen(&t.store).await;
    let recorded = r2.insert(won_after_all());
    db::write(&t.store, vec![write(recorded)], 10)
        .await
        .unwrap();
    let want = r2.tree(&id(2)).unwrap();
    assert_eq!(want.tx, Some(link(1, 2).tx));
    // And again after the block.
    assert_eq!(reopen(&t.store).await.tree(&id(2)), Some(want));
}

fn idn(n: u32) -> Txid {
    let mut b = [0u8; 32];
    b[..4].copy_from_slice(&n.to_le_bytes());
    Txid::from_byte_array(b)
}

#[test]
fn a_history_longer_than_any_answer_still_has_one_newest_end() {
    let mut r = Replacements::new(10_000);
    for i in 0..1025 {
        r.insert(Link {
            txid: idn(i),
            by: idn(i + 1),
            ..link(1, 2)
        });
    }
    assert_eq!(r.root(&idn(0)), idn(1025));
    let trees = r.recent(25, false);
    assert_eq!(trees.len(), 1, "one history, one tree");
    assert_eq!(trees[0].txid, idn(1025));
}

#[test]
fn a_transaction_back_in_the_mempool_is_no_longer_replaced_or_mined() {
    let mut r = Replacements::new(10);
    r.insert(link(1, 2));
    r.insert(link(3, 4));
    assert!(r.confirmed(&id(4), 7, block(7)));
    // 1 was rebroadcast after 2 left: nothing stands replaced by 2 any more.
    assert!(r.returned(&id(1)));
    assert!(r.get(&id(1)).is_none() && r.tree(&id(2)).is_none());
    // 4 came back from a block a reorg undid: its tree stands, unmined.
    let v = r.version();
    assert!(r.returned(&id(4)));
    assert!(r.version() > v);
    assert!(!mined(&r.tree(&id(3)).unwrap()));
    assert!(
        !r.returned(&id(9)),
        "an unknown transaction changes nothing"
    );
}

#[test]
fn long_chains_are_cut_and_marked() {
    let mut r = Replacements::new(1000);
    for i in 0..150 {
        r.insert(link(i, i + 1));
    }
    let (chain, more) = r.chain(&id(0));
    assert_eq!((chain.len(), more), (MAX_LINKS, true));
    let (back, more) = r.earlier(&id(150));
    assert_eq!((back.len(), more), (MAX_LINKS, true));
    // The tree is cut at its bound, newest first.
    let tree = r.tree(&id(0)).unwrap();
    assert_eq!(tree.txid, id(150));
    assert_eq!(shape(&tree).len(), MAX_TREE);
}

#[test]
fn the_oldest_fall_out_first_and_a_rewrite_counts_once() {
    let mut r = Replacements::new(3);
    for (a, b) in [(1, 2), (3, 4), (5, 6)] {
        r.insert(link(a, b));
    }
    r.insert(link(7, 8));
    assert_eq!((r.len(), r.get(&id(1))), (3, None));
    assert!(
        r.earlier(&id(2)).0.is_empty(),
        "the reverse index forgets it too"
    );
    assert!(r.tree(&id(2)).is_none() && r.facts(&id(1)).is_none());
    // 3 is replaced again by 9: its old entry in the order no longer evicts the new one.
    r.insert(link(3, 9));
    r.insert(link(10, 11));
    assert_eq!(r.get(&id(3)).map(|l| l.by), Some(id(9)));
    assert!(r.earlier(&id(4)).0.is_empty());
    assert_eq!(r.len(), 3);
    // Many rewrites of one link never grow the record past its cap.
    for _ in 0..50 {
        r.insert(link(3, 9));
    }
    assert!(r.order.len() <= 3 && r.len() <= 3);
    assert_eq!(r.take_recorded(), 56);
    assert_eq!(r.take_recorded(), 0);
}

#[test]
fn a_chain_a_then_b_then_c_is_one_tree_from_any_member() {
    let mut r = Replacements::new(100);
    r.insert(link(1, 2));
    r.insert(link(2, 3));
    for t in [1, 2, 3] {
        let tree = r.tree(&id(t)).unwrap();
        assert_eq!(
            shape(&tree),
            vec![(id(3), vec![id(2)]), (id(2), vec![id(1)]), (id(1), vec![])]
        );
    }
    let tree = r.tree(&id(1)).unwrap();
    // The newest replacement's figures come from the link that names it; the others' their own.
    assert_eq!(tree.tx.map(|f| f.fee), Some(300));
    assert_eq!(tree.time, u64::from(facts(3, true).time));
    assert_eq!(tree.replaces[0].tx.map(|f| f.fee), Some(100));
    assert!(!tree.full_rbf() && !mined(&tree));
    assert_eq!(r.replaced_by(&id(3)), &[id(2)]);
    assert_eq!(r.facts(&id(3)).map(|f| f.fee), Some(300));
    assert_eq!(r.facts(&id(1)).map(|f| f.time), Some(facts(1, true).time));
    // Mined: the tree says so, and only the newest replacement's confirmation counts.
    assert!(!r.confirmed(&id(1), 7, block(7)));
    let v = r.version();
    assert!(r.confirmed(&id(3), 7, block(7)));
    assert!(r.version() > v);
    assert!(mined(&r.tree(&id(1)).unwrap()));
    assert_eq!(r.recent(25, false).len(), 1);
    assert!(r.recent(25, true).is_empty());
}

#[test]
fn one_replacement_that_removes_several_and_a_package_replacement() {
    let mut r = Replacements::new(100);
    // 5 spends inputs of 1 and 2; 3 is a child of 1 that left with it.
    for a in [1, 2, 3] {
        r.insert(link(a, 5));
    }
    let tree = r.tree(&id(3)).unwrap();
    assert_eq!(
        shape(&tree)[0],
        (id(5), vec![id(1), id(2), id(3)]),
        "every transaction it removed, in the order recorded"
    );
    // A package: parent 7 and child 8 entered together; 8 spends 6's input, so 6 is replaced
    // by 8, the transaction that conflicts. The tree hangs from 8.
    r.insert(link(6, 8));
    assert_eq!(shape(&r.tree(&id(6)).unwrap())[0], (id(8), vec![id(6)]));
    // One without signalling makes its tree full RBF, and only that tree is listed as such.
    let mut quiet = link(9, 10);
    quiet.tx.rbf = false;
    r.insert(quiet);
    let full: Vec<Txid> = r.recent(25, true).iter().map(|t| t.txid).collect();
    assert_eq!(full, vec![id(10)]);
    let all: Vec<Txid> = r.recent(25, false).iter().map(|t| t.txid).collect();
    assert_eq!(all, vec![id(10), id(8), id(5)], "newest first");
    assert_eq!(r.recent(2, false).len(), 2);
}

#[test]
fn a_replacement_the_tracker_never_held_has_no_figures() {
    let mut r = Replacements::new(10);
    let mut l = link(1, 2);
    l.by_tx = None;
    l.seen = 42;
    r.insert(l);
    let tree = r.tree(&id(1)).unwrap();
    assert_eq!((tree.tx, tree.time), (None, 42));
    assert_eq!(r.facts(&id(2)), None);
}

struct Temp {
    dir: PathBuf,
    store: Store,
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp() -> Temp {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rbitcoin-space-replacements-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::open(&dir, "regtest", Options::default()).unwrap();
    Temp { dir, store }
}

#[tokio::test]
async fn the_stored_record_survives_a_restart_and_keeps_its_bound() {
    let t = temp();
    let mut quiet = link(1, 2);
    quiet.tx.rbf = false;
    let mut unknown = link(2, 3);
    unknown.by_tx = None;
    let first = vec![Change::Link(quiet), Change::Link(unknown)];
    db::write(&t.store, vec![first], 3).await.unwrap();
    db::write(
        &t.store,
        vec![vec![
            Change::Link(link(4, 5)),
            Change::Mined(id(3), Mined::In(Some((9, block(9))))),
        ]],
        3,
    )
    .await
    .unwrap();
    // Reopened, the record is what it was, mined flag included.
    let dir = t.dir.clone();
    let Temp { store, .. } = &t;
    let loaded = db::load(store, 3).await.unwrap();
    let mut want_unknown = unknown;
    want_unknown.mined = Mined::In(Some((9, block(9))));
    assert_eq!(loaded, vec![quiet, want_unknown, link(4, 5)]);
    let again = Store::open(&dir, "regtest", Options::default()).unwrap();
    assert_eq!(db::load(&again, 3).await.unwrap(), loaded);
    let mut r = Replacements::new(3);
    for l in loaded {
        r.restore(l);
    }
    assert_eq!(r.take_recorded(), 0, "restored links are not new");
    assert!(mined(&r.tree(&id(1)).unwrap()) && r.tree(&id(1)).unwrap().full_rbf());

    // The bound: only the newest three stay, a rewrite moves a link to the newest.
    db::write(
        &again,
        vec![vec![Change::Link(link(6, 7)), Change::Link(link(1, 9))]],
        3,
    )
    .await
    .unwrap();
    let kept: Vec<Txid> = txids(&db::load(&again, 100).await.unwrap());
    assert_eq!(kept, vec![id(4), id(6), id(1)]);
    // Batches apply in order: a link recorded then undone by a return is gone, and one recorded
    // after a return stays.
    db::write(
        &again,
        vec![
            vec![Change::Link(link(30, 31))],
            vec![Change::Returned(id(30)), Change::Returned(id(6))],
            vec![Change::Link(link(6, 32))],
        ],
        3,
    )
    .await
    .unwrap();
    let kept: Vec<Txid> = txids(&db::load(&again, 100).await.unwrap());
    // The bound counts places in the order, and the deleted link had one: never more than three.
    assert_eq!(kept, vec![id(1), id(6)]);
    // B replaced A, a miner confirmed A (A replaced B), and a reorg returned B: the store, read
    // back, holds what memory holds.
    let mut r = Replacements::new(10);
    r.insert(link(40, 41));
    db::write(&again, vec![r.take_changes()], 10).await.unwrap();
    r.insert(link(41, 40));
    db::write(&again, vec![r.take_changes()], 10).await.unwrap();
    r.returned(&id(41));
    db::write(&again, vec![r.take_changes()], 10).await.unwrap();
    let stored = db::load(&again, 100).await.unwrap();
    assert!(r.get(&id(40)).is_none() && r.get(&id(41)).is_none());
    assert!(
        stored.iter().all(|l| ![id(40), id(41)].contains(&l.txid)),
        "{stored:?}"
    );
    // A write that fails part way leaves nothing behind.
    let half = vec![Change::Link(link(20, 21))];
    let failed = again
        .write(move |sql| {
            db::insert(sql, &half)?;
            Err::<(), _>(crate::store::Error::Closed)
        })
        .await;
    assert!(failed.is_err());
    assert_eq!(txids(&db::load(&again, 100).await.unwrap()), kept);
}

/// The table at its default bound: its size on disk, and how long putting it back takes. Each
/// link keeps both sides' outputs: `SIDES=wallet` (the default) two P2WPKH outputs a side, as a
/// fee bump of a payment has; `SIDES=worst` the most a side can keep, 32 outputs of 34-byte
/// scripts with the largest values; `SIDES=none` nothing, as before outputs were kept.
/// `cargo test --release -p engine -- --ignored --nocapture replacements_benchmark`
#[tokio::test]
#[ignore = "a measurement, not a check"]
#[allow(clippy::print_stdout)]
async fn replacements_benchmark() {
    use crate::outputs::{MAX_OUTPUTS, Outputs};
    use bitcoin::{Amount, ScriptBuf, TxOut};
    let mode = std::env::var("SIDES").unwrap_or_else(|_| "wallet".into());
    let side = |n: u32| -> Option<Outputs> {
        let out = |v: u64, len: usize, i: u32| TxOut {
            value: Amount::from_sat(v),
            script_pubkey: ScriptBuf::from_bytes(
                (0..len).map(|k| (n ^ i ^ k as u32) as u8).collect(),
            ),
        };
        match mode.as_str() {
            "none" => None,
            "worst" => Some(Outputs::of(
                &(0..MAX_OUTPUTS as u32)
                    .map(|i| out(u64::MAX, 34, i))
                    .collect::<Vec<_>>(),
            )),
            _ => Some(Outputs::of(&[out(84_000, 22, 0), out(1_250_000, 22, 1)])),
        }
    };
    let t = temp();
    let keep = 10_000;
    let mut n = 0u32;
    // Twice the bound, in writes of 20 links, so the bound has pruned half.
    for _ in 0..(2 * keep / 20) {
        let mut links = Vec::new();
        for _ in 0..20 {
            n += 1;
            let mut l = link(1, 2);
            let mut a = [0u8; 32];
            a[..4].copy_from_slice(&n.to_le_bytes());
            l.txid = Txid::from_byte_array(a);
            a[4] = 1;
            l.by = Txid::from_byte_array(a);
            links.push(Change::Link(l));
            let sides = Sides {
                outputs: side(n),
                by_outputs: side(!n),
                inputs: Some(1),
                by_inputs: Some(1),
                shared: Some(1),
            };
            if !sides.is_empty() {
                links.push(Change::Sides(l.txid, sides));
            }
        }
        db::write(&t.store, vec![links], keep).await.unwrap();
    }
    let started = std::time::Instant::now();
    let loaded = db::load_kept(&t.store, keep).await.unwrap();
    let took = started.elapsed();
    let mut r = Replacements::new(keep);
    for (l, s) in loaded.iter().cloned() {
        r.restore_with(l, s);
    }
    let kept: usize = loaded
        .iter()
        .map(|(_, s)| {
            s.outputs.as_ref().map_or(0, Outputs::heap_bytes)
                + s.by_outputs.as_ref().map_or(0, Outputs::heap_bytes)
        })
        .sum();
    let rows: i64 = t
        .store
        .read(crate::store::Read::Blocks, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM replacements")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap();
    let bytes: i64 = t
        .store
        .read(crate::store::Read::Blocks, |sql| {
            Ok(sql
                .prepare("SELECT sum(pgsize) FROM dbstat WHERE name LIKE '%replacements%'")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap_or(-1);
    println!(
        "sides {mode}: rows {rows}, loaded {} in {took:?}, table and indexes {bytes} bytes ({} a \
         row), record {}, outputs kept in memory {kept} bytes ({} a link)",
        loaded.len(),
        bytes / rows.max(1),
        r.len(),
        kept / loaded.len().max(1),
    );
}

// Following the chain.

/// A scripted chain: block `n` at height `h` holding `txs`, on parent `p`.
fn blk(h: u32, n: u8, p: u8, txs: &[u8]) -> Arc<BlockSpends> {
    let txs: Vec<Txid> = txs.iter().map(|t| id(*t)).collect();
    Arc::new(BlockSpends::listed(h, block(n), block(p), &txs))
}

/// The window, tip first, as a delta carries it.
fn window(blocks: &[Arc<BlockSpends>]) -> Vec<Arc<BlockSpends>> {
    let mut w = blocks.to_vec();
    w.sort_by_key(|b| std::cmp::Reverse(b.height));
    w.truncate(6);
    w
}

/// Answers from a scripted best chain; `down` fails every read. Counts reads.
#[derive(Default)]
struct Script {
    hashes: HashMap<u32, BlockHash>,
    txs: HashMap<Txid, (u32, BlockHash)>,
    down: bool,
    reads: AtomicUsize,
}

impl Lookup for Script {
    async fn answer(&self, ask: Ask) -> Option<Answer> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.down {
            return None;
        }
        Some(match ask {
            Ask::Hash(h) => Answer::Hash(*self.hashes.get(&h)?),
            Ask::Tx(t) => Answer::Tx(self.txs.get(&t).copied()),
        })
    }
}

/// Runs every check due until none is, or one fails. Returns the reads made.
async fn check(r: &mut Replacements, node: &Script) -> usize {
    let before = node.reads.load(Ordering::SeqCst);
    while let Some((epoch, asks)) = r.asks() {
        let answers = ask(node, &asks).await;
        let failed = answers.iter().any(|(_, a)| a.is_none());
        r.answers(epoch, &answers);
        if failed {
            break;
        }
    }
    node.reads.load(Ordering::SeqCst) - before
}

/// A chain of empty blocks 1..=n (block hash n at height n), and a record that followed it.
fn chain(n: u8) -> (Vec<Arc<BlockSpends>>, Replacements) {
    let blocks: Vec<_> = (1..=n).map(|h| blk(u32::from(h), h, h - 1, &[])).collect();
    let mut r = Replacements::new(1000);
    r.follow(&window(&blocks));
    (blocks, r)
}

/// `a` replaced by `b`, confirmed in a new block `h` at height `h`, through a delta's window.
fn mine(r: &mut Replacements, blocks: &mut Vec<Arc<BlockSpends>>, a: u8, b: u8, h: u8) {
    r.insert(link(a, b));
    blocks.push(blk(u32::from(h), h, h - 1, &[b]));
    r.follow(&window(blocks));
}

#[test]
fn a_replacement_in_a_new_block_is_mined_there_whether_it_left_our_mempool_or_not() {
    let (mut blocks, mut r) = chain(10);
    mine(&mut r, &mut blocks, 1, 2, 11);
    assert_eq!(r.mined(&id(2)), Mined::In(Some((11, block(11)))));
    assert_eq!(
        r.take_changes().last(),
        Some(&Change::Mined(id(2), Mined::In(Some((11, block(11))))))
    );
    // The next block changes nothing: a hash compare and a lookup per transaction.
    let v = r.version();
    blocks.push(blk(12, 12, 11, &[9]));
    let new = r.follow(&window(&blocks));
    assert!(r.originals(&new).is_empty());
    assert_eq!(r.version(), v);
    assert_eq!(r.asks(), None, "nothing to ask the node");
}

#[tokio::test]
async fn a_replacement_also_in_the_competing_block_stays_mined_at_the_new_block() {
    let (mut blocks, mut r) = chain(10);
    mine(&mut r, &mut blocks, 1, 2, 11);
    // Block 11 is replaced by 111, which also holds 2.
    blocks.pop();
    blocks.push(blk(11, 111, 10, &[2]));
    r.follow(&window(&blocks));
    assert_eq!(r.mined(&id(2)), Mined::In(Some((11, block(111)))));
    let node = Script::default();
    assert_eq!(check(&mut r, &node).await, 0, "settled from memory");
}

#[tokio::test]
async fn a_replacement_not_in_the_competing_block_is_not_mined() {
    let (mut blocks, mut r) = chain(10);
    mine(&mut r, &mut blocks, 1, 2, 11);
    mine(&mut r, &mut blocks, 3, 4, 12);
    blocks.truncate(10);
    blocks.push(blk(11, 111, 10, &[]));
    blocks.push(blk(12, 112, 111, &[]));
    blocks.push(blk(13, 113, 112, &[]));
    r.follow(&window(&blocks));
    // Neither is in the new chain's blocks above where the chains part: not mined, and nothing
    // asked. Whether one returns to the mempool is the tracker's to say (`returned`).
    assert_eq!((r.mined(&id(2)), r.mined(&id(4))), (Mined::No, Mined::No));
    assert_eq!(check(&mut r, &Script::default()).await, 0);
    assert!(r.get(&id(1)).is_some(), "still replaced");
    // 4 comes back to the mempool, then is mined in a later block.
    r.returned(&id(4));
    assert_eq!(r.mined(&id(4)), Mined::No);
    blocks.push(blk(14, 114, 113, &[4]));
    r.follow(&window(&blocks));
    assert_eq!(r.mined(&id(4)), Mined::In(Some((14, block(114)))));
}

#[test]
fn the_original_winning_in_the_competing_block_is_confirmed_not_replaced() {
    let (mut blocks, mut r) = chain(10);
    mine(&mut r, &mut blocks, 1, 2, 11);
    blocks.pop();
    blocks.push(blk(11, 111, 10, &[1]));
    let new = r.follow(&window(&blocks));
    assert_eq!(r.originals(&new), vec![(id(1), 11, block(111))]);
    assert!(r.get(&id(1)).is_none(), "1 no longer stands replaced");
    assert!(r.tree(&id(2)).is_none());
    assert!(r.take_changes().contains(&Change::Returned(id(1))));
}

#[tokio::test]
async fn a_two_block_reorg_and_a_shorter_chain() {
    let (mut blocks, mut r) = chain(10);
    mine(&mut r, &mut blocks, 1, 2, 11);
    mine(&mut r, &mut blocks, 3, 4, 12);
    // The node invalidates 11: the chain is back at 10.
    blocks.truncate(10);
    r.follow(&window(&blocks));
    assert_eq!((r.mined(&id(2)), r.mined(&id(4))), (Mined::No, Mined::No));
    // A competing 11 and 12 with 4 in the second.
    blocks.push(blk(11, 111, 10, &[]));
    blocks.push(blk(12, 112, 111, &[4]));
    r.follow(&window(&blocks));
    assert_eq!(r.mined(&id(2)), Mined::No);
    assert_eq!(r.mined(&id(4)), Mined::In(Some((12, block(112)))));
    assert_eq!(check(&mut r, &Script::default()).await, 0);
}

#[tokio::test]
async fn a_reorg_deeper_than_the_window_walks_down_and_asks() {
    let (mut blocks, mut r) = chain(20);
    // Mined at 12 (below the coming window) and at 18 (inside it).
    r.insert(link(1, 2));
    r.confirmed(&id(2), 12, block(12));
    r.insert(link(3, 4));
    r.confirmed(&id(4), 18, block(18));
    r.insert(link(5, 6));
    r.confirmed(&id(6), 5, block(5));
    // Everything above 10 is replaced; 2 ended up in the new 11, 4 in no block.
    blocks.truncate(10);
    blocks.push(blk(11, 211, 10, &[2]));
    for h in 12..=21u8 {
        blocks.push(blk(u32::from(h), 200 + h, 199 + h, &[]));
    }
    r.follow(&window(&blocks));
    // 4's block is in the window's range and gone; the window cannot show where the chains
    // part, so where 4 is now is unknown until asked. 2 and 6 are below the window: unproven.
    assert_eq!(r.mined(&id(4)), Mined::Unknown);
    assert_eq!(r.mined(&id(2)), Mined::In(Some((12, block(12)))));
    let mut node = Script::default();
    for b in &blocks {
        node.hashes.insert(b.height, b.hash);
    }
    node.txs.insert(id(2), (11, block(211)));
    let reads = check(&mut r, &node).await;
    assert_eq!(r.mined(&id(4)), Mined::No);
    assert_eq!(r.mined(&id(2)), Mined::In(Some((11, block(211)))));
    assert_eq!(
        r.mined(&id(6)),
        Mined::In(Some((5, block(5)))),
        "below the fork"
    );
    // 4's status, the hash at 12 (gone), 2's status, the hash at 5 (held).
    assert_eq!(reads, 4);
    assert_eq!(r.asks(), None);
}

#[tokio::test]
async fn the_cap_bounds_the_reads_of_one_reorg_and_leaves_the_rest_unknown() {
    let (mut blocks, mut r) = chain(10);
    // More replacements mined in the window than one reorg may read for.
    let n = u32::try_from(CHECKS).unwrap() + 20;
    for i in 0..n {
        r.insert(Link {
            txid: idn(i),
            by: idn(100_000 + i),
            ..link(1, 2)
        });
        r.confirmed(&idn(100_000 + i), 9, block(9));
    }
    // A reorg from below the window: block 9 is gone, nothing tells where the chains part.
    blocks.truncate(3);
    for h in 4..=20u8 {
        blocks.push(blk(u32::from(h), 100 + h, 99 + h, &[]));
    }
    r.follow(&window(&blocks));
    let mut node = Script::default();
    for b in &blocks {
        node.hashes.insert(b.height, b.hash);
    }
    let reads = check(&mut r, &node).await;
    assert_eq!(reads, CHECKS, "never more than the cap");
    let unknown = (0..n)
        .filter(|i| r.mined(&idn(100_000 + i)) == Mined::Unknown)
        .count();
    let no = (0..n)
        .filter(|i| r.mined(&idn(100_000 + i)) == Mined::No)
        .count();
    // One read for the hash at 9, which was gone; one each for the first 99 replacements.
    assert_eq!(
        (no, unknown),
        (CHECKS - 1, 21),
        "past the cap: unknown, not guessed"
    );
    assert_eq!(r.asks(), None, "and stays so");
}

#[tokio::test]
async fn an_unreachable_node_is_asked_once_and_the_state_stays_unknown_until_it_answers() {
    let (mut blocks, mut r) = chain(20);
    r.insert(link(3, 4));
    r.confirmed(&id(4), 18, block(18));
    blocks.truncate(10);
    for h in 11..=21u8 {
        blocks.push(blk(u32::from(h), 200 + h, 199 + h, &[]));
    }
    r.follow(&window(&blocks));
    let mut node = Script {
        down: true,
        ..Script::default()
    };
    assert_eq!(check(&mut r, &node).await, 1, "one failed read, then wait");
    assert_eq!(r.mined(&id(4)), Mined::Unknown);
    assert_eq!(r.tree(&id(3)).unwrap().mined, Mined::Unknown);
    assert_eq!(r.chain(&id(3)).0[0].json()["mined"], Value::Null);
    node.down = false;
    node.txs.insert(id(4), (13, block(213)));
    check(&mut r, &node).await;
    assert_eq!(r.mined(&id(4)), Mined::In(Some((13, block(213)))));
}

#[tokio::test]
async fn answers_from_before_another_reorg_are_dropped() {
    let (mut blocks, mut r) = chain(20);
    r.insert(link(3, 4));
    r.confirmed(&id(4), 18, block(18));
    blocks.truncate(10);
    for h in 11..=21u8 {
        blocks.push(blk(u32::from(h), 200 + h, 199 + h, &[]));
    }
    r.follow(&window(&blocks));
    let (epoch, asks) = r.asks().unwrap();
    assert_eq!(asks, vec![Ask::Tx(id(4))]);
    // Another reorg puts 4 in the window before the answer lands.
    blocks.truncate(20);
    blocks.push(blk(21, 99, 220, &[4]));
    r.follow(&window(&blocks));
    assert_eq!(r.mined(&id(4)), Mined::In(Some((21, block(99)))));
    r.answers(epoch, &[(Ask::Tx(id(4)), Some(Answer::Tx(None)))]);
    assert_eq!(r.mined(&id(4)), Mined::In(Some((21, block(99)))));
}

#[tokio::test]
async fn a_restart_between_the_reorg_and_the_check_checks_after_it() {
    let t = temp();
    let (mut blocks, mut r) = chain(20);
    r.insert(link(1, 2));
    r.confirmed(&id(2), 12, block(12));
    r.insert(link(3, 4));
    r.confirmed(&id(4), 18, block(18));
    blocks.truncate(10);
    for h in 11..=21u8 {
        blocks.push(blk(u32::from(h), 200 + h, 199 + h, &[]));
    }
    r.follow(&window(&blocks));
    db::write(&t.store, vec![r.take_changes()], 100)
        .await
        .unwrap();
    // Stopped before any check: 4 is stored unknown, 2 as mined at 12.
    let mut again = Replacements::new(100);
    for l in db::load(&t.store, 100).await.unwrap() {
        again.restore(l);
    }
    assert_eq!(again.mined(&id(4)), Mined::Unknown);
    assert_eq!(
        again.asks(),
        None,
        "nothing is asked before the first window"
    );
    // The first window after the start cannot show where it parts from what we knew: the
    // unknown is asked, and the walk proves or disproves 12.
    again.follow(&window(&blocks));
    let mut node = Script::default();
    for b in &blocks {
        node.hashes.insert(b.height, b.hash);
    }
    check(&mut again, &node).await;
    assert_eq!(again.mined(&id(4)), Mined::No);
    assert_eq!(again.mined(&id(2)), Mined::No);
    db::write(&t.store, vec![again.take_changes()], 100)
        .await
        .unwrap();
    let stored = db::load(&t.store, 100).await.unwrap();
    assert!(stored.iter().all(|l| l.mined == Mined::No), "{stored:?}");
}

#[tokio::test]
async fn a_restart_with_no_reorg_costs_one_read_at_most() {
    let (blocks, mut r) = chain(20);
    r.insert(link(1, 2));
    r.confirmed(&id(2), 3, block(3));
    r.insert(link(3, 4));
    r.confirmed(&id(4), 18, block(18));
    let mut again = Replacements::new(100);
    for (_, l) in r.links.values() {
        again.restore(*l);
    }
    again.follow(&window(&blocks));
    // 18 is in the window and still there: nothing below it moved, nothing is asked.
    assert_eq!(check(&mut again, &Script::default()).await, 0);
    let mut fresh = Replacements::new(100);
    fresh.restore(r.links.values().find(|(_, l)| l.by == id(2)).unwrap().1);
    fresh.follow(&window(&blocks));
    let mut node = Script::default();
    node.hashes.insert(3, block(3));
    assert_eq!(check(&mut fresh, &node).await, 1, "one hash, and it held");
    assert_eq!(fresh.mined(&id(2)), Mined::In(Some((3, block(3)))));
}

#[tokio::test]
async fn links_stored_before_blocks_were_recorded_read_mined_and_are_left_as_they_are() {
    let t = temp();
    db::write(&t.store, vec![vec![Change::Link(link(1, 2))]], 10)
        .await
        .unwrap();
    t.store
        .write(|sql| {
            sql.prepare("UPDATE replacements SET mined = 1, height = NULL, block = NULL")?
                .execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    let mut r = Replacements::new(10);
    for l in db::load(&t.store, 10).await.unwrap() {
        r.restore(l);
    }
    assert_eq!(r.mined(&id(2)), Mined::In(None));
    let (blocks, _) = chain(10);
    r.follow(&window(&blocks));
    assert_eq!(r.asks(), None);
    assert_eq!(r.chain(&id(1)).0[0].json()["mined"], true);
    assert_eq!(r.chain(&id(1)).0[0].json()["block"], Value::Null);
}

#[test]
fn an_original_confirmed_while_its_replacement_was_not_is_no_longer_replaced() {
    // 2 replaced 1 and was itself replaced by 3, unmined; a block then confirms 1.
    let (mut blocks, mut r) = chain(10);
    r.insert(link(1, 2));
    r.insert(link(2, 3));
    blocks.push(blk(11, 11, 10, &[1]));
    let new = r.follow(&window(&blocks));
    assert_eq!(r.originals(&new), vec![(id(1), 11, block(11))]);
    assert!(r.get(&id(1)).is_none());
    assert!(r.get(&id(2)).is_some(), "what replaced 2 still stands");
}

#[test]
fn an_intermediate_replacement_confirmed_by_a_reorg_keeps_what_it_replaced_mined() {
    // 1 replaced by 2, 2 by 3 (unmined); a reorg's new block holds 2.
    let (mut blocks, mut r) = chain(10);
    r.insert(link(1, 2));
    r.insert(link(2, 3));
    blocks.pop();
    blocks.push(blk(10, 110, 9, &[2]));
    let new = r.follow(&window(&blocks));
    assert_eq!(r.originals(&new), vec![(id(2), 10, block(110))]);
    assert!(r.get(&id(2)).is_none(), "2 no longer stands replaced");
    let mined = Mined::In(Some((10, block(110))));
    assert_eq!(r.mined(&id(2)), mined);
    // The store, replaying the changes, agrees.
    let changes = r.take_changes();
    let last = changes
        .iter()
        .rposition(|c| matches!(c, Change::Returned(t) if *t == id(2)));
    assert!(
        changes[last.unwrap()..].contains(&Change::Mined(id(2), mined)),
        "{changes:?}"
    );
}

#[tokio::test]
async fn reads_spent_with_the_node_down_leave_the_unproven_unknown_and_say_so() {
    let (mut blocks, mut r) = chain(20);
    r.insert(link(1, 2));
    r.confirmed(&id(2), 5, block(5));
    blocks.truncate(10);
    for h in 11..=21u8 {
        blocks.push(blk(u32::from(h), 200 + h, 199 + h, &[]));
    }
    r.follow(&window(&blocks));
    r.take_changes();
    let node = Script {
        down: true,
        ..Script::default()
    };
    for _ in 0..CHECKS {
        assert_eq!(check(&mut r, &node).await, 1);
    }
    // The last failed read spent the budget: 2's block is unproven, so it is unknown, and the
    // change is there for the store and the sockets.
    assert_eq!(r.mined(&id(2)), Mined::Unknown);
    assert_eq!(r.take_changes(), vec![Change::Mined(id(2), Mined::Unknown)]);
    assert_eq!(r.asks(), None);
}

#[tokio::test]
async fn answers_dropped_after_another_reorg_do_not_spend_its_reads() {
    let (mut blocks, mut r) = chain(20);
    r.insert(link(3, 4));
    r.confirmed(&id(4), 18, block(18));
    blocks.truncate(10);
    for h in 11..=21u8 {
        blocks.push(blk(u32::from(h), 200 + h, 199 + h, &[]));
    }
    r.follow(&window(&blocks));
    let (epoch, asks) = r.asks().unwrap();
    // Another reorg deeper than the window before the answers land.
    blocks.truncate(10);
    for h in 11..=22u8 {
        blocks.push(blk(u32::from(h), 150 + h, 149 + h, &[]));
    }
    r.follow(&window(&blocks));
    let stale: Vec<_> = (0..CHECKS)
        .map(|_| (asks[0], Some(Answer::Tx(None))))
        .collect();
    r.answers(epoch, &stale);
    assert_eq!(
        r.mined(&id(4)),
        Mined::Unknown,
        "the stale answer is dropped"
    );
    let mut node = Script::default();
    node.txs.insert(id(4), (12, block(162)));
    assert_eq!(
        check(&mut r, &node).await,
        1,
        "this reorg still has its reads"
    );
    assert_eq!(r.mined(&id(4)), Mined::In(Some((12, block(162)))));
}

// What a link keeps beside its figures: each side's outputs and inputs.

/// Outputs paying `value` to a script tagged `n`, and 1,000 sats to a script tagged 0 (change).
fn outs(n: u8, value: u64) -> crate::outputs::Outputs {
    use bitcoin::{Amount, ScriptBuf, TxOut};
    let pay = |v: u64, tag: u8| TxOut {
        value: Amount::from_sat(v),
        script_pubkey: ScriptBuf::from_bytes([&[0x00, 0x14][..], &[tag; 20]].concat()),
    };
    crate::outputs::Outputs::of(&[pay(value, n), pay(1000, 0)])
}

fn sides(a: u8, b: u8) -> Sides {
    Sides {
        outputs: Some(outs(a, 5000)),
        by_outputs: Some(outs(b, 4000)),
        inputs: Some(2),
        by_inputs: Some(3),
        shared: Some(2),
    }
}

#[test]
fn each_version_keeps_its_outputs_through_replace_again() {
    let mut r = Replacements::new(10);
    r.insert_with(link(1, 2), sides(1, 2));
    r.insert_with(link(2, 3), sides(2, 3));
    let changes = r.take_changes();
    assert_eq!(
        changes,
        vec![
            Change::Link(link(1, 2)),
            Change::Sides(id(1), sides(1, 2)),
            Change::Link(link(2, 3)),
            Change::Sides(id(2), sides(2, 3)),
        ]
    );
    // Each version once: the first as replaced, the middle from its own link, the newest as the
    // replacement of the middle one.
    let v = |n: u8| r.version_of(&id(n)).unwrap();
    assert_eq!(v(1).outputs, Some(outs(1, 5000)));
    assert_eq!(v(1).facts, link(1, 2).tx);
    assert_eq!(v(2).outputs, Some(outs(2, 5000)));
    assert_eq!(v(3).outputs, Some(outs(3, 4000)));
    assert_eq!(
        (v(3).inputs, v(3).facts),
        (Some(3), link(2, 3).by_tx.unwrap())
    );
    assert_eq!(r.version_of(&id(9)), None);
    // A link without them keeps nothing beside it, and says nothing to the store.
    r.insert(link(4, 5));
    assert_eq!(r.take_changes(), vec![Change::Link(link(4, 5))]);
    assert_eq!(r.version_of(&id(4)).unwrap().outputs, None);
    assert_eq!(r.sides(&id(4)), None);
}

#[test]
fn the_original_confirmed_after_all_keeps_its_outputs() {
    // B replaced A; then a miner confirmed A: the tracker no longer held A, so the new link has
    // neither A's figures nor its outputs, and both come from A's old link.
    let mut r = Replacements::new(10);
    r.insert_with(link(1, 2), sides(1, 2));
    r.take_changes();
    let came_back = Sides {
        outputs: Some(outs(2, 4000)),
        inputs: Some(3),
        ..Sides::default()
    };
    r.insert_with(won_after_all(), came_back);
    let want = Sides {
        outputs: Some(outs(2, 4000)),
        by_outputs: Some(outs(1, 5000)),
        inputs: Some(3),
        by_inputs: Some(2),
        shared: None,
    };
    assert_eq!(r.sides(&id(2)), Some(&want));
    assert_eq!(
        r.take_changes()[1],
        Change::Sides(id(2), want),
        "what the store is given"
    );
    assert_eq!(r.version_of(&id(1)).unwrap().outputs, Some(outs(1, 5000)));
    assert_eq!(r.sides(&id(1)), None, "the old link went with its outputs");
}

#[test]
fn outputs_leave_with_their_link() {
    let mut r = Replacements::new(2);
    r.insert_with(link(1, 2), sides(1, 2));
    r.insert_with(link(3, 4), sides(3, 4));
    r.insert_with(link(5, 6), sides(5, 6));
    assert_eq!(r.sides(&id(1)), None, "past the bound");
    assert!(r.sides(&id(3)).is_some());
    // Back in the mempool: no longer replaced, so nothing to compare.
    r.returned(&id(3));
    assert_eq!((r.sides(&id(3)), r.version_of(&id(3))), (None, None));
    assert!(r.sides(&id(5)).is_some());
}

#[tokio::test]
async fn outputs_survive_a_restart() {
    let t = temp();
    let mut r = Replacements::new(10);
    r.insert_with(link(1, 2), sides(1, 2));
    r.insert_with(link(2, 3), sides(2, 3));
    r.insert(link(7, 8));
    let too_many = Sides {
        outputs: Some(crate::outputs::Outputs::TooMany(400)),
        ..Sides::default()
    };
    r.insert_with(link(9, 10), too_many.clone());
    db::write(&t.store, vec![r.take_changes()], 10)
        .await
        .unwrap();
    let again = Store::open(&t.dir, "regtest", Options::default()).unwrap();
    let mut back = Replacements::new(10);
    for (l, s) in db::load_kept(&again, 10).await.unwrap() {
        back.restore_with(l, s);
    }
    for n in [1, 2, 3, 7, 8, 9] {
        assert_eq!(back.version_of(&id(n)), r.version_of(&id(n)), "{n}");
    }
    assert_eq!(back.sides(&id(9)), Some(&too_many));
    assert_eq!(back.sides(&id(7)), None);
}

/// A table written before migration 0021 reads back with its links whole and nothing beside them;
/// a row written after it keeps what it was given.
#[tokio::test]
async fn rows_from_before_the_outputs_read_back_without_them() {
    use crate::store::MIGRATIONS;
    let dir = std::env::temp_dir().join(format!(
        "rbitcoin-space-replacements-old-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let at = MIGRATIONS
        .iter()
        .position(|(n, _)| *n == "0021_replacement_outputs.sql")
        .unwrap();
    let old = Store::open_with(&dir, "regtest", Options::default(), &MIGRATIONS[..at]).unwrap();
    // The statement the build before wrote with: no outputs columns.
    let l = link(1, 2);
    old.write(move |sql| {
        sql.prepare(
            "INSERT INTO replacements (txid, by, seen, fee, vsize, weight, value, time, rbf, \
             by_fee, by_vsize, by_weight, by_value, by_time, by_rbf, mined, height, block) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, NULL, \
             NULL)",
        )?
        .execute(crate::store::params![
            l.txid.to_byte_array(),
            l.by.to_byte_array(),
            l.seen as i64,
            l.tx.fee as i64,
            l.tx.vsize,
            l.tx.weight,
            l.tx.value as i64,
            l.tx.time,
            l.tx.rbf,
            l.by_tx.map(|f| f.fee as i64),
            l.by_tx.map(|f| f.vsize),
            l.by_tx.map(|f| f.weight),
            l.by_tx.map(|f| f.value as i64),
            l.by_tx.map(|f| f.time),
            l.by_tx.map(|f| f.rbf),
        ])?;
        Ok(())
    })
    .await
    .unwrap();
    old.close().await;
    let store = Store::open(&dir, "regtest", Options::default()).unwrap();
    let mut r = Replacements::new(10);
    r.insert_with(link(3, 4), sides(3, 4));
    db::write(&store, vec![r.take_changes()], 10).await.unwrap();
    let loaded = db::load_kept(&store, 10).await.unwrap();
    assert_eq!(
        loaded,
        vec![(link(1, 2), Sides::default()), (link(3, 4), sides(3, 4))]
    );
    // A stored form that does not read back is left out, as if never recorded.
    store
        .write(|sql| {
            sql.prepare("UPDATE replacements SET outputs = x'0102' WHERE by = ?1")?
                .execute(crate::store::params![id(4).to_byte_array()])?;
            Ok(())
        })
        .await
        .unwrap();
    let loaded = db::load_kept(&store, 10).await.unwrap();
    assert_eq!(loaded[1].1.outputs, None);
    assert_eq!(loaded[1].1.by_outputs, sides(3, 4).by_outputs);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_later_link_without_outputs_does_not_hide_an_earlier_ones() {
    // A → B kept B's outputs; B came back past the budget and C replaced it, so B → C has none.
    let mut r = Replacements::new(10);
    r.insert_with(link(1, 2), sides(1, 2));
    let bare = Sides {
        shared: Some(1),
        ..Sides::default()
    };
    r.insert_with(link(2, 3), bare);
    let b = r.version_of(&id(2)).unwrap();
    assert_eq!(b.facts, link(2, 3).tx, "its own figures first");
    assert_eq!((b.outputs, b.inputs), (Some(outs(2, 4000)), Some(3)));
}

#[test]
fn earlier_versions_come_before_children_in_the_cut() {
    // 200 replaced its one direct conflict, 250, and evicted 33 children of it that sort first.
    let child = Sides {
        shared: Some(0),
        ..Sides::default()
    };
    let mut r = Replacements::new(100);
    for c in 1..=33 {
        r.insert_with(link(c, 200), child.clone());
    }
    r.insert_with(link(250, 200), sides(250, 200));
    let (back, more) = r.earlier(&id(200));
    assert!(more);
    assert_eq!(back.len(), MAX_LINKS);
    assert_eq!(back[0].txid, id(250));
}

// Versions of one another: joined by version links only (`docs/MEMPOOL.md`, "Versions").

/// A record from `(replaced, replacement, shared inputs)`, in that order; `None` is a link stored
/// before shared inputs were counted.
fn record(links: &[(u8, u8, Option<u32>)]) -> Replacements {
    let mut r = Replacements::new(1000);
    for (a, b, shared) in links {
        let sides = Sides {
            shared: *shared,
            ..Sides::default()
        };
        r.insert_with(link(*a, *b), sides);
    }
    r
}

/// Asks `are_versions` both ways round, and that each one's line holds the other exactly then.
fn versions_both_ways(r: &Replacements, a: u8, b: u8) -> bool {
    let (x, y) = (
        r.are_versions(&id(a), &id(b)),
        r.are_versions(&id(b), &id(a)),
    );
    assert_eq!(x, y, "{a} and {b} asked both ways");
    assert_eq!(
        r.versions(&id(a)).0.contains(&id(b)),
        x,
        "{a}'s line and {b}"
    );
    assert_eq!(
        r.versions(&id(b)).0.contains(&id(a)),
        x,
        "{b}'s line and {a}"
    );
    x
}

fn line(r: &Replacements, t: u8) -> Vec<Txid> {
    r.versions(&id(t)).0
}

#[test]
fn a_chain_of_bumps_is_one_line() {
    let r = record(&[(1, 2, Some(1)), (2, 3, Some(1))]);
    assert!(versions_both_ways(&r, 1, 2) && versions_both_ways(&r, 1, 3));
    assert_eq!(line(&r, 1), vec![id(1), id(2), id(3)]);
    assert_eq!(line(&r, 3), line(&r, 2));
    // A count not recorded (before migration 0021) counts as a version link.
    let old = record(&[(1, 2, None)]);
    assert!(versions_both_ways(&old, 1, 2));
}

#[test]
fn a_child_that_left_with_its_parent_is_no_version() {
    // P (10) replaced by Q (11); X (12) spent from P and left with it.
    let r = record(&[(10, 11, Some(1)), (12, 11, Some(0))]);
    assert!(versions_both_ways(&r, 10, 11));
    assert!(!versions_both_ways(&r, 12, 11));
    assert!(!versions_both_ways(&r, 12, 10));
    assert_eq!(line(&r, 12), Vec::<Txid>::new());
    assert_eq!(line(&r, 11), vec![id(10), id(11)]);
}

#[test]
fn a_bumped_child_stays_a_version_of_what_it_bumped() {
    // A (1) bumped to B (2), which spends from P (10); then Q (11) replaced P and removed B.
    let r = record(&[(1, 2, Some(1)), (10, 11, Some(1)), (2, 11, Some(0))]);
    assert!(
        versions_both_ways(&r, 1, 2),
        "a real bump, whatever happened to B after"
    );
    assert!(
        !versions_both_ways(&r, 1, 11),
        "the path to Q crosses a child's link"
    );
    assert!(!versions_both_ways(&r, 2, 11));
    assert!(!versions_both_ways(&r, 1, 10));
    assert_eq!(line(&r, 1), vec![id(1), id(2)]);
    assert_eq!(line(&r, 2), vec![id(1), id(2)]);
    assert_eq!(line(&r, 11), vec![id(10), id(11)]);
}

#[test]
fn children_and_what_they_replaced_cannot_crowd_out_an_earlier_version() {
    // R (200) → P (201) → Q (202); Q also removed 31 children of P (1..=31), each of which had
    // replaced something (101..=131). The children are recorded first, so they sort first.
    let mut links: Vec<(u8, u8, Option<u32>)> = Vec::new();
    for c in 1..=31 {
        links.push((c + 100, c, Some(1)));
        links.push((c, 202, Some(0)));
    }
    links.extend([(200, 201, Some(1)), (201, 202, Some(1))]);
    let r = record(&links);
    assert_eq!(line(&r, 202), vec![id(200), id(201), id(202)]);
    assert!(!r.versions(&id(202)).1);
    assert!(versions_both_ways(&r, 200, 202));
    assert!(!versions_both_ways(&r, 101, 202));
    assert!(!versions_both_ways(&r, 1, 202));
    // A child's own earlier version is its line, not Q's.
    assert!(versions_both_ways(&r, 101, 1));
    // The links listed back from Q: both versions before any child or what a child replaced.
    let (back, more) = r.earlier(&id(202));
    assert!(more);
    assert_eq!(txids(&back[..2]), vec![id(201), id(200)]);
}

#[test]
fn a_line_longer_than_it_holds_keeps_its_own_and_the_newest_and_says_so() {
    // 1 → 2 → … → 40: forty versions, more than a line holds.
    let links: Vec<(u8, u8, Option<u32>)> = (1..40).map(|i| (i, i + 1, Some(1))).collect();
    let r = record(&links);
    let held = u8::try_from(MAX_LINKS).unwrap_or(u8::MAX);
    // From the oldest: itself, what replaced it (the pair its page compares first), then the
    // versions nearest the newest, the newest among them.
    let (line, more) = r.versions(&id(1));
    assert!(more, "it says versions were left out");
    assert_eq!(line.len(), MAX_LINKS + 1);
    assert_eq!(line.first(), Some(&id(1)));
    assert_eq!(line.get(1), Some(&id(2)));
    assert_eq!(line.get(2), Some(&id(40 - held + 2)));
    assert_eq!(line.last(), Some(&id(40)));
    // From the middle, the same three: itself, its replacement, the newest.
    let (line, _) = r.versions(&id(3));
    assert_eq!(line.first(), Some(&id(3)));
    assert_eq!(line.get(1), Some(&id(4)));
    assert_eq!(line.last(), Some(&id(40)));
    // From the newest: the nearest versions, and that there were more.
    let (line, more) = r.versions(&id(40));
    assert!(more);
    assert_eq!(line.len(), MAX_LINKS + 1);
    assert_eq!(line.last(), Some(&id(40)));
    // Exactly as many as a line holds: all of them, and nothing left out.
    let links: Vec<(u8, u8, Option<u32>)> = (1..=held).map(|i| (i, i + 1, Some(1))).collect();
    let (line, more) = record(&links).versions(&id(1));
    assert!(!more);
    assert_eq!(line.len(), MAX_LINKS + 1);
    assert_eq!(
        (line.first(), line.last()),
        (Some(&id(1)), Some(&id(held + 1)))
    );
}
