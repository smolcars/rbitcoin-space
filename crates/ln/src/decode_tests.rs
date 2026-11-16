#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use super::*;
use lightning::bitcoin::bech32::{self, Bech32, Hrp};
use serde_json::Value;

fn vectors(file: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/decode/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn json(d: &Decoded) -> Value {
    serde_json::to_value(d).unwrap()
}

#[test]
fn every_valid_bolt11_example_decodes() {
    let v = vectors("bolt11.json");
    for case in v["valid"].as_array().unwrap() {
        let s = case["string"].as_str().unwrap();
        let d = decode(s).unwrap_or_else(|e| panic!("{}: {e:?}", case["comment"]));
        assert!(matches!(d, Decoded::Bolt11(_)), "{}", case["comment"]);
    }
}

#[test]
fn every_invalid_bolt11_example_is_refused_with_its_reason() {
    let v = vectors("bolt11.json");
    let mut reasons = Vec::new();
    for case in v["invalid"].as_array().unwrap() {
        let s = case["string"].as_str().unwrap();
        let comment = case["comment"].as_str().unwrap();
        // LDK skips an `n` of the wrong length, as BOLT 11 tells a reader to, and recovers the key.
        if comment.contains("`n` field of invalid length") {
            assert!(decode(s).is_ok());
            continue;
        }
        reasons.push((comment.to_owned(), decode(s).expect_err(comment)));
    }
    let reason = |c: &str| reasons.iter().find(|(k, _)| k.starts_with(c)).unwrap().1;
    assert_eq!(reason("Bech32 checksum is invalid"), Failure::Checksum);
    assert_eq!(reason("Signature is not recoverable"), Failure::Signature);
    assert_eq!(
        reason("Malformed bech32 string (no 1)"),
        Failure::Unrecognised
    );
    assert_eq!(reason("Missing required `p`"), Failure::Malformed);
    assert_eq!(reason("Invalid multiplier"), Failure::Malformed);
}

#[test]
fn reads_an_invoice_with_hints_and_a_fallback() {
    let v = vectors("bolt11.json");
    let case = v["valid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["comment"]
                .as_str()
                .unwrap()
                .contains("extra routing info")
        })
        .unwrap();
    let d = decode(case["string"].as_str().unwrap()).unwrap();
    let j = json(&d);
    assert_eq!(j["kind"], "bolt11");
    assert_eq!(j["network"], "mainnet");
    assert_eq!(j["amount_msat"], 2_000_000_000);
    assert_eq!(
        j["payee"]["key"],
        "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad"
    );
    assert_eq!(j["payee_named"], false);
    assert_eq!(j["payee"]["known"], Value::Null);
    assert_eq!(j["fallbacks"][0], "1RustyRX2oai4EYYDpQGWvEL62BBGqN9T");
    let hops = j["hints"][0].as_array().unwrap();
    assert_eq!(hops.len(), 2);
    assert_eq!(
        hops[0]["node"]["key"],
        "029e03a901b85534ff1e92c43c74431f7ce72046060fcf7a95c37e148f78c77255"
    );
    assert_eq!(hops[0]["channel"]["scid"], "66051x263430x1800");
    assert_eq!(hops[0]["base_fee_msat"], 1);
    assert_eq!(hops[0]["fee_ppm"], 20);
    assert_eq!(hops[0]["cltv_delta"], 3);
    assert_eq!(j["description_hash"].as_str().unwrap().len(), 64);
    assert_eq!(j["description"], Value::Null);
}

#[test]
fn reads_the_first_example_and_its_features() {
    let v = vectors("bolt11.json");
    let first = v["valid"][0]["string"].as_str().unwrap();
    let j = json(&decode(first).unwrap());
    assert_eq!(j["description"], "Please consider supporting this project");
    assert_eq!(j["amount_msat"], Value::Null);
    assert_eq!(j["created"], 1_496_314_658);
    assert_eq!(j["expiry"], 3600);
    assert_eq!(j["min_final_cltv"], 18);
    assert_eq!(
        j["payment_hash"],
        "0001020304050607080900010203040506070809000102030405060708090102"
    );
    let names: Vec<&str> = j["features"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["name"].as_str())
        .collect();
    assert_eq!(names, ["var_onion_optin", "payment_secret"]);
}

