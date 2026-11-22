//! Decoded Esplora responses, shaped as rbitcoin serves them.
//!
//! Strings here (scripts, asm, addresses, witness items) are chain data: untrusted text.
//! Fields rbitcoin may leave out (pruned transactions, mempool-only rows) are optional.

use std::collections::BTreeMap;

use bitcoin::{Amount, BlockHash, TxMerkleNode, Txid};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Block {
    pub id: BlockHash,
    pub height: u32,
    pub version: i64,
    pub timestamp: u64,
    pub tx_count: u32,
    /// BIP144 total size.
    pub size: u64,
    pub weight: u64,
    pub merkle_root: TxMerkleNode,
    pub previousblockhash: Option<BlockHash>,
    pub mediantime: u64,
    pub nonce: u32,
    /// Compact target as a number, not Core's hex string.
    pub bits: u32,
    pub difficulty: f64,
}

/// One row of `/block/:hash/txs/summary`, sent as `[txid, fee, weight, value]`: fee and total
/// output value in sats (the coinbase's fee is 0), BIP141 weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(from = "(Txid, u64, u32, u64)")]
pub struct BlockTxSummary {
    pub txid: Txid,
    pub fee: Amount,
    pub weight: u32,
    pub value: Amount,
}

impl From<(Txid, u64, u32, u64)> for BlockTxSummary {
    fn from((txid, fee, weight, value): (Txid, u64, u32, u64)) -> Self {
        Self {
            txid,
            fee: Amount::from_sat(fee),
            weight,
            value: Amount::from_sat(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BlockStatus {
    pub in_best_chain: bool,
    pub height: Option<u32>,
    pub next_best: Option<BlockHash>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TxStatus {
    pub confirmed: bool,
    pub block_height: Option<u32>,
    pub block_hash: Option<BlockHash>,
    pub block_time: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptType {
    P2pkh,
    P2sh,
    P2pk,
    V0P2wpkh,
    V0P2wsh,
    V1P2tr,
    OpReturn,
    Multisig,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Vout {
    pub scriptpubkey: String,
    pub scriptpubkey_asm: String,
    pub scriptpubkey_type: ScriptType,
    pub scriptpubkey_address: Option<String>,
    pub value: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Vin {
    pub txid: Txid,
    pub vout: u32,
    pub is_coinbase: bool,
    /// Absent on pruned transactions, as are the script and witness fields.
    pub sequence: Option<u32>,
    pub scriptsig: Option<String>,
    pub scriptsig_asm: Option<String>,
    pub witness: Option<Vec<String>>,
    pub inner_redeemscript_asm: Option<String>,
    pub inner_witnessscript_asm: Option<String>,
    /// `None` for a coinbase, or when the parent output is no longer stored.
    pub prevout: Option<Vout>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Tx {
    pub txid: Txid,
    pub version: i64,
    pub locktime: u32,
    pub size: Option<u64>,
    pub weight: Option<u64>,
    pub sigops: Option<u32>,
    pub fee: Option<u64>,
    #[serde(default)]
    pub vin: Vec<Vin>,
    pub vout: Vec<Vout>,
    pub status: TxStatus,
    /// Below the node's prune point: `vin` is partial or empty.
    #[serde(default)]
    pub pruned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MerkleProof {
    pub block_height: u32,
    pub merkle: Vec<TxMerkleNode>,
    pub pos: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Outspend {
    pub spent: bool,
    pub txid: Option<Txid>,
    /// Input index of the spender.
    pub vin: Option<u32>,
    pub status: Option<TxStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Utxo {
    pub txid: Txid,
    pub vout: u32,
    pub value: u64,
    pub status: TxStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct ScriptStats {
    pub tx_count: u64,
    pub funded_txo_count: u64,
    pub funded_txo_sum: u64,
    pub spent_txo_count: u64,
    pub spent_txo_sum: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ScriptInfo {
    pub address: Option<String>,
    /// The hash as the node echoed it from the path, in digest order. Unused.
    pub scripthash: Option<String>,
    pub chain_stats: ScriptStats,
    pub mempool_stats: ScriptStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TxSummary {
    pub txid: Txid,
    /// Net sats for this script in this transaction: funded minus spent.
    pub value: i64,
    pub height: u32,
    /// Confirming header timestamp; 0 if the header is missing.
    pub time: u64,
    pub tx_position: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MempoolInfo {
    pub count: u64,
    pub vsize: u64,
    pub total_fee: u64,
    /// `(feerate sat/vB, vsize)` bands, highest feerate first.
    pub fee_histogram: Vec<(f64, u64)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MempoolRecent {
    pub txid: Txid,
    pub fee: u64,
    pub vsize: u64,
    /// Total output value in sats.
    pub value: u64,
}

/// Confirmation target in blocks to feerate in sat/vB. Targets without an estimate are absent.
pub type FeeEstimates = BTreeMap<u16, f64>;

/// One confirmed output found by position, with whether it is spent (a mempool spend counts as unspent).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PositionedOutput {
    #[serde(flatten)]
    pub out: Vout,
    pub spent: bool,
    /// Status of the creating transaction.
    pub status: TxStatus,
}
