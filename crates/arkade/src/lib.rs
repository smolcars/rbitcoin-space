//! A typed client for an Arkade server's public indexer (arkd's REST gateway), and the one lookup
//! the VTXO page needs: a VTXO, the transactions that would take it on chain, and the batch trees
//! they belong to.
//!
//! Everything the server answers is untrusted (`docs/SECURITY.md`): each answer is size-capped,
//! timed out, decoded into strict types and checked against the caps below. A lookup makes a
//! bounded number of calls, [`MAX_CALLS`], and identical lookups in flight share one; answers are
//! kept for [`KEEP`]. Every route is named here with typed parameters: there is no pass-through.
//! Nothing here verifies the server's claims (signatures, amounts): it reports what arkd says.
//!
//! It also lists an Arkade address's VTXOs ([`Client::list`]), one page at a time: at most
//! [`MAX_LIST_CALLS`] calls a page, shared and kept the same way.

mod address;
mod http;
mod wire;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::hash::Hash;
use std::str::FromStr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

pub use address::{Address, AddressError, MAX_ADDRESS_LEN};
pub use bitcoin::Txid;
use bytes::Bytes;
pub use http::Endpoint;
use hyper::StatusCode;
use serde::Serialize;
use tokio::sync::OnceCell;
use tokio::time::Instant;

/// Transactions read from a VTXO's chain: one page of this many. A longer chain is cut, and says so.
pub const MAX_CHAIN: usize = 128;
/// Inputs read per chain transaction.
pub const MAX_SPENDS: usize = 64;
/// Nodes read per batch tree: one page of this many (256 leaves). A larger tree is not drawn whole.
pub const MAX_TREE_NODES: usize = 512;
/// Commitment transactions whose trees are fetched. Others are counted.
pub const MAX_TREES: usize = 2;
/// Batches tried per commitment transaction while looking for the one this VTXO is in.
pub const MAX_BATCH_TRIES: usize = 2;
/// Commitment txids kept from a VTXO's own list.
pub const MAX_COMMITMENTS: usize = 16;
/// A VTXO's script, in hex characters: 10,000 bytes, the consensus limit for a spendable script.
pub const MAX_SCRIPT_HEX: usize = 20_000;
/// The most calls one lookup makes: the VTXO, the server's info (kept for [`INFO_KEEP`]), its
/// chain, then per tree its commitment and up to [`MAX_BATCH_TRIES`] trees.
pub const MAX_CALLS: usize = 3 + MAX_TREES * (1 + MAX_BATCH_TRIES);
/// How long a lookup's answer, found or not found, is kept.
pub const KEEP: Duration = Duration::from_secs(30);
/// How long the server's info is kept.
pub const INFO_KEEP: Duration = Duration::from_secs(600);
/// A lookup unanswered this long was left by everyone who asked: [`MAX_CALLS`] calls at their
/// timeout take well under it, and a caller gives up sooner still.
pub const STALLED: Duration = Duration::from_secs(120);
/// Lookups kept or in flight at once. Past it, a new outpoint is refused as [`Error::Busy`].
pub const MAX_KEPT: usize = 1024;
/// VTXOs in one page of an address's list, fixed so a client cannot ask for more.
pub const PAGE_SIZE: u32 = 25;
/// The last page an address's list may be asked for: 25,000 VTXOs.
pub const MAX_PAGE: u32 = 1000;
/// The most calls one page of an address's list makes: the server's info (kept for
/// [`INFO_KEEP`]), then the page.
pub const MAX_LIST_CALLS: usize = 2;
/// Signers arkd may list as deprecated; more refuses its info.
pub const MAX_SIGNERS: usize = 16;

/// Body caps per route, in bytes: a little over the largest real answer at the caps above.
const INFO_BYTES: usize = 16 * 1024;
const VTXOS_BYTES: usize = 64 * 1024;
const CHAIN_BYTES: usize = 256 * 1024;
const COMMITMENT_BYTES: usize = 64 * 1024;
const TREE_BYTES: usize = 256 * 1024;
const LIST_BYTES: usize = 256 * 1024;

