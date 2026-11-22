//! Typed results of the RPC methods, decoded straight from the response bytes.
//!
//! Field names follow the RPC keys so they can be checked against rbitcoin's `docs/rpc.md`.
//! Keys we do not use are skipped while decoding. 8-decimal BTC values become [`Amount`] or
//! [`SignedAmount`]; a fee rate in BTC/kvB becomes the [`Amount`] paid per 1,000 vbytes.

use bitcoin::{Amount, BlockHash, ScriptBuf, SignedAmount, TxMerkleNode, TxOut, Txid, Wtxid};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer};

/// `getblockchaininfo`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BlockchainInfo {
    /// `main`, `test`, `testnet4`, `testnet5`, `signet` or `regtest`.
    pub chain: String,
    pub blocks: u32,
    pub headers: u32,
    pub bestblockhash: BlockHash,
    pub bits: String,
    pub target: String,
    pub difficulty: f64,
    pub time: u32,
    pub mediantime: u32,
    pub verificationprogress: f64,
    /// rbitcoin: relay-inhibited, not "still catching up".
    pub initialblockdownload: bool,
    /// Summed header work, 64 hex characters.
    pub chainwork: String,
    pub size_on_disk: u64,
    pub pruned: bool,
    /// The last height rbitcoin has pruned, absent until it drops data.
    pub pruneheight: Option<u32>,
}

/// `getblockheader` with `verbose = true`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BlockHeader {
    pub hash: BlockHash,
    /// `-1` when the block is not on the active chain.
    pub confirmations: i64,
    pub height: u32,
    pub version: i32,
    pub merkleroot: TxMerkleNode,
    pub time: u32,
    pub mediantime: u32,
    pub nonce: u32,
    pub bits: String,
    pub target: String,
    pub difficulty: f64,
    pub chainwork: String,
    #[serde(rename = "nTx")]
    pub n_tx: u32,
    /// Absent on genesis.
    pub previousblockhash: Option<BlockHash>,
    /// Absent on the tip and off the active chain.
    pub nextblockhash: Option<BlockHash>,
}

/// `getblock` with verbosity 2, reduced to what fee and size views need. Inputs, outputs
/// and scripts are skipped while decoding, except the first transaction's ([`Block::coinbase`]).
/// The engine builds the same value from Esplora's block summary route where the node has it,
/// so every field here must be one that route and its companions can give.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "RawBlock")]
pub struct Block {
    pub hash: BlockHash,
    pub height: u32,
    pub time: u32,
    pub mediantime: u32,
    pub size: u64,
    pub weight: u64,
    /// Absent on genesis.
    pub previousblockhash: Option<BlockHash>,
    /// In block order, coinbase first.
    pub tx: Vec<BlockTx>,
    /// The first transaction's input script and outputs, for telling who mined the block.
    pub coinbase: Coinbase,
}

/// A block's coinbase as far as pool attribution needs it. Chain data written by the miner.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Coinbase {
    /// `vin[0].coinbase`; empty when the first transaction has none.
    pub script: ScriptBuf,
    /// Every output, in order.
    pub outputs: Vec<TxOut>,
}

/// [`Block`] as sent, its transactions read by [`Txs`].
#[derive(Deserialize)]
struct RawBlock {
    hash: BlockHash,
    height: u32,
    time: u32,
    mediantime: u32,
    size: u64,
    weight: u64,
    previousblockhash: Option<BlockHash>,
    tx: Txs,
}

impl From<RawBlock> for Block {
    fn from(b: RawBlock) -> Self {
        Self {
            hash: b.hash,
            height: b.height,
            time: b.time,
            mediantime: b.mediantime,
            size: b.size,
            weight: b.weight,
            previousblockhash: b.previousblockhash,
            tx: b.tx.0,
            coinbase: b.tx.1,
        }
    }
}

/// Every transaction as a [`BlockTx`], and the first one's [`Coinbase`] too.
struct Txs(Vec<BlockTx>, Coinbase);

