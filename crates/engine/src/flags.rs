//! A transaction's feature bits, from its own bytes alone: the reference's `flags` layout, so its
//! `/api/v1` field can be passed through. What each bit means, the rules and how well they agree
//! with the reference: [`docs/API.md`](../../../docs/API.md#transaction-flags).
//!
//! No previous outputs are read: what an input spends is inferred from its scriptSig and witness.
//! A spend the rules cannot place sets no type bit rather than a guess.

use bitcoin::opcodes::all::{OP_CHECKMULTISIG, OP_IF, OP_PUSHNUM_1, OP_PUSHNUM_16};
use bitcoin::script::Instruction;
use bitcoin::secp256k1::PublicKey;
use bitcoin::{Script, Transaction, TxIn};

/// An input's sequence is below `0xfffffffe`.
pub const RBF: u64 = 1 << 0;
/// No input's sequence is below `0xfffffffe`.
pub const NO_RBF: u64 = 1 << 1;
pub const V1: u64 = 1 << 2;
pub const V2: u64 = 1 << 3;
pub const V3: u64 = 1 << 4;
pub const P2PK: u64 = 1 << 8;
/// Bare multisig.
pub const P2MS: u64 = 1 << 9;
pub const P2PKH: u64 = 1 << 10;
pub const P2SH: u64 = 1 << 11;
pub const P2WPKH: u64 = 1 << 12;
pub const P2WSH: u64 = 1 << 13;
pub const P2TR: u64 = 1 << 14;
/// A child pays for it: its chunk's rate in a projected block, or a child's in the same mined
/// block, is more than [`CPFP_MARGIN_PERCENT`] above its own. Set by the projector and by a mined
/// block's summary, never by [`of`].
pub const PAID_BY_CHILD: u64 = 1 << 16;
/// It pays for a parent: its own rate is more than [`CPFP_MARGIN_PERCENT`] above its chunk's in a
/// projected block, or above a parent's in the same mined block. Set as [`PAID_BY_CHILD`] is.
pub const PAYS_FOR_PARENT: u64 = 1 << 17;
/// It replaced another transaction in the mempool. Set by the tracker when it sees the
/// replacement, and by a mined block's summary from the record of replacements.
pub const REPLACEMENT: u64 = 1 << 18;
/// How far apart, in percent, two fee rates must be for bits 16 and 17. Compared exactly, mainnet
/// chains of 0.12 sat/vB lifted 2% by one member flagged 82 to 90% of a block (`docs/API.md`).
pub const CPFP_MARGIN_PERCENT: u64 = 10;
pub const OP_RETURN: u64 = 1 << 24;
/// A bare multisig output holds a key that is not a point on the curve.
pub const FAKE_PUBKEY: u64 = 1 << 25;
/// A Taproot script-path spend whose script holds an `OP_FALSE OP_IF` envelope.
pub const INSCRIPTION: u64 = 1 << 26;
/// Not the coinbase, and at least five inputs per output.
pub const CONSOLIDATION: u64 = 1 << 33;
/// At least five outputs per input.
pub const BATCH_PAYMENT: u64 = 1 << 34;
pub const SIGHASH_ALL: u64 = 1 << 40;
pub const SIGHASH_NONE: u64 = 1 << 41;
pub const SIGHASH_SINGLE: u64 = 1 << 42;
/// A 64-byte Taproot signature.
pub const SIGHASH_DEFAULT: u64 = 1 << 43;
pub const SIGHASH_ACP: u64 = 1 << 44;

/// Every bit [`of`] can set. Bits 16 to 18 need the mempool's context and are set elsewhere;
/// the reference's other bits are left unset.
pub const KNOWN: u64 = RBF
    | NO_RBF
    | V1
    | V2
    | V3
    | P2PK
    | P2MS
    | P2PKH
    | P2SH
    | P2WPKH
    | P2WSH
    | P2TR
    | OP_RETURN
    | FAKE_PUBKEY
    | INSCRIPTION
    | CONSOLIDATION
    | BATCH_PAYMENT
    | SIGHASH_ALL
    | SIGHASH_NONE
    | SIGHASH_SINGLE
    | SIGHASH_DEFAULT
    | SIGHASH_ACP;

