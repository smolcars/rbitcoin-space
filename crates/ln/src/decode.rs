//! What a pasted Lightning payment string says: a BOLT 11 invoice, a BOLT 12 offer or refund, an
//! LNURL (LUD-01, and LUD-17's plain-URL forms) or a Lightning address (LUD-16). Pure: nothing here
//! fetches, so an LNURL or address only becomes the URL a wallet would ask (docs/API.md, "Decoding").
//!
//! The string is untrusted. BOLT 11 and BOLT 12 are parsed by LDK; every failure becomes one of a
//! few [`Failure`]s, never LDK's text. Descriptions and other free text keep LDK's printable form
//! (control characters replaced) and are served as JSON strings, never markup.

use std::str::FromStr;

use lightning::bitcoin::bech32::Checksum;
use lightning::bitcoin::bech32::primitives::decode::{
    CheckedHrpstring, CheckedHrpstringError, ChecksumError,
};
use lightning::bitcoin::hex::DisplayHex;
use lightning::bitcoin::secp256k1::PublicKey;
use lightning::bitcoin::{Network, constants::ChainHash};
use lightning::blinded_path::IntroductionNode;
use lightning::blinded_path::message::BlindedMessagePath;
use lightning::bolt11_invoice::{
    Bolt11Invoice, Bolt11InvoiceDescriptionRef, Bolt11ParseError, Bolt11SemanticError, Currency,
    ParseOrSemanticError,
};
use lightning::offers::offer::{self, Quantity};
use lightning::offers::parse::Bolt12ParseError;
use lightning::offers::refund;
use serde::Serialize;

/// Why a string was not decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Not a form this decoder knows.
    Unrecognised,
    /// A known form whose bech32 checksum does not hold: most likely mistyped.
    Checksum,
    /// A BOLT 11 invoice whose signature does not verify or recover.
    Signature,
    /// A known form that breaks its own rules.
    Malformed,
}

/// A decoded string, tagged with its kind.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Decoded {
    Bolt11(Invoice),
    Offer(Offer),
    Refund(Refund),
    Lnurl(Lnurl),
    LightningAddress(LightningAddress),
}

/// A Lightning node a string names, with what the caller's graph knows of it ([`Decoded::name`]).
#[derive(Debug, Serialize)]
pub struct Node {
    pub key: String,
    #[serde(skip)]
    pub id: [u8; 33],
    /// Its alias, when the graph knows the node and it announced one.
    pub alias: Option<String>,
    /// Whether the graph knows the node; `None` when no graph was asked.
    pub known: Option<bool>,
}

/// A channel a string names by its short id.
#[derive(Debug, Serialize)]
pub struct Channel {
    /// `<block>x<tx>x<output>`.
    pub scid: String,
    #[serde(skip)]
    pub id: u64,
    /// Whether the graph holds it as a public channel; `None` when no graph was asked.
    pub known: Option<bool>,
}

/// A feature bit an invoice sets, by its pair's name when it has one.
#[derive(Debug, Serialize)]
pub struct Feature {
    pub bit: u16,
    pub name: Option<&'static str>,
    /// An even bit: a payer that does not know it must not pay.
    pub required: bool,
}

#[derive(Debug, Serialize)]
pub struct Invoice {
    /// `mainnet`, `testnet` (testnet 3 or 4: `lntb` says no more), `signet`, `regtest` or `simnet`.
    pub network: &'static str,
    pub amount_msat: Option<u64>,
    pub description: Option<String>,
    pub description_hash: Option<String>,
    pub payee: Node,
    /// The payee is named in the invoice (`n`), not recovered from the signature.
    pub payee_named: bool,
    /// Unix seconds.
    pub created: u64,
    /// Seconds after `created`.
    pub expiry: u64,
    pub payment_hash: String,
    pub min_final_cltv: u64,
    pub features: Vec<Feature>,
    /// On-chain fallback addresses.
    pub fallbacks: Vec<String>,
    /// Route hints: each a list of hops, the payee last.
    pub hints: Vec<Vec<Hop>>,
}

#[derive(Debug, Serialize)]
pub struct Hop {
    pub node: Node,
    pub channel: Channel,
    pub base_fee_msat: u32,
    pub fee_ppm: u32,
    pub cltv_delta: u16,
}

/// A BOLT 12 price: in millisatoshis, or in an ISO 4217 currency's minor unit.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Price {
    Msat { msat: u64 },
    Currency { currency: String, amount: u64 },
}

