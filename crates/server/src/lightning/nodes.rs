//! Nodes, channels, search and rankings (`docs/API.md`, "Lightning"): `/app/lightning/…` for our
//! pages and `/api/v1/lightning/…` in the reference's shapes, both from the graph's [`Index`] and
//! indexed store reads. No request asks the node or takes the graph's lock.
//!
//! Every alias here is a node's own claim: serialized as a JSON string, never trusted or parsed.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path as UrlPath, RawQuery, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{any, get};
use bitcoin::Txid;
use engine::lightning::{
    self as store_ln, Bucket, Channel, GraphChannel, Index, Kind, Link, Node, Policy, Rank,
};
use engine::store::Store;
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    Lightning, block_json, channel_json, enabled, hex, json_response, scid_text, store_error,
};
use crate::NetworkContext;
use crate::error::ApiError;

pub(crate) const SYNCING: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "lightning graph is still syncing; retry",
);
const NO_INDEX: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "lightning graph is synced but cannot be indexed; retry later",
);
pub(crate) const NO_NODE: ApiError = ApiError::new(StatusCode::NOT_FOUND, "node not found");
pub(crate) const NO_CHANNEL: ApiError = ApiError::new(StatusCode::NOT_FOUND, "channel not found");
const BAD_KEY: ApiError = ApiError::bad_request("invalid public key: 66 hex digits");
const BAD_CHANNEL: ApiError =
    ApiError::bad_request("invalid channel id: a decimal id or <height>x<index>x<output>");
const BAD_SEARCH: ApiError =
    ApiError::bad_request("search text is 3 to 66 characters, without control characters");

/// Results of each kind a search returns.
pub(crate) const SEARCH_MAX: usize = 10;
/// Channels per page: ours, and the reference's.
pub(crate) const PAGE: usize = 25;
const V1_PAGE: usize = 10;
/// Channels in an `index=-1` answer, largest first: the reference's own cap, observed.
pub(crate) const V1_ALL: usize = 1_000;
/// Deepest offset into a node's channels: the graph's ceiling.
const MAX_OFFSET: usize = 100_000;
/// Nodes in each list of `/api/v1/lightning/nodes/rankings`, as the reference sends.
const V1_TOP: usize = 6;
/// Answers lag the graph by at most the index's rebuild period.
const CACHE: &str = "public, max-age=10";

pub fn routes() -> Router<Arc<NetworkContext>> {
    Router::new()
        .route("/app/lightning/overview", get(app_overview))
        .route("/app/lightning/search", get(app_search))
        .route("/app/lightning/rankings/{by}", get(app_rankings))
        .route("/app/lightning/nodes/{key}", get(app_node))
        .route(
            "/app/lightning/nodes/{key}/channels",
            get(app_node_channels),
        )
        .route("/app/lightning/nodes/{key}/history", get(app_node_history))
        .route("/app/lightning/channels/{id}", get(app_channel))
        .route("/app/lightning/tx/{txid}", get(app_tx))
        .route("/app/lightning/block/{hash}", get(app_block))
        .route("/api/v1/lightning/search", get(v1_search))
        .route("/api/v1/lightning/nodes/rankings", get(v1_rankings))
        .route("/api/v1/lightning/nodes/rankings/{by}", get(v1_ranking))
        .route("/api/v1/lightning/nodes/{key}", get(v1_node))
        // The reference's location routes, which we do not serve (no GeoIP): answered as any
        // route we do not serve, not as a malformed key.
        .route("/api/v1/lightning/nodes/countries", any(crate::not_found))
        .route("/api/v1/lightning/nodes/world", any(crate::not_found))
        // Without an IP database: the capacity by address kind, and no provider or place.
        .route("/api/v1/lightning/nodes/isp-ranking", get(v1_isp_ranking))
        .route("/api/v1/lightning/channels-geo", get(v1_channels_geo))
        .route(
            "/api/v1/lightning/channels-geo/{key}",
            get(v1_node_channels_geo),
        )
        .route(
            "/api/v1/lightning/nodes/{key}/statistics",
            get(v1_node_statistics),
        )
        .route("/api/v1/lightning/nodes/{key}/fees/histogram", get(v1_fees))
        .route("/api/v1/lightning/channels", get(v1_node_channels))
        .route("/api/v1/lightning/channels/txids", get(v1_txids))
        // As the reference's frontend asks it: a listed path, not a rule for every slash.
        .route("/api/v1/lightning/channels/txids/", get(v1_txids))
        .route("/api/v1/lightning/channels/{id}", get(v1_channel))
}

pub(crate) fn send(v: &impl Serialize, route: &'static str) -> Response {
    match serde_json::to_vec(v) {
        Ok(b) => json_response(b.into(), route, CACHE),
        Err(_) => axum::response::IntoResponse::into_response(ApiError::INTERNAL),
    }
}

pub(crate) type Answer = Result<Response, ApiError>;

/// The index, the Lightning side and the store, or why a route cannot answer yet.
pub(crate) fn graph(
    ctx: &NetworkContext,
) -> Result<(Arc<Index>, &Lightning, &Arc<Store>), ApiError> {
    let (l, store) = enabled(ctx)?;
    let unindexed = || if l.index_failing() { NO_INDEX } else { SYNCING };
    Ok((l.index().ok_or_else(unindexed)?, l, store))
}

// Parameters: each parsed into its type before any work.

/// A compressed public key: exactly 66 hex digits, any case.
pub(crate) fn pubkey(s: &str) -> Result<[u8; 33], ApiError> {
    if s.len() != 66 {
        return Err(BAD_KEY);
    }
    let mut out = [0; 33];
    for (o, pair) in out.iter_mut().zip(s.as_bytes().chunks(2)) {
        let pair = std::str::from_utf8(pair).map_err(|_| BAD_KEY)?;
        if !pair.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BAD_KEY);
        }
        *o = u8::from_str_radix(pair, 16).map_err(|_| BAD_KEY)?;
    }
    Ok(out)
}

/// Decimal digits without a leading zero (but `0`), as a number at most `max`.
pub(crate) fn number(s: &str, max: u64) -> Option<u64> {
    let plain = !s.is_empty()
        && s.len() <= 20
        && s.bytes().all(|b| b.is_ascii_digit())
        && (s == "0" || !s.starts_with('0'));
    plain
        .then(|| s.parse().ok())
        .flatten()
        .filter(|n| *n <= max)
}

/// A short channel id, as the 64-bit decimal the reference takes or `<height>x<index>x<output>`.
pub(crate) fn scid(s: &str) -> Result<u64, ApiError> {
    let mut parts = s.split('x');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(id), None, None, None) => number(id, u64::MAX),
        (Some(h), Some(i), Some(o), None) => {
            match (
                number(h, 0xff_ffff),
                number(i, 0xff_ffff),
                number(o, 0xffff),
            ) {
                (Some(h), Some(i), Some(o)) => Some(h << 40 | i << 16 | o),
                _ => None,
            }
        }
        _ => None,
    }
    .ok_or(BAD_CHANNEL)
}

/// `%XX` and `+` decoded; `None` if the bytes are not UTF-8 or an escape is broken.
pub(crate) fn decode(s: &str) -> Option<String> {
    let mut out = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        out.push(match b {
            b'+' => b' ',
            b'%' => {
                let hi = char::from(bytes.next()?).to_digit(16)?;
                let lo = char::from(bytes.next()?).to_digit(16)?;
                u8::try_from(hi << 4 | lo).ok()?
            }
            b => b,
        });
    }
    String::from_utf8(out).ok()
}

/// The query's parameters, decoded, each at most once. With `strict`, a name not in `known` is
/// refused; without, it is ignored, like every `/api/v1` query.
pub(crate) fn query<'a>(
    raw: Option<&str>,
    known: &[&'a str],
    strict: bool,
) -> Result<BTreeMap<&'a str, String>, ApiError> {
    let mut out = BTreeMap::new();
    for part in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        let Some(name) = known.iter().find(|k| **k == name) else {
            if strict {
                return Err(ApiError::bad_request("unknown query parameter"));
            }
            continue;
        };
        let value = decode(value).ok_or(ApiError::bad_request("invalid query encoding"))?;
        if out.insert(*name, value).is_some() {
            return Err(ApiError::bad_request("query parameter given twice"));
        }
    }
    Ok(out)
}

/// Search text: 3 to 66 characters once trimmed, none of them a control character.
fn search_text(s: Option<&String>) -> Result<&str, ApiError> {
    let s = s.map(|s| s.trim()).ok_or(BAD_SEARCH)?;
    let ok = (3..=66).contains(&s.chars().count()) && !s.chars().any(char::is_control);
    ok.then_some(s).ok_or(BAD_SEARCH)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Open,
    Closed,
}

