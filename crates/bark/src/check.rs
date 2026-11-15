//! Rebuilds a VTXO's exit transactions from its anchor, and checks what a Bark server cannot fake:
//! that they spend the anchor output the node holds, hash to the id asked for, and carry valid
//! signatures.
//!
//! Each exit transaction is version 3, lock time 0, with one input at sequence 0 spending the last
//! one's output, and as outputs the siblings with ours put at its index, then the fee anchor. Our
//! output's script is not sent: it is the next transaction's spending conditions, or for the last
//! one the VTXO's policy, built here.

use bitcoin::hashes::{Hash, sha256};
use bitcoin::secp256k1::{Message, PublicKey};
use bitcoin::sighash::{Prevouts, SighashCache};
use bitcoin::taproot::{LeafVersion, TapLeafHash};
use bitcoin::transaction::Version;
use bitcoin::{
    Amount, OutPoint, ScriptBuf, Sequence, TapSighashType, Transaction, TxIn, TxOut, Txid, Witness,
    absolute,
};

use crate::decode::{Item, Policy, Transition, Unlock, Vtxo};
use crate::id::VtxoId;
use crate::keys::{self, KeyError, SECP};

/// The server's answer contradicts itself, the chain or the id: it is not shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lie(pub &'static str);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigState {
    /// Present and valid for the rebuilt transaction.
    Valid,
    /// Not there yet: Bark sends VTXOs whose leaf waits for its preimage.
    Missing,
    /// The transaction could not be rebuilt, so neither could its signature be checked.
    Unchecked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitTx {
    /// None when it could not be rebuilt.
    pub txid: Option<Txid>,
    /// What our output holds.
    pub value: Amount,
    pub signature: SigState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub vtxo: Vtxo,
    pub txs: Vec<ExitTx>,
    /// The anchor output's value: the VTXO's amount plus everything paid out along the way.
    pub anchor_value: Amount,
    /// The node holds the anchor transaction, and its output is the one the chain spends.
    pub anchored: bool,
    /// Every transaction was rebuilt and the last one's output is the id.
    pub rebuilt: bool,
    /// The anchor output commits to the expiry height and server key: its first transition is
    /// cosigned or hash-locked, whose outputs carry the expiry clause. An arkoor transition's
    /// tweak is opaque and a policy's output holds no expiry, so a chain that starts with one, or
    /// has no transactions, could carry any expiry and still check out.
    pub expiry_bound: bool,
}

impl Checked {
    /// Every signature there and valid, on a chain rebuilt whole and anchored, its expiry bound.
    pub fn all_signed(&self) -> bool {
        self.anchored
            && self.rebuilt
            && self.expiry_bound
            && self.txs.iter().all(|t| t.signature == SigState::Valid)
    }
}

fn sum_out(item: &Item) -> Option<Amount> {
    item.siblings
        .iter()
        .try_fold(item.fee, |acc, o| acc.checked_add(o.value))
}

/// The output a transition spends.
fn input_txout(t: &Transition, value: Amount, vtxo: &Vtxo) -> Result<TxOut, KeyError> {
    let server = vtxo.server_pubkey;
    let expiry = keys::timelock_sign(vtxo.expiry_height, &server);
    let info = match t {
        Transition::Cosigned { pubkeys, .. } => {
            keys::taproot(&keys::aggregate(pubkeys)?, &[expiry])?
        }
        Transition::HashLocked {
            v1,
            user_pubkey,
            unlock,
            ..
        } => {
            let agg = keys::aggregate(&[*user_pubkey, server])?;
            let unlock =
                keys::hash_sign(&unlock_hash(unlock), &agg.x_only_public_key().0, None, *v1);
            keys::taproot(&agg, &[expiry, unlock])?
        }
        Transition::Arkoor {
            cosigners,
            tap_tweak,
            ..
        } => {
            let mut all = cosigners.clone();
            all.push(server);
            let key = keys::aggregate_tweaked(&all, *tap_tweak)?;
            return Ok(TxOut {
                value,
                script_pubkey: ScriptBuf::new_p2tr_tweaked(key),
            });
        }
    };
    Ok(keys::p2tr(value, &info))
}