/// How many items one payment may buy: `"one"`, `"any"`, or up to a number.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Items {
    Word(&'static str),
    Max(u64),
}

/// Where a blinded path starts: a node, or a channel and which end of it.
#[derive(Debug, Serialize)]
pub struct Path {
    pub node: Option<Node>,
    pub channel: Option<Channel>,
    pub direction: Option<u8>,
    /// Blinded hops after the entry.
    pub hops: usize,
}

#[derive(Debug, Serialize)]
pub struct Offer {
    /// The first chain it names that is a Bitcoin network; mainnet when it names none.
    pub network: Option<&'static str>,
    /// Every chain it names: a network's name, or the chain hash.
    pub chains: Vec<String>,
    pub description: Option<String>,
    pub issuer: Option<String>,
    pub amount: Option<Price>,
    pub quantity: Items,
    /// Unix seconds.
    pub expires: Option<u64>,
    pub signing_key: Option<Node>,
    pub paths: Vec<Path>,
    pub features: Vec<Feature>,
}

#[derive(Debug, Serialize)]
pub struct Refund {
    pub network: Option<&'static str>,
    pub chains: Vec<String>,
    pub description: String,
    pub issuer: Option<String>,
    pub amount_msat: u64,
    pub quantity: Option<u64>,
    pub expires: Option<u64>,
    /// The payer's key: not a node of the graph.
    pub payer_key: String,
    pub payer_note: Option<String>,
    pub paths: Vec<Path>,
}

#[derive(Debug, Serialize)]
pub struct Lnurl {
    /// LNURLs name no network.
    pub network: Option<&'static str>,
    /// `bech32` (LUD-01) or `url` (LUD-17's `lnurlp://` and kin).
    pub form: &'static str,
    pub url: String,
    /// The host, lower-cased, without user info or port: what a look-alike must imitate.
    pub host: String,
    /// The query's `tag` (`login`, `withdrawRequest`, …) and `k1`, when it carries them.
    pub tag: Option<String>,
    pub k1: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LightningAddress {
    pub network: Option<&'static str>,
    pub name: String,
    pub domain: String,
    /// What a wallet asks: `https://<domain>/.well-known/lnurlp/<name>`.
    pub url: String,
}

impl Decoded {
    /// The Bitcoin network the string names, by this crate's names; `None` for an LNURL or address.
    pub fn network(&self) -> Option<&'static str> {
        match self {
            Self::Bolt11(i) => Some(i.network),
            Self::Offer(o) => o.network,
            Self::Refund(r) => r.network,
            Self::Lnurl(_) | Self::LightningAddress(_) => None,
        }
    }

    /// Fills in what a graph knows: `node` answers `None` for a node it lacks and `Some(alias)`
    /// for one it has; `channel` whether it holds a public channel.
    pub fn name(
        &mut self,
        node: &dyn Fn(&[u8; 33]) -> Option<Option<String>>,
        channel: &dyn Fn(u64) -> bool,
    ) {
        let name_node = |n: &mut Node| {
            let found = node(&n.id);
            n.known = Some(found.is_some());
            n.alias = found.flatten();
        };
        let name_channel = |c: &mut Channel| c.known = Some(channel(c.id));
        let name_paths = |paths: &mut Vec<Path>| {
            for p in paths {
                p.node.as_mut().map(name_node);
                p.channel.as_mut().map(name_channel);
            }
        };
        match self {
            Self::Bolt11(i) => {
                name_node(&mut i.payee);
                for hop in i.hints.iter_mut().flatten() {
                    name_node(&mut hop.node);
                    name_channel(&mut hop.channel);
                }
            }
            Self::Offer(o) => {
                o.signing_key.as_mut().map(name_node);
                name_paths(&mut o.paths);
            }
            Self::Refund(r) => name_paths(&mut r.paths),
            Self::Lnurl(_) | Self::LightningAddress(_) => {}
        }
    }
}

