//! The record of recent replacements (`engine::replacements`) in the server: the `/app` route,
//! and keeping it in the store. Fed by [`crate::ws::track`] from every tracker delta; read by the
//! `tx:<txid>` topic, `GET /app/tx/:txid/replacements` (`docs/FRONTEND.md`) and the `/api/v1`
//! replacement routes ([`crate::transactions`]).
//!
//! With a store, the record is put back from the `replacements` table when the mempool engine
//! starts, and every change is written to it by one task per network ([`writer`]), off the path
//! that follows the tracker: a full queue drops the write rather than wait.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::HeaderValue;
use axum::http::header::CACHE_CONTROL;
use axum::response::{IntoResponse, Response};
use axum::{Json, http::StatusCode};
pub use engine::replacements::db::Batch;
pub use engine::replacements::{Change, Facts, Link, MAX_LINKS, Mined, Replacements, Sides};
use engine::store::Store;
use logging::events::{ReplacementsRestored, ReplacementsStoreFailed};
use serde_json::json;
use tokio::sync::mpsc;

use crate::config::Network;
use crate::{ApiError, NetworkContext, esplora};

/// Writes waiting for the store, per network. Each is one tracker delta's replacements, so 64
/// covers a minute of a busy mainnet many times over.
pub const QUEUE: usize = 64;

/// `GET /app/tx/:txid/replacements`: what this transaction replaced and what replaced it, as far
/// as the record goes back.
pub async fn route(
    State(ctx): State<Arc<NetworkContext>>,
    Path(txid): Path<String>,
) -> Result<Response, ApiError> {
    let txid = esplora::txid(&txid)?;
    if !ctx.track.mempool_enabled() {
        return Err(crate::ws::track::MEMPOOL_OFF);
    }
    let body = ctx.track.with_replacements(|r| {
        let (later, more_later) = r.chain(&txid);
        let (earlier, more_earlier) = r.earlier(&txid);
        // With how many inputs each pair shares: 0 says a child left with its replaced parent,
        // not an earlier version (the compare view's line of versions skips those).
        let json = |l: &Link| {
            let mut v = l.json();
            if let serde_json::Value::Object(m) = &mut v {
                m.insert(
                    "shared_inputs".into(),
                    json!(r.sides(&l.txid).and_then(|s| s.shared)),
                );
            }
            v
        };
        let (versions, more_versions) = r.versions(&txid);
        json!({
            "txid": txid,
            "replaced_by": later.iter().map(json).collect::<Vec<_>>(),
            "replaces": earlier.iter().map(json).collect::<Vec<_>>(),
            "versions": versions,
            "versions_truncated": more_versions,
            "truncated": more_later || more_earlier,
        })
    });
    let mut res = (StatusCode::OK, Json(body)).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

/// Where the record is kept besides memory: the store and the queue to its writer.
#[derive(Clone)]
pub struct Kept {
    pub store: Arc<Store>,
    /// Each batch with the store's generation when it was made ([`Store::write_from`]).
    pub queue: mpsc::Sender<(u64, Batch)>,
    /// Failures in a row, for the log's powers of two.
    failures: Arc<AtomicU64>,
    network: Network,
}

impl std::fmt::Debug for Kept {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Kept")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

impl Kept {
    /// Queues `batch` for the store, never waiting: when the writer is that far behind, the
    /// batch is dropped (memory still has it) and logged.
    pub fn send(&self, batch: Batch) {
        if batch.is_empty() {
            return;
        }
        let links = links(&batch);
        if self
            .queue
            .try_send((self.store.generation(), batch))
            .is_err()
        {
            self.failed("write", "queue_full", links);
        }
    }

    fn failed(&self, task: &'static str, error: &'static str, links: usize) {
        let failures = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
        if failures.is_power_of_two() {
            logging::emit(&ReplacementsStoreFailed {
                network: self.network.name(),
                task,
                error,
                links,
                failures,
            });
        }
    }

    /// Puts the stored record back into `r`, oldest first.
    pub async fn restore(&self, track: &crate::ws::Tracking) {
        let started = Instant::now();
        let keep = track.with_replacements(Replacements::cap);
        match engine::replacements::db::load_kept(&self.store, keep).await {
            Ok(links) => {
                let n = links.len();
                track.restore_kept(links);
                logging::emit(&ReplacementsRestored {
                    network: self.network.name(),
                    links: n,
                    duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                });
            }
            Err(e) => self.failed("restore", store_error(&e), 0),
        }
    }
}

/// New links in a batch, for the log.
fn links(batch: &[Change]) -> usize {
    batch
        .iter()
        .filter(|c| matches!(c, Change::Link(_)))
        .count()
}

fn store_error(e: &engine::store::Error) -> &'static str {
    match e {
        engine::store::Error::TimedOut => "timed_out",
        engine::store::Error::Held => "held",
        _ => "store",
    }
}

/// The store side of the record for `ctx`'s network, when it has a store: what feeds the writer,
/// and the writer, which runs until shutdown aborts it. Each write is one transaction that also
/// drops rows past `REPLACEMENTS_KEPT`, so the table never holds more than memory does.
pub fn writer(ctx: &NetworkContext) -> Option<(Kept, tokio::task::JoinHandle<()>)> {
    let store = Arc::clone(&ctx.blocks.as_ref()?.store);
    let (queue, mut rx) = mpsc::channel::<(u64, Batch)>(QUEUE);
    let kept = Kept {
        store,
        queue,
        failures: Arc::default(),
        network: ctx.config.network,
    };
    let keep = ctx.track.with_replacements(Replacements::cap);
    let k = kept.clone();
    let task = tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            // Whatever queued meanwhile goes in the same transaction, in order.
            let mut batches = vec![first];
            while let Ok(more) = rx.try_recv() {
                batches.push(more);
            }
            // Batches made before the node was last found on another chain, or while it was,
            // are never written.
            let now = k.store.generation();
            let (fresh, stale): (Vec<_>, Vec<_>) =
                batches.into_iter().partition(|(g, _)| *g == now);
            let stale: usize = stale.iter().map(|(_, b)| links(b)).sum();
            if stale > 0 {
                k.failed("write", "held", stale);
            }
            let batches: Vec<Batch> = fresh.into_iter().map(|(_, b)| b).collect();
            if batches.is_empty() {
                continue;
            }
            let links = batches.iter().map(|b| links(b)).sum();
            match engine::replacements::db::write_from(&k.store, now, batches, keep).await {
                Ok(()) => k.failures.store(0, Ordering::Relaxed),
                Err(e) => k.failed("write", store_error(&e), links),
            }
        }
    });
    Some((kept, task))
}
