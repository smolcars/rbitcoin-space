//! Who mined a block: the pool list (`data/pools/`, MIT, from bitcoin-data/mining-pools, plus our
//! own additions) and the rules that match a block's coinbase against it (`docs/API.md`, "Mining").
//!
//! The coinbase tag and payout scripts are written by whoever mined the block, so matching is
//! bounded by the inputs' stored sizes and the list's, allocates nothing per block and cannot
//! panic.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::OnceLock;

use bitcoin::address::{Address, NetworkUnchecked};
use bitcoin::hashes::{Hash, HashEngine, sha256};
use bitcoin::{Script, ScriptBuf};
use serde::Deserialize;

use super::sv2;

/// The id of "Unknown": a block no rule attributes. The list's own ids start at 1.
pub const UNKNOWN: u16 = 0;

const LIST: &str = include_str!("../../data/pools/pool-list.json");
/// Our own: pools upstream does not list yet, ids from 10000 so they never meet upstream's, and
/// tags and addresses added to upstream's pools.
const LOCAL: &str = include_str!("../../data/pools/local-pools.json");
const SHIPPED: [&str; 2] = [LIST, LOCAL];
/// Bumped whenever the matching rules change, so stored attributions are redone like after a
/// change to the list.
const RULES: u32 = 3;

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
    /// The coinbase script, or its pool field when it is a Stratum V2 tag, holds one of the
    /// pool's tags.
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
    /// An entry with both the id and the name of a pool in an earlier list is no clash: it adds
    /// to that pool.
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

    /// Several lists read as one, in order. An entry with the id and the name of a pool in an
    /// earlier list adds its tags and addresses to that pool, and its link is ignored. Any other
    /// id or slug met twice, in one list or two, refuses the whole.
    fn parse_all(lists: &[&str]) -> Result<Self, ListError> {
        let mut pools = Self::empty(lists);
        let mut tags = Vec::new();
        for json in lists {
            let list: Vec<Entry> =
                serde_json::from_str(json).map_err(|e| ListError::Json(e.to_string()))?;
            // An addition is to an earlier list's pool: no id twice in this one.
            let mut ids = HashSet::new();
            for e in list {
                let slug = slug(&e.name);
                if e.id == UNKNOWN || slug.is_empty() || !ids.insert(e.id) {
                    return Err(ListError::Duplicate(e.name));
                }
                let at = match (
                    pools.by_id.get(&e.id).copied(),
                    pools.by_slug.get(&slug).copied(),
                ) {
                    (None, None) => {
                        let at = pools.pools.len();
                        pools.by_id.insert(e.id, at);
                        pools.by_slug.insert(slug.clone(), at);
                        pools.pools.push(Pool {
                            id: e.id,
                            name: e.name,
                            slug,
                            link: e.link,
                            addresses: Vec::new(),
                            tags: Vec::new(),
                        });
                        at
                    }
                    (Some(at), _) if pools.pools.get(at).is_some_and(|p| p.name == e.name) => at,
                    _ => return Err(ListError::Duplicate(e.name)),
                };
                for a in &e.addresses {
                    if let Ok(addr) = Address::<NetworkUnchecked>::from_str(a) {
                        // The first pool to list an address keeps it.
                        pools
                            .scripts
                            .entry(addr.assume_checked().script_pubkey())
                            .or_insert(e.id);
                    }
                }
                for t in &e.tags {
                    if !t.is_empty() {
                        tags.push((t.as_bytes().to_ascii_lowercase(), e.id));
                    }
                }
                if let Some(pool) = pools.pools.get_mut(at) {
                    pool.addresses.extend(e.addresses);
                    pool.tags.extend(e.tags);
                }
            }
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
    /// 1. **The tag wins:** the longest list tag found in the script, ignoring ASCII case, so a
    ///    pool whose tag contains another's (`/ViaBTC/TATMAS Pool/` holds `/ViaBTC/`) wins over
    ///    it. Equal lengths: the one found first, then the lower id. The tag is written by
    ///    whoever built the block. A script laid out as Stratum V2's reference implementation
    ///    writes it ([`sv2::tag`]) is searched in its pool field only, between its delimiters
    ///    (`/<pool>/`, so a tag listed with slashes still matches): the miner field is the
    ///    miner's own words, and with Job Declaration the miner builds the whole script, so a
    ///    pool's name there does not make the block that pool's.
    /// 2. **Otherwise a payout to a pool's address**, the first in output order. A payout only
    ///    shows who got paid: P2Pool and TIDES pools pay their miners from the coinbase, so a
    ///    listed solo miner's address in such a block does not make the block theirs. Stratum V2's
    ///    convention itself leaves a block whose pool field is empty to be named by its payout.
    /// 3. **Otherwise [`UNKNOWN`].**
    pub fn attribute(&self, tag: &[u8], payouts: &[ScriptBuf]) -> (u16, Method) {
        let named = sv2::tag(tag).map_or(tag, |t| t.delimited);
        let mut best: Option<(usize, usize, u16)> = None;
        for (t, id) in &self.tags {
            if best.is_some_and(|(len, _, _)| t.len() < len) {
                break;
            }
            if let Some(pos) = find(named, t)
                && best.is_none_or(|(_, p, _)| pos < p)
            {
                best = Some((t.len(), pos, *id));
            }
        }
        if let Some((_, _, id)) = best {
            return (id, Method::Tag);
        }
        match payouts.iter().find_map(|s| self.by_script(s)) {
            Some(id) => (id, Method::Address),
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
        let pleb = p.by_slug("sv2plebhash").unwrap();
        assert_eq!((pleb.id, pleb.addresses.len()), (10002, 0));
        let t5 = p.by_slug("testnet5com").unwrap();
        assert_eq!((t5.id, t5.addresses.len()), (10003, 0));
        // Every address in the shipped list is a valid mainnet address.
        let listed: usize = p.all().iter().map(|p| p.addresses.len()).sum();
        assert_eq!(p.scripts.len(), listed);
        assert_eq!(list().version(), p.version());
        assert!(p.version().starts_with("3-"));
    }

    fn hex(h: &str) -> Vec<u8> {
        (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Testnet 5 block 4329 (`0000000000000038d4…7a8b`): its coinbase script and first 8 payouts.
    /// The second pays jaonoctus's address; the tag decides, so listing it would not matter.
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

    /// Testnet 5 blocks 2408 (`…3e496bcffa`, `Sv2/@jaonoctus/casa21.vinteum.org/0x539/`, a
    /// Stratum V2 tag whose pool field names him) and 2540 (`…8600ccb845`, `ckpool%/@jaonoctus/`,
    /// whose longer tag beats CKPool's): coinbase script, first payouts.
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

    /// The pool testnet5.com by its `testnet5.com` tag, in a plain coinbase and as a Stratum V2
    /// pool field. No block of its was read for this test: the scripts are written by hand.
    #[test]
    fn testnet5com_by_tag() {
        let upstream = Pools::parse(LIST).unwrap();
        for tag in [
            // height 0x2000, push "/testnet5.com/"
            "0200200e2f746573746e6574352e636f6d2f",
            // height 0x2000, push "Sv2/testnet5.com//", push an 8-byte extranonce
            "020020125376322f746573746e6574352e636f6d2f2f080000000000000000",
        ] {
            assert_eq!(list().attribute(&hex(tag), &[]), (10003, Method::Tag));
            assert_eq!(upstream.attribute(&hex(tag), &[]), (UNKNOWN, Method::None));
        }
    }

    /// Testnet 5 blocks 129 (`…8ca630eb`) and 4363 (`…be35072e`): coinbase `Sv2/⛏️ plebhash ⚡//`,
    /// paying the pool's own address, which the list leaves out.
    #[test]
    fn plebhash_blocks_by_tag() {
        let payouts = [ScriptBuf::from_bytes(hex(
            "0014eb859601c3afef69055d0fc0e740aadfbc0d5fa1",
        ))];
        let upstream = Pools::parse(LIST).unwrap();
        for tag in [
            "028100195376322fe29b8fefb88f20706c65626861736820e29aa12f2f140100000000000000000000000000000000000000",
            "020b11195376322fe29b8fefb88f20706c65626861736820e29aa12f2f140100000f00000000000000000000000000000000",
        ] {
            assert_eq!(list().attribute(&hex(tag), &payouts), (10002, Method::Tag));
            assert_eq!(
                upstream.attribute(&hex(tag), &payouts),
                (UNKNOWN, Method::None)
            );
        }
    }

    /// The script every recent MARA Pool block pays: `32i1m6gNcSHwiPX9nfTNXVjme9j5DU8y5g`.
    const MARA_PAYOUT: &str = "a9140b2867e31c2c5e8ebb55631eececd31da8e2510887";
    const MARA: u16 = 140;

    /// `height || push(text) || push(a 20-byte extranonce)`: Stratum V2's layout.
    fn sv2_script(text: &str) -> Vec<u8> {
        let mut s = vec![0x03, 0x98, 0xe5, 0x0e, text.len() as u8];
        s.extend_from_slice(text.as_bytes());
        s.push(20);
        s.extend_from_slice(&[7; 20]);
        s
    }

    /// Mainnet blocks 976,280 (`…ca58844dc2`) and 975,369: coinbase `Sv2/MARA🇺🇸🇺🇸//`, paying an
    /// address upstream does not list. Our additions to upstream's MARA Pool name them.
    #[test]
    fn mara_sv2_blocks_by_tag() {
        let paid = [ScriptBuf::from_bytes(hex(MARA_PAYOUT))];
        let elsewhere = [ScriptBuf::from_bytes(vec![0x51])];
        let upstream = Pools::parse(LIST).unwrap();
        for tag in [
            "0398e50e1a5376322f4d415241f09f87baf09f87b8f09f87baf09f87b82f2f14020000140000000000000000000005cf0007c4fa",
            "0309e20e1a5376322f4d415241f09f87baf09f87b8f09f87baf09f87b82f2f1401000000000000000000000000001014b8050000",
        ] {
            let tag = hex(tag);
            assert_eq!(list().attribute(&tag, &paid), (MARA, Method::Tag));
            assert_eq!(list().attribute(&tag, &elsewhere), (MARA, Method::Tag));
            assert_eq!(upstream.attribute(&tag, &paid), (UNKNOWN, Method::None));
        }
        // One flag or three: the tag holds one.
        for text in ["Sv2/MARA🇺🇸//", "Sv2/MARA🇺🇸🇺🇸🇺🇸/a miner/"] {
            let named = list().attribute(&sv2_script(text), &elsewhere);
            assert_eq!(named, (MARA, Method::Tag), "{text}");
        }
        // The letters alone are no tag of ours.
        let bare = list().attribute(&sv2_script("Sv2/MARA//"), &elsewhere);
        assert_eq!(bare, (UNKNOWN, Method::None));
    }

    /// A job the miner declared has an empty pool field: the payout names the pool.
    #[test]
    fn sv2_block_with_no_pool_tag_by_address() {
        let paid = [ScriptBuf::from_bytes(hex(MARA_PAYOUT))];
        for text in ["Sv2///", "Sv2//a miner/", "Sv2//bitaxe/gamma/"] {
            let tag = sv2_script(text);
            assert_eq!(list().attribute(&tag, &paid), (MARA, Method::Address));
            assert_eq!(list().attribute(&tag, &[]), (UNKNOWN, Method::None));
        }
        let upstream = Pools::parse(LIST).unwrap();
        let named = upstream.attribute(&sv2_script("Sv2///"), &paid);
        assert_eq!(named, (UNKNOWN, Method::None));
    }

    /// Mainnet block 976,273: `| MARA Made in USA 🇺🇸 |v05`, not Stratum V2, the same payout.
    #[test]
    fn mara_block_by_its_older_tag() {
        let tag = hex(
            "0391e50e048446fc6a7c204d415241204d61646520696e2055534120f09f87baf09f87b8207c763035137d71b65e0000000000ffffffff",
        );
        let paid = [ScriptBuf::from_bytes(hex(MARA_PAYOUT))];
        assert_eq!(list().attribute(&tag, &paid), (MARA, Method::Tag));
        let upstream = Pools::parse(LIST).unwrap();
        assert_eq!(upstream.attribute(&tag, &paid), (MARA, Method::Tag));
        assert_eq!(upstream.attribute(b"", &paid), (UNKNOWN, Method::None));
        assert_eq!(list().attribute(b"", &paid), (MARA, Method::Address));
    }

    /// The miner field is the miner's own words: a listed pool's tag there names nobody.
    #[test]
    fn sv2_miner_field_names_no_pool() {
        let foundry = list().by_slug("foundryusa").unwrap().id;
        let viabtc = list().by_slug("viabtc").unwrap().id;
        let paid = [ScriptBuf::from_bytes(hex(MARA_PAYOUT))];
        for text in ["Sv2//Foundry USA Pool/", "Sv2/solo//ViaBTC//"] {
            let tag = sv2_script(text);
            assert_eq!(list().attribute(&tag, &[]), (UNKNOWN, Method::None));
            // The payout decides, as for any block with no listed tag.
            assert_eq!(list().attribute(&tag, &paid), (MARA, Method::Address));
        }
        // The pool field decides even against a longer tag in the miner field.
        let both = sv2_script("Sv2/MARA🇺🇸/Foundry USA Pool/");
        assert_eq!(list().attribute(&both, &[]), (MARA, Method::Tag));
        let swapped = sv2_script("Sv2/Foundry USA Pool/MARA🇺🇸/");
        assert_eq!(list().attribute(&swapped, &paid), (foundry, Method::Tag));
        // The same words in a script not laid out as Stratum V2's are searched whole: without
        // the extranonce push, and under the reference implementation's older `/pool/miner/`.
        let cut = sv2_script("Sv2//Foundry USA Pool/");
        let cut = &cut[..cut.len() - 21];
        assert_eq!(list().attribute(cut, &[]), (foundry, Method::Tag));
        let older = sv2_script("/solo//ViaBTC//");
        assert_eq!(list().attribute(&older, &[]), (viabtc, Method::Tag));
        // A pool field that is the words of a tag listed with slashes is that pool's.
        let moved = sv2_script("Sv2/ViaBTC//");
        assert_eq!(list().attribute(&moved, &paid), (viabtc, Method::Tag));
    }

    /// In the pool field the listed tags match as in any script: as part of it, ignoring ASCII
    /// case, the longest first.
    #[test]
    fn sv2_pool_field_is_searched_like_a_script() {
        let (a1, s1) = p2pkh(1);
        let json = serde_json::json!([
            {"id": 1, "name": "Via", "addresses": [], "tags": ["ViaBTC"], "link": ""},
            {"id": 2, "name": "Tatmas", "addresses": [], "tags": ["ViaBTC TATMAS"], "link": ""},
            {"id": 3, "name": "Alpha", "addresses": [a1], "tags": ["alpha"], "link": ""},
            {"id": 4, "name": "Beta", "addresses": [], "tags": ["beta", "B3"], "link": ""},
            {"id": 5, "name": "Gamma", "addresses": [], "tags": ["gamm"], "link": ""},
            {"id": 6, "name": "Slashed", "addresses": [], "tags": ["/slashed/"], "link": ""},
        ]);
        let p = Pools::parse(&json.to_string()).unwrap();
        let by = |text: &str| p.attribute(&sv2_script(text), std::slice::from_ref(&s1));
        assert_eq!(by("Sv2/the BETA pool//"), (4, Method::Tag));
        assert_eq!(by("Sv2/ViaBTC TATMAS pool/miner/"), (2, Method::Tag));
        assert_eq!(by("Sv2/viabtc tatma//"), (1, Method::Tag));
        assert_eq!(by("Sv2/gamm beta//"), (5, Method::Tag));
        assert_eq!(by("Sv2/beta gamm//"), (4, Method::Tag));
        assert_eq!(by("Sv2/b3 alpha//"), (3, Method::Tag));
        // No listed tag in the pool field: the payout, whatever the miner field holds.
        assert_eq!(by("Sv2/nobody/beta/"), (3, Method::Address));
        assert_eq!(by("Sv2//ViaBTC TATMAS/"), (3, Method::Address));
        assert_eq!(by("Sv2///"), (3, Method::Address));
        let unpaid = p.attribute(&sv2_script("Sv2/nobody/beta/"), &[]);
        assert_eq!(unpaid, (UNKNOWN, Method::None));
        // The field is searched between its delimiters, so a tag listed with slashes matches a
        // pool field that is exactly its words, and never the miner field.
        assert_eq!(by("Sv2/slashed//"), (6, Method::Tag));
        assert_eq!(by("Sv2/Slashed/a miner/"), (6, Method::Tag));
        assert_eq!(by("Sv2/slashed pool//"), (3, Method::Address));
        assert_eq!(by("Sv2//slashed//"), (3, Method::Address));
        assert_eq!(by("Sv2/nobody/slashed/"), (3, Method::Address));
        assert_eq!(by("Sv2/nobody//slashed//"), (3, Method::Address));
        assert_eq!(p.attribute(b"\x03abc/Slashed/", &[]), (6, Method::Tag));
    }

    /// What `local-pools.json` adds to a pool of upstream's is listed nowhere else. A refresh
    /// from upstream that brings one of these must drop ours.
    #[test]
    fn shipped_additions_are_listed_once() {
        let upstream = Pools::parse(LIST).unwrap();
        let local: Vec<Entry> = serde_json::from_str(LOCAL).unwrap();
        let all = list().all();
        let mut added = 0;
        for e in local.iter().filter(|e| upstream.by_id(e.id).is_some()) {
            let pool = list().by_id(e.id).unwrap();
            assert!(!e.tags.is_empty() || !e.addresses.is_empty(), "{}", e.name);
            for t in &e.tags {
                let listed = all
                    .iter()
                    .flat_map(|p| &p.tags)
                    .filter(|x| x.eq_ignore_ascii_case(t))
                    .count();
                assert_eq!(listed, 1, "{t} is listed {listed} times");
                assert!(pool.tags.contains(t) && !t.is_empty());
                added += 1;
            }
            for a in &e.addresses {
                let listed = all.iter().flat_map(|p| &p.addresses).filter(|x| *x == a);
                assert_eq!(listed.count(), 1, "{a} is listed more than once");
                // It is a mainnet address, and this pool's.
                let script = Address::<NetworkUnchecked>::from_str(a)
                    .unwrap()
                    .assume_checked()
                    .script_pubkey();
                assert_eq!(list().by_script(&script), Some(e.id), "{a}");
                assert_eq!(upstream.by_script(&script), None, "{a}");
                added += 1;
            }
        }
        // MARA Pool's: the `MARA🇺🇸` tag and the address its blocks pay.
        assert_eq!(added, 2);
        let mara = list().by_id(MARA).unwrap();
        assert_eq!(mara.name, "MARA Pool");
        assert_eq!(mara.link, upstream.by_id(MARA).unwrap().link);
        assert_eq!(
            (mara.tags.len(), mara.addresses.len()),
            (4, 5),
            "upstream's three tags and four addresses, and ours"
        );
        assert_eq!(mara.tags[3].as_bytes(), hex("4d415241f09f87baf09f87b8"));
        assert_eq!(list().all().len(), upstream.all().len() + 4);
    }

    #[test]
    fn tag_beats_address() {
        let (p, s1, s2) = sample();
        // Tagged Beta, pays Alpha: Beta's.
        assert_eq!(
            p.attribute(b"/beta/", std::slice::from_ref(&s1)),
            (4, Method::Tag)
        );
        // No listed tag: the first payout that matches decides.
        assert_eq!(
            p.attribute(b"", &[ScriptBuf::new(), s2.clone(), s1.clone()]),
            (4, Method::Address)
        );
        assert_eq!(
            p.attribute(b"/nobody/", std::slice::from_ref(&s1)),
            (3, Method::Address)
        );
        // Tagged Alpha, paying an address not on the list: Alpha's, by tag.
        assert_eq!(
            p.attribute(b"/alpha/", &[ScriptBuf::from_bytes(vec![0x51])]),
            (3, Method::Tag)
        );
    }

    /// A P2Pool block pays its miners from the coinbase; one of them having a listed address
    /// does not take the block.
    #[test]
    fn p2pool_block_paying_a_listed_address_stays_p2pool() {
        let (a1, s1) = p2pkh(1);
        let json = serde_json::json!([
            {"id": 10000, "name": "P2Poolv2", "addresses": [], "tags": ["P2Poolv2"], "link": ""},
            {"id": 10001, "name": "Solo", "addresses": [a1], "tags": ["@solo"], "link": ""},
        ]);
        let p = Pools::parse(&json.to_string()).unwrap();
        let payouts = [ScriptBuf::from_bytes(vec![0x51]), s1];
        assert_eq!(
            p.attribute(b"\x03\x08P2Poolv2", &payouts),
            (10000, Method::Tag)
        );
        assert_eq!(p.attribute(b"", &payouts), (10001, Method::Address));
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

    /// An entry in a later list with the id and name of an earlier list's pool adds to it.
    #[test]
    fn a_later_list_adds_to_a_pool() {
        let (a1, s1) = p2pkh(1);
        let (a2, s2) = p2pkh(2);
        let (a3, s3) = p2pkh(3);
        let first = serde_json::json!([
            {"id": 1, "name": "Alpha", "addresses": [a1], "tags": ["/alpha/"], "link": "a"},
            {"id": 2, "name": "Beta", "addresses": [a2], "tags": ["/beta/"], "link": "b"},
        ])
        .to_string();
        // It adds an address of its own, one Alpha listed first, a tag, and a new pool.
        let second = serde_json::json!([
            {"id": 2, "name": "Beta", "addresses": [a3, a1], "tags": ["B-two"], "link": "ignored"},
            {"id": 3, "name": "Gamma", "addresses": [], "tags": ["/gamma/"], "link": "g"},
        ])
        .to_string();
        let third = serde_json::json!([
            {"id": 2, "name": "Beta", "addresses": [], "tags": ["B-three"], "link": ""},
            {"id": 3, "name": "Gamma", "addresses": [], "tags": ["G-three"], "link": ""},
        ])
        .to_string();
        let p = Pools::parse_all(&[&first, &second, &third]).unwrap();
        assert_eq!(p.all().len(), 4);
        let beta = p.by_id(2).unwrap();
        assert_eq!(p.by_slug("beta"), Some(beta));
        assert_eq!(beta.link, "b");
        assert_eq!(beta.tags, ["/beta/", "B-two", "B-three"]);
        assert_eq!(beta.addresses, [a2, a3, a1.clone()]);
        assert_eq!(p.by_id(3).unwrap().tags, ["/gamma/", "G-three"]);
        assert_eq!(p.by_id(1).unwrap().addresses, [a1]);
        // Added tags and addresses match like the pool's own.
        assert_eq!(p.attribute(b"mined by b-TWO", &[]), (2, Method::Tag));
        assert_eq!(p.attribute(b"B-three", &[]), (2, Method::Tag));
        assert_eq!(p.attribute(b"g-three", &[]), (3, Method::Tag));
        assert_eq!(p.attribute(b"", &[s3]), (2, Method::Address));
        assert_eq!(p.attribute(b"", &[s2]), (2, Method::Address));
        // The first pool to list an address keeps it.
        assert_eq!(p.attribute(b"", &[s1]), (1, Method::Address));
        // The lists alone, and in another order, are other lists.
        let alone = Pools::parse(&first).unwrap();
        assert_eq!(alone.attribute(b"B-two", &[]), (UNKNOWN, Method::None));
        assert_ne!(alone.version(), p.version());
        assert!(Pools::parse(&second).is_ok());
        // The pool added to need not come from the first list.
        assert!(Pools::parse_all(&[&second, &third]).is_ok());
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
        // An id with another name in a later list, even one with the same slug.
        for name in ["B", "a"] {
            let b = format!(r#"[{{"id":1,"name":"{name}","addresses":[],"tags":[],"link":""}}]"#);
            assert!(matches!(
                Pools::parse_all(&[a, &b]),
                Err(ListError::Duplicate(_))
            ));
        }
        // An id and name twice in one list, whether the pool is that list's or an earlier one's.
        let twice = format!("{},{}", a.trim_end_matches(']'), a.trim_start_matches('['));
        assert!(matches!(Pools::parse(&twice), Err(ListError::Duplicate(_))));
        assert!(matches!(
            Pools::parse_all(&[a, &twice]),
            Err(ListError::Duplicate(_))
        ));
        assert!(Pools::parse_all(&[a, a]).is_ok());
        let zero = r#"[{"id":0,"name":"Z","addresses":[],"tags":[],"link":""}]"#;
        assert!(Pools::parse(zero).is_err());
        assert!(matches!(Pools::parse("{"), Err(ListError::Json(_))));
        // Any change to the list changes the version.
        assert_ne!(Pools::parse("[]").unwrap().version(), p.version());
        // Either shipped file changing changes the version.
        assert_ne!(Pools::parse(LIST).unwrap().version(), list().version());
    }
}