/// The first transaction: a [`BlockTx`] with its input script and output scripts kept.
#[derive(Deserialize)]
struct FirstTx {
    txid: Txid,
    #[serde(default, deserialize_with = "opt_btc")]
    fee: Option<Amount>,
    vsize: u32,
    weight: u32,
    #[serde(default)]
    vin: Vec<FirstIn>,
    vout: Vec<FirstOut>,
}

#[derive(Deserialize)]
struct FirstIn {
    #[serde(default, deserialize_with = "opt_script")]
    coinbase: Option<ScriptBuf>,
}

#[derive(Deserialize)]
struct FirstOut {
    #[serde(deserialize_with = "btc")]
    value: Amount,
    #[serde(rename = "scriptPubKey", default)]
    script_pub_key: ScriptHex,
}

#[derive(Deserialize, Default)]
struct ScriptHex {
    #[serde(deserialize_with = "script")]
    hex: ScriptBuf,
}

impl<'de> Deserialize<'de> for Txs {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = Txs;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a list of transactions")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Txs, A::Error> {
                let mut txs = Vec::new();
                let mut coinbase = Coinbase::default();
                if let Some(first) = seq.next_element::<FirstTx>()? {
                    let mut value = Amount::ZERO;
                    for o in &first.vout {
                        value = value
                            .checked_add(o.value)
                            .ok_or_else(|| A::Error::custom("output total out of range"))?;
                    }
                    txs.push(BlockTx {
                        txid: first.txid,
                        fee: first.fee,
                        vsize: first.vsize,
                        weight: first.weight,
                        value,
                    });
                    coinbase = Coinbase {
                        script: first
                            .vin
                            .into_iter()
                            .next()
                            .and_then(|i| i.coinbase)
                            .unwrap_or_default(),
                        outputs: first
                            .vout
                            .into_iter()
                            .map(|o| TxOut {
                                value: o.value,
                                script_pubkey: o.script_pub_key.hex,
                            })
                            .collect(),
                    };
                }
                while let Some(tx) = seq.next_element::<BlockTx>()? {
                    txs.push(tx);
                }
                Ok(Txs(txs, coinbase))
            }
        }
        d.deserialize_seq(Visit)
    }
}

/// One transaction of [`Block`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct BlockTx {
    pub txid: Txid,
    /// `None` for the coinbase.
    #[serde(default, deserialize_with = "opt_btc")]
    pub fee: Option<Amount>,
    /// `ceil(weight / 4)`, not sigop-adjusted.
    pub vsize: u32,
    pub weight: u32,
    /// Sum of the output values, from `vout`.
    #[serde(rename = "vout", deserialize_with = "output_total")]
    pub value: Amount,
}

/// `getblock` with verbosity 3, reduced to what a running total per script needs: each
/// transaction's outputs and the outputs its inputs spend (`prevout`), as values and script hex.
/// The coinbase input has no `prevout`. Scripts are kept as the node's lower-case hex, so they can
/// be matched without decoding them.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PrevoutBlock {
    pub hash: BlockHash,
    pub height: u32,
    pub time: u32,
    /// Absent on genesis.
    pub previousblockhash: Option<BlockHash>,
    /// In block order, coinbase first.
    pub tx: Vec<PrevoutTx>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PrevoutTx {
    pub txid: Txid,
    pub vin: Vec<PrevoutIn>,
    pub vout: Vec<PrevoutOut>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PrevoutIn {
    /// The output this input spends; `None` for a coinbase input.
    pub prevout: Option<PrevoutOut>,
}

/// An output: its value and its script as the node wrote it in hex.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PrevoutOut {
    #[serde(deserialize_with = "btc")]
    pub value: Amount,
    #[serde(rename = "scriptPubKey")]
    pub script_pub_key: ScriptHexText,
}

/// `scriptPubKey.hex`, unparsed: chain data, compared as text and never decoded here.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ScriptHexText {
    pub hex: String,
}

