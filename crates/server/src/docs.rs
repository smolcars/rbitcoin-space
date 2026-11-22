//! `/docs`: the public docs, built by the frontend into `web_dir` (docs/FRONTEND.md, "Public
//! docs"). Each page is a file of HTML and a Markdown copy of it. An address with `.md` is the
//! copy; an address without one is the HTML, or the copy for a client whose `Accept` header
//! prefers `text/markdown`, as an agent's can. Nothing here reads anything but those files.

use std::path::Path;

use axum::extract::{Request, State};
use axum::http::header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE, LINK, VARY};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::ApiError;

/// The longest path segment a page has, and the longest path; anything longer names no page, and
/// never reaches the file system, which would answer a very long name with an error (a 500).
const MAX_SEGMENT: usize = 64;
const MAX_PATH: usize = 256;

#[derive(Clone)]
pub(crate) struct Docs {
    files: ServeDir,
}

impl Docs {
    pub(crate) fn new(web_dir: &Path) -> Self {
        let files = ServeDir::new(web_dir)
            .precompressed_br()
            .precompressed_gzip()
            .append_index_html_on_directories(false);
        Self { files }
    }
}

/// A docs address: the page's slug (`""` for the overview) and whether the address itself asks
/// for Markdown. `None` names no page: only lower-case letters, digits and hyphens, in segments.
fn parse(path: &str) -> Option<(&str, bool)> {
    if path.len() > MAX_PATH {
        return None;
    }
    if path == "/docs.md" {
        return Some(("", true));
    }
    let rest = match path.strip_prefix("/docs")? {
        "" | "/" => return Some(("", false)),
        r => r.strip_prefix('/')?,
    };
    let (slug, md) = match rest.strip_suffix(".md") {
        Some(s) => (s, true),
        None => (rest, false),
    };
    let segment = |s: &str| {
        !s.is_empty()
            && s.len() <= MAX_SEGMENT
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    // `index` is the overview's file, not a page of its own.
    (slug != "index" && slug.split('/').all(segment)).then_some((slug, md))
}

/// How much a client's `Accept` wants `media` (its `q`), counting `type/*` and `*/*` only when
/// `wildcards` is set. 0 when it does not say.
fn quality(accept: &str, media: &str, wildcards: bool) -> f32 {
    let (kind, _) = media.split_once('/').unwrap_or((media, ""));
    let mut best: Option<(u8, f32)> = None;
    for range in accept.split(',') {
        let mut parts = range.split(';');
        let name = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
        let rank = if name == media {
            2
        } else if wildcards && (name == "*/*" || name.strip_suffix("/*") == Some(kind)) {
            u8::from(name != "*/*")
        } else {
            continue;
        };
        // No `q` is 1; one that is not a number counts the range out.
        let q = match parts.find_map(|p| {
            let p = p.trim();
            p.get(..2)
                .filter(|k| k.eq_ignore_ascii_case("q="))
                .and_then(|_| p.get(2..))
        }) {
            None => 1.0,
            Some(v) => v
                .trim()
                .parse::<f32>()
                .ok()
                .filter(|q| q.is_finite())
                .map_or(0.0, |q| q.clamp(0.0, 1.0)),
        };
        // The most specific range that names the type decides its quality; named twice as
        // specifically, the higher wins.
        best = match best {
            Some((r, b)) if r > rank || (r == rank && b >= q) => Some((r, b)),
            _ => Some((rank, q)),
        };
    }
    best.map_or(0.0, |(_, q)| q)
}

/// Whether the client prefers the Markdown copy: it names `text/markdown`, at least as high as
/// HTML. A browser never names it, so it gets the page.
fn wants_markdown(headers: &HeaderMap) -> bool {
    let accept = headers
        .get_all(ACCEPT)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join(",");
    let md = quality(&accept, "text/markdown", false);
    md > 0.0 && md >= quality(&accept, "text/html", true)
}

/// A `404` that no cache keeps, as every error (the route's `no-cache` is only for pages).
fn not_found() -> Response {
    let mut res = ApiError::NOT_FOUND.into_response();
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Routed at `/docs`, `/docs/`, `/docs/{*page}` and `/docs.md`, never nested, so the path is whole.
pub(crate) async fn serve(State(docs): State<Docs>, req: Request) -> Response {
    let Some((slug, by_address)) = parse(req.uri().path()) else {
        return not_found();
    };
    let markdown = by_address || wants_markdown(req.headers());
    let md_path = if slug.is_empty() {
        "/docs.md".to_owned()
    } else {
        format!("/docs/{slug}.md")
    };
    let file = match (markdown, slug.is_empty()) {
        (true, _) => md_path.clone(),
        (false, true) => "/docs/index.html".to_owned(),
        (false, false) => format!("/docs/{slug}.html"),
    };
    let Ok(file_uri) = Uri::try_from(file) else {
        return not_found();
    };
    let (mut parts, body) = req.into_parts();
    parts.uri = file_uri;
    let Ok(res) = docs.files.oneshot(Request::from_parts(parts, body)).await;
    let mut res = res.into_response();
    if res.status() == StatusCode::NOT_FOUND {
        return not_found();
    }
    let headers = res.headers_mut();
    if !by_address {
        headers.append(VARY, HeaderValue::from_static("accept"));
    }
    if markdown {
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/markdown; charset=utf-8"),
        );
    } else if let Ok(link) = HeaderValue::from_str(&format!(
        "<{md_path}>; rel=\"alternate\"; type=\"text/markdown\""
    )) {
        headers.insert(LINK, link);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_names_a_page_or_nothing() {
        assert_eq!(parse("/docs"), Some(("", false)));
        assert_eq!(parse("/docs/"), Some(("", false)));
        assert_eq!(parse("/docs.md"), Some(("", true)));
        assert_eq!(parse("/docs/limits"), Some(("limits", false)));
        assert_eq!(parse("/docs/limits.md"), Some(("limits", true)));
        assert_eq!(parse("/docs/api/fees"), Some(("api/fees", false)));
        assert_eq!(parse("/docs/api/fees.md"), Some(("api/fees", true)));
        for bad in [
            "/docsx",
            "/docs/index",
            "/docs/index.md",
            "/docs/.md",
            "/docs/limits.html",
            "/docs/Limits",
            "/docs/a//b",
            "/docs/a/",
            "/docs/../web",
            "/docs/a%2fb",
            "/docs/a.md.md",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        assert_eq!(parse(&format!("/docs/{}", "a".repeat(65))), None);
        // Valid segments, too many of them: no page, and no file system error.
        assert_eq!(parse(&format!("/docs{}", "/a".repeat(200))), None);
    }

    fn accept(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            ACCEPT,
            HeaderValue::from_str(v).unwrap_or(HeaderValue::from_static("")),
        );
        h
    }

    #[test]
    fn markdown_only_for_a_client_that_prefers_it() {
        assert!(wants_markdown(&accept("text/markdown")));
        assert!(wants_markdown(&accept("text/markdown, text/html, */*")));
        assert!(wants_markdown(&accept("text/markdown;q=0.9, */*;q=0.8")));
        assert!(wants_markdown(&accept("text/html;q=0.5, text/markdown")));
        assert!(!wants_markdown(&HeaderMap::new()));
        assert!(!wants_markdown(&accept("*/*")));
        assert!(!wants_markdown(&accept(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        )));
        assert!(!wants_markdown(&accept("text/html, text/markdown;q=0.5")));
        assert!(!wants_markdown(&accept("text/markdown;q=0")));
        assert!(!wants_markdown(&accept("text/markdown;q=nan, text/*")));
        assert!(!wants_markdown(&accept("text/markdown;Q=0, text/html")));
        assert!(wants_markdown(&accept("text/html;Q=0.1, text/markdown")));
        assert!(!wants_markdown(&accept(
            "text/html;q=0.5, text/html;q=0.9, text/markdown;q=0.7"
        )));
    }
}
