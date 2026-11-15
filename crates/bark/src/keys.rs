//! The keys and scripts Bark's outputs are built from: MuSig2 key aggregation (BIP 327, keys
//! sorted first, as Bark does), its tapscripts, and the taproot outputs they make.

use std::sync::LazyLock;

use bitcoin::hashes::{Hash, HashEngine, ripemd160, sha256};
use bitcoin::key::TweakedPublicKey;
use bitcoin::opcodes::all::{
    OP_CHECKSIG, OP_CLTV, OP_CSV, OP_DROP, OP_EQUALVERIFY, OP_HASH160, OP_SIZE,
};
use bitcoin::secp256k1::{PublicKey, Scalar, Secp256k1, VerifyOnly, XOnlyPublicKey};
use bitcoin::taproot::{TaprootBuilder, TaprootSpendInfo};
use bitcoin::{Amount, Script, ScriptBuf, TxOut};

pub static SECP: LazyLock<Secp256k1<VerifyOnly>> = LazyLock::new(Secp256k1::verification_only);

/// A key or script that cannot be built from what the server sent: a sum at infinity, a
/// coefficient out of range. Real VTXOs never hit it; a forged one can.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyError;

fn tagged(tag: &str, parts: &[&[u8]]) -> [u8; 32] {
    let t = sha256::Hash::hash(tag.as_bytes());
    let mut e = sha256::Hash::engine();
    e.input(t.as_byte_array());
    e.input(t.as_byte_array());
    for p in parts {
        e.input(p);
    }
    sha256::Hash::from_engine(e).to_byte_array()
}

/// The aggregate key of `keys`, in any order (BIP 327 KeyAgg over the sorted list).
pub fn aggregate(keys: &[PublicKey]) -> Result<PublicKey, KeyError> {
    let mut sorted: Vec<[u8; 33]> = keys.iter().map(PublicKey::serialize).collect();
    sorted.sort_unstable();
    key_agg(&sorted)
}

/// BIP 327 KeyAgg over the keys in the order given.
fn key_agg(sorted: &[[u8; 33]]) -> Result<PublicKey, KeyError> {
    let list: Vec<u8> = sorted.concat();
    let l = tagged("KeyAgg list", &[&list]);
    let first = sorted.first().ok_or(KeyError)?;
    let second = sorted.iter().find(|k| *k != first);
    let mut terms = Vec::with_capacity(sorted.len());
    for k in sorted {
        let p = PublicKey::from_slice(k).map_err(|_| KeyError)?;
        if Some(k) == second {
            terms.push(p);
            continue;
        }
        let a = tagged("KeyAgg coefficient", &[&l, k]);
        let a = Scalar::from_be_bytes(a).map_err(|_| KeyError)?;
        terms.push(p.mul_tweak(&*SECP, &a).map_err(|_| KeyError)?);
    }
    let refs: Vec<&PublicKey> = terms.iter().collect();
    PublicKey::combine_keys(&refs).map_err(|_| KeyError)
}

fn xonly(k: &PublicKey) -> XOnlyPublicKey {
    k.x_only_public_key().0
}

/// The aggregate of `keys` with an x-only tweak added, as an arkoor transfer's output key.
pub fn aggregate_tweaked(
    keys: &[PublicKey],
    tweak: [u8; 32],
) -> Result<TweakedPublicKey, KeyError> {
    let q = xonly(&aggregate(keys)?);
    let t = Scalar::from_be_bytes(tweak).map_err(|_| KeyError)?;
    let (out, _) = q.add_tweak(&*SECP, &t).map_err(|_| KeyError)?;
    Ok(TweakedPublicKey::dangerous_assume_tweaked(out))
}

fn int(n: u32) -> i64 {
    i64::from(n)
}

