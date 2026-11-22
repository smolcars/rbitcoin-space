//! Keeps the newest rows in line with the node's best chain.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bitcoin::BlockHash;

use super::backfill::BATCH;
use super::db::{self, RATE, REPLACE};
use super::{Error, Header, RATED_BY_FOLLOW, Rated, Source, ZONE};
use crate::store::{Read, Store, params};

/// Counts [`follow`]'s writes that replaced or removed rows. The backfill drops a batch it read
/// before one, since that batch may come from the chain the reorg left. Cheap to clone.
#[derive(Debug, Clone, Default)]
pub struct Reorgs(Arc<AtomicU64>);

impl Reorgs {
    pub(super) fn seen(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(super) fn bump(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// What one [`follow`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Followed {
    /// The node's best height.
    pub tip: u32,
    /// Rows written: new blocks, and blocks replacing stale rows.
    pub written: usize,
    /// Rows that described blocks no longer on the best chain, replaced or removed.
    pub stale: usize,
    /// The highest height whose row still agreed, when there were stale rows.
    pub fork: Option<u32>,
    /// Rows given fee rates.
    pub rated: usize,
}

/// Brings the newest [`ZONE`] rows in line with the node's best chain; call it on every new tip.
///
/// A row whose hash differs from the node's block at that height is stale: it and every row
/// above the tip are replaced or removed in one write, so readers never see a mix. Below the
/// zone, the highest stored row must agree with the node too, however many heights below the
/// zone are still missing (after downtime, say); while a page of rows under it holds a stale
/// one, the walk goes on down, jumping heights not stored, so it reaches every stale row of a
/// reorg however deep; it reads one page more than there are stale rows. Missing rows in the
/// zone are added; below it they are the backfill's. The newest [`RATED_BY_FOLLOW`] rows get
/// fee rates from [`Source::facts`]. If the tip moved while the chain was read, nothing is
/// written and the call fails, to be retried.
pub async fn follow<S: Source>(
    store: &Store,
    source: &S,
    reorgs: &Reorgs,
) -> Result<Followed, Error> {
    let mut headers: Vec<Header> = Vec::new();
    let mut stored: HashMap<u32, (BlockHash, bool)> = HashMap::new();
    // The zone, page by page from the tip.
    let mut top = None;
    loop {
        let page = source.headers(top).await?;
        let (Some(first), Some(last)) = (page.first(), page.last()) else {
            break;
        };
        // Pages are read one after another; if the tip moved between them they do not join.
        if headers
            .last()
            .is_some_and(|h| h.previousblockhash != Some(first.id))
        {
            return Err(Error::Moved);
        }
        let (lo, hi) = (last.height, first.height);
        stored.extend(
            store
                .read(Read::BlockFollow, move |sql| db::stored(sql, lo, hi))
                .await?,
        );
        headers.extend(page);
        let tip = headers.first().map_or(0, |h| h.height);
        match lo.checked_sub(1) {
            Some(next) if tip - lo + 1 < ZONE => top = Some(next),
            _ => break,
        }
    }
    // Below it, from the highest stored row down, while pages hold stale rows.
    while let Some(below) = headers.last().and_then(|h| h.height.checked_sub(1)) {
        let Some(h) = store
            .read(Read::BlockFollow, move |sql| db::highest(sql, below))
            .await?
        else {
            break;
        };
        let page = source.headers(Some(h)).await?;
        let (Some(first), Some(last)) = (page.first(), page.last()) else {
            break;
        };
        if first.height == below
            && headers.last().and_then(|h| h.previousblockhash) != Some(first.id)
        {
            return Err(Error::Moved);
        }
        let (lo, hi) = (last.height, first.height);
        let here = store
            .read(Read::BlockFollow, move |sql| db::stored(sql, lo, hi))
            .await?;
        let stale_here = page
            .iter()
            .any(|h| here.get(&h.height).is_some_and(|(s, _)| *s != h.id));
        stored.extend(here);
        headers.extend(page);
        if !stale_here {
            break;
        }
    }
    let Some((tip, tip_hash)) = headers.first().map(|h| (h.height, h.id)) else {
        return Ok(Followed::default());
    };
    // Pages below the zone may not join the ones above; one tip before and after means they all
    // come from one chain.
    if source.headers(None).await?.first().map(|h| h.id) != Some(tip_hash) {
        return Err(Error::Moved);
    }

    let mut fork = None;
    let mut stale = 0;
    let mut need = Vec::new();
    for h in &headers {
        match stored.get(&h.height) {
            Some((s, _)) if *s == h.id => continue,
            Some(_) => {
                stale += 1;
                fork = Some(h.height.saturating_sub(1));
            }
            None if tip - h.height >= ZONE => continue,
            None => {}
        }
        need.push(h.clone());
    }
    // Read in batches the node takes; written below in one transaction.
    let mut rows = Vec::with_capacity(need.len());
    for chunk in need.chunks(BATCH) {
        rows.extend(source.rows(chunk).await?);
    }

    // Rates for the newest blocks, from summaries computed for them anyway.
    let mut rate = Vec::new();
    for h in headers.iter().take(RATED_BY_FOLLOW as usize) {
        let new = rows.iter_mut().find(|r| r.hash == h.id);
        let rated = stored.get(&h.height).is_some_and(|(s, r)| *s == h.id && *r);
        if rated {
            continue;
        }
        let Some(facts) = source.facts(h.height, h.id).await? else {
            continue;
        };
        match new {
            Some(row) => row.rates = Some(Rated::from(&facts)),
            None => rate.push((h.height, h.id, Rated::from(&facts))),
        }
    }

    let written = rows.len();
    let reorgs = reorgs.clone();
    let (removed, rated) = store
        .write(move |sql| {
            let removed = sql
                .prepare("DELETE FROM blocks WHERE height > ?1")?
                .execute(params![tip])?;
            // On the writer thread, so every later write sees it.
            if stale + removed > 0 {
                reorgs.0.fetch_add(1, Ordering::SeqCst);
            }
            let mut replace = sql.prepare(REPLACE)?;
            for row in &rows {
                db::write_row(&mut replace, row)?;
            }
            let rated_new = rows.iter().filter(|r| r.rates.is_some()).count();
            let mut update = sql.prepare(RATE)?;
            let mut rated = rated_new;
            for (height, hash, r) in &rate {
                rated += usize::from(db::rate_row(&mut update, *height, hash, r)?);
            }
            Ok((removed, rated))
        })
        .await?;
    if removed > 0 {
        fork = Some(fork.map_or(tip, |f| f.min(tip)));
    }
    Ok(Followed {
        tip,
        written,
        stale: stale + removed,
        fork,
        rated,
    })
}