fn status(s: Option<&String>) -> Result<Status, ApiError> {
    match s.map(String::as_str) {
        None | Some("open") => Ok(Status::Open),
        Some("closed") => Ok(Status::Closed),
        Some(_) => Err(ApiError::bad_request("status is open or closed")),
    }
}

// Shared pieces.

fn color(n: &Node) -> Option<String> {
    n.announcement.as_ref().map(|a| {
        let [r, g, b] = a.color;
        format!("#{r:02x}{g:02x}{b:02x}")
    })
}

/// BOLT 9's name for a feature bit, by its pair.
fn feature_name(bit: usize) -> Option<&'static str> {
    Some(match bit & !1 {
        0 => "data-loss-protect",
        2 => "initial-routing-sync",
        4 => "upfront-shutdown-script",
        6 => "gossip-queries",
        8 => "tlv-onion",
        10 => "gossip-queries-ex",
        12 => "static-remote-key",
        14 => "payment-addr",
        16 => "multi-path-payments",
        18 => "wumbo-channels",
        20 => "anchor-outputs",
        22 => "anchors-zero-fee-htlc-tx",
        24 => "route-blinding",
        26 => "shutdown-any-segwit",
        28 => "dual-fund",
        34 => "quiesce",
        38 => "onion-messages",
        44 => "explicit-commitment-type",
        46 => "scid-alias",
        48 => "payment-metadata",
        50 => "zero-conf",
        _ => return None,
    })
}

/// The set bits of little-endian feature flags.
fn bits(flags: &[u8]) -> impl Iterator<Item = usize> + '_ {
    flags.iter().enumerate().flat_map(|(i, b)| {
        (0..8)
            .filter(move |j| b >> j & 1 == 1)
            .map(move |j| i * 8 + j)
    })
}

/// The flags as one hexadecimal number, without leading zeros.
fn features_hex(flags: &[u8]) -> String {
    let s: String = flags.iter().rev().map(|b| format!("{b:02x}")).collect();
    s.trim_start_matches('0').to_owned()
}

fn flags(n: &Node) -> &[u8] {
    n.announcement
        .as_ref()
        .map_or(&[], |a| a.features.as_slice())
}

/// 2 closed, 1 able to forward, 0 not (no enabled policy, or gone from the graph unclosed).
fn v1_status(stored: Option<&Channel>, live: Option<&GraphChannel>) -> u8 {
    if stored.is_some_and(|c| c.close.is_some()) {
        2
    } else {
        u8::from(live.is_some_and(GraphChannel::active))
    }
}

/// The reference's `closing_reason`: 1 cooperative, 2 force, 3 a breach. A close that is neither
/// (a splice adding funds, most likely) has none.
fn v1_reason(c: &Channel) -> Option<u8> {
    let close = c.close?;
    if c.penalty.is_some() || close.kind == Kind::Penalty {
        return Some(3);
    }
    match close.kind {
        Kind::Cooperative => Some(1),
        Kind::Force => Some(2),
        Kind::Penalty | Kind::Other => None,
    }
}

fn state(stored: Option<&Channel>, live: Option<&GraphChannel>) -> &'static str {
    match v1_status(stored, live) {
        2 => "closed",
        1 => "active",
        _ => "inactive",
    }
}

fn close_json(c: &Channel) -> Value {
    c.close.map_or(Value::Null, |x| {
        json!({ "block": block_json(&x.block), "txid": x.txid.to_string(), "kind": x.kind.label(), "fee": x.fee })
    })
}

fn summary(n: &Node) -> Value {
    json!({ "id": hex(&n.id), "alias": n.alias(), "capacity": n.capacity, "channels": n.open() })
}

/// The reference writes the key's first 20 hex digits for a node that announced no alias.
fn v1_alias(index: &Index, id: &[u8; 33]) -> String {
    index
        .node(id)
        .and_then(Node::alias)
        .map_or_else(|| hex(id).chars().take(20).collect(), str::to_owned)
}

// /app routes.

/// An open channel as its operator reads it: which end, if any, has switched it off. An end is
/// off when its policy is disabled or there is none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpState {
    /// Both ends on.
    Active = 0,
    /// Only this node's end off.
    Here = 1,
    /// Only the peer's end off.
    Peer = 2,
    /// Both ends off.
    Inactive = 3,
}

const OP_STATES: [(OpState, &str); 4] = [
    (OpState::Active, "active"),
    (OpState::Here, "here"),
    (OpState::Peer, "peer"),
    (OpState::Inactive, "inactive"),
];

impl OpState {
    pub(crate) fn of(own: Option<Policy>, theirs: Option<Policy>) -> Self {
        let on = |p: Option<Policy>| p.is_some_and(|p| p.enabled);
        match (on(own), on(theirs)) {
            (true, true) => Self::Active,
            (false, true) => Self::Here,
            (true, false) => Self::Peer,
            (false, false) => Self::Inactive,
        }
    }

    fn label(self) -> &'static str {
        OP_STATES
            .iter()
            .find(|s| s.0 == self)
            .map_or("inactive", |s| s.1)
    }
}

/// How many of each [`OpState`], by label.
fn states_json(counts: [u64; 4]) -> Value {
    let [active, here, peer, inactive] = counts;
    json!({ "active": active, "here": here, "peer": peer, "inactive": inactive })
}

/// This node's policy on `c`, the peer's, and the peer.
fn ends(c: &GraphChannel, node: &[u8; 33]) -> (Option<Policy>, Option<Policy>, [u8; 33]) {
    let ([one, two], [a, b]) = (c.policies, c.nodes);
    if a == *node {
        (one, two, b)
    } else {
        (two, one, a)
    }
}

/// What a node's open channels sort by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenSort {
    Capacity,
    /// By funding time: descending is oldest first.
    Age,
    /// This node's fee rate.
    Out,
    /// The peer's fee rate.
    In,
    /// This node's CLTV delta.
    Cltv,
    /// This node's max HTLC.
    Htlc,
    /// The newer policy update.
    Update,
    /// The peer's total capacity.
    Peer,
}

/// Each sort's name, and whether it goes descending unless `dir` says otherwise.
const OPEN_SORTS: [(OpenSort, &str, bool); 8] = [
    (OpenSort::Capacity, "capacity", true),
    (OpenSort::Age, "age", true),
    (OpenSort::Out, "out", false),
    (OpenSort::In, "in", false),
    (OpenSort::Cltv, "cltv", false),
    (OpenSort::Htlc, "htlc", true),
    (OpenSort::Update, "update", true),
    (OpenSort::Peer, "peer", true),
];

/// What a node's closed channels sort by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosedSort {
    /// The closing height.
    Close,
    Capacity,
    /// The closing transaction's fee.
    Fee,
    /// From funding to closing block time.
    Lived,
}

const CLOSED_SORTS: [(ClosedSort, &str); 4] = [
    (ClosedSort::Close, "closed"),
    (ClosedSort::Capacity, "capacity"),
    (ClosedSort::Fee, "fee"),
    (ClosedSort::Lived, "lived"),
];

const BAD_TEXT: ApiError =
    ApiError::bad_request("filter text is 1 to 66 characters, without control characters");

/// Filter text: a peer's alias (substring, any case), a peer's key (prefix), or a channel id in
/// either form (exact).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Text {
    lower: String,
    scid: Option<u64>,
}

impl Text {
    pub(crate) fn parse(s: &str) -> Result<Self, ApiError> {
        let s = s.trim();
        let ok = (1..=66).contains(&s.chars().count()) && !s.chars().any(char::is_control);
        if !ok {
            return Err(BAD_TEXT);
        }
        Ok(Self {
            lower: s.to_lowercase(),
            scid: scid(s).ok(),
        })
    }

    /// `alias` is the peer's, lowercased, when it is held.
    fn matches(&self, scid: u64, peer: &[u8; 33], alias: Option<&str>) -> bool {
        self.scid == Some(scid)
            || key_starts(peer, &self.lower)
            || alias.is_some_and(|a| a.contains(&self.lower))
    }
}

/// `key` in hex starts with `prefix` (lowercase). Without building the hex: it runs per channel.
fn key_starts(key: &[u8; 33], prefix: &str) -> bool {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    prefix.len() <= 66
        && key
            .iter()
            .flat_map(|b| [b >> 4, b & 15])
            .zip(prefix.bytes())
            .all(|(d, p)| HEX.get(usize::from(d)) == Some(&p))
}

/// A view of a node's open channels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpenQuery {
    pub sort: OpenSort,
    pub desc: bool,
    pub text: Option<Text>,
    pub peer: Option<[u8; 33]>,
    pub state: Option<OpState>,
    /// Bars of the node's fee histogram: `true` for the peers' rates (incoming), and the first
    /// and last bucket kept, `None` for no policy.
    pub fee: Option<(bool, Option<(u64, u64)>)>,
}

