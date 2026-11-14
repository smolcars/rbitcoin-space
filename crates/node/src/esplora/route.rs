//! Every Esplora route we call, as a value built only from parsed types.
//!
//! An upstream path is written by [`Route::write_path`] and nowhere else, from
//! hashes, integers and checked addresses. There is no variant that carries a
//! raw string, so a client string cannot reach the node (SECURITY.md rules 2–3).

use std::fmt::{self, Write as _};
use std::str::FromStr;

use bitcoin::hashes::{Hash as _, sha256};
use bitcoin::hex::{DisplayHex as _, FromHex as _};
use bitcoin::{Address, BlockHash, OutPoint, Transaction, Txid};
use bytes::Bytes;
use hyper::Method;

/// Largest batch `POST /block-heights/txs/outs` accepts.
pub const MAX_OUT_POSITIONS: usize = 300;

/// An Electrum scripthash: SHA-256 of the scriptPubKey, shown byte-reversed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ScriptHash([u8; 32]);

impl ScriptHash {
    pub fn from_script(script: &bitcoin::Script) -> Self {
        let mut bytes = sha256::Hash::hash(script.as_bytes()).to_byte_array();
        bytes.reverse();
        Self(bytes)
    }

    /// The 32 bytes in the order shown.
    pub fn to_byte_array(self) -> [u8; 32] {
        self.0
    }

    pub fn from_byte_array(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl FromStr for ScriptHash {
    type Err = bitcoin::hex::HexToArrayError;
    /// Exactly 64 hex characters, as shown.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        <[u8; 32]>::from_hex(s).map(Self)
    }
}

impl fmt::Display for ScriptHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.as_hex())
    }
}

impl<'de> serde::Deserialize<'de> for ScriptHash {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// The script an address or scripthash route is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptRef {
    /// Checked for the node's network by the caller (`Address::require_network`).
    Address(Address),
    ScriptHash(ScriptHash),
}

/// `start_index` of `/block/:hash/txs/:start_index`: a multiple of 25.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockTxsStart(u32);

impl BlockTxsStart {
    pub const PAGE: u32 = 25;
    pub const FIRST: Self = Self(0);

