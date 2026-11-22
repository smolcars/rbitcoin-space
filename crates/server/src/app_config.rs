//! `GET /app/config`: what the frontend needs before it can draw the shell. Server-wide, so it is
//! served at the root only, whichever networks are enabled.

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::{Config, NetworkConfig};

/// The Ark implementations a network looks VTXOs up on, by their path name (docs/ARK.md).
fn ark(n: &NetworkConfig) -> Vec<&'static str> {
    let mut list = Vec::new();
    if n.bark.is_some() {
        list.push("bark");
    }
    if n.arkade.is_some() {
        list.push("arkade");
    }
    list
}

pub fn routes(config: &Config) -> Router {
    // The answer never changes while the process runs, so it is built once. `ark` names only the
    // networks that have an implementation; the frontend offers Ark pages on those alone, and
    // Lightning pages only on the networks in `lightning`.
    let ark: serde_json::Map<String, Value> = config
        .networks
        .iter()
        .map(|n| (n.network.name().to_owned(), json!(ark(n))))
        .filter(|(_, l)| l.as_array().is_some_and(|a| !a.is_empty()))
        .collect();
    let body = json!({
        "networks": config.networks.iter().map(|n| n.network.name()).collect::<Vec<_>>(),
        "version": env!("CARGO_PKG_VERSION"),
        "ark": ark,
        "lightning": config.networks.iter().filter(|n| n.lightning.is_some()).map(|n| n.network.name()).collect::<Vec<_>>(),
        "broadcast": config.broadcast,
        "mcp": config.mcp,
    });
    Router::new().route(
        "/app/config",
        get(move || async move { Json::<Value>(body) }),
    )
}
