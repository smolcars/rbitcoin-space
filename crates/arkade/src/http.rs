//! HTTP/1.1 GETs to one Arkade server over TCP, with TLS for `https://`, on pooled keep-alive
//! connections. Only GET exists here: the client never writes to the server.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt as _, Empty, LengthLimitError, Limited};
use hyper::header::{ACCEPT, CONTENT_LENGTH, HeaderValue, USER_AGENT};
use hyper::{Request, StatusCode, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection, HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::Error;

/// Idle keep-alive connections are closed after this long.
const POOL_IDLE: Duration = Duration::from_secs(30);

/// Where the Arkade server listens: `http(s)://host[:port]` and an optional base path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    https: bool,
    /// `scheme://authority`.
    origin: String,
    base_path: String,
}

impl Endpoint {
    /// Parses `{NET}_ARKADE_URL`. Credentials, a query and a fragment are refused: URLs end up in
    /// logs, and nothing about the path may come from anywhere but this setting.
    pub fn parse(s: &str) -> Result<Self, &'static str> {
        let s = s.trim();
        if s.contains('#') {
            return Err("a fragment is not allowed");
        }
        let uri: Uri = s.parse().map_err(|_| "not a URL")?;
        let https = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => return Err("only http:// and https:// URLs are supported"),
        };
        if uri.query().is_some() {
            return Err("a query string is not allowed");
        }
        let authority = uri.authority().ok_or("no host")?;
        if authority.as_str().contains('@') {
            return Err("credentials in the URL are not allowed");
        }
        if authority.host().is_empty() {
            return Err("no host");
        }
        let scheme = if https { "https" } else { "http" };
        Ok(Self {
            https,
            origin: format!("{scheme}://{authority}"),
            base_path: uri.path().trim_end_matches('/').to_owned(),
        })
    }

    pub fn is_https(&self) -> bool {
        self.https
    }
}

/// One server's connection pool.
#[derive(Clone)]
pub(crate) struct Transport {
    client: Client<Connector, Empty<Bytes>>,
    /// `scheme://authority` plus base path, prepended to each route path.
    prefix: Arc<str>,
    timeout: Duration,
    user_agent: HeaderValue,
}

impl Transport {
    pub fn new(
        endpoint: &Endpoint,
        timeout: Duration,
        user_agent: &'static str,
    ) -> Result<Self, rustls::Error> {
        let mut http = HttpConnector::new();
        http.enforce_http(false);
        http.set_nodelay(true);
        http.set_connect_timeout(Some(timeout));
        let tls = endpoint.https.then(tls_connector).transpose()?;
        let client = Client::builder(TokioExecutor::new())
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(POOL_IDLE)
            .build(Connector { http, tls });
        Ok(Self {
            client,
            prefix: format!("{}{}", endpoint.origin, endpoint.base_path).into(),
            timeout,
            user_agent: HeaderValue::from_static(user_agent),
        })
    }

    /// GETs `path` (with its query) and reads the whole body, within the timeout and `max_body`.
    /// Any status is returned: arkd's gateway answers some lookups of unknown things with a 500.
    pub async fn get(&self, path: &str, max_body: usize) -> Result<(StatusCode, Bytes), Error> {
        tokio::time::timeout(self.timeout, self.get_inner(path, max_body))
            .await
            .map_err(|_| Error::Timeout)?
    }

    async fn get_inner(&self, path: &str, max_body: usize) -> Result<(StatusCode, Bytes), Error> {
        let uri: Uri = format!("{}{path}", self.prefix)
            .parse()
            .map_err(|_| Error::Decode)?;
        let req = Request::get(uri)
            .header(USER_AGENT, self.user_agent.clone())
            .header(ACCEPT, "application/json")
            .body(Empty::new())
            .map_err(|_| Error::Decode)?;
        let res = self
            .client
            .request(req)
            .await
            .map_err(|_| Error::Unavailable)?;
        let (parts, body) = res.into_parts();
        let announced = parts
            .headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()?.parse::<u64>().ok());
        if announced.is_some_and(|n| n > max_body as u64) {
            return Err(Error::TooBig);
        }
        let body = Limited::new(body, max_body).collect().await.map_err(|e| {
            if e.downcast_ref::<LengthLimitError>().is_some() {
                Error::TooBig
            } else {
                Error::Unavailable
            }
        })?;
        Ok((parts.status, body.to_bytes()))
    }
}

/// TLS 1.3 with the `ring` provider, checked against Mozilla's roots, HTTP/1.1 only.
fn tls_connector() -> Result<TlsConnector, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

/// TCP, then TLS when the server's URL says `https`.
#[derive(Clone)]
struct Connector {
    http: HttpConnector,
    tls: Option<TlsConnector>,
}

impl tower_service::Service<Uri> for Connector {
    type Response = TokioIo<Stream>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = io::Result<Self::Response>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.http.poll_ready(cx).map_err(io::Error::other)
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let host = uri.host().unwrap_or_default().to_owned();
        let tcp = self.http.call(uri);
        let tls = self.tls.clone();
        Box::pin(async move {
            let tcp = tcp.await.map_err(io::Error::other)?.into_inner();
            let Some(tls) = tls else {
                return Ok(TokioIo::new(Stream::Plain(tcp)));
            };
            // An IPv6 literal comes bracketed from the URI.
            let name = ServerName::try_from(host.trim_matches(['[', ']']).to_owned())
                .map_err(io::Error::other)?;
            let stream = tls.connect(name, tcp).await?;
            Ok(TokioIo::new(Stream::Tls(Box::new(stream))))
        })
    }
}

/// A connection, plain or under TLS.
enum Stream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl Connection for Stream {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_flush(cx),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        let e = Endpoint::parse("https://arkade.computer/").unwrap();
        assert!(e.is_https());
        assert_eq!(e.origin, "https://arkade.computer");
        assert_eq!(e.base_path, "");
        let e = Endpoint::parse("http://127.0.0.1:7070/ark").unwrap();
        assert!(!e.is_https());
        assert_eq!(e.origin, "http://127.0.0.1:7070");
        assert_eq!(e.base_path, "/ark");
        for bad in [
            "",
            "arkade.computer",
            "ftp://arkade.computer",
            "https://user:pw@arkade.computer",
            "https://arkade.computer/?x=1",
            "https://arkade.computer/#x",
            "/run/arkd.sock",
        ] {
            assert!(Endpoint::parse(bad).is_err(), "{bad}");
        }
    }
}