/// `getblockstats`. Fees and values are in satoshis, fee rates in whole sat/vB
/// (so the percentiles round most of today's transactions to 0, see `docs/RBITCOIN.md`).
/// The coinbase is left out of counts, sizes and fees, as in Core.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BlockStats {
    pub blockhash: BlockHash,
    pub height: u32,
    pub time: u32,
    pub mediantime: u32,
    pub txs: u64,
    pub ins: u64,
    pub outs: u64,
    pub subsidy: Amount,
    pub totalfee: Amount,
    pub total_out: Amount,
    pub avgfee: Amount,
    pub medianfee: Amount,
    pub minfee: Amount,
    pub maxfee: Amount,
    pub avgfeerate: u64,
    pub minfeerate: u64,
    pub maxfeerate: u64,
    /// 10th, 25th, 50th, 75th and 90th percentile, weighted by size.
    pub feerate_percentiles: [u64; 5],
    pub total_size: u64,
    pub total_weight: u64,
    pub avgtxsize: u64,
    pub mediantxsize: u64,
    pub mintxsize: u64,
    pub maxtxsize: u64,
    pub swtxs: u64,
    pub swtotal_size: u64,
    pub swtotal_weight: u64,
    pub utxo_increase: i64,
    pub utxo_increase_actual: i64,
    pub utxo_size_inc: i64,
    pub utxo_size_inc_actual: i64,
}

/// `getblockstats` asked for `totalfee`, `subsidy` and `total_weight` only: the stats that need
/// no UTXO work. The full set took about a second per recent mainnet block, this about 25 ms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct BlockTotals {
    pub totalfee: Amount,
    pub subsidy: Amount,
    /// Weight of every transaction but the coinbase.
    pub total_weight: u64,
}

/// One entry of `getchaintips`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ChainTip {
    pub height: u32,
    pub hash: BlockHash,
    /// 0 for the active tip.
    pub branchlen: u32,
    /// `active`, `valid-fork`, `valid-headers`, `headers-only` or `invalid`.
    pub status: String,
}

/// `getmininginfo`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MiningInfo {
    pub chain: String,
    pub blocks: u32,
    pub bestblockhash: BlockHash,
    pub bits: String,
    pub target: String,
    pub difficulty: f64,
    /// Hashes per second over the last 120 blocks. Above `u64::MAX` on mainnet.
    pub networkhashps: f64,
    pub pooledtx: u64,
    /// Weight and count of the last block a template assembled; absent before the first.
    pub currentblockweight: Option<u64>,
    pub currentblocktx: Option<u64>,
    #[serde(deserialize_with = "btc")]
    pub blockmintxfee: Amount,
    pub next: NextBlock,
}

/// `getmininginfo.next`: the block being mined.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct NextBlock {
    pub height: u32,
    pub bits: String,
    pub target: String,
    pub difficulty: f64,
}

/// `getmempoolinfo`. Sizes are sigop-adjusted vbytes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MempoolInfo {
    pub loaded: bool,
    pub size: u64,
    pub bytes: u64,
    pub usage: u64,
    pub maxmempool: u64,
    #[serde(deserialize_with = "btc")]
    pub total_fee: Amount,
    #[serde(deserialize_with = "btc")]
    pub mempoolminfee: Amount,
    #[serde(deserialize_with = "btc")]
    pub minrelaytxfee: Amount,
    #[serde(deserialize_with = "btc")]
    pub incrementalrelayfee: Amount,
    pub fullrbf: bool,
    pub limitclustercount: u64,
    pub limitclustersize: u64,
    pub unbroadcastcount: u64,
}

/// `getrawmempool` with `verbose = false, mempool_sequence = true`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RawMempool {
    pub mempool_sequence: u64,
    pub txids: Vec<Txid>,
}

