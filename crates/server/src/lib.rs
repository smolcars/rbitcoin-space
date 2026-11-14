//! HTTP surface of the rbitcoin.space server.
//!
//! [`App::new`] builds everything: per-network routes from [`network_routes`] mounted under each
//! enabled network's prefix, `/healthz` (liveness), `/readyz` (readiness, [`health`]), the
//! frontend, and the limits around all of it.

pub mod answers;
mod api_v1;
mod app_config;
mod audits;
pub mod blocks;
pub mod config;
pub mod difficulty;
pub mod error;
pub mod esplora;
pub mod health;
mod kept;
pub mod ledger;
pub mod lightning;
pub mod limits;
pub mod mining;
mod pages;
mod refusals;
pub mod relatives;
pub mod replacements;
pub mod report;
pub mod request_log;
mod serve;
pub mod statistics;
pub mod summary;
mod transactions;
mod v1_blocks;
pub mod verdicts;
pub mod ws;

use std::future::Future;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Request};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_MAX_AGE, CACHE_CONTROL, CONTENT_SECURITY_POLICY,
    HeaderName, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router, middleware};
use node::esplora::Esplora;
use serde_json::json;
use tokio::net::TcpListener;
use tower::{Layer, ServiceExt};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

pub use config::{Config, Limits, Network, NetworkConfig, WsLimits};
pub use error::ApiError;
use limits::Limiter;
pub use serve::bind;

/// Sent on every response. The CSP is SECURITY.md rule 15.
pub const SECURITY_HEADERS: [(HeaderName, &str); 4] = [
    (
        CONTENT_SECURITY_POLICY,
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    ),
    (X_CONTENT_TYPE_OPTIONS, "nosniff"),
    (REFERRER_POLICY, "no-referrer"),
    (X_FRAME_OPTIONS, "DENY"),
];

/// The commit this binary was built from, or `unknown` (`build.rs`).
pub const REVISION: &str = env!("SOURCE_REVISION");

/// Vite puts content-hashed files under `/assets/`, so a URL there never changes content.
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// API prefixes inside a network scope. Unmatched paths under them are a JSON 404, never the app
/// shell; inside an enabled network, `/api/{*rest}` is the Esplora pass-through, which does the same.
const API_PATHS: [&str; 6] = [
    "/api",
    "/api/",
    "/api/{*rest}",
    "/app",
    "/app/",
    "/app/{*rest}",
];

/// One enabled network. Handlers in [`network_routes`] receive it as `State<Arc<NetworkContext>>`;
/// later tasks add the other node clients and the engine here.
pub struct NetworkContext {
    pub config: NetworkConfig,
    pub esplora: Esplora,
    /// State of the `/api` pass-through.
    pub api: esplora::Api,
    /// The node's push channel; feeds [`ws::feed`].
    pub electrum: node::electrum::Client,
    /// Read-only JSON-RPC, shared by every caller: at most four calls in flight.
    pub rpc: node::rpc::Rpc,
    /// Which source lists a block's transactions; shared with the block table's backfill.
    pub lister: Arc<engine::blocks::Lister>,
    /// State of the block summary routes.
    pub summaries: summary::Summaries,
    pub hub: Arc<ws::Hub>,
    /// Followed transactions and addresses, and the replacement record.
    pub track: Arc<ws::Tracking>,
    pub sockets: Arc<ws::Sockets>,
    /// Kept current by [`difficulty::run`]; read by `/api/v1/difficulty-adjustment`.
    pub difficulty: difficulty::Difficulty,
    /// The block table, when `DATA_DIR` is set and the file opened.
    pub blocks: Option<blocks::BlockTable>,
    /// `DATA_DIR` is set, so a missing table means the file would not open.
    pub data_dir: bool,
    /// The mining routes' answers, kept current by [`mining::run`].
    pub mining: mining::Mining,
    /// What the last node check found, for `/readyz`; kept by [`health::watch`].
    pub node: health::NodeCheck,
    /// Whether the node has its address index; kept by [`health::watch_address_index`].
    pub address_index: health::AddressIndex,
    /// Fee recommendations and projected-block totals, kept current by `ws::fees`.
    pub fees: ws::fees::Fees,
    pub history: statistics::History,
    /// The mempool.space-shaped socket's own state (`ws::v1`).
    pub v1: Arc<ws::v1::Compat>,
    /// Answers kept until they can change: store-backed routes and immutable node answers.
    pub answers: answers::Answers,
    /// Esplora headers by hash for the `/api/v1` block routes.
    pub block_headers: v1_blocks::Headers,
    /// `/api/v1/replacements` and `/api/v1/fullrbf/replacements`, built once per change.
    pub trees: transactions::Trees,
    /// The Lightning gossip peer, when `{NET}_LIGHTNING_ENABLED` (`lightning`).
    pub lightning: Option<Arc<lightning::Lightning>>,
    /// The guard on large-address joins, and the ledger when there is a store (`ledger`).
    pub guard: Arc<ledger::Guard>,
}