impl Default for OpenQuery {
    fn default() -> Self {
        Self {
            sort: OpenSort::Capacity,
            desc: true,
            text: None,
            peer: None,
            state: None,
            fee: None,
        }
    }
}

/// A view of a node's closed channels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClosedQuery {
    pub sort: ClosedSort,
    pub desc: bool,
    pub text: Option<Text>,
    pub peer: Option<[u8; 33]>,
    pub kind: Option<Kind>,
}

/// `incoming:` or `outgoing:`-side bucket, as `in:100`, `out:none`, or a run of them, as
/// `out:10-40` (the buckets from 10 to 40, as the page groups its rows). Each number must be a
/// bucket the histogram has: a lower bound, not any rate.
fn fee_bar(s: &str) -> Result<(bool, Option<(u64, u64)>), ApiError> {
    const BAD: ApiError = ApiError::bad_request(
        "fee is in: or out: and a fee histogram bucket, a run of them, or none",
    );
    let (side, b) = s.split_once(':').ok_or(BAD)?;
    let incoming = match side {
        "in" => true,
        "out" => false,
        _ => return Err(BAD),
    };
    if b == "none" {
        return Ok((incoming, None));
    }
    let bucket = |b: &str| {
        let n = number(b, u64::from(u32::MAX))?;
        (store_ln::bucket(u32::try_from(n).ok()?) == n).then_some(n)
    };
    let (from, to) = b.split_once('-').unwrap_or((b, b));
    match (bucket(from), bucket(to)) {
        (Some(from), Some(to)) if from <= to => Ok((incoming, Some((from, to)))),
        _ => Err(BAD),
    }
}

/// Orders `a` before `b`: present values in `desc` or ascending order, a missing one last either
/// way.
fn by_value(a: Option<u64>, b: Option<u64>, desc: bool) -> std::cmp::Ordering {
    use std::cmp::Ordering::{Equal, Greater, Less};
    match (a, b) {
        (Some(a), Some(b)) if desc => b.cmp(&a),
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => Less,
        (None, Some(_)) => Greater,
        (None, None) => Equal,
    }
}

/// A node's open channels that `q` keeps, in its order, and how many of each [`OpState`] its
/// other filters keep. Work in proportion to the node's open channels.
pub(crate) fn open_list<'a>(
    index: &'a Index,
    n: &'a Node,
    q: &OpenQuery,
) -> (Vec<Link<'a>>, [u64; 4]) {
    let mut counts = [0; 4];
    let mut kept: Vec<(Option<u64>, Link<'a>)> = Vec::new();
    for link in index.links(n) {
        let c = link.channel;
        let (own, theirs, peer) = ends(c, &n.id);
        if q.peer.is_some_and(|p| p != peer) {
            continue;
        }
        if let Some((incoming, bar)) = q.fee {
            let p = if incoming { theirs } else { own };
            let kept = match (p.map(|p| store_ln::bucket(p.fee_rate)), bar) {
                (None, None) => true,
                (Some(b), Some((from, to))) => (from..=to).contains(&b),
                _ => false,
            };
            if !kept {
                continue;
            }
        }
        let other = link.peer;
        if let Some(t) = &q.text
            && !t.matches(c.scid, &peer, other.map(Node::alias_key))
        {
            continue;
        }
        let state = OpState::of(own, theirs);
        if let Some(count) = counts.get_mut(state as usize) {
            *count += 1;
        }
        if q.state.is_some_and(|s| s != state) {
            continue;
        }
        let value = match q.sort {
            OpenSort::Capacity => Some(c.capacity),
            OpenSort::Age => link.funded.map(|t| u64::MAX - t),
            OpenSort::Out => own.map(|p| u64::from(p.fee_rate)),
            OpenSort::In => theirs.map(|p| u64::from(p.fee_rate)),
            OpenSort::Cltv => own.map(|p| u64::from(p.cltv_delta)),
            OpenSort::Htlc => own.map(|p| p.max_htlc_msat),
            OpenSort::Update => c.last_update().map(u64::from),
            OpenSort::Peer => Some(other.map_or(0, |o| o.capacity)),
        };
        kept.push((value, link));
    }
    kept.sort_unstable_by(|(a, x), (b, y)| {
        by_value(*a, *b, q.desc).then(x.channel.scid.cmp(&y.channel.scid))
    });
    (kept.into_iter().map(|k| k.1).collect(), counts)
}

/// How a closed channel ended, a breach found later counted as one.
fn close_kind(c: &Channel) -> Option<Kind> {
    let x = c.close?;
    Some(if c.penalty.is_some() {
        Kind::Penalty
    } else {
        x.kind
    })
}

/// The peer of `node` on a stored channel.
fn stored_peer(c: &Channel, node: &[u8; 33]) -> [u8; 33] {
    if c.open.node_one == *node {
        c.open.node_two
    } else {
        c.open.node_one
    }
}

/// A node's closed channels (`rows`, newest close first) that `q` keeps, in its order. Ties keep
/// the newest close and funding first, as before sorts existed.
pub(crate) fn closed_list(
    index: &Index,
    node: &[u8; 33],
    rows: Vec<Channel>,
    q: &ClosedQuery,
) -> Vec<Channel> {
    let mut kept: Vec<(Option<u64>, Channel)> = rows
        .into_iter()
        .filter(|c| {
            let peer = stored_peer(c, node);
            q.kind.is_none_or(|k| close_kind(c) == Some(k))
                && q.peer.is_none_or(|p| p == peer)
                && q.text.as_ref().is_none_or(|t| {
                    t.matches(c.open.scid, &peer, index.node(&peer).map(Node::alias_key))
                })
        })
        .map(|c| {
            let close = c.close;
            let value = match q.sort {
                ClosedSort::Close => close.map(|x| u64::from(x.block.height)),
                ClosedSort::Capacity => Some(c.open.capacity),
                ClosedSort::Fee => close.and_then(|x| x.fee),
                ClosedSort::Lived => close.map(|x| x.block.time.saturating_sub(c.open.block.time)),
            };
            (value, c)
        })
        .collect();
    kept.sort_by(|(a, x), (b, y)| {
        by_value(*a, *b, q.desc)
            .then(close_height(y).cmp(&close_height(x)))
            .then(y.open.scid.cmp(&x.open.scid))
    });
    kept.into_iter().map(|k| k.1).collect()
}

fn close_height(c: &Channel) -> u32 {
    c.close.map_or(0, |x| x.block.height)
}

fn peer_json(peer: &[u8; 33], n: Option<&Node>) -> Value {
    json!({
        "id": hex(peer),
        "alias": n.and_then(Node::alias),
        "capacity": n.map(|n| n.capacity),
        "channels": n.map(Node::open),
    })
}

/// One of a node's open channels, as its list shows it. `together` counts the node's open
/// channels with each peer, by the peer's place in the index.
fn open_row(n: &Node, link: &Link<'_>, together: &HashMap<u32, u32>) -> Value {
    let c = link.channel;
    let (own, theirs, peer) = ends(c, &n.id);
    let together = together.get(&link.peer_at).copied().unwrap_or(1);
    json!({
        "id": scid_text(c.scid),
        "scid": c.scid.to_string(),
        "capacity": c.capacity,
        "state": state(None, Some(c)),
        "op_state": OpState::of(own, theirs).label(),
        "peer": peer_json(&peer, link.peer),
        "with_peer": together,
        "fee_rate": own.map(|p| p.fee_rate),
        "own_policy": policy_json(own),
        "peer_policy": policy_json(theirs),
        "last_update": c.last_update(),
        "funded": link.funded,
        "closed": Value::Null,
    })
}

/// One of a node's closed channels, as its list shows it.
fn closed_row(index: &Index, node: &[u8; 33], c: &Channel, next: Option<u64>) -> Value {
    json!({
        "id": scid_text(c.open.scid),
        "scid": c.open.scid.to_string(),
        "capacity": c.open.capacity,
        "state": state(Some(c), None),
        "peer": peer_json(&stored_peer(c, node), index.node(&stored_peer(c, node))),
        "fee_rate": Value::Null,
        "funded": c.open.block.time,
        "closed": close_json(c),
        "continued_as": next.map(scid_text),
    })
}

fn c_policy(c: Option<&GraphChannel>, side: usize) -> Option<Policy> {
    c?.policies.get(side).copied().flatten()
}

/// A page of a node's open channels from the index, and the counts by state.
pub(crate) fn open_page(index: &Index, n: &Node, q: &OpenQuery, page: usize) -> Value {
    let (list, counts) = open_list(index, n, q);
    let mut together: HashMap<u32, u32> = HashMap::new();
    for link in index.links(n) {
        *together.entry(link.peer_at).or_default() += 1;
    }
    let rows: Vec<Value> = list
        .iter()
        .skip(page * PAGE)
        .take(PAGE)
        .map(|link| open_row(n, link, &together))
        .collect();
    let sort = OPEN_SORTS.iter().find(|s| s.0 == q.sort).map(|s| s.1);
    json!({
        "status": "open",
        "page": page,
        "per_page": PAGE,
        "total": list.len(),
        "sort": sort,
        "dir": if q.desc { "desc" } else { "asc" },
        "states": states_json(counts),
        "channels": rows,
    })
}

/// A page of a node's closed channels from the store.
/// A node's closed channels: from the store, so a node the graph no longer holds has them too. A
/// key the graph does not hold and no close is stored for is no node.
async fn closed_page(
    index: &Index,
    store: &Store,
    id: [u8; 33],
    q: &ClosedQuery,
    page: usize,
) -> Result<Value, ApiError> {
    let rows = store_ln::node_closes(store, id)
        .await
        .map_err(|e| store_error(&e))?;
    if rows.is_empty() && index.node(&id).is_none() {
        return Err(NO_NODE);
    }
    let list = closed_list(index, &id, rows, q);
    let shown: Vec<Channel> = list.iter().skip(page * PAGE).take(PAGE).copied().collect();
    let next = store_ln::continued(store, shown.clone())
        .await
        .map_err(|e| store_error(&e))?;
    let rows: Vec<Value> = shown
        .iter()
        .zip(next)
        .map(|(c, next)| closed_row(index, &id, c, next))
        .collect();
    let sort = CLOSED_SORTS.iter().find(|s| s.0 == q.sort).map(|s| s.1);
    Ok(json!({
        "status": "closed",
        "page": page,
        "per_page": PAGE,
        "total": list.len(),
        "sort": sort,
        "dir": if q.desc { "desc" } else { "asc" },
        "channels": rows,
    }))
}

fn bucket_json(b: &Bucket) -> Value {
    json!({ "bucket": b.bucket, "count": b.count, "capacity": b.capacity })
}

/// The median (the lower middle), smallest and largest of `v`, `null`s when it is empty.
fn spread(mut v: Vec<u64>) -> [Option<u64>; 3] {
    if v.is_empty() {
        return [None; 3];
    }
    let mid = store_ln::median(&mut v);
    [Some(mid), v.first().copied(), v.last().copied()]
}

/// Fee rates over channels with a policy one way: median, average weighted by capacity (rates
/// over [`super::FEE_CAP`], which refuse to route, left out, as the network's averages do),
/// lowest, highest, and how many.
fn fee_figures(rates: &[(u32, u64)]) -> Value {
    let [median, lowest, highest] = spread(rates.iter().map(|r| u64::from(r.0)).collect());
    let (mut sum, mut weight) = (0u128, 0u128);
    for (rate, cap) in rates.iter().filter(|r| u64::from(r.0) <= super::FEE_CAP) {
        sum += u128::from(*rate) * u128::from(*cap);
        weight += u128::from(*cap);
    }
    let weighted = (weight > 0).then(|| u64::try_from((sum + weight / 2) / weight).unwrap_or(0));
    json!({
        "median": median,
        "weighted": weighted,
        "lowest": lowest,
        "highest": highest,
        "policies": rates.len(),
    })
}

/// The node page's figures over its open channels.
pub(crate) fn figures(index: &Index, n: &Node) -> Value {
    let (mut caps, mut funded, mut updated) = (Vec::new(), Vec::new(), None);
    let (mut out, mut inc, mut counts) = (Vec::new(), Vec::new(), [0; 4]);
    for link in index.links(n) {
        let c = link.channel;
        let (own, theirs, _) = ends(c, &n.id);
        caps.push(c.capacity);
        funded.extend(link.funded);
        updated = updated.max(c.last_update());
        out.extend(own.map(|p| (p.fee_rate, c.capacity)));
        inc.extend(theirs.map(|p| (p.fee_rate, c.capacity)));
        if let Some(count) = counts.get_mut(OpState::of(own, theirs) as usize) {
            *count += 1;
        }
    }
    let [median, smallest, largest] = spread(caps);
    let [age, oldest, youngest] = spread(funded);
    json!({
        "capacity": { "median": median, "smallest": smallest, "largest": largest },
        "funded": { "median": age, "oldest": oldest, "youngest": youngest },
        "states": states_json(counts),
        "fee_rates": { "outgoing": fee_figures(&out), "incoming": fee_figures(&inc) },
        "last_policy_update": updated,
    })
}

async fn app_node(State(ctx): State<Arc<NetworkContext>>, UrlPath(key): UrlPath<String>) -> Answer {
    let id = pubkey(&key)?;
    let (index, _, _) = graph(&ctx)?;
    let n = index.node(&id).ok_or(NO_NODE)?;
    let past = n.past.unwrap_or_default();
    let [cooperative, force, penalty, other] = past.closed;
    let [incoming, outgoing] = index.fees(n);
    let a = n.announcement.as_ref();
    let [by_capacity, by_channels] = n.rank;
    let v = json!({
        "id": hex(&n.id),
        "alias": n.alias(),
        "color": color(n),
        "addresses": a.map(|a| &a.addresses),
        "features": bits(flags(n)).map(|b| json!({ "bit": b, "name": feature_name(b), "required": b % 2 == 0 })).collect::<Vec<_>>(),
        "features_hex": features_hex(flags(n)),
        "last_update": a.map(|a| a.last_update),
        "first_seen": n.past.map(|p| p.first_seen),
        "capacity": n.capacity,
        "rank": { "capacity": by_capacity, "channels": by_channels, "of": index.len().0 },
        "channels": {
            "open": n.open(),
            "active": n.active,
            "closed": cooperative + force + penalty + other,
            "cooperative": cooperative,
            "force": force,
            "penalty": penalty,
            "other": other,
        },
        "figures": figures(&index, n),
        "fees": {
            "incoming": incoming.iter().map(bucket_json).collect::<Vec<_>>(),
            "outgoing": outgoing.iter().map(bucket_json).collect::<Vec<_>>(),
        },
        "open_channels": open_page(&index, n, &OpenQuery::default(), 0),
    });
    Ok(send(&v, "lightning_node"))
}

/// A node's channel list: open or closed, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum View {
    Open(OpenQuery),
    Closed(ClosedQuery),
}

