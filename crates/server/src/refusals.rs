//! Refused requests, counted instead of logged one by one (docs/LOGGING.md, "Refusals").
//!
//! A client decides how many requests it sends, so a line per refusal lets it decide how much we
//! write. Each refusal is a few counter updates under one lock; once a minute the counts are one
//! `requests_refused` event. The first refusal of each reason after a quiet minute is still
//! written whole, so an operator chasing one `429` finds its request id at once. Every count and
//! table here has a fixed size: a thousand attackers cost what one does.

use std::collections::BTreeMap;
use std::hash::{BuildHasher, RandomState};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use logging::events::RequestsRefused;

use crate::limits::is_static;

/// How long one summary covers.
pub const WINDOW: Duration = Duration::from_secs(60);
/// Candidates kept for the most refused client.
const TOP_SLOTS: usize = 8;
/// Bits in the distinct-clients sketch: 2 KB, accurate to a few percent up to about 50,000.
const SKETCH_BITS: usize = 1 << 14;

/// Route classes, by the order of [`Window::routes`].
const ROUTES: [&str; 5] = ["api", "app", "ws", "health", "pages"];

/// Who was refused. The limits middleware attaches it to every refused response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    /// The address the limiter keyed on.
    pub client: IpAddr,
    /// The request carried a forwarding header from a peer that is not a trusted proxy.
    pub untrusted_forwarded: bool,
    /// The address is a trusted proxy's own: its forwarding header was missing or unreadable.
    pub proxy_keyed: bool,
}

/// The counts for the current window.
#[derive(Debug)]
pub struct Refusals {
    window: Mutex<Window>,
    keys: RandomState,
}

#[derive(Debug)]
struct Window {
    started: Instant,
    total: u64,
    logged: u64,
    /// By reason. The reasons are labels in our code, so this stays a handful of entries.
    reasons: Vec<(&'static str, u64)>,
    /// Reasons the previous window had: their next refusal is not news.
    recent: Vec<&'static str>,
    routes: [u64; ROUTES.len()],
    /// Linear counting: one bit per hashed client address.
    seen: Box<[u64; SKETCH_BITS / 64]>,
    /// Space-saving counters (client, count, overcount): the most refused client is in here,
    /// and `count - overcount` refusals of each are certain.
    top: Vec<(IpAddr, u64, u64)>,
    untrusted_forwarded: u64,
    proxy_keyed: u64,
}

impl Window {
    fn new(started: Instant, recent: Vec<&'static str>) -> Self {
        Self {
            started,
            total: 0,
            logged: 0,
            reasons: Vec::new(),
            recent,
            routes: [0; ROUTES.len()],
            seen: Box::new([0; SKETCH_BITS / 64]),
            top: Vec::with_capacity(TOP_SLOTS),
            untrusted_forwarded: 0,
            proxy_keyed: 0,
        }
    }
}

/// One window's counts, ready to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub window_secs: u64,
    pub total: u64,
    pub logged: u64,
    pub reasons: BTreeMap<&'static str, u64>,
    pub routes: BTreeMap<&'static str, u64>,
    pub clients: u64,
    pub top_client: IpAddr,
    pub top_client_refused: u64,
    pub untrusted_forwarded: u64,
    pub proxy_keyed: u64,
}

impl Summary {
    pub fn emit(&self, client_addr: bool) {
        logging::emit(&RequestsRefused {
            window_secs: self.window_secs,
            total: self.total,
            logged: self.logged,
            reasons: &self.reasons,
            routes: &self.routes,
            clients: self.clients,
            top_client_refused: self.top_client_refused,
            top_client: client_addr.then(|| self.top_client.to_string()),
            untrusted_forwarded: self.untrusted_forwarded,
            proxy_keyed: self.proxy_keyed,
        });
    }
}

impl Refusals {
    pub fn new(now: Instant) -> Arc<Self> {
        Arc::new(Self {
            window: Mutex::new(Window::new(now, Vec::new())),
            keys: RandomState::new(),
        })
    }

    /// Counts one refusal of `path` for `reason`. True when it is the first of its reason since
    /// a window without any: then the caller writes it whole.
    pub fn record(&self, reason: &'static str, path: &str, who: Refusal) -> bool {
        self.tally(reason, path, who, true)
    }

    /// Counts one refusal that has no request line to write: a WebSocket message refused.
    pub fn count(&self, reason: &'static str, path: &str, who: Refusal) {
        self.tally(reason, path, who, false);
    }

