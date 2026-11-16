//! Per-client accounting and the request limits middleware (SECURITY.md rules 6 and 7).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderName, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use crate::config::{Limits, TrustedProxy};
use crate::error::ApiError;
use crate::refusals::Refusal;

/// A limit said no: the error the client gets, and a fixed reason for the request log. Its
/// response carries it as an extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refused {
    pub error: ApiError,
    /// `client_rate`, `client_concurrency`, `client_table_full`, `route_rate`, `server_busy` or
    /// `timeout`.
    pub reason: &'static str,
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let mut res = self.error.into_response();
        res.extensions_mut().insert(self);
        res
    }
}

/// What a client holds open. Each kind has its own per-client cap, passed to [`Client::hold`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held {
    /// An HTTP request being handled.
    Request,
    /// An open TCP connection.
    Connection,
    /// An open WebSocket on `/app/ws`.
    Socket,
    /// An open WebSocket on the mempool.space-shaped `/api/v1/ws`, counted apart.
    V1Socket,
}

/// Rate and concurrency state for every recently active client, in a table of bounded size.
#[derive(Debug)]
pub struct Clients {
    table: Mutex<Table>,
    rate: f64,
    burst: f64,
    max_entries: usize,
}

#[derive(Debug)]
struct Table {
    entries: HashMap<IpAddr, Entry>,
    last_sweep: Instant,
}

#[derive(Debug)]
struct Entry {
    tokens: f64,
    refilled: Instant,
    requests: u32,
    connections: u32,
    sockets: u32,
    v1_sockets: u32,
}

impl Entry {
    fn count(&mut self, kind: Held) -> &mut u32 {
        match kind {
            Held::Request => &mut self.requests,
            Held::Connection => &mut self.connections,
            Held::Socket => &mut self.sockets,
            Held::V1Socket => &mut self.v1_sockets,
        }
    }

    fn refill(&mut self, now: Instant, rate: f64, burst: f64) {
        let earned = now.saturating_duration_since(self.refilled).as_secs_f64() * rate;
        self.tokens = (self.tokens + earned).min(burst);
        self.refilled = now;
    }

    /// An entry with a full bucket and nothing held is the same as no entry, so it can be dropped.
    fn idle(&mut self, now: Instant, rate: f64, burst: f64) -> bool {
        self.refill(now, rate, burst);
        self.tokens >= burst
            && self.requests == 0
            && self.connections == 0
            && self.sockets == 0
            && self.v1_sockets == 0
    }
}

impl Clients {
    pub fn new(limits: &Limits) -> Arc<Self> {
        Self::with_rate(
            f64::from(limits.client_rate_per_sec),
            limits.client_burst,
            limits.max_tracked_clients,
        )
    }

    /// A separate table with its own rate (tokens per second) and burst, for a route that needs a
    /// stricter limit than the rest.
    pub fn with_rate(rate: f64, burst: u32, max_entries: usize) -> Arc<Self> {
        Arc::new(Self {
            table: Mutex::new(Table {
                entries: HashMap::new(),
                last_sweep: Instant::now(),
            }),
            rate,
            burst: f64::from(burst),
            max_entries,
        })
    }

    /// Takes one rate token for `client` and holds nothing.
    pub fn take(self: &Arc<Self>, client: IpAddr) -> Result<(), Refused> {
        self.acquire(client, Held::Request, u32::MAX, 1.0)
            .map(drop)
            .map_err(|r| match r.reason {
                "client_rate" => Refused {
                    reason: "route_rate",
                    ..r
                },
                _ => r,
            })
    }

