//! Fills the rows of every block below [`ZONE`], newest first, without crowding the node.
//!
//! Two tiers run interleaved, one step each in turn:
//! - **totals:** rows without fee rates for every block, [`BATCH`] blocks per step: Esplora
//!   headers, one batched `getblockstats` limited to cheap stats, the coinbase txids, one batched
//!   `getrawtransaction`;
//! - **rates:** fee rates for the rows within [`Options::fee_rate_depth`] of the tip, one
//!   `getblock` each.
//!
//! Gentle by construction: one call in flight at most, since every node call is awaited before
//! the next; after each step a pause so the node is busy for at most [`Options::busy_percent`]
//! of the time; and on failure a back-off from [`BACKOFF_MIN`] doubling to [`BACKOFF_MAX`].
//! Resumable: the table is the progress. Each pass starts at the tip and skips rows already
//! there, reading the table [`SCAN`] heights at a time, down to the node's first retained height.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

use super::db::{self, INSERT_NEW, RATE};
use super::{Error, RATED_BY_FOLLOW, Rated, Reorgs, Source, SourceError, ZONE};
use crate::store::{Read, Store};

/// Blocks per totals step: one `getblockstats` batch of about 1.3 s of node time for full
/// mainnet blocks, far inside the RPC timeout.
pub const BATCH: usize = 50;
/// Heights read from the table at once when looking for missing rows: a few milliseconds.
pub const SCAN: u32 = 10_000;
/// First pause after a failure; it doubles with each failure in a row.
pub const BACKOFF_MIN: Duration = Duration::from_secs(5);
pub const BACKOFF_MAX: Duration = Duration::from_secs(300);
/// How often the tip and prune watermark are checked and progress is reported while working.
pub const TICK: Duration = Duration::from_secs(60);

/// Settings for [`backfill`].
#[derive(Clone)]
pub struct Options {
    /// Share of wall time, 1 to 100, the backfill keeps the node busy: after a step that took
    /// `t`, it waits `t * (100 - busy_percent) / busy_percent`.
    pub busy_percent: u32,
    /// Blocks below the tip that get fee rates; 0 for none.
    pub fee_rate_depth: u32,
    pub observer: Arc<dyn Fn(&Event) + Send + Sync>,
    /// The same [`Reorgs`] that [`super::follow`] is given.
    pub reorgs: Reorgs,
}

/// Something worth reporting. Passed to [`Options::observer`].
#[derive(Debug)]
pub enum Event<'a> {
    /// Every [`TICK`] while steps write, and when a pass completes. `counted` is false when the row
    /// count failed or timed out: `rows` and `rated` are then the last counted, not now's.
    Progress {
        progress: &'a Progress,
        counted: bool,
    },
    /// A step failed; it is retried after a back-off. `failures` counts them in a row.
    Failed {
        tier: &'static str,
        error: &'a Error,
        failures: u32,
    },
    /// A step succeeded after `failures` in a row.
    Recovered { failures: u32 },
}

/// Where the backfill stands, as a status page would show it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    /// The node's best height at the last check.
    pub tip: u32,
    /// Rows in the table, and how many are rated.
    pub rows: u64,
    pub rated: u64,
    /// Finished adding rows in the retained range below the zone.
    pub totals_done: bool,
    /// Finished rating rows within the fee-rate depth and the retained range.
    pub rates_done: bool,
    /// Since the start: rows added, rows rated, time spent on steps (node calls and writes),
    /// and response bytes read.
    pub totals_written: u64,
    pub rates_written: u64,
    pub busy: Duration,
    pub bytes: u64,
}

