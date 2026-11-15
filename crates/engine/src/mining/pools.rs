//! Who mined a block: the pool list (`data/pools/`, MIT, from bitcoin-data/mining-pools, plus our
//! own additions) and the rules that match a block's coinbase against it (`docs/API.md`, "Mining").
//!
//! The coinbase tag and payout scripts are written by whoever mined the block, so matching is
//! bounded by the inputs' stored sizes and the list's, allocates nothing per block and cannot
//! panic.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::OnceLock;

use bitcoin::address::{Address, NetworkUnchecked};
use bitcoin::hashes::{Hash, HashEngine, sha256};
use bitcoin::{Script, ScriptBuf};
use serde::Deserialize;

/// The id of "Unknown": a block no rule attributes. The list's own ids start at 1.
pub const UNKNOWN: u16 = 0;

const LIST: &str = include_str!("../../data/pools/pool-list.json");
/// Pools upstream does not list yet, ids from 10000 so they never meet upstream's.
const LOCAL: &str = include_str!("../../data/pools/local-pools.json");
const SHIPPED: [&str; 2] = [LIST, LOCAL];
/// Bumped whenever the matching rules change, so stored attributions are redone like after a
/// change to the list.
const RULES: u32 = 1;

/// One pool. `tags` are matched as bytes; `addresses` as their scripts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pool {
    pub id: u16,
    pub name: String,
    /// The name's ASCII letters and digits, lowercased: `Foundry USA` is `foundryusa`.
    pub slug: String,
    pub link: String,
    pub addresses: Vec<String>,
    pub tags: Vec<String>,
}

/// How a block was attributed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// A payout script is one of the pool's addresses.
    Address,
    /// The coinbase script contains one of the pool's tags.
    Tag,
    /// Nothing matched: [`UNKNOWN`].
    None,
}

/// Every pool, indexed for matching.
#[derive(Debug)]
pub struct Pools {
    /// `Unknown` first, then the list in its order.
    pools: Vec<Pool>,
    by_id: HashMap<u16, usize>,
    by_slug: HashMap<String, usize>,
    scripts: HashMap<ScriptBuf, u16>,
    /// Lowercased tag bytes and their pool, longest first.
    tags: Vec<(Vec<u8>, u16)>,
    version: String,
}

#[derive(Deserialize)]
struct Entry {
    id: u16,
    name: String,
    addresses: Vec<String>,
    tags: Vec<String>,
    link: String,
}

/// Why a list was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListError {
    Json(String),
    /// Two pools share an id or a slug, a pool uses id 0, or its name has no letter or digit.
    Duplicate(String),
}

/// The list compiled into the binary. A list that does not parse (a test catches it) leaves
/// only `Unknown`, so every block is unattributed rather than the server failing.
pub fn list() -> &'static Pools {
    static POOLS: OnceLock<Pools> = OnceLock::new();
    POOLS.get_or_init(|| Pools::parse_all(&SHIPPED).unwrap_or_else(|_| Pools::empty(&SHIPPED)))
}

