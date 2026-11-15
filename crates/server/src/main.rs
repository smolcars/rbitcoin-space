use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::process::ExitCode;
use std::time::Duration;

use logging::events::{
    ConfigInvalid, ListenFailed, Listening, NetworkEnabled, NoNetworks, ServerStarting,
    ServerStopped, ShutdownRequested, WebDirMissing,
};
use rbitcoin_space::config::EsploraEndpoint;
use rbitcoin_space::{App, Config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long exit waits for queued log lines; a blocked stdout must not hang shutdown.
const LOG_FLUSH: Duration = Duration::from_secs(2);

#[tokio::main]
async fn main() -> ExitCode {
    let code = run().await;
    logging::flush(LOG_FLUSH);
    code
}

async fn run() -> ExitCode {
    let (settings, bad_settings) = match logging::Settings::from_env() {
        Ok(s) => (s, None),
        Err(e) => (logging::Settings::default_for_stdout(), Some(e)),
    };
    logging::init(settings, std::io::stdout());
    logging::install_panic_hook();
    let config = match bad_settings.map_or_else(Config::from_env, Err) {
        Ok(config) => config,
        Err(error) => {
            logging::emit(&ConfigInvalid { error: &error });
            return ExitCode::FAILURE;
        }
    };
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return if healthcheck(config.listen).await {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }

    started(&config, settings);
    let listener = match rbitcoin_space::bind(config.listen) {
        Ok(listener) => listener,
        Err(e) => {
            logging::emit(&ListenFailed {
                addr: config.listen.to_string(),
                error: e.to_string(),
            });
            return ExitCode::FAILURE;
        }
    };
    let bound = listener.local_addr().unwrap_or(config.listen);
    logging::emit(&Listening {
        addr: bound.to_string(),
    });
    App::new(&config).serve(listener, shutdown_signal()).await;
    logging::emit(&ServerStopped {});
    ExitCode::SUCCESS
}

/// The effective configuration, without secrets: the RPC password and user are left out.
fn started(config: &Config, log: logging::Settings) {
    let l = &config.limits;
    logging::emit(&ServerStarting {
        version: env!("CARGO_PKG_VERSION"),
        revision: rbitcoin_space::REVISION,
        listen_addr: config.listen.to_string(),
        // Empty: the frontend is off (`WEB_DIR=`).
        web_dir: config
            .web_dir
            .as_ref()
            .map_or_else(String::new, |d| d.display().to_string()),
        networks: config.networks.iter().map(|n| n.network.name()).collect(),
        log_format: log.format.as_str(),
        log_level: log.level.as_str(),
        log_requests: config.log_requests.as_str(),
        log_client_addr: config.log_client_addr,
        log_max_bytes_per_sec: log.max_bytes_per_sec,
        broadcast_enabled: config.broadcast,
        cloudflare_web_analytics: config.cloudflare_web_analytics,
        max_body_bytes: l.max_body_bytes,
        request_timeout_secs: l.request_timeout.as_secs(),
        max_connections: l.max_connections,
        max_concurrent_requests: l.max_requests,
        client_max_connections: l.client_connections,
        client_max_concurrent_requests: l.client_requests,
        client_rate_per_sec: l.client_rate_per_sec,
        client_burst: l.client_burst,
        max_tracked_clients: l.max_tracked_clients,
        trusted_proxy_header: l.trusted_proxy.as_ref().map(|t| t.header.as_str()),
        trusted_proxies: l
            .trusted_proxy
            .as_ref()
            .map(|t| t.proxies.iter().map(ToString::to_string).collect()),
        ws_max_sockets: config.ws.max_sockets,
        ws_client_max_sockets: config.ws.client_max_sockets,
        ws_v1_max_sockets: config.ws.v1_max_sockets,
        ws_v1_client_max_sockets: config.ws.v1_client_max_sockets,
        ws_max_message_bytes: config.ws.max_message_bytes,
        ws_messages_per_sec: config.ws.messages_per_sec,
        ws_max_subscriptions: config.ws.max_subscriptions,
        ws_send_queue: config.ws.send_queue,
        ws_idle_timeout_secs: config.ws.idle_timeout.as_secs(),
        ws_max_block_subscriptions: config.ws.max_block_subscriptions,
        ws_mempool_interval_ms: u64::try_from(config.ws.mempool_interval.as_millis())
            .unwrap_or(u64::MAX),
        ws_block_wait_secs: config.ws.block_wait.as_secs(),
        ws_latest_txs: config.ws.latest_txs,
        ws_max_tracked_txs: config.ws.max_tracked_txs,
        ws_max_tracked_addresses: config.ws.max_tracked_addresses,
        ws_tracked_txs_total: config.ws.tracked_txs_total,
        ws_tracked_addresses_total: config.ws.tracked_addresses_total,
        ws_position_interval_ms: u64::try_from(config.ws.position_interval.as_millis())
            .unwrap_or(u64::MAX),
        replacements_kept: config.ws.replacements_kept,
        block_summary_cache_mb: l.summary_cache_bytes >> 20,
        answer_cache_mb: l.answer_cache_bytes >> 20,
        data_dir: config.data_dir.as_ref().map(|d| d.display().to_string()),
        backfill_enabled: config.backfill.enabled,
        backfill_busy_percent: config.backfill.busy_percent,
        backfill_fee_rate_depth: config.backfill.fee_rate_depth,
        ledger_max_addresses: config.ledger.max_addresses,
        ledger_discover: config.ledger.discover,
        ledger_max_history_rows: config.ledger.max_history_rows,
    });
    for n in &config.networks {
        logging::emit(&NetworkEnabled {
            network: n.network.name(),
            rpc_addr: format!("{}:{}", n.rpc.host, n.rpc.port),
            esplora: match &n.esplora {
                EsploraEndpoint::Http(url) => url.clone(),
                EsploraEndpoint::Unix(path) => path.display().to_string(),
            },
            electrum_addr: &n.electrum,
            mempool: n.mempool,
            lightning: n.lightning.is_some(),
        });
    }
    if config.networks.is_empty() {
        logging::emit(&NoNetworks {});
    }
    if let Some(dir) = &config.web_dir
        && !dir.join("index.html").is_file()
    {
        logging::emit(&WebDirMissing {
            web_dir: dir.display().to_string(),
        });
    }
}

/// `rbitcoin-space healthcheck`: whether the server at `LISTEN_ADDR` answers `/healthz` with 200.
/// The container image has no shell or curl, so its health check runs the binary itself.
async fn healthcheck(listen: SocketAddr) -> bool {
    let ip = match listen.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let check = async {
        let mut stream = TcpStream::connect((ip, listen.port())).await?;
        stream
            .write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await?;
        // The status line starts `HTTP/1.x 200`.
        let mut head = [0; 12];
        stream.read_exact(&mut head).await?;
        Ok::<_, std::io::Error>(head.ends_with(b" 200"))
    };
    matches!(
        tokio::time::timeout(Duration::from_secs(5), check).await,
        Ok(Ok(true))
    )
}

/// Resolves on Ctrl-C or SIGTERM; in-flight requests then finish before exit.
async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    let signal = tokio::select! {
        () = ctrl_c => "ctrl_c",
        () = terminate => "sigterm",
    };
    logging::emit(&ShutdownRequested { signal });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use rbitcoin_space::config::RequestLog;
    use rbitcoin_space::{Limits, WsLimits};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn healthcheck_needs_a_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let config = Config {
            listen: addr,
            web_dir: Some("missing".into()),
            data_dir: None,
            backfill: rbitcoin_space::config::Backfill::default(),
            ledger: rbitcoin_space::config::LedgerConfig::default(),
            networks: Vec::new(),
            limits: Limits::default(),
            ws: WsLimits::default(),
            broadcast: false,
            log_requests: RequestLog::All,
            log_client_addr: false,
            cloudflare_web_analytics: false,
        };
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(App::new(&config).serve(listener, async {
            stopped.await.ok();
        }));
        // An unspecified address is checked on loopback, as LISTEN_ADDR=0.0.0.0:… in the image.
        let any = SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), addr.port());
        assert!(healthcheck(any).await);
        stop.send(()).unwrap();
        server.await.unwrap();
        assert!(!healthcheck(addr).await);
    }

    #[derive(Clone, Default)]
    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn an_empty_web_dir_is_no_frontend_and_no_warning() {
        let config = Config::from_vars(|k| (k == "WEB_DIR").then(String::new)).unwrap();
        assert_eq!(config.web_dir, None);
        let settings = logging::Settings {
            format: logging::Format::Json,
            level: logging::Level::Debug,
            max_bytes_per_sec: logging::DEFAULT_MAX_BYTES_PER_SEC,
        };
        let out = Capture::default();
        assert!(logging::init(settings, out.clone()));
        started(&config, settings);
        logging::flush(LOG_FLUSH);
        let log = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        let events: Vec<serde_json::Value> = log
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let starting = events.iter().find(|e| e["event"] == "server_starting");
        assert_eq!(starting.unwrap()["web_dir"], "", "{log}");
        assert!(
            events.iter().all(|e| e["event"] != "web_dir_missing"),
            "{log}"
        );
    }
}