/// The transaction's flags.
pub fn of(tx: &Transaction) -> u64 {
    let mut f = if tx.input.iter().any(|i| i.sequence.is_rbf()) {
        RBF
    } else {
        NO_RBF
    };
    f |= match tx.version.0 {
        1 => V1,
        2 => V2,
        3 => V3,
        _ => 0,
    };
    for out in &tx.output {
        f |= output(&out.script_pubkey);
    }
    let coinbase = tx.is_coinbase();
    if !coinbase {
        for input in &tx.input {
            f |= spend(input);
        }
    }
    let (ins, outs) = (tx.input.len(), tx.output.len());
    if !coinbase && ins >= outs.saturating_mul(5) {
        f |= CONSOLIDATION;
    }
    if outs >= ins.saturating_mul(5) {
        f |= BATCH_PAYMENT;
    }
    f
}

fn output(spk: &Script) -> u64 {
    if spk.is_op_return() {
        OP_RETURN
    } else if spk.is_p2pkh() {
        P2PKH
    } else if spk.is_p2sh() {
        P2SH
    } else if spk.is_p2wpkh() {
        P2WPKH
    } else if spk.is_p2wsh() {
        P2WSH
    } else if spk.is_p2tr() {
        P2TR
    } else if spk.is_p2pk() {
        P2PK
    } else {
        match multisig(spk) {
            Some(true) => P2MS | FAKE_PUBKEY,
            Some(false) => P2MS,
            None => 0,
        }
    }
}

/// `Some(has a key off the curve)` for `OP_m <n keys of 33 or 65 bytes> OP_n OP_CHECKMULTISIG`.
fn multisig(spk: &Script) -> Option<bool> {
    let [m, keys @ .., n, last] = spk.as_bytes() else {
        return None;
    };
    let pushnum = OP_PUSHNUM_1.to_u8()..=OP_PUSHNUM_16.to_u8();
    if *last != OP_CHECKMULTISIG.to_u8() || !pushnum.contains(m) || !pushnum.contains(n) {
        return None;
    }
    let (mut count, mut fake) = (0u8, false);
    for key in Script::from_bytes(keys).instructions() {
        let Ok(Instruction::PushBytes(key)) = key else {
            return None;
        };
        let key = key.as_bytes();
        if key.len() != 33 && key.len() != 65 {
            return None;
        }
        fake |= PublicKey::from_slice(key).is_err();
        count = count.saturating_add(1);
    }
    (count == n - OP_PUSHNUM_1.to_u8() + 1).then_some(fake)
}

/// What a non-coinbase input spends, its signatures' types, and whether it is an inscription.
fn spend(input: &TxIn) -> u64 {
    let wit = &input.witness;
    let sig = pushes(&input.script_sig);
    if wit.is_empty() {
        let p = sig;
        let kind = if !p.push_only || p.count == 0 {
            0
        } else if p.count == 1 && der(p.first) {
            P2PK
        } else if p.count == 2 && der(p.first) && pubkey(p.second) {
            P2PKH
        } else if p.count >= 2 && p.first.is_empty() && p.rest_der {
            P2MS
        } else {
            P2SH
        };
        return kind | p.sighash;
    }
    let every_der = wit
        .iter()
        .filter(|w| der(w))
        .fold(0, |f, w| f | sighash(w.last().copied()));
    if !input.script_sig.is_empty() {
        return P2SH | every_der | sig.sighash;
    }
    // The annex: the last of two or more items, when it starts with 0x50.
    let n = match wit.last() {
        Some([0x50, ..]) if wit.len() >= 2 => wit.len() - 1,
        _ => wit.len(),
    };
    let last = n
        .checked_sub(1)
        .and_then(|i| wit.nth(i))
        .unwrap_or_default();
    if n == 1 && (last.len() == 64 || last.len() == 65) {
        return P2TR | schnorr(last);
    }
    if n >= 2 && control_block(last) {
        let script = n
            .checked_sub(2)
            .and_then(|i| wit.nth(i))
            .unwrap_or_default();
        let sigs = wit
            .iter()
            .take(n - 2)
            .filter(|w| w.len() == 64 || w.len() == 65)
            .fold(0, |f, w| f | schnorr(w));
        let envelope = if envelope(Script::from_bytes(script)) {
            INSCRIPTION
        } else {
            0
        };
        return P2TR | sigs | envelope;
    }
    if n == 2 && last.len() == 33 && matches!(last.first(), Some(2 | 3)) {
        return P2WPKH | every_der;
    }
    P2WSH | every_der
}

