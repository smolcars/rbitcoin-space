//! A transaction's outputs, kept compactly so the replacement record can say what changed between
//! two versions after the node has forgotten the older one (`docs/MEMPOOL.md`, "The record").
//!
//! Each output is its value and its script: in full up to [`SCRIPT_KEPT`] bytes (every standard
//! address form fits), and past that its length and the first [`HASH_BYTES`] bytes of its SHA-256,
//! enough to tell two scripts apart without keeping either. A transaction with more than
//! [`MAX_OUTPUTS`] outputs keeps only their number.
//!
//! The encoding, per output: the value as a LEB128 number, then a LEB128 tag `len << 1 | hashed`,
//! then the script's `len` bytes or, when hashed, the hash.

use std::sync::Arc;

use bitcoin::TxOut;
use bitcoin::hashes::{Hash, sha256};
use serde_json::{Value, json};

/// Most outputs kept per transaction. Past it the compare view says the version has too many
/// outputs to compare. Wallet payments and fee bumps have two or three; 32 still covers small
/// batched payouts, and bounds one transaction's kept outputs at [`MAX_KEPT_BYTES`].
pub const MAX_OUTPUTS: usize = 32;
/// Longest script kept in full: P2WSH and P2TR, the longest standard address forms, are 34 bytes.
pub const SCRIPT_KEPT: usize = 34;
/// Bytes of SHA-256 kept for a longer script: 128 bits, so two scripts that look the same here
/// cannot be ground out (a 64-bit hash would take an attacker about 2³² tries).
pub const HASH_BYTES: usize = 16;
/// The most one transaction's kept outputs take: a value of at most 10 bytes (8 for any amount
/// up to 21 million bitcoin), a 1-byte tag and 34 bytes each.
pub const MAX_KEPT_BYTES: usize = MAX_OUTPUTS * (10 + 1 + SCRIPT_KEPT);

/// One output as kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// Sats.
    pub value: u64,
    pub script: Script,
}

/// An output's script as kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Script {
    /// The script itself, at most [`SCRIPT_KEPT`] bytes.
    Full(Vec<u8>),
    /// A longer script: its length and the start of its SHA-256.
    Hashed { len: u32, hash: [u8; HASH_BYTES] },
}

/// What is known of one version's outputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outputs {
    /// Every output, encoded (see the module's documentation).
    Kept(Arc<[u8]>),
    /// More than [`MAX_OUTPUTS`]: only how many.
    TooMany(u32),
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// A LEB128 number at `*at`, moving past it. `None` when cut short or longer than a `u64`.
fn get_varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let b = *bytes.get(*at)?;
        *at += 1;
        // The tenth byte has room for one bit: more would be lost by the shift, not refused.
        if shift == 63 && b & 0x7f > 1 {
            return None;
        }
        v |= u64::from(b & 0x7f).checked_shl(shift)?;
        if b & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// Appends one output's encoding.
fn put(out: &mut Vec<u8>, value: u64, script: &[u8]) {
    put_varint(out, value);
    let len = script.len() as u64;
    if script.len() <= SCRIPT_KEPT {
        put_varint(out, len << 1);
        out.extend_from_slice(script);
    } else {
        put_varint(out, (len << 1) | 1);
        let hash = sha256::Hash::hash(script).to_byte_array();
        out.extend_from_slice(hash.get(..HASH_BYTES).unwrap_or_default());
    }
}

/// The encoding of `outputs` (value, script), or `None` past [`MAX_OUTPUTS`].
pub fn encode<'a>(outputs: impl ExactSizeIterator<Item = (u64, &'a [u8])>) -> Option<Vec<u8>> {
    if outputs.len() > MAX_OUTPUTS {
        return None;
    }
    let mut out = Vec::new();
    for (value, script) in outputs {
        put(&mut out, value, script);
    }
    Some(out)
}

