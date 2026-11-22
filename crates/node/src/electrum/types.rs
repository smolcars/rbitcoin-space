use std::fmt;
use std::str::FromStr;

use bitcoin::block::Header;
use bitcoin::consensus::encode::deserialize;
use bitcoin::hashes::{Hash, sha256};
use bitcoin::hex::{DisplayHex, FromHex};
use bitcoin::{BlockHash, OutPoint, Script, Txid};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// There is no connection to the node, or it dropped before the reply came.
    Disconnected,
    Timeout,
    /// The outgoing queue is full: the node is not reading what we send.
    Overloaded,
    SubscriptionLimit {
        max: usize,
    },
    Server {
        code: i64,
        message: String,
    },
    Protocol(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Disconnected => f.write_str("not connected to the Electrum server"),
            Error::Timeout => f.write_str("Electrum request timed out"),
            Error::Overloaded => f.write_str("Electrum send queue is full"),
            Error::SubscriptionLimit { max } => {
                write!(f, "Electrum subscription limit of {max} reached")
            }
            Error::Server { code, message } => write!(f, "Electrum error {code}: {message}"),
            Error::Protocol(what) => write!(f, "unexpected Electrum reply: {what}"),
        }
    }
}

impl std::error::Error for Error {}

pub(crate) fn protocol(what: impl fmt::Display) -> Error {
    Error::Protocol(what.to_string())
}

/// An Electrum script hash: SHA-256 of the output script, kept in the
/// byte-reversed order the protocol prints.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ScriptHash(pub [u8; 32]);

impl fmt::Debug for ScriptHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ScriptHash({self})")
    }
}

impl ScriptHash {
    pub fn from_script(script: &Script) -> Self {
        let mut bytes = sha256::Hash::hash(script.as_bytes()).to_byte_array();
        bytes.reverse();
        ScriptHash(bytes)
    }
}

impl fmt::Display for ScriptHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.to_lower_hex_string())
    }
}

impl FromStr for ScriptHash {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self, Error> {
        <[u8; 32]>::from_hex(s).map(ScriptHash).map_err(protocol)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Topic {
    ScriptHash(ScriptHash),
    Outpoint(OutPoint),
}

impl Topic {
    pub(crate) fn method(&self, verb: &str) -> String {
        match self {
            Topic::ScriptHash(_) => format!("blockchain.scripthash.{verb}"),
            Topic::Outpoint(_) => format!("blockchain.outpoint.{verb}"),
        }
    }

    pub(crate) fn params(&self) -> Value {
        match self {
            Topic::ScriptHash(sh) => serde_json::json!([sh.to_string()]),
            Topic::Outpoint(op) => serde_json::json!([op.txid.to_string(), op.vout]),
        }
    }