    /// `None` unless `index` is a multiple of 25, which the node requires.
    pub fn new(index: u32) -> Option<Self> {
        index.is_multiple_of(Self::PAGE).then_some(Self(index))
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

/// One output addressed by its block height, its transaction's index in the block and its vout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(into = "[u32; 3]")]
pub struct OutPosition {
    pub height: u32,
    pub index: u32,
    pub vout: u32,
}

impl From<OutPosition> for [u32; 3] {
    fn from(p: OutPosition) -> Self {
        [p.height, p.index, p.vout]
    }
}

/// A batch for `POST /block-heights/txs/outs`: at most [`MAX_OUT_POSITIONS`] positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutPositions(Vec<OutPosition>);

impl OutPositions {
    /// `None` when the batch is longer than the node accepts.
    pub fn new(positions: Vec<OutPosition>) -> Option<Self> {
        (positions.len() <= MAX_OUT_POSITIONS).then_some(Self(positions))
    }

    pub fn as_slice(&self) -> &[OutPosition] {
        &self.0
    }
}

/// An Esplora route with its typed parameters. `asof` pins a read to a best-chain ancestor;
/// only the routes that accept `?asof=` have the field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    TipHeight,
    TipHash,
    /// Ten blocks, newest first, ending at `start_height` or the tip.
    Blocks {
        start_height: Option<u32>,
    },
    /// Best-chain block hash at a height.
    BlockHash(u32),
    Block(BlockHash),
    BlockHeader(BlockHash),
    BlockStatus(BlockHash),
    BlockTxids(BlockHash),
    BlockTxs {
        hash: BlockHash,
        start: BlockTxsStart,
    },
    BlockRaw(BlockHash),
    /// `[txid, fee, weight, value]` per transaction. Not in rbitcoin v0.9.2, which answers 400.
    BlockTxsSummary(BlockHash),
    /// The txid at `index` in the block.
    BlockTxid {
        hash: BlockHash,
        index: u32,
    },

    Tx(Txid),
    TxStatus {
        txid: Txid,
        asof: Option<BlockHash>,
    },
    TxHex(Txid),
    TxRaw(Txid),
    TxMerkleProof(Txid),
    /// BIP37 merkleblock, as hex.
    TxMerkleblockProof(Txid),
    TxOutspend {
        txid: Txid,
        vout: u32,
        asof: Option<BlockHash>,
    },
    TxOutspends {
        txid: Txid,
        asof: Option<BlockHash>,
    },
    /// `GET /txs/outspends?txids=`: one outspend array per txid. The node takes at most 50.
    TxsOutspends(Vec<Txid>),

    ScriptStats {
        script: ScriptRef,
        asof: Option<BlockHash>,
    },
    ScriptUtxo {
        script: ScriptRef,
        asof: Option<BlockHash>,
    },
    /// Mempool rows (up to 50) then 25 confirmed; `after` skips through that txid.
    ScriptTxs {
        script: ScriptRef,
        after: Option<Txid>,
        asof: Option<BlockHash>,
    },
    /// 25 confirmed, newest first, after `last_seen`.
    ScriptTxsChain {
        script: ScriptRef,
        last_seen: Option<Txid>,
        asof: Option<BlockHash>,
    },
    ScriptTxsMempool(ScriptRef),
    /// Compact confirmed history, 25 per page, after `last_seen`.
    ScriptTxsSummary {
        script: ScriptRef,
        last_seen: Option<Txid>,
        asof: Option<BlockHash>,
    },

    Mempool,
    MempoolTxids,
    /// Mempool txids in txid order after `after`, at most `max_txs` (node default and cap 10,000).
    MempoolTxidsPage {
        after: Option<Txid>,
        max_txs: Option<u32>,
    },
    MempoolRecent,
    FeeEstimates,
    /// `POST /tx`: the only write. Never call it on a shared node.
    Broadcast(Transaction),

    /// The confirmed transaction at a block position, as `/tx/:txid` JSON.
    TxAt {
        height: u32,
        index: u32,
        asof: Option<BlockHash>,
    },
    /// One confirmed output by outpoint, in the same shape as [`Route::OutputAt`].
    TxOut {
        txid: Txid,
        vout: u32,
        asof: Option<BlockHash>,
    },
    /// One confirmed output by position. No address index needed.
    OutputAt {
        position: OutPosition,
        asof: Option<BlockHash>,
    },
    /// Up to 300 outputs by position; a missing one is `null` in its slot.
    OutputsAt {
        positions: OutPositions,
        asof: Option<BlockHash>,
    },

    /// Bulk tx JSON by txid; unknown ids are left out. Unix socket only, as are all below.
    InternalTxs(Vec<Txid>),
    /// Mempool tx JSON in txid order, after `after`, at most `max_txs` (node default 10,000).
    InternalMempoolTxs {
        after: Option<Txid>,
        max_txs: Option<u32>,
    },
    InternalMempoolTxsAll,
    InternalMempoolTxsByTxid(Vec<Txid>),
    InternalBlockTxs(BlockHash),
    InternalOutspendsByTxid(Vec<Txid>),
    InternalOutspendsByOutpoint(Vec<OutPoint>),
    /// [`Route::ScriptStats`] without the node's `--max-sh-creates` refusal (rbitcoin PR 1628,
    /// after v0.9.2): the same JSON, `?asof=` and chain-tip stamp.
    InternalScriptStats {
        script: ScriptRef,
        asof: Option<BlockHash>,
    },
}

impl Route {
    pub fn method(&self) -> Method {
        match self {
            Self::Broadcast(_)
            | Self::OutputsAt { .. }
            | Self::InternalTxs(_)
            | Self::InternalMempoolTxsByTxid(_)
            | Self::InternalOutspendsByTxid(_)
            | Self::InternalOutspendsByOutpoint(_) => Method::POST,
            _ => Method::GET,
        }
    }