/// [`encode`] for a transaction's own outputs.
pub fn encode_tx(outputs: &[TxOut]) -> Option<Vec<u8>> {
    encode(
        outputs
            .iter()
            .map(|o| (o.value.to_sat(), o.script_pubkey.as_bytes())),
    )
}

/// Reads one output at `*at`. `None` when the bytes are not a valid encoding.
fn get(bytes: &[u8], at: &mut usize) -> Option<Output> {
    let value = get_varint(bytes, at)?;
    let tag = get_varint(bytes, at)?;
    let len = usize::try_from(tag >> 1).ok()?;
    let script = if tag & 1 == 0 {
        if len > SCRIPT_KEPT {
            return None;
        }
        let s = bytes.get(*at..at.checked_add(len)?)?;
        *at += len;
        Script::Full(s.to_vec())
    } else {
        let h = bytes.get(*at..at.checked_add(HASH_BYTES)?)?;
        *at += HASH_BYTES;
        Script::Hashed {
            len: u32::try_from(len).ok()?,
            hash: h.try_into().ok()?,
        }
    };
    Some(Output { value, script })
}

/// The first `count` outputs of an encoding, and the bytes they took. `None` when malformed.
pub(crate) fn decode_n(bytes: &[u8], count: usize) -> Option<(Vec<Output>, usize)> {
    if count > MAX_OUTPUTS {
        return None;
    }
    let mut at = 0;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(get(bytes, &mut at)?);
    }
    Some((out, at))
}

/// Every output of an encoding. `None` when malformed or longer than [`MAX_OUTPUTS`].
pub fn decode(bytes: &[u8]) -> Option<Vec<Output>> {
    let mut at = 0;
    let mut out = Vec::new();
    while at < bytes.len() {
        if out.len() == MAX_OUTPUTS {
            return None;
        }
        out.push(get(bytes, &mut at)?);
    }
    Some(out)
}

/// The longest stored form read back: the kind byte and the largest kept encoding. A longer
/// blob is refused before it is copied out of the store.
pub const MAX_BLOB_BYTES: usize = 1 + MAX_KEPT_BYTES;

/// Stored form's first byte: what follows.
const BLOB_KEPT: u8 = 1;
const BLOB_TOO_MANY: u8 = 2;

impl Outputs {
    /// A transaction's outputs as kept.
    pub fn of(outputs: &[TxOut]) -> Self {
        match encode_tx(outputs) {
            Some(b) => Self::Kept(b.into()),
            None => Self::TooMany(u32::try_from(outputs.len()).unwrap_or(u32::MAX)),
        }
    }

    /// Each output, or `None` when there were too many to keep (or the bytes are malformed).
    pub fn list(&self) -> Option<Vec<Output>> {
        match self {
            Self::Kept(b) => decode(b),
            Self::TooMany(_) => None,
        }
    }

    /// The bytes this takes in memory beyond the value itself.
    pub fn heap_bytes(&self) -> usize {
        match self {
            Self::Kept(b) => b.len(),
            Self::TooMany(_) => 0,
        }
    }

    /// The stored form: a byte saying which, then the encoding or the count as LEB128.
    pub fn to_blob(&self) -> Vec<u8> {
        match self {
            Self::Kept(b) => {
                let mut out = Vec::with_capacity(b.len() + 1);
                out.push(BLOB_KEPT);
                out.extend_from_slice(b);
                out
            }
            Self::TooMany(n) => {
                let mut out = vec![BLOB_TOO_MANY];
                put_varint(&mut out, u64::from(*n));
                out
            }
        }
    }

    /// The stored form read back. `None` when it is not one: the reader then says the outputs
    /// were not recorded, rather than trust it.
    pub fn from_blob(blob: &[u8]) -> Option<Self> {
        if blob.len() > MAX_BLOB_BYTES {
            return None;
        }
        let (kind, rest) = blob.split_first()?;
        match *kind {
            BLOB_KEPT => decode(rest).map(|_| Self::Kept(rest.into())),
            BLOB_TOO_MANY => {
                let mut at = 0;
                let n = get_varint(rest, &mut at)?;
                (at == rest.len()).then_some(Self::TooMany(u32::try_from(n).ok()?))
            }
            _ => None,
        }
    }