/// `<delta> CSV DROP <key> CHECKSIG`
pub fn delayed_sign(delta: u16, key: &PublicKey) -> ScriptBuf {
    Script::builder()
        .push_int(int(delta.into()))
        .push_opcode(OP_CSV)
        .push_opcode(OP_DROP)
        .push_x_only_key(&xonly(key))
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

/// `<height> CLTV DROP <key> CHECKSIG`
pub fn timelock_sign(height: u32, key: &PublicKey) -> ScriptBuf {
    Script::builder()
        .push_int(int(height))
        .push_opcode(OP_CLTV)
        .push_opcode(OP_DROP)
        .push_x_only_key(&xonly(key))
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

/// `<height> CLTV DROP <delta> CSV DROP <key> CHECKSIG`
pub fn delay_timelock_sign(delta: u16, height: u32, key: &PublicKey) -> ScriptBuf {
    Script::builder()
        .push_int(int(height))
        .push_opcode(OP_CLTV)
        .push_opcode(OP_DROP)
        .push_int(int(delta.into()))
        .push_opcode(OP_CSV)
        .push_opcode(OP_DROP)
        .push_x_only_key(&xonly(key))
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

/// `[<delta> CSV DROP] [SIZE 32 EQUALVERIFY] HASH160 <h160(hash)> EQUALVERIFY <key> CHECKSIG`.
/// `sized` is the current form; the first one did not check the preimage's size.
pub fn hash_sign(
    hash: &[u8; 32],
    key: &XOnlyPublicKey,
    delta: Option<u16>,
    sized: bool,
) -> ScriptBuf {
    // OP_HASH160 of the preimage is RIPEMD160 of its SHA-256, which `hash` already is.
    let h160 = ripemd160::Hash::hash(hash).to_byte_array();
    let mut b = Script::builder();
    if let Some(d) = delta {
        b = b
            .push_int(int(d.into()))
            .push_opcode(OP_CSV)
            .push_opcode(OP_DROP);
    }
    if sized {
        b = b
            .push_opcode(OP_SIZE)
            .push_int(32)
            .push_opcode(OP_EQUALVERIFY);
    }
    b.push_opcode(OP_HASH160)
        .push_slice(h160)
        .push_opcode(OP_EQUALVERIFY)
        .push_x_only_key(key)
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

/// A taproot with `internal` as its key and the scripts as leaves: one at depth 0, two at depth 1.
pub fn taproot(internal: &PublicKey, leaves: &[ScriptBuf]) -> Result<TaprootSpendInfo, KeyError> {
    let depth = if leaves.len() == 1 { 0 } else { 1 };
    let mut b = TaprootBuilder::new();
    for leaf in leaves {
        b = b.add_leaf(depth, leaf.clone()).map_err(|_| KeyError)?;
    }
    b.finalize(&*SECP, xonly(internal)).map_err(|_| KeyError)
}

pub fn p2tr(value: Amount, info: &TaprootSpendInfo) -> TxOut {
    TxOut {
        value,
        script_pubkey: ScriptBuf::new_p2tr_tweaked(info.output_key()),
    }
}

/// The pay-to-anchor output every exit transaction ends with, holding its fee.
pub fn fee_anchor(value: Amount) -> TxOut {
    TxOut {
        value,
        script_pubkey: ScriptBuf::from_bytes(vec![0x51, 0x02, 0x4e, 0x73]),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn pk(s: &str) -> PublicKey {
        PublicKey::from_str(s).unwrap()
    }

    /// BIP 327's key aggregation vectors, which aggregate in the order given.
    #[test]
    fn bip327_key_agg() {
        let x = [
            "02F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9",
            "03DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
            "023590A94E768F8E1815C2F24B4D80A8E3149316C3518CE7B7AD338368D038CA66",
        ]
        .map(|s| pk(s).serialize());
        let agg = |idx: &[usize]| {
            let keys: Vec<[u8; 33]> = idx.iter().map(|i| x[*i]).collect();
            xonly(&key_agg(&keys).unwrap()).to_string().to_uppercase()
        };
        assert_eq!(
            agg(&[0, 1, 2]),
            "90539EEDE565F5D054F32CC0C220126889ED1E5D193BAF15AEF344FE59D4610C"
        );
        assert_eq!(
            agg(&[2, 1, 0]),
            "6204DE8B083426DC6EAF9502D27024D53FC826BF7D2012148A0575435DF54B2B"
        );
        assert_eq!(
            agg(&[0, 0, 0]),
            "B436E3BAD62B8CD409969A224731C193D051162D8C5AE8B109306127DA3AA935"
        );
        assert_eq!(
            agg(&[0, 0, 1, 1]),
            "69BC22BFA5D106306E48A20679DE1D7389386124D07571D0D872686028C26A3E"
        );
        // Bark sorts first, so order never matters to it.
        let keys = x.map(|k| PublicKey::from_slice(&k).unwrap());
        assert_eq!(aggregate(&keys), aggregate(&[keys[2], keys[0], keys[1]]));
        assert_eq!(aggregate(&[]), Err(KeyError));
    }

    #[test]
    fn scripts_have_bark_shapes() {
        let k = pk("02F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9");
        assert_eq!(delayed_sign(144, &k).len(), 3 + 2 + 33 + 1);
        assert_eq!(hash_sign(&[0; 32], &xonly(&k), None, false).len(), 57);
        assert_eq!(
            fee_anchor(Amount::ZERO).script_pubkey.as_bytes(),
            &[0x51, 0x02, 0x4e, 0x73]
        );
    }
}