    fn tally(&self, reason: &'static str, path: &str, who: Refusal, whole: bool) -> bool {
        let route = route_class(path);
        let bit = usize::try_from(self.keys.hash_one(who.client)).unwrap_or(0) % SKETCH_BITS;
        let mut w = self.window.lock().unwrap_or_else(PoisonError::into_inner);
        w.total += 1;
        let first = match w.reasons.iter_mut().find(|(r, _)| *r == reason) {
            Some((_, n)) => {
                *n += 1;
                false
            }
            None => {
                w.reasons.push((reason, 1));
                whole && !w.recent.contains(&reason)
            }
        };
        w.logged += u64::from(first);
        if let Some(n) = w.routes.get_mut(route) {
            *n += 1;
        }
        if let Some(word) = w.seen.get_mut(bit / 64) {
            *word |= 1 << (bit % 64);
        }
        if let Some(slot) = w.top.iter_mut().find(|(ip, ..)| *ip == who.client) {
            slot.1 += 1;
        } else if w.top.len() < TOP_SLOTS {
            w.top.push((who.client, 1, 0));
        } else if let Some(min) = w.top.iter_mut().min_by_key(|(_, n, _)| *n) {
            // The newcomer takes the evicted slot and its count, which it may not have earned.
            *min = (who.client, min.1 + 1, min.1);
        }
        w.untrusted_forwarded += u64::from(who.untrusted_forwarded);
        w.proxy_keyed += u64::from(who.proxy_keyed);
        first
    }

    /// Ends the window at `now` and starts the next; the ended window's counts if it had any.
    pub fn roll(&self, now: Instant) -> Option<Summary> {
        let mut w = self.window.lock().unwrap_or_else(PoisonError::into_inner);
        let recent = w.reasons.iter().map(|(r, _)| *r).collect();
        let w = std::mem::replace(&mut *w, Window::new(now, recent));
        if w.total == 0 {
            return None;
        }
        let (top_client, top_client_refused) = w
            .top
            .iter()
            .map(|(ip, n, over)| (*ip, n - over))
            .max_by_key(|(_, certain)| *certain)
            .unwrap_or((IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0));
        let zeros: u32 = w.seen.iter().map(|word| word.count_zeros()).sum();
        Some(Summary {
            window_secs: now.saturating_duration_since(w.started).as_secs(),
            total: w.total,
            logged: w.logged,
            reasons: w.reasons.into_iter().collect(),
            routes: ROUTES
                .into_iter()
                .zip(w.routes)
                .filter(|(_, n)| *n > 0)
                .collect(),
            clients: distinct(zeros),
            top_client,
            top_client_refused,
            untrusted_forwarded: w.untrusted_forwarded,
            proxy_keyed: w.proxy_keyed,
        })
    }
}

/// Linear counting's estimate from the zero bits left; a full sketch reports its ceiling.
fn distinct(zeros: u32) -> u64 {
    let m = SKETCH_BITS as f64;
    let estimate = m * (m / f64::from(zeros.max(1))).ln();
    estimate.round() as u64
}

/// The index in [`ROUTES`] of a request path.
fn route_class(path: &str) -> usize {
    if is_static(path) {
        return 4;
    }
    let p = path.trim_start_matches('/');
    // A network prefix (`/signet/...`, or an unknown one) comes first, if any.
    let p = match p.split_once('/') {
        Some((first, rest)) if !matches!(first, "api" | "app" | "healthz" | "readyz") => rest,
        _ => p,
    };
    if p == "app/ws" || p == "api/v1/ws" {
        2
    } else if p == "api" || p.starts_with("api/") {
        0
    } else if p == "app" || p.starts_with("app/") {
        1
    } else {
        3
    }
}