/// What `/nodes/:key/channels` takes.
const CHANNEL_PARAMS: [&str; 9] = [
    "status", "page", "sort", "dir", "q", "peer", "state", "fee", "kind",
];

/// The view a node's channel list asks for, open or closed, and its page. Every parameter is
/// checked before anything is read; one that applies only to the other status is refused.
pub(crate) fn channel_view(raw: Option<&str>) -> Result<(View, usize), ApiError> {
    let q = query(raw, &CHANNEL_PARAMS, true)?;
    let page = match q.get("page") {
        None => 0,
        Some(p) => number(p, (MAX_OFFSET / PAGE) as u64)
            .ok_or(ApiError::bad_request("page is 0 to 4000"))? as usize,
    };
    let dir = match q.get("dir").map(String::as_str) {
        None => None,
        Some("asc") => Some(false),
        Some("desc") => Some(true),
        Some(_) => return Err(ApiError::bad_request("dir is asc or desc")),
    };
    let text = q.get("q").map(|t| Text::parse(t)).transpose()?;
    let peer = q.get("peer").map(|p| pubkey(p)).transpose()?;
    let sort = q.get("sort").map(String::as_str);
    let view = match status(q.get("status"))? {
        Status::Open => {
            if q.contains_key("kind") {
                return Err(ApiError::bad_request("kind applies to closed channels"));
            }
            let (sort, desc) = match sort {
                None => (OpenSort::Capacity, true),
                Some(s) => OPEN_SORTS
                    .iter()
                    .find(|o| o.1 == s)
                    .map(|o| (o.0, o.2))
                    .ok_or(ApiError::bad_request(
                        "sort is capacity, age, out, in, cltv, htlc, update or peer",
                    ))?,
            };
            let state = match q.get("state") {
                None => None,
                Some(s) => Some(OP_STATES.iter().find(|o| o.1 == s).map(|o| o.0).ok_or(
                    ApiError::bad_request("state is active, here, peer or inactive"),
                )?),
            };
            let fee = q.get("fee").map(|f| fee_bar(f)).transpose()?;
            View::Open(OpenQuery {
                sort,
                desc: dir.unwrap_or(desc),
                text,
                peer,
                state,
                fee,
            })
        }
        Status::Closed => {
            if q.contains_key("state") || q.contains_key("fee") {
                return Err(ApiError::bad_request(
                    "state and fee apply to open channels",
                ));
            }
            let sort = match sort {
                None => ClosedSort::Close,
                Some(s) => CLOSED_SORTS.iter().find(|o| o.1 == s).map(|o| o.0).ok_or(
                    ApiError::bad_request("sort is closed, capacity, fee or lived"),
                )?,
            };
            let kind = match q.get("kind").map(String::as_str) {
                None => None,
                Some("cooperative") => Some(Kind::Cooperative),
                Some("force") => Some(Kind::Force),
                Some("penalty") => Some(Kind::Penalty),
                Some("other") => Some(Kind::Other),
                Some(_) => {
                    return Err(ApiError::bad_request(
                        "kind is cooperative, force, penalty or other",
                    ));
                }
            };
            View::Closed(ClosedQuery {
                sort,
                desc: dir.unwrap_or(true),
                text,
                peer,
                kind,
            })
        }
    };
    Ok((view, page))
}