fn slug(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn unknown() -> Pool {
    Pool {
        id: UNKNOWN,
        name: "Unknown".into(),
        slug: "unknown".into(),
        link: String::new(),
        addresses: Vec::new(),
        tags: Vec::new(),
    }
}

impl Pools {
    /// Reads a list in bitcoin-data/mining-pools' `pool-list.json` format. An address that does
    /// not parse is kept for display but matches nothing.
    pub fn parse(json: &str) -> Result<Self, ListError> {
        Self::parse_all(&[json])
    }

    /// Several lists read as one, in order: an id or slug in two of them refuses the whole.
    fn parse_all(lists: &[&str]) -> Result<Self, ListError> {
        let mut entries = Vec::new();
        for json in lists {
            let list: Vec<Entry> =
                serde_json::from_str(json).map_err(|e| ListError::Json(e.to_string()))?;
            entries.extend(list);
        }
        let mut pools = Self::empty(lists);
        let mut tags = Vec::new();
        for e in entries {
            let pool = Pool {
                id: e.id,
                slug: slug(&e.name),
                name: e.name,
                link: e.link,
                addresses: e.addresses,
                tags: e.tags,
            };
            if pool.id == UNKNOWN
                || pool.slug.is_empty()
                || pools.by_id.contains_key(&pool.id)
                || pools.by_slug.contains_key(&pool.slug)
            {
                return Err(ListError::Duplicate(pool.name));
            }
            for a in &pool.addresses {
                if let Ok(addr) = Address::<NetworkUnchecked>::from_str(a) {
                    // The first pool to list an address keeps it.
                    pools
                        .scripts
                        .entry(addr.assume_checked().script_pubkey())
                        .or_insert(pool.id);
                }
            }
            for t in &pool.tags {
                if !t.is_empty() {
                    tags.push((t.as_bytes().to_ascii_lowercase(), pool.id));
                }
            }
            pools.by_id.insert(pool.id, pools.pools.len());
            pools.by_slug.insert(pool.slug.clone(), pools.pools.len());
            pools.pools.push(pool);
        }
        // Longest first, then lowest id: the order `attribute` prefers among tags that match.
        tags.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.1.cmp(&b.1)));
        pools.tags = tags;
        Ok(pools)
    }

    fn empty(lists: &[&str]) -> Self {
        let mut engine = sha256::Hash::engine();
        for json in lists {
            engine.input(json.as_bytes());
        }
        let hash = sha256::Hash::from_engine(engine).to_string();
        let u = unknown();
        Self {
            by_id: HashMap::from([(UNKNOWN, 0)]),
            by_slug: HashMap::from([(u.slug.clone(), 0)]),
            pools: vec![u],
            scripts: HashMap::new(),
            tags: Vec::new(),
            version: format!("{RULES}-{}", hash.get(..16).unwrap_or(&hash)),
        }
    }

    /// Changes whenever the list or the rules change; the store keeps the version its rows were
    /// attributed with.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// `Unknown` first, then the list's pools.
    pub fn all(&self) -> &[Pool] {
        &self.pools
    }

    pub fn by_id(&self, id: u16) -> Option<&Pool> {
        self.pools.get(*self.by_id.get(&id)?)
    }

    pub fn by_slug(&self, slug: &str) -> Option<&Pool> {
        self.pools.get(*self.by_slug.get(slug)?)
    }

    /// The pool that mined a block with this coinbase script (`tag`) and these payout scripts,
    /// in output order.
    ///
    /// 1. **A payout to a pool's address wins.** Only the pool holds that address's key, while
    ///    anyone can write any tag; so a block tagged for one pool that pays another's address is
    ///    the other's. Among payouts, the first in output order decides.
    /// 2. **Otherwise the tag:** the longest list tag found anywhere in the script, ignoring ASCII
    ///    case, so a pool whose tag contains another's (`/ViaBTC/TATMAS Pool/` holds `/ViaBTC/`)
    ///    wins over it. Equal lengths: the one found first in the script, then the lower id.
    /// 3. **Otherwise [`UNKNOWN`].** A tag claims a pool without proof: a block that writes a
    ///    pool's tag and pays an address not on the list is that pool's, since pools change
    ///    payout addresses more often than lists do.
    pub fn attribute(&self, tag: &[u8], payouts: &[ScriptBuf]) -> (u16, Method) {
        if let Some(id) = payouts.iter().find_map(|s| self.by_script(s)) {
            return (id, Method::Address);
        }
        let mut best: Option<(usize, usize, u16)> = None;
        for (t, id) in &self.tags {
            if best.is_some_and(|(len, _, _)| t.len() < len) {
                break;
            }
            if let Some(pos) = find(tag, t)
                && best.is_none_or(|(_, p, _)| pos < p)
            {
                best = Some((t.len(), pos, *id));
            }
        }
        match best {
            Some((_, _, id)) => (id, Method::Tag),
            None => (UNKNOWN, Method::None),
        }
    }

    fn by_script(&self, s: &Script) -> Option<u16> {
        self.scripts.get(s).copied()
    }
}

