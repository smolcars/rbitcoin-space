//! A VTXO's id: the outpoint of its last exit transaction's output, written `<txid>:<vout>`.

use std::fmt;
use std::str::FromStr;

use bitcoin::hashes::Hash;
use bitcoin::{OutPoint, Txid};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct VtxoId(pub OutPoint);

/// Bytes on the wire: the txid in internal byte order, then the vout as a little-endian u32.
pub const WIRE_LEN: usize = 36;

impl VtxoId {
    pub fn wire(&self) -> [u8; WIRE_LEN] {
        let mut out = [0u8; WIRE_LEN];
        let (txid, vout) = out.split_at_mut(32);
        txid.copy_from_slice(self.0.txid.as_byte_array());
        vout.copy_from_slice(&self.0.vout.to_le_bytes());
        out
    }
}

impl FromStr for VtxoId {
    type Err = &'static str;

    /// Exactly `<64 hex digits>:<decimal vout>`: no spaces, no sign, no leading zeros.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        const BAD: &str = "invalid vtxo id";
        let (txid, vout) = s.split_once(':').ok_or(BAD)?;
        if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BAD);
        }
        let digits =
            vout.len() <= 10 && !vout.is_empty() && vout.bytes().all(|b| b.is_ascii_digit());
        if !digits || (vout.len() > 1 && vout.starts_with('0')) {
            return Err(BAD);
        }
        let vout = vout.parse::<u32>().map_err(|_| BAD)?;
        let txid = Txid::from_str(txid).map_err(|_| BAD)?;
        Ok(Self(OutPoint { txid, vout }))
    }
}

impl fmt::Display for VtxoId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.0.txid, self.0.vout)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const TXID: &str = "5452a1e4a4b3c787f44bd3a2fc1ac2af0d378d8fe86eff08ab0317db671ba9ec";

    #[test]
    fn parses_and_prints() {
        let id: VtxoId = format!("{TXID}:0").parse().unwrap();
        assert_eq!(id.to_string(), format!("{TXID}:0"));
        let id: VtxoId = format!("{TXID}:4294967295").parse().unwrap();
        assert_eq!(id.0.vout, u32::MAX);
    }

    #[test]
    fn wire_reverses_the_txid() {
        let id: VtxoId = format!("{TXID}:1").parse().unwrap();
        let w = id.wire();
        assert_eq!(w[0], 0xec);
        assert_eq!(w[31], 0x54);
        assert_eq!(&w[32..], &[1, 0, 0, 0]);
    }

    #[test]
    fn refuses_the_malformed() {
        for s in [
            "",
            ":",
            TXID,
            &format!("{TXID}:"),
            &format!("{TXID}:01"),
            &format!("{TXID}:+1"),
            &format!("{TXID}:-1"),
            &format!("{TXID}:4294967296"),
            &format!("{TXID}:99999999999"),
            &format!("{TXID} :0"),
            &format!("{}:0", &TXID[..63]),
            &format!("{}g:0", &TXID[..63]),
            &format!("{TXID}:0:0"),
        ] {
            assert!(s.parse::<VtxoId>().is_err(), "{s}");
        }
    }
}
