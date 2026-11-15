//! Keeps one network's difficulty-adjustment answer current. The tip comes from the Electrum
//! events the hub already follows; on each new tip (a block, a reorg, a reconnect) the first
//! blocks of this period and the last are read from Esplora, two small requests, and the result
//! is held in memory. Requests only read it (SECURITY.md rule 8). The arithmetic is
//! `engine::difficulty`; what the answer means is `docs/API.md`.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use bitcoin::params::{self, Params};
use bitcoin::{BlockHash, CompactTarget};
use engine::difficulty::{Block, INTERVAL, Period, TESTNET5, period_start};
use logging::events::{DifficultyComputed, DifficultyRefreshFailed, DifficultyRetried};
use node::electrum;
use node::esplora::{Error, Esplora};
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::{broadcast, watch};

use crate::NetworkContext;
use crate::config::Network;

/// After a failed refresh, the first retry; doubled on each failure up to [`RETRY_MAX`].
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(60);

/// The latest answer, as of one tip.
#[derive(Debug, Clone, Copy)]
pub struct Answer {
    pub period: Period,
    /// The tip it was computed at.
    pub tip: BlockHash,
    pub computed: SystemTime,
}

/// One network's answer, written by [`run`] and read by request handlers.
#[derive(Debug)]
pub struct Difficulty(watch::Sender<Option<Answer>>);

impl Default for Difficulty {
    fn default() -> Self {
        Self(watch::Sender::new(None))
    }
}

impl Difficulty {
    /// `None` until the first tip has been read.
    pub fn current(&self) -> Option<Answer> {
        *self.0.borrow()
    }
}

#[cfg(test)]
impl Difficulty {
    pub(crate) fn set(&self, a: Answer) {
        self.0.send_replace(Some(a));
    }
}

/// Recomputes `ctx.difficulty` on every new tip until `events` ends. Bursts of blocks (catching
/// up after a restart) are coalesced into one refresh at the newest tip; a failed refresh keeps
/// the last answer and is retried with backoff.
pub async fn run(ctx: Arc<NetworkContext>, mut events: broadcast::Receiver<electrum::Event>) {
    let network = ctx.config.network;
    let mut failures = 0u32;
    let mut retries = 0u32;
    loop {
        let retry = match refresh(&ctx).await {
            Ok(()) => {
                failures = 0;
                retries = 0;
                None
            }
            // Expected during a burst of blocks: try again soon, or at the next tip, quietly.
            Err((height, "tip_moved")) => {
                retries = retries.saturating_add(1);
                if retries.is_power_of_two() {
                    logging::emit(&DifficultyRetried {
                        network: network.name(),
                        height,
                        retries,
                    });
                }
                Some(RETRY_MIN)
            }
            Err((height, error)) => {
                failures = failures.saturating_add(1);
                if failures.is_power_of_two() {
                    logging::emit(&DifficultyRefreshFailed {
                        network: network.name(),
                        height,
                        error,
                        failures,
                    });
                }
                Some(
                    RETRY_MIN
                        .saturating_mul(1 << (failures - 1).min(6))
                        .min(RETRY_MAX),
                )
            }
        };
        let event = match retry {
            None => Some(events.recv().await),
            Some(after) => tokio::time::timeout(after, events.recv()).await.ok(),
        };
        if matches!(event, Some(Err(RecvError::Closed))) {
            return;
        }
        loop {
            match events.try_recv() {
                Err(TryRecvError::Closed) => return,
                Err(TryRecvError::Empty) => break,
                Ok(_) | Err(TryRecvError::Lagged(_)) => {}
            }
        }
    }
}

/// Recomputes the answer if the tip moved. `Err` carries the tip's height and why.
async fn refresh(ctx: &NetworkContext) -> Result<(), (u32, &'static str)> {
    // Before the first connection there is nothing to compute; the first tip arrives as an event.
    let Some(tip) = ctx.electrum.tip() else {
        return Ok(());
    };
    if ctx.difficulty.current().is_some_and(|a| a.tip == tip.hash) {
        return Ok(());
    }
    let started = Instant::now();
    let failed = |e| (tip.height, e);
    let start = period_start(tip.height);
    let first = if start == tip.height {
        Block {
            height: start,
            time: tip.header.time.into(),
            bits: tip.header.bits,
        }
    } else {
        fetch(&ctx.esplora, start, tip.hash).await.map_err(failed)?
    };
    let previous = match start.checked_sub(INTERVAL) {
        Some(height) => Some(
            fetch(&ctx.esplora, height, tip.hash)
                .await
                .map_err(failed)?,
        ),
        None => None,
    };
    let network = ctx.config.network;
    let period = Period::new(
        params(network),
        tip.height,
        tip.header.time.into(),
        first,
        previous,
    )
    .map_err(|e| failed(e.label()))?;
    let computed = SystemTime::now();
    ctx.difficulty.0.send_replace(Some(Answer {
        period,
        tip: tip.hash,
        computed,
    }));
    let estimate = period.estimate(unix_ms(computed));
    logging::emit(&DifficultyComputed {
        network: network.name(),
        height: tip.height,
        next_retarget_height: estimate.next_retarget_height,
        difficulty_change: estimate.difficulty_change,
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    });
    Ok(())
}

/// The block at `height` on the chain whose tip is `tip`. A read stamped with another tip (a
/// block or reorg since the tip was taken) is refused, so blocks from two chains never mix.
async fn fetch(esplora: &Esplora, height: u32, tip: BlockHash) -> Result<Block, &'static str> {
    let read = esplora.blocks(Some(height)).await.map_err(|e| match e {
        Error::Timeout => "timeout",
        Error::ResponseTooBig => "response_too_big",
        Error::Decode(_) => "decode",
        Error::NotFound => "not_found",
        _ => "unavailable",
    })?;
    if read.tip.is_some_and(|t| t.hash != tip) {
        return Err("tip_moved");
    }
    let blocks = read.value;
    // Newest first, starting at `height`; a tip below it (a reorg in between) answers lower.
    let block = blocks
        .first()
        .filter(|b| b.height == height)
        .ok_or("wrong_height")?;
    Ok(Block {
        height,
        time: block.timestamp,
        bits: CompactTarget::from_consensus(block.bits),
    })
}

/// The network as rust-bitcoin names it, for address forms. It has no Testnet 5, which uses
/// testnet4's, as rbitcoin does.
pub(crate) fn chain(network: Network) -> bitcoin::Network {
    match network {
        Network::Mainnet => bitcoin::Network::Bitcoin,
        Network::Signet => bitcoin::Network::Signet,
        Network::Testnet4 | Network::Testnet5 => bitcoin::Network::Testnet4,
        Network::Regtest => bitcoin::Network::Regtest,
    }
}

/// The network's proof-of-work rules.
fn params(network: Network) -> &'static Params {
    match network {
        Network::Mainnet => &params::MAINNET,
        Network::Signet => &params::SIGNET,
        Network::Testnet4 => &params::TESTNET4,
        Network::Testnet5 => &TESTNET5,
        Network::Regtest => &params::REGTEST,
    }
}

/// Unix milliseconds; 0 for a clock before 1970.
pub fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
