//! Compares `engine::flags::of` with the reference's flags over whole blocks, per bit.
//!
//! `cargo run --release -p engine --example flags_compare -- <dir>` reads every `<hash>.raw` (a
//! raw block) in `<dir>` with its `<hash>.summary.json` (the reference's
//! `/api/v1/block/:hash/summary`, in block order) and prints, for each bit `of` can set, how
//! many transactions both set, how many only we set (extra) and how many only the reference set
//! (missing). Then, per block, the same for bits 16 and 17 by `stats::flags`' rule for a mined
//! block, which the reference does not share, and the time that rule adds to a block's flags.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// A command-line proof program: its printed output is its purpose.
#![allow(clippy::print_stdout)]

use std::time::{Duration, Instant};

use bitcoin::{Amount, Block, BlockHash, Txid};
use engine::blocks::stats;
use engine::flags::{self, KNOWN, PAID_BY_CHILD, PAYS_FOR_PARENT};
use node::rpc::model::{Block as Listing, BlockTx};
use serde::Deserialize;

#[derive(Deserialize)]
struct Summary {
    txid: String,
    // The reference sends a few as floats a hair off a whole sat.
    fee: f64,
    vsize: f64,
    flags: u64,
}

/// The listing `stats::flags` reads, from the reference's rows: its `vsize` is weight / 4.
fn listing(hash: BlockHash, rows: &[Summary]) -> Listing {
    Listing {
        hash,
        height: 0,
        time: 0,
        mediantime: 0,
        size: 0,
        weight: 0,
        previousblockhash: None,
        tx: rows
            .iter()
            .map(|r| BlockTx {
                txid: r.txid.parse::<Txid>().unwrap(),
                fee: Some(Amount::from_sat(r.fee.round() as u64)),
                vsize: r.vsize.ceil() as u32,
                weight: (r.vsize * 4.0).round() as u32,
                value: Amount::ZERO,
            })
            .collect(),
        coinbase: Default::default(),
    }
}

/// The least of five runs.
fn fastest(mut f: impl FnMut()) -> Duration {
    (0..5)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed()
        })
        .min()
        .unwrap()
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: flags_compare <dir>");
    let mut raws: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "raw"))
        .collect();
    raws.sort();
    let (mut both, mut extra, mut missing) = ([0u32; 64], [0u32; 64], [0u32; 64]);
    let (mut txs, mut equal) = (0u32, 0u32);
    let mut cpfp = Vec::new();
    for raw in &raws {
        let block: Block = bitcoin::consensus::deserialize(&std::fs::read(raw).unwrap()).unwrap();
        let summary: Vec<Summary> =
            serde_json::from_slice(&std::fs::read(raw.with_extension("summary.json")).unwrap())
                .unwrap();
        assert_eq!(block.txdata.len(), summary.len(), "{}", raw.display());
        let listed = listing(block.block_hash(), &summary);
        let ours = stats::flags(&listed, &block).unwrap();
        let count = |bit: u64| {
            let (mut both, mut extra, mut missing) = (0, 0, 0);
            for (o, s) in ours.iter().zip(&summary) {
                let (o, t) = (o & bit != 0, s.flags & bit != 0);
                both += u32::from(o && t);
                extra += u32::from(o && !t);
                missing += u32::from(!o && t);
            }
            (both, extra, missing)
        };
        let own = fastest(|| {
            // `stats::flags` before bits 16 and 17: check each txid, read each transaction.
            std::hint::black_box(
                block
                    .txdata
                    .iter()
                    .map(|t| (t.compute_txid(), flags::of(t)))
                    .collect::<Vec<_>>(),
            );
        });
        let all = fastest(|| {
            std::hint::black_box(stats::flags(&listed, &block));
        });
        cpfp.push((
            block.block_hash(),
            block.txdata.len(),
            count(PAID_BY_CHILD),
            count(PAYS_FOR_PARENT),
            all.saturating_sub(own),
        ));
        for (tx, s) in block.txdata.iter().zip(&summary) {
            assert_eq!(tx.compute_txid().to_string(), s.txid);
            let (ours, theirs) = (flags::of(tx), s.flags & KNOWN);
            txs += 1;
            if ours == theirs {
                equal += 1;
            } else {
                println!(
                    "differs {} extra {:#x} missing {:#x}",
                    s.txid,
                    ours & !theirs,
                    theirs & !ours
                );
            }
            for bit in 0..64 {
                let (o, t) = (ours >> bit & 1 == 1, theirs >> bit & 1 == 1);
                both[bit] += u32::from(o && t);
                extra[bit] += u32::from(o && !t);
                missing[bit] += u32::from(!o && t);
            }
        }
    }
    println!(
        "{} blocks, {txs} transactions, {equal} equal on every known bit",
        raws.len()
    );
    println!("| Bit | Both | Extra | Missing |\n|---|---|---|---|");
    for bit in (0..64).filter(|b| KNOWN >> b & 1 == 1) {
        println!(
            "| {bit} | {} | {} | {} |",
            both[bit], extra[bit], missing[bit]
        );
    }
    println!(
        "\nBits 16 and 17 by our rule (both, extra, missing), and the time it adds\n\
         | Block | Txs | 16 | 17 | Added |\n|---|---|---|---|---|"
    );
    for (hash, n, p, c, added) in cpfp {
        println!(
            "| {hash} | {n} | {} / {} / {} | {} / {} / {} | {:.2} ms |",
            p.0,
            p.1,
            p.2,
            c.0,
            c.1,
            c.2,
            added.as_secs_f64() * 1000.0
        );
    }
}