    /// Takes `cost` rate tokens (0 or 1) and one `kind` slot for `client`, all or nothing.
    pub(crate) fn acquire(
        self: &Arc<Self>,
        client: IpAddr,
        kind: Held,
        max: u32,
        cost: f64,
    ) -> Result<Hold, Refused> {
        let now = Instant::now();
        let mut table = self.table.lock().unwrap_or_else(PoisonError::into_inner);
        if !table.entries.contains_key(&client) && table.entries.len() >= self.max_entries {
            // Sweep at most once a second, so a flood of new addresses cannot make every request O(n).
            if now.saturating_duration_since(table.last_sweep) >= Duration::from_secs(1) {
                table.last_sweep = now;
                let (rate, burst) = (self.rate, self.burst);
                table.entries.retain(|_, e| !e.idle(now, rate, burst));
            }
            if table.entries.len() >= self.max_entries {
                return Err(Refused {
                    error: ApiError::OVERLOADED,
                    reason: "client_table_full",
                });
            }
        }
        let entry = table.entries.entry(client).or_insert(Entry {
            tokens: self.burst,
            refilled: now,
            requests: 0,
            connections: 0,
            sockets: 0,
            v1_sockets: 0,
        });
        entry.refill(now, self.rate, self.burst);
        if entry.tokens < cost || *entry.count(kind) >= max {
            let reason = if entry.tokens < cost {
                "client_rate"
            } else {
                "client_concurrency"
            };
            return Err(Refused {
                error: ApiError::TOO_MANY_REQUESTS,
                reason,
            });
        }
        entry.tokens -= cost;
        *entry.count(kind) += 1;
        Ok(Hold {
            clients: Arc::clone(self),
            client,
            kind,
        })
    }

    /// Number of clients currently tracked. Bounded by `MAX_TRACKED_CLIENTS`.
    pub fn tracked(&self) -> usize {
        self.table
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entries
            .len()
    }
}

/// One slot a client holds; released on drop.
#[derive(Debug)]
pub struct Hold {
    clients: Arc<Clients>,
    client: IpAddr,
    kind: Held,
}

impl Drop for Hold {
    fn drop(&mut self) {
        let mut table = self
            .clients
            .table
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(e) = table.entries.get_mut(&self.client) {
            let n = e.count(self.kind);
            *n = n.saturating_sub(1);
        }
    }
}

/// The caller of the current request, as a request extension. The WebSocket hub uses
/// [`Client::hold`] with [`Held::Socket`] to cap sockets per client against the same table.
#[derive(Debug, Clone)]
pub struct Client {
    pub addr: IpAddr,
    /// Who it is in the refusal summary, for a refusal decided after the response: a socket's.
    pub who: Refusal,
    clients: Arc<Clients>,
}

impl Client {
    /// Holds one `kind` slot for this client if it has fewer than `max`. No rate token is taken.
    pub fn hold(&self, kind: Held, max: u32) -> Result<Hold, Refused> {
        self.clients.acquire(self.addr, kind, max, 0.0)
    }
}

/// The address limits are keyed on. IPv6 clients are grouped by /64, since one host is routinely
/// given a whole /64 and could otherwise rotate through addresses to dodge every per-client limit.
pub fn client_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(Ipv6Addr::from(u128::from(v6) & (!0u128 << 64))),
        },
    }
}

/// The client address. The socket peer, unless the peer is a trusted proxy: then the address that
/// proxy chain names in the trusted header. Every instance of the header is read as one list, in
/// order, and walked from the right, the end the nearest proxy wrote: entries that are themselves
/// trusted proxies are skipped and the first other address is the client. A chain made only of
/// trusted proxies names the leftmost; a missing or unparsable entry stops the walk at the last
/// trusted address, so a broken chain costs the proxy its own share, never anyone else's.
pub(crate) fn client_addr(
    headers: &HeaderMap,
    peer: IpAddr,
    trust: Option<&TrustedProxy>,
) -> IpAddr {
    let peer = peer.to_canonical();
    let Some(trust) = trust.filter(|t| t.trusts(peer)) else {
        return client_key(peer);
    };
    let mut nearest = peer;
    for value in headers.get_all(&trust.header).iter().rev() {
        let Ok(value) = value.to_str() else {
            return client_key(nearest);
        };
        for entry in value.rsplit(',') {
            let entry = entry.trim();
            let Some(ip) = entry
                .parse::<IpAddr>()
                .ok()
                .or_else(|| entry.parse::<SocketAddr>().ok().map(|s| s.ip()))
                .map(|ip| ip.to_canonical())
            else {
                return client_key(nearest);
            };
            if !trust.trusts(ip) {
                return client_key(ip);
            }
            nearest = ip;
        }
    }
    client_key(nearest)
}

/// Static files and pages: the app shell and the content-hashed files under `/assets`, served from
/// memory or disk with no node work behind them. Everything a handler answers (`/api`, `/app`,
/// under any network prefix or none, and `/healthz`, `/readyz` and `/mcp`) is not.
pub fn is_static(path: &str) -> bool {
    let mut segs = path.trim_start_matches('/').split('/');
    let first = segs.next().unwrap_or_default();
    let second = segs.next();
    !(matches!(first, "api" | "app" | "healthz" | "readyz" | "mcp")
        || matches!(second, Some("api" | "app")))
}

