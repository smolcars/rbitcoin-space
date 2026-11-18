//! The live mempool: a polled, diffed, in-memory copy of the node's mempool and a stream of
//! changes with the reason each transaction left. Design and numbers: `docs/MEMPOOL.md`.
//!
//! ```no_run
//! # async fn f(source: engine::mempool::NodeSource) {
//! use engine::mempool::{Config, Tracker};
//! let (tracker, _task) = Tracker::start(source, Config::default());
//! let (count, mut deltas) = tracker.subscribe(|m| m.len());
//! while let Ok(delta) = deltas.recv().await {
//!     // delta.seq follows the snapshot without a gap; apply delta.added and delta.removed.
//! }
//! # }
//! ```

mod model;
mod tracker;

pub use model::{BlockSpends, Delta, Mempool, Removal, TxInfo};
pub use tracker::{
    Config, CycleStats, Event, KEPT_OUTPUTS, NodeSource, Source, SourceError, Subscription, Tracker,
};
pub(crate) use tracker::{esplora_err, rpc_err};

#[cfg(test)]
mod tests;
