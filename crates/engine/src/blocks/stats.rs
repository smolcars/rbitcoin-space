//! Fee facts and the per-transaction records of one block, as [`super::Lister`] lists it. Pure.

use std::collections::HashMap;

use bitcoin::{BlockHash, Txid};
use node::rpc::model::{Block, BlockTx};
use serde::Serialize;

use super::Coinbase;
use crate::mining::pools;
use crate::replacements::Replacements;

use crate::projected::{BAND_EDGES, BANDS, Bands};

/// Version of the [`encode_txs`] format, its first four bytes.
pub const TXS_FORMAT: u32 = 2;
/// Bytes before the first record: format version and record count, both `u32` little-endian.
pub const TXS_HEADER: usize = 8;
/// Bytes per transaction: vsize `u32`, fee `u64`, output value `u64`, [`crate::flags`] `u64`,
/// all little-endian.
pub const TXS_RECORD: usize = 28;

/// The facts of one block, as `/app/block/{hash}/summary` answers them. Everything except
/// `tx_count` leaves the coinbase out, as `getblockstats` does.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Facts {
    pub id: BlockHash,
    pub height: u32,
    /// Every transaction, the coinbase included, as Esplora's `tx_count`.
    pub tx_count: usize,
    /// Sum of the fees, in sats.
    pub fees: u64,
    /// Sum of the virtual sizes; equals the sum of `fee_bands`.
    pub vsize: u64,
    pub weight: u64,
    /// `None` for a block holding only its coinbase.
    pub fee_rate: Option<Rates>,
    /// Virtual size paid at each of the design's bands, cheapest first, banded on the rate as
    /// the frontend prints it (two decimals), so a stratum's color agrees with its number. 12
    /// bands, or 10 for a block stored before the lowest was split ([`Bands`]).
    pub fee_bands: Bands,
    /// Who mined it, by the pool list's rules.
    pub miner: Miner,
}

/// Who mined a block: a pool from the shipped list, or Unknown. Never text from the block, whose
/// coinbase tag is whatever its miner wrote; a tag only selects one of the list's names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Miner {
    pub name: &'static str,
    /// The pool page's slug, `unknown` for Unknown.
    pub slug: &'static str,
}

impl Miner {
    pub const UNKNOWN: Self = Self {
        name: "Unknown",
        slug: "unknown",
    };

    /// The pool [`pools::Pools::attribute`] gives this coinbase: its payout address first, then
    /// its tag.
    pub fn of(coinbase: &Coinbase) -> Self {
        let list = pools::list();
        let (id, _) = list.attribute(&coinbase.tag, &coinbase.payouts);
        list.by_id(id).map_or(Self::UNKNOWN, |p| Self {
            name: &p.name,
            slug: &p.slug,
        })
    }
}

/// Fee rates in sat/vB, unrounded. Percentiles are weighted by virtual size: `p25` is the rate
/// of the transaction that the cheapest quarter of the block's vbytes reaches.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rates {
    pub min: f64,
    pub p10: f64,
    pub p25: f64,
    pub median: f64,
    pub p75: f64,
    pub p90: f64,
    pub max: f64,
}

/// One block's facts. The first transaction is taken as the coinbase, whatever its fee says.
pub fn facts(block: &Block) -> Facts {
    let paying = block.tx.get(1..).unwrap_or_default();
    let mut fee_bands = [0u64; BANDS];
    let (mut fees, mut vsize, mut weight) = (0u64, 0u64, 0u64);
    for tx in paying {
        let (fee, size) = fee_and_size(tx);
        fees = fees.saturating_add(fee);
        vsize += u64::from(tx.vsize);
        weight += u64::from(tx.weight);
        if let Some(b) = fee_bands.get_mut(band(fee, size)) {
            *b += u64::from(tx.vsize);
        }
    }
    Facts {
        id: block.hash,
        height: block.height,
        tx_count: block.tx.len(),
        fees,
        vsize,
        weight,
        fee_rate: rates(paying),
        fee_bands: Bands::new(fee_bands),
        miner: Miner::of(&Coinbase::from_parts(
            block.coinbase.script.as_bytes(),
            &block.coinbase.outputs,
        )),
    }
}

/// Fee in sats and a size that is never zero, so a malformed reply cannot divide by zero.
fn fee_and_size(tx: &BlockTx) -> (u64, u64) {
    (tx.fee.map_or(0, |f| f.to_sat()), u64::from(tx.vsize.max(1)))
}