/// Per-client limits on static files, fixed: generous, since they cost no node work and finish in
/// milliseconds, but there so one client cannot take every global request slot with them. A cold
/// load of the heaviest page is 25 files (docs/CONFIG.md, "Per-client defaults").
pub const STATIC_BURST: u32 = 400;
pub const STATIC_RATE_PER_SEC: u32 = 100;
pub const STATIC_CONCURRENCY: u32 = 96;

/// Shared state for [`limit`].
#[derive(Debug, Clone)]
pub struct Limiter {
    pub clients: Arc<Clients>,
    /// Static files' own table, so pages and assets never use up a client's API allowance.
    statics: Arc<Clients>,
    /// API preflights' own table, with the API's rate, burst and concurrency: a browser sends at
    /// most one before each API call, so an honest page is never refused a preflight while its
    /// call would be allowed, and the preflight never spends that call's token.
    preflights: Arc<Clients>,
    pub limits: Limits,
    in_flight: Arc<Semaphore>,
    /// Requests whose forwarding header was ignored, for `proxy_header_ignored`.
    ignored_forwarding: Arc<AtomicU64>,
    /// `LOG_CLIENT_ADDR`: whether that event may name the peer, which may be a visitor.
    log_client_addr: bool,
}

impl Limiter {
    pub fn new(limits: &Limits, log_client_addr: bool) -> Self {
        Self {
            clients: Clients::new(limits),
            statics: Clients::with_rate(
                f64::from(STATIC_RATE_PER_SEC),
                STATIC_BURST,
                limits.max_tracked_clients,
            ),
            preflights: Clients::new(limits),
            limits: limits.clone(),
            in_flight: Arc::new(Semaphore::new(limits.max_requests)),
            ignored_forwarding: Arc::default(),
            log_client_addr,
        }
    }

    /// Holds a connection slot for `peer`, refusing one past its cap. Connections from a trusted
    /// proxy carry many clients, so they have no per-client cap (`Ok(None)`): the proxy owns it.
    pub fn connection(&self, peer: IpAddr) -> Result<Option<Hold>, ApiError> {
        let peer = peer.to_canonical();
        if self
            .limits
            .trusted_proxy
            .as_ref()
            .is_some_and(|t| t.trusts(peer))
        {
            return Ok(None);
        }
        let max = self.limits.client_connections;
        let hold = self
            .clients
            .acquire(client_key(peer), Held::Connection, max, 0.0)
            .map_err(|r| r.error)?;
        Ok(Some(hold))
    }
}

/// Aborts the task when dropped, so work for a client that hung up or timed out stops with it.
struct AbortOnDrop(JoinHandle<Response>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Headers a proxy names the client in. Sent by a peer we do not trust, they hint that a proxy in
/// front is missing from `TRUSTED_PROXIES`.
static FORWARDING: [HeaderName; 3] = [
    HeaderName::from_static("x-forwarded-for"),
    HeaderName::from_static("x-real-ip"),
    HeaderName::from_static("forwarded"),
];

/// The per-client verdict, reached before routing by `serve` (or by [`limit`] when the router is
/// driven alone). It rides on the request as an extension so [`limit`] does not decide twice.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Checked {
    /// Admitted: the caller holds the client's request slot until the response head is ready.
    Admitted { addr: IpAddr, who: Refusal },
    /// Refused, and the first of its reason in a while: routed only to be logged whole. Already
    /// counted in the refusal summary.
    Refused(Refused, Refusal),
}

/// On a response, says its refusal is already counted in the summary.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Counted;