    pub(crate) fn parse_status(&self, value: &Value) -> Result<Status, Error> {
        match self {
            Topic::ScriptHash(_) => match value {
                Value::Null => Ok(Status::ScriptHash(None)),
                Value::String(s) if s.len() == 64 => Ok(Status::ScriptHash(Some(s.clone()))),
                other => Err(protocol(format!("scripthash status {other}"))),
            },
            Topic::Outpoint(_) => OutpointStatus::parse(value).map(Status::Outpoint),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Electrum status hash of the script's history, or `None` if it has none.
    ScriptHash(Option<String>),
    Outpoint(OutpointStatus),
}

/// Whether an output is spent, from `blockchain.outpoint.*`.
///
/// rbitcoin reports the chain tip height beside a confirmed spend, not the
/// spend's own height, so that number is dropped: it changes every block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutpointStatus {
    /// Unspent, or not known to the node.
    Unspent,
    SpentInMempool {
        spending_txid: Txid,
    },
    SpentConfirmed,
}

impl OutpointStatus {
    pub(crate) fn parse(value: &Value) -> Result<Self, Error> {
        #[derive(Deserialize)]
        struct Raw {
            spent: bool,
            #[serde(default)]
            height: u32,
            #[serde(default)]
            spending_txid: Option<Txid>,
        }
        let raw = Raw::deserialize(value).map_err(protocol)?;
        Ok(match (raw.spent, raw.height, raw.spending_txid) {
            (false, _, _) => OutpointStatus::Unspent,
            (true, 0, Some(spending_txid)) => OutpointStatus::SpentInMempool { spending_txid },
            (true, 0, None) => return Err(protocol("mempool spend without spending_txid")),
            (true, _, _) => OutpointStatus::SpentConfirmed,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tip {
    pub height: u32,
    pub hash: BlockHash,
    pub header: Header,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A block joined the best chain, in height order. The first is the tip
    /// found on the first connection.
    Block(Tip),
    /// Every block above `fork_height` left the best chain. `Block` events for
    /// the new branch follow.
    Reorg { fork_height: u32 },
    /// A subscribed topic changed. Sent only when the status differs from the last one.
    Status { topic: Topic, status: Status },
    /// Updates may have been missed: the connection was re-established, or the
    /// tip moved further than the client could follow. Refresh derived state.
    /// A consumer whose receiver lagged must treat that the same way.
    Resynced,
}

/// A reply with rbitcoin's chain-tip stamp: the tip the answer was read at.
#[derive(Clone, Debug, PartialEq)]
pub struct Stamped<T> {
    pub value: T,
    pub chain_tip: Option<BlockHash>,
    pub chain_tip_height: Option<u32>,
}

/// `server.version`: the server's name and the protocol it agreed to speak.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerVersion {
    pub server: String,
    pub protocol: String,
}

/// `server.features`, with the members we use.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Features {
    pub genesis_hash: BlockHash,
    pub server_version: String,
    pub protocol_min: String,
    pub protocol_max: String,
    /// rbitcoin stamps `chain_tip` on scripthash and transaction replies.
    #[serde(default)]
    pub chain_tip: bool,
}

/// `mempool.get_info`, in BTC per kvB as the node reports.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct MempoolInfo {
    pub mempoolminfee: f64,
    pub minrelaytxfee: f64,
    pub incrementalrelayfee: f64,
}

/// One row of `blockchain.scripthash.get_history`. `height` is 0 for an
/// unconfirmed transaction and -1 when one of its parents is unconfirmed too.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct HistoryItem {
    pub tx_hash: Txid,
    pub height: i32,
    /// Present on unconfirmed rows only.
    #[serde(default)]
    pub fee: Option<u64>,
}

/// `blockchain.scripthash.get_balance`, in satoshis. Unconfirmed can be negative.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Balance {
    pub confirmed: i64,
    pub unconfirmed: i64,
}

pub(crate) fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(protocol)
}

pub(crate) fn parse_version(value: Value) -> Result<ServerVersion, Error> {
    let (server, protocol) = parse(value)?;
    Ok(ServerVersion { server, protocol })
}

pub(crate) fn parse_header(value: &Value) -> Result<Header, Error> {
    let hex = value
        .as_str()
        .ok_or_else(|| protocol("header is not a string"))?;
    header_from_hex(hex)
}

fn header_from_hex(hex: &str) -> Result<Header, Error> {
    let bytes = <[u8; 80]>::from_hex(hex).map_err(protocol)?;
    deserialize(&bytes).map_err(protocol)
}

/// `blockchain.block.headers`: a `headers` list on protocol 1.6, one
/// concatenated `hex` string before it.
pub(crate) fn parse_headers(value: &Value) -> Result<Vec<Header>, Error> {
    if let Some(list) = value.get("headers").and_then(Value::as_array) {
        return list.iter().map(parse_header).collect();
    }
    let hex = value
        .get("hex")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol("headers reply has neither headers nor hex"))?;
    if !hex.is_ascii() || hex.len() % 160 != 0 {
        return Err(protocol("headers hex is not whole headers"));
    }
    hex.as_bytes()
        .chunks(160)
        .map(|chunk| header_from_hex(std::str::from_utf8(chunk).map_err(protocol)?))
        .collect()
}

/// The `{height, hex}` object of `blockchain.headers.subscribe`.
pub(crate) fn parse_tip(value: &Value) -> Result<(u32, Header), Error> {
    let height = value
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|h| u32::try_from(h).ok())
        .ok_or_else(|| protocol("tip without a height"))?;
    let header = parse_header(value.get("hex").unwrap_or(&Value::Null))?;
    Ok((height, header))
}
