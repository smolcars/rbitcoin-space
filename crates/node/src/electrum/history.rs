//! A script's whole confirmed history in one `blockchain.scripthash.get_history`, pinned to a
//! block, read on a connection of its own and handed on in batches as it arrives: an answer of
//! millions of rows (hundreds of MB) is never held at once (docs/RBITCOIN.md, "The whole history
//! of a large address").
//!
//! Blocking: run it on a blocking thread.

use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, Txid};
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use super::{CLIENT_NAME, Error, ScriptHash};

/// One confirmed transaction of the script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Row {
    pub height: u32,
    pub txid: Txid,
}

/// The order rbitcoin lists a history in: height, then the txid's bytes in internal order, both
/// ascending (`apply_history_filter` in rbitcoin's `scripthash.rs`; its Esplora pages are the
/// same order reversed). Checked on every row, so a node that lists otherwise is an error.
pub fn order(r: &Row) -> (u32, [u8; 32]) {
    (r.height, r.txid.to_byte_array())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Listed {
    pub rows: u64,
    /// Bytes read from the node, the handshake included.
    pub bytes: u64,
}

/// Reads the confirmed history of `sh` as of block `at` (height `at_height`) from the Electrum
/// server at `addr`, giving `sink` at most `batch` rows at a time, in the node's order. `sink`
/// returns `false` to stop; the read then ends with [`Error::Disconnected`]. The whole read must
/// finish within `deadline`. A refusal is [`Error::Server`] with the node's message.
pub fn list(
    addr: &str,
    sh: &ScriptHash,
    at: BlockHash,
    at_height: u32,
    deadline: Duration,
    batch: usize,
    sink: &mut dyn FnMut(Vec<Row>) -> bool,
) -> Result<Listed, Error> {
    let end = Instant::now() + deadline;
    let target = addr
        .to_socket_addrs()
        .map_err(|_| Error::Disconnected)?
        .next()
        .ok_or(Error::Disconnected)?;
    let stream = TcpStream::connect_timeout(&target, Duration::from_secs(5).min(deadline))
        .map_err(|_| Error::Disconnected)?;
    let mut writer = stream.try_clone().map_err(|_| Error::Disconnected)?;
    let request = format!(
        concat!(
            "{{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"server.version\",",
            "\"params\":[\"{}\",\"1.4\"]}}\n",
            "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"blockchain.scripthash.get_history\",",
            "\"params\":[\"{}\",\"asof:{}\"]}}\n"
        ),
        CLIENT_NAME, sh, at
    );
    writer
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| Error::Disconnected)?;
    writer
        .write_all(request.as_bytes())
        .map_err(|_| Error::Disconnected)?;
    let mut reader = BufReader::with_capacity(
        1 << 16,
        Timed {
            stream,
            end,
            bytes: 0,
        },
    );
    // The handshake's reply: one short line.
    let mut line = Vec::new();
    (&mut reader)
        .take(64 << 10)
        .read_until(b'\n', &mut line)
        .map_err(io)?;
    if line.last() != Some(&b'\n') {
        return Err(Error::Protocol("no server.version reply".into()));
    }
    let mut state = State {
        at_height,
        batch: batch.max(1),
        sink,
        rows: 0,
        last: None,
        tip: None,
        error: None,
        stopped: false,
    };
    let mut de = serde_json::Deserializer::from_reader(&mut reader);
    let r = Reply(&mut state).deserialize(&mut de);
    if state.stopped {
        return Err(Error::Disconnected);
    }
    if let Err(e) = r {
        return Err(if e.is_io() {
            if reader.get_ref().timed_out() {
                Error::Timeout
            } else {
                Error::Disconnected
            }
        } else {
            Error::Protocol(format!("history: {e}"))
        });
    }
    if let Some(e) = state.error {
        return Err(Error::Server {
            code: e.code,
            message: e.message,
        });
    }
    // Every reply rbitcoin pins with `asof:` names the block it was pinned to.
    if state.tip != Some(at.to_string()) {
        return Err(Error::Protocol(
            "history not pinned to the block asked".into(),
        ));
    }
    Ok(Listed {
        rows: state.rows,
        bytes: reader.get_ref().bytes,
    })
}

fn io(e: std::io::Error) -> Error {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => Error::Timeout,
        _ => Error::Disconnected,
    }
}

struct Timed {
    stream: TcpStream,
    end: Instant,
    bytes: u64,
}

impl Timed {
    fn timed_out(&self) -> bool {
        Instant::now() >= self.end
    }
}

impl Read for Timed {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        self.stream.set_read_timeout(Some(left))?;
        let n = self.stream.read(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
}

#[derive(Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

struct State<'a> {
    at_height: u32,
    batch: usize,
    sink: &'a mut dyn FnMut(Vec<Row>) -> bool,
    rows: u64,
    last: Option<(u32, [u8; 32])>,
    tip: Option<String>,
    error: Option<RpcError>,
    stopped: bool,
}

struct Reply<'s, 'a>(&'s mut State<'a>);

impl<'de> DeserializeSeed<'de> for Reply<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Reply<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON-RPC reply")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<(), M::Error> {
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "result" => map.next_value_seed(Rows(&mut *self.0))?,
                "error" => self.0.error = Some(map.next_value()?),
                "chain_tip" => self.0.tip = Some(map.next_value()?),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(())
    }
}

struct Rows<'s, 'a>(&'s mut State<'a>);

#[derive(Deserialize)]
struct Item {
    height: i64,
    tx_hash: Txid,
}

impl<'de> DeserializeSeed<'de> for Rows<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for Rows<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a history list")
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<(), S::Error> {
        let s = self.0;
        let mut out = Vec::with_capacity(s.batch);
        while let Some(item) = seq.next_element::<Item>()? {
            // Pinned to a block, the list holds confirmed rows at or below it only.
            let height = u32::try_from(item.height)
                .ok()
                .filter(|h| (1..=s.at_height).contains(h))
                .ok_or_else(|| de::Error::custom("a row outside the chain asked"))?;
            let row = Row {
                height,
                txid: item.tx_hash,
            };
            let key = order(&row);
            if s.last.is_some_and(|l| l >= key) {
                return Err(de::Error::custom("rows out of the node's order"));
            }
            s.last = Some(key);
            s.rows += 1;
            out.push(row);
            if out.len() >= s.batch {
                let full = std::mem::replace(&mut out, Vec::with_capacity(s.batch));
                if !(s.sink)(full) {
                    s.stopped = true;
                    return Err(de::Error::custom("stopped"));
                }
            }
        }
        if !out.is_empty() && !(s.sink)(out) {
            s.stopped = true;
            return Err(de::Error::custom("stopped"));
        }
        Ok(())
    }
}