    /// As `/app` sends it: `{"state": "kept", "list": [...]}` or `{"state": "too_many",
    /// "count": n}`. A script is hex, or for a long one `script_len` and `script_hash` (hex).
    pub fn json(&self) -> Value {
        match self {
            Self::TooMany(n) => json!({ "state": "too_many", "count": n }),
            Self::Kept(_) => match self.list() {
                None => json!({ "state": "not_recorded" }),
                Some(list) => json!({
                    "state": "kept",
                    "list": list.iter().map(Output::json).collect::<Vec<_>>(),
                }),
            },
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

impl Output {
    pub fn json(&self) -> Value {
        match &self.script {
            Script::Full(s) => json!({ "value": self.value, "script": hex(s) }),
            Script::Hashed { len, hash } => json!({
                "value": self.value,
                "script_len": len,
                "script_hash": hex(hash),
            }),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;
    use bitcoin::{Amount, ScriptBuf};

    fn out(value: u64, script: Vec<u8>) -> TxOut {
        TxOut {
            value: Amount::from_sat(value),
            script_pubkey: ScriptBuf::from_bytes(script),
        }
    }

    #[test]
    fn standard_scripts_are_kept_whole_and_longer_ones_hashed() {
        let p2wpkh = [&[0x00, 0x14][..], &[7; 20]].concat();
        let p2tr = [&[0x51, 0x20][..], &[9; 32]].concat();
        let op_return = [&[0x6a, 0x4c, 0x50][..], &[1; 80]].concat();
        let outs = [
            out(546, p2wpkh.clone()),
            out(21_000_000 * 100_000_000, p2tr.clone()),
            out(0, op_return.clone()),
        ];
        let kept = Outputs::of(&outs);
        let list = kept.list().unwrap();
        assert_eq!(list[0].script, Script::Full(p2wpkh));
        assert_eq!(list[1].value, 21_000_000 * 100_000_000);
        assert_eq!(list[1].script, Script::Full(p2tr));
        let Script::Hashed { len, hash } = &list[2].script else {
            panic!("an 83-byte script is hashed");
        };
        assert_eq!(*len, 83);
        assert_eq!(
            hash[..],
            sha256::Hash::hash(&op_return).to_byte_array()[..HASH_BYTES]
        );
        // value (2 + 8 + 1 bytes) + tag (1 + 1 + 2) + 22 + 34 + 16.
        assert_eq!(kept.heap_bytes(), 2 + 8 + 1 + 1 + 1 + 2 + 22 + 34 + 16);
    }

    #[test]
    fn a_script_of_exactly_the_limit_is_kept_and_one_byte_more_is_hashed() {
        let kept = Outputs::of(&[
            out(1, vec![5; SCRIPT_KEPT]),
            out(1, vec![5; SCRIPT_KEPT + 1]),
        ]);
        let list = kept.list().unwrap();
        assert!(matches!(list[0].script, Script::Full(_)));
        assert!(matches!(list[1].script, Script::Hashed { len: 35, .. }));
    }

    #[test]
    fn past_the_cap_only_the_count_is_kept() {
        let at_cap: Vec<TxOut> = (0..MAX_OUTPUTS as u64)
            .map(|i| out(i, vec![0x51]))
            .collect();
        assert_eq!(Outputs::of(&at_cap).list().unwrap().len(), MAX_OUTPUTS);
        let over: Vec<TxOut> = (0..=MAX_OUTPUTS as u64)
            .map(|i| out(i, vec![0x51]))
            .collect();
        assert_eq!(Outputs::of(&over), Outputs::TooMany(MAX_OUTPUTS as u32 + 1));
        assert_eq!(Outputs::of(&over).list(), None);
    }

    #[test]
    fn the_largest_kept_form_is_within_its_bound() {
        let worst: Vec<TxOut> = (0..MAX_OUTPUTS)
            .map(|_| out(u64::MAX, vec![0xff; SCRIPT_KEPT]))
            .collect();
        assert!(Outputs::of(&worst).heap_bytes() <= MAX_KEPT_BYTES);
    }

    #[test]
    fn the_stored_form_round_trips_and_garbage_is_refused() {
        for o in [
            Outputs::of(&[out(1000, vec![0x00, 0x14, 1, 2]), out(5, vec![0x6a; 90])]),
            Outputs::TooMany(5000),
            Outputs::Kept(Arc::from(&[][..])),
        ] {
            assert_eq!(Outputs::from_blob(&o.to_blob()), Some(o));
        }
        for bad in [
            &[][..],
            &[9],
            &[BLOB_KEPT, 0x80],          // cut-short value
            &[BLOB_KEPT, 1, 0x08, 1],    // 4-byte script, 1 byte present
            &[BLOB_KEPT, 1, 0x80, 0x01], // a 64-byte script said to be kept whole
            &[BLOB_TOO_MANY],            // no count
            &[BLOB_TOO_MANY, 1, 2],      // trailing bytes
            &[
                BLOB_KEPT, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
            ],
        ] {
            assert_eq!(Outputs::from_blob(bad), None, "{bad:?}");
        }
        // More outputs than the cap is not a kept form either.
        let mut many = vec![BLOB_KEPT];
        for _ in 0..=MAX_OUTPUTS {
            many.extend_from_slice(&[1, 0]);
        }
        assert_eq!(Outputs::from_blob(&many), None);
    }

    #[test]
    fn a_varint_that_overflows_in_its_last_byte_is_refused() {
        let mut at = 0;
        let max = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
        assert_eq!(get_varint(&max, &mut at), Some(u64::MAX));
        // Nine continuation bytes, then a payload of 2: bit 64, which a u64 does not have.
        let over = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02];
        assert_eq!(get_varint(&over, &mut 0), None);
        let mut blob = vec![BLOB_KEPT];
        blob.extend_from_slice(&over);
        blob.push(0);
        assert_eq!(
            Outputs::from_blob(&blob),
            None,
            "a corrupt amount reads as missing"
        );
    }

    #[test]
    fn a_blob_longer_than_any_kept_form_is_refused() {
        // 32 outputs whose numbers carry redundant continuation bytes: each one decodes, but
        // together they are longer than anything `encode` writes.
        let mut blob = vec![BLOB_KEPT];
        for _ in 0..MAX_OUTPUTS {
            blob.extend_from_slice(&[0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]);
            // Tag 68: a 34-byte script kept whole.
            blob.extend_from_slice(&[0xc4, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]);
            blob.extend_from_slice(&[0x40; 34]);
        }
        assert!(blob.len() > MAX_BLOB_BYTES);
        assert!(decode(&blob[1..]).is_some(), "each part reads");
        assert_eq!(Outputs::from_blob(&blob), None);
    }

    #[test]
    fn json_names_scripts_by_hex_or_by_length_and_hash() {
        let o = Outputs::of(&[out(1, vec![0xab, 0xcd]), out(2, vec![0; 40])]);
        let v = o.json();
        assert_eq!(v["state"], "kept");
        assert_eq!(v["list"][0], json!({ "value": 1, "script": "abcd" }));
        assert_eq!(v["list"][1]["script_len"], 40);
        assert_eq!(
            v["list"][1]["script_hash"].as_str().unwrap().len(),
            HASH_BYTES * 2
        );
        assert_eq!(
            Outputs::TooMany(40).json(),
            json!({ "state": "too_many", "count": 40 })
        );
    }
}
