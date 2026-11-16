//! `POST /app/decode`: what a pasted payment string is, on any network (docs/API.md, "Decoding").
//! Server-wide, like `/app/config`. The string comes in the body, so it is in no URL and no log
//! line (the request event names the route only); nothing is fetched for it, and the answer is
//! never kept. Lightning kinds are read by `ln::decode`, Ark addresses by `arkade` and `bark`;
//! this file only picks one, names keys the matching network's graph knows, and writes the answer.

use std::sync::Arc;

use axum::Extension;
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bitcoin::hex::DisplayHex;
use ln::decode::{Decoded, Failure};
use serde_json::{Value, json};

use crate::limits::{Client, Clients};
use crate::{ApiError, Network, NetworkContext};

/// The largest body read: twice the 4,296 characters a QR code can hold, so anything a camera can
/// scan fits, the longest BOLT 11 route hints and BOLT 12 blinded paths included.
pub const MAX_BODY: usize = 8 * 1024;
/// Decodes one client may start: a burst, then a steady rate. A decode is at most a signature
/// recovery and a parse of 8 KiB, well under a millisecond.
pub const CLIENT_BURST: u32 = 30;
pub const CLIENT_PER_SEC: f64 = 2.0;

const TOO_LONG: ApiError = ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too long");
const UNRECOGNISED: ApiError = ApiError::bad_request("not recognised");
const CHECKSUM: ApiError = ApiError::bad_request("bad checksum");
const SIGNATURE: ApiError = ApiError::bad_request("bad signature");
const MALFORMED: ApiError = ApiError::bad_request("malformed");

/// The route's state: every enabled network, for their graphs, and its own per-client budget.
#[derive(Debug)]
pub struct Decoder {
    networks: Vec<Arc<NetworkContext>>,
    clients: Arc<Clients>,
}

impl Decoder {
    pub fn new(networks: Vec<Arc<NetworkContext>>, max_tracked_clients: usize) -> Self {
        Self {
            networks,
            clients: Clients::with_rate(CLIENT_PER_SEC, CLIENT_BURST, max_tracked_clients),
        }
    }
}

pub async fn route(
    State(d): State<Arc<Decoder>>,
    Extension(client): Extension<Client>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(b) if b.len() <= MAX_BODY => b,
        Ok(_) => return TOO_LONG.into_response(),
        Err(r) if r.status() == StatusCode::PAYLOAD_TOO_LARGE => return TOO_LONG.into_response(),
        Err(_) => return UNRECOGNISED.into_response(),
    };
    if let Err(refused) = d.clients.take(client.addr) {
        return refused.into_response();
    }
    let answer = match std::str::from_utf8(&body) {
        Ok(text) => decode(&d.networks, text.trim()),
        Err(_) => Err(UNRECOGNISED),
    };
    match answer {
        Ok(v) => {
            let mut res = Json(v).into_response();
            // The answer repeats a string its sender may want private: no cache keeps it.
            res.headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            res
        }
        Err(e) => e.into_response(),
    }
}

/// The answer for a trimmed string: its kind, network and fields, and `names`, the network of
/// this server whose graph named its keys (`null` when none could).
pub fn decode(networks: &[Arc<NetworkContext>], s: &str) -> Result<Value, ApiError> {
    let prefix = |p: &str| s.get(..p.len()).is_some_and(|h| h.eq_ignore_ascii_case(p));
    if prefix("ark1") || prefix("tark1") {
        return ark(s);
    }
    let mut decoded = ln::decode::decode(s).map_err(|e| match e {
        Failure::Unrecognised => UNRECOGNISED,
        Failure::Checksum => CHECKSUM,
        Failure::Signature => SIGNATURE,
        Failure::Malformed => MALFORMED,
    })?;
    let names = name(networks, &mut decoded);
    let mut v = serde_json::to_value(&decoded).map_err(|_| ApiError::INTERNAL)?;
    if let Some(map) = v.as_object_mut() {
        map.insert("names".into(), json!(names.map(Network::name)));
    }
    Ok(v)
}

/// Names the keys from the graph of the network the string names, when this server has it with
/// Lightning on and indexed. `lntb` is testnet 3 or 4: only testnet4 can be ours.
fn name(networks: &[Arc<NetworkContext>], decoded: &mut Decoded) -> Option<Network> {
    let network = match decoded.network()? {
        "mainnet" => Network::Mainnet,
        "testnet" | "testnet4" => Network::Testnet4,
        "signet" => Network::Signet,
        "regtest" => Network::Regtest,
        _ => return None,
    };
    let ctx = networks.iter().find(|c| c.config.network == network)?;
    let index = ctx.lightning.as_ref()?.index()?;
    decoded.name(
        &|id| index.node(id).map(|n| n.alias().map(str::to_owned)),
        &|scid| index.channel(scid).is_some(),
    );
    Some(network)
}