fn control_block(item: &[u8]) -> bool {
    item.len() >= 33
        && (item.len() - 33).is_multiple_of(32)
        && matches!(item.first(), Some(b) if b & 0xfe == 0xc0)
}

/// Whether the script holds `OP_FALSE OP_IF`, read as opcodes up to the first it cannot parse.
fn envelope(script: &Script) -> bool {
    let mut after_false = false;
    for i in script.instruction_indices() {
        match i {
            Ok((_, Instruction::Op(op))) if op == OP_IF && after_false => return true,
            // OP_FALSE is the byte 0x00; an empty OP_PUSHDATA push is not it.
            Ok((at, _)) => after_false = script.as_bytes().get(at) == Some(&0x00),
            Err(_) => return false,
        }
    }
    false
}

/// A 64-byte Taproot signature is DEFAULT; a 65-byte one names its type in its last byte.
fn schnorr(s: &[u8]) -> u64 {
    if s.len() == 64 {
        SIGHASH_DEFAULT
    } else {
        sighash(s.last().copied())
    }
}

fn sighash(kind: Option<u8>) -> u64 {
    let Some(kind) = kind else { return 0 };
    let base = match kind & 0x1f {
        1 => SIGHASH_ALL,
        2 => SIGHASH_NONE,
        3 => SIGHASH_SINGLE,
        _ => 0,
    };
    if kind & 0x80 != 0 {
        base | SIGHASH_ACP
    } else {
        base
    }
}

/// 9 to 73 bytes, `0x30`, then a length that leaves one byte for the sighash type.
fn der(s: &[u8]) -> bool {
    matches!(s, [0x30, len, ..] if (9..=73).contains(&s.len()) && usize::from(*len) == s.len() - 3)
}

fn pubkey(s: &[u8]) -> bool {
    matches!((s.len(), s.first()), (33, Some(2 | 3)) | (65, Some(4)))
}

/// A scriptSig's pushes, read once without collecting them.
struct Pushes<'a> {
    /// No opcode but pushes, and every push complete.
    push_only: bool,
    count: usize,
    first: &'a [u8],
    second: &'a [u8],
    /// Every push after the first is a DER signature.
    rest_der: bool,
    sighash: u64,
}

/// The pushes up to the first truncated one; signatures count wherever they are.
fn pushes(script: &Script) -> Pushes<'_> {
    let mut p = Pushes {
        push_only: true,
        count: 0,
        first: &[],
        second: &[],
        rest_der: true,
        sighash: 0,
    };
    for i in script.instructions() {
        let item: &[u8] = match i {
            Ok(Instruction::PushBytes(b)) => b.as_bytes(),
            // OP_1NEGATE and OP_1 to OP_16 push a number: one byte that is no key or signature.
            Ok(Instruction::Op(op)) if matches!(op.to_u8(), 0x4f | 0x51..=0x60) => &[0x01],
            Ok(Instruction::Op(_)) => {
                p.push_only = false;
                continue;
            }
            Err(_) => {
                p.push_only = false;
                break;
            }
        };
        if der(item) {
            p.sighash |= sighash(item.last().copied());
        } else if p.count > 0 {
            p.rest_der = false;
        }
        match p.count {
            0 => p.first = item,
            1 => p.second = item,
            _ => {}
        }
        p.count += 1;
    }
    p
}

#[cfg(test)]
mod tests;