impl std::fmt::Debug for NetworkContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetworkContext")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl NetworkContext {
    /// For tests with no node to confirm the chain: the store takes writes at once.
    #[cfg(test)]
    pub(crate) fn with_open_store(self) -> Self {
        if let Some(t) = &self.blocks {
            t.store.set_gate(engine::store::Gate::Open);
        }
        self
    }

    /// Starts the network's Electrum client, so it must run inside a tokio runtime. With a lane
    /// of its own: the app shares one between its networks.
    #[cfg(test)]
    fn new(config: &NetworkConfig, all: &Config, sockets: &Arc<ws::Sockets>) -> Option<Self> {
        Self::with_lane(
            config,
            all,
            sockets,
            Arc::new(tokio::sync::Semaphore::new(1)),
        )
    }

    fn with_lane(
        config: &NetworkConfig,
        all: &Config,
        sockets: &Arc<ws::Sockets>,
        lane: Arc<tokio::sync::Semaphore>,
    ) -> Option<Self> {
        let url = match &config.esplora {
            config::EsploraEndpoint::Http(url) => url.clone(),
            config::EsploraEndpoint::Unix(path) => path.to_string_lossy().into_owned(),
        };
        let rpc = &config.rpc;
        let electrum = node::electrum::Client::spawn(node::electrum::Config::new(&config.electrum));
        let hub = Arc::new(ws::Hub::new(config.network, Arc::clone(sockets)));
        let track = Arc::new(ws::Tracking::new(
            config.network,
            Arc::clone(&hub),
            Some(electrum.clone()),
            config.mempool,
            &all.ws,
            &all.limits,
        ));
        let lister = Arc::new(summary::lister(config.network));
        let table = all
            .data_dir
            .as_deref()
            .and_then(|dir| blocks::BlockTable::open(dir, config, &url, &lister));
        let api = esplora::Api::new(all.broadcast, &all.limits, &url).ok()?;
        let ledger = table.as_ref().and_then(|t| {
            ledger::Ledger::new(
                Arc::clone(&t.store),
                config,
                &url,
                all.ledger,
                Arc::clone(&lane),
                Arc::clone(&api.verdicts),
                Arc::clone(&track),
            )
            .map(Arc::new)
        });
        let guard = Arc::new(ledger::Guard::new(
            Arc::clone(&api.verdicts),
            lane,
            &url,
            all.limits.history_timeout,
            ledger,
        )?);
        Some(Self {
            guard,
            blocks: table,
            data_dir: all.data_dir.is_some(),
            lister,
            rpc: node::rpc::Rpc::new(&rpc.host, rpc.port, &rpc.user, rpc.password.expose()).ok()?,
            summaries: summary::Summaries::new(
                all.limits.summary_cache_bytes,
                all.limits.max_tracked_clients,
            ),
            config: config.clone(),
            esplora: Esplora::new(&url).ok()?,
            api,
            electrum,
            hub,
            track,
            sockets: Arc::clone(sockets),
            difficulty: difficulty::Difficulty::default(),
            mining: mining::Mining::default(),
            node: health::NodeCheck::default(),
            address_index: health::AddressIndex::default(),
            fees: ws::fees::Fees::default(),
            history: statistics::History::default(),
            v1: Arc::new(ws::v1::Compat::new(Some(&url))),
            answers: answers::Answers::new(all.limits.answer_cache_bytes),
            block_headers: v1_blocks::Headers::default(),
            trees: transactions::Trees::default(),
            lightning: config
                .lightning
                .as_ref()
                .zip(all.data_dir.as_deref())
                .map(|(l, dir)| Arc::new(lightning::Lightning::new(l, dir, config.network))),
        })
    }
}

