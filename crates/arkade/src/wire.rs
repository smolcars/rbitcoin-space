//! arkd's REST gateway answers, as sent: protobuf JSON, with 64-bit integers as decimal strings
//! and enums as their names. Each type here is decoded strictly (a txid is 64 hex digits, a count
//! is a number in range) and then checked against the caps in [`crate`] before anything uses it.
//! Fields arkd may add later are ignored; fields we read must have the type we expect.

use std::collections::BTreeMap;

use bitcoin::Txid;
use serde::Deserialize;
use serde::de::{self, Deserializer};

/// `/v1/info`. Only what the page shows.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    pub signer_pubkey: String,
    /// Seconds, as a decimal string.
    #[serde(deserialize_with = "string_u64")]
    pub unilateral_exit_delay: u64,
    #[serde(default)]
    pub network: String,
    #[serde(default)]
    pub deprecated_signers: Vec<DeprecatedSigner>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeprecatedSigner {
    pub pubkey: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Outpoint {
    #[serde(deserialize_with = "txid")]
    pub txid: Txid,
    pub vout: u32,
}

/// `/v1/indexer/vtxos`. Paged when listed by script.
#[derive(Debug, Deserialize)]
pub(crate) struct Vtxos {
    pub vtxos: Vec<Vtxo>,
    #[serde(default)]
    pub page: Option<Page>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Vtxo {
    pub outpoint: Outpoint,
    #[serde(deserialize_with = "string_i64")]
    pub created_at: i64,
    #[serde(deserialize_with = "string_i64")]
    pub expires_at: i64,
    #[serde(deserialize_with = "string_u64")]
    pub amount: u64,
    #[serde(default)]
    pub script: String,
    #[serde(default)]
    pub is_preconfirmed: bool,
    #[serde(default)]
    pub is_swept: bool,
    #[serde(default)]
    pub is_unrolled: bool,
    #[serde(default)]
    pub is_spent: bool,
    #[serde(default, deserialize_with = "opt_txid")]
    pub spent_by: Option<Txid>,
    #[serde(default, deserialize_with = "txids")]
    pub commitment_txids: Vec<Txid>,
    #[serde(default, deserialize_with = "opt_txid")]
    pub settled_by: Option<Txid>,
    #[serde(default, deserialize_with = "opt_txid")]
    pub ark_txid: Option<Txid>,
    #[serde(default)]
    pub depth: u32,
}

/// `/v1/indexer/vtxo/{txid}/{vout}/chain`.
#[derive(Debug, Deserialize)]
pub(crate) struct Chain {
    pub chain: Vec<ChainTx>,
    pub page: Option<Page>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChainTx {
    #[serde(deserialize_with = "txid")]
    pub txid: Txid,
    #[serde(default, deserialize_with = "string_i64")]
    pub expires_at: i64,
    #[serde(rename = "type")]
    pub kind: String,
    /// What it spends: arkd writes a txid for some kinds and `txid:vout` for others. The txid is
    /// kept.
    #[serde(default, deserialize_with = "spends")]
    pub spends: Vec<Txid>,
}

/// `/v1/indexer/commitmentTx/{txid}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Commitment {
    #[serde(default, deserialize_with = "string_i64")]
    pub started_at: i64,
    #[serde(default, deserialize_with = "string_i64")]
    pub ended_at: i64,
    /// Keyed by the batch's output index, as a decimal string.
    #[serde(default)]
    pub batches: BTreeMap<String, Batch>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Batch {
    #[serde(default, deserialize_with = "string_u64")]
    pub total_output_amount: u64,
    #[serde(default)]
    pub total_output_vtxos: u32,
    #[serde(default, deserialize_with = "string_i64")]
    pub expires_at: i64,
    #[serde(default)]
    pub swept: bool,
}

/// `/v1/indexer/batch/{txid}/{vout}/tree`. Nodes come in no particular order.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tree {
    pub vtxo_tree: Vec<Node>,
    pub page: Option<Page>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Node {
    #[serde(deserialize_with = "txid")]
    pub txid: Txid,
    /// Output index, as a decimal string, to the child spending it.
    #[serde(default)]
    pub children: BTreeMap<String, TxidStr>,
}

/// A txid in a map's value.
#[derive(Debug)]
pub(crate) struct TxidStr(pub Txid);

impl<'de> Deserialize<'de> for TxidStr {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        txid(d).map(Self)
    }
}

/// A page of a paged answer. `current` and `total` count pages from 1.
#[derive(Debug, Deserialize)]
pub(crate) struct Page {
    pub current: i32,
    pub total: i32,
}

/// Exactly 64 hex digits.
pub(crate) fn parse_txid(s: &str) -> Option<Txid> {
    (s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| s.parse().ok())
        .flatten()
}

fn txid<'de, D: Deserializer<'de>>(d: D) -> Result<Txid, D::Error> {
    let s = <&str>::deserialize(d)?;
    parse_txid(s).ok_or_else(|| de::Error::custom("not a txid"))
}

/// A txid, or the empty string protobuf writes for none.
fn opt_txid<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Txid>, D::Error> {
    let s = <&str>::deserialize(d)?;
    if s.is_empty() {
        return Ok(None);
    }
    parse_txid(s)
        .map(Some)
        .ok_or_else(|| de::Error::custom("not a txid"))
}

fn txids<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Txid>, D::Error> {
    Ok(Vec::<TxidStr>::deserialize(d)?
        .into_iter()
        .map(|t| t.0)
        .collect())
}

/// A txid, or an outpoint whose txid is kept.
struct Spend(Txid);

impl<'de> Deserialize<'de> for Spend {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <&str>::deserialize(d)?;
        let txid = match s.split_once(':') {
            Some((txid, vout)) if crate::parse_vout(vout).is_some() => txid,
            Some(_) => return Err(de::Error::custom("not an outpoint")),
            None => s,
        };
        parse_txid(txid)
            .map(Self)
            .ok_or_else(|| de::Error::custom("not a txid"))
    }
}

fn spends<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Txid>, D::Error> {
    Ok(Vec::<Spend>::deserialize(d)?
        .into_iter()
        .map(|t| t.0)
        .collect())
}

/// A protobuf 64-bit integer: a decimal string (or a number, which the gateway may also write).
#[derive(Deserialize)]
#[serde(untagged)]
enum Int {
    Str(String),
    Num(i64),
}

fn int<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    match Int::deserialize(d)? {
        Int::Num(n) => Ok(n),
        Int::Str(s) => {
            let digits = s.strip_prefix('-').unwrap_or(&s);
            if digits.is_empty() || digits.len() > 19 || !digits.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(de::Error::custom("not an integer"));
            }
            s.parse().map_err(|_| de::Error::custom("not an integer"))
        }
    }
}

fn string_i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    int(d)
}

fn string_u64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    u64::try_from(int(d)?).map_err(|_| de::Error::custom("negative"))
}
