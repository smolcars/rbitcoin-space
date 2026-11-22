//! `GET /app/ark/arkade/vtxo/{txid}/{vout}`: an Arkade VTXO for its page (`docs/FRONTEND.md`).
//!
//! The network's Arkade server (`{NET}_ARKADE_URL`) is asked through the `arkade` crate, which
//! bounds a lookup to [`arkade::MAX_CALLS`] calls, shares identical lookups and keeps answers for
//! [`arkade::KEEP`]. Each transaction of the VTXO's chain is then looked up on our own node, so the
//! page can say which are already on chain: at most [`arkade::MAX_CHAIN`] status reads,
//! [`STATUS_PARALLEL`] at a time, kept for [`STATES_KEEP`] or until the next block.
//!
//! `GET /app/ark/arkade/address/{address}?page=n` lists one page of an Arkade address's VTXOs:
//! the address is parsed for the network first, and only its script reaches arkd, in at most
//! [`arkade::MAX_LIST_CALLS`] calls. It shares this route's limits.
//!
//! What arkd says is reported as it said it; nothing here checks its signatures or amounts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use bitcoin::{BlockHash, Txid};
use serde::Serialize;
use tokio::sync::{OnceCell, Semaphore, SemaphorePermit};

use crate::config::Network;
use crate::limits::{Client, Clients, Refused};
use crate::{ApiError, NetworkContext, esplora};

/// Each call to the Arkade server.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(4);
/// A whole lookup, inside the request's own timeout (10 s by default).
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);
/// This route's requests in progress at once per network; past it, `503`.
pub const MAX_IN_FLIGHT: usize = 16;
/// Per client: a page asks once on opening and again at each block or half minute, so a burst of
/// ten pages, then one every two seconds.
pub const CLIENT_BURST: u32 = 10;
pub const CLIENT_EVERY: Duration = Duration::from_secs(2);
/// Status reads to our node in flight for one lookup.
pub const STATUS_PARALLEL: usize = 8;
/// How long a chain's on-chain states are kept, unless a block arrives first.
pub const STATES_KEEP: Duration = Duration::from_secs(10);
/// Chains whose states are kept.
const MAX_STATES: usize = 1024;

const OFF: ApiError = ApiError::new(StatusCode::NOT_FOUND, "arkade is not available here");
const UNKNOWN: ApiError = ApiError::new(StatusCode::NOT_FOUND, "vtxo not found");
const UPSTREAM_TIMEOUT: ApiError =
    ApiError::new(StatusCode::GATEWAY_TIMEOUT, "arkade did not answer in time");
const UPSTREAM: ApiError = ApiError::new(StatusCode::BAD_GATEWAY, "arkade is not answering");
const BAD_ADDRESS: ApiError = ApiError::bad_request("invalid address");
const OTHER_NETWORK: ApiError = ApiError::bad_request("address is for another network");
const BARK_ADDRESS: ApiError = ApiError::bad_request("bark address");
const UNKNOWN_VERSION: ApiError = ApiError::bad_request("unknown ark address version");
const BAD_PAGE: ApiError = ApiError::bad_request("invalid page");
const FOREIGN: ApiError = ApiError::new(
    StatusCode::UNPROCESSABLE_ENTITY,
    "address belongs to another arkade server",
);

/// Sent to the Arkade server: some refuse a generic or missing one.
const USER_AGENT: &str = concat!("rbitcoin-space/", env!("CARGO_PKG_VERSION"));

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/app/ark/arkade/vtxo/{txid}/{vout}", get(route))
        .route("/app/ark/arkade/address/{address}", get(address_route))
}

/// A network's Arkade side.
pub struct Arkade {
    client: arkade::Client,
    network: Network,
    clients: Arc<Clients>,
    in_flight: Semaphore,
    states: Mutex<HashMap<arkade::Outpoint, Kept>>,
    failures: AtomicU32,
}

impl std::fmt::Debug for Arkade {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Arkade").finish_non_exhaustive()
    }
}

/// One chain's states: kept once read, and shared while being read, so requests that arrive
/// together read the node once.
struct Kept {
    at: Instant,
    tip: Option<BlockHash>,
    /// The chain they are the states of, in order: a changed chain reads again.
    txids: Vec<Txid>,
    states: Arc<OnceCell<Arc<Vec<Option<OnChain>>>>>,
}

impl Arkade {
    pub fn new(
        endpoint: &arkade::Endpoint,
        network: Network,
        max_tracked_clients: usize,
    ) -> Option<Self> {
        let client = arkade::Client::new(
            endpoint,
            network == Network::Mainnet,
            CALL_TIMEOUT,
            USER_AGENT,
        )
        .ok()?;
        Some(Self {
            client,
            network,
            clients: Clients::with_rate(
                1.0 / CLIENT_EVERY.as_secs_f64(),
                CLIENT_BURST,
                max_tracked_clients,
            ),
            in_flight: Semaphore::new(MAX_IN_FLIGHT),
            states: Mutex::new(HashMap::new()),
            failures: AtomicU32::new(0),
        })
    }

