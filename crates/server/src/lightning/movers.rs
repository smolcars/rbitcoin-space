//! The Lightning overview's movers and closes by day (`docs/LIGHTNING.md`, "The overview"):
//! worked out from `ln_channels` every [`EVERY`] while the graph is indexed, off the request path,
//! and served from memory.

use std::sync::atomic::Ordering;
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::routing::get;
use engine::lightning::overview::{self, Day, Mover, Movers};
use engine::lightning::{self as store_ln, DAY, Index};
use engine::store::Store;
use serde_json::{Value, json};

use super::nodes::{Answer, SYNCING, graph, number, query, send};
use super::{Lightning, hex, json_response};
use crate::NetworkContext;
use crate::error::ApiError;

/// How often the figures are worked out again: the statistics sampler's period.
const EVERY: Duration = Duration::from_secs(store_ln::EVERY);
/// How soon a first computation is tried again while there is no index, or after a failure.
const RETRY: Duration = Duration::from_secs(5);
/// The periods `?period=` names, and their length.
const PERIODS: [(&str, u64); 3] = [("24h", DAY), ("1w", 7 * DAY), ("1m", 30 * DAY)];
/// Days of closes kept, the most `?days=` takes, and its default.
const DAYS: u64 = 90;
const DEFAULT_DAYS: u64 = 30;

/// The last computation: each period's movers answer, encoded, and the closes of [`DAYS`] days.
#[derive(Debug)]
pub(crate) struct Overview {
    time: u64,
    movers: [Bytes; 3],
    closes: Vec<Day>,
}

/// Works the figures out every [`EVERY`] once the graph is indexed, until the peer stops.
pub(crate) async fn keep(store: Arc<Store>, l: Arc<Lightning>) {
    loop {
        let wait = match l.index() {
            Some(index) if compute(&store, &l, Arc::clone(&index)).await => EVERY,
            _ => RETRY,
        };
        tokio::time::sleep(wait).await;
    }
}

/// One computation: one read of the table, then the work on a blocking thread. `false` if the
/// read failed (counted in the summary); the last figures stay.
async fn compute(store: &Store, l: &Arc<Lightning>, index: Arc<Index>) -> bool {
    let started = Instant::now();
    let Ok(rows) = overview::rows(store).await else {
        l.overview_failures.fetch_add(1, Ordering::Relaxed);
        return false;
    };
    let read = started.elapsed();
    let now = store_ln::unix_now();
    let work = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let movers = PERIODS.map(|(name, span)| {
            let since = now.saturating_sub(span);
            let v = movers_json(&index, &overview::movers(&rows, since), name, since, now);
            Bytes::from(serde_json::to_vec(&v).unwrap_or_default())
        });
        let closes = overview::closes(&rows, now, DAYS);
        (movers, closes, started.elapsed())
    })
    .await;
    let Ok((movers, closes, took)) = work else {
        l.overview_failures.fetch_add(1, Ordering::Relaxed);
        return false;
    };
    *l.overview.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(Overview {
        time: now,
        movers,
        closes,
    }));
    let us = |d: Duration| d.as_micros().try_into().unwrap_or(u64::MAX);
    l.overview_read_us.store(us(read), Ordering::Relaxed);
    l.overview_us.store(us(took), Ordering::Relaxed);
    true
}

/// A node's row: the change, and what it holds now by the index (nothing for one gone from the
/// graph, whose alias is then unknown too).
fn mover_json(index: &Index, m: &Mover) -> Value {
    let node = index.node(&m.id);
    let mut v = json!({
        "id": hex(&m.id),
        "alias": node.and_then(|n| n.alias()),
        "capacity_change": m.capacity,
        "channels_change": m.channels,
        "capacity": node.map_or(0, |n| n.capacity),
        "channels": node.map_or(0, |n| n.open()),
    });
    if let (Some(t), Some(o)) = (m.time, v.as_object_mut()) {
        o.insert("time".into(), t.into());
    }
    v
}

fn movers_json(index: &Index, m: &Movers, period: &str, since: u64, now: u64) -> Value {
    let list = |v: &[Mover]| v.iter().map(|m| mover_json(index, m)).collect::<Vec<_>>();
    json!({
        "period": period,
        "from": since,
        "time": now,
        "capacity_up": list(&m.capacity_up),
        "capacity_down": list(&m.capacity_down),
        "channels_up": list(&m.channels_up),
        "channels_down": list(&m.channels_down),
        "new": list(&m.new),
        "left": list(&m.left),
    })
}

/// The last computation, or the not-ready answer the other Lightning routes give.
fn latest(ctx: &NetworkContext) -> Result<Arc<Overview>, ApiError> {
    let (_, l, _) = graph(ctx)?;
    l.overview
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .ok_or(SYNCING)
}

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/app/lightning/movers", get(app_movers))
        .route("/app/lightning/closes", get(app_closes))
}

/// `GET /app/lightning/movers?period=24h|1w|1m`: from memory.
async fn app_movers(State(ctx): State<Arc<NetworkContext>>, RawQuery(raw): RawQuery) -> Answer {
    const BAD: ApiError = ApiError::bad_request("period is 24h, 1w or 1m");
    let q = query(raw.as_deref(), &["period"], true)?;
    let i = match q.get("period") {
        None => 0,
        Some(p) => PERIODS.iter().position(|(n, _)| n == p).ok_or(BAD)?,
    };
    let o = latest(&ctx)?;
    let body = o.movers.get(i).cloned().ok_or(ApiError::INTERNAL)?;
    Ok(json_response(
        body,
        "lightning_movers",
        "public, max-age=10",
    ))
}

fn day_json(time: Option<u64>, d: &Day) -> Value {
    let [cooperative, force, penalty, other] = d.closes;
    let mut v = json!({
        "cooperative": cooperative,
        "force": force,
        "penalty": penalty,
        "other": other,
        "capacity": d.capacity,
    });
    if let (Some(t), Some(o)) = (time, v.as_object_mut()) {
        o.insert("time".into(), t.into());
    }
    v
}

/// `GET /app/lightning/closes?days=1..90`: each UTC day's closes by kind and capacity closed,
/// oldest first and ending today, and their totals. From memory.
async fn app_closes(State(ctx): State<Arc<NetworkContext>>, RawQuery(raw): RawQuery) -> Answer {
    const BAD: ApiError = ApiError::bad_request("days is 1 to 90");
    let q = query(raw.as_deref(), &["days"], true)?;
    let days = match q.get("days") {
        None => DEFAULT_DAYS,
        Some(s) => number(s, DAYS).filter(|n| *n >= 1).ok_or(BAD)?,
    };
    let o = latest(&ctx)?;
    let from = o
        .closes
        .len()
        .saturating_sub(usize::try_from(days).unwrap_or(usize::MAX));
    let span = o.closes.get(from..).unwrap_or_default();
    let mut total = Day::default();
    for d in span {
        for (t, n) in total.closes.iter_mut().zip(d.closes) {
            *t = t.saturating_add(n);
        }
        total.capacity = total.capacity.saturating_add(d.capacity);
    }
    let v = json!({
        "time": o.time,
        "days": span.iter().map(|d| day_json(Some(d.time), d)).collect::<Vec<_>>(),
        "total": day_json(None, &total),
    });
    Ok(send(&v, "lightning_closes"))
}