/// Runs until the task is dropped. `progress` always holds the latest [`Progress`].
pub async fn backfill<S: Source>(
    store: Arc<Store>,
    source: S,
    options: Options,
    progress: &watch::Sender<Progress>,
) {
    let busy_percent = options.busy_percent.clamp(1, 100);
    let mut p = Progress::default();
    let mut floor = 0;
    // The next height each tier looks at; `None` once its pass is done.
    let (mut totals, mut rates): (Option<u32>, Option<u32>) = (None, None);
    let mut failures = 0u32;
    let mut checked: Option<Instant> = None;
    let mut reported = Instant::now();
    // No step has written since the last report.
    let mut idle = false;
    let start_bytes = source.bytes();

    loop {
        if checked.is_none_or(|at| at.elapsed() >= TICK) {
            match source.chain_state().await {
                Ok((t, pruned)) => {
                    let new_floor = pruned.map_or(0, |h| h.saturating_add(1));
                    if checked.is_none() || p.tip != t || new_floor < floor {
                        p.tip = t;
                        totals = t.checked_sub(ZONE);
                        rates = t
                            .checked_sub(RATED_BY_FOLLOW)
                            .filter(|_| options.fee_rate_depth > 0);
                    }
                    floor = new_floor;
                    checked = Some(Instant::now());
                }
                Err(e) => {
                    failures += 1;
                    let e = Error::from(e);
                    (options.observer)(&Event::Failed {
                        tier: "tip",
                        error: &e,
                        failures,
                    });
                    tokio::time::sleep(backoff(failures)).await;
                    continue;
                }
            }
        }
        let rates_floor = floor.max(p.tip.saturating_sub(options.fee_rate_depth));

        let started = Instant::now();
        let mut worked = false;
        let mut failed = None;
        if let Some(c) = totals {
            match totals_step(&store, &source, floor, c, &options.reorgs).await {
                Ok((next, n)) => {
                    totals = next;
                    p.totals_written += n as u64;
                    worked |= n > 0;
                }
                Err(e) => failed = Some(("totals", e)),
            }
        }
        if failed.is_none()
            && let Some(c) = rates
        {
            match rates_step(&store, &source, rates_floor, c).await {
                Ok((next, n)) => {
                    rates = next;
                    p.rates_written += n as u64;
                    worked |= n > 0;
                }
                Err(e) => failed = Some(("rates", e)),
            }
        }
        // rbitcoin may prune more data between the status check and a body read.
        // Retry the same cursor with the narrower range only if the new watermark covers
        // the failed height. Other errors and unconfirmed prune errors take the normal back-off,
        // and a failed check reports its own error.
        let mut replanned = false;
        if let Some((_, Error::Pruned(height))) = &failed {
            match source.chain_state().await {
                Ok((_, Some(pruned))) if pruned >= floor && pruned >= *height => {
                    floor = pruned.saturating_add(1);
                    failed = None;
                    replanned = true;
                }
                Ok(_) => {}
                Err(e) => failed = Some(("tip", e.into())),
            }
        }
        let took = started.elapsed();
        p.busy += took;
        p.bytes = source.bytes().saturating_sub(start_bytes);

        if let Some((tier, e)) = failed {
            failures += 1;
            (options.observer)(&Event::Failed {
                tier,
                error: &e,
                failures,
            });
            tokio::time::sleep(backoff(failures)).await;
            continue;
        }
        // A replan has not read anything yet: the streak ends at the next step that succeeds.
        if failures > 0 && !replanned {
            (options.observer)(&Event::Recovered { failures });
            failures = 0;
        }
        let done = (totals.is_none(), rates.is_none());
        let finished = done != (p.totals_done, p.rates_done) && done.0 && done.1;
        (p.totals_done, p.rates_done) = done;
        idle &= !worked;
        // Once everything is done the table changes only by follow's writes: nothing to report.
        if finished || (!idle && reported.elapsed() >= TICK) {
            (reported, idle) = (Instant::now(), true);
            let counted = store.read(Read::BlockCounts, db::counts).await;
            if let Ok((rows, rated)) = counted {
                (p.rows, p.rated) = (rows, rated);
            }
            (options.observer)(&Event::Progress {
                progress: &p,
                counted: counted.is_ok(),
            });
        }
        progress.send_replace(p.clone());
        if done.0 && done.1 {
            tokio::time::sleep(TICK).await;
        } else if worked || replanned {
            let rest = 100 - busy_percent;
            tokio::time::sleep(took * rest / busy_percent).await;
        }
    }
}

fn backoff(failures: u32) -> Duration {
    BACKOFF_MIN
        .saturating_mul(1 << failures.saturating_sub(1).min(16))
        .min(BACKOFF_MAX)
}