/// Decodes `input`, already trimmed; a `lightning:` prefix and upper case are accepted.
pub fn decode(input: &str) -> Result<Decoded, Failure> {
    let s = strip_scheme(input);
    // The kind is read from the start alone; BOLT 12 lets `+` and whitespace split a string anywhere.
    let start: String = s
        .chars()
        .filter(|c| *c != '+' && !c.is_whitespace())
        .take(10)
        .collect::<String>()
        .to_ascii_lowercase();
    if start.starts_with("lno1") {
        return offer(s);
    }
    if start.starts_with("lnr1") {
        return refund(s);
    }
    if start.starts_with("lnurl1") {
        return lnurl(s);
    }
    if let Some((scheme, _)) = s.split_once("://")
        && ["lnurlp", "lnurlw", "lnurlc", "keyauth"].contains(&scheme.to_ascii_lowercase().as_str())
    {
        return lud17(s);
    }
    if start.starts_with("ln") && s.contains('1') && !s.contains('@') && !start.starts_with("lni1")
    {
        return bolt11(s);
    }
    if s.contains('@') {
        return lightning_address(s);
    }
    Err(Failure::Unrecognised)
}

fn strip_scheme(s: &str) -> &str {
    s.get(..10)
        .filter(|p| p.eq_ignore_ascii_case("lightning:"))
        .and_then(|_| s.get(10..))
        .map_or(s, |rest| rest.strip_prefix("//").unwrap_or(rest))
}

fn node(key: &PublicKey) -> Node {
    let id = key.serialize();
    Node {
        key: id.to_lower_hex_string(),
        id,
        alias: None,
        known: None,
    }
}

fn channel(scid: u64) -> Channel {
    Channel {
        scid: format!(
            "{}x{}x{}",
            scid >> 40,
            (scid >> 16) & 0xff_ffff,
            scid & 0xffff
        ),
        id: scid,
        known: None,
    }
}

/// Names for the BOLT 11 feature pairs a reader may want to see.
fn feature_name(pair: u16) -> Option<&'static str> {
    Some(match pair {
        4 => "var_onion_optin",
        7 => "payment_secret",
        8 => "basic_mpp",
        24 => "payment_metadata",
        28 => "trampoline",
        _ => return None,
    })
}

fn features(flags: &[u8]) -> Vec<Feature> {
    let mut out = Vec::new();
    for (byte, b) in (0u16..).zip(flags) {
        for bit in 0..8 {
            if b & (1 << bit) != 0 {
                let n = byte * 8 + bit;
                out.push(Feature {
                    bit: n,
                    name: feature_name(n / 2),
                    required: n % 2 == 0,
                });
            }
        }
    }
    out
}

fn bolt11(s: &str) -> Result<Decoded, Failure> {
    let invoice = Bolt11Invoice::from_str(s).map_err(|e| match e {
        ParseOrSemanticError::ParseError(Bolt11ParseError::Bech32Error(
            CheckedHrpstringError::Checksum(ChecksumError::InvalidResidue),
        )) => Failure::Checksum,
        ParseOrSemanticError::ParseError(Bolt11ParseError::MalformedSignature(_))
        | ParseOrSemanticError::SemanticError(Bolt11SemanticError::InvalidSignature) => {
            Failure::Signature
        }
        ParseOrSemanticError::ParseError(Bolt11ParseError::UnknownCurrency) => {
            Failure::Unrecognised
        }
        _ => Failure::Malformed,
    })?;
    let (description, description_hash) = match invoice.description() {
        Bolt11InvoiceDescriptionRef::Direct(d) => (Some(d.as_inner().to_string()), None),
        Bolt11InvoiceDescriptionRef::Hash(h) => (None, Some(h.0.to_string())),
    };
    let named = invoice.payee_pub_key().copied();
    let hints = invoice
        .route_hints()
        .into_iter()
        .map(|hint| {
            hint.0
                .into_iter()
                .map(|h| Hop {
                    node: node(&h.src_node_id),
                    channel: channel(h.short_channel_id),
                    base_fee_msat: h.fees.base_msat,
                    fee_ppm: h.fees.proportional_millionths,
                    cltv_delta: h.cltv_expiry_delta,
                })
                .collect()
        })
        .collect();
    Ok(Decoded::Bolt11(Invoice {
        network: match invoice.currency() {
            Currency::Bitcoin => "mainnet",
            Currency::BitcoinTestnet => "testnet",
            Currency::Signet => "signet",
            Currency::Regtest => "regtest",
            Currency::Simnet => "simnet",
        },
        amount_msat: invoice.amount_milli_satoshis(),
        description,
        description_hash,
        payee: node(&named.unwrap_or_else(|| invoice.recover_payee_pub_key())),
        payee_named: named.is_some(),
        created: invoice.duration_since_epoch().as_secs(),
        expiry: invoice.expiry_time().as_secs(),
        payment_hash: invoice.payment_hash().to_string(),
        min_final_cltv: invoice.min_final_cltv_expiry_delta(),
        features: invoice
            .features()
            .map_or_else(Vec::new, |f| features(f.le_flags())),
        fallbacks: invoice
            .fallback_addresses()
            .iter()
            .map(ToString::to_string)
            .collect(),
        hints,
    }))
}