/// Routes every enabled network serves, written with paths starting `/api` or `/app`. They are
/// mounted at the root for mainnet and under `/signet`, `/testnet4` and `/regtest` for the others.
pub fn network_routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/app/ws", get(ws::handle))
        .route("/api/v1/ws", get(ws::v1::handle))
        .route("/app/block/{hash}/summary", get(summary::facts))
        .route("/app/block/{hash}/txs", get(summary::txs))
        .route("/app/blocks/summary", get(summary::batch))
        .route("/app/tx/{txid}/relatives", get(relatives::route))
        .route("/app/tx/{txid}/replacements", get(replacements::route))
        .route("/app/fees/score", get(ws::fees::score::route))
        .route("/app/address/{address}/size", get(verdicts::size_route))
        .route("/app/address/{address}/ledger", get(ledger::route))
        .merge(statistics::app_routes())
        .merge(api_v1::routes())
        .merge(audits::routes())
        .merge(transactions::routes())
        .merge(lightning::routes())
}

/// The whole application, ready to serve.
#[derive(Debug, Clone)]
pub struct App {
    router: Router,
    limiter: Limiter,
    sockets: Arc<ws::Sockets>,
    /// Stopped after the last request, so each peer writes its graph.
    lightning: Vec<Arc<lightning::Lightning>>,
    networks: Vec<Arc<NetworkContext>>,
    /// Summarised once more at shutdown, so the last window's refusals are not lost.
    refusals: Arc<refusals::Refusals>,
    log_client_addr: bool,
}

impl App {
    pub fn new(config: &Config) -> Self {
        Self::with_routes(config, network_routes())
    }