#[test]
fn the_lightning_prefix_and_upper_case_are_accepted() {
    let v = vectors("bolt11.json");
    let first = v["valid"][0]["string"].as_str().unwrap();
    for s in [
        format!("lightning:{first}"),
        format!("LIGHTNING:{}", first.to_uppercase()),
        format!("lightning://{first}"),
    ] {
        assert!(matches!(decode(&s), Ok(Decoded::Bolt11(_))), "{s}");
    }
}

#[test]
fn testnet_says_testnet_not_a_guess() {
    let v = vectors("bolt11.json");
    let case = v["valid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["string"].as_str().unwrap().starts_with("lntb"))
        .unwrap();
    let d = decode(case["string"].as_str().unwrap()).unwrap();
    assert_eq!(d.network(), Some("testnet"));
    assert_eq!(
        json(&d)["fallbacks"][0],
        "mk2QpYatsKicvFVuTAQLBryyccRXMUaGHP"
    );
}

/// Vectors the spec marks invalid that LDK 0.2.8 parses. An unknown required feature is refused
/// when paying, not when reading; the decoder shows the bit.
const LDK_ACCEPTS: [&str; 3] = [
    "Contains unknown feature 122",
    "offer_chains with zero entries",
    "Bech32 padding exceeds 4-bit limit",
];

#[test]
fn bolt12_offer_vectors_decode_or_fail_as_the_spec_says() {
    let v = vectors("offers-test.json");
    for case in v.as_array().unwrap() {
        let s = case["bolt12"].as_str().unwrap();
        let got = decode(s);
        let leniency = LDK_ACCEPTS.contains(&case["description"].as_str().unwrap());
        if case["valid"].as_bool().unwrap() || leniency {
            assert!(
                matches!(got, Ok(Decoded::Offer(_))),
                "{}: {got:?}",
                case["description"]
            );
        } else {
            assert!(got.is_err(), "{}", case["description"]);
        }
    }
}

#[test]
fn bolt12_format_strings() {
    let v = vectors("format-string-test.json");
    for case in v.as_array().unwrap() {
        let got = decode(case["string"].as_str().unwrap());
        assert_eq!(
            got.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["comment"]
        );
    }
}

fn offer_named(v: &Value, start: &str) -> Value {
    let case = v
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["description"].as_str().unwrap().starts_with(start))
        .unwrap();
    json(&decode(case["bolt12"].as_str().unwrap()).unwrap())
}

#[test]
fn reads_an_offers_fields() {
    let v = vectors("offers-test.json");
    let minimal = offer_named(&v, "Minimal");
    assert_eq!(minimal["kind"], "offer");
    assert_eq!(minimal["network"], "mainnet");
    assert_eq!(minimal["chains"][0], "mainnet");
    assert_eq!(minimal["quantity"], "one");
    assert!(minimal["signing_key"]["key"].as_str().unwrap().len() == 66);

    assert_eq!(offer_named(&v, "for testnet")["network"], "testnet3");
    let liquid = offer_named(&v, "for bitcoin or liquidv1");
    assert_eq!(liquid["network"], "mainnet");
    assert_eq!(liquid["chains"].as_array().unwrap().len(), 2);
    assert_eq!(offer_named(&v, "with amount")["amount"]["msat"], 10_000);
    let unknown = offer_named(&v, "Contains unknown feature 122")["features"].clone();
    assert_eq!(unknown[0]["bit"], 122);
    assert_eq!(unknown[0]["required"], true);
    let currency = offer_named(&v, "with currency")["amount"].clone();
    assert_eq!(currency["currency"], "USD");
    assert_eq!(currency["amount"], 10_000);
    assert_eq!(
        offer_named(&v, "with issuer")["issuer"],
        "https://bolt12.org BOLT12 industries"
    );
    assert_eq!(offer_named(&v, "with quantity")["quantity"], 5);
    assert_eq!(offer_named(&v, "with unlimited")["quantity"], "any");
    assert_eq!(offer_named(&v, "with expiry")["expires"], 2_051_184_600);

    let path = offer_named(&v, "with blinded path via Bob");
    assert_eq!(
        path["paths"][0]["node"]["key"],
        "0324653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c"
    );
    assert_eq!(path["paths"][0]["hops"], 2);
    let sciddir = offer_named(&v, "same, with blinded path first_node_id using sciddir");
    assert_eq!(sciddir["paths"][0]["channel"]["scid"], "0x0x42");
    assert_eq!(sciddir["paths"][0]["direction"], 0);
    let two = offer_named(&v, "... and with second blinded path");
    assert_eq!(two["paths"][1]["channel"]["scid"], "1x2x3");
    assert_eq!(two["paths"][1]["direction"], 1);
    let no_issuer = offer_named(&v, "with no issuer_id");
    assert_eq!(no_issuer["signing_key"], Value::Null);
    assert_eq!(sciddir["paths"][0]["node"], Value::Null);
}