/// Where `needle` (already lowercase) first occurs in `hay`, ignoring ASCII case.
fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    hay.windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;

    fn p2pkh(byte: u8) -> (String, ScriptBuf) {
        use bitcoin::{Network, PubkeyHash};
        let h = PubkeyHash::from_byte_array([byte; 20]);
        let a = Address::p2pkh(h, Network::Bitcoin);
        (a.to_string(), a.script_pubkey())
    }

    fn sample() -> (Pools, ScriptBuf, ScriptBuf) {
        let (a1, s1) = p2pkh(1);
        let (a2, s2) = p2pkh(2);
        let json = serde_json::json!([
            {"id": 1, "name": "Via BTC", "addresses": [], "tags": ["/ViaBTC/"], "link": "v"},
            {"id": 2, "name": "TATMAS Pool", "addresses": [], "tags": ["/ViaBTC/TATMAS Pool/"], "link": "t"},
            {"id": 3, "name": "Alpha", "addresses": [a1], "tags": ["/alpha/"], "link": "a"},
            {"id": 4, "name": "Beta", "addresses": [a2, "not an address"], "tags": ["/beta/", "B3"], "link": "b"},
            {"id": 5, "name": "Gamma", "addresses": [], "tags": ["/gamm/"], "link": "g"},
        ]);
        (Pools::parse(&json.to_string()).unwrap(), s1, s2)
    }

    #[test]
    fn shipped_list_parses_whole() {
        let p = Pools::parse_all(&SHIPPED).unwrap();
        assert!(p.all().len() > 100);
        assert_eq!(p.all()[0].slug, "unknown");
        assert_eq!(p.by_slug("foundryusa").unwrap().name, "Foundry USA");
        let v2 = p.by_slug("p2poolv2").unwrap();
        assert_eq!((v2.id, v2.addresses.len()), (10000, 0));
        let jao = p.by_slug("jaonoctus").unwrap();
        assert_eq!((jao.id, jao.addresses.len()), (10001, 0));
        // Every address in the shipped list is a valid mainnet address.
        let listed: usize = p.all().iter().map(|p| p.addresses.len()).sum();
        assert_eq!(p.scripts.len(), listed);
        assert_eq!(list().version(), p.version());
        assert!(p.version().starts_with("1-"));
    }

    fn hex(h: &str) -> Vec<u8> {
        (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Testnet 5 block 4329 (`0000000000000038d4…7a8b`): its coinbase script and first 8 payouts.
    /// The second pays jaonoctus's address, which stays off the list so this stays P2Poolv2.
    #[test]
    fn p2poolv2_block_by_tag() {
        let tag = hex("02e91001000c9f579b58040000000000000008538548613d4be818085032506f6f6c7632");
        let payouts: Vec<ScriptBuf> = [
            "512052ef4dd1295ff526d7b761366fcbd83081ba588e300e26185445818f5b0f05b5",
            "5120c6cdf3f715a8c3c38ed34a6dc80b02fd3e99ae94973d590324448827c9cf2d7b",
            "512072c6aa2cc4dc5ac3ee2a888d90094fc4d86480939310debc7061368111698c63",
            "0014af4dc32d8b78346a8fc838240d8937b59d55c90c",
            "0014c51738a852d902cacbf583858d6d5a318cbbea8d",
            "0014c62c7f3ce17699f15c704989ee0905c5b44c477e",
            "00141a1ef865e8ef1d7a607d8a36c81b1c4b3ed70a47",
            "001436b2f44bc0f1b83fbcf874c3bcb33a76849aadda",
        ]
        .map(|s| ScriptBuf::from_bytes(hex(s)))
        .into();
        assert_eq!(list().attribute(&tag, &payouts), (10000, Method::Tag));
        // No upstream tag outranks it: upstream alone finds nothing in this coinbase.
        let upstream = Pools::parse(LIST).unwrap();
        assert_eq!(upstream.attribute(&tag, &payouts), (UNKNOWN, Method::None));
    }

    /// Testnet 5 blocks 2408 (`…3e496bcffa`, `v2/@jaonoctus/`) and 2540 (`…8600ccb845`,
    /// `ckpool%/@jaonoctus/`, whose longer tag beats CKPool's): coinbase script, first payouts.
    #[test]
    fn jaonoctus_blocks_by_tag() {
        let ckpool = list().by_slug("ckpool").unwrap().id;
        // (coinbase script, payouts, whom upstream's list alone names)
        let blocks = [
            (
                "026809285376322f406a616f6e6f637475732f6361736132312e76696e7465756d2e6f72672f30783533392f140100000000000000d4d7f86a000000000000d898",
                &[
                    "5120c6cdf3f715a8c3c38ed34a6dc80b02fd3e99ae94973d590324448827c9cf2d7b",
                    "5120548afdde8ed083cd3b24de5359ef667f599ed3afccf144007b03d311ddfa8fdb",
                    "51202efd5f7375a692876af4652fe8e6d81ab01979f6f7f397075c2cc17043d62c9b",
                    "51205864acfa8e790ee4ca6d39bf1b3518769281249b4876da5c5c0803c77d0e6ae6",
                ][..],
                UNKNOWN,
            ),
            (
                "02ec090004def3f86a04bb0d2f060c20ecf86a03004300000000000a636b706f6f6c252f406a616f6e6f637475732f6361736132312e76696e7465756d2e6f72672f30783533392f",
                &[
                    "5120c6cdf3f715a8c3c38ed34a6dc80b02fd3e99ae94973d590324448827c9cf2d7b",
                    "51024e73",
                ][..],
                ckpool,
            ),
        ];
        let upstream = Pools::parse(LIST).unwrap();
        for (tag, payouts, alone) in blocks {
            let payouts: Vec<ScriptBuf> = payouts
                .iter()
                .map(|s| ScriptBuf::from_bytes(hex(s)))
                .collect();
            assert_eq!(list().attribute(&hex(tag), &payouts), (10001, Method::Tag));
            assert_eq!(upstream.attribute(&hex(tag), &payouts).0, alone);
        }
    }

    #[test]
    fn address_beats_tag() {
        let (p, s1, s2) = sample();
        // Tagged Beta, pays Alpha: Alpha's.
        assert_eq!(
            p.attribute(b"/beta/", std::slice::from_ref(&s1)),
            (3, Method::Address)
        );
        // The first payout that matches decides.
        assert_eq!(
            p.attribute(b"", &[ScriptBuf::new(), s2.clone(), s1]),
            (4, Method::Address)
        );
        // Tagged Alpha, paying an address not on the list: Alpha's, by tag.
        assert_eq!(
            p.attribute(b"/alpha/", &[ScriptBuf::from_bytes(vec![0x51])]),
            (3, Method::Tag)
        );
    }

    #[test]
    fn longest_tag_wins_then_first_then_lowest_id() {
        let (p, _, _) = sample();
        assert_eq!(
            p.attribute(b"\x03abc/ViaBTC/TATMAS Pool/xyz", &[]),
            (2, Method::Tag)
        );
        assert_eq!(p.attribute(b"/ViaBTC/TATMAS", &[]), (1, Method::Tag));
        // Two tags of one length: the one earlier in the script.
        assert_eq!(p.attribute(b"xx/beta/yy/gamm/", &[]), (4, Method::Tag));
        assert_eq!(p.attribute(b"/gamm//beta/", &[]), (5, Method::Tag));
        // A shorter tag earlier never beats a longer one later.
        assert_eq!(p.attribute(b"B3 ... /alpha/", &[]), (3, Method::Tag));
    }

    #[test]
    fn case_is_ignored_for_ascii_only() {
        let (p, _, _) = sample();
        assert_eq!(p.attribute(b"/VIABTC/", &[]), (1, Method::Tag));
        assert_eq!(p.attribute(b"b3", &[]), (4, Method::Tag));
        // A tag cut short, or a prefix of a tag, is no match.
        assert_eq!(p.attribute(b"/ViaBT", &[]), (UNKNOWN, Method::None));
    }

    #[test]
    fn hostile_input_is_harmless() {
        let (p, _, _) = sample();
        assert_eq!(p.attribute(b"", &[]), (UNKNOWN, Method::None));
        let junk: Vec<u8> = (0..10_000u32).map(|i| (i * 7919 % 251) as u8).collect();
        assert_eq!(p.attribute(&junk, &[]), (UNKNOWN, Method::None));
        // Invalid UTF-8 around a tag still matches it.
        let mut bytes = vec![0xff, 0xfe, 0xc3];
        bytes.extend_from_slice(b"/gamm/");
        bytes.push(0x80);
        assert_eq!(p.attribute(&bytes, &[]), (5, Method::Tag));
        // A tag that is the whole script, and non-ASCII bytes that differ only in the high bit.
        assert_eq!(p.attribute(b"/gamm/", &[]), (5, Method::Tag));
        assert_eq!(p.attribute(b"/g\xc1mm/", &[]), (UNKNOWN, Method::None));
        let long = ScriptBuf::from_bytes(vec![0x6a; 10_000]);
        assert_eq!(p.attribute(b"", &[long]), (UNKNOWN, Method::None));
    }

    #[test]
    fn lookups_and_refusals() {
        let (p, _, _) = sample();
        assert_eq!(p.by_slug("viabtc").unwrap().id, 1);
        assert_eq!(p.by_slug("tatmaspool").unwrap().id, 2);
        assert_eq!(p.by_id(UNKNOWN).unwrap().name, "Unknown");
        assert!(p.by_slug("Via BTC").is_none());
        let dup = r#"[{"id":1,"name":"A","addresses":[],"tags":[],"link":""},
                      {"id":1,"name":"B","addresses":[],"tags":[],"link":""}]"#;
        assert!(matches!(Pools::parse(dup), Err(ListError::Duplicate(_))));
        let slugs = r#"[{"id":1,"name":"A b","addresses":[],"tags":[],"link":""},
                        {"id":2,"name":"Ab","addresses":[],"tags":[],"link":""}]"#;
        assert!(matches!(Pools::parse(slugs), Err(ListError::Duplicate(_))));
        // A clash across two lists refuses both.
        let a = r#"[{"id":1,"name":"A","addresses":[],"tags":[],"link":""}]"#;
        let b = r#"[{"id":2,"name":"a","addresses":[],"tags":[],"link":""}]"#;
        assert!(matches!(
            Pools::parse_all(&[a, b]),
            Err(ListError::Duplicate(_))
        ));
        let zero = r#"[{"id":0,"name":"Z","addresses":[],"tags":[],"link":""}]"#;
        assert!(Pools::parse(zero).is_err());
        assert!(matches!(Pools::parse("{"), Err(ListError::Json(_))));
        // Any change to the list changes the version.
        assert_ne!(Pools::parse("[]").unwrap().version(), p.version());
        // Either shipped file changing changes the version.
        assert_ne!(Pools::parse(LIST).unwrap().version(), list().version());
    }
}