fn unlock_hash(u: &Unlock) -> [u8; 32] {
    match u {
        Unlock::Preimage(p) => sha256::Hash::hash(p).to_byte_array(),
        Unlock::Hash(h) => *h,
    }
}

/// The VTXO's own output, or None for a policy we do not build.
fn policy_txout(vtxo: &Vtxo) -> Result<Option<TxOut>, KeyError> {
    let server = vtxo.server_pubkey;
    let delta = vtxo.exit_delta;
    let leaves = match &vtxo.policy {
        Policy::Pubkey { user_pubkey } => vec![keys::delayed_sign(delta, user_pubkey)],
        Policy::HtlcSend {
            v1,
            user_pubkey,
            payment_hash,
            htlc_expiry,
        } => {
            let twice = delta.checked_mul(2).ok_or(KeyError)?;
            vec![
                keys::hash_sign(
                    payment_hash,
                    &server.x_only_public_key().0,
                    Some(delta),
                    *v1,
                ),
                keys::delay_timelock_sign(twice, *htlc_expiry, user_pubkey),
            ]
        }
        Policy::HtlcRecv {
            v1,
            user_pubkey,
            payment_hash,
            htlc_expiry,
            htlc_expiry_delta,
        } => {
            let wait = htlc_expiry_delta.checked_add(delta).ok_or(KeyError)?;
            vec![
                keys::delay_timelock_sign(delta, *htlc_expiry, &server),
                keys::hash_sign(
                    payment_hash,
                    &user_pubkey.x_only_public_key().0,
                    Some(wait),
                    *v1,
                ),
            ]
        }
        Policy::Other { .. } => return Ok(None),
    };
    let user = vtxo.policy.user_pubkey().ok_or(KeyError)?;
    let internal = keys::aggregate(&[user, server])?;
    Ok(Some(keys::p2tr(
        vtxo.amount,
        &keys::taproot(&internal, &leaves)?,
    )))
}

fn exit_tx(item: &Item, prev: OutPoint, ours: TxOut) -> Transaction {
    let at = usize::from(item.output_idx).min(item.siblings.len());
    let mut output = Vec::with_capacity(item.siblings.len().saturating_add(2));
    output.extend(item.siblings.iter().take(at).cloned());
    output.push(ours);
    output.extend(item.siblings.iter().skip(at).cloned());
    output.push(keys::fee_anchor(item.fee));
    Transaction {
        version: Version(3),
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: prev,
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output,
    }
}

const BAD_SIG: Lie = Lie("invalid signature");

/// Checks the transition's signature on `tx`, which spends `prev`.
fn verify(t: &Transition, tx: &Transaction, prev: &TxOut, vtxo: &Vtxo) -> Result<SigState, Lie> {
    let Some(sig) = t.signature() else {
        return Ok(SigState::Missing);
    };
    let prevouts = [prev];
    let mut cache = SighashCache::new(tx);
    let (msg, key) = match t {
        Transition::Cosigned { .. } | Transition::Arkoor { .. } => {
            let hash = cache
                .taproot_key_spend_signature_hash(
                    0,
                    &Prevouts::All(&prevouts),
                    TapSighashType::Default,
                )
                .map_err(|_| BAD_SIG)?;
            // The output key is the script's own: the 32 bytes after OP_1 PUSH32.
            let key = prev
                .script_pubkey
                .as_bytes()
                .get(2..34)
                .and_then(|k| bitcoin::secp256k1::XOnlyPublicKey::from_slice(k).ok())
                .ok_or(BAD_SIG)?;
            (Message::from_digest(hash.to_byte_array()), key)
        }
        Transition::HashLocked {
            v1,
            user_pubkey,
            unlock,
            ..
        } => {
            // The leaf can be spent only with the preimage; without it the leaf is not signed yet.
            if matches!(unlock, Unlock::Hash(_)) {
                return Ok(SigState::Missing);
            }
            let agg: PublicKey =
                keys::aggregate(&[*user_pubkey, vtxo.server_pubkey]).map_err(|_| BAD_SIG)?;
            let key = agg.x_only_public_key().0;
            let script = keys::hash_sign(&unlock_hash(unlock), &key, None, *v1);
            let leaf = TapLeafHash::from_script(&script, LeafVersion::TapScript);
            let hash = cache
                .taproot_script_spend_signature_hash(
                    0,
                    &Prevouts::All(&prevouts),
                    leaf,
                    TapSighashType::Default,
                )
                .map_err(|_| BAD_SIG)?;
            (Message::from_digest(hash.to_byte_array()), key)
        }
    };
    SECP.verify_schnorr(sig, &msg, &key).map_err(|_| BAD_SIG)?;
    Ok(SigState::Valid)
}