impl Limiter {
    /// Takes `peer`'s rate token and request slot for `path` (static files' own limits, API
    /// preflights' own, or the API's), or says why not. Who the client is, for the refusal
    /// summary, either way.
    pub(crate) fn check(
        &self,
        method: &Method,
        headers: &HeaderMap,
        path: &str,
        peer: IpAddr,
    ) -> Result<(Hold, IpAddr, Refusal), (Refused, Refusal)> {
        let trust = self.limits.trusted_proxy.as_ref();
        let addr = client_addr(headers, peer, trust);
        let ignored = if trust.is_some_and(|t| t.trusts(peer.to_canonical())) {
            None
        } else {
            FORWARDING.iter().find(|h| headers.contains_key(*h))
        };
        if let Some(header) = ignored {
            self.forwarding_ignored(header, peer);
        }
        let who = Refusal {
            client: addr,
            untrusted_forwarded: ignored.is_some(),
            proxy_keyed: trust.is_some_and(|t| t.trusts(addr)),
        };
        let (table, max) = if is_static(path) {
            (&self.statics, STATIC_CONCURRENCY)
        } else if method == Method::OPTIONS && crate::is_api(path) {
            (&self.preflights, self.limits.client_requests)
        } else {
            (&self.clients, self.limits.client_requests)
        };
        match table.acquire(addr, Held::Request, max, 1.0) {
            Ok(hold) => Ok((hold, addr, who)),
            Err(refused) => Err((refused, who)),
        }
    }
}

impl Limiter {
    /// Counts a request whose forwarding header was ignored, and says so at a total of 1, 2, 4…
    fn forwarding_ignored(&self, header: &'static HeaderName, peer: IpAddr) {
        let total = self.ignored_forwarding.fetch_add(1, Ordering::Relaxed) + 1;
        if total.is_power_of_two() {
            logging::emit(&logging::events::ProxyHeaderIgnored {
                header: header.as_str(),
                peer: self
                    .log_client_addr
                    .then(|| peer.to_canonical().to_string()),
                trusted_proxies_set: self.limits.trusted_proxy.is_some(),
                total,
            });
        }
    }
}

/// Middleware applying, in order: the per-client limits ([`Limiter::check`], unless `serve`
/// already did), the global concurrency limit (shedding load instead of queueing), then the
/// request timeout. A refused response, from here or from a handler, leaves with a [`Refusal`]
/// saying who was refused. Its state is one pointer: axum clones it for every request, and each
/// shared count it holds is a cache line every core fights over under a flood.
pub async fn limit(State(limiter): State<Arc<Limiter>>, mut req: Request, next: Next) -> Response {
    let (_hold, addr, who) = match req.extensions_mut().remove::<Checked>() {
        Some(Checked::Admitted { addr, who }) => (None, addr, who),
        Some(Checked::Refused(refused, who)) => {
            let mut res = refused.into_response();
            res.extensions_mut().insert(who);
            res.extensions_mut().insert(Counted);
            return res;
        }
        None => {
            let Some(ConnectInfo(peer)) =
                req.extensions().get::<ConnectInfo<SocketAddr>>().copied()
            else {
                // Only reachable if the router is served without `serve`; refuse rather than
                // share one bucket.
                return ApiError::INTERNAL.into_response();
            };
            match limiter.check(req.method(), req.headers(), req.uri().path(), peer.ip()) {
                Ok((hold, addr, who)) => (Some(hold), addr, who),
                Err((refused, who)) => {
                    let mut res = refused.into_response();
                    res.extensions_mut().insert(who);
                    return res;
                }
            }
        }
    };
    // An admitted API preflight needs nothing more: `cors` adds its headers.
    if req.method() == Method::OPTIONS && crate::is_api(req.uri().path()) {
        return StatusCode::NO_CONTENT.into_response();
    }
    let mut res = admitted(&limiter, addr, who, req, next).await;
    if res.extensions().get::<Refused>().is_some() {
        res.extensions_mut().insert(who);
    }
    res
}