    /// Served only on a unix-socket listener.
    pub fn is_internal(&self) -> bool {
        matches!(
            self,
            Self::InternalTxs(_)
                | Self::InternalMempoolTxs { .. }
                | Self::InternalMempoolTxsAll
                | Self::InternalMempoolTxsByTxid(_)
                | Self::InternalBlockTxs(_)
                | Self::InternalOutspendsByTxid(_)
                | Self::InternalOutspendsByOutpoint(_)
                | Self::InternalScriptStats { .. }
        )
    }

    /// Appends the path and query, relative to the Esplora base.
    pub fn write_path(&self, out: &mut String) {
        // Writing to a String cannot fail.
        let _ = self.write(out);
    }

    fn write(&self, o: &mut String) -> fmt::Result {
        let mut asof = None;
        match self {
            Self::TipHeight => o.push_str("/blocks/tip/height"),
            Self::TipHash => o.push_str("/blocks/tip/hash"),
            Self::Blocks { start_height: None } => o.push_str("/blocks"),
            Self::Blocks {
                start_height: Some(h),
            } => write!(o, "/blocks/{h}")?,
            Self::BlockHash(h) => write!(o, "/block-height/{h}")?,
            Self::Block(h) => write!(o, "/block/{h}")?,
            Self::BlockHeader(h) => write!(o, "/block/{h}/header")?,
            Self::BlockStatus(h) => write!(o, "/block/{h}/status")?,
            Self::BlockTxids(h) => write!(o, "/block/{h}/txids")?,
            Self::BlockTxs { hash, start } => write!(o, "/block/{hash}/txs/{}", start.0)?,
            Self::BlockRaw(h) => write!(o, "/block/{h}/raw")?,
            Self::BlockTxsSummary(h) => write!(o, "/block/{h}/txs/summary")?,
            Self::BlockTxid { hash, index } => write!(o, "/block/{hash}/txid/{index}")?,

            Self::Tx(t) => write!(o, "/tx/{t}")?,
            Self::TxStatus { txid, asof: a } => {
                write!(o, "/tx/{txid}/status")?;
                asof = *a;
            }
            Self::TxHex(t) => write!(o, "/tx/{t}/hex")?,
            Self::TxRaw(t) => write!(o, "/tx/{t}/raw")?,
            Self::TxMerkleProof(t) => write!(o, "/tx/{t}/merkle-proof")?,
            Self::TxMerkleblockProof(t) => write!(o, "/tx/{t}/merkleblock-proof")?,
            Self::TxOutspend {
                txid,
                vout,
                asof: a,
            } => {
                write!(o, "/tx/{txid}/outspend/{vout}")?;
                asof = *a;
            }
            Self::TxOutspends { txid, asof: a } => {
                write!(o, "/tx/{txid}/outspends")?;
                asof = *a;
            }
            Self::TxsOutspends(ids) => {
                o.push_str("/txs/outspends?txids=");
                for (i, t) in ids.iter().enumerate() {
                    if i > 0 {
                        o.push(',');
                    }
                    write!(o, "{t}")?;
                }
            }

            Self::ScriptStats { script, asof: a } => {
                write_script(o, script)?;
                asof = *a;
            }
            Self::ScriptUtxo { script, asof: a } => {
                write_script(o, script)?;
                o.push_str("/utxo");
                asof = *a;
            }
            Self::ScriptTxs {
                script,
                after,
                asof: a,
            } => {
                write_script(o, script)?;
                o.push_str("/txs");
                if let Some(t) = after {
                    write!(o, "?after_txid={t}")?;
                }
                asof = *a;
            }
            Self::ScriptTxsChain {
                script,
                last_seen,
                asof: a,
            } => {
                write_script(o, script)?;
                o.push_str("/txs/chain");
                if let Some(t) = last_seen {
                    write!(o, "/{t}")?;
                }
                asof = *a;
            }
            Self::ScriptTxsMempool(script) => {
                write_script(o, script)?;
                o.push_str("/txs/mempool");
            }
            Self::ScriptTxsSummary {
                script,
                last_seen,
                asof: a,
            } => {
                write_script(o, script)?;
                o.push_str("/txs/summary");
                if let Some(t) = last_seen {
                    write!(o, "/{t}")?;
                }
                asof = *a;
            }

            Self::Mempool => o.push_str("/mempool"),
            Self::MempoolTxids => o.push_str("/mempool/txids"),
            Self::MempoolTxidsPage { after, max_txs } => {
                o.push_str("/mempool/txids/page");
                if let Some(t) = after {
                    write!(o, "/{t}")?;
                }
                if let Some(n) = max_txs {
                    write!(o, "?max_txs={n}")?;
                }
            }
            Self::MempoolRecent => o.push_str("/mempool/recent"),
            Self::FeeEstimates => o.push_str("/fee-estimates"),
            Self::Broadcast(_) => o.push_str("/tx"),

            Self::TxAt {
                height,
                index,
                asof: a,
            } => {
                write!(o, "/block-height/{height}/tx/{index}")?;
                asof = *a;
            }
            Self::TxOut {
                txid,
                vout,
                asof: a,
            } => {
                write!(o, "/tx/{txid}/out/{vout}")?;
                asof = *a;
            }
            Self::OutputAt {
                position: p,
                asof: a,
            } => {
                write!(
                    o,
                    "/block-height/{}/tx/{}/out/{}",
                    p.height, p.index, p.vout
                )?;
                asof = *a;
            }
            Self::OutputsAt { asof: a, .. } => {
                o.push_str("/block-heights/txs/outs");
                asof = *a;
            }

            Self::InternalTxs(_) => o.push_str("/internal/txs"),
            Self::InternalMempoolTxs { after, max_txs } => {
                o.push_str("/internal/mempool/txs");
                if let Some(t) = after {
                    write!(o, "/{t}")?;
                }
                if let Some(n) = max_txs {
                    write!(o, "?max_txs={n}")?;
                }
            }
            Self::InternalMempoolTxsAll => o.push_str("/internal/mempool/txs/all"),
            Self::InternalMempoolTxsByTxid(_) => o.push_str("/internal/mempool/txs"),
            Self::InternalBlockTxs(h) => write!(o, "/internal/block/{h}/txs")?,
            Self::InternalOutspendsByTxid(_) => o.push_str("/internal/txs/outspends/by-txid"),
            Self::InternalOutspendsByOutpoint(_) => {
                o.push_str("/internal/txs/outspends/by-outpoint")
            }
            Self::InternalScriptStats { script, asof: a } => {
                o.push_str("/internal");
                write_script(o, script)?;
                asof = *a;
            }
        }
        if let Some(h) = asof {
            // Only ScriptTxs can already have a query (`after_txid`).
            let sep = if o.contains('?') { '&' } else { '?' };
            write!(o, "{sep}asof={h}")?;
        }
        Ok(())
    }

