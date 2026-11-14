//! One `http_request` event per request served, and an `X-Request-Id` on every response
//! (`docs/LOGGING.md`). A refused request is counted in [`Refusals`] instead, so a client cannot
//! choose how much we write; the first of each reason after a quiet minute is still written.
//!
//! The event names the matched route template, never the raw path or query: a path says which
//! address or transaction someone looked up, and the log must not become a record of that.

use std::hash::BuildHasher;
use std::hash::RandomState;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use axum::body::HttpBody;
use axum::extract::{ConnectInfo, MatchedPath, Request, State};
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use logging::events::HttpRequest;

use crate::config::{Config, Network, RequestLog, TrustedProxy};
use crate::esplora::{ApiOutcome, Source};
use crate::limits::{Counted, Refused, client_addr};
use crate::refusals::{Refusal, Refusals};

pub const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// Route label for everything the frontend fallback serves: pages, the app shell, static files.
const FRONTEND: &str = "frontend";

/// Settings and state for [`log_request`]. Cloned per request, so behind one pointer.
#[derive(Debug, Clone)]
pub struct RequestLogger(Arc<Inner>);

#[derive(Debug)]
struct Inner {
    mode: RequestLog,
    client_addr: bool,
    trusted_proxy: Option<TrustedProxy>,
    refusals: Arc<Refusals>,
}

impl RequestLogger {
    pub fn new(config: &Config, refusals: Arc<Refusals>) -> Self {
        Self(Arc::new(Inner {
            mode: config.log_requests,
            client_addr: config.log_client_addr,
            trusted_proxy: config.limits.trusted_proxy.clone(),
            refusals,
        }))
    }
}

/// Outermost middleware: times the request, tags the response with its id and records it.
pub async fn log_request(State(log): State<RequestLogger>, req: Request, next: Next) -> Response {
    let log = &*log.0;
    let started = Instant::now();
    let id = request_id();
    let method = req.method().clone();
    let route = req.extensions().get::<MatchedPath>().cloned();
    let route = route.as_ref().map_or(FRONTEND, MatchedPath::as_str);
    let network = network(req.uri().path(), route);
    let client = log
        .client_addr
        .then(|| {
            let peer = req.extensions().get::<ConnectInfo<SocketAddr>>()?.0;
            let addr = client_addr(req.headers(), peer.ip(), log.trusted_proxy.as_ref());
            Some(addr.to_string())
        })
        .flatten();

    let path = req.uri().clone();
    let mut res = next.run(req).await;
    if let Ok(v) = HeaderValue::from_str(&id) {
        res.headers_mut().insert(REQUEST_ID, v);
    }
    // A refusal is counted; only the first of its reason after a quiet window goes on.
    // A timeout is not one: the request was admitted and its work ran.
    if let Some(r) = res.extensions().get::<Refused>()
        && r.reason != "timeout"
    {
        let who = res
            .extensions()
            .get::<Refusal>()
            .copied()
            .unwrap_or(Refusal {
                client: std::net::Ipv4Addr::UNSPECIFIED.into(),
                untrusted_forwarded: false,
                proxy_keyed: false,
            });
        // `serve` counted it already when it chose to route it, to be written here.
        let counted = res.extensions().get::<Counted>().is_some();
        if !counted && !log.refusals.record(r.reason, path.path(), who) {
            return res;
        }
    }
    let status = res.status();
    let failed = status.is_client_error() || status.is_server_error();
    let wanted = match log.mode {
        RequestLog::All => true,
        RequestLog::Failures => failed,
        RequestLog::Off => false,
    };
    // Health checks poll constantly; only a failing one is news.
    if !wanted || (matches!(route, "/healthz" | "/readyz") && !failed) {
        return res;
    }
    let outcome = res.extensions().get::<ApiOutcome>().copied();
    let (source, upstream_ms) = match outcome.map(|o| o.source) {
        Some(Source::Upstream(d)) => (Some("upstream"), Some(ms(d.as_micros()))),
        Some(Source::Coalesced) => (Some("coalesced"), None),
        Some(Source::Hot) => (Some("hot"), None),
        Some(Source::Cached) => (Some("cached"), None),
        Some(Source::Stored) => (Some("stored"), None),
        None => (None, None),
    };
    logging::emit(&HttpRequest {
        request_id: &id,
        network,
        method: method.as_str(),
        route,
        status: status.as_u16(),
        duration_ms: ms(started.elapsed().as_micros()),
        bytes: res.body().size_hint().exact(),
        refused: res.extensions().get::<Refused>().map(|r| r.reason),
        endpoint: outcome.map(|o| o.route),
        source,
        upstream_ms,
        upstream_error: outcome.and_then(|o| o.upstream_error),
        client,
    });
    res
}

/// Milliseconds with microsecond precision.
fn ms(micros: u128) -> f64 {
    u64::try_from(micros).unwrap_or(u64::MAX) as f64 / 1000.0
}

/// Unique within the process and unguessable across restarts: a counter through a randomly
/// keyed SipHash, as 16 hex digits.
pub(crate) fn request_id() -> String {
    static KEYS: OnceLock<RandomState> = OnceLock::new();
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}", KEYS.get_or_init(RandomState::new).hash_one(n))
}

/// The network a request was for. The raw path is only matched against fixed prefixes, so
/// nothing from it reaches the log.
fn network(path: &str, route: &str) -> Option<&'static str> {
    if matches!(route, "/healthz" | "/readyz")
        || path.starts_with("/assets/")
        || route.starts_with("/{network}")
    {
        return None;
    }
    let under = |prefix: &str| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    let network = Network::ALL
        .into_iter()
        .find(|n| !n.path_prefix().is_empty() && under(n.path_prefix()))
        .unwrap_or(Network::Mainnet);
    Some(network.name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn networks_come_from_fixed_prefixes() {
        assert_eq!(network("/api/tx/ab", "/api/{*rest}"), Some("mainnet"));
        assert_eq!(network("/", FRONTEND), Some("mainnet"));
        assert_eq!(
            network("/signet/api/x", "/signet/api/{*rest}"),
            Some("signet")
        );
        assert_eq!(network("/testnet4", FRONTEND), Some("testnet4"));
        assert_eq!(network("/testnet5/tx/ab", FRONTEND), Some("testnet5"));
        assert_eq!(network("/signetx/tx", FRONTEND), Some("mainnet"));
        assert_eq!(network("/healthz", "/healthz"), None);
        assert_eq!(network("/assets/a.js", FRONTEND), None);
        assert_eq!(network("/foo/api/x", "/{network}/api/{*rest}"), None);
    }

    #[test]
    fn request_ids_are_distinct_hex() {
        let a = request_id();
        let b = request_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