async fn admitted(
    limiter: &Limiter,
    addr: IpAddr,
    who: Refusal,
    mut req: Request,
    next: Next,
) -> Response {
    let Ok(_permit) = limiter.in_flight.clone().try_acquire_owned() else {
        return Refused {
            error: ApiError::OVERLOADED,
            reason: "server_busy",
        }
        .into_response();
    };
    req.extensions_mut().insert(Client {
        addr,
        who,
        clients: Arc::clone(&limiter.clients),
    });
    // A task of its own turns a handler panic into a 500 instead of a dropped connection.
    let mut task = AbortOnDrop(tokio::spawn(next.run(req)));
    match tokio::time::timeout(limiter.limits.request_timeout, &mut task.0).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => ApiError::INTERNAL.into_response(),
        Err(_) => Refused {
            error: ApiError::TIMEOUT,
            reason: "timeout",
        }
        .into_response(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn clients(rate: u32, burst: u32, max: usize) -> Arc<Clients> {
        Clients::new(&Limits {
            client_rate_per_sec: rate,
            client_burst: burst,
            max_tracked_clients: max,
            ..Limits::default()
        })
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn ipv6_is_keyed_by_64_and_mapped_v4_by_v4() {
        assert_eq!(client_key(ip("2001:db8:1:2:aaaa::1")), ip("2001:db8:1:2::"));
        assert_eq!(client_key(ip("::ffff:192.0.2.7")), ip("192.0.2.7"));
        assert_eq!(client_key(ip("192.0.2.7")), ip("192.0.2.7"));
    }

    #[test]
    fn rate_is_per_client() {
        let c = clients(1, 2, 10);
        let a = ip("192.0.2.1");
        assert!(c.acquire(a, Held::Request, 10, 1.0).is_ok());
        assert!(c.acquire(a, Held::Request, 10, 1.0).is_ok());
        let refused = c.acquire(a, Held::Request, 10, 1.0).unwrap_err();
        assert_eq!(refused.error, ApiError::TOO_MANY_REQUESTS);
        assert_eq!(refused.reason, "client_rate");
        assert!(c.acquire(ip("192.0.2.2"), Held::Request, 10, 1.0).is_ok());
    }

    #[test]
    fn holds_are_capped_per_kind_and_released_on_drop() {
        let c = clients(100, 100, 10);
        let a = ip("192.0.2.1");
        let first = c.acquire(a, Held::Socket, 1, 0.0).unwrap();
        assert_eq!(
            c.acquire(a, Held::Socket, 1, 0.0).unwrap_err().reason,
            "client_concurrency"
        );
        assert!(c.acquire(a, Held::Request, 1, 0.0).is_ok());
        drop(first);
        assert!(c.acquire(a, Held::Socket, 1, 0.0).is_ok());
    }

    #[test]
    fn table_is_bounded_and_keeps_serving_known_clients() {
        let c = clients(1, 1, 2);
        let _a = c.acquire(ip("192.0.2.1"), Held::Request, 10, 0.0).unwrap();
        let _b = c.acquire(ip("192.0.2.2"), Held::Request, 10, 0.0).unwrap();
        assert_eq!(
            c.acquire(ip("192.0.2.3"), Held::Request, 10, 0.0)
                .unwrap_err()
                .reason,
            "client_table_full"
        );
        assert_eq!(c.tracked(), 2);
        assert!(c.acquire(ip("192.0.2.1"), Held::Request, 10, 0.0).is_ok());
    }

    #[test]
    fn idle_clients_are_swept_when_the_table_is_full() {
        let c = clients(1, 1, 2);
        drop(c.acquire(ip("192.0.2.1"), Held::Request, 10, 0.0).unwrap());
        drop(c.acquire(ip("192.0.2.2"), Held::Request, 10, 0.0).unwrap());
        c.table.lock().unwrap().last_sweep -= Duration::from_secs(2);
        assert!(c.acquire(ip("192.0.2.3"), Held::Request, 10, 0.0).is_ok());
        assert_eq!(c.tracked(), 1);
    }

    fn trust(header: &str, proxies: &[&str]) -> TrustedProxy {
        TrustedProxy {
            header: axum::http::HeaderName::try_from(header).unwrap(),
            proxies: proxies
                .iter()
                .map(|p| crate::config::IpNet::parse(p).unwrap())
                .collect(),
        }
    }

    fn headers(name: &str, values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(
                axum::http::HeaderName::try_from(name).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn the_header_counts_only_from_a_trusted_proxy() {
        let t = trust("x-real-ip", &["10.0.0.1"]);
        let h = headers("x-real-ip", &["203.0.113.9"]);
        // Not configured, or sent by anyone but the proxy: the socket peer, header ignored.
        assert_eq!(
            client_addr(&h, ip("198.51.100.4"), None),
            ip("198.51.100.4")
        );
        assert_eq!(
            client_addr(&h, ip("198.51.100.4"), Some(&t)),
            ip("198.51.100.4")
        );
        assert_eq!(client_addr(&h, ip("10.0.0.2"), Some(&t)), ip("10.0.0.2"));
        // From the proxy, also as an IPv4-mapped IPv6 peer.
        assert_eq!(client_addr(&h, ip("10.0.0.1"), Some(&t)), ip("203.0.113.9"));
        assert_eq!(
            client_addr(&h, ip("::ffff:10.0.0.1"), Some(&t)),
            ip("203.0.113.9")
        );
        // Grouped by /64 like any other client.
        let h6 = headers("x-real-ip", &["2001:db8:1:2::77"]);
        assert_eq!(
            client_addr(&h6, ip("10.0.0.1"), Some(&t)),
            ip("2001:db8:1:2::")
        );
    }

    #[test]
    fn forwarding_chains_are_walked_from_the_nearest_proxy() {
        let t = trust("x-forwarded-for", &["10.0.0.0/8", "fd00::/8"]);
        let proxy = ip("10.0.0.1");
        let walk =
            |values: &[&str]| client_addr(&headers("x-forwarded-for", values), proxy, Some(&t));
        // A client's own entries come first and are never reached.
        assert_eq!(walk(&["1.1.1.1, 203.0.113.9"]), ip("203.0.113.9"));
        // Trusted hops on the right are skipped, across header instances too.
        assert_eq!(walk(&["1.1.1.1, 203.0.113.9, 10.0.0.7"]), ip("203.0.113.9"));
        assert_eq!(
            walk(&["1.1.1.1", "203.0.113.9", "10.0.0.7, fd00::1"]),
            ip("203.0.113.9")
        );
        assert_eq!(walk(&["203.0.113.9:4711"]), ip("203.0.113.9"));
        assert_eq!(walk(&["[2001:db8::1]:443"]), ip("2001:db8::"));
        // Only trusted hops: the leftmost. Nothing usable: the nearest trusted address.
        assert_eq!(walk(&["10.0.0.9, 10.0.0.7"]), ip("10.0.0.9"));
        assert_eq!(walk(&[]), proxy);
        assert_eq!(walk(&["garbage"]), proxy);
        assert_eq!(walk(&["203.0.113.9, unknown, 10.0.0.7"]), ip("10.0.0.7"));
        assert_eq!(walk(&[""]), proxy);
        assert_eq!(walk(&["1.1.1.1,"]), proxy);
        let mut h = HeaderMap::new();
        h.append(
            "x-forwarded-for",
            axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
        );
        assert_eq!(client_addr(&h, proxy, Some(&t)), proxy);
    }

    #[test]
    fn preflights_have_their_own_bounded_table() {
        let limiter = Limiter::new(
            &Limits {
                client_rate_per_sec: 1,
                client_burst: 1,
                max_tracked_clients: 2,
                ..Limits::default()
            },
            false,
        );
        let h = HeaderMap::new();
        let check = |m: &Method, path: &str, peer: &str| limiter.check(m, &h, path, ip(peer));
        let api = "/signet/api/tx";
        let _a = check(&Method::OPTIONS, api, "192.0.2.1").unwrap();
        // The preflight did not spend the call's token.
        let _b = check(&Method::POST, api, "192.0.2.1").unwrap();
        assert_eq!(
            check(&Method::OPTIONS, api, "192.0.2.1")
                .unwrap_err()
                .0
                .reason,
            "client_rate"
        );
        let _c = check(&Method::OPTIONS, api, "192.0.2.2").unwrap();
        // Many clients: the table stays at its size like the API's own.
        assert_eq!(
            check(&Method::OPTIONS, api, "192.0.2.3")
                .unwrap_err()
                .0
                .reason,
            "client_table_full"
        );
        assert_eq!(limiter.preflights.tracked(), 2);
        assert_eq!(limiter.clients.tracked(), 1);
        // `OPTIONS` outside the API is no preflight: it is counted where the path belongs.
        let _d = check(&Method::OPTIONS, "/app/config", "192.0.2.4").unwrap();
        assert_eq!(limiter.clients.tracked(), 2);
        assert_eq!(limiter.preflights.tracked(), 2);
    }

    #[test]
    fn static_files_and_pages_are_told_from_handlers() {
        for p in [
            "/",
            "/assets/index-abc.js",
            "/signet/",
            "/block/00ff",
            "/regtest/tx/ab",
            "/boot.js",
            "/favicon.svg",
            "/%61pi/x",
        ] {
            assert!(is_static(p), "{p}");
        }
        for p in [
            "/api",
            "/api/blocks",
            "/app/ws",
            "/app/config",
            "/healthz",
            "/readyz",
            "/mcp",
            "/signet/api/x",
            "/regtest/app/ws",
            "/nope/api/x",
            "/x/app",
        ] {
            assert!(!is_static(p), "{p}");
        }
    }
}