/// What can go wrong. Carries no upstream text: a client of ours learns only that arkd failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Timeout,
    /// No connection, or it broke.
    Unavailable,
    /// An answer over its route's cap.
    TooBig,
    /// A status other than the route's success.
    Status,
    /// An answer that is not what the route returns, or breaks a cap.
    Decode,
    /// The server says it runs on another chain than the one it is configured for.
    WrongNetwork,
    /// Too many different lookups at once.
    Busy,
}

impl Error {
    /// A fixed label for the log.
    pub fn label(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
            Self::TooBig => "response_too_big",
            Self::Status => "status",
            Self::Decode => "decode",
            Self::WrongNetwork => "wrong_network",
            Self::Busy => "busy",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

impl std::error::Error for Error {}

/// A VTXO's outpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Outpoint {
    pub txid: Txid,
    pub vout: u32,
}

impl FromStr for Outpoint {
    type Err = &'static str;

    /// `txid:vout`: 64 hex digits, a colon, and a decimal output index with no sign or padding.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (txid, vout) = s.split_once(':').ok_or("not txid:vout")?;
        Ok(Self {
            txid: wire::parse_txid(txid).ok_or("not a txid")?,
            vout: parse_vout(vout).ok_or("not an output index")?,
        })
    }
}

/// A decimal `u32` with no sign and no leading zero.
pub fn parse_vout(s: &str) -> Option<u32> {
    let canonical = !s.is_empty()
        && s.len() <= 10
        && s.bytes().all(|b| b.is_ascii_digit())
        && (s == "0" || !s.starts_with('0'));
    canonical.then(|| s.parse().ok()).flatten()
}

/// Exactly 64 hex digits.
pub fn parse_txid(s: &str) -> Option<Txid> {
    wire::parse_txid(s)
}

