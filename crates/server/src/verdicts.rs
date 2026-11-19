//! What the server has learned about address histories the node will not finish, so it can refuse
//! them at once instead of spending the node's time again (docs/API.md, "Very large addresses").
//!
//! Two facts are kept, each for [`REMEMBER`], in a table of at most [`MAX_REMEMBERED`] entries:
//! the node refused a script's totals for size (no history is asked for that script), and one page
//! of a script's history ran past the history deadline (that page is not asked again).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bitcoin::{BlockHash, Txid};
use node::esplora::{Route, ScriptHash, ScriptSize};

/// How long a verdict holds. Long enough that reloads and other visitors in the meantime cost the
/// node nothing; short enough that a page slowed by a moment of load is asked again soon.
pub const REMEMBER: Duration = Duration::from_secs(300);
/// Verdicts kept per network: about 100 bytes each. Each one is learned from a node call, so the
/// address routes' cost limit already bounds how fast the table fills.
pub const MAX_REMEMBERED: usize = 4096;

/// `GET /app/address/:address/size`: how many transactions have paid an address and the node's cap,
/// as the node's last refusal of its totals said (docs/API.md, "Very large addresses"). Read from
/// memory only, never from the node; `404 size not known` when the server holds no such refusal.
pub async fn size_route(
    State(ctx): State<Arc<crate::NetworkContext>>,
    Path(address): Path<String>,
) -> Result<Response, crate::ApiError> {
    let payee = crate::esplora::payee(&address, ctx.config.network)?;
    let script = ScriptHash::from_script(&payee.script_pubkey());
    let size = ctx
        .api
        .verdicts
        .size(script, Instant::now())
        .ok_or(crate::ApiError::new(
            StatusCode::NOT_FOUND,
            "size not known",
        ))?;
    let body = serde_json::json!({ "creates": size.creates, "cap": size.cap });
    let mut res = (StatusCode::OK, Json(body)).into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The node refused the script's totals as above its `--max-sh-creates`, with the counts its
    /// refusal gave when it gave them.
    TooLarge(Option<ScriptSize>),
    /// The node answered the script's totals, and it is large (`crate::ledger::LARGE`): more
    /// funded outputs than that, or the answer took longer than the history deadline. Its
    /// totals are not asked of the node again except to seed it in the ledger.
    Large,
    /// This page of the history ran past the history deadline.
    Slow,
    /// The node answered the script's totals quickly and it is not large: asked freely.
    Small,
}

/// How long a script is remembered as [`Verdict::Large`]: an address's paying transactions only
/// grow, so it stays large; the bound is the table's.
pub const REMEMBER_LARGE: Duration = Duration::from_secs(30 * 24 * 3600);
/// How long a script is remembered as [`Verdict::Small`]: it may grow past the threshold.
pub const REMEMBER_SMALL: Duration = Duration::from_secs(3600);

/// One page of a script's history: its cursor and `?asof=`. `None` stands for the whole script.
type Page = Option<(Option<Txid>, Option<BlockHash>)>;

#[derive(Debug, Default)]
pub struct Verdicts {
    table: Mutex<HashMap<(ScriptHash, Page), (Verdict, Instant)>>,
}

/// The script and page a history route reads, or `None` for any other route. The `/txs`,
/// `/txs/chain` and `/txs/summary` forms of one page cost the node the same join, so they share it.
pub fn history_page(route: &Route) -> Option<(ScriptHash, Page)> {
    let (script, cursor, asof) = match route {
        Route::ScriptTxs {
            script,
            after,
            asof,
        } => (script, after, asof),
        Route::ScriptTxsChain {
            script,
            last_seen,
            asof,
        }
        | Route::ScriptTxsSummary {
            script,
            last_seen,
            asof,
        } => (script, last_seen, asof),
        _ => return None,
    };
    Some((script.script_hash(), Some((*cursor, *asof))))
}

/// The script the totals and unspent routes read.
pub fn unpaged_script(route: &Route) -> Option<ScriptHash> {
    match route {
        Route::ScriptStats { script, .. } | Route::ScriptUtxo { script, .. } => {
            Some(script.script_hash())
        }
        _ => None,
    }
}

impl Verdicts {
    /// Why this page would be refused: the script's size first, then the page's own time.
    /// `None` when nothing refuses it (a small script is not a refusal).
    pub fn check(&self, script: ScriptHash, page: Page, now: Instant) -> Option<Verdict> {
        let table = self.table.lock().unwrap_or_else(PoisonError::into_inner);
        [(script, None), (script, page)]
            .iter()
            .find_map(|k| {
                table
                    .get(k)
                    .filter(|(v, until)| *until > now && *v != Verdict::Small)
            })
            .map(|(v, _)| *v)
    }