    fn failed(&self, e: arkade::Error) {
        let n = self
            .failures
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        if n.is_power_of_two() {
            logging::emit(&logging::events::ArkadeFailed {
                network: self.network.name(),
                error: e.label(),
                failures: n,
            });
        }
    }

    fn worked(&self) {
        let n = self.failures.swap(0, Ordering::Relaxed);
        if n > 0 {
            logging::emit(&logging::events::ArkadeRecovered {
                network: self.network.name(),
                failures: n,
            });
        }
    }
}

/// Where a chain transaction is, as our node sees it.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum OnChain {
    /// The node knows no such transaction: it is still off chain.
    Off,
    Mempool,
    Confirmed {
        height: u32,
    },
}

#[derive(Serialize)]
struct Answer<'a> {
    #[serde(flatten)]
    lookup: &'a arkade::Lookup,
    /// Per chain transaction, in its order: where it is, or `null` when our node did not say.
    onchain: &'a [Option<OnChain>],
}

async fn route(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path((txid, vout)): Path<(String, String)>,
    uri: Uri,
) -> Response {
    answer(&ctx, &client, &txid, &vout, &uri)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

/// Why a request was not answered: an error of ours, or a limit's refusal (which the request log
/// counts as one).
enum Fail {
    Api(ApiError),
    Refused(Refused),
}

impl From<ApiError> for Fail {
    fn from(e: ApiError) -> Self {
        Self::Api(e)
    }
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        match self {
            Self::Api(e) => e.into_response(),
            Self::Refused(r) => r.into_response(),
        }
    }
}

async fn answer(
    ctx: &NetworkContext,
    client: &Client,
    txid: &str,
    vout: &str,
    uri: &Uri,
) -> Result<Response, Fail> {
    let ark = ctx.arkade.as_ref().ok_or(OFF)?;
    if uri.query().is_some() {
        return Err(ApiError::bad_request("unexpected query parameter").into());
    }
    let outpoint = arkade::Outpoint {
        txid: esplora::txid(txid)?,
        vout: arkade::parse_vout(vout).ok_or(ApiError::bad_request("invalid output index"))?,
    };
    // Held through the node's status reads below, so they count against the network's slots too.
    let _slot = admit(ark, client)?;
    let found = ask(ark, ark.client.lookup(outpoint)).await?;
    let lookup = found.ok_or(UNKNOWN)?;
    let onchain = states(ctx, ark, outpoint, &lookup.chain).await;
    let mut res = Json(Answer {
        lookup: &lookup,
        onchain: &onchain,
    })
    .into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

/// Takes a client's token and one of the network's slots, held until the permit is dropped.
fn admit<'a>(ark: &'a Arkade, client: &Client) -> Result<SemaphorePermit<'a>, Fail> {
    ark.clients.take(client.addr).map_err(Fail::Refused)?;
    Ok(ark
        .in_flight
        .try_acquire()
        .map_err(|_| ApiError::OVERLOADED)?)
}

/// Waits for `call` within [`LOOKUP_TIMEOUT`], counting arkd's failures.
async fn ask<T>(
    ark: &Arkade,
    call: impl Future<Output = Result<T, arkade::Error>>,
) -> Result<T, Fail> {
    let found = match tokio::time::timeout(LOOKUP_TIMEOUT, call).await {
        Ok(Ok(found)) => found,
        Ok(Err(arkade::Error::Busy)) => {
            ark.failed(arkade::Error::Busy);
            return Err(ApiError::OVERLOADED.into());
        }
        Ok(Err(e)) => {
            ark.failed(e);
            return Err(UPSTREAM.into());
        }
        Err(_) => {
            ark.failed(arkade::Error::Timeout);
            return Err(UPSTREAM_TIMEOUT.into());
        }
    };
    ark.worked();
    Ok(found)
}