/// The band index (0–11) of `fee / size`, rounded half up to hundredths first, as printed.
fn band(fee: u64, size: u64) -> usize {
    let hundredths = (u128::from(fee) * 200 + u128::from(size)) / (2 * u128::from(size));
    BAND_EDGES
        .iter()
        .take_while(|&&b| u128::from(b) <= hundredths)
        .count()
}

fn rates(paying: &[BlockTx]) -> Option<Rates> {
    let mut txs: Vec<(u64, u64)> = paying.iter().map(fee_and_size).collect();
    // Exact: compares fee_a / size_a with fee_b / size_b by cross-multiplying.
    txs.sort_unstable_by(|a, b| {
        (u128::from(a.0) * u128::from(b.1)).cmp(&(u128::from(b.0) * u128::from(a.1)))
    });
    let rate = |t: &(u64, u64)| t.0 as f64 / t.1 as f64;
    let total: u64 = txs.iter().map(|t| t.1).sum();
    // The first transaction at which the running vsize reaches `pct` percent of the total.
    let at = |pct: u64| {
        let mut seen = 0u64;
        txs.iter()
            .find(|t| {
                seen += t.1;
                u128::from(seen) * 100 >= u128::from(total) * u128::from(pct)
            })
            .map(rate)
    };
    Some(Rates {
        min: txs.first().map(rate)?,
        p10: at(10)?,
        p25: at(25)?,
        median: at(50)?,
        p75: at(75)?,
        p90: at(90)?,
        max: txs.last().map(rate)?,
    })
}

/// Each transaction's [`crate::flags::of`], in block order, read from the block's raw bytes,
/// with [`crate::flags::PAID_BY_CHILD`] and [`crate::flags::PAYS_FOR_PARENT`] from its direct
/// relatives in the block: a child paying a rate more than [`crate::flags::CPFP_MARGIN_PERCENT`]
/// above its parent's. `None` unless `raw` holds the listed transactions in the listed order: a
/// different block under the same hash, or a short one, must not lend its flags.
pub fn flags(block: &Block, raw: &bitcoin::Block) -> Option<Vec<u64>> {
    use crate::flags::{PAID_BY_CHILD, PAYS_FOR_PARENT};
    if raw.txdata.len() != block.tx.len() {
        return None;
    }
    let mut out = raw
        .txdata
        .iter()
        .zip(&block.tx)
        .map(|(t, listed)| (t.compute_txid() == listed.txid).then(|| crate::flags::of(t)))
        .collect::<Option<Vec<_>>>()?;
    let index: HashMap<Txid, usize> = block
        .tx
        .iter()
        .enumerate()
        .map(|(i, t)| (t.txid, i))
        .collect();
    // The coinbase is neither: it spends nothing in the block, and nothing may spend it there.
    for (c, (t, child)) in raw.txdata.iter().zip(&block.tx).enumerate().skip(1) {
        for input in &t.input {
            let Some(&p) = index.get(&input.previous_output.txid) else {
                continue;
            };
            if p != 0
                && block
                    .tx
                    .get(p)
                    .is_some_and(|parent| pays_more(child, parent))
            {
                // `out` is as long as `block.tx`, so both are there.
                if let Some(f) = out.get_mut(p) {
                    *f |= PAID_BY_CHILD;
                }
                if let Some(f) = out.get_mut(c) {
                    *f |= PAYS_FOR_PARENT;
                }
            }
        }
    }
    Some(out)
}

/// `a`'s fee rate is more than [`crate::flags::CPFP_MARGIN_PERCENT`] above `b`'s, exactly: fee
/// over weight, cross-multiplied, never rounded.
fn pays_more(a: &BlockTx, b: &BlockTx) -> bool {
    use crate::flags::CPFP_MARGIN_PERCENT as M;
    let fee = |t: &BlockTx| u128::from(t.fee.map_or(0, |f| f.to_sat()));
    fee(a) * u128::from(b.weight) * 100 > fee(b) * u128::from(a.weight) * u128::from(100 + M)
}

/// Sets [`crate::flags::REPLACEMENT`] on each transaction the record holds as having replaced
/// another. One hash lookup per transaction; an empty record sets none.
pub fn mark_replacements(block: &Block, record: &Replacements, flags: &mut [u64]) {
    for (t, f) in block.tx.iter().zip(flags) {
        if !record.replaced_by(&t.txid).is_empty() {
            *f |= crate::flags::REPLACEMENT;
        }
    }
}

