//! One unary gRPC call to a Bark server, `bark_server.ArkService/GetVtxo`, over HTTP/2: with TLS
//! for `https://`, in the clear for `http://` (a test or a server of one's own). A fresh
//! connection per call; the server answers lookups once per id and caches them (`docs/ARK.md`).

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::Request;
use hyper::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_rustls::TlsConnector;

use crate::grpc;
use crate::id::VtxoId;

/// The largest reply read. A real VTXO is a few kilobytes; the decoder's caps fit well inside.
pub const MAX_REPLY: usize = 256 * 1024;

/// Where the Bark server is, from configuration only (SECURITY.md rule 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    tls: bool,
    host: String,
    port: u16,
}

impl Endpoint {
    /// `https://host[:port]` or `http://host[:port]`, with nothing after but an optional `/`. No
    /// credentials and no path: the call's path is fixed.
    pub fn parse(s: &str) -> Result<Self, &'static str> {
        const BAD: &str =
            "must be an https:// or http:// URL with a host, an optional port and no path";
        let (tls, rest) = if let Some(r) = s.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = s.strip_prefix("http://") {
            (false, r)
        } else {
            return Err(BAD);
        };
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        let ok = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']');
        if authority.is_empty() || !authority.bytes().all(ok) {
            return Err(BAD);
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) if !h.ends_with(':') && (!h.contains(':') || h.ends_with(']')) => {
                (h, p.parse::<u16>().ok().filter(|p| *p > 0).ok_or(BAD)?)
            }
            _ => (authority, if tls { 443 } else { 80 }),
        };
        let bracketed = host.strip_prefix('[').and_then(|h| h.strip_suffix(']'));
        // An IPv6 address only in brackets, so its colons are not read as a port.
        if bracketed.is_none() && host.contains(':') {
            return Err(BAD);
        }
        let host = bracketed.unwrap_or(host);
        if host.is_empty() || host.contains(['[', ']']) || ServerName::try_from(host).is_err() {
            return Err(BAD);
        }
        Ok(Self {
            tls,
            host: host.to_owned(),
            port,
        })
    }

    fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// Why a call got no VTXO. Each has a fixed label for the request log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    /// The server does not know the id (gRPC status 5).
    NotFound,
    Timeout,
    /// No connection, no TLS, or no HTTP/2 answer.
    Unavailable,
    /// The reply passed [`MAX_REPLY`].
    TooBig,
    /// An answer that is not a gRPC reply with a VTXO in it, or another gRPC error.
    Decode,
}

impl FetchError {
    pub fn label(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
            Self::TooBig => "response_too_big",
            Self::Decode => "decode",
        }
    }
}

static TLS: LazyLock<Option<Arc<rustls::ClientConfig>>> = LazyLock::new(|| {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .ok()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    Some(Arc::new(config))
});

/// Stops the connection's task when the call ends or is dropped.
struct Driver(JoinHandle<()>);

impl Drop for Driver {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The serialized VTXO the server holds for `id`, within `timeout`.
pub async fn get_vtxo(
    ep: &Endpoint,
    id: &VtxoId,
    timeout: Duration,
) -> Result<Vec<u8>, FetchError> {
    tokio::time::timeout(timeout, connect_and_call(ep, id))
        .await
        .unwrap_or(Err(FetchError::Timeout))
}

async fn connect_and_call(ep: &Endpoint, id: &VtxoId) -> Result<Vec<u8>, FetchError> {
    let tcp = TcpStream::connect((ep.host.as_str(), ep.port))
        .await
        .map_err(|_| FetchError::Unavailable)?;
    let _ = tcp.set_nodelay(true);
    if !ep.tls {
        return call(tcp, ep, id).await;
    }
    let config = TLS.clone().ok_or(FetchError::Unavailable)?;
    let name = ServerName::try_from(ep.host.clone()).map_err(|_| FetchError::Unavailable)?;
    let tls = TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|_| FetchError::Unavailable)?;
    call(tls, ep, id).await
}

/// The gRPC status in `headers`, if it is there.
fn grpc_status(headers: &HeaderMap) -> Option<&[u8]> {
    headers.get("grpc-status").map(HeaderValue::as_bytes)
}

fn status_error(s: &[u8]) -> Option<FetchError> {
    match s {
        b"0" => None,
        b"5" => Some(FetchError::NotFound),
        _ => Some(FetchError::Decode),
    }
}

async fn call<S>(io: S, ep: &Endpoint, id: &VtxoId) -> Result<Vec<u8>, FetchError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut send, conn) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(io))
            .await
            .map_err(|_| FetchError::Unavailable)?;
    let _driver = Driver(tokio::spawn(async move {
        let _ = conn.await;
    }));
    let scheme = if ep.tls { "https" } else { "http" };
    let req = Request::post(format!(
        "{scheme}://{}/bark_server.ArkService/GetVtxo",
        ep.authority()
    ))
    .header(CONTENT_TYPE, "application/grpc")
    .header("te", "trailers")
    .body(Full::new(Bytes::from(grpc::request(id))))
    .map_err(|_| FetchError::Unavailable)?;
    let res = send
        .send_request(req)
        .await
        .map_err(|_| FetchError::Unavailable)?;
    if res.status() != hyper::StatusCode::OK {
        return Err(FetchError::Unavailable);
    }
    // A reply with no message carries its status in the headers ("trailers-only").
    if let Some(e) = grpc_status(res.headers()).and_then(status_error) {
        return Err(e);
    }
    let collected = Limited::new(res.into_body(), MAX_REPLY)
        .collect()
        .await
        .map_err(|e| {
            if e.downcast_ref::<LengthLimitError>().is_some() {
                FetchError::TooBig
            } else {
                FetchError::Unavailable
            }
        })?;
    let trailer_status = collected.trailers().and_then(grpc_status);
    if let Some(e) = trailer_status.and_then(status_error) {
        return Err(e);
    }
    let body = collected.to_bytes();
    grpc::reply(&body)
        .map(<[u8]>::to_vec)
        .ok_or(FetchError::Decode)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_endpoints() {
        let e = Endpoint::parse("https://ark.second.tech").unwrap();
        assert_eq!(
            (e.tls, e.host.as_str(), e.port),
            (true, "ark.second.tech", 443)
        );
        let e = Endpoint::parse("http://127.0.0.1:3535/").unwrap();
        assert_eq!((e.tls, e.host.as_str(), e.port), (false, "127.0.0.1", 3535));
        let e = Endpoint::parse("http://[::1]:9").unwrap();
        assert_eq!(
            (e.host.as_str(), e.authority()),
            ("::1", "[::1]:9".to_owned())
        );
        for bad in [
            "ark.second.tech",
            "ftp://x",
            "https://",
            "https://user:pw@host",
            "https://host/path",
            "https://host:0",
            "https://host:99999",
            "https://ho st",
            "https://[::1",
            "https://::1",
        ] {
            assert!(Endpoint::parse(bad).is_err(), "{bad}");
        }
    }
}