/// Everything the page shows, as arkd reported it.
#[derive(Debug, Clone, Serialize)]
pub struct Lookup {
    pub vtxo: Vtxo,
    pub server: Server,
    /// The transactions that take this VTXO on chain, as arkd lists them: the VTXO's own first,
    /// the commitment transactions last.
    pub chain: Vec<ChainTx>,
    /// False when the chain was longer than [`MAX_CHAIN`] and is cut.
    pub chain_complete: bool,
    /// The batches this VTXO's chain starts from, at most [`MAX_TREES`].
    pub batches: Vec<Batch>,
    /// Commitment transactions in the chain whose batches were not fetched.
    pub batches_omitted: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Vtxo {
    pub txid: Txid,
    pub vout: u32,
    pub amount: u64,
    /// The output script, hex.
    pub script: String,
    /// Unix seconds.
    pub created_at: i64,
    pub expires_at: i64,
    /// Created off chain by a transfer, not yet in a commitment transaction of its own.
    pub preconfirmed: bool,
    pub swept: bool,
    /// Being taken on chain.
    pub unrolled: bool,
    pub spent: bool,
    pub spent_by: Option<Txid>,
    pub settled_by: Option<Txid>,
    pub ark_txid: Option<Txid>,
    pub commitment_txids: Vec<Txid>,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Server {
    /// Hex, as arkd sends it.
    pub signer_pubkey: String,
    /// The wait after a unilateral exit, in seconds.
    pub exit_delay_secs: u64,
    /// The x-only keys an address of this server may name: its signer's, then those it lists as
    /// deprecated.
    #[serde(skip)]
    pub signers: Vec<[u8; 32]>,
}

/// One page of an address's VTXOs, as arkd lists them (newest first).
#[derive(Debug, Clone, Serialize)]
pub struct Listing {
    /// The page, from 1.
    pub page: u32,
    /// How many pages arkd says the list has: 0 when it is empty.
    pub pages: u32,
    pub vtxos: Vec<Vtxo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Commitment,
    Tree,
    Checkpoint,
    /// An off-chain transfer.
    Ark,
    /// A type this client does not know.
    Other,
}

impl Kind {
    fn parse(s: &str) -> Self {
        match s {
            "INDEXER_CHAINED_TX_TYPE_COMMITMENT" => Self::Commitment,
            "INDEXER_CHAINED_TX_TYPE_TREE" => Self::Tree,
            "INDEXER_CHAINED_TX_TYPE_CHECKPOINT" => Self::Checkpoint,
            "INDEXER_CHAINED_TX_TYPE_ARK" => Self::Ark,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChainTx {
    pub txid: Txid,
    pub kind: Kind,
    pub expires_at: i64,
    /// The chain transactions this one spends.
    pub spends: Vec<Txid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Batch {
    pub commitment: Txid,
    pub vout: u32,
    /// When the round that made it started and ended, unix seconds.
    pub started_at: i64,
    pub ended_at: i64,
    pub expires_at: i64,
    pub vtxos: u32,
    pub amount: u64,
    pub swept: bool,
    /// The whole tree, its root first; `None` when it is larger than [`MAX_TREE_NODES`] or
    /// malformed.
    pub tree: Option<Vec<TreeNode>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeNode {
    pub txid: Txid,
    /// The transactions spending its outputs, in output order.
    pub children: Vec<Txid>,
}

type Shared<V> = Arc<OnceCell<Result<V, Error>>>;

struct Slot<V> {
    cell: Shared<V>,
    born: Instant,
}

/// Answers by key: identical asks in flight share one, an answer is kept for [`KEEP`], a failure
/// is not kept, and at most [`MAX_KEPT`] are held.
struct Kept<K, V> {
    map: Mutex<HashMap<K, Slot<V>>>,
}

impl<K: Copy + Eq + Hash, V: Clone> Kept<K, V> {
    fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    async fn get<F: Future<Output = Result<V, Error>>>(
        &self,
        key: K,
        fetch: impl FnOnce() -> F,
    ) -> Result<V, Error> {
        let cell = self.slot(key)?;
        let answer = cell.get_or_init(fetch).await.clone();
        if answer.is_err() {
            self.forget(key, &cell);
        }
        answer
    }

    /// Drops `key`'s slot if it is still `cell`.
    fn forget(&self, key: K, cell: &Shared<V>) {
        let mut kept = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        if kept.get(&key).is_some_and(|s| Arc::ptr_eq(&s.cell, cell)) {
            kept.remove(&key);
        }
    }

    fn slot(&self, key: K) -> Result<Shared<V>, Error> {
        let now = Instant::now();
        let mut kept = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        // A lookup still unanswered after `STALLED` was abandoned by every caller (each call times
        // out long before), so its slot goes like an old answer's.
        let fresh = |s: &Slot<V>| {
            now.duration_since(s.born) < if s.cell.initialized() { KEEP } else { STALLED }
        };
        if let Some(s) = kept.get(&key).filter(|s| fresh(s)) {
            return Ok(Arc::clone(&s.cell));
        }
        if !kept.contains_key(&key) && kept.len() >= MAX_KEPT {
            kept.retain(|_, s| fresh(s));
            if kept.len() >= MAX_KEPT {
                return Err(Error::Busy);
            }
        }
        let cell = Shared::default();
        kept.insert(
            key,
            Slot {
                cell: Arc::clone(&cell),
                born: now,
            },
        );
        Ok(cell)
    }
}

/// One Arkade server.
pub struct Client {
    transport: http::Transport,
    /// Whether this network is Bitcoin's main chain, which arkd calls `bitcoin`.
    mainnet: bool,
    info: tokio::sync::Mutex<Option<(Instant, Server)>>,
    kept: Kept<Outpoint, Option<Arc<Lookup>>>,
    /// Pages of address lists, by the address and the page; `None` for another server's address.
    lists: Kept<(Address, u32), Option<Arc<Listing>>>,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client").finish_non_exhaustive()
    }
}

impl Client {
    /// `timeout` bounds each call; `user_agent` names us to the server (some refuse a missing or
    /// generic one).
    pub fn new(
        endpoint: &Endpoint,
        mainnet: bool,
        timeout: Duration,
        user_agent: &'static str,
    ) -> Result<Self, Error> {
        let transport =
            http::Transport::new(endpoint, timeout, user_agent).map_err(|_| Error::Unavailable)?;
        Ok(Self {
            transport,
            mainnet,
            info: tokio::sync::Mutex::new(None),
            kept: Kept::new(),
            lists: Kept::new(),
        })
    }

    /// Whether this client's server is on Bitcoin's main chain, so its addresses start `ark`.
    pub fn mainnet(&self) -> bool {
        self.mainnet
    }

    /// The page's lookup: `None` when arkd knows no such VTXO. Shared with identical lookups in
    /// flight and kept for [`KEEP`]; a failure is not kept.
    pub async fn lookup(&self, outpoint: Outpoint) -> Result<Option<Arc<Lookup>>, Error> {
        self.kept.get(outpoint, || self.fetch(outpoint)).await
    }

    /// One page of `address`'s VTXOs, from 1 to [`MAX_PAGE`] (clamped): `None` when the address
    /// names another server's signer, which is then not asked. At most [`MAX_LIST_CALLS`] calls;
    /// shared and kept as [`Client::lookup`] is.
    pub async fn list(&self, address: &Address, page: u32) -> Result<Option<Arc<Listing>>, Error> {
        let page = page.clamp(1, MAX_PAGE);
        self.lists
            .get((*address, page), || self.list_page(address, page))
            .await
    }

    /// The server's info, then `GET /v1/indexer/vtxos?scripts=`, one page of [`PAGE_SIZE`], unless
    /// the address names another server. Every VTXO must pay to the address's script.
    async fn list_page(&self, address: &Address, page: u32) -> Result<Option<Arc<Listing>>, Error> {
        if !self.info().await?.signers.contains(&address.server_key) {
            return Ok(None);
        }
        let script = address.script_hex();
        let path =
            format!("/v1/indexer/vtxos?scripts={script}&page.size={PAGE_SIZE}&page.index={page}");
        let raw: wire::Vtxos = self.json(&path, LIST_BYTES).await?;
        if raw.vtxos.len() > PAGE_SIZE as usize {
            return Err(Error::Decode);
        }
        let mut vtxos = Vec::with_capacity(raw.vtxos.len());
        for v in raw.vtxos {
            let v = convert(v)?;
            if v.script != script {
                return Err(Error::Decode);
            }
            vtxos.push(v);
        }
        let pages = raw.page.map_or(0, |p| u32::try_from(p.total).unwrap_or(0));
        Ok(Some(Arc::new(Listing { page, pages, vtxos })))
    }

    async fn fetch(&self, outpoint: Outpoint) -> Result<Option<Arc<Lookup>>, Error> {
        let Some(vtxo) = self.vtxo(outpoint).await? else {
            return Ok(None);
        };
        let server = self.info().await?;
        let (chain, chain_complete) = self.chain(outpoint).await?;
        let mut commitments: Vec<Txid> = Vec::new();
        let listed = chain
            .iter()
            .filter(|t| t.kind == Kind::Commitment)
            .map(|t| t.txid);
        for txid in listed.chain(vtxo.commitment_txids.iter().copied()) {
            if !commitments.contains(&txid) {
                commitments.push(txid);
            }
        }
        let mut batches = Vec::new();
        for &commitment in commitments.iter().take(MAX_TREES) {
            if let Some(batch) = self.batch(commitment, &chain).await? {
                batches.push(batch);
            }
        }
        Ok(Some(Arc::new(Lookup {
            vtxo,
            server,
            chain,
            chain_complete,
            batches,
            batches_omitted: commitments.len().saturating_sub(MAX_TREES),
        })))
    }

    /// The batch of `commitment` that this chain's tree starts from, with its tree when it is
    /// small enough. A commitment with several batches is searched, at most [`MAX_BATCH_TRIES`].
    async fn batch(&self, commitment: Txid, chain: &[ChainTx]) -> Result<Option<Batch>, Error> {
        let roots: HashSet<Txid> = chain
            .iter()
            .filter(|t| t.kind == Kind::Tree && t.spends.contains(&commitment))
            .map(|t| t.txid)
            .collect();
        let found = self.commitment(commitment).await?;
        let mut first = None;
        for (vout, b) in found.batches.iter().take(MAX_BATCH_TRIES) {
            let tree = self.tree(commitment, *vout).await?;
            let matches = tree
                .as_ref()
                .and_then(|t| t.first())
                .is_some_and(|root| roots.contains(&root.txid));
            let batch = Batch {
                commitment,
                vout: *vout,
                started_at: found.started_at,
                ended_at: found.ended_at,
                expires_at: b.expires_at,
                vtxos: b.total_output_vtxos,
                amount: b.total_output_amount,
                swept: b.swept,
                tree,
            };
            if matches || found.batches.len() == 1 {
                return Ok(Some(batch));
            }
            if first.is_none() {
                first = Some(Batch {
                    tree: None,
                    ..batch
                });
            }
        }
        Ok(first)
    }

    /// `GET /v1/info`, kept for [`INFO_KEEP`].
    pub async fn info(&self) -> Result<Server, Error> {
        let mut info = self.info.lock().await;
        if let Some((at, server)) = info.as_ref()
            && at.elapsed() < INFO_KEEP
        {
            return Ok(server.clone());
        }
        let raw: wire::Info = self.json("/v1/info", INFO_BYTES).await?;
        if (raw.network == "bitcoin") != self.mainnet {
            return Err(Error::WrongNetwork);
        }
        let key = raw.signer_pubkey;
        let hexish = |k: &str| k.len() <= 130 && k.bytes().all(|b| b.is_ascii_hexdigit());
        if !hexish(&key)
            || raw.deprecated_signers.len() > MAX_SIGNERS
            || !raw.deprecated_signers.iter().all(|d| hexish(&d.pubkey))
        {
            return Err(Error::Decode);
        }
        // A key that is not one an address can name is left out: no address matches it.
        let signers = std::iter::once(key.as_str())
            .chain(raw.deprecated_signers.iter().map(|d| d.pubkey.as_str()))
            .filter_map(address::x_only)
            .collect();
        let server = Server {
            signer_pubkey: key,
            exit_delay_secs: raw.unilateral_exit_delay,
            signers,
        };
        *info = Some((Instant::now(), server.clone()));
        Ok(server)
    }

    /// `GET /v1/indexer/vtxos?outpoints=`, for one outpoint. `None` when arkd lists none.
    pub async fn vtxo(&self, outpoint: Outpoint) -> Result<Option<Vtxo>, Error> {
        let path = format!(
            "/v1/indexer/vtxos?outpoints={}:{}",
            outpoint.txid, outpoint.vout
        );
        let raw: wire::Vtxos = self.json(&path, VTXOS_BYTES).await?;
        raw.vtxos
            .into_iter()
            .find(|v| v.outpoint.txid == outpoint.txid && v.outpoint.vout == outpoint.vout)
            .map(convert)
            .transpose()
    }

    /// `GET /v1/indexer/vtxo/{txid}/{vout}/chain`, its first page of [`MAX_CHAIN`]. True when that
    /// page is the whole chain.
    pub async fn chain(&self, outpoint: Outpoint) -> Result<(Vec<ChainTx>, bool), Error> {
        let path = format!(
            "/v1/indexer/vtxo/{}/{}/chain?page.size={MAX_CHAIN}&page.index=1",
            outpoint.txid, outpoint.vout
        );
        let raw: wire::Chain = self.json(&path, CHAIN_BYTES).await?;
        if raw.chain.len() > MAX_CHAIN || raw.chain.iter().any(|t| t.spends.len() > MAX_SPENDS) {
            return Err(Error::Decode);
        }
        let complete = raw.page.is_none_or(|p| p.total <= p.current);
        let chain = raw
            .chain
            .into_iter()
            .map(|t| ChainTx {
                txid: t.txid,
                kind: Kind::parse(&t.kind),
                expires_at: t.expires_at,
                spends: t.spends,
            })
            .collect();
        Ok((chain, complete))
    }

    /// `GET /v1/indexer/commitmentTx/{txid}`: its batches by output index.
    async fn commitment(&self, txid: Txid) -> Result<Commitment, Error> {
        let raw: wire::Commitment = self
            .json(
                &format!("/v1/indexer/commitmentTx/{txid}"),
                COMMITMENT_BYTES,
            )
            .await?;
        let mut batches = Vec::with_capacity(raw.batches.len().min(MAX_BATCH_TRIES));
        for (vout, b) in raw.batches {
            batches.push((parse_vout(&vout).ok_or(Error::Decode)?, b));
        }
        batches.sort_by_key(|(vout, _)| *vout);
        Ok(Commitment {
            started_at: raw.started_at,
            ended_at: raw.ended_at,
            batches,
        })
    }

    /// `GET /v1/indexer/batch/{txid}/{vout}/tree`, one page of [`MAX_TREE_NODES`], put in order
    /// from its root ([`order_tree`]). `None` when the tree is larger or is not one tree.
    async fn tree(&self, txid: Txid, vout: u32) -> Result<Option<Vec<TreeNode>>, Error> {
        let path =
            format!("/v1/indexer/batch/{txid}/{vout}/tree?page.size={MAX_TREE_NODES}&page.index=1");
        let raw: wire::Tree = self.json(&path, TREE_BYTES).await?;
        if raw.vtxo_tree.len() > MAX_TREE_NODES {
            return Err(Error::Decode);
        }
        if raw.page.is_some_and(|p| p.total > p.current) {
            return Ok(None);
        }
        let mut nodes = Vec::with_capacity(raw.vtxo_tree.len());
        for n in raw.vtxo_tree {
            let mut children = Vec::with_capacity(n.children.len());
            for (vout, child) in n.children {
                children.push((parse_vout(&vout).ok_or(Error::Decode)?, child.0));
            }
            children.sort_by_key(|(vout, _)| *vout);
            nodes.push(TreeNode {
                txid: n.txid,
                children: children.into_iter().map(|(_, t)| t).collect(),
            });
        }
        Ok(order_tree(nodes))
    }

    async fn json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        max_body: usize,
    ) -> Result<T, Error> {
        let (status, body): (StatusCode, Bytes) = self.transport.get(path, max_body).await?;
        if status != StatusCode::OK {
            return Err(Error::Status);
        }
        serde_json::from_slice(&body).map_err(|_| Error::Decode)
    }
}

/// A VTXO as arkd sent it, checked against the caps.
fn convert(v: wire::Vtxo) -> Result<Vtxo, Error> {
    let script_ok = v.script.len() <= MAX_SCRIPT_HEX
        && v.script.len().is_multiple_of(2)
        && v.script.bytes().all(|b| b.is_ascii_hexdigit());
    if !script_ok || v.commitment_txids.len() > MAX_COMMITMENTS {
        return Err(Error::Decode);
    }
    Ok(Vtxo {
        txid: v.outpoint.txid,
        vout: v.outpoint.vout,
        amount: v.amount,
        script: v.script.to_ascii_lowercase(),
        created_at: v.created_at,
        expires_at: v.expires_at,
        preconfirmed: v.is_preconfirmed,
        swept: v.is_swept,
        unrolled: v.is_unrolled,
        spent: v.is_spent,
        spent_by: v.spent_by,
        settled_by: v.settled_by,
        ark_txid: v.ark_txid,
        commitment_txids: v.commitment_txids,
        depth: v.depth,
    })
}

struct Commitment {
    started_at: i64,
    ended_at: i64,
    batches: Vec<(u32, wire::Batch)>,
}

/// The nodes in breadth-first order from the one root, or `None` unless they form exactly one
/// tree: one node no other spends, every child a node of the tree, no node reached twice.
pub fn order_tree(nodes: Vec<TreeNode>) -> Option<Vec<TreeNode>> {
    let children: HashSet<Txid> = nodes
        .iter()
        .flat_map(|n| n.children.iter().copied())
        .collect();
    let mut roots = nodes.iter().filter(|n| !children.contains(&n.txid));
    let root = roots.next()?.txid;
    if roots.next().is_some() {
        return None;
    }
    let total = nodes.len();
    let mut by_id: HashMap<Txid, TreeNode> = nodes.into_iter().map(|n| (n.txid, n)).collect();
    if by_id.len() != total {
        return None;
    }
    let mut ordered = Vec::with_capacity(total);
    let mut queue = std::collections::VecDeque::from([root]);
    while let Some(id) = queue.pop_front() {
        let node = by_id.remove(&id)?;
        queue.extend(node.children.iter().copied());
        ordered.push(node);
    }
    by_id.is_empty().then_some(ordered)
}

#[cfg(test)]
mod tests;
