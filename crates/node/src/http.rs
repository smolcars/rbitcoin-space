//! HTTP/1.1 to the node over TCP or a unix socket, with pooled keep-alive connections.
//! Shared by the Esplora and JSON-RPC clients.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt as _, Full, LengthLimitError, Limited};
use hyper::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HOST, HeaderMap, HeaderValue};
use hyper::{Request, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use tokio::net::UnixStream;

/// A transport failure. Each client maps it into its own error type.
#[derive(Debug)]
pub(crate) enum Error {
    /// The request could not be formed from the endpoint and path.
    Config(&'static str),
    Unavailable(String),
    Timeout,
    ResponseTooBig,
}

/// Idle keep-alive connections are closed after this long.
const POOL_IDLE: Duration = Duration::from_secs(30);

/// Where the node listens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// `http://host:port` and an optional base path such as `/api`.
    Tcp { origin: String, base_path: String },
    /// A unix-socket path. Only this listener serves `/internal/*`.
    Unix(PathBuf),
}

impl Endpoint {
    /// Parses `{NET}_ESPLORA_URL`: an `http://` URL, or otherwise a unix-socket path.
    pub fn parse(s: &str) -> Result<Self, &'static str> {
        let s = s.trim();
        if s.is_empty() {
            return Err("empty");
        }
        if !s.contains("://") {
            return Ok(Self::Unix(PathBuf::from(s)));
        }
        let uri: Uri = s.parse().map_err(|_| "not a URL")?;
        // The node speaks plain HTTP; TLS belongs to a reverse proxy in front of the public site.
        if uri.scheme_str() != Some("http") {
            return Err("only http:// URLs and unix-socket paths are supported");
        }
        if uri.query().is_some() {
            return Err("a query string is not allowed");
        }
        let authority = uri.authority().ok_or("no host")?;
        Ok(Self::Tcp {
            origin: format!("http://{authority}"),
            base_path: uri.path().trim_end_matches('/').to_owned(),
        })
    }
}

/// An upstream answer, read in full.
pub(crate) struct Response {
    pub status: hyper::StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

#[derive(Clone)]
enum Pool {
    Tcp(Client<HttpConnector, Full<Bytes>>),
    Unix(Client<UnixConnector, Full<Bytes>>),
}

#[derive(Clone)]
pub(crate) struct Transport {
    pool: Pool,
    /// `http://authority` plus base path, prepended to each route path.
    prefix: Arc<str>,
    timeout: Duration,
    max_body: usize,
    /// Sent on every request. Marked sensitive so `Debug` never prints it.
    authorization: Option<HeaderValue>,
    /// Response body bytes read so far, shared by clones.
    received: Arc<AtomicU64>,
}

impl Transport {
    pub fn new(endpoint: &Endpoint, timeout: Duration, max_body: usize) -> Self {
        let mut builder = Client::builder(TokioExecutor::new());
        builder
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(POOL_IDLE);
        let (pool, prefix) = match endpoint {
            Endpoint::Tcp { origin, base_path } => {
                let mut http = HttpConnector::new();
                http.set_nodelay(true);
                (
                    Pool::Tcp(builder.build(http)),
                    format!("{origin}{base_path}"),
                )
            }
            Endpoint::Unix(path) => {
                // The authority only keys the pool; the connector ignores it.
                let unix = UnixConnector(path.as_path().into());
                (
                    Pool::Unix(builder.build(unix)),
                    "http://localhost".to_owned(),
                )
            }
        };
        Self {
            pool,
            prefix: prefix.into(),
            timeout,
            max_body,
            authorization: None,
            received: Arc::default(),
        }
    }

    /// Sends `value` as the `Authorization` header on every request.
    pub fn with_authorization(mut self, mut value: HeaderValue) -> Self {
        value.set_sensitive(true);
        self.authorization = Some(value);
        self
    }

    /// Response body bytes this transport and its clones have read.
    pub fn bytes_received(&self) -> u64 {
        self.received.load(Ordering::Relaxed)
    }

    pub fn is_unix(&self) -> bool {
        matches!(self.pool, Pool::Unix(_))
    }