fn chain_name(chain: &ChainHash) -> Option<&'static str> {
    Some(match Network::try_from(*chain).ok()? {
        Network::Bitcoin => "mainnet",
        Network::Testnet => "testnet3",
        Network::Testnet4 => "testnet4",
        Network::Signet => "signet",
        Network::Regtest => "regtest",
    })
}

/// The first Bitcoin network among `chains`, and every chain named.
fn chains(chains: &[ChainHash]) -> (Option<&'static str>, Vec<String>) {
    let names = chains
        .iter()
        .map(|c| chain_name(c).map_or_else(|| c.to_string(), str::to_owned))
        .collect();
    (chains.iter().find_map(chain_name), names)
}

fn paths(paths: &[BlindedMessagePath]) -> Vec<Path> {
    paths
        .iter()
        .map(|p| {
            let (n, c, d) = match p.introduction_node() {
                IntroductionNode::NodeId(key) => (Some(node(key)), None, None),
                IntroductionNode::DirectedShortChannelId(dir, scid) => {
                    let d = match dir {
                        lightning::blinded_path::Direction::NodeOne => 0,
                        lightning::blinded_path::Direction::NodeTwo => 1,
                    };
                    (None, Some(channel(*scid)), Some(d))
                }
            };
            Path {
                node: n,
                channel: c,
                direction: d,
                hops: p.blinded_hops().len(),
            }
        })
        .collect()
}

fn bolt12_failure(e: Bolt12ParseError) -> Failure {
    match e {
        Bolt12ParseError::Bech32(CheckedHrpstringError::Checksum(
            ChecksumError::InvalidResidue,
        )) => Failure::Checksum,
        Bolt12ParseError::InvalidSignature(_) => Failure::Signature,
        _ => Failure::Malformed,
    }
}

fn offer(s: &str) -> Result<Decoded, Failure> {
    let o = offer::Offer::from_str(s).map_err(bolt12_failure)?;
    let (network, chain_names) = chains(&o.chains());
    Ok(Decoded::Offer(Offer {
        network,
        chains: chain_names,
        description: o.description().map(|d| d.to_string()),
        issuer: o.issuer().map(|d| d.to_string()),
        amount: o.amount().map(|a| match a {
            offer::Amount::Bitcoin { amount_msats } => Price::Msat { msat: amount_msats },
            offer::Amount::Currency {
                iso4217_code,
                amount,
            } => Price::Currency {
                currency: iso4217_code.as_str().to_owned(),
                amount,
            },
        }),
        quantity: match o.supported_quantity() {
            Quantity::One => Items::Word("one"),
            Quantity::Unbounded => Items::Word("any"),
            Quantity::Bounded(n) => Items::Max(n.get()),
        },
        expires: o.absolute_expiry().map(|d| d.as_secs()),
        signing_key: o.issuer_signing_pubkey().map(|k| node(&k)),
        paths: paths(o.paths()),
        features: features(o.offer_features().le_flags()),
    }))
}

fn refund(s: &str) -> Result<Decoded, Failure> {
    let r = refund::Refund::from_str(s).map_err(bolt12_failure)?;
    let (network, chain_names) = chains(&[r.chain()]);
    Ok(Decoded::Refund(Refund {
        network,
        chains: chain_names,
        description: r.description().to_string(),
        issuer: r.issuer().map(|d| d.to_string()),
        amount_msat: r.amount_msats(),
        quantity: r.quantity(),
        expires: r.absolute_expiry().map(|d| d.as_secs()),
        payer_key: r.payer_signing_pubkey().serialize().to_lower_hex_string(),
        payer_note: r.payer_note().map(|d| d.to_string()),
        paths: paths(r.paths()),
    }))
}

/// Bech32 without its 90- and 1023-character limits: LNURLs carry whole URLs. The input cap
/// bounds the work instead.
enum LongBech32 {}

