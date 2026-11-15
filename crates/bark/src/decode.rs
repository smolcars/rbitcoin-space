//! Bark's serialized VTXO, read defensively. Every integer is little-endian.
//!
//! ```text
//! u16 version (1 or 2) | u64 amount | u32 expiry height | 33 server pubkey | u16 exit delta
//! | 36 anchor outpoint | compact-size n | n genesis items | policy | 36 point
//! ```
//!
//! A genesis item is a transition, `u8` outputs, `u8` our output's index, the other outputs
//! (consensus-encoded), then a `u64` fee in version 2. The point is the last 36 bytes, so a policy
//! we cannot read is skipped as a whole and the rest still decodes.

use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{PublicKey, Scalar, schnorr};
use bitcoin::{Amount, OutPoint, ScriptBuf, TxOut, Txid};

/// What Bark itself allows: heights below the lock-time threshold with room for four deltas.
pub const MAX_BLOCK_DELTA: u16 = u16::MAX / 4;
pub const MAX_BLOCK_HEIGHT: u32 = 500_000_000 - 1 - 4 * MAX_BLOCK_DELTA as u32;
/// More exit transactions than any real VTXO has; the reply's size cap bounds it too.
pub const MAX_ITEMS: usize = 256;
/// Cosigners on one transition.
pub const MAX_KEYS: usize = 256;
/// Bark's own cap on a sibling output's script.
pub const MAX_SCRIPT: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError(pub &'static str);

type Result<T> = std::result::Result<T, DecodeError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vtxo {
    pub version: u16,
    pub amount: Amount,
    pub expiry_height: u32,
    pub server_pubkey: PublicKey,
    pub exit_delta: u16,
    pub anchor: OutPoint,
    pub items: Vec<Item>,
    pub policy: Policy,
    pub point: OutPoint,
}

/// One exit transaction's recipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub transition: Transition,
    /// Where our output sits among the transaction's outputs (before the fee anchor).
    pub output_idx: u8,
    /// The other outputs, in order, without ours.
    pub siblings: Vec<TxOut>,
    /// The value of the pay-to-anchor output; zero in version 1.
    pub fee: Amount,
}

/// How the transaction's one input is signed. A signature of 64 zero bytes is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    /// A tree branch (or a board): a MuSig key-spend by every cosigner.
    Cosigned {
        pubkeys: Vec<PublicKey>,
        signature: Option<schnorr::Signature>,
    },
    /// An out-of-round transfer: a tweaked MuSig key-spend by the cosigners and the server.
    Arkoor {
        cosigners: Vec<PublicKey>,
        tap_tweak: [u8; 32],
        signature: Option<schnorr::Signature>,
    },
    /// A tree leaf: a script spend with the user and server's MuSig key and a hash preimage.
    /// `v1` is the current script; the first one lacked a size check on the preimage.
    HashLocked {
        v1: bool,
        user_pubkey: PublicKey,
        signature: Option<schnorr::Signature>,
        unlock: Unlock,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unlock {
    Preimage([u8; 32]),
    Hash([u8; 32]),
}

/// Who may spend the VTXO's own output, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Policy {
    Pubkey {
        user_pubkey: PublicKey,
    },
    /// A Lightning payment out through the server.
    HtlcSend {
        v1: bool,
        user_pubkey: PublicKey,
        payment_hash: [u8; 32],
        htlc_expiry: u32,
    },
    /// A Lightning payment in through the server.
    HtlcRecv {
        v1: bool,
        user_pubkey: PublicKey,
        payment_hash: [u8; 32],
        htlc_expiry: u32,
        htlc_expiry_delta: u16,
    },
    /// A type we do not rebuild (the server's own kinds, or a newer one): its first byte.
    Other {
        type_byte: u8,
    },
}

impl Transition {
    pub fn signature(&self) -> Option<&schnorr::Signature> {
        match self {
            Self::Cosigned { signature, .. }
            | Self::Arkoor { signature, .. }
            | Self::HashLocked { signature, .. } => signature.as_ref(),
        }
    }

    /// Bark's own name for it.
    pub fn bark_name(&self) -> &'static str {
        match self {
            Self::Cosigned { .. } => "cosigned",
            Self::Arkoor { .. } => "arkoor",
            Self::HashLocked { v1: true, .. } => "hash-locked cosigned",
            Self::HashLocked { v1: false, .. } => "hash-locked cosigned v0",
        }
    }
}

impl Policy {
    pub fn user_pubkey(&self) -> Option<PublicKey> {
        match self {
            Self::Pubkey { user_pubkey }
            | Self::HtlcSend { user_pubkey, .. }
            | Self::HtlcRecv { user_pubkey, .. } => Some(*user_pubkey),
            Self::Other { .. } => None,
        }
    }

    /// Bark's own name for it.
    pub fn bark_name(&self) -> &'static str {
        match self {
            Self::Pubkey { .. } => "pubkey",
            Self::HtlcSend { v1: true, .. } => "server-htlc-send-v1",
            Self::HtlcSend { v1: false, .. } => "server-htlc-send",
            Self::HtlcRecv { v1: true, .. } => "server-htlc-receive-v1",
            Self::HtlcRecv { v1: false, .. } => "server-htlc-receive",
            Self::Other { .. } => "other",
        }
    }
}

struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if n > self.rest.len() {
            return Err(DecodeError("truncated"));
        }
        let (head, rest) = self.rest.split_at(n);
        self.rest = rest;
        Ok(head)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.array::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    /// Bitcoin's compact size, minimally encoded.
    fn compact(&mut self) -> Result<u64> {
        const NON_MINIMAL: DecodeError = DecodeError("non-minimal compact size");
        match self.u8()? {
            0xFD => {
                let n = self.u16()?;
                if n < 0xFD {
                    Err(NON_MINIMAL)
                } else {
                    Ok(u64::from(n))
                }
            }
            0xFE => {
                let n = self.u32()?;
                if n <= 0xFFFF {
                    Err(NON_MINIMAL)
                } else {
                    Ok(u64::from(n))
                }
            }
            0xFF => {
                let n = self.u64()?;
                if n <= 0xFFFF_FFFF {
                    Err(NON_MINIMAL)
                } else {
                    Ok(n)
                }
            }
            n => Ok(u64::from(n)),
        }
    }

    /// A count no larger than `max`.
    fn count(&mut self, max: usize) -> Result<usize> {
        usize::try_from(self.compact()?)
            .ok()
            .filter(|n| *n <= max)
            .ok_or(DecodeError("too many entries"))
    }

    fn pubkey(&mut self) -> Result<PublicKey> {
        PublicKey::from_slice(self.take(33)?).map_err(|_| DecodeError("invalid public key"))
    }

    fn pubkeys(&mut self) -> Result<Vec<PublicKey>> {
        let n = self.count(MAX_KEYS)?;
        (0..n).map(|_| self.pubkey()).collect()
    }

    fn signature(&mut self) -> Result<Option<schnorr::Signature>> {
        let raw: [u8; 64] = self.array()?;
        if raw == [0u8; 64] {
            return Ok(None);
        }
        schnorr::Signature::from_slice(&raw)
            .map(Some)
            .map_err(|_| DecodeError("invalid signature"))
    }

    fn outpoint(&mut self) -> Result<OutPoint> {
        let txid = Txid::from_byte_array(self.array()?);
        Ok(OutPoint {
            txid,
            vout: self.u32()?,
        })
    }

    fn height(&mut self) -> Result<u32> {
        let h = self.u32()?;
        if h > MAX_BLOCK_HEIGHT {
            return Err(DecodeError("block height out of range"));
        }
        Ok(h)
    }

    fn delta(&mut self) -> Result<u16> {
        let d = self.u16()?;
        if d > MAX_BLOCK_DELTA {
            return Err(DecodeError("block delta out of range"));
        }
        Ok(d)
    }

    fn txout(&mut self) -> Result<TxOut> {
        let value = Amount::from_sat(self.u64()?);
        let len = self.count(MAX_SCRIPT)?;
        let script = ScriptBuf::from_bytes(self.take(len)?.to_vec());
        Ok(TxOut {
            value,
            script_pubkey: script,
        })
    }

    fn transition(&mut self) -> Result<Transition> {
        match self.u8()? {
            1 => {
                let pubkeys = self.pubkeys()?;
                if pubkeys.is_empty() {
                    return Err(DecodeError("cosigned transition without keys"));
                }
                Ok(Transition::Cosigned {
                    pubkeys,
                    signature: self.signature()?,
                })
            }
            2 => {
                let cosigners = self.pubkeys()?;
                let tap_tweak: [u8; 32] = self.array()?;
                if Scalar::from_be_bytes(tap_tweak).is_err() {
                    return Err(DecodeError("tap tweak out of range"));
                }
                Ok(Transition::Arkoor {
                    cosigners,
                    tap_tweak,
                    signature: self.signature()?,
                })
            }
            t @ (3 | 4) => {
                let user_pubkey = self.pubkey()?;
                let signature = self.signature()?;
                let unlock = match self.u8()? {
                    0 => Unlock::Preimage(self.array()?),
                    1 => Unlock::Hash(self.array()?),
                    _ => return Err(DecodeError("invalid unlock kind")),
                };
                Ok(Transition::HashLocked {
                    v1: t == 4,
                    user_pubkey,
                    signature,
                    unlock,
                })
            }
            _ => Err(DecodeError("unknown transition type")),
        }
    }

    fn item(&mut self, version: u16) -> Result<Item> {
        let transition = self.transition()?;
        let outputs = usize::from(self.u8()?);
        let output_idx = self.u8()?;
        // Our output must be one of the transaction's, never the fee anchor after them.
        if outputs == 0 || usize::from(output_idx) >= outputs {
            return Err(DecodeError("output index out of range"));
        }
        let siblings = (1..outputs)
            .map(|_| self.txout())
            .collect::<Result<Vec<_>>>()?;
        let fee = if version == 1 {
            Amount::ZERO
        } else {
            Amount::from_sat(self.u64()?)
        };
        Ok(Item {
            transition,
            output_idx,
            siblings,
            fee,
        })
    }
}