    /// Like [`App::new`] with other per-network routes. Tests use it to mount probe handlers.
    pub fn with_routes(config: &Config, routes: Router<Arc<NetworkContext>>) -> Self {
        let mut app = Router::new()
            .route("/healthz", get(healthz))
            .merge(app_config::routes(config));
        let sockets = ws::Sockets::new(&config.ws, config.limits.request_timeout);
        // One large-address join at the node at a time, for the whole server (`ledger`).
        let lane = Arc::new(tokio::sync::Semaphore::new(1));
        let mut enabled_networks = Vec::new();
        let mut peers = Vec::new();
        for network in Network::ALL {
            let prefix = network.path_prefix();
            let context = config
                .networks
                .iter()
                .find(|n| n.network == network)
                // Cannot fail: `Config` checked the endpoints by the clients' own rules.
                .and_then(|n| NetworkContext::with_lane(n, config, &sockets, Arc::clone(&lane)));
            let enabled = context.is_some();
            let scope = match context {
                Some(ctx) => {
                    let ctx = Arc::new(ctx);
                    enabled_networks.push(Arc::clone(&ctx));
                    tokio::spawn(health::watch(Arc::clone(&ctx)));
                    let events = ctx.electrum.events();
                    tokio::spawn(ws::feed(Arc::clone(&ctx), events));
                    tokio::spawn(summary::worker(Arc::clone(&ctx)));
                    tokio::spawn(difficulty::run(Arc::clone(&ctx), ctx.electrum.events()));
                    blocks::spawn(&ctx, config.backfill);
                    ledger::spawn(&ctx);
                    ctx.track
                        .set_gate(Arc::clone(&ctx.guard) as Arc<dyn ws::track::AddressGate>);
                    ws::mempool::start(&ctx);
                    tokio::spawn(mining::run(Arc::clone(&ctx)));
                    tokio::spawn(ws::v1::run(Arc::clone(&ctx)));
                    tokio::spawn(ws::track::follow_addresses(
                        Arc::clone(&ctx.track),
                        ctx.electrum.events(),
                        ctx.electrum.health(),
                    ));
                    report::report_electrum(network, &ctx.electrum);
                    lightning::spawn(&ctx);
                    peers.extend(ctx.lightning.clone());
                    tokio::spawn(summary::detect_routes(Arc::clone(&ctx)));
                    tokio::spawn(health::watch_address_index(Arc::clone(&ctx)));
                    routes
                        .clone()
                        .route_layer(middleware::from_fn_with_state(
                            Arc::clone(&ctx),
                            answers::keep,
                        ))
                        .route("/api/{*rest}", any(esplora::handle))
                        .route(
                            "/api/tx",
                            any(esplora::handle)
                                .layer(DefaultBodyLimit::max(esplora::MAX_BROADCAST_BODY)),
                        )
                        .with_state(ctx)
                }
                None if prefix.is_empty() => Router::new(),
                None => {
                    // A disabled network has no pages either.
                    for path in [
                        prefix.to_owned(),
                        format!("{prefix}/"),
                        format!("{prefix}/{{*rest}}"),
                    ] {
                        app = app.route(&path, any(not_found));
                    }
                    continue;
                }
            };
            let scope = API_PATHS
                .iter()
                .filter(|p| !(enabled && **p == "/api/{*rest}"))
                .fold(scope, |r, p| r.route(p, any(not_found)));
            app = if prefix.is_empty() {
                app.merge(scope)
            } else {
                app.nest(prefix, scope)
            };
        }
        let pages = Arc::new(pages::Pages::new(&config.web_dir, enabled_networks.clone()));
        let contexts = enabled_networks.clone();
        let networks = Arc::new(enabled_networks);
        app = app.route(
            "/readyz",
            get(move || {
                let networks = Arc::clone(&networks);
                async move { health::readyz(&networks) }
            }),
        );
        // `/<anything>/api/...` is an API call for a network we do not know, never a page.
        for path in API_PATHS {
            app = app.route(&format!("/{{network}}{path}"), any(not_found));
        }

        let dir = &config.web_dir;
        let assets_dir = dir.join("assets");
        let assets = ServeDir::new(&assets_dir)
            .precompressed_br()
            .precompressed_gzip();
        // A non-JSON 404, so `finish` replaces it whole and it loses the `immutable` header.
        let assets = tower::service_fn(move |req: Request| {
            let (assets, unservable) = (assets.clone(), too_long(&assets_dir, req.uri().path()));
            async move {
                if unservable {
                    return Ok(axum::http::StatusCode::NOT_FOUND.into_response());
                }
                assets.oneshot(req).await.map(IntoResponse::into_response)
            }
        });
        // ServeDir rejects `..` and absolute components, so nothing outside web_dir is reachable.
        // A path that is no file, `/` included, is a page: the shell with its head ([`pages`]).
        let page = axum::handler::Handler::with_state(pages::page, pages);
        let files = ServeDir::new(dir)
            .precompressed_br()
            .precompressed_gzip()
            .append_index_html_on_directories(false)
            .fallback(page.clone());
        let web_dir = dir.clone();
        let pages = tower::service_fn(move |req: Request| {
            let (files, page) = (files.clone(), page.clone());
            let unservable = too_long(&web_dir, req.uri().path());
            async move {
                if unservable {
                    return page.oneshot(req).await;
                }
                files.oneshot(req).await.map(IntoResponse::into_response)
            }
        });
        let cache =
            |v| SetResponseHeaderLayer::overriding(CACHE_CONTROL, HeaderValue::from_static(v));

        let limiter = Limiter::new(&config.limits, config.log_client_addr);
        let refusals = Arc::clone(&sockets.refusals);
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::spawn(refusals::report(
                Arc::clone(&refusals),
                config.log_client_addr,
            ));
        }
        let router = app
            .nest_service("/assets", cache(IMMUTABLE).layer(assets))
            // Pages and unhashed files are revalidated on every load, so a deploy shows at once.
            // A page's head varies by its URL alone, which every cache keys on.
            .fallback_service(cache("no-cache").layer(pages))
            .layer(DefaultBodyLimit::max(config.limits.max_body_bytes))
            .layer(middleware::from_fn_with_state(
                Arc::new(limiter.clone()),
                limits::limit,
            ))
            .layer(middleware::map_response(finish))
            .layer(middleware::from_fn(cors))
            .layer(middleware::from_fn_with_state(
                request_log::RequestLogger::new(config, Arc::clone(&refusals)),
                request_log::log_request,
            ));
        Self {
            router,
            limiter,
            sockets,
            lightning: peers,
            networks: contexts,
            refusals,
            log_client_addr: config.log_client_addr,
        }
    }

    /// The router alone, for driving with `tower::ServiceExt::oneshot`. Requests must carry a
    /// `ConnectInfo<SocketAddr>` extension, as [`App::serve`] adds.
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    /// Each enabled network's Lightning side. Tests use it to serve a graph they built.
    #[doc(hidden)]
    pub fn lightning(&self) -> &[Arc<lightning::Lightning>] {
        &self.lightning
    }

    /// An enabled network's context. Tests use it to write through the server's own store (a
    /// write from another connection does not move the versions kept answers follow) and to
    /// look at its caches.
    #[doc(hidden)]
    pub fn network(&self, network: Network) -> Option<Arc<NetworkContext>> {
        self.networks
            .iter()
            .find(|n| n.config.network == network)
            .cloned()
    }

    /// WebSocket state shared by every network.
    pub fn sockets(&self) -> &Arc<ws::Sockets> {
        &self.sockets
    }

    /// Serves until `shutdown` resolves. Then open requests get the request timeout to finish,
    /// and open WebSockets are sent a close frame and get the same time, counted from the signal.
    pub async fn serve(self, listener: TcpListener, shutdown: impl Future<Output = ()>) {
        let sockets = self.sockets;
        let signal = async {
            shutdown.await;
            sockets.close_all();
        };
        let early = Arc::new(serve::Early {
            limiter: self.limiter,
            refusals: Arc::clone(&self.refusals),
        });
        serve::serve(listener, self.router, early, signal).await;
        sockets.drain().await;
        if let Some(summary) = self.refusals.roll(std::time::Instant::now()) {
            summary.emit(self.log_client_addr);
        }
        for l in &self.lightning {
            l.stop().await;
        }
    }
}