/// `getmempoolentry`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MempoolEntry {
    pub wtxid: Wtxid,
    /// Sigop-adjusted virtual size.
    pub vsize: u64,
    /// `ceil(weight / 4)`.
    pub vsize_bip141: u64,
    /// Raw weight.
    pub weight: u64,
    /// Unix time it entered the mempool.
    pub time: u64,
    /// Tip height when it entered.
    pub height: u32,
    pub fees: EntryFees,
    pub ancestorcount: u64,
    pub ancestorsize: u64,
    pub descendantcount: u64,
    pub descendantsize: u64,
    /// Sigop-adjusted weight of the mining chunk this transaction is in.
    pub chunkweight: u64,
    /// In-mempool parents.
    pub depends: Vec<Txid>,
    /// In-mempool children.
    pub spentby: Vec<Txid>,
    #[serde(rename = "bip125-replaceable")]
    pub bip125_replaceable: bool,
    pub unbroadcast: bool,
}

/// `getmempoolentry.fees`. All but `base` include `prioritisetransaction` deltas, so may be negative.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EntryFees {
    #[serde(deserialize_with = "btc")]
    pub base: Amount,
    #[serde(deserialize_with = "signed_btc")]
    pub modified: SignedAmount,
    #[serde(deserialize_with = "signed_btc")]
    pub ancestor: SignedAmount,
    #[serde(deserialize_with = "signed_btc")]
    pub descendant: SignedAmount,
    #[serde(deserialize_with = "signed_btc")]
    pub chunk: SignedAmount,
}

/// `getmempoolcluster`: the cluster a transaction belongs to, as mining chunks.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Cluster {
    /// Sigop-adjusted.
    pub clusterweight: u64,
    pub txcount: u64,
    /// In linearization order, highest feerate first.
    pub chunks: Vec<ClusterChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ClusterChunk {
    /// Modified fee.
    #[serde(deserialize_with = "signed_btc")]
    pub chunkfee: SignedAmount,
    /// Sigop-adjusted.
    pub chunkweight: u64,
    pub txs: Vec<Txid>,
}

/// One point of `getmempoolfeeratediagram`: a single mining chunk, not a running total.
/// Points come in mining order (decreasing modified feerate); negative-fee chunks are omitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct ChunkPoint {
    pub weight: u64,
    #[serde(deserialize_with = "btc")]
    pub fee: Amount,
}

/// One answer of `gettxspendingprevout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct PrevoutSpend {
    pub txid: Txid,
    pub vout: u32,
    /// The mempool transaction spending it, if any.
    pub spendingtxid: Option<Txid>,
}

/// `getblocktemplate` in template mode. Transaction bytes (`data`) are skipped while
/// decoding: the template is read for selection and fees, not to build a block.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BlockTemplate {
    pub version: i32,
    pub previousblockhash: BlockHash,
    pub height: u32,
    pub curtime: u32,
    pub mintime: u32,
    pub bits: String,
    pub target: String,
    /// Subsidy plus the fees of `transactions`.
    pub coinbasevalue: Amount,
    pub sigoplimit: u64,
    /// Absent before segwit.
    pub weightlimit: Option<u64>,
    pub default_witness_commitment: String,
    pub longpollid: String,
    pub rules: Vec<String>,
    /// In block order.
    pub transactions: Vec<TemplateTx>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TemplateTx {
    pub txid: Txid,
    #[serde(rename = "hash")]
    pub wtxid: Wtxid,
    pub fee: Amount,
    pub sigops: u32,
    pub weight: u32,
    /// 1-based positions in `transactions` of the parents this one needs.
    pub depends: Vec<u32>,
}

/// `estimatesmartfee`. rbitcoin answers with a 10-minute inclusion frontier, not Core's
/// historical estimator.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SmartFee {
    /// Per 1,000 vbytes. `None` when the node has no estimate; see `errors`.
    #[serde(default, deserialize_with = "opt_btc")]
    pub feerate: Option<Amount>,
    /// The target the estimate is for, which may differ from the one asked.
    pub blocks: u32,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// `getnetworkinfo`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NetworkInfo {
    /// Always 190000 on rbitcoin, an RPC shape floor; `subversion` names the software.
    pub version: u32,
    pub subversion: String,
    pub protocolversion: u32,
    pub connections: u32,
    pub connections_in: u32,
    pub connections_out: u32,
    pub networkactive: bool,
    #[serde(deserialize_with = "btc")]
    pub relayfee: Amount,
    #[serde(deserialize_with = "btc")]
    pub incrementalfee: Amount,
    pub warnings: Vec<String>,
}

