//! `/app/lightning/penalties` (`docs/API.md`, "Lightning"): the breaches this server saw swept,
//! newest sweep first, a page at a time from the store, with the nodes' aliases from the index.

use std::sync::Arc;

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::routing::get;
use engine::lightning as store_ln;
use serde_json::{Value, json};

use super::nodes::{Answer, PAGE, graph, number, query, send};
use super::{aliases, channel_json, store_error};
use crate::NetworkContext;
use crate::error::ApiError;

/// Deepest page, as for a node's channels: the graph's ceiling over [`PAGE`].
const LAST_PAGE: u64 = 4_000;

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new().route("/app/lightning/penalties", get(app_penalties))
}

/// `?page=N`, 0 to [`LAST_PAGE`], and nothing else.
fn page(raw: Option<&str>) -> Result<usize, ApiError> {
    let q = query(raw, &["page"], true)?;
    Ok(match q.get("page") {
        None => 0,
        Some(p) => number(p, LAST_PAGE).ok_or(ApiError::bad_request("page is 0 to 4000"))? as usize,
    })
}

async fn app_penalties(State(ctx): State<Arc<NetworkContext>>, RawQuery(raw): RawQuery) -> Answer {
    let page = page(raw.as_deref())?;
    let (index, l, store) = graph(&ctx)?;
    let (total, rows) = store_ln::penalties(store, page * PAGE, PAGE)
        .await
        .map_err(|e| store_error(&e))?;
    let names = aliases(l, &rows);
    let v = json!({
        "page": page,
        "per_page": PAGE,
        "total": total,
        // When our history starts: no penalty before it can be known.
        "from": index.start,
        "channels": rows.iter().map(|c| channel_json(c, &names)).collect::<Vec<Value>>(),
    });
    Ok(send(&v, "lightning_penalties"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::page;

    #[test]
    fn the_page_is_read_strictly() {
        assert_eq!(page(None).unwrap(), 0);
        assert_eq!(page(Some("")).unwrap(), 0);
        assert_eq!(page(Some("page=0")).unwrap(), 0);
        assert_eq!(page(Some("page=4000")).unwrap(), 4_000);
        for bad in [
            "page=4001",
            "page=-1",
            "page=01",
            "page=",
            "page=1&page=1",
            "page=1&limit=2",
            "page=1e3",
            "page=99999999999999999999999",
        ] {
            assert!(page(Some(bad)).is_err(), "{bad}");
        }
    }
}