async fn app_node_channels(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(key): UrlPath<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let id = pubkey(&key)?;
    let (view, page) = channel_view(raw.as_deref())?;
    let (index, _, store) = graph(&ctx)?;
    let v = match view {
        View::Open(q) => open_page(&index, index.node(&id).ok_or(NO_NODE)?, &q, page),
        // A node that left the graph still has the closes stored for it, as its record does.
        View::Closed(q) => closed_page(&index, store, id, &q, page).await?,
    };
    Ok(send(&v, "lightning_node_channels"))
}

/// A node's open channels and capacity at each UTC midnight since our history starts, and now;
/// with `changes`, also at each open and close in between.
async fn node_points(
    index: &Index,
    store: &Store,
    id: [u8; 33],
    changes: bool,
) -> Result<Vec<store_ln::NodePoint>, ApiError> {
    index.node(&id).ok_or(NO_NODE)?;
    let spans = store_ln::node_spans(store, id)
        .await
        .map_err(|e| store_error(&e))?;
    Ok(store_ln::node_series(
        &spans,
        index.start,
        store_ln::unix_now(),
        changes,
    ))
}

async fn app_node_history(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(key): UrlPath<String>,
) -> Answer {
    let id = pubkey(&key)?;
    let (index, _, store) = graph(&ctx)?;
    let points = node_points(&index, store, id, true).await?;
    let v = json!({
        "from": index.start,
        "points": points.iter().map(|p| json!({ "time": p.time, "channels": p.channels, "capacity": p.capacity })).collect::<Vec<_>>(),
    });
    Ok(send(&v, "lightning_node_history"))
}

fn policy_json(p: Option<Policy>) -> Value {
    p.map_or(Value::Null, |p| {
        json!({
            "fee_rate": p.fee_rate,
            "base_fee_msat": p.base_fee_msat,
            "cltv_delta": p.cltv_delta,
            "min_htlc_msat": p.min_htlc_msat,
            "max_htlc_msat": p.max_htlc_msat,
            "enabled": p.enabled,
            "last_update": p.last_update,
            "inbound_fee": inbound_json(p.inbound),
        })
    })
}

/// lnd's inbound fee, signed, or `null` when the update carries none.
pub(crate) fn inbound_json(i: Option<store_ln::Inbound>) -> Value {
    i.map_or(
        Value::Null,
        |i| json!({ "base_fee_msat": i.base_fee_msat, "fee_rate": i.fee_rate }),
    )
}

/// A channel as both sources know it: the index while open, the store always (once stored).
async fn find_channel(
    index: &Index,
    store: &Store,
    scid: u64,
) -> Result<(Option<GraphChannel>, Option<Channel>), ApiError> {
    let stored = store_ln::channel(store, scid)
        .await
        .map_err(|e| store_error(&e))?;
    let live = index.channel(scid).cloned();
    if live.is_none() && stored.is_none() {
        return Err(NO_CHANNEL);
    }
    Ok((live, stored))
}

async fn app_channel(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(id): UrlPath<String>,
) -> Answer {
    let scid = scid(&id)?;
    let (index, _, store) = graph(&ctx)?;
    let (live, stored) = find_channel(&index, store, scid).await?;
    let (next, previous) = match stored {
        Some(c) => store_ln::lineage(store, c)
            .await
            .map_err(|e| store_error(&e))?,
        None => (None, None),
    };
    let (live, stored) = (live.as_ref(), stored.as_ref());
    // The channel a lineage names: open, as the index knows it, or closed.
    let link = |c: Option<Channel>| {
        c.map_or(Value::Null, |c| {
            let live = index.channel(c.open.scid);
            json!({
                "id": scid_text(c.open.scid),
                "scid": c.open.scid.to_string(),
                "capacity": live.map_or(c.open.capacity, |l| l.capacity),
                "state": state(Some(&c), live),
            })
        })
    };
    let closed = stored.is_some_and(|c| c.close.is_some());
    let nodes = live.map_or_else(
        || stored.map_or([[0; 33]; 2], |c| [c.open.node_one, c.open.node_two]),
        |c| c.nodes,
    );
    let end = |side: usize| {
        let id = nodes.get(side).copied().unwrap_or([0; 33]);
        let n = index.node(&id);
        json!({
            "id": hex(&id),
            "alias": n.and_then(Node::alias),
            "color": n.and_then(color),
            "policy": if closed { Value::Null } else { policy_json(c_policy(live, side)) },
        })
    };
    let v = json!({
        "id": scid_text(scid),
        "scid": scid.to_string(),
        "capacity": live.map_or_else(|| stored.map(|c| c.open.capacity), |c| Some(c.capacity)),
        "state": state(stored, live),
        "node_one": end(0),
        "node_two": end(1),
        "last_update": if closed { None } else { live.and_then(GraphChannel::last_update) },
        "funding": {
            "txid": stored.and_then(|c| c.funding_txid).map(|t| t.to_string()),
            "vout": scid & 0xffff,
            "block": stored.map(|c| block_json(&c.open.block)),
        },
        "closed": stored.map_or(Value::Null, close_json),
        "penalty": stored.and_then(|c| c.penalty).map(|p| json!({ "block": block_json(&p.block), "txid": p.txid.to_string() })),
        "continued_as": link(next),
        "continued_from": link(previous),
    });
    Ok(send(&v, "lightning_channel"))
}

async fn app_tx(State(ctx): State<Arc<NetworkContext>>, UrlPath(txid): UrlPath<String>) -> Answer {
    let txid = crate::esplora::txid(&txid)?;
    let (index, l, store) = graph(&ctx)?;
    let rows = store_ln::by_txids(store, vec![txid])
        .await
        .map_err(|e| store_error(&e))?;
    let names = super::aliases(l, &rows);
    let pick = |closes: bool| {
        rows.iter()
            .filter(|c| {
                if closes {
                    c.close.is_some_and(|x| x.txid == txid)
                } else {
                    c.funding_txid == Some(txid)
                }
            })
            .map(|c| channel_json(c, &names))
            .collect::<Vec<_>>()
    };
    drop(index);
    Ok(send(
        &json!({ "opened": pick(false), "closed": pick(true) }),
        "lightning_tx",
    ))
}

/// Channels of each list in a block's answer; the counts cover the rest.
pub(crate) const BLOCK_ROWS: usize = 100;

/// `GET /app/lightning/block/:hash`: the channels a block opened and closed, for its page.
async fn app_block(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(hash): UrlPath<String>,
) -> Answer {
    let hash = crate::esplora::block_hash(&hash)?;
    let (index, _, store) = graph(&ctx)?;
    let b = store_ln::in_block(store, hash, BLOCK_ROWS)
        .await
        .map_err(|e| store_error(&e))?;
    let end =
        |id: &[u8; 33]| json!({ "id": hex(id), "alias": index.node(id).and_then(Node::alias) });
    let row = |c: &Channel| {
        json!({
            "id": scid_text(c.open.scid),
            "scid": c.open.scid.to_string(),
            "capacity": c.open.capacity,
            "node_one": end(&c.open.node_one),
            "node_two": end(&c.open.node_two),
        })
    };
    let closed = |c: &Channel| {
        let mut v = row(c);
        if let Value::Object(m) = &mut v {
            let kind = close_kind(c).unwrap_or(Kind::Other).label();
            m.insert("kind".into(), kind.into());
        }
        v
    };
    let v = json!({
        "opened": {
            "count": b.opened_count,
            "capacity": b.opened_capacity,
            "channels": b.opened.iter().map(row).collect::<Vec<_>>(),
        },
        "closed": {
            "count": b.closed_count,
            "forced": b.forced,
            "channels": b.closed.iter().map(closed).collect::<Vec<_>>(),
        },
    });
    Ok(send(&v, "lightning_block"))
}

/// One channel a search names by its id, from the index or the store.
async fn search_channel(
    index: &Index,
    store: &Store,
    q: &str,
) -> Result<Option<(u64, u64, u8)>, ApiError> {
    let Ok(id) = scid(q) else { return Ok(None) };
    if let Some(c) = index.channel(id) {
        return Ok(Some((id, c.capacity, v1_status(None, Some(c)))));
    }
    let stored = store_ln::channel(store, id)
        .await
        .map_err(|e| store_error(&e))?;
    Ok(stored.map(|c| (id, c.open.capacity, v1_status(Some(&c), None))))
}