/// An 8-decimal BTC number to satoshis. Exact for every value up to 21 million BTC:
/// the f64 error there is under 0.25 sat, so rounding recovers the decimal.
fn btc_sats<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    const MAX: f64 = 21e14;
    let sats = (f64::deserialize(d)? * 1e8).round();
    if !(-MAX..=MAX).contains(&sats) {
        return Err(D::Error::custom("BTC amount out of range"));
    }
    Ok(sats as i64)
}

fn btc<'de, D: Deserializer<'de>>(d: D) -> Result<Amount, D::Error> {
    let sats = u64::try_from(btc_sats(d)?).map_err(|_| D::Error::custom("negative amount"))?;
    Ok(Amount::from_sat(sats))
}

fn signed_btc<'de, D: Deserializer<'de>>(d: D) -> Result<SignedAmount, D::Error> {
    Ok(SignedAmount::from_sat(btc_sats(d)?))
}

/// Sums `vout[].value` without keeping the outputs.
fn output_total<'de, D: Deserializer<'de>>(d: D) -> Result<Amount, D::Error> {
    #[derive(Deserialize)]
    struct Output {
        #[serde(deserialize_with = "btc")]
        value: Amount,
    }
    struct Sum;
    impl<'de> serde::de::Visitor<'de> for Sum {
        type Value = Amount;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a list of outputs")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Amount, A::Error> {
            let mut total = Amount::ZERO;
            while let Some(out) = seq.next_element::<Output>()? {
                total = total
                    .checked_add(out.value)
                    .ok_or_else(|| A::Error::custom("output total out of range"))?;
            }
            Ok(total)
        }
    }
    d.deserialize_seq(Sum)
}

fn script<'de, D: Deserializer<'de>>(d: D) -> Result<ScriptBuf, D::Error> {
    ScriptBuf::from_hex(&String::deserialize(d)?).map_err(D::Error::custom)
}

fn opt_script<'de, D: Deserializer<'de>>(d: D) -> Result<Option<ScriptBuf>, D::Error> {
    script(d).map(Some)
}

fn opt_btc<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Amount>, D::Error> {
    btc(d).map(Some)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct A(#[serde(deserialize_with = "btc")] Amount);

    #[derive(Deserialize)]
    struct S(#[serde(deserialize_with = "signed_btc")] SignedAmount);

    fn a(s: &str) -> Result<u64, serde_json::Error> {
        serde_json::from_str::<A>(s).map(|a| a.0.to_sat())
    }

    #[test]
    fn btc_amounts_are_exact() {
        assert_eq!(a("0.00000001").unwrap(), 1);
        assert_eq!(a("0.00013538").unwrap(), 13_538);
        assert_eq!(a("0.1").unwrap(), 10_000_000);
        assert_eq!(a("20999999.97690000").unwrap(), 2_099_999_997_690_000);
        assert_eq!(a("0").unwrap(), 0);
        // Every satoshi value near the top of the range survives the f64 round trip.
        for sats in (2_099_999_999_000_000u64..2_100_000_000_000_000).step_by(7_919) {
            let s = format!("{}.{:08}", sats / 100_000_000, sats % 100_000_000);
            assert_eq!(a(&s).unwrap(), sats, "{s}");
        }
        assert!(a("-0.00000001").is_err());
        assert!(a("21000000.00000001").is_err());
        assert!(a("1e300").is_err());
        assert!(a("\"1\"").is_err());
        let s: S = serde_json::from_str("-0.00000312").unwrap();
        assert_eq!(s.0.to_sat(), -312);
    }
}