fn policy(bytes: &[u8]) -> Result<Policy> {
    let mut r = Reader { rest: bytes };
    let kind = r.u8()?;
    let policy = match kind {
        0x00 => Policy::Pubkey {
            user_pubkey: r.pubkey()?,
        },
        0x01 | 0x09 => Policy::HtlcSend {
            v1: kind == 0x09,
            user_pubkey: r.pubkey()?,
            payment_hash: r.array()?,
            htlc_expiry: r.height()?,
        },
        0x02 | 0x08 => Policy::HtlcRecv {
            v1: kind == 0x08,
            user_pubkey: r.pubkey()?,
            payment_hash: r.array()?,
            htlc_expiry: r.height()?,
            htlc_expiry_delta: r.delta()?,
        },
        type_byte => return Ok(Policy::Other { type_byte }),
    };
    if !r.rest.is_empty() {
        return Err(DecodeError("trailing bytes in policy"));
    }
    Ok(policy)
}

/// Reads a whole serialized VTXO; anything left over is an error.
pub fn decode(bytes: &[u8]) -> Result<Vtxo> {
    let mut r = Reader { rest: bytes };
    let version = r.u16()?;
    if version != 1 && version != 2 {
        return Err(DecodeError("unknown encoding version"));
    }
    let amount = Amount::from_sat(r.u64()?);
    let expiry_height = r.height()?;
    let server_pubkey = r.pubkey()?;
    let exit_delta = r.delta()?;
    let anchor = r.outpoint()?;
    let n = r.count(MAX_ITEMS)?;
    let items = (0..n)
        .map(|_| r.item(version))
        .collect::<Result<Vec<_>>>()?;
    let split = r
        .rest
        .len()
        .checked_sub(crate::id::WIRE_LEN)
        .ok_or(DecodeError("truncated"))?;
    let policy_bytes = r.take(split)?;
    let policy = policy(policy_bytes)?;
    let point = r.outpoint()?;
    // A VTXO with no exit transactions is the anchor itself, and only then.
    if (point == anchor) != items.is_empty() {
        return Err(DecodeError("genesis does not match the point"));
    }
    Ok(Vtxo {
        version,
        amount,
        expiry_height,
        server_pubkey,
        exit_delta,
        anchor,
        items,
        policy,
        point,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;
    use crate::check::tests::{named, vectors};

    #[test]
    fn decodes_every_vector() {
        for (version, set) in vectors() {
            for (name, bytes) in set.vtxos {
                let v = decode(&bytes).unwrap_or_else(|e| panic!("{version} {name}: {e:?}"));
                assert_eq!(v.version, version, "{name}");
                assert!(!v.items.is_empty(), "{name}");
            }
        }
    }

    #[test]
    fn reads_the_board_vector() {
        let set = &vectors()[0].1;
        let v = decode(named(set, "board_vtxo")).unwrap();
        assert_eq!(v.amount, Amount::from_sat(10_000));
        assert_eq!(v.items.len(), 1);
        assert!(matches!(v.items[0].transition, Transition::Cosigned { .. }));
        assert!(matches!(v.policy, Policy::Pubkey { .. }));
    }

    #[test]
    fn every_truncation_is_an_error() {
        for (_, set) in vectors() {
            for (_, bytes) in set.vtxos {
                for n in 0..bytes.len() {
                    // A cut inside the policy can still parse as a shorter "other" policy, but
                    // never as the same VTXO.
                    if let Ok(v) = decode(&bytes[..n]) {
                        assert_ne!(Some(v), decode(&bytes).ok());
                    }
                }
            }
        }
    }

    #[test]
    fn refuses_bad_fields() {
        let set = &vectors()[0].1;
        let good = named(set, "board_vtxo").to_vec();
        let mut bad = good.clone();
        bad[0] = 3;
        assert_eq!(decode(&bad), Err(DecodeError("unknown encoding version")));
        // The expiry height, past what Bark allows.
        let mut bad = good.clone();
        bad[10..14].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode(&bad), Err(DecodeError("block height out of range")));
        let mut bad = good.clone();
        bad.push(0);
        assert!(decode(&bad).is_err());
        // An output index past the outputs: board vector's first item at a fixed offset.
        let v = decode(&good).unwrap();
        let Transition::Cosigned { pubkeys, .. } = &v.items[0].transition else {
            unreachable!()
        };
        let at = 2 + 8 + 4 + 33 + 2 + 36 + 1 + 1 + 1 + 33 * pubkeys.len() + 64;
        let mut bad = good.clone();
        bad[at + 1] = bad[at];
        assert_eq!(decode(&bad), Err(DecodeError("output index out of range")));
    }

    #[test]
    fn huge_counts_do_not_allocate() {
        let mut bytes = vec![2, 0];
        bytes.extend([0u8; 8 + 4]);
        bytes.extend(named(&vectors()[0].1, "board_vtxo")[14..14 + 33].iter());
        bytes.extend([0u8; 2 + 36]);
        bytes.extend([0xFF, 0, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(decode(&bytes), Err(DecodeError("too many entries")));
    }
}