impl Checksum for LongBech32 {
    type MidstateRepr = u32;
    const CODE_LENGTH: usize = usize::MAX;
    const CHECKSUM_LENGTH: usize = 6;
    // BIP 173's generator and its shifts, and bech32's residue.
    const GENERATOR_SH: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    const TARGET_RESIDUE: u32 = 1;
}

fn lnurl(s: &str) -> Result<Decoded, Failure> {
    let checked = CheckedHrpstring::new::<LongBech32>(s).map_err(|e| match e {
        CheckedHrpstringError::Checksum(ChecksumError::InvalidResidue) => Failure::Checksum,
        _ => Failure::Malformed,
    })?;
    if !checked.hrp().as_str().eq_ignore_ascii_case("lnurl") {
        return Err(Failure::Unrecognised);
    }
    let url = String::from_utf8(checked.byte_iter().collect()).map_err(|_| Failure::Malformed)?;
    let (host, tag, k1) = read_url(&url).ok_or(Failure::Malformed)?;
    // LUD-01: clearnet over HTTPS only; plain HTTP only to an onion service.
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") && onion(&host)) {
        return Err(Failure::Malformed);
    }
    Ok(Decoded::Lnurl(Lnurl {
        network: None,
        form: "bech32",
        url,
        host,
        tag,
        k1,
    }))
}

/// LUD-17: `lnurlp://host/…` and kin are the URL with `https` (`http` to an onion) for scheme.
fn lud17(s: &str) -> Result<Decoded, Failure> {
    let (scheme, rest) = s.split_once("://").ok_or(Failure::Unrecognised)?;
    let (host, tag, k1) = read_url(s).ok_or(Failure::Malformed)?;
    let url = format!("{}://{rest}", if onion(&host) { "http" } else { "https" });
    // keyauth:// is a login link, whatever its query says.
    let tag = if scheme.eq_ignore_ascii_case("keyauth") {
        Some("login".to_owned())
    } else {
        tag
    };
    Ok(Decoded::Lnurl(Lnurl {
        network: None,
        form: "url",
        url,
        host,
        tag,
        k1,
    }))
}

fn onion(host: &str) -> bool {
    host.ends_with(".onion")
}

/// An absolute URL's host (lower case, no user info or port) and its query's `tag` and `k1`.
/// `None` when it has no host or holds a space, a control character or a backslash, which a
/// browser reads as `/`: `https://evil\@good/` goes to `evil`, while splitting at `@` says `good`.
fn read_url(url: &str) -> Option<(String, Option<String>, Option<String>)> {
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return None;
    }
    let (_, rest) = url.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest.get(..end)?;
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match host_port.strip_prefix('[') {
        Some(v6) => host_port.get(..v6.find(']')? + 2)?,
        None => host_port.split(':').next()?,
    };
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-.[]:".contains(c))
    {
        return None;
    }
    let query = rest
        .get(end..)?
        .split_once('?')
        .map_or("", |(_, q)| q.split('#').next().unwrap_or(""));
    let param = |key: &str| {
        query
            .split('&')
            .find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key))
            .map(|(_, v)| v.to_owned())
    };
    Some((host.to_ascii_lowercase(), param("tag"), param("k1")))
}

/// LUD-16: `name@domain`, the name of `a-z0-9-_.+`, the domain a hostname with a dot. Read in
/// lower case, so an upper-case QR code works.
fn lightning_address(s: &str) -> Result<Decoded, Failure> {
    let lower = s.to_ascii_lowercase();
    let (name, domain) = lower.split_once('@').ok_or(Failure::Unrecognised)?;
    // `@domain` is short for the domain's default name, `_`.
    let name = if name.is_empty() { "_" } else { name };
    let name_ok = name.len() <= 256
        && name.len() <= 256
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.+".contains(&b));
    let labels: Vec<&str> = domain.split('.').collect();
    let domain_ok = domain.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && labels
            .last()
            .is_some_and(|tld| tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_lowercase()));
    if !name_ok || !domain_ok {
        return Err(Failure::Malformed);
    }
    let scheme = if onion(domain) { "http" } else { "https" };
    Ok(Decoded::LightningAddress(LightningAddress {
        network: None,
        url: format!("{scheme}://{domain}/.well-known/lnurlp/{name}"),
        name: name.to_owned(),
        domain: domain.to_owned(),
    }))
}

#[cfg(test)]
#[path = "decode_tests.rs"]
mod tests;