/// Writes each window's summary, forever. Spawned once per server.
pub async fn report(refusals: Arc<Refusals>, client_addr: bool) {
    let start = tokio::time::Instant::now() + WINDOW;
    let mut tick = tokio::time::interval_at(start, WINDOW);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let now = tick.tick().await;
        if let Some(summary) = refusals.roll(now.into_std()) {
            summary.emit(client_addr);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn who(n: u32) -> Refusal {
        Refusal {
            client: IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + n)),
            untrusted_forwarded: false,
            proxy_keyed: false,
        }
    }

    #[test]
    fn counts_are_exact_and_the_first_after_quiet_is_flagged() {
        let t0 = Instant::now();
        let r = Refusals::new(t0);
        assert!(r.record("client_rate", "/api/tx/ab", who(1)), "first ever");
        for _ in 0..999 {
            assert!(!r.record("client_rate", "/signet/api/blocks", who(1)));
        }
        assert!(
            r.record("server_busy", "/assets/a.js", who(2)),
            "first of its reason"
        );
        assert!(!r.record("server_busy", "/app/config", who(2)));
        let flagged = Refusal {
            untrusted_forwarded: true,
            proxy_keyed: true,
            ..who(3)
        };
        assert!(r.record("client_sockets", "/regtest/app/ws", flagged));
        assert!(r.record("origin", "/api/v1/ws", who(3)));
        let s = r.roll(t0 + WINDOW).unwrap();
        assert_eq!(s.window_secs, 60);
        assert_eq!(s.total, 1004);
        assert_eq!(s.logged, 4);
        assert_eq!(
            s.reasons,
            BTreeMap::from([
                ("client_rate", 1000),
                ("server_busy", 2),
                ("client_sockets", 1),
                ("origin", 1)
            ])
        );
        assert_eq!(
            s.routes,
            BTreeMap::from([("api", 1000), ("app", 1), ("pages", 1), ("ws", 2)])
        );
        assert_eq!(s.clients, 3);
        assert_eq!((s.top_client, s.top_client_refused), (who(1).client, 1000));
        assert_eq!((s.untrusted_forwarded, s.proxy_keyed), (1, 1));
    }

    #[test]
    fn windows_roll_over_and_quiet_is_a_whole_window_without() {
        let t0 = Instant::now();
        let r = Refusals::new(t0);
        assert_eq!(
            r.roll(t0 + WINDOW),
            None,
            "nothing refused, nothing written"
        );
        assert!(r.record("client_rate", "/api", who(1)));
        let first = r.roll(t0 + 2 * WINDOW).unwrap();
        assert_eq!((first.total, first.logged), (1, 1));
        // The previous window had it: the next one is counted, not written.
        assert!(!r.record("client_rate", "/api", who(1)));
        let second = r.roll(t0 + 3 * WINDOW).unwrap();
        assert_eq!((second.total, second.logged), (1, 0));
        // A window without it: news again, promptly.
        assert_eq!(r.roll(t0 + 4 * WINDOW), None);
        assert!(r.record("client_rate", "/api", who(1)));
    }

    #[test]
    fn nothing_grows_with_the_number_of_clients() {
        let t0 = Instant::now();
        let r = Refusals::new(t0);
        for n in 0..100_000 {
            r.record("client_rate", "/api", who(n));
            // One client far busier than the rest stays the top, whatever else comes and goes.
            r.record("client_rate", "/api", who(7));
        }
        {
            let w = r.window.lock().unwrap();
            assert_eq!(w.top.len(), TOP_SLOTS);
            assert_eq!(w.reasons.len(), 1);
        }
        let s = r.roll(t0 + WINDOW).unwrap();
        assert_eq!(s.total, 200_000);
        assert_eq!(
            (s.top_client, s.top_client_refused),
            (who(7).client, 100_001)
        );
        // Past the sketch's range the estimate saturates rather than grow.
        assert!(s.clients >= 50_000, "{}", s.clients);

        // No client stands out: the count reported is certain, so it does not make one up.
        for n in 0..1000 {
            r.record("client_rate", "/api", who(n));
            r.record("client_rate", "/api", who(n));
        }
        let s = r.roll(t0 + 2 * WINDOW).unwrap();
        assert!((970..=1030).contains(&s.clients), "{}", s.clients);
        assert!(s.top_client_refused <= 2, "{}", s.top_client_refused);
    }

    #[test]
    fn routes_are_classed_by_path() {
        let class = |p| ROUTES[route_class(p)];
        assert_eq!(class("/api/tx/ab"), "api");
        assert_eq!(class("/signet/api"), "api");
        assert_eq!(class("/nope/api/x"), "api");
        assert_eq!(class("/app/config"), "app");
        assert_eq!(class("/app/ws"), "ws");
        assert_eq!(class("/testnet4/app/ws"), "ws");
        assert_eq!(class("/testnet5/app/ws"), "ws");
        assert_eq!(class("/api/v1/ws"), "ws");
        assert_eq!(class("/signet/api/v1/ws"), "ws");
        assert_eq!(class("/healthz"), "health");
        assert_eq!(class("/readyz"), "health");
        assert_eq!(class("/"), "pages");
        assert_eq!(class("/assets/x.js"), "pages");
        assert_eq!(class("/block/00ff"), "pages");
    }
}