    /// The request body and its content type, for POST routes.
    pub fn body(&self) -> Option<(Bytes, &'static str)> {
        let json =
            |v: serde_json::Result<Vec<u8>>| v.ok().map(|b| (Bytes::from(b), "application/json"));
        match self {
            Self::Broadcast(tx) => {
                let hex = bitcoin::consensus::encode::serialize_hex(tx);
                Some((Bytes::from(hex), "text/plain"))
            }
            Self::OutputsAt { positions, .. } => json(serde_json::to_vec(positions.as_slice())),
            Self::InternalTxs(ids)
            | Self::InternalMempoolTxsByTxid(ids)
            | Self::InternalOutspendsByTxid(ids) => json(serde_json::to_vec(ids)),
            Self::InternalOutspendsByOutpoint(ops) => {
                let ops: Vec<String> = ops.iter().map(ToString::to_string).collect();
                json(serde_json::to_vec(&ops))
            }
            _ => None,
        }
    }
}

fn write_script(o: &mut String, s: &ScriptRef) -> fmt::Result {
    match s {
        ScriptRef::Address(a) => write!(o, "/address/{a}"),
        ScriptRef::ScriptHash(h) => write!(o, "/scripthash/{h}"),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn path(r: &Route) -> String {
        let mut s = String::new();
        r.write_path(&mut s);
        s
    }

    const H: &str = "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054";

    #[test]
    fn paths_and_queries() {
        let h: BlockHash = H.parse().unwrap();
        let t: Txid = H.parse().unwrap();
        let sh = ScriptRef::ScriptHash(H.parse().unwrap());
        assert_eq!(
            path(&Route::Blocks {
                start_height: Some(7)
            }),
            "/blocks/7"
        );
        assert_eq!(
            path(&Route::TxStatus {
                txid: t,
                asof: Some(h)
            }),
            format!("/tx/{H}/status?asof={H}")
        );
        assert_eq!(
            path(&Route::ScriptTxs {
                script: sh.clone(),
                after: Some(t),
                asof: Some(h)
            }),
            format!("/scripthash/{H}/txs?after_txid={H}&asof={H}")
        );
        assert_eq!(
            path(&Route::ScriptTxsSummary {
                script: sh.clone(),
                last_seen: Some(t),
                asof: None
            }),
            format!("/scripthash/{H}/txs/summary/{H}")
        );
        let uncapped = Route::InternalScriptStats {
            script: sh,
            asof: Some(h),
        };
        assert_eq!(
            path(&uncapped),
            format!("/internal/scripthash/{H}?asof={H}")
        );
        assert!(uncapped.is_internal());
        assert_eq!(
            path(&Route::InternalMempoolTxs {
                after: Some(t),
                max_txs: Some(5)
            }),
            format!("/internal/mempool/txs/{H}?max_txs=5")
        );
        let pos = OutPosition {
            height: 1,
            index: 2,
            vout: 3,
        };
        assert_eq!(
            path(&Route::OutputAt {
                position: pos,
                asof: None
            }),
            "/block-height/1/tx/2/out/3"
        );
        let batch = Route::OutputsAt {
            positions: OutPositions::new(vec![pos, pos]).unwrap(),
            asof: None,
        };
        assert_eq!(batch.body().unwrap().0, "[[1,2,3],[1,2,3]]");
        assert_eq!(
            path(&Route::TxsOutspends(vec![t, t])),
            format!("/txs/outspends?txids={H},{H}")
        );
        assert_eq!(
            path(&Route::MempoolTxidsPage {
                after: Some(t),
                max_txs: Some(9)
            }),
            format!("/mempool/txids/page/{H}?max_txs=9")
        );
        assert_eq!(
            path(&Route::TxAt {
                height: 5,
                index: 1,
                asof: Some(h)
            }),
            format!("/block-height/5/tx/1?asof={H}")
        );
        assert_eq!(
            path(&Route::TxOut {
                txid: t,
                vout: 2,
                asof: None
            }),
            format!("/tx/{H}/out/2")
        );
        assert_eq!(
            path(&Route::BlockTxid { hash: h, index: 3 }),
            format!("/block/{H}/txid/3")
        );
        assert_eq!(
            path(&Route::BlockTxsSummary(h)),
            format!("/block/{H}/txs/summary")
        );
        assert_eq!(batch.method(), Method::POST);
    }

    #[test]
    fn addresses_are_written_canonically() {
        let a: Address = "BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ"
            .parse::<Address<_>>()
            .unwrap()
            .require_network(bitcoin::Network::Bitcoin)
            .unwrap();
        let r = Route::ScriptUtxo {
            script: ScriptRef::Address(a),
            asof: None,
        };
        assert_eq!(
            path(&r),
            "/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/utxo"
        );
    }

    #[test]
    fn parameters_reject_bad_values() {
        assert!(BlockTxsStart::new(26).is_none());
        assert_eq!(BlockTxsStart::new(50).map(BlockTxsStart::get), Some(50));
        let pos = OutPosition {
            height: 0,
            index: 0,
            vout: 0,
        };
        assert!(OutPositions::new(vec![pos; MAX_OUT_POSITIONS]).is_some());
        assert!(OutPositions::new(vec![pos; MAX_OUT_POSITIONS + 1]).is_none());
        assert!("../etc".parse::<ScriptHash>().is_err());
        assert!(format!("{H}/x").parse::<ScriptHash>().is_err());
    }

    #[test]
    fn scripthash_matches_electrum() {
        // Electrum protocol docs: P2PKH script of 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.
        let script =
            bitcoin::ScriptBuf::from_hex("76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac")
                .unwrap();
        assert_eq!(
            ScriptHash::from_script(&script).to_string(),
            "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161"
        );
    }
}