/// Adds rows for one run of up to [`BATCH`] consecutive missing heights in `floor..=cursor`,
/// the highest first.
/// Returns the next cursor (`None` when the floor is passed) and the rows added.
pub(super) async fn totals_step<S: Source>(
    store: &Store,
    source: &S,
    floor: u32,
    cursor: u32,
    reorgs: &Reorgs,
) -> Result<(Option<u32>, usize), Error> {
    let seen = reorgs.seen();
    let mut hi = cursor;
    let missing = loop {
        if hi < floor {
            return Ok((None, 0));
        }
        // Heights whose 1,008-height buckets hold every row are skipped without reading them.
        let found = store
            .read(Read::Backfill, move |sql| {
                sql.prepare("BEGIN")?.execute([])?;
                let top = match super::totals::below_full(sql, hi)? {
                    Some(None) => return Ok(None),
                    Some(Some(top)) => top,
                    None => hi,
                };
                if top < floor {
                    return Ok(None);
                }
                let lo = floor.max(top.saturating_sub(SCAN - 1));
                Ok(Some((top, lo, db::present(sql, lo, top)?)))
            })
            .await?;
        let Some((top, lo, present)) = found else {
            return Ok((None, 0));
        };
        hi = top;
        let present: std::collections::HashSet<u32> = present.into_iter().collect();
        // One run of consecutive heights, so the row checked below it is the only one under it.
        let mut missing: Vec<u32> = Vec::new();
        for h in (lo..=hi).rev().filter(|h| !present.contains(h)) {
            if missing.len() == BATCH || missing.last().is_some_and(|&l| l != h + 1) {
                break;
            }
            missing.push(h);
        }
        if !missing.is_empty() {
            break missing;
        }
        match lo.checked_sub(1) {
            Some(next) => hi = next,
            None => return Ok((None, 0)),
        }
    };
    let mut headers = Vec::with_capacity(missing.len());
    let mut rest = missing.as_slice();
    while let Some(&top) = rest.first() {
        let page = source.headers(Some(top)).await?;
        let Some(low) = page.last().map(|h| h.height) else {
            break;
        };
        headers.extend(page.into_iter().filter(|h| rest.contains(&h.height)));
        rest = rest
            .iter()
            .position(|&h| h < low)
            .and_then(|i| rest.get(i..))
            .unwrap_or_default();
    }
    // Fewer headers than asked: the chain shrank under us. Retry after the back-off; the next
    // tip check moves the cursor.
    if headers.len() != missing.len() {
        return Err(SourceError::Failed("headers missing for some heights".into()).into());
    }
    // The stored row below the batch must be on the batch's chain. If a reorg left it stale,
    // writing current rows above it would hide it from follow, whose walk stops at the first
    // page that agrees. Delete it instead; the next steps check the rows under it the same way
    // and refill the heights.
    if let Some(below) = headers.last().and_then(|h| h.height.checked_sub(1)) {
        let found = store
            .read(Read::Backfill, move |sql| match db::highest(sql, below)? {
                Some(b) => Ok(db::stored(sql, b, b)?.remove(&b).map(|(h, _)| (b, h))),
                None => Ok(None),
            })
            .await?;
        if let Some((b, hash)) = found {
            let node = if b == below {
                headers.last().and_then(|h| h.previousblockhash)
            } else {
                let page = source.headers(Some(b)).await?;
                page.first().filter(|h| h.height == b).map(|h| h.id)
            };
            if node != Some(hash) {
                store
                    .write(move |sql| db::delete_row(sql, b, &hash))
                    .await?;
                return Ok((Some(cursor), 0));
            }
        }
    }
    let rows = source.rows(&headers).await?;
    let reorgs = reorgs.clone();
    let added = store
        .write(move |sql| {
            // Follow replaced rows since this batch was read: it may be from the old chain.
            if reorgs.seen() != seen {
                return Ok(None);
            }
            let mut insert = sql.prepare(INSERT_NEW)?;
            let mut added = 0;
            for row in &rows {
                added += db::write_row(&mut insert, row)?;
            }
            Ok(Some(added))
        })
        .await?;
    let Some(added) = added else {
        return Ok((Some(cursor), 0));
    };
    let next = missing
        .last()
        .and_then(|h| h.checked_sub(1))
        .filter(|&n| n >= floor);
    Ok((next, added))
}

/// Rates the highest unrated row in `floor..=cursor`. Returns the next cursor (`None` once the
/// floor is passed) and the rows rated (0 or 1).
async fn rates_step<S: Source>(
    store: &Store,
    source: &S,
    floor: u32,
    cursor: u32,
) -> Result<(Option<u32>, usize), Error> {
    if cursor < floor {
        return Ok((None, 0));
    }
    let Some((height, hash)) = store
        .read(Read::Backfill, move |sql| {
            db::next_unrated(sql, floor, cursor)
        })
        .await?
    else {
        return Ok((None, 0));
    };
    let next = height.checked_sub(1).filter(|&n| n >= floor);
    // An unknown block is a stale row; the next follow replaces it.
    let Some(facts) = source.facts(height, hash).await? else {
        return Ok((next, 0));
    };
    let rated = Rated::from(&facts);
    let changed = store
        .write(move |sql| {
            Ok(db::rate_row(
                &mut sql.prepare(RATE)?,
                height,
                &hash,
                &rated,
            )?)
        })
        .await?;
    Ok((next, usize::from(changed)))
}