fn encode_lnurl(url: &str) -> String {
    bech32::encode::<Bech32>(Hrp::parse("lnurl").unwrap(), url.as_bytes())
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|_| {
            // Past bech32's 1023: the decoder's own unlimited checksum.
            bech32::encode::<LongBech32>(Hrp::parse("lnurl").unwrap(), url.as_bytes()).unwrap()
        })
}

#[test]
fn lnurl_from_lud01_in_both_cases_and_with_the_prefix() {
    let lud01 = "LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS";
    for s in [
        lud01.to_owned(),
        lud01.to_lowercase(),
        format!("lightning:{lud01}"),
    ] {
        let j = json(&decode(&s).unwrap());
        assert_eq!(j["kind"], "lnurl");
        assert_eq!(j["network"], Value::Null);
        assert_eq!(
            j["url"],
            "https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df"
        );
        assert_eq!(j["host"], "service.com");
        assert_eq!(j["form"], "bech32");
    }
    // One character changed: the checksum fails.
    let typo = lud01.replacen("DP68", "DP69", 1);
    assert_eq!(decode(&typo).unwrap_err(), Failure::Checksum);
}

#[test]
fn a_login_lnurl_reads_as_one_and_its_host_is_the_real_one() {
    let url = "https://user@SITE.example:8443/auth?tag=login&k1=e2af6254a8df433264fa23f67eb8188635d15ce883e8fc020989d5f82ae6f11e&action=login";
    let j = json(&decode(&encode_lnurl(url)).unwrap());
    assert_eq!(j["host"], "site.example");
    assert_eq!(j["tag"], "login");
    assert_eq!(
        j["k1"],
        "e2af6254a8df433264fa23f67eb8188635d15ce883e8fc020989d5f82ae6f11e"
    );
    // A long URL past bech32's usual limits still decodes.
    let long = format!("https://example.com/{}", "a".repeat(2000));
    assert_eq!(json(&decode(&encode_lnurl(&long)).unwrap())["url"], long);
    // Plain HTTP only to an onion service.
    assert_eq!(
        decode(&encode_lnurl("http://example.com/x")).unwrap_err(),
        Failure::Malformed
    );
    assert!(decode(&encode_lnurl("http://abcdef.onion/x")).is_ok());
    assert_eq!(
        decode(&encode_lnurl("javascript:alert(1)")).unwrap_err(),
        Failure::Malformed
    );
}

#[test]
fn lud17_urls() {
    let j = json(&decode("lnurlw://domain.com/path?tag=withdrawRequest&k1=ab").unwrap());
    assert_eq!(
        j["url"],
        "https://domain.com/path?tag=withdrawRequest&k1=ab"
    );
    assert_eq!(j["form"], "url");
    assert_eq!(j["tag"], "withdrawRequest");
    let j = json(&decode("lnurlp://examplennnnnnnn.onion/path").unwrap());
    assert_eq!(j["url"], "http://examplennnnnnnn.onion/path");
    let j = json(&decode("keyauth://site.com/a?k1=00").unwrap());
    assert_eq!(j["tag"], "login");
    // A query cannot make a keyauth:// link anything but a login.
    let j = json(&decode("keyauth://site.com/a?tag=payRequest&k1=00").unwrap());
    assert_eq!(j["tag"], "login");
    assert_eq!(
        decode("lnurlp://bad host/x").unwrap_err(),
        Failure::Malformed
    );
    // A backslash is a path separator to a browser: the host shown would not be the one reached.
    assert_eq!(
        decode("lnurlp://evil.example\\@trusted.example/pay").unwrap_err(),
        Failure::Malformed
    );
    assert_eq!(
        decode(&encode_lnurl("https://evil.example\\@trusted.example/pay")).unwrap_err(),
        Failure::Malformed
    );
}

