//! Compares `engine::flags::of` with the reference's flags over whole blocks, per bit.
//!
//! `cargo run --release -p engine --example flags_compare -- <dir>` reads every `<hash>.raw` (a
//! raw block) in `<dir>` with its `<hash>.summary.json` (the reference's
//! `/api/v1/block/:hash/summary`, in block order) and prints, for each bit `of` can set, how
//! many transactions both set, how many only we set (extra) and how many only the reference set
//! (missing).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// A command-line proof program: its printed output is its purpose.
#![allow(clippy::print_stdout)]

use bitcoin::Block;
use engine::flags::{self, KNOWN};
use serde::Deserialize;

#[derive(Deserialize)]
struct Summary {
    txid: String,
    flags: u64,
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
    for raw in &raws {
        let block: Block = bitcoin::consensus::deserialize(&std::fs::read(raw).unwrap()).unwrap();
        let summary: Vec<Summary> =
            serde_json::from_slice(&std::fs::read(raw.with_extension("summary.json")).unwrap())
                .unwrap();
        assert_eq!(block.txdata.len(), summary.len(), "{}", raw.display());
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
}