    /// Sends one request and reads the whole body, within the timeout and the size cap.
    pub async fn send(
        &self,
        method: hyper::Method,
        path: &str,
        body: Option<(Bytes, &'static str)>,
    ) -> Result<Response, Error> {
        self.send_limited(method, path, body, self.max_body).await
    }

    /// [`Transport::send`] with a cap of `max_body` bytes, if that is below the transport's own.
    pub async fn send_limited(
        &self,
        method: hyper::Method,
        path: &str,
        body: Option<(Bytes, &'static str)>,
        max_body: usize,
    ) -> Result<Response, Error> {
        let max_body = max_body.min(self.max_body);
        tokio::time::timeout(self.timeout, self.send_inner(method, path, body, max_body))
            .await
            .map_err(|_| Error::Timeout)?
    }

    async fn send_inner(
        &self,
        method: hyper::Method,
        path: &str,
        body: Option<(Bytes, &'static str)>,
        max_body: usize,
    ) -> Result<Response, Error> {
        let uri: Uri = format!("{}{path}", self.prefix)
            .parse()
            .map_err(|_| Error::Config("route did not form a URI"))?;
        let mut req = Request::builder().method(method).uri(uri);
        if matches!(self.pool, Pool::Unix(_)) {
            req = req.header(HOST, "localhost");
        }
        if let Some(auth) = &self.authorization {
            req = req.header(AUTHORIZATION, auth.clone());
        }
        let body = match body {
            Some((bytes, content_type)) => {
                req = req.header(CONTENT_TYPE, content_type);
                Full::new(bytes)
            }
            None => Full::default(),
        };
        let req = req
            .body(body)
            .map_err(|_| Error::Config("route did not form a request"))?;
        let pending = match &self.pool {
            Pool::Tcp(c) => c.request(req),
            Pool::Unix(c) => c.request(req),
        };
        let res = pending
            .await
            .map_err(|e| Error::Unavailable(error_chain(&e)))?;
        let (parts, body) = res.into_parts();
        // Refuse early when the node announces a body over the cap.
        let announced = parts
            .headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()?.parse::<u64>().ok());
        if announced.is_some_and(|n| n > max_body as u64) {
            return Err(Error::ResponseTooBig);
        }
        let body = Limited::new(body, max_body).collect().await.map_err(|e| {
            if e.downcast_ref::<LengthLimitError>().is_some() {
                Error::ResponseTooBig
            } else {
                Error::Unavailable(error_chain(e.as_ref()))
            }
        })?;
        let body = body.to_bytes();
        self.received
            .fetch_add(body.len() as u64, Ordering::Relaxed);
        Ok(Response {
            status: parts.status,
            headers: parts.headers,
            body,
        })
    }
}

/// The error and its causes on one line. hyper's errors name no address or path.
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cause = e.source();
    while let Some(c) = cause {
        out.push_str(": ");
        out.push_str(&c.to_string());
        cause = c.source();
    }
    out
}

/// Connects every request to one unix socket, whatever the URI says.
#[derive(Clone)]
struct UnixConnector(Arc<Path>);

impl tower_service::Service<Uri> for UnixConnector {
    type Response = TokioIo<UnixStream>;
    type Error = std::io::Error;
    type Future = Pin<Box<dyn Future<Output = std::io::Result<Self::Response>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: Uri) -> Self::Future {
        let path = self.0.clone();
        Box::pin(async move { UnixStream::connect(&*path).await.map(TokioIo::new) })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        assert_eq!(
            Endpoint::parse("http://node:3000/signet/api/").unwrap(),
            Endpoint::Tcp {
                origin: "http://node:3000".into(),
                base_path: "/signet/api".into()
            }
        );
        assert_eq!(
            Endpoint::parse("http://node:3000").unwrap(),
            Endpoint::Tcp {
                origin: "http://node:3000".into(),
                base_path: String::new()
            }
        );
        assert_eq!(
            Endpoint::parse("/run/esplora.sock").unwrap(),
            Endpoint::Unix("/run/esplora.sock".into())
        );
        assert!(Endpoint::parse("https://node").is_err());
        assert!(Endpoint::parse("http://node/api?x=1").is_err());
        assert!(Endpoint::parse("").is_err());
    }
}
