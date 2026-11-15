//! The client against a fake Bark server on a free port, speaking HTTP/2 in the clear.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::convert::Infallible;
use std::time::Duration;

use bark::{Endpoint, FetchError, MAX_REPLY, VtxoId, get_vtxo};
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::HeaderValue;
use hyper::{HeaderMap, Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::TcpListener;

const TXID: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn frame(msg: &[u8]) -> Vec<u8> {
    let mut b = vec![0];
    b.extend((msg.len() as u32).to_be_bytes());
    b.extend(msg);
    b
}

fn with_status(body: Vec<u8>, status: &'static str) -> BoxBody<Bytes, Infallible> {
    let mut t = HeaderMap::new();
    t.insert("grpc-status", HeaderValue::from_static(status));
    Full::new(Bytes::from(body))
        .with_trailers(async move { Some(Ok(t)) })
        .boxed()
}

/// Answers by the vout asked for: 0 a VTXO, 1 unknown, 2 too big, 3 never, 4 not gRPC.
async fn handle(
    req: Request<Incoming>,
) -> Result<Response<BoxBody<Bytes, Infallible>>, Infallible> {
    assert_eq!(req.uri().path(), "/bark_server.ArkService/GetVtxo");
    assert_eq!(req.headers()["content-type"], "application/grpc");
    let body = req.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..7], &[0, 0, 0, 0, 38, 0x0a, 36]);
    let vout = u32::from_le_bytes(body[5 + 2 + 32..].try_into().unwrap());
    let res = match vout {
        0 => {
            let mut msg = vec![0x0a, 5];
            msg.extend([1, 2, 3, 4, 5]);
            Response::new(with_status(frame(&msg), "0"))
        }
        1 => Response::builder()
            .header("grpc-status", "5")
            .body(Full::new(Bytes::new()).boxed())
            .unwrap(),
        2 => Response::new(with_status(vec![0; MAX_REPLY + 1], "0")),
        3 => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            unreachable!()
        }
        _ => Response::new(with_status(b"<html>".to_vec(), "0")),
    };
    Ok(res)
}

async fn fake_server() -> Endpoint {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                    .serve_connection(TokioIo::new(tcp), hyper::service::service_fn(handle))
                    .await;
            });
        }
    });
    Endpoint::parse(&format!("http://{addr}")).unwrap()
}

fn id(vout: u32) -> VtxoId {
    format!("{TXID}:{vout}").parse().unwrap()
}

#[tokio::test]
async fn answers_and_failures() {
    let ep = fake_server().await;
    let long = Duration::from_secs(20);
    assert_eq!(get_vtxo(&ep, &id(0), long).await, Ok(vec![1, 2, 3, 4, 5]));
    assert_eq!(get_vtxo(&ep, &id(1), long).await, Err(FetchError::NotFound));
    assert_eq!(get_vtxo(&ep, &id(2), long).await, Err(FetchError::TooBig));
    assert_eq!(get_vtxo(&ep, &id(4), long).await, Err(FetchError::Decode));
    // The server never answers this one: the call gives up at its timeout.
    assert_eq!(
        get_vtxo(&ep, &id(3), Duration::from_millis(200)).await,
        Err(FetchError::Timeout)
    );
}

#[tokio::test]
async fn nobody_listening_is_unavailable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let ep = Endpoint::parse(&format!("http://{addr}")).unwrap();
    assert_eq!(
        get_vtxo(&ep, &id(0), Duration::from_secs(20)).await,
        Err(FetchError::Unavailable)
    );
}