fn ark(s: &str) -> Result<Value, ApiError> {
    use arkade::{AddressError, AnyAddress};
    let (mainnet, address) = arkade::parse_any(s).map_err(|e| match e {
        AddressError::Checksum => CHECKSUM,
        _ => MALFORMED,
    })?;
    // `tark` is every test network alike.
    let network = if mainnet { "mainnet" } else { "test" };
    Ok(match address {
        AnyAddress::Arkade(a) => json!({
            "kind": "ark_address", "implementation": "arkade", "network": network, "names": null,
            "server_key": a.server_key.to_lower_hex_string(),
            "p2tr_key": a.p2tr_key.to_lower_hex_string(),
            "script": a.script_hex(),
        }),
        AnyAddress::Bark(payload) => {
            let b = bark::address(&payload).map_err(|_| MALFORMED)?;
            let delivery: Vec<Value> = b
                .delivery
                .iter()
                .map(|d| match d {
                    bark::Delivery::Builtin => json!({ "kind": "server" }),
                    bark::Delivery::Mailbox(id) => {
                        json!({ "kind": "mailbox", "id": id.to_lower_hex_string() })
                    }
                    bark::Delivery::Other(t) => json!({ "kind": "other", "type": t }),
                })
                .collect();
            json!({
                "kind": "ark_address", "implementation": "bark", "network": network, "names": null,
                "ark_id": b.ark_id.to_lower_hex_string(),
                "policy": b.policy.bark_name(),
                "user_key": b.policy.user_pubkey().map(|k| k.to_string()),
                "delivery": delivery,
            })
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn ark_addresses_on_both_prefixes() {
        let signet = "tark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqnrjdp6x";
        let v = decode(&[], signet).unwrap();
        assert_eq!(v["kind"], "ark_address");
        assert_eq!(v["implementation"], "arkade");
        assert_eq!(v["network"], "test");
        assert_eq!(
            v["script"],
            "5120679eb02033f3fa5b7c8e1c00679f0d3f8966a62f0c8bca7d78462e6df1ed1813"
        );
        let main = "ark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqn9qxkrw";
        assert_eq!(
            decode(&[], &main.to_uppercase()).unwrap()["network"],
            "mainnet"
        );
        let typo = signet.replacen("qz9l", "qz8l", 1);
        assert_eq!(decode(&[], &typo).unwrap_err(), CHECKSUM);
        let bark = "ark1pndckx4ezqqp4cn00sj5cswh7vrhh9vm647qr3ht5a57s4vdp7vrpptxv66x3ehfzqyp4cn00sj5cswh7vrhh9vm647qr3ht5a57s4vdp7vrpptxv66x3ehgjdr0q7";
        let v = decode(&[], bark).unwrap();
        assert_eq!(v["implementation"], "bark");
        assert_eq!(v["network"], "mainnet");
        assert_eq!(v["policy"], "pubkey");
        assert_eq!(
            v["user_key"],
            "035c4def84a9883afe60ef72b37aaf8038dd74ed3d0ab1a1f30610acccd68d1cdd"
        );
        assert_eq!(v["delivery"][0]["kind"], "mailbox");
    }

    #[test]
    fn typed_reasons() {
        assert_eq!(decode(&[], "hello").unwrap_err(), UNRECOGNISED);
        assert_eq!(decode(&[], "satoshi@bitcoin").unwrap_err(), MALFORMED);
        let lnurl = "LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNT";
        assert_eq!(decode(&[], lnurl).unwrap_err(), CHECKSUM);
        let v = decode(&[], "satoshi@bitcoin.org").unwrap();
        assert_eq!(v["names"], Value::Null);
    }

    const ANSWERS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/decode/answers.json"
    );

    /// One answer of each kind, which the frontend's tests and browser tests read. The invoice is
    /// named as a graph that knows its first hint would name it. `DECODE_RECORD=1` writes it again.
    #[test]
    fn the_recorded_answers_are_ours() {
        let spec: Value =
            serde_json::from_str(include_str!("../../../fixtures/decode/bolt11.json")).unwrap();
        let hints = spec["valid"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| {
                c["comment"]
                    .as_str()
                    .unwrap()
                    .contains("extra routing info")
            })
            .unwrap()["string"]
            .as_str()
            .unwrap();
        let mut invoice = ln::decode::decode(hints).unwrap();
        invoice.name(
            &|id| (id[0] == 2).then(|| Some("Hint <b>one</b>".to_owned())),
            &|scid| scid == (66_051 << 40 | 263_430 << 16 | 1800),
        );
        let mut invoice = serde_json::to_value(&invoice).unwrap();
        invoice["names"] = json!("mainnet");
        let offers: Value =
            serde_json::from_str(include_str!("../../../fixtures/decode/offers-test.json"))
                .unwrap();
        let offer = |start: &str| {
            let s = offers
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["description"].as_str().unwrap().starts_with(start))
                .unwrap()["bolt12"]
                .as_str()
                .unwrap();
            decode(&[], s).unwrap()
        };
        let answers = json!({
            "bolt11": invoice,
            "bolt11_plain": decode(&[], spec["valid"][0]["string"].as_str().unwrap()).unwrap(),
            "offer": offer("... and with second blinded path"),
            "offer_currency": offer("with currency"),
            "lnurl": decode(&[], "LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS").unwrap(),
            "lnurl_withdraw": decode(&[], "lnurlw://sats.example/w?tag=withdrawRequest&k1=ab12").unwrap(),
            "lightning_address": decode(&[], "satoshi@bitcoin.org").unwrap(),
            "arkade": decode(&[], "tark1qz9l2ctqalrkjyftxcw7gytm83cm3r9pdudmna4v0gncry56h30x5eu7kqsr8ul6td7gu8qqv70s60ufv6nz7rytef7hs33wdhc76xqnrjdp6x").unwrap(),
            "bark": decode(&[], "ark1pndckx4ezqqp4cn00sj5cswh7vrhh9vm647qr3ht5a57s4vdp7vrpptxv66x3ehfzqyp4cn00sj5cswh7vrhh9vm647qr3ht5a57s4vdp7vrpptxv66x3ehgjdr0q7").unwrap(),
        });
        let text = serde_json::to_string_pretty(&answers).unwrap() + "\n";
        if std::env::var_os("DECODE_RECORD").is_some() {
            std::fs::write(ANSWERS, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(ANSWERS).unwrap(), text);
    }
}