async fn address_route(
    State(ctx): State<Arc<NetworkContext>>,
    Extension(client): Extension<Client>,
    Path(address): Path<String>,
    uri: Uri,
) -> Response {
    list(&ctx, &client, &address, &uri)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn list(
    ctx: &NetworkContext,
    client: &Client,
    address: &str,
    uri: &Uri,
) -> Result<Response, Fail> {
    let ark = ctx.arkade.as_ref().ok_or(OFF)?;
    let page = page(uri.query())?;
    let address = arkade::Address::parse(address, ark.client.mainnet()).map_err(|e| match e {
        arkade::AddressError::OtherNetwork => OTHER_NETWORK,
        arkade::AddressError::Bark => BARK_ADDRESS,
        arkade::AddressError::Version => UNKNOWN_VERSION,
        _ => BAD_ADDRESS,
    })?;
    let _slot = admit(ark, client)?;
    let listing = ask(ark, ark.client.list(&address, page))
        .await?
        .ok_or(FOREIGN)?;
    let mut res = Json(&*listing).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

/// `page=n`, the only query taken: a decimal from 1 to [`arkade::MAX_PAGE`], without sign or
/// padding. None is page 1.
fn page(query: Option<&str>) -> Result<u32, ApiError> {
    let Some(query) = query else { return Ok(1) };
    let n = query
        .strip_prefix("page=")
        .ok_or(ApiError::bad_request("unexpected query parameter"))?;
    arkade::parse_vout(n)
        .filter(|n| (1..=arkade::MAX_PAGE).contains(n))
        .ok_or(BAD_PAGE)
}

/// Each chain transaction's place on our chain, kept for [`STATES_KEEP`] within one tip.
async fn states(
    ctx: &NetworkContext,
    ark: &Arkade,
    outpoint: arkade::Outpoint,
    chain: &[arkade::ChainTx],
) -> Arc<Vec<Option<OnChain>>> {
    let tip = ctx.summaries.tips().borrow().map(|(hash, _)| hash);
    let now = Instant::now();
    // An entry a cancelled request left unread ages out like any other.
    let fresh = |k: &Kept| k.fresh(tip, now);
    let txids: Vec<Txid> = chain.iter().map(|t| t.txid).collect();
    let cell = {
        let mut kept = ark.states.lock().unwrap_or_else(PoisonError::into_inner);
        match kept.get(&outpoint).filter(|k| k.serves(tip, now, &txids)) {
            Some(k) => Arc::clone(&k.states),
            None => {
                let cell = Arc::new(OnceCell::new());
                if kept.len() >= MAX_STATES {
                    kept.retain(|_, k| fresh(k));
                }
                if kept.len() < MAX_STATES {
                    kept.insert(
                        outpoint,
                        Kept {
                            at: now,
                            tip,
                            txids: txids.clone(),
                            states: Arc::clone(&cell),
                        },
                    );
                }
                cell
            }
        }
    };
    let states = cell
        .get_or_init(|| async { Arc::new(read_states(ctx, &txids).await) })
        .await;
    Arc::clone(states)
}

impl Kept {
    /// Within [`STATES_KEEP`] and on the same tip.
    fn fresh(&self, tip: Option<BlockHash>, now: Instant) -> bool {
        self.tip == tip && now.duration_since(self.at) < STATES_KEEP
    }

    /// Fresh, and the states of the same chain in the same order.
    fn serves(&self, tip: Option<BlockHash>, now: Instant, txids: &[Txid]) -> bool {
        self.fresh(tip, now) && self.txids == txids
    }
}

/// Asks the node for each txid's status, [`STATUS_PARALLEL`] at a time, in order.
async fn read_states(ctx: &NetworkContext, txids: &[Txid]) -> Vec<Option<OnChain>> {
    let mut out = vec![None; txids.len()];
    let mut set = tokio::task::JoinSet::new();
    let mut next = txids.iter().copied().enumerate();
    loop {
        while set.len() < STATUS_PARALLEL {
            let Some((i, txid)) = next.next() else { break };
            let esplora = ctx.esplora.clone();
            set.spawn(async move { (i, state(&esplora, txid).await) });
        }
        let Some(done) = set.join_next().await else {
            break;
        };
        if let Ok((i, s)) = done
            && let Some(slot) = out.get_mut(i)
        {
            *slot = s;
        }
    }
    out
}

async fn state(esplora: &node::esplora::Esplora, txid: Txid) -> Option<OnChain> {
    match esplora.tx_status(txid, None).await {
        Ok(s) => Some(match (s.value.confirmed, s.value.block_height) {
            (true, Some(height)) => OnChain::Confirmed { height },
            (true, None) => return None,
            (false, _) => OnChain::Mempool,
        }),
        Err(node::esplora::Error::NotFound) => Some(OnChain::Off),
        Err(_) => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_one_canonical_number_in_bounds() {
        assert_eq!(page(None).ok(), Some(1));
        assert_eq!(page(Some("page=1")).ok(), Some(1));
        assert_eq!(page(Some("page=1000")).ok(), Some(arkade::MAX_PAGE));
        for bad in [
            "",
            "page=",
            "page=0",
            "page=01",
            "page=+2",
            "page=1001",
            "page=2&page=3",
            "page=2&x=1",
            "x=1",
            "PAGE=2",
            "page=%32",
            "page=4294967296",
        ] {
            assert!(page(Some(bad)).is_err(), "{bad}");
        }
    }

    /// Kept states serve only the same chain, in the same order, on the same tip, for a while.
    #[test]
    fn kept_states_serve_only_the_chain_they_were_read_for() {
        let t = |c: char| -> Txid { c.to_string().repeat(64).parse().unwrap() };
        let now = Instant::now();
        let tip = Some("11".repeat(32).parse::<BlockHash>().unwrap());
        let kept = Kept {
            at: now,
            tip,
            txids: vec![t('a'), t('b')],
            states: Arc::new(OnceCell::new()),
        };
        let serves = |tip, at, txids: &[Txid]| kept.serves(tip, at, txids);
        assert!(serves(tip, now, &[t('a'), t('b')]));
        // Same length, other order or other transactions: read again.
        assert!(!serves(tip, now, &[t('b'), t('a')]));
        assert!(!serves(tip, now, &[t('a'), t('c')]));
        assert!(!serves(None, now, &[t('a'), t('b')]));
        assert!(!serves(tip, now + STATES_KEEP, &[t('a'), t('b')]));
    }
}