/// Every transaction in block order, coinbase first (its fee is 0), as fixed-width records
/// after an 8-byte header ([`TXS_FORMAT`], count). A square needs no txid up front: the public
/// API resolves a block hash and index to one (`/api/block/:hash/txid/:index`). `flags` is
/// [`flags`]' answer for this block, one per transaction.
pub fn encode_txs(block: &Block, flags: &[u64]) -> Vec<u8> {
    let count = block.tx.len().min(flags.len());
    let mut out = Vec::with_capacity(TXS_HEADER + TXS_RECORD * count);
    out.extend_from_slice(&TXS_FORMAT.to_le_bytes());
    let count = u32::try_from(count).unwrap_or(u32::MAX);
    out.extend_from_slice(&count.to_le_bytes());
    for (tx, f) in block.tx.iter().zip(flags).take(count as usize) {
        out.extend_from_slice(&tx.vsize.to_le_bytes());
        out.extend_from_slice(&tx.fee.map_or(0, |f| f.to_sat()).to_le_bytes());
        out.extend_from_slice(&tx.value.to_sat().to_le_bytes());
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use bitcoin::hashes::Hash;
    use bitcoin::{Amount, Txid};

    use super::*;

    fn tx(fee: Option<u64>, vsize: u32) -> BlockTx {
        BlockTx {
            txid: Txid::all_zeros(),
            fee: fee.map(Amount::from_sat),
            vsize,
            weight: vsize * 4,
            value: Amount::from_sat(u64::from(vsize) * 1000),
        }
    }

    fn block(paying: &[(u64, u32)]) -> Block {
        let mut tx_list = vec![tx(None, 150)];
        tx_list.extend(paying.iter().map(|&(f, v)| tx(Some(f), v)));
        Block {
            hash: BlockHash::all_zeros(),
            height: 7,
            time: 0,
            mediantime: 0,
            size: 0,
            weight: 0,
            previousblockhash: None,
            tx: tx_list,
            coinbase: Default::default(),
        }
    }

    #[test]
    fn weighted_percentiles_keep_sub_sat_rates() {
        // 0.11, 0.25, 0.5 and 2 sat/vB; the 0.25 transaction holds most of the vbytes.
        let b = block(&[(11, 100), (2500, 10_000), (50, 100), (400, 200)]);
        let f = facts(&b);
        let r = f.fee_rate.unwrap();
        assert_eq!((r.min, r.max), (0.11, 2.0));
        // Cumulative vsize: 100 (1%), 10 100 (97%), 10 200 (98%), 10 400 (100%).
        assert_eq!(
            (r.p10, r.p25, r.median, r.p75, r.p90),
            (0.25, 0.25, 0.25, 0.25, 0.25)
        );
        let b = block(&[(10, 100), (20, 100), (30, 100), (40, 100)]);
        let r = facts(&b).fee_rate.unwrap();
        assert_eq!(
            (r.p10, r.p25, r.median, r.p75, r.p90),
            (0.1, 0.1, 0.2, 0.3, 0.4)
        );
        assert_eq!(
            (f.tx_count, f.fees, f.vsize, f.weight),
            (5, 2961, 10_400, 41_600)
        );
    }

    fn mined(tag: &[u8], pays: &str) -> Miner {
        use std::str::FromStr;
        let script = bitcoin::Address::from_str(pays)
            .unwrap()
            .assume_checked()
            .script_pubkey();
        let mut b = block(&[]);
        b.coinbase = node::rpc::model::Coinbase {
            script: bitcoin::ScriptBuf::from_bytes(tag.to_vec()),
            outputs: vec![
                bitcoin::TxOut {
                    value: Amount::ZERO,
                    script_pubkey: bitcoin::ScriptBuf::new_op_return([0xaa; 4]),
                },
                bitcoin::TxOut {
                    value: Amount::from_sat(312_500_000),
                    script_pubkey: script,
                },
            ],
        };
        facts(&b).miner
    }

    #[test]
    fn the_miner_is_a_listed_name_payout_first() {
        const ELSEWHERE: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
        // Tagged ViaBTC but paying Foundry USA's listed address: Foundry USA's.
        let m = mined(
            b"\x03\x97\xe2\x0e/ViaBTC/",
            "12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL",
        );
        assert_eq!((m.name, m.slug), ("Foundry USA", "foundryusa"));
        // A tag alone names its pool, by the list's spelling.
        let m = mined(b"\x03\x97\xe2\x0e/viabtc/", ELSEWHERE);
        assert_eq!((m.name, m.slug), ("ViaBTC", "viabtc"));
        // Anything else is Unknown, and the tag's text never becomes a name.
        for tag in [
            &b"<img src=x onerror=alert(1)>"[..],
            b"\x00\x1b[31m\xe2\x80\xaeMy Pool",
            b"",
        ] {
            assert_eq!(mined(tag, ELSEWHERE), Miner::UNKNOWN);
        }
        assert_eq!(facts(&block(&[])).miner, Miner::UNKNOWN, "no coinbase read");
        let json = serde_json::to_value(facts(&block(&[]))).unwrap();
        assert_eq!(
            json["miner"],
            serde_json::json!({"name": "Unknown", "slug": "unknown"})
        );
    }

    #[test]
    fn a_coinbase_only_block_has_no_rates() {
        let f = facts(&block(&[]));
        assert_eq!(f.tx_count, 1);
        assert_eq!((f.fees, f.vsize, f.fee_rate), (0, 0, None));
        assert_eq!(f.fee_bands.list(), [0; 12]);
        let empty = Block {
            tx: Vec::new(),
            ..block(&[])
        };
        assert_eq!(facts(&empty).tx_count, 0);
        assert_eq!(encode_txs(&empty, &[]), [2, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn identical_rates_give_one_value_everywhere() {
        let f = facts(&block(&[(70, 140), (35, 70), (700, 1400)]));
        let r = f.fee_rate.unwrap();
        for v in [r.min, r.p10, r.p25, r.median, r.p75, r.p90, r.max] {
            assert_eq!(v, 0.5);
        }
        assert_eq!(f.fee_bands.list()[5], 1610);
    }

    #[test]
    fn bands_follow_the_printed_rate_and_sum_to_the_whole() {
        // 0.1995 prints as 0.20 (band 4); 0.1949 as 0.19 (band 3); 0.1196 as 0.12 (band 2);
        // 0.1149 as 0.11 (band 1); 9.996 as 10.0 (band 12).
        assert_eq!(band(1995, 10_000), 3);
        assert_eq!(band(1949, 10_000), 2);
        assert_eq!(band(1196, 10_000), 1);
        assert_eq!(band(1149, 10_000), 0);
        assert_eq!(band(9996, 1000), 11);
        assert_eq!(band(0, 1), 0);
        assert_eq!(band(u64::MAX, 1), 11);
        let edges = [0, 12, 15, 20, 30, 50, 100, 150, 200, 300, 500, 1000];
        for (i, fee) in edges.into_iter().enumerate() {
            assert_eq!(band(fee, 100), i, "{fee}/100");
        }
        let b = block(&[
            (11, 100),
            (13, 100),
            (17, 100),
            (2500, 10_000),
            (50, 100),
            (400, 200),
            (5000, 333),
        ]);
        let f = facts(&b);
        assert_eq!(f.fee_bands.list().iter().sum::<u64>(), f.vsize);
        assert_eq!(
            f.fee_bands.list(),
            [100, 100, 100, 10_000, 0, 100, 0, 0, 200, 0, 0, 333]
        );
        // Stored as the ten bands, the lowest under 0.2 whole, and its split.
        assert_eq!(
            f.fee_bands.stored,
            [300, 10_000, 0, 100, 0, 0, 200, 0, 0, 333]
        );
        assert_eq!(f.fee_bands.split, Some([100, 100]));
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["fee_bands"].as_array().unwrap().len(), 12);
    }

    #[test]
    fn zero_sizes_and_huge_fees_do_not_panic() {
        let f = facts(&block(&[(5, 0), (u64::MAX / 2, 1), (u64::MAX / 2, 1)]));
        assert_eq!(f.fees, u64::MAX, "saturates");
        assert!(f.fee_rate.unwrap().max > 1e18);
    }

    #[test]
    fn flags_come_only_from_the_listed_transactions_in_their_order() {
        use bitcoin::{OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness};
        let t = |vout: u32| Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::all_zeros(),
                    vout,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(1),
                script_pubkey: ScriptBuf::new_op_return([]),
            }],
        };
        let raw = |txdata: Vec<Transaction>| bitcoin::Block {
            header: bitcoin::constants::genesis_block(bitcoin::Network::Regtest).header,
            txdata,
        };
        let txs = vec![t(0), t(1), t(2)];
        let mut b = block(&[(1, 100), (2, 100)]);
        for (listed, t) in b.tx.iter_mut().zip(&txs) {
            listed.txid = t.compute_txid();
        }
        let got = flags(&b, &raw(txs.clone())).unwrap();
        assert_eq!(got, txs.iter().map(crate::flags::of).collect::<Vec<_>>());
        assert!(got.iter().all(|f| f & crate::flags::OP_RETURN != 0));
        assert_eq!(
            flags(&b, &raw(vec![t(1), t(0), t(2)])),
            None,
            "out of order"
        );
        assert_eq!(flags(&b, &raw(txs[..2].to_vec())), None, "short");
        assert_eq!(flags(&b, &raw(vec![t(0), t(1), t(2), t(3)])), None, "long");
        assert_eq!(
            flags(&b, &raw(vec![t(0), t(1), t(9)])),
            None,
            "another transaction"
        );
    }

    /// A block of `txs`, each `(fee, weight, parents)`: the coinbase first, then one transaction
    /// per entry spending output 0 of each parent, an index into the block or `None` for a
    /// transaction outside it. Returns its listing and its raw bytes.
    fn family(txs: &[(u64, u32, &[Option<usize>])]) -> (Block, bitcoin::Block) {
        use bitcoin::{OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness};
        let make = |n: u8, prevs: Vec<OutPoint>| Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: prevs
                .into_iter()
                .map(|previous_output| TxIn {
                    previous_output,
                    script_sig: ScriptBuf::new(),
                    sequence: Sequence::MAX,
                    witness: Witness::new(),
                })
                .collect(),
            output: vec![TxOut {
                value: Amount::from_sat(1),
                script_pubkey: ScriptBuf::new_op_return([n]),
            }],
        };
        let mut raw = vec![make(0, vec![OutPoint::null()])];
        for (n, (_, _, parents)) in (1u8..).zip(txs) {
            let prevs = parents
                .iter()
                .map(|p| OutPoint {
                    txid: p.map_or(Txid::from_byte_array([0xee; 32]), |i| raw[i].compute_txid()),
                    vout: 0,
                })
                .collect();
            raw.push(make(n, prevs));
        }
        let mut b = block(&[]);
        b.tx[0].txid = raw[0].compute_txid();
        for ((fee, weight, _), t) in txs.iter().zip(&raw[1..]) {
            b.tx.push(BlockTx {
                txid: t.compute_txid(),
                weight: *weight,
                ..tx(Some(*fee), weight.div_ceil(4))
            });
        }
        let raw = bitcoin::Block {
            header: bitcoin::constants::genesis_block(bitcoin::Network::Regtest).header,
            txdata: raw,
        };
        (b, raw)
    }

    /// Bits 16 and 17 of each transaction after the coinbase, as `(paid for, pays for)`.
    fn cpfp(txs: &[(u64, u32, &[Option<usize>])]) -> Vec<(bool, bool)> {
        use crate::flags::{PAID_BY_CHILD, PAYS_FOR_PARENT};
        let (b, raw) = family(txs);
        let f = flags(&b, &raw).unwrap();
        assert_eq!(
            f[0] & (PAID_BY_CHILD | PAYS_FOR_PARENT),
            0,
            "the coinbase is neither"
        );
        f[1..]
            .iter()
            .map(|f| (f & PAID_BY_CHILD != 0, f & PAYS_FOR_PARENT != 0))
            .collect()
    }

    #[test]
    fn a_child_paying_more_marks_both() {
        const NONE: (bool, bool) = (false, false);
        // 1 sat/WU parent, 2 sat/WU child.
        assert_eq!(
            cpfp(&[(400, 400, &[]), (1600, 800, &[Some(1)])]),
            [(true, false), (false, true)]
        );
        // The same rate, though not the same fee: neither.
        assert_eq!(
            cpfp(&[(400, 400, &[]), (800, 800, &[Some(1)])]),
            [NONE, NONE]
        );
        // The margin, exactly: 10% more is not enough, one sat past it is, never rounded.
        let child = |fee| cpfp(&[(100_000, 400_000, &[]), (fee, 400_000, &[Some(1)])]);
        assert_eq!(child(109_999), [NONE, NONE], "under");
        assert_eq!(child(110_000), [NONE, NONE], "at");
        assert_eq!(child(110_001), [(true, false), (false, true)], "over");
        // A zero-fee parent with a paying child qualifies; with a zero-fee child it does not.
        assert_eq!(
            cpfp(&[(0, 400, &[]), (1, 400, &[Some(1)])]),
            [(true, false), (false, true)]
        );
        assert_eq!(cpfp(&[(0, 400, &[]), (0, 400, &[Some(1)])]), [NONE, NONE]);
        // A child paying less than its parent: neither.
        assert_eq!(
            cpfp(&[(800, 400, &[]), (400, 400, &[Some(1)])]),
            [NONE, NONE]
        );
        // A chain of three, each paying more: the middle one is both.
        assert_eq!(
            cpfp(&[
                (400, 400, &[]),
                (800, 400, &[Some(1)]),
                (1200, 400, &[Some(2)])
            ]),
            [(true, false), (true, true), (false, true)]
        );
        // Only direct relatives: the grandparent is marked by its own child alone.
        assert_eq!(
            cpfp(&[
                (800, 400, &[]),
                (400, 400, &[Some(1)]),
                (1200, 400, &[Some(2)])
            ]),
            [NONE, (true, false), (false, true)]
        );
        // A child spending two parents pays for the cheaper one only.
        assert_eq!(
            cpfp(&[
                (400, 400, &[]),
                (2000, 400, &[]),
                (1200, 400, &[Some(1), Some(2)])
            ]),
            [(true, false), NONE, (false, true)]
        );
        // A parent outside the block: neither.
        assert_eq!(cpfp(&[(1600, 400, &[None])]), [NONE]);
        // Spending the coinbase's txid marks nothing: the coinbase is never a parent.
        assert_eq!(cpfp(&[(1600, 400, &[Some(0)])]), [NONE]);
    }

    #[test]
    fn replacements_mark_what_replaced_something() {
        use crate::replacements::{Facts, Link, Mined, Replacements};
        let (b, raw) = family(&[(400, 400, &[]), (400, 400, &[])]);
        let (x, y) = (b.tx[1].txid, b.tx[2].txid);
        let base = flags(&b, &raw).unwrap();
        let marked = |r: &Replacements| {
            let mut f = base.clone();
            mark_replacements(&b, r, &mut f);
            f.iter()
                .map(|f| f & crate::flags::REPLACEMENT != 0)
                .collect::<Vec<_>>()
        };
        // An empty record, as after a start with no data directory: none.
        let mut r = Replacements::new(10);
        assert_eq!(marked(&r), [false, false, false]);
        // `y` replaced a transaction outside the block; `x` was itself replaced, and came back.
        let link = |txid, by| Link {
            txid,
            by,
            seen: 0,
            tx: Facts::default(),
            by_tx: None,
            mined: Mined::No,
        };
        r.insert(link(Txid::from_byte_array([1; 32]), y));
        r.insert(link(x, Txid::from_byte_array([2; 32])));
        assert_eq!(marked(&r), [false, false, true]);
    }

    #[test]
    fn records_are_fixed_width_in_block_order() {
        let b = block(&[(11, 100), (u64::from(u32::MAX) + 1, 200)]);
        let out = encode_txs(&b, &[crate::flags::KNOWN, 1 << 44, 7]);
        assert_eq!(out.len(), TXS_HEADER + 3 * TXS_RECORD);
        assert_eq!(out[..8], [2, 0, 0, 0, 3, 0, 0, 0]);
        let rec = |i: usize| &out[TXS_HEADER + i * TXS_RECORD..][..TXS_RECORD];
        let u32_at = |r: &[u8], o: usize| u32::from_le_bytes(r[o..o + 4].try_into().unwrap());
        let u64_at = |r: &[u8], o: usize| u64::from_le_bytes(r[o..o + 8].try_into().unwrap());
        // The coinbase: no fee.
        assert_eq!(
            (u32_at(rec(0), 0), u64_at(rec(0), 4), u64_at(rec(0), 12)),
            (150, 0, 150_000)
        );
        assert_eq!((u32_at(rec(1), 0), u64_at(rec(1), 4)), (100, 11));
        assert_eq!(u64_at(rec(2), 4), 1 << 32);
        assert_eq!(u64_at(rec(2), 12), 200_000);
        // The flags, at offset 20 of each record.
        assert_eq!(u64_at(rec(0), 20), crate::flags::KNOWN);
        assert_eq!(u64_at(rec(1), 20), 1 << 44);
        assert_eq!(u64_at(rec(2), 20), 7);
    }
}