    /// What is known about the script as a whole: its size.
    pub fn class(&self, script: ScriptHash, now: Instant) -> Option<Verdict> {
        let table = self.table.lock().unwrap_or_else(PoisonError::into_inner);
        table
            .get(&(script, None))
            .filter(|(_, until)| *until > now)
            .map(|(v, _)| *v)
    }

    /// The size the node gave when it last refused this script's totals, if that is still known.
    pub fn size(&self, script: ScriptHash, now: Instant) -> Option<ScriptSize> {
        match self.check(script, None, now) {
            Some(Verdict::TooLarge(size)) => size,
            _ => None,
        }
    }

    pub fn learn(&self, script: ScriptHash, page: Page, verdict: Verdict, now: Instant) {
        let mut table = self.table.lock().unwrap_or_else(PoisonError::into_inner);
        let key = (script, page);
        if !table.contains_key(&key) && table.len() >= MAX_REMEMBERED {
            table.retain(|_, (_, until)| *until > now);
            // Still full of live verdicts: the one closest to expiring makes room.
            if table.len() >= MAX_REMEMBERED
                && let Some(oldest) = table.iter().min_by_key(|(_, (_, u))| *u).map(|(k, _)| *k)
            {
                table.remove(&oldest);
            }
        }
        let keep = match verdict {
            Verdict::Large => REMEMBER_LARGE,
            Verdict::Small => REMEMBER_SMALL,
            Verdict::TooLarge(_) | Verdict::Slow => REMEMBER,
        };
        table.insert(key, (verdict, now + keep));
    }

    pub fn len(&self) -> usize {
        self.table
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use bitcoin::hashes::Hash;

    fn script(n: u32) -> ScriptHash {
        ScriptHash::from_script(bitcoin::Script::from_bytes(&n.to_le_bytes()))
    }

    fn first_page() -> Page {
        Some((None, None))
    }

    #[test]
    fn a_size_verdict_covers_every_page_and_a_slow_one_only_its_own() {
        let v = Verdicts::default();
        let now = Instant::now();
        v.learn(script(1), None, Verdict::TooLarge(None), now);
        let later = Some((Some(Txid::all_zeros()), None));
        assert_eq!(
            v.check(script(1), first_page(), now),
            Some(Verdict::TooLarge(None))
        );
        assert_eq!(
            v.check(script(1), later, now),
            Some(Verdict::TooLarge(None))
        );
        v.learn(script(2), first_page(), Verdict::Slow, now);
        assert_eq!(v.check(script(2), first_page(), now), Some(Verdict::Slow));
        assert_eq!(v.check(script(2), later, now), None);
        assert_eq!(v.check(script(3), first_page(), now), None);
    }

    #[test]
    fn a_small_script_still_has_its_slow_pages() {
        let v = Verdicts::default();
        let now = Instant::now();
        v.learn(script(1), None, Verdict::Small, now);
        v.learn(script(1), first_page(), Verdict::Slow, now);
        assert_eq!(v.check(script(1), first_page(), now), Some(Verdict::Slow));
        assert_eq!(
            v.check(script(1), Some((None, Some(BlockHash::all_zeros()))), now),
            None
        );
        assert_eq!(v.class(script(1), now), Some(Verdict::Small));
    }

    #[test]
    fn verdicts_expire() {
        let v = Verdicts::default();
        let now = Instant::now();
        v.learn(script(1), None, Verdict::TooLarge(None), now);
        let edge = now + REMEMBER;
        assert_eq!(
            v.check(script(1), first_page(), edge - Duration::from_millis(1)),
            Some(Verdict::TooLarge(None))
        );
        assert_eq!(v.check(script(1), first_page(), edge), None);
    }

    #[test]
    fn the_table_is_bounded_and_drops_expired_then_oldest() {
        let v = Verdicts::default();
        let start = Instant::now();
        let n = u32::try_from(MAX_REMEMBERED).unwrap();
        for i in 0..n {
            v.learn(
                script(i),
                None,
                Verdict::TooLarge(None),
                start + Duration::from_millis(u64::from(i)),
            );
        }
        assert_eq!(v.len(), MAX_REMEMBERED);
        // Full of live verdicts: the oldest goes.
        let now = start + Duration::from_secs(10);
        v.learn(script(n), None, Verdict::TooLarge(None), now);
        assert_eq!(v.len(), MAX_REMEMBERED);
        assert_eq!(v.check(script(0), None, now), None);
        assert_eq!(v.check(script(1), None, now), Some(Verdict::TooLarge(None)));
        // Once they have expired, a new one sweeps them all out.
        let much_later = start + REMEMBER + Duration::from_secs(20);
        v.learn(script(n + 1), None, Verdict::Slow, much_later);
        assert_eq!(v.len(), 1);
    }
}