async fn app_search(State(ctx): State<Arc<NetworkContext>>, RawQuery(raw): RawQuery) -> Answer {
    let q = query(raw.as_deref(), &["q"], true)?;
    let text = search_text(q.get("q"))?;
    let (index, _, store) = graph(&ctx)?;
    let channel = search_channel(&index, store, text).await?;
    let v = json!({
        "nodes": index.search(text, SEARCH_MAX).into_iter().map(summary).collect::<Vec<_>>(),
        "channels": channel.map(|(id, capacity, s)| json!({
            "id": scid_text(id),
            "scid": id.to_string(),
            "capacity": capacity,
            "state": match s { 2 => "closed", 1 => "active", _ => "inactive" },
        })).into_iter().collect::<Vec<_>>(),
    });
    Ok(send(&v, "lightning_search"))
}

fn rank_of(by: &str) -> Result<Rank, ApiError> {
    match by {
        "capacity" | "liquidity" => Ok(Rank::Capacity),
        "channels" | "connectivity" => Ok(Rank::Channels),
        "age" => Ok(Rank::Age),
        _ => Err(ApiError::NOT_FOUND),
    }
}

fn ranked_json(n: &Node) -> Value {
    json!({
        "id": hex(&n.id),
        "alias": n.alias(),
        "capacity": n.capacity,
        "channels": n.open(),
        "first_seen": n.past.map(|p| p.first_seen),
        "last_update": n.announcement.as_ref().map(|a| a.last_update),
    })
}

async fn app_rankings(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(by): UrlPath<String>,
    uri: axum::http::Uri,
) -> Answer {
    let rank = match by.as_str() {
        "capacity" | "channels" | "age" => rank_of(&by)?,
        _ => {
            return Err(ApiError::bad_request(
                "rankings are by capacity, channels or age",
            ));
        }
    };
    let n = super::limit(&uri)?;
    let (index, _, _) = graph(&ctx)?;
    let nodes: Vec<Value> = index.ranking(rank).take(n).map(ranked_json).collect();
    Ok(send(
        &json!({ "by": by, "nodes": nodes }),
        "lightning_rankings",
    ))
}

async fn app_overview(State(ctx): State<Arc<NetworkContext>>, uri: axum::http::Uri) -> Answer {
    if uri.query().is_some_and(|q| !q.is_empty()) {
        return Err(ApiError::bad_request("no query parameters here"));
    }
    let (index, l, store) = graph(&ctx)?;
    let latest = super::newest(l, store).await?;
    let opened = store_ln::opened(store, 10)
        .await
        .map_err(|e| store_error(&e))?;
    let closed = store_ln::closed(store, 10)
        .await
        .map_err(|e| store_error(&e))?;
    let names = super::aliases(l, &[opened.as_slice(), closed.as_slice()].concat());
    let top = |r| index.ranking(r).take(10).map(summary).collect::<Vec<_>>();
    // The totals as they were a period ago, for the change over it: the first stored row from
    // then, if one lies within a tenth of the period after it.
    let now = store_ln::unix_now();
    let mut before = serde_json::Map::new();
    for (name, span) in [
        ("24h", store_ln::DAY),
        ("1w", 7 * store_ln::DAY),
        ("1m", 30 * store_ln::DAY),
    ] {
        let p = store_ln::at(store, now.saturating_sub(span), span / 10)
            .await
            .map_err(|e| store_error(&e))?;
        let v = p.as_ref().map(super::means).map(|m| {
            json!({
                "time": m.time,
                "channels": m.channels,
                "nodes": m.nodes,
                "capacity": m.capacity,
                "med_fee_rate": m.med_fee_rate,
                "med_base_fee_msat": m.med_base_fee_msat,
            })
        });
        before.insert(name.into(), v.into());
    }
    let v = json!({
        "statistics": latest.as_ref().map(super::means),
        "before": before,
        "top_capacity": top(Rank::Capacity),
        "top_channels": top(Rank::Channels),
        "opened": opened.iter().map(|c| channel_json(c, &names)).collect::<Vec<_>>(),
        "closed": closed.iter().map(|c| channel_json(c, &names)).collect::<Vec<_>>(),
    });
    Ok(send(&v, "lightning_overview"))
}

// /api/v1 routes, in the reference's shapes. Field order matters, so each is a struct.

/// What we cannot know without GeoIP: always `null`.
type Null = Option<()>;

#[derive(Serialize)]
struct V1SearchNode {
    public_key: String,
    alias: String,
    capacity: u64,
    channels: usize,
    status: u8,
}

#[derive(Serialize)]
struct V1SearchChannel {
    id: String,
    short_id: String,
    capacity: u64,
    status: u8,
}

#[derive(Serialize)]
struct V1Search {
    nodes: Vec<V1SearchNode>,
    channels: Vec<V1SearchChannel>,
}

async fn v1_search(State(ctx): State<Arc<NetworkContext>>, RawQuery(raw): RawQuery) -> Answer {
    let q = query(raw.as_deref(), &["searchText"], false)?;
    let text = search_text(q.get("searchText"))?;
    let (index, _, store) = graph(&ctx)?;
    let channel = search_channel(&index, store, text).await?;
    let v = V1Search {
        nodes: index
            .search(text, SEARCH_MAX)
            .into_iter()
            .map(|n| V1SearchNode {
                public_key: hex(&n.id),
                alias: v1_alias(&index, &n.id),
                capacity: n.capacity,
                channels: n.open(),
                status: u8::from(n.active > 0),
            })
            .collect(),
        channels: channel
            .map(|(id, capacity, status)| V1SearchChannel {
                id: id.to_string(),
                short_id: scid_text(id),
                capacity,
                status,
            })
            .into_iter()
            .collect(),
    };
    Ok(send(&v, "lightning_search_v1"))
}

#[derive(Serialize)]
struct V1TopCapacity {
    #[serde(rename = "publicKey")]
    public_key: String,
    alias: String,
    capacity: u64,
}

#[derive(Serialize)]
struct V1TopChannels {
    #[serde(rename = "publicKey")]
    public_key: String,
    alias: String,
    channels: usize,
    city: Null,
    country: Null,
    iso_code: Null,
    subdivision: Null,
}

#[derive(Serialize)]
struct V1Top {
    #[serde(rename = "topByCapacity")]
    by_capacity: Vec<V1TopCapacity>,
    #[serde(rename = "topByChannels")]
    by_channels: Vec<V1TopChannels>,
}

async fn v1_rankings(State(ctx): State<Arc<NetworkContext>>) -> Answer {
    let (index, _, _) = graph(&ctx)?;
    let v = V1Top {
        by_capacity: index
            .ranking(Rank::Capacity)
            .take(V1_TOP)
            .map(|n| V1TopCapacity {
                public_key: hex(&n.id),
                alias: v1_alias(&index, &n.id),
                capacity: n.capacity,
            })
            .collect(),
        by_channels: index
            .ranking(Rank::Channels)
            .take(V1_TOP)
            .map(|n| V1TopChannels {
                public_key: hex(&n.id),
                alias: v1_alias(&index, &n.id),
                channels: n.open(),
                city: None,
                country: None,
                iso_code: None,
                subdivision: None,
            })
            .collect(),
    };
    Ok(send(&v, "lightning_rankings_v1"))
}

/// A ranked node; liquidity puts capacity before channels, the other two after.
#[derive(Serialize)]
struct V1Ranked {
    #[serde(rename = "publicKey")]
    public_key: String,
    alias: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    capacity: Option<u64>,
    channels: usize,
    #[serde(rename = "capacity", skip_serializing_if = "Option::is_none")]
    capacity_after: Option<u64>,
    #[serde(rename = "firstSeen")]
    first_seen: Option<u64>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<u32>,
    city: Null,
    country: Null,
    iso_code: Null,
    subdivision: Null,
}

async fn v1_ranking(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(by): UrlPath<String>,
) -> Answer {
    let rank = match by.as_str() {
        "liquidity" | "connectivity" | "age" => rank_of(&by)?,
        _ => return Err(ApiError::NOT_FOUND),
    };
    let (index, _, _) = graph(&ctx)?;
    let v: Vec<V1Ranked> = index
        .ranking(rank)
        .map(|n| {
            let first = rank == Rank::Capacity;
            V1Ranked {
                public_key: hex(&n.id),
                alias: v1_alias(&index, &n.id),
                capacity: first.then_some(n.capacity),
                channels: n.open(),
                capacity_after: (!first).then_some(n.capacity),
                first_seen: n.past.map(|p| p.first_seen),
                updated_at: n.announcement.as_ref().map(|a| a.last_update),
                city: None,
                country: None,
                iso_code: None,
                subdivision: None,
            }
        })
        .collect();
    Ok(send(&v, "lightning_ranking_v1"))
}