#[test]
fn lightning_addresses() {
    let j = json(&decode("satoshi@bitcoin.org").unwrap());
    assert_eq!(j["kind"], "lightning_address");
    assert_eq!(j["url"], "https://bitcoin.org/.well-known/lnurlp/satoshi");
    // Odd but valid: a tag, dots and dashes, upper case from a QR code, an onion, the shorthand.
    let j = json(&decode("LIGHTNING:Sat.O-shi_+tips@Sub.Bitcoin.ORG").unwrap());
    assert_eq!(j["name"], "sat.o-shi_+tips");
    assert_eq!(j["domain"], "sub.bitcoin.org");
    let j = json(&decode("me@abcdefgh.onion").unwrap());
    assert_eq!(j["url"], "http://abcdefgh.onion/.well-known/lnurlp/me");
    assert_eq!(json(&decode("@bitcoin.org").unwrap())["name"], "_");
    for bad in [
        "satoshi@bitcoin",
        "sat oshi@bitcoin.org",
        "satoshi@-bitcoin.org",
        "satoshi@bitcoin..org",
        "sa/toshi@bitcoin.org",
        "satoshi@bitcoin.org/x",
        "a@b@c.org",
        "satoshi@bitcoin.o1",
    ] {
        assert_eq!(decode(bad).unwrap_err(), Failure::Malformed, "{bad}");
    }
}

#[test]
fn anything_else_is_unrecognised() {
    for s in [
        "",
        "hello",
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "lni1qqqq",
    ] {
        assert_eq!(decode(s).unwrap_err(), Failure::Unrecognised, "{s:?}");
    }
}

#[test]
fn naming_fills_known_nodes_and_channels() {
    let v = vectors("bolt11.json");
    let case = v["valid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["comment"]
                .as_str()
                .unwrap()
                .contains("extra routing info")
        })
        .unwrap();
    let mut d = decode(case["string"].as_str().unwrap()).unwrap();
    let known = [0x02u8, 0x9e];
    d.name(
        &|id: &[u8; 33]| (id[..2] == known).then(|| Some("Hint <b>one</b>".to_owned())),
        &|scid| scid == (66051 << 40 | 263_430 << 16 | 1800),
    );
    let j = json(&d);
    assert_eq!(j["payee"]["known"], false);
    assert_eq!(j["payee"]["alias"], Value::Null);
    assert_eq!(j["hints"][0][0]["node"]["known"], true);
    assert_eq!(j["hints"][0][0]["node"]["alias"], "Hint <b>one</b>");
    assert_eq!(j["hints"][0][0]["channel"]["known"], true);
    assert_eq!(j["hints"][0][1]["channel"]["known"], false);
}

#[test]
fn reads_a_refund() {
    use lightning::bitcoin::secp256k1::{Secp256k1, SecretKey};
    let secp = Secp256k1::new();
    let payer = PublicKey::from_secret_key(&secp, &SecretKey::from_slice(&[7; 32]).unwrap());
    let refund = refund::RefundBuilder::new(vec![1; 32], payer, 21_000)
        .unwrap()
        .description("Returned \u{202e}gnihtemos".to_owned())
        .chain(Network::Signet)
        .payer_note("thanks".to_owned())
        .build()
        .unwrap()
        .to_string();
    assert!(refund.starts_with("lnr1"));
    let j = json(&decode(&refund).unwrap());
    assert_eq!(j["kind"], "refund");
    assert_eq!(j["network"], "signet");
    assert_eq!(j["amount_msat"], 21_000);
    // A right-to-left override is a format character: LDK's printable form replaces it.
    assert_eq!(j["description"], "Returned \u{fffd}gnihtemos");
    assert_eq!(j["payer_note"], "thanks");
    assert_eq!(j["payer_key"], payer.serialize().to_lower_hex_string());
}