/// Whether `path` names no file under `dir` because it is too long to be one: a segment over 255
/// bytes, or the whole over 1024 (macOS's `PATH_MAX`; Linux allows 4096), counting the `.br` or
/// `.gz` that `ServeDir` adds for a compressed variant. The file system answers those with an
/// error, which `ServeDir` turns into a 500, rather than "not found". The raw path is never
/// shorter than the one `ServeDir` decodes, so this errs towards "too long".
fn too_long(dir: &std::path::Path, path: &str) -> bool {
    const SUFFIX: usize = ".br".len();
    dir.as_os_str().len() + path.len() + SUFFIX >= 1024
        || path.split('/').any(|s| s.len() + SUFFIX > 255)
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "revision": REVISION,
    }))
}

pub(crate) async fn not_found() -> ApiError {
    ApiError::NOT_FOUND
}

/// Whether `path` is under some network's `/api`.
pub(crate) fn is_api(path: &str) -> bool {
    Network::ALL.iter().any(|n| {
        path.strip_prefix(n.path_prefix())
            .is_some_and(|rest| rest == "/api" || rest.starts_with("/api/"))
    })
}

/// `/api` is a public API that web wallets call from other origins. Nothing in it depends on
/// cookies or other ambient credentials, so any origin may read it, broadcast included. Outermost,
/// so refusals from the limits (429, 503, 504) are readable cross-origin too. A preflight is
/// answered by [`limits::limit`] once admitted under its own limits; here it gets its headers.
async fn cors(req: Request, next: Next) -> Response {
    if !is_api(req.uri().path()) {
        return next.run(req).await;
    }
    let preflight = req.method() == Method::OPTIONS;
    let mut res = next.run(req).await;
    let preflight = preflight && res.extensions().get::<limits::Refused>().is_none();
    api_headers(res.headers_mut(), preflight);
    res
}

fn api_headers(h: &mut HeaderMap, preflight: bool) {
    h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    if preflight {
        h.insert(
            ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, HEAD, POST"),
        );
        h.insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type"),
        );
        h.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    } else {
        h.insert(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static(
                "X-Bitcoin-Chain-Tip, X-Bitcoin-Chain-Tip-Height, X-Request-Id, X-Data-From-Height, \
                 X-Data-From-Time, X-Data-Complete, X-Fee-Source",
            ),
        );
    }
    // Errors and refusals must not be cached: the same URL can succeed a moment later.
    if !h.contains_key(CACHE_CONTROL) {
        h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
}

/// A request the limits refused before routing gets the response the router would have sent
/// (`finish`, `cors`, the request id), built without routing it.
fn refused_early(path: &str, refused: limits::Refused) -> Response {
    let mut res = finished(refused.into_response());
    if is_api(path) {
        api_headers(res.headers_mut(), false);
    }
    if let Ok(id) = HeaderValue::from_str(&request_log::request_id()) {
        res.headers_mut().insert(request_log::REQUEST_ID, id);
    }
    res
}

/// Last step for every response: errors through the error model, then the security headers.
/// An error is `no-store` unless its route said otherwise: the same URL can succeed a moment later.
async fn finish(res: Response) -> Response {
    finished(res)
}

fn finished(res: Response) -> Response {
    let mut res = error::sanitize(res);
    let failed = res.status().is_client_error() || res.status().is_server_error();
    let headers = res.headers_mut();
    for (name, value) in SECURITY_HEADERS {
        headers.insert(name, HeaderValue::from_static(value));
    }
    if failed && !headers.contains_key(CACHE_CONTROL) {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}