#[derive(Serialize)]
struct V1Feature {
    bit: usize,
    name: &'static str,
    is_required: bool,
    is_known: bool,
}

#[derive(Serialize)]
struct V1Node {
    public_key: String,
    alias: String,
    first_seen: Option<u64>,
    updated_at: Option<u32>,
    color: Option<String>,
    sockets: String,
    as_number: Null,
    city_id: Null,
    country_id: Null,
    subdivision_id: Null,
    longitude: Null,
    latitude: Null,
    iso_code: Null,
    as_organization: Null,
    city: Null,
    country: Null,
    subdivision: Null,
    features: Vec<V1Feature>,
    #[serde(rename = "featuresBits")]
    features_bits: String,
    active_channel_count: u32,
    capacity: String,
    opened_channel_count: usize,
    closed_channel_count: u32,
    custom_records: serde_json::Map<String, Value>,
}

async fn v1_node(State(ctx): State<Arc<NetworkContext>>, UrlPath(key): UrlPath<String>) -> Answer {
    let id = pubkey(&key)?;
    let (index, _, _) = graph(&ctx)?;
    let n = index.node(&id).ok_or(NO_NODE)?;
    let a = n.announcement.as_ref();
    let v = V1Node {
        public_key: hex(&n.id),
        alias: v1_alias(&index, &n.id),
        first_seen: n.past.map(|p| p.first_seen),
        updated_at: a.map(|a| a.last_update),
        color: color(n),
        sockets: a.map(|a| a.addresses.join(",")).unwrap_or_default(),
        as_number: None,
        city_id: None,
        country_id: None,
        subdivision_id: None,
        longitude: None,
        latitude: None,
        iso_code: None,
        as_organization: None,
        city: None,
        country: None,
        subdivision: None,
        features: bits(flags(n))
            .map(|bit| V1Feature {
                bit,
                name: feature_name(bit).unwrap_or("unknown"),
                is_required: bit % 2 == 0,
                is_known: feature_name(bit).is_some(),
            })
            .collect(),
        features_bits: features_hex(flags(n)),
        active_channel_count: n.active,
        capacity: n.capacity.to_string(),
        opened_channel_count: n.open(),
        closed_channel_count: n.past.map_or(0, |p| p.closed.iter().sum()),
        custom_records: serde_json::Map::new(),
    };
    Ok(send(&v, "lightning_node_v1"))
}

#[derive(Serialize)]
struct V1NodePoint {
    added: u64,
    capacity: u64,
    channels: u64,
}

async fn v1_node_statistics(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(key): UrlPath<String>,
) -> Answer {
    let id = pubkey(&key)?;
    let (index, _, store) = graph(&ctx)?;
    // The reference's points are daily: its shape, without the changes between.
    let points = node_points(&index, store, id, false).await?;
    let v: Vec<V1NodePoint> = points
        .iter()
        .rev()
        .map(|p| V1NodePoint {
            added: p.time,
            capacity: p.capacity,
            channels: p.channels,
        })
        .collect();
    Ok(send(&v, "lightning_node_statistics_v1"))
}

#[derive(Serialize)]
struct V1Bucket {
    bucket: Option<String>,
    count: u64,
    capacity: String,
}

#[derive(Serialize)]
struct V1Fees {
    incoming: Vec<V1Bucket>,
    outgoing: Vec<V1Bucket>,
}

async fn v1_fees(State(ctx): State<Arc<NetworkContext>>, UrlPath(key): UrlPath<String>) -> Answer {
    let id = pubkey(&key)?;
    let (index, _, _) = graph(&ctx)?;
    let n = index.node(&id).ok_or(NO_NODE)?;
    let v1 = |b: &Vec<Bucket>| {
        b.iter()
            .map(|b| V1Bucket {
                bucket: b.bucket.map(|x| format!("{x}.0")),
                count: b.count,
                capacity: b.capacity.to_string(),
            })
            .collect()
    };
    let [incoming, outgoing] = index.fees(n);
    let v = V1Fees {
        incoming: v1(&incoming),
        outgoing: v1(&outgoing),
    };
    Ok(send(&v, "lightning_fees_v1"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct V1IspRanking {
    clearnet_capacity: u64,
    tor_capacity: u64,
    unknown_capacity: u64,
    /// Providers need an IP database we do not have.
    isp_ranking: [(); 0],
}

async fn v1_isp_ranking(State(ctx): State<Arc<NetworkContext>>) -> Answer {
    let (index, _, _) = graph(&ctx)?;
    let [clearnet_capacity, tor_capacity, unknown_capacity] = index.by_address();
    let body = V1IspRanking {
        clearnet_capacity,
        tor_capacity,
        unknown_capacity,
        isp_ranking: [],
    };
    Ok(send(&body, "lightning_isp_ranking_v1"))
}

/// Channels with their ends' places: none known without an IP database.
async fn v1_channels_geo(State(ctx): State<Arc<NetworkContext>>) -> Answer {
    graph(&ctx)?;
    Ok(send(&[(); 0], "lightning_channels_geo_v1"))
}

async fn v1_node_channels_geo(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(key): UrlPath<String>,
) -> Answer {
    pubkey(&key)?;
    v1_channels_geo(State(ctx)).await
}

#[derive(Serialize)]
struct V1ListNode {
    alias: String,
    public_key: String,
    channels: usize,
    capacity: String,
}

#[derive(Serialize)]
struct V1ListChannel {
    status: u8,
    closing_reason: Option<u8>,
    closing_date: Option<u64>,
    capacity: u64,
    short_id: String,
    id: String,
    fee_rate: Option<u32>,
    node: V1ListNode,
}

/// The reference's `index=-1` item: what its node page's channel map draws.
#[derive(Serialize)]
struct V1MapChannel<'a> {
    capacity: u64,
    short_id: &'a str,
    id: &'a str,
    node: V1MapNode<'a>,
}

#[derive(Serialize)]
struct V1MapNode<'a> {
    alias: &'a str,
    public_key: &'a str,
}

impl<'a> From<&'a V1ListChannel> for V1MapChannel<'a> {
    fn from(c: &'a V1ListChannel) -> Self {
        Self {
            capacity: c.capacity,
            short_id: &c.short_id,
            id: &c.id,
            node: V1MapNode {
                alias: &c.node.alias,
                public_key: &c.node.public_key,
            },
        }
    }
}

async fn v1_node_channels(
    State(ctx): State<Arc<NetworkContext>>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = query(raw.as_deref(), &["public_key", "status", "index"], false)?;
    let id = pubkey(
        q.get("public_key")
            .ok_or(ApiError::bad_request("public_key is required"))?,
    )?;
    // `active`: the open channels that can forward, as the reference's node page asks them.
    let (status, active) = match q.get("status").map(String::as_str) {
        None | Some("open") => (Status::Open, false),
        Some("active") => (Status::Open, true),
        Some("closed") => (Status::Closed, false),
        Some(_) => return Err(ApiError::bad_request("status is open, active or closed")),
    };
    // `index=-1`: the largest V1_ALL in one answer, in the map's shape; otherwise a page.
    let (offset, limit, map) = match q.get("index").map(String::as_str) {
        None => (0, V1_PAGE, false),
        Some("-1") => (0, V1_ALL, true),
        Some(i) => (
            number(i, MAX_OFFSET as u64).ok_or(ApiError::bad_request("index is -1 to 100000"))?
                as usize,
            V1_PAGE,
            false,
        ),
    };
    let (index, _, store) = graph(&ctx)?;
    let n = index.node(&id).ok_or(NO_NODE)?;
    let peer = |nodes: [[u8; 33]; 2]| {
        let p = if nodes[0] == id { nodes[1] } else { nodes[0] };
        let other = index.node(&p);
        V1ListNode {
            alias: v1_alias(&index, &p),
            public_key: hex(&p),
            channels: other.map_or(0, Node::open),
            capacity: other.map_or(0, |o| o.capacity).to_string(),
        }
    };
    let (total, list): (u64, Vec<V1ListChannel>) = match status {
        Status::Open => (
            if active {
                n.active.into()
            } else {
                n.open() as u64
            },
            index
                .channels_of(n)
                .filter(|c| !active || c.active())
                .skip(offset)
                .take(limit)
                .map(|c| V1ListChannel {
                    status: v1_status(None, Some(c)),
                    closing_reason: None,
                    closing_date: None,
                    capacity: c.capacity,
                    short_id: scid_text(c.scid),
                    id: c.scid.to_string(),
                    fee_rate: c
                        .side(&id)
                        .and_then(|s| c_policy(Some(c), s))
                        .map(|p| p.fee_rate),
                    node: peer(c.nodes),
                })
                .collect(),
        ),
        Status::Closed => {
            let (total, rows) = store_ln::node_closed(store, id, offset, limit)
                .await
                .map_err(|e| store_error(&e))?;
            let list = rows
                .iter()
                .map(|c| V1ListChannel {
                    status: 2,
                    closing_reason: v1_reason(c),
                    closing_date: c.close.map(|x| x.block.time),
                    capacity: c.open.capacity,
                    short_id: scid_text(c.open.scid),
                    id: c.open.scid.to_string(),
                    fee_rate: None,
                    node: peer([c.open.node_one, c.open.node_two]),
                })
                .collect();
            (total, list)
        }
    };
    const ROUTE: &str = "lightning_channels_v1";
    let mut res = if map {
        send(
            &list.iter().map(V1MapChannel::from).collect::<Vec<_>>(),
            ROUTE,
        )
    } else {
        send(&list, ROUTE)
    };
    res.headers_mut()
        .insert("x-total-count", HeaderValue::from(total));
    Ok(res)
}