/// Checks `vtxo`, which the server sent for `id`, against `anchor`: the anchor transaction's
/// output as the node holds it, or None when the node does not know the transaction.
pub fn check(vtxo: Vtxo, id: VtxoId, anchor: Option<&TxOut>) -> Result<Checked, Lie> {
    if vtxo.point != id.0 {
        return Err(Lie("not the vtxo asked for"));
    }
    let anchor_value = vtxo
        .items
        .iter()
        .try_fold(vtxo.amount, |acc, i| acc.checked_add(sum_out(i)?))
        .ok_or(Lie("amounts overflow"))?;
    let unbuildable = Lie("keys do not combine");
    let own = policy_txout(&vtxo).map_err(|_| unbuildable)?;

    let Some(first) = vtxo.items.first() else {
        // The VTXO is the anchor output itself.
        let rebuilt = own.is_some();
        if let (Some(own), Some(a)) = (&own, anchor)
            && own != a
        {
            return Err(Lie("anchor output does not match"));
        }
        return Ok(Checked {
            anchored: anchor.is_some() && rebuilt,
            rebuilt,
            expiry_bound: false,
            anchor_value,
            txs: Vec::new(),
            vtxo,
        });
    };

    let expected = input_txout(&first.transition, anchor_value, &vtxo).map_err(|_| unbuildable)?;
    if let Some(a) = anchor
        && *a != expected
    {
        return Err(Lie("anchor output does not match"));
    }

    let mut txs = Vec::with_capacity(vtxo.items.len());
    let mut prev = (vtxo.anchor, expected);
    let mut value = anchor_value;
    let mut rebuilt = true;
    for (i, item) in vtxo.items.iter().enumerate() {
        value = value
            .checked_sub(sum_out(item).ok_or(Lie("amounts overflow"))?)
            .ok_or(Lie("outputs exceed input"))?;
        let ours = match vtxo.items.get(i.saturating_add(1)) {
            Some(next) => {
                Some(input_txout(&next.transition, value, &vtxo).map_err(|_| unbuildable)?)
            }
            None => own.clone(),
        };
        let Some(ours) = ours else {
            rebuilt = false;
            txs.push(ExitTx {
                txid: None,
                value,
                signature: SigState::Unchecked,
            });
            break;
        };
        let tx = exit_tx(item, prev.0, ours.clone());
        let signature = verify(&item.transition, &tx, &prev.1, &vtxo)?;
        let txid = tx.compute_txid();
        txs.push(ExitTx {
            txid: Some(txid),
            value,
            signature,
        });
        prev = (
            OutPoint {
                txid,
                vout: u32::from(item.output_idx),
            },
            ours,
        );
    }
    if rebuilt && prev.0 != vtxo.point {
        return Err(Lie("exit chain does not lead to the id"));
    }
    Ok(Checked {
        anchored: anchor.is_some(),
        rebuilt,
        expiry_bound: !matches!(first.transition, Transition::Arkoor { .. }),
        anchor_value,
        txs,
        vtxo,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
pub(crate) mod tests {
    use super::*;
    use crate::decode::decode;
    use bitcoin::consensus::deserialize;
    use bitcoin::hex::FromHex;

    pub(crate) struct Set {
        pub anchor_tx: Transaction,
        pub round_tx: Transaction,
        /// Name and bytes, in the file's order.
        pub vtxos: Vec<(String, Vec<u8>)>,
    }

    /// ark-lib 0.8.1's vectors (fixtures/bark), version 2 then version 1.
    pub(crate) fn vectors() -> Vec<(u16, Set)> {
        let text = include_str!("../../../fixtures/bark/vectors.json");
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        [(2, "v2"), (1, "v1")]
            .into_iter()
            .map(|(v, key)| {
                let m = json[key].as_object().unwrap();
                let bytes = |k: &str| Vec::<u8>::from_hex(m[k].as_str().unwrap()).unwrap();
                let vtxos = m
                    .keys()
                    .filter(|k| k.ends_with("_vtxo"))
                    .map(|k| (k.clone(), bytes(k)))
                    .collect();
                let set = Set {
                    anchor_tx: deserialize(&bytes("anchor_tx")).unwrap(),
                    round_tx: deserialize(&bytes("round_tx")).unwrap(),
                    vtxos,
                };
                (v, set)
            })
            .collect()
    }

    pub(crate) fn named<'a>(set: &'a Set, name: &str) -> &'a [u8] {
        &set.vtxos.iter().find(|(n, _)| n == name).unwrap().1
    }

    fn anchor_of<'a>(set: &'a Set, v: &Vtxo) -> &'a TxOut {
        let tx = if v.anchor.txid == set.anchor_tx.compute_txid() {
            &set.anchor_tx
        } else {
            &set.round_tx
        };
        &tx.output[v.anchor.vout as usize]
    }

    #[test]
    fn every_vector_checks_out() {
        for (version, set) in vectors() {
            for (name, bytes) in &set.vtxos {
                let v = decode(bytes).unwrap();
                let id = VtxoId(v.point);
                let anchor = anchor_of(&set, &v).clone();
                let c = check(v, id, Some(&anchor))
                    .unwrap_or_else(|e| panic!("{version} {name}: {e:?}"));
                assert!(c.rebuilt && c.anchored, "{name}");
                assert_eq!(c.anchor_value, anchor.value, "{name}");
                // The round vectors' leaves carry their preimage and signature like the rest.
                assert!(c.all_signed(), "{version} {name}: {:?}", c.txs);
            }
        }
    }

    #[test]
    fn a_vtxo_for_another_id_is_refused() {
        let (_, set) = &vectors()[0];
        let v = decode(named(set, "board_vtxo")).unwrap();
        let mut other = v.point;
        other.vout += 1;
        assert_eq!(
            check(v, VtxoId(other), None),
            Err(Lie("not the vtxo asked for"))
        );
    }

    #[test]
    fn a_different_anchor_is_refused() {
        let (_, set) = &vectors()[0];
        let v = decode(named(set, "board_vtxo")).unwrap();
        let mut anchor = anchor_of(set, &v).clone();
        anchor.value += Amount::from_sat(1);
        let id = VtxoId(v.point);
        assert_eq!(
            check(v, id, Some(&anchor)),
            Err(Lie("anchor output does not match"))
        );
    }

    #[test]
    fn without_the_node_it_is_not_anchored() {
        let (_, set) = &vectors()[0];
        let v = decode(named(set, "arkoor3_vtxo")).unwrap();
        let c = check(v.clone(), VtxoId(v.point), None).unwrap();
        assert!(c.rebuilt && !c.anchored && !c.all_signed());
    }

    /// Changing any field the chain commits to breaks it: an amount, a sibling, a fee, a
    /// signature, the point.
    #[test]
    fn tampering_is_caught() {
        for (_, set) in vectors() {
            for (name, bytes) in &set.vtxos {
                let good = decode(bytes).unwrap();
                let anchor = anchor_of(&set, &good).clone();
                let id = VtxoId(good.point);
                let mut tampered = Vec::new();

                let mut v = good.clone();
                v.amount += Amount::from_sat(1);
                tampered.push(("amount", v));

                let mut v = good.clone();
                v.expiry_height += 1;
                tampered.push(("expiry", v));

                let mut v = good.clone();
                v.exit_delta += 1;
                tampered.push(("exit delta", v));

                if let Some(item) = good.items.iter().position(|i| !i.siblings.is_empty()) {
                    let mut v = good.clone();
                    v.items[item].siblings[0].value += Amount::from_sat(1);
                    tampered.push(("sibling value", v));
                    let mut v = good.clone();
                    v.items[item].siblings[0].script_pubkey = ScriptBuf::from_bytes(vec![0x6a]);
                    tampered.push(("sibling script", v));
                }

                let mut v = good.clone();
                let last = v.items.len() - 1;
                v.items[last].fee += Amount::from_sat(1);
                v.amount -= Amount::from_sat(1);
                tampered.push(("fee", v));

                let mut v = good.clone();
                let sig = match &mut v.items[0].transition {
                    Transition::Cosigned { signature, .. }
                    | Transition::Arkoor { signature, .. }
                    | Transition::HashLocked { signature, .. } => signature,
                };
                let mut raw = sig.unwrap().serialize();
                raw[63] ^= 1;
                *sig = Some(bitcoin::secp256k1::schnorr::Signature::from_slice(&raw).unwrap());
                tampered.push(("signature", v));

                for (what, v) in tampered {
                    assert!(
                        check(v, id, Some(&anchor)).is_err(),
                        "{name}: {what} passed"
                    );
                }
            }
        }
    }

    /// A server can restate a cosigned first transition as arkoor, the server's key left out of
    /// the cosigners and the taproot tweak given as is: the same output key and signature, so the
    /// chain still checks out, but nothing then binds the expiry. It must not read as verified.
    #[test]
    fn an_expiry_nothing_commits_to_is_not_verified() {
        let (_, set) = &vectors()[0];
        let good = decode(named(set, "board_vtxo")).unwrap();
        let anchor = anchor_of(set, &good).clone();
        let id = VtxoId(good.point);
        let Transition::Cosigned { pubkeys, signature } = good.items[0].transition.clone() else {
            unreachable!()
        };
        let server = good.server_pubkey;
        let expiry = keys::timelock_sign(good.expiry_height, &server);
        let tweak = keys::taproot(&keys::aggregate(&pubkeys).unwrap(), &[expiry])
            .unwrap()
            .tap_tweak()
            .to_byte_array();
        let mut forged = good.clone();
        forged.items[0].transition = Transition::Arkoor {
            cosigners: pubkeys.into_iter().filter(|k| *k != server).collect(),
            tap_tweak: tweak,
            signature,
        };
        forged.expiry_height = 400_000_000;
        let c = check(forged, id, Some(&anchor)).unwrap();
        assert!(c.rebuilt && c.anchored);
        assert!(!c.expiry_bound && !c.all_signed());
        // The honest one binds it.
        assert!(check(good, id, Some(&anchor)).unwrap().expiry_bound);
    }

    #[test]
    fn a_missing_signature_is_said() {
        let (_, set) = &vectors()[0];
        let mut v = decode(named(set, "board_vtxo")).unwrap();
        if let Transition::Cosigned { signature, .. } = &mut v.items[0].transition {
            *signature = None;
        }
        let anchor = anchor_of(set, &v).clone();
        let c = check(v.clone(), VtxoId(v.point), Some(&anchor)).unwrap();
        assert_eq!(c.txs[0].signature, SigState::Missing);
        assert!(!c.all_signed());
    }

    #[test]
    fn an_unknown_policy_shows_what_it_can() {
        let (_, set) = &vectors()[0];
        let mut v = decode(named(set, "arkoor2_vtxo")).unwrap();
        v.policy = Policy::Other { type_byte: 0x07 };
        let anchor = anchor_of(set, &v).clone();
        let c = check(v.clone(), VtxoId(v.point), Some(&anchor)).unwrap();
        assert!(!c.rebuilt && !c.all_signed());
        assert!(c.txs.last().unwrap().txid.is_none());
        assert!(c.txs[0].txid.is_some());
    }
}
