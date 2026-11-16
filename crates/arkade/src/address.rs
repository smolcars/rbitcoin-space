//! Ark addresses as BOAT-1 ("Ark address format", github.com/ark-protocol/boats) defines them,
//! parsed strictly before anything is asked of the server.
//!
//! Bech32m with the prefix `ark` (mainnet) or `tark` (any test network). The first 5-bit field
//! element is the version: `0` (`q`) is Arkade's, `1` (`p`) Bark's. Version 0's whole data part,
//! version bits included, decodes to 65 bytes: `arkade_version` (1 byte, only `0` defined),
//! `server_key` (32 bytes, the server's x-only key) and `p2tr_key` (32 bytes, the taproot output
//! key). The script it pays to is `5120<p2tr_key>`.

use std::fmt;

use bitcoin::bech32::primitives::decode::UncheckedHrpstring;
use bitcoin::bech32::primitives::iter::Fe32IterExt;
use bitcoin::bech32::{Bech32m, Fe32};
use bitcoin::secp256k1::XOnlyPublicKey;

/// Longer than any Arkade address (`tark1` + 104 + 6 = 115 characters): refused unread.
pub const MAX_ADDRESS_LEN: usize = 128;
/// Data characters of a version 0 address, its checksum left out: 65 bytes are 104 groups of 5.
const DATA_CHARS: usize = 104;

/// Why a string is not an Arkade address of this network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressError {
    /// Not bech32m, or the wrong length (and, from [`Address::parse`], a bad checksum).
    Invalid,
    /// An `ark` or `tark` string whose bech32m checksum fails ([`parse_any`] only).
    Checksum,
    /// An Ark address for another network: `ark` on a test network, `tark` on mainnet.
    OtherNetwork,
    /// BOAT-1 version 1: a Bark address, whose VTXOs cannot be listed.
    Bark,
    /// A BOAT-1 version, or an `arkade_version`, that is not defined.
    Version,
    /// A key that is not a point on the curve.
    Key,
}

/// A version 0 (Arkade) address's two keys, by BOAT-1's names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Address {
    /// The Ark server's key, x-only: its signer.
    pub server_key: [u8; 32],
    /// The taproot output key the VTXO pays to.
    pub p2tr_key: [u8; 32],
}

/// Any Ark address, read without being told the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnyAddress {
    Arkade(Address),
    /// BOAT-1 version 1: the bytes after the version, for `bark::address` to read.
    Bark(Vec<u8>),
}

/// The longest Ark address of any version read: Bark's carry delivery entries of their own length.
pub const MAX_ANY_LEN: usize = 1023;

/// Reads an Ark address of either network: `true` with it for mainnet (`ark`), `false` for a test
/// network (`tark`). Either case, never mixed.
pub fn parse_any(s: &str) -> Result<(bool, AnyAddress), AddressError> {
    if s.len() > MAX_ANY_LEN {
        return Err(AddressError::Invalid);
    }
    let raw = UncheckedHrpstring::new(s).map_err(|_| AddressError::Invalid)?;
    let mainnet = match raw.hrp().to_lowercase().as_str() {
        "ark" => true,
        "tark" => false,
        _ => return Err(AddressError::Invalid),
    };
    let checked = raw
        .validate_and_remove_checksum::<Bech32m>()
        .map_err(|_| AddressError::Checksum)?;
    // Bark's payload has its own length, so the version is read before the length.
    match checked.fe32_iter::<std::iter::Empty<u8>>().next() {
        Some(Fe32::Q) => {}
        Some(Fe32::P) => {
            let bytes = checked
                .fe32_iter::<std::iter::Empty<u8>>()
                .skip(1)
                .fes_to_bytes();
            return Ok((mainnet, AnyAddress::Bark(bytes.collect())));
        }
        Some(_) => return Err(AddressError::Version),
        None => return Err(AddressError::Invalid),
    }
    if checked.data_part_ascii_no_checksum().len() != DATA_CHARS {
        return Err(AddressError::Invalid);
    }
    let bytes: Vec<u8> = checked.byte_iter().collect();
    let [arkade_version, rest @ ..] = bytes.as_slice() else {
        return Err(AddressError::Invalid);
    };
    if *arkade_version != 0 {
        return Err(AddressError::Version);
    }
    let (server_key, p2tr_key) = rest.split_at_checked(32).ok_or(AddressError::Invalid)?;
    let key = |b: &[u8]| -> Result<[u8; 32], AddressError> {
        let k = XOnlyPublicKey::from_slice(b).map_err(|_| AddressError::Key)?;
        Ok(k.serialize())
    };
    let address = Address {
        server_key: key(server_key)?,
        p2tr_key: key(p2tr_key)?,
    };
    Ok((mainnet, AnyAddress::Arkade(address)))
}

impl Address {
    /// Parses `s` for mainnet (`ark`) or a test network (`tark`). Either case, never mixed.
    pub fn parse(s: &str, mainnet: bool) -> Result<Self, AddressError> {
        if s.len() > MAX_ADDRESS_LEN {
            return Err(AddressError::Invalid);
        }
        match parse_any(s) {
            Ok((m, _)) if m != mainnet => Err(AddressError::OtherNetwork),
            Ok((_, AnyAddress::Arkade(a))) => Ok(a),
            Ok((_, AnyAddress::Bark(_))) => Err(AddressError::Bark),
            // A mistyped address is never one of another network, nor told apart from any other.
            Err(AddressError::Checksum) => Err(AddressError::Invalid),
            Err(e) => Err(e),
        }
    }

    /// The script the address pays to, as hex: `5120<p2tr_key>`.
    pub fn script_hex(&self) -> String {
        format!("5120{}", hex(&self.p2tr_key))
    }
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid",
            Self::Checksum => "checksum",
            Self::OtherNetwork => "other_network",
            Self::Bark => "bark",
            Self::Version => "version",
            Self::Key => "key",
        })
    }
}

impl std::error::Error for AddressError {}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// The x-only form of a key arkd sends as hex: 33 bytes compressed, or 32 already x-only.
pub(crate) fn x_only(hex_key: &str) -> Option<[u8; 32]> {
    let digits = hex_key.as_bytes();
    if !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let from = match (digits.len(), digits.get(..2)) {
        (66, Some(b"02" | b"03")) => 2,
        (64, _) => 0,
        _ => return None,
    };
    let mut out = [0u8; 32];
    let (pairs, _) = digits.get(from..)?.as_chunks::<2>();
    for (o, pair) in out.iter_mut().zip(pairs) {
        let s = std::str::from_utf8(pair).ok()?;
        *o = u8::from_str_radix(s, 16).ok()?;
    }
    Some(out)
}