#[derive(Serialize)]
struct V1End {
    alias: String,
    public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channels: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capacity: Option<u64>,
    base_fee_mtokens: Option<u32>,
    cltv_delta: Option<u16>,
    fee_rate: Option<u32>,
    is_disabled: Option<u8>,
    max_htlc_mtokens: Option<u64>,
    min_htlc_mtokens: Option<u64>,
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    longitude: Option<Null>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latitude: Option<Null>,
}

#[derive(Serialize)]
struct V1Channel {
    id: String,
    short_id: String,
    capacity: u64,
    transaction_id: Option<String>,
    transaction_vout: u64,
    closing_transaction_id: Option<String>,
    closing_fee: Option<u64>,
    closing_reason: Option<u8>,
    closing_date: Option<String>,
    updated_at: Option<String>,
    created: Option<String>,
    status: u8,
    funding_ratio: Null,
    closed_by: Null,
    node_left: V1End,
    node_right: V1End,
}

/// The reference's channel. `full` adds what its detail route has and its txids route lacks:
/// each end's channel count, capacity and (for us, empty) coordinates.
fn v1_channel_of(
    index: &Index,
    scid: u64,
    live: Option<&GraphChannel>,
    stored: Option<&Channel>,
    full: bool,
) -> V1Channel {
    let iso = |t: u64| crate::mining::iso8601(t);
    let nodes = live.map_or_else(
        || stored.map_or([[0; 33]; 2], |c| [c.open.node_one, c.open.node_two]),
        |c| c.nodes,
    );
    let closed = stored.and_then(|c| c.close);
    let end = |side: usize| {
        let id = nodes.get(side).copied().unwrap_or([0; 33]);
        let n = index.node(&id);
        let p = if closed.is_some() {
            None
        } else {
            c_policy(live, side)
        };
        V1End {
            alias: v1_alias(index, &id),
            public_key: hex(&id),
            channels: full.then(|| n.map_or(0, Node::open)),
            capacity: full.then(|| n.map_or(0, |n| n.capacity)),
            base_fee_mtokens: p.map(|p| p.base_fee_msat),
            cltv_delta: p.map(|p| p.cltv_delta),
            fee_rate: p.map(|p| p.fee_rate),
            is_disabled: p.map(|p| u8::from(!p.enabled)),
            max_htlc_mtokens: p.map(|p| p.max_htlc_msat),
            min_htlc_mtokens: p.map(|p| p.min_htlc_msat),
            updated_at: p.map(|p| iso(u64::from(p.last_update))),
            longitude: full.then_some(None),
            latitude: full.then_some(None),
        }
    };
    V1Channel {
        id: scid.to_string(),
        short_id: scid_text(scid),
        capacity: live.map_or_else(|| stored.map_or(0, |c| c.open.capacity), |c| c.capacity),
        transaction_id: stored.and_then(|c| c.funding_txid).map(|t| t.to_string()),
        transaction_vout: scid & 0xffff,
        closing_transaction_id: closed.map(|c| c.txid.to_string()),
        closing_fee: closed.and_then(|c| c.fee),
        closing_reason: stored.and_then(v1_reason),
        closing_date: closed.map(|c| iso(c.block.time)),
        updated_at: if closed.is_some() {
            None
        } else {
            live.and_then(GraphChannel::last_update)
                .map(|t| iso(u64::from(t)))
        },
        created: stored.map(|c| iso(c.open.block.time)),
        status: v1_status(stored, live),
        funding_ratio: None,
        closed_by: None,
        node_left: end(0),
        node_right: end(1),
    }
}

async fn v1_channel(
    State(ctx): State<Arc<NetworkContext>>,
    UrlPath(id): UrlPath<String>,
) -> Answer {
    let scid = scid(&id)?;
    let (index, _, store) = graph(&ctx)?;
    let (live, stored) = find_channel(&index, store, scid).await?;
    let v = v1_channel_of(&index, scid, live.as_ref(), stored.as_ref(), true);
    Ok(send(&v, "lightning_channel_v1"))
}

#[derive(Serialize)]
struct V1TxChannels {
    inputs: BTreeMap<String, V1Channel>,
    outputs: BTreeMap<String, V1Channel>,
}

async fn v1_txids(State(ctx): State<Arc<NetworkContext>>, RawQuery(raw): RawQuery) -> Answer {
    let txids: Vec<Txid> = crate::transactions::times_query(raw.as_deref())?;
    let (index, _, store) = graph(&ctx)?;
    let rows = store_ln::by_txids(store, txids.clone())
        .await
        .map_err(|e| store_error(&e))?;
    let v: Vec<V1TxChannels> = txids
        .iter()
        .map(|t| {
            let mut out = V1TxChannels {
                inputs: BTreeMap::new(),
                outputs: BTreeMap::new(),
            };
            for c in &rows {
                let live = index.channel(c.open.scid);
                let scid = c.open.scid;
                if c.funding_txid == Some(*t) {
                    out.outputs.insert(
                        (scid & 0xffff).to_string(),
                        v1_channel_of(&index, scid, live, Some(c), false),
                    );
                }
                // A cooperative or force close spends the funding output alone, as input 0; an
                // `other` close has more inputs and we do not keep which one it was.
                let only_input = c
                    .close
                    .is_some_and(|x| x.txid == *t && x.kind != Kind::Other);
                if only_input {
                    out.inputs.insert(
                        "0".to_owned(),
                        v1_channel_of(&index, scid, live, Some(c), false),
                    );
                }
            }
            out
        })
        .collect();
    Ok(send(&v, "lightning_txids_v1"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn parameters_parse_strictly() {
        let k = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";
        assert_eq!(pubkey(k).unwrap()[0], 3);
        assert_eq!(pubkey(&k.to_uppercase()).unwrap(), pubkey(k).unwrap());
        for bad in [
            "",
            &k[2..],
            &format!("{k}00"),
            &k.replace('f', "g"),
            &format!("{}é", &k[..64]),
        ] {
            assert_eq!(pubkey(bad), Err(BAD_KEY), "{bad}");
        }
        assert_eq!(scid("892785849701564416"), Ok(892_785_849_701_564_416));
        assert_eq!(scid("811984x2037x0"), Ok(892_785_849_701_564_416));
        assert_eq!(scid("0"), Ok(0));
        for bad in [
            "",
            "x",
            "1x2",
            "1x2x3x4",
            "01x2x3",
            "16777216x0x0",
            "1x16777216x0",
            "1x1x65536",
            "18446744073709551616",
            "-1",
            "1 ",
            "1x2x+3",
        ] {
            assert_eq!(scid(bad), Err(BAD_CHANNEL), "{bad}");
        }
        assert_eq!(decode("a%3Cb%3E+c").as_deref(), Some("a<b> c"));
        assert_eq!(decode("%E2%9A%A1").as_deref(), Some("\u{26a1}"));
        for bad in ["%", "%4", "%zz", "%ff"] {
            assert_eq!(decode(bad), None, "{bad}");
        }
        let s = |q: &str| {
            search_text(query(Some(q), &["q"], true).unwrap().get("q")).map(str::to_owned)
        };
        assert_eq!(s("q=+acinq+").as_deref(), Ok("acinq"));
        assert_eq!(s("q=%3Cscript%3E").as_deref(), Ok("<script>"));
        for bad in [
            "q=ab",
            "q=a%00bc",
            "q=ab%07c",
            &format!("q={}", "a".repeat(10_000)),
            "q=",
        ] {
            assert_eq!(s(bad), Err(BAD_SEARCH), "{bad}");
        }
        assert!(query(Some("q=abc&q=abd"), &["q"], true).is_err());
        assert!(query(Some("q=abc&x=1"), &["q"], true).is_err());
        assert!(query(Some("q=abc&x=1"), &["q"], false).is_ok());
        assert_eq!(features_hex(&[0x81, 0x69, 0, 0]), "6981");
        assert_eq!(bits(&[0b1000_0001, 0b10]).collect::<Vec<_>>(), [0, 7, 9]);
    }
}
