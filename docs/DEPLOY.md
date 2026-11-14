# Running rbitcoin.space

The operator's guide: how to put the explorer beside an rbitcoin node, behind TLS, and keep it running and upgraded. Read it top to bottom the first time. Settings are listed once, in [`CONFIG.md`](CONFIG.md); this guide links there instead of repeating them.

What you run is one image, `ghcr.io/smolcars/rbitcoin-space`, holding the server and the built frontend, and [`deploy/compose.yml`](../deploy/compose.yml), which runs it beside rbitcoin v0.9.2. Every command below was run as written, on Docker 29.8 with Compose v5.5, against a regtest node; the [mainnet values](#run-it-beside-the-node) are what differs. The exceptions say so where they stand: what needs a Cloudflare account, and what the first public deployment, on 2026-11-14, observed on its own host.

## What you need

### The node

rbitcoin at **v0.9.2**, the version this release was built and tested against. The compose file runs one for you; if you bring your own, it needs these switched on:

| Flag | The explorer uses it for | Without it |
|---|---|---|
| `--esplora-listen` | Blocks, transactions, addresses, spends, broadcast, fee estimates: most of what a page shows | Nothing works |
| `--electrum-listen` | Being told about new blocks and about changes to followed addresses and transactions | Nothing is live, and `/readyz` stays `503` |
| `--rpc-listen` with `--rpc-cookie-file` | The live mempool, projected blocks, block statistics and the backfill. The cookie file holds `user:password`; rbitcoin has no `--rpcuser` | No mempool, no block table, no mining pages |
| `--sh-index` | Address pages and the address and scripthash API routes | Those answer `503` `address index is disabled on this server`; everything else works. The server says so at startup (`address_index_off`, and `address_index` in [`/readyz`](#health)). It is off by default in rbitcoin |

#### Large addresses and the node's cap

Keep `--max-sh-creates` on (rbitcoin's default, 10,000 paying transactions) on a node that serves anyone but the server, its public Electrum port above all: raising it lets anyone start joins of millions of transactions. The explorer keeps the busiest addresses' totals itself and needs the node to add each up once ([`API.md`](API.md#very-large-addresses)). With the server on the node's Esplora unix socket and a node that has rbitcoin PR 1628 (no release yet; nightly images from `nightly-20261114` on), it does that through the socket alone, one address at a time, so the cap can stay where it is. The log says which at startup and after every reconnect: `ledger_totals_route` with `uncapped: true` ([`RBITCOIN.md`](RBITCOIN.md#totals-of-large-addresses)). What the cap still costs is the whole history of an address above it: rbitcoin has no socket-only list yet, so such an address shows its totals and newest 200 transactions, and its older pages are refused. On v0.9.2, or over TCP, an address above the cap is shown as too large for this server unless the cap is raised for everyone.

Esplora and Electrum have no authentication. Never let anything but the server reach them. The [interfaces and what the explorer relies on](RBITCOIN.md) are documented separately.

### The host

Linux with Docker Engine and the Compose plugin, on amd64 or arm64. The node needs what rbitcoin needs for the chain; the server needs little:

| | Expect |
|---|---|
| Memory | 251 MB resident, [measured](#one-day-on-mainnet) for mainnet, signet and testnet4 together with the mempool engine on each and [Lightning](#lightning) on mainnet, without visitors. [`LIGHTNING.md`](LIGHTNING.md#measured-in-the-server) measured Lightning at 250 to 330 MB more, by the process's physical footprint, a larger measure than resident memory; how much of the 251 MB it was is not known. More with open WebSockets (64 MB at the peak with 5,000, in a load test, [`WS.md`](WS.md)) and as the block summaries and kept answers fill, up to `BLOCK_SUMMARY_CACHE_MB` and `ANSWER_CACHE_MB` (32 MB each) per network |
| CPU | About 6% of one core, measured for the same server. 8% with 5,000 WebSockets open, in a load test |
| Disk | Measured after the full backfill: 547 MB for mainnet's store, 133 MB for signet's, 72 MB for testnet4's, and 35 MB for the Lightning graph ([the data directory](#the-data-directory)). Growth from there, estimated: about 150 MB a year on mainnet, nearly all of it audits. The log was 6.6 MB a day; it is capped at 256 KiB a second, so at worst it grows 22.6 GB a day ([`LOGGING.md`](LOGGING.md#for-operators)). The compose file's `local` driver keeps 100 MB of it, but a host that keeps the log another way must rotate it or lower `LOG_MAX_BYTES_PER_SEC` |
| Network | Nothing published but the node's P2P port and, through the proxy, 443. [Behind a Cloudflare Tunnel](#behind-a-cloudflare-tunnel), only P2P |

### One day on mainnet

The figures in this guide marked measured come from one server, on one machine, from 2026-11-12 09:11 UTC to 2026-11-13 10:13 UTC: mainnet, signet and testnet4, each with the mempool engine and the backfill on from an empty store, and Lightning on mainnet. The nodes were on another host of the same private network, and had the block listing route ([`STORE.md`](STORE.md#backfill)). The server was restarted twelve times for new builds and had no visitors from 21:52 on; the site was offline from about 23:11 to 03:40, which did not stop the backfill. Memory and CPU were read at the end, 11 hours after the last restart. What they do not say is listed with each figure.

| | Measured | Not confirmed |
|---|---|---|
| Memory, CPU | 251 MB resident, about 6% of one core, all three networks | Mainnet alone; without Lightning; with real visitors |
| Stores | 547 MB mainnet (975,660 block rows, a year of fee rates, a day of audits and mempool history, 36,200 Lightning channels), 133 MB signet, 72 MB testnet4; Lightning graph and saved answers 35 MB | Growth per year: the 150 MB a year for audits is an estimate |
| Backfill | Mainnet: every block's totals 18 h 11 min after the start, the year of fee rates 59 min later; signet 3 h 13 min and 5 h 20 min; testnet4 1 h 21 min and 2 h 17 min ([the first start](#the-first-start)) | A run with no restarts; a node without the listing route |
| Node load, mempool | 120 MB a minute of RPC answers on mainnet with 39,000 transactions in the mempool, 200 MB with 63,000; about 45 tracker cycles a minute of 2.6 to 4.3 MB each; the slowest cycle in a minute took 230 ms at the median | |
| Lightning | First sync from an empty directory 273 s (36,826 outputs looked up in 126 requests, 56 MB of gossip). A restart from its own files: graph loaded in 62 ms, synced in 20 s, one lookup | A first sync with the build that paces lookups (PR #89): the one observed predates it |
| Log | 6.6 MB a day; without visitors 11 lines a minute ([a healthy minute](#the-log)) | |
| Requests and WebSockets | 4,255 requests over the first 13 hours, 3,109 of them in one hour, and 166 WebSocket upgrades; at most two clients on a topic | The cost of real traffic: the day had almost none |

### Many WebSockets

Every open page holds one WebSocket. At the default `WS_MAX_SOCKETS` (1,024) the host needs nothing more than the compose file sets. For more sockets, raise `WS_MAX_SOCKETS` ([`CONFIG.md`](CONFIG.md#websocket)) and check each line below. Measured on Linux up to 20,000 sockets, every message delivered to every client ([`PERFORMANCE.md`](PERFORMANCE.md#on-linux)); what stopped it each time was one of these.

| Limit | Needed | Check | When it is short |
|---|---|---|---|
| The server's open files | More than `WS_MAX_SOCKETS` + `WS_V1_MAX_SOCKETS` + `MAX_CONNECTIONS`, and about 100 for the node and the store. The compose file sets 65,536: Docker otherwise gives the daemon's default, as low as 1,024 on some hosts, too few even for the default caps | `grep 'open files' /proc/$(docker inspect -f '{{.State.Pid}}' $(docker compose ps -q server))/limits` (the image has no shell) | `accept_failed` with `Too many open files`. New visitors wait and time out, and the server's own new connections to the node fail too |
| `WS_MAX_SOCKETS` | The sockets you expect, every network together | `ws_max_sockets` in the `server_starting` event | New sockets get `503`, counted in `requests_refused` with `server_sockets` |
| `net.core.somaxconn` | 4,096, Linux's default since 5.4. The server asks for the host's maximum | `sysctl net.core.somaxconn` | After a restart every open page reconnects at once; past the listen queue a connection is retried after 1 s, then 2 s. Slower, nothing fails. `nstat -az TcpExtListenOverflows` counts them |
| Local ports on the proxy's host | One per socket: each is a connection from the proxy to the server's one address and port. The default range, 32768 to 60999, allows 28,232, connections closed in the last minute included | `sysctl net.ipv4.ip_local_port_range` | The proxy cannot connect (`address not available` in its own log); visitors get `502`. Widen it: `sysctl -w net.ipv4.ip_local_port_range="1024 65535"`, and in `/etc/sysctl.d/` to keep it |
| The proxy's open files | Two per socket | Its service's limit (for Caddy under systemd, `LimitNOFILE`) | The proxy's own errors |
| Memory | 16 KB a socket on top of [the figures above](#the-host): about 5 KB in the server, 6 KB in the kernel, the rest for messages in flight. With 20,000 sockets the server used 128 MB | `docker stats` | |
| CPU | Delivery is the server writing to each socket. With 20,000 sockets a new block reached the last client 54 ms (median) after the server started queueing it, on a quarter of a core on average; on one core instead of four, three times slower | `docker stats` | Updates arrive later. Nothing is dropped unless one client's own queue fills (`ws_clients_dropped`, `too_slow`) |

Not measured: connection tracking, if the host's firewall tracks connections (`nf_conntrack_max`; a socket through the proxy and Docker's published port can take two entries); Docker's own proxy process for the published port, which carries every connection with the daemon's limits; and `net.ipv4.tcp_mem`, which the measuring VM did not expose. Its default on a host with a few GB is far above the socket buffers measured, 52 MB at most for 16,000 sockets.

## Run it beside the node

### Same host, with the compose file

The layout this guide assumes, and the one the compose file builds:

```text
 internet ── reverse proxy (TLS) ──► server :8080 ─┬─ unix socket ──► node  Esplora
                                                   ├─ TCP 8332 ─────► node  JSON-RPC
                                                   └─ TCP 50001 ────► node  Electrum
 bitcoin peers ──────────────────────────────────────────────────────► node  P2P (published)
```

The node's Esplora is a unix socket, so it is on no network at all; RPC and Electrum are on the compose network only. The socket also carries rbitcoin's bulk `/internal/*` routes, which exist on no TCP listener ([`RBITCOIN.md`](RBITCOIN.md#what-it-does-not-give-us)).

Get the compose file at the release you run (the newest on the [releases page](https://github.com/smolcars/rbitcoin-space/releases)), make an RPC password, and start both:

```sh
VERSION=0.1.0
git clone --depth 1 --branch "v$VERSION" https://github.com/smolcars/rbitcoin-space.git
cd rbitcoin-space/deploy
cp .env.example .env && chmod 600 .env
pass=$(openssl rand -hex 32)
sed -i.bak "s/^MAINNET_RPC_PASSWORD=.*/MAINNET_RPC_PASSWORD=$pass/" .env && rm .env.bak
echo "SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space:$VERSION" >> .env
touch rpc.cookie && chmod 600 rpc.cookie
printf 'rbitcoin-space:%s' "$pass" > rpc.cookie
sudo chown 10001:10001 rpc.cookie
docker compose up -d
```

- The node reads the user and password from `rpc.cookie` (`user:password`, no newline), as its uid 10001, and refuses to start if others may read the file; the server reads the same pair from `MAINNET_RPC_USER` and `MAINNET_RPC_PASSWORD`. `.env` and `rpc.cookie` are git-ignored.
- Without `SERVER_IMAGE`, compose builds the image from the checkout instead of pulling it.
- The server listens on `127.0.0.1:8080` (`HTTP_PUBLISH` changes it), for the reverse proxy on the same host. Nothing outside the host can reach it.
- The node keeps its chain in the `node-data` volume, and the first mainnet sync takes as long as rbitcoin takes. The site serves what the node has meanwhile, and [`/readyz`](#health) says how far behind it is.
- `docker compose logs -f server` follows the server's log.

### The node on another host

Run the server alone and give it the node's addresses:

```sh
docker run -d --name rbitcoin-space --restart unless-stopped --log-driver local \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env-file server.env -e DATA_DIR=/data -v rbitcoin-space-data:/data \
  -p 127.0.0.1:8080:8080 ghcr.io/smolcars/rbitcoin-space:0.1.0
```

with `server.env` holding the six `MAINNET_*` variables ([`CONFIG.md`](CONFIG.md#networks)), `MAINNET_ESPLORA_URL` an `http://` address such as `http://node.internal:3000`. What differs:

- **The node's Esplora, Electrum and RPC are on a network.** None of them encrypts, and the first two do not authenticate. Put them on a private network or a tunnel (WireGuard, SSH) that only the server's host can reach.
- **Every node call crosses it.** With the mempool engine on, the server reads 120 to 200 MB a minute of RPC answers on mainnet, more as the mempool grows ([`CONFIG.md`](CONFIG.md#the-live-mempool)): 7 to 12 GB an hour between the two hosts, measured. The backfill's old blocks are mostly round trips, so it runs slower over a network ([`STORE.md`](STORE.md#backfill)).
- **No bulk routes.** rbitcoin's `/internal/*` routes are only on its unix socket. The server uses one: totals of addresses above the node's `--max-sh-creates` ([large addresses](#large-addresses-and-the-nodes-cap)). Over TCP those addresses are shown as too large for this server unless the cap is raised for everyone.

### The node in another compose project

When the host already runs rbitcoin in a compose project of its own, add the server to that project instead of running a second node. This is how the first public deployment ran, on 2026-11-14: one server beside three existing nodes (mainnet, signet, testnet4), in their project. Copy the `server` service from [`compose.yml`](../deploy/compose.yml) into that project's file, with its hardening and volume, and change what reaches the node:

```yaml
services:
  server:
    # ...the server service and its hardening from deploy/compose.yml, then:
    env_file: rbitcoin-space.env
    # The group id of each node's socket; nodes from one image share one.
    group_add: ["<socket gid>"]
    depends_on: [<node services>]
    volumes:
      - server-data:/data
      # Each node's Esplora socket directory, read-only.
      - <mainnet node's socket directory>:/run/mainnet:ro
      - <signet node's socket directory>:/run/signet:ro
      - <testnet4 node's socket directory>:/run/testnet4:ro
volumes:
  server-data:
```

- **Esplora over the node's unix socket.** Mount the directory holding the node's socket read-only and give `{NET}_ESPLORA_URL` the socket's absolute path inside the server, such as `/run/mainnet/esplora.sock`. The server connects to the socket as a member of its group: put each socket's group id in `group_add` (`stat -c %g <socket>` on the host, where the directory is a bind mount).
- **RPC and Electrum by service name,** on the project's network: `MAINNET_RPC_HOST=<node service>`, `MAINNET_ELECTRUM_ADDR=<node service>:<port>`. Neither is published.
- **The RPC user and password come from the node's cookie file** (`user:password`): copy them into the server's env file as `{NET}_RPC_USER` and `{NET}_RPC_PASSWORD`. If the node's cookie changes, copy it again and run `docker compose up -d --no-deps --force-recreate server`; until then the server logs `rpc_auth_failed`.
- **One server serves every network** with each network's six variables ([`CONFIG.md`](CONFIG.md#networks)); each node's socket gets a mount of its own.
- **Leave the nodes alone when you touch the server:** `docker compose up -d --no-deps server`. Without `--no-deps`, compose also starts, and may recreate, every service the server depends on ([upgrading](#upgrading)).

The deployment observed this working with all three networks. The YAML above was not run as written: its paths and names are the host's.

### Try it on regtest first

The same compose file runs a private regtest chain, which is a safe way to try every step of this guide. In the shell where you made `$pass` above, replace the node's lines and **every** `MAINNET_*` line in `.env` with regtest ones. A `MAINNET_*` line left behind points the explorer's mainnet at the regtest node, which the server reports as `rpc_wrong_network` ([below](#when-it-goes-wrong)), writing nothing to `mainnet.sqlite` meanwhile:

```sh
sed -i.bak -E '/^(NETWORK|P2P_PORT|MAINNET_[A-Z_]+)=/d' .env && rm .env.bak
cat >> .env <<EOF
NETWORK=regtest
P2P_PORT=18444
P2P_PUBLISH=127.0.0.1:0
HTTP_PUBLISH=127.0.0.1:0
REGTEST_RPC_HOST=node
REGTEST_RPC_PORT=8332
REGTEST_RPC_USER=rbitcoin-space
REGTEST_RPC_PASSWORD=$pass
REGTEST_ESPLORA_URL=/run/esplora/esplora.sock
REGTEST_ELECTRUM_ADDR=node:50001
EOF
```

`127.0.0.1:0` lets Docker choose free host ports; `docker compose port server 8080` prints the server's, which a proxy in front then uses in place of `127.0.0.1:8080`. The app is at `/regtest/`. Mine blocks with JSON-RPC from a container on the compose network:

```sh
docker run --rm --network rbitcoin-space_default curlimages/curl:8.11.1 -su "rbitcoin-space:$pass" \
  -d '{"method":"generatetoaddress","params":[101,"bcrt1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqseac85"]}' http://node:8332/
```

`docker compose down -v` removes the chain and the store.

## Health

| Route | Answers | Use it for |
|---|---|---|
| `/healthz` | `200` `{"status":"ok","version":"0.1.0","revision":…}` while the process serves HTTP. `revision` is the commit the binary was built from, or `unknown` for a build without one (below). Never asks the node | Liveness. It is the image's own health check, so `docker compose ps` shows `healthy`. And which build is running: after an upgrade, `revision` must be the new release's commit |
| `/readyz` | `200` when every enabled network's node answers RPC with our credentials and its Electrum connection is up, `503` otherwise. Per network: `ready`, `rpc` (`ok`, `auth_failed`, `wrong_network` when the node is on another chain, `unreachable` with `rpc_error`, or `pending` before the first check), `rpc_checked_secs_ago`, `electrum`, `tip_height`, and `tip_age_secs`, how old the newest block we know of is by its timestamp. Then four that do not count towards `ready`: `lightning`, the Lightning peer's state (`off`, `starting`, `syncing`, `synced` once its pages answer, `failed` when the peer stopped or its synced graph cannot be indexed, `stopped`); `address_index` (`on`, `off`, or `unknown` until the node has answered); `store` (`ok`; `waiting` until a check has found the node on this network's chain, and while it is on another, since nothing is written then; `failing` while SQLite refuses writes; `wrong_chain` when the file belongs to another chain; `open_failed`; or `off` without `DATA_DIR`); and `store_written_secs_ago`, since a write last committed (`null` before the first) | Readiness: a load balancer or monitor deciding whether to send users here. A syncing node shows as a growing `tip_age_secs`. Alert on `address_index` `off` and `store` other than `ok` too |

```sh
curl -s http://127.0.0.1:8080/readyz
```

`/readyz` costs the node nothing per request: it reads the Electrum client's state and the last RPC check, which each network makes at startup and every 30 seconds. The address index is asked once the Electrum connection is up and again after every reconnect, since the node may come back with other flags: one lookup of a scripthash no script has, about 20 ms of the node's time. Neither route is logged when it passes.

Lightning, the address index and the store are left out of readiness on purpose: the explorer serves blocks, transactions and the mempool without any of them, so a load balancer should keep sending users. Without the index, address pages answer `503`; with the store failing, the pages still answer from the node and from memory, but history (block rows, audits, the mempool chart, replacements) stops being recorded until writes commit again. Watch the three fields, or their log events, instead. `/app/lightning/status` says when the Lightning pages have data.

**What the two routes tell a client,** since they answer anyone the proxy lets through: the version and commit, which name public source code an attacker could read anyway and save an operator guessing which build runs; and the labels above, each a state, never a reason. Why the RPC failed, SQLite's message, file paths and the node's addresses stay in the log ([`SECURITY.md`](SECURITY.md) rule 17). Hide both routes in the proxy if even that is too much.

**The revision** comes from the build: the image's build argument `SOURCE_REVISION` (the release workflow passes the commit it builds, the same commit as the image's `org.opencontainers.image.revision` label), else `git` when building from a checkout, else `unknown`, as from a source archive. Uncommitted changes are not marked. Compare the two:

```sh
docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/smolcars/rbitcoin-space:0.1.0
curl -s http://127.0.0.1:8080/healthz
```

The compose file adds no health check of its own and restarts on exit, not on health. The usual reason for not being ready is the node, which can take hours to sync, and restarting the server would not help.

## TLS and the reverse proxy

Put a reverse proxy on the host in front of `127.0.0.1:8080`, [one in a container](#a-proxy-in-a-container), or [a Cloudflare Tunnel](#behind-a-cloudflare-tunnel). Three things matter, and each is easy to get wrong:

1. **Compress `/api` and `/app` answers in the proxy.** The server does not compress what it computes; only the frontend's files come precompressed. Uncompressed, a list of blocks is about four times larger on the wire.
2. **Tell the server who the client is**, or every visitor shares the proxy's rate limits. The server reads the client's address from a header only when you name the header and the proxy's address ([below](#client-addresses)); until then it ignores the header, so a client cannot choose its own address ([`SECURITY.md`](SECURITY.md) rule 7).
3. **Serve it over HTTPS, on the same origin as the WebSocket.** Browsers switch some features off on plain HTTP anywhere but `localhost`, the clipboard API among them (the copy buttons fall back to an older way there), and anything on the path can read or change the pages. And `/app/ws` refuses an upgrade whose `Origin` is not the page's own host and port, so the proxy must pass the browser's `Host` through unchanged ([`SECURITY.md`](SECURITY.md) rule 21).

### Caddy

[Caddy](https://caddyserver.com/docs/install) gets and renews the certificate itself, proxies WebSockets and passes `Host` through by default. The whole site:

```caddyfile
explorer.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Real-IP {remote_host}
	}
}
```

- `encode` compresses `application/json` and the other text types, and leaves the frontend's precompressed files alone.
- `header_up X-Real-IP {remote_host}` overwrites whatever `X-Real-IP` the client sent with the address Caddy saw.

This was tested with Caddy 2.11.9, with a certificate from a file in place of an automatic one (`tls cert.pem key.pem` inside the site block).

### Any other proxy

It must:

| Do | Why | nginx, for example (not tested here) |
|---|---|---|
| Terminate TLS and redirect HTTP to HTTPS | [Point 3](#tls-and-the-reverse-proxy) | `listen 443 ssl`, `return 301 https://$host$request_uri` |
| Forward every path unchanged, every network prefix included | The app, `/api`, `/app` and `/signet/…` are one site | `location / { proxy_pass http://127.0.0.1:8080; }` |
| Pass `Host` as the browser sent it, port included | The WebSocket origin check compares `Origin` with it | `proxy_set_header Host $http_host;` |
| Upgrade WebSockets on `/app/ws` and `/api/v1/ws`, under every prefix | Live blocks, mempool and followed transactions | `proxy_http_version 1.1;` and the `Upgrade` and `Connection` headers |
| Keep an idle WebSocket open for at least 60 s | The server pings a quiet socket every 30 s (`WS_IDLE_TIMEOUT_SECS`) | `proxy_read_timeout` is 60 s by default |
| Overwrite the client-address header, or append to `X-Forwarded-For` | [Client addresses](#client-addresses) | `proxy_set_header X-Real-IP $remote_addr;` |
| Compress `application/json` | [Point 1](#tls-and-the-reverse-proxy) | `gzip on; gzip_types application/json;` |
| Accept request bodies of 1 MB | A broadcast transaction may be 800,000 hex characters ([`API.md`](API.md#broadcast)) | `client_max_body_size` is 1 MB by default |

A CDN in front must also honour the server's `Cache-Control` headers: confirmed blocks are cacheable for long, live answers are `no-store`. A page's head names that page for link previews, so a cache in front must key pages on the whole URL, query string included, as caches do by default ([`FRONTEND.md`](FRONTEND.md#link-previews)).

### Client addresses

Once the proxy runs, tell the server two things in `.env`: the header the proxy writes, and the address the proxy's connections arrive from **as the server sees them**, inside its container. That is not `127.0.0.1`: a proxy on the host reaches the published port through the compose network's gateway. Find it:

```sh
docker network inspect rbitcoin-space_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

A worked example. The command printed `172.18.0.1`, and Caddy writes `X-Real-IP` as above. Add to `.env`:

```sh
TRUSTED_PROXY_HEADER=X-Real-IP
TRUSTED_PROXIES=172.18.0.1
LOG_CLIENT_ADDR=true                       # only while you check; it is off for privacy
```

and apply it with `docker compose up -d`. Now load the site from your own machine and look at the `client` in the server's log:

```sh
docker compose logs --no-log-prefix server | grep '"http_request"' | tail -n 3
```

It must be your own address. If it is the gateway, the server is not reading the header: check both settings. The server says so too: a `proxy_header_ignored` warning at the first request whose header it ignored, naming in `peer`, while `LOG_CLIENT_ADDR` is on, the address `TRUSTED_PROXIES` is missing. Then remove `LOG_CLIENT_ADDR` and run `docker compose up -d` again.

How the address is found, `X-Forwarded-For` and chains of proxies are in [`CONFIG.md`](CONFIG.md#client-addresses). Two cautions:

- Docker may give the network another subnet when it is recreated, after `docker compose down`, and then every visitor shares the new gateway's allowance. Check the gateway again after one, and watch for `proxy_header_ignored`.
- A proxy in a container arrives from its own container address, not the gateway: [below](#a-proxy-in-a-container).
- Anything on the host that connects to the published port comes from the same gateway and is trusted like the proxy. That is why the port stays on loopback: the host is part of the proxy's trust. Never trust a range that clients can connect from.
- **A published port may not pass on anyone's address.** Observed on 2026-11-14 on a Linux host (Docker Engine 28, Ubuntu 24.04) with the server's port published on specific host addresses: **every** connection to it reached the server from the compose network's gateway, from clients on the LAN, from clients over a VPN interface, and from a reverse proxy on another machine forwarding to the port. Why was not found. On a Mac (OrbStack, Docker Engine 29.8.2) we tested the same on 2026-11-14: a connection from the host and one from a container on another network both arrived from the gateway. On such a host, all clients of the port share one allowance, and a proxy forwarding to it cannot be told apart from a direct client. **Never trust the gateway when the port is reachable from anywhere but this host:** anyone who can reach the port could then choose their address with the header. Leave the gateway untrusted, so that every client through the port shares one allowance (what the deployment did), or run every public proxy as a container on the `edge` network ([below](#a-proxy-in-a-container), or [a tunnel](#behind-a-cloudflare-tunnel)) and trust only its pinned address. To see which host you have: with `LOG_CLIENT_ADDR=true`, load a page from another machine and read the `client` of its `http_request`; the gateway there means the port hides addresses. A proxy that sends a forwarding header to an untrusted port is also named by `proxy_header_ignored`, its `peer` the gateway.

### A proxy in a container

When Caddy or nginx runs as a container beside the server, the server's peer is the proxy's own address on the network they share, not the gateway, and nothing is published on the host for the server. Docker gives a container whatever address is free when it starts, so trusting it as it happens to be goes stale: after `docker compose down` with another network created meanwhile, the network comes back on another subnet, the proxy arrives from an address the server does not trust, and every visitor shares one allowance (`proxy_header_ignored` names the new address while `LOG_CLIENT_ADDR` is on). [`deploy/compose.proxy.yml`](../deploy/compose.proxy.yml) pins it instead: a network, `edge`, holding only the proxy and the server, a fixed subnet, and the proxy at `172.30.111.2`, an address Docker gives no other container. It also removes the server's published port.

Next to `compose.yml`, write a `Caddyfile` that proxies to the server by its service name:

```caddyfile
explorer.example.com {
	encode zstd gzip
	reverse_proxy server:8080 {
		header_up X-Real-IP {remote_host}
	}
}
```

add the proxy to `.env`:

```sh
TRUSTED_PROXY_HEADER=X-Real-IP
TRUSTED_PROXIES=172.30.111.2
```

and start everything with both files:

```sh
docker compose -f compose.yml -f compose.proxy.yml up -d
```

Every later command needs both `-f` flags, or compose leaves the proxy out. Caddy keeps its certificates in the `proxy-data` volume. If `172.30.111.0/29` overlaps a network the host already has, compose refuses to start: change the subnet, the `ip_range` and the address in `compose.proxy.yml`, and `TRUSTED_PROXIES`, together. Do not trust the network's gateway here, as for a proxy on the host: the proxy does not come from it, and the host does.

Tested on 2026-11-13 with Caddy 2.11.9, plain HTTP in place of a certificate, and visitors as containers on a network of their own that only the proxy joined:

- Two visitors had separate limits: one sent 800 requests back to back and got `429` for 616 of them, while the other got `200` at the same moment. The server logged each by its own address.
- A visitor that sent `X-Real-IP` and `X-Forwarded-For` naming another address was logged under its own: Caddy overwrites the first, and the server does not read the second.
- A container on the node's network that went straight to the server with `X-Real-IP` was keyed on its own address, with `proxy_header_ignored`.
- With `TRUSTED_PROXIES` set to the `edge` gateway, the server saw the proxy at `172.30.111.2`, ignored the header, and warned.
- The pinned address held when the proxy was recreated, and after `docker compose down`, another network created, and `up`. Without the pin, recreating the proxy happened to keep its address, but `down`, another network and `up` moved it to another subnet, as described above.
- Responses were compressed (`zstd`) and `/regtest/app/ws` upgraded (`101`) through it.

Not tested: how the published ports 80 and 443 pass the visitor's address to Caddy. They may not: on the host [above](#client-addresses) every connection to a published port arrived from the gateway, and Caddy would then write the gateway into `X-Real-IP` for every visitor, so all would share one allowance (none could choose another's address). Check it as above: the server's `client` must be your own address, not the `edge` gateway `172.30.111.1`. The test above used containers as visitors for that reason. Nor IPv6 visitors to an IPv4 network, whom Docker may forward through its own userland proxy, with the same effect. [A tunnel](#behind-a-cloudflare-tunnel) publishes no port and has neither problem.

### Behind a Cloudflare Tunnel

`cloudflared` runs as a container beside the server and dials out to Cloudflare; Cloudflare's edge holds the certificate for your hostname and sends each request down that connection. Nothing is published on the host and no port is opened on the router, so neither [published-port caution](#client-addresses) applies. The first public deployment ran this way on 2026-11-14, with a locally managed tunnel and the free plan.

**The trade:** Cloudflare terminates TLS. It sees every page, block, transaction and address a visitor looks up, and the visitor's address, and it could change what it serves. A proxy of your own sees the same and nobody else does, but needs a published port.

**You need** a Cloudflare account, and your domain's DNS hosted at Cloudflare: add the domain there and change its nameservers at the registrar. The registration stays where it is.

**Create the tunnel** on any machine with [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and a browser, not necessarily the server:

```sh
cloudflared tunnel login                                    # writes ~/.cloudflared/cert.pem
cloudflared tunnel create explorer                          # prints the tunnel's id, writes ~/.cloudflared/<id>.json
cloudflared tunnel route dns explorer explorer.example.com
cloudflared tunnel route dns explorer www.explorer.example.com   # only if you serve a www name too
```

`<id>.json` is the tunnel's credentials file: whoever holds it can run the tunnel and answer for your hostname. Move it to the server's host, next to `compose.yml`, readable by the container's user (65532) alone:

```sh
mkdir -p cloudflared
mv <id>.json cloudflared/credentials.json
sudo chown 65532:65532 cloudflared/credentials.json && sudo chmod 400 cloudflared/credentials.json
```

`cert.pem` is the account's login for managing tunnels, not needed to run one: leave it off the server.

**Write `cloudflared/config.yml`:**

```yaml
# The id `cloudflared tunnel create` printed (not a secret), and the credentials file.
tunnel: <id>
credentials-file: /etc/cloudflared/credentials.json
ingress:
  # One rule per hostname routed to the tunnel, each to the server on the edge network.
  - hostname: explorer.example.com
    service: http://server:8080
  - hostname: www.explorer.example.com
    service: http://server:8080
  # Any other hostname. cloudflared refuses a config whose last rule is not a catch-all.
  - service: http_status:404
```

`cloudflared` passes the browser's `Host` through unchanged, which the WebSocket origin check needs ([point 3](#tls-and-the-reverse-proxy)). Check the file without an account:

```sh
docker compose -f compose.yml -f compose.tunnel.yml run --rm --no-deps tunnel \
  tunnel --config /etc/cloudflared/config.yml ingress validate             # OK
```

**Tell the server** in `.env`:

```sh
TRUSTED_PROXY_HEADER=X-Forwarded-For
TRUSTED_PROXIES=172.30.111.2
```

and start everything with [`deploy/compose.tunnel.yml`](../deploy/compose.tunnel.yml), which adds the tunnel on the pinned `edge` network as [`compose.proxy.yml`](#a-proxy-in-a-container) adds Caddy, with the same hardening and the image pinned by digest, and removes the server's published port:

```sh
docker compose -f compose.yml -f compose.tunnel.yml up -d
```

Every later command needs both `-f` flags. Use this file or `compose.proxy.yml`, not both: they pin the same address. Then, in Cloudflare's dashboard, switch on **Always Use HTTPS** (SSL/TLS, Edge Certificates): until then `http://` answers `200`, with the page in the clear ([point 3](#tls-and-the-reverse-proxy)).

**Which header.** `X-Forwarded-For` is the one to use, because it is the one checked. Cloudflare appends the visitor's address to whatever `X-Forwarded-For` the client sent; the server walks the header from the right and takes the first address that is not a trusted proxy, Cloudflare's entry, so a client's own header is harmless ([`CONFIG.md`](CONFIG.md#client-addresses)). It also keeps working if you later put a proxy of your own between the tunnel and the server: list both in `TRUSTED_PROXIES`. `CF-Connecting-IP`, which Cloudflare sets to the visitor's address alone, would work as well with the same `TRUSTED_PROXIES`; nobody has tried it here.

**Check the addresses** as the deployment did: with `LOG_CLIENT_ADDR=true`, load the site and compare the `client` of your request in the server's log with the `ip=` line of `https://explorer.example.com/cdn-cgi/trace`, Cloudflare's own view of you, from the same browser. An IPv4 address must be equal; an IPv6 one is logged as its `/64` ([`CONFIG.md`](CONFIG.md#logging)), so the first four groups must match. Then remove `LOG_CLIENT_ADDR`.

Observed in the deployment on 2026-11-14, free plan, with nothing configured in Cloudflare but the tunnel, its DNS records and Always Use HTTPS:

| | Observed |
|---|---|
| Client addresses | `X-Forwarded-For` with the tunnel's pinned address trusted: each visitor keyed by their own public address, as `/cdn-cgi/trace` reported it |
| Compression | `/api` JSON arrived `content-encoding: br`: [point 1](#tls-and-the-reverse-proxy) is met with no setting |
| Caching | API answers were not cached (`cf-cache-status: DYNAMIC`); the frontend's immutable files were |
| WebSockets | `/app/ws` and `/api/v1/ws` upgraded (`101`) |
| HTTPS | `http://` answered `200` until Always Use HTTPS was on |

Not observed: whether Cloudflare's bot protection challenges script clients of `/api`; how long Cloudflare keeps an idle WebSocket open (the server pings a socket quiet for half of `WS_IDLE_TIMEOUT_SECS`, checked every quarter of it, so 30 to 45 s by default: an idle limit of at least `WS_IDLE_TIMEOUT_SECS` is enough, as for [any other proxy](#any-other-proxy)); a request body near 1 MB, as a large broadcast sends.

Tested here on 2026-11-14, without a Cloudflare account: `docker compose -f compose.yml -f compose.tunnel.yml config -q` with `.env.example` (the [release workflow](CI.md#releases) runs it too); and in the container that file defines, read-only with no capabilities, `cloudflared` 2026.11.0 accepted the config above (`ingress validate`), matched both hostnames to the server and any other to `404` (`ingress rule`), and refused the config without its last rule. The deployment ran an equivalent service, not this file; nobody has run this file against a live tunnel.

### Check it

From any machine, against your domain:

```sh
curl -s -o /dev/null -H 'Accept-Encoding: zstd, gzip' -w '%{http_code} %header{content-encoding}\n' \
  https://explorer.example.com/api/blocks                  # 200 zstd: compressed
curl -s -o /dev/null --max-time 3 -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://explorer.example.com' \
  https://explorer.example.com/app/ws                      # 101: the WebSocket upgrades
```

The second prints `101` and then waits until `--max-time`, because the socket stays open. A `403` there means the proxy changed `Host` ([below](#when-it-goes-wrong)). Behind Cloudflare, put `br` in `Accept-Encoding`: the deployment's answers came `br`.

## The data directory

The server keeps one SQLite file per network, `<network>.sqlite`, with `-wal` and `-shm` beside it while it runs. In the compose setup it is the `rbitcoin-space_server-data` volume, mounted at `/data`. It holds only what the server derived or observed, never a copy of what the node stores ([`STORE.md`](STORE.md)):

| Kept | Rebuilt if lost |
|---|---|
| One row per block: totals, fee rates, miner | Yes, by the backfill |
| Block audits: what we expected against what was mined | No: observed as each block arrived |
| Mempool history, a sample a minute, rolled into hours and days | No |
| The replacement record: what replaced what, and when it was first seen | No |
| With Lightning on: the record of channels opened and closed, and in `lightning/<network>/` the peer's node key and graph | The graph by a fresh sync of a few minutes; the closed channels no |

So deleting it costs the backfill's time, and loses for good the audits, the mempool chart's past and the replacement history. The node is untouched either way.

**Size on mainnet:** 547 MB [measured](#one-day-on-mainnet) once the backfill was done and a day had been recorded. Estimated by table: the block table about 220 bytes a block, about 215 MB for the whole chain; audits about 150 MB a year; the mempool history under 3 MB, and the replacement record about 2 MB. The write-ahead log can add up to 64 MB. The measured file is larger than those add up to; it was not split by table.

**Back it up while it runs** with SQLite's own backup, from a throwaway container (the image has no shell or `sqlite3`):

```sh
mkdir -p backup
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/backup":/backup alpine:3 \
  sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -readonly /data/mainnet.sqlite ".backup /backup/mainnet.sqlite"'
```

It is a consistent copy from one read snapshot, and the server keeps writing meanwhile. Copying the `.sqlite` file alone while the server runs can give a corrupt copy, because recent writes live in the `-wal` file.

**Restore** with the server stopped, removing the old `-wal` and `-shm`:

```sh
docker compose stop server
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/backup":/backup:ro alpine:3 \
  sh -c 'rm -f /data/mainnet.sqlite-wal /data/mainnet.sqlite-shm && cp /backup/mainnet.sqlite /data/ && chown 65532:65532 /data/mainnet.sqlite'
docker compose start server
```

**Seed it from another instance** to skip the backfill: about 18 hours for mainnet's block totals ([measured](#one-day-on-mainnet)), and the audits, mempool history and replacements the other instance recorded come along, which no backfill rebuilds. Worth it when you move the explorer to a new host, or start a second one, with an instance that has caught up. On the instance you copy from, beside its compose file, take each network's file with SQLite's backup, and the Lightning graph without its node key:

```sh
mkdir -p seed
for net in mainnet signet testnet4; do
  docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/seed":/seed alpine:3 \
    sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 -readonly /data/$net.sqlite '.backup /seed/$net.sqlite'"
done
docker run --rm -v rbitcoin-space_server-data:/data:ro -v "$PWD/seed":/seed alpine:3 \
  sh -c 'mkdir -p /seed/lightning/mainnet && cp -p /data/lightning/mainnet/graph /data/lightning/mainnet/verified /seed/lightning/mainnet/'
```

Copy `seed/` to the new host and, before the server's first start there, into its volume, owned by the image's user:

```sh
docker compose up --no-start                # creates the volume
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/seed":/seed:ro alpine:3 \
  sh -c 'cp -Rp /seed/. /data/ && chown -R 65532:65532 /data'
docker compose up -d
```

- List only the networks you run, and leave out the Lightning line without Lightning. The volume is `<project>_server-data` in [another compose project](#the-node-in-another-compose-project).
- `cp -p` keeps the graph's modification time, which records when it was last caught up.
- The node key (`node_key`) stays behind: it is the old instance's identity to the Lightning nodes it dials, and the new one makes its own on first start.
- Each file records its chain, so a file from another network's node is refused (`store_open_failed`, [below](#when-it-goes-wrong)). A file from a newer release is refused too; one from an older release is migrated forward ([upgrading](#upgrading)).
- It worked: `block_backfill_progress` with `totals_done` and `rates_done` both `true` in the first second means there is nothing to backfill.

Observed in the deployment on 2026-11-14: the three networks' files and the graph, copied this way into the new volume, were accepted, and the first `block_backfill_progress` already had both `true`. We ran the commands above on 2026-11-14 with small stand-in files: the copies opened, passed `integrity_check`, kept the graph's time and were owned by 65532.

## The first start

On its first start with an empty store the server runs the **backfill**: it fills the block table from the node, newest blocks first, with every block's totals and the last year's fee rates. The table is its progress, so it resumes where it stopped after any restart.

- **How long.** On mainnet at the default pace, about 19 hours [measured](#one-day-on-mainnet) for every block's totals and a year of fee rates, on a node with the block listing route; through `getblock` on rbitcoin v0.9.2, which lacks it, the year of fee rates is estimated at about another day. The numbers, and what the measured run included, are in [`STORE.md`](STORE.md#backfill), which owns them.
- **What it reads.** On a node with the listing route, about 18 GB for every block's totals and the year's fee rates, as estimated and as the measured run read once it used the route; through `getblock` the fee rates are estimated at 550 GB. The node does that work, so a node on the same host matters here.
- **Gentler.** `BACKFILL_BUSY_PERCENT` (default 50) is the share of time its one call keeps the node busy; lower is gentler and slower. `BACKFILL_FEE_RATE_DEPTH` (default 52560, a year) is how far back fee rates go; `0` skips them, and the block facts route then computes older blocks' rates on demand.
- **Pause it** with `BACKFILL_ENABLED=false` in `.env` and `docker compose up -d`; set it back to resume. All three are in [`CONFIG.md`](CONFIG.md#block-table).
- **Progress** is a `block_backfill_progress` line every minute while it writes rows, and a last one when it has caught up: `rows` and `rated` against `tip`. A line without them means the count timed out; the next one that has them shows the real change.

Meanwhile the site works: blocks, transactions and addresses come from the node, the newest 100 rows follow the tip from the start, and mining charts and lists cover the rows filled so far, saying where their history starts. The mempool chart starts empty and fills a minute at a time; block audits start with the first block the server watches arrive.

## After a restart

Every later start finds its store and graph and needs no backfill, but a few things take a moment. Observed in the deployment on 2026-11-14:

- **Fee routes** answer `503` `not ready yet; retry` for some seconds, until the first fee answer is computed. `fees_fallback_started` with `warming_up` follows every start, and the first `fees_summary`, a minute in, names the `source` being served. What each route answers while warming up is in [`API.md`](API.md).
- **The Lightning pages** take up to a minute, in three steps: `lightning_started` with `graph` `loaded` (the graph read from disk, `load_ms`), `lightning_synced` with `from_disk` (caught up with its peers), then `lightning_index_built`, from which the node, channel and search routes answer and `/readyz` `lightning` turns from `syncing` to `synced`. A restart [measured](#one-day-on-mainnet) on 2026-11-13 loaded the graph in 62 ms and synced in 20 s.
- **Everything else** answers as soon as the node does: `/readyz` is `200` once each network's RPC check and Electrum connection have succeeded.

## Watching it

### The log

The server writes one JSON object per line to stdout: `ts`, `level`, `event`, then the event's fields. Every event is listed in [`LOGGING.md`](LOGGING.md). Docker keeps it; the compose file uses the `local` logging driver, which rotates it. Read it with:

```sh
docker compose logs --no-log-prefix server | jq -c 'select(.level != "info")'
```

**A healthy minute**, with no visitors, is one `mempool_summary` and one `fees_summary` per network (and one `block_backfill_progress` while a backfill writes), a `tracking_summary` per network that saw a replacement, a `lightning_summary` with Lightning on, then `block_audited`, `mempool_block`, `difficulty_computed` and two to four `ws_fanout` lines when a block arrives, and one `http_request` per request served. [Measured](#one-day-on-mainnet) with three networks and Lightning, that was 11 lines a minute and 6.1 MB a day, and two `warn` lines (`mempool_poll_failed` with `timeout`) in five and a half hours (`LOG_REQUESTS=failures` keeps only those answered with an error). Requests refused by a limit are not lines of their own: they are counted in one `requests_refused` a minute, whatever `LOG_REQUESTS` says ([`LOGGING.md`](LOGGING.md#for-operators)). Nothing at `warn` or `error`. In the first seconds after a start, `electrum_unreachable`, `mempool_poll_failed` and `block_rows_failed` are normal while the node comes up, and `fees_fallback_started` (`info`) with `warming_up` means our fee recommendations are not served yet: for five minutes, nothing in the first and then the node's estimates, capped ([`MEMPOOL.md`](MEMPOOL.md#while-warming-up)). A reorg is `chain_reorg` and `block_rows_reorged` at `info`: testnet4 has several a day.

**Alert on:**

| Event or check | Means |
|---|---|
| Any `error`: `config_invalid`, `listen_failed`, `rpc_auth_failed`, `rpc_wrong_network`, `store_open_failed`, `store_wrong_chain`, `panic` | Act now; each is in [When it goes wrong](#when-it-goes-wrong) |
| `store_read_failed` | A read the store refused; `read` names which (`lightning_index` is the Lightning pages' index) and `error` why, as for writes. Pages that need it fail or fall back to the node meanwhile |
| `lightning_index_failed`, or `/readyz` `lightning` `failed` | The Lightning pages answer `503`: the peer stopped, or its synced graph cannot be indexed. `stage` and `error` say why; a `store_read_failed` with `lightning_index` beside it has SQLite's message |
| `store_write_failed`, or `/readyz` `store` not `ok` | History is not being recorded. `failing`: SQLite refuses writes, and `error` says why (`disk_full`, `read_only`, `corrupt`, `busy`, `io`). `waiting` for more than a minute: the node is unreachable or on another chain, or `store_chain_unverified` says an older file cannot be checked yet |
| `address_index_off`, or `/readyz` `address_index` `off` | The node runs without `--sh-index`: address pages are down |
| `/readyz` not `200` for more than a few minutes | The node is down, unreachable or refusing our password |
| `tip_age_secs` in `/readyz` over two hours on mainnet | The node has stopped following the chain |
| `rpc_unreachable`, `electrum_unreachable`, `mempool_poll_failed`, `block_rows_failed` repeating | The node is failing or overloaded. They are logged at the 1st, 2nd, 4th, 8th… in a row, so a rising count is a long outage |
| `store_slow_write`, `store_read_timed_out`, `replacements_store_failed`, `mempool_history_skipped` with `store_failed` | The disk is slow or full, or the machine is overloaded: the read limit is wall-clock time, so a host that stalls for two seconds trips it even on a read that takes milliseconds ([`STORE.md`](STORE.md#using-it)) |
| `proxy_header_ignored` | Behind a proxy: the server does not trust it, so every visitor shares one allowance ([client addresses](#client-addresses)) |
| `connections_refused` | One address is holding many connections |
| `accept_failed` | The server is out of file descriptors and not accepting anyone ([many WebSockets](#many-websockets)) |
| `requests_refused` every minute | Something is being refused: one address flooding, or a proxy set up wrong. Its fields tell which ([`LOGGING.md`](LOGGING.md#refusals)) |
| `log_events_dropped` | Request lines were dropped: `queue_full`, the output (a disk, a pipe) cannot keep up; `over_budget`, the site served more than the log's ceiling ([`LOGGING.md`](LOGGING.md#for-operators)) |

### Memory and CPU

`docker stats` shows both. The figures to expect are [above](#the-host); memory grows with open WebSockets and the block summary cache, not with time.

## Upgrading

**Tags.** Each release is published once as `ghcr.io/smolcars/rbitcoin-space:X.Y.Z`, never moved, and as `latest`, which moves to the newest release. Pin `X.Y.Z` in `SERVER_IMAGE`; `latest` would upgrade the store whenever compose pulls. Every image is for linux/amd64 and linux/arm64 and carries a signed record of the commit and workflow that built it:

```sh
gh attestation verify oci://ghcr.io/smolcars/rbitcoin-space:0.1.0 --repo smolcars/rbitcoin-space
```

**Images of `master`.** Every merge to `master` that changes the image is published too, as `sha-<full commit>`, never moved, and `master`, which moves to the newest such merge and never back. They have passed the same checks and carry the same attestation, but no release notes and no promise about what changed: a release is what to run, and a `master` image is for trying a change before it is released. Its `version` label is the one in `Cargo.toml`, not a release. To run one, pin it by digest, so a pull never changes it under you:

```sh
skopeo inspect --raw docker://ghcr.io/smolcars/rbitcoin-space:master | sha256sum   # the index digest
echo "SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space@sha256:<digest>" >> .env
```

`docker buildx imagetools inspect ghcr.io/smolcars/rbitcoin-space:master` prints the same digest, and the `org.opencontainers.image.revision` label names the commit. The compose file and `.env.example` come from a checkout of that commit. Moving between a `master` image and a release is an upgrade like any other: back up first, since the store's migrations are one-way (below).

**Following `master`.** A release is still the default. If you choose to run ahead of releases, move from one `master` image to the next the same way each time: back up, put the new digest in `SERVER_IMAGE`, then replace the server alone and check that the new commit runs:

```sh
docker compose pull server
docker compose up -d --no-deps server
curl -s https://explorer.example.com/healthz           # revision: the commit of the image you pinned
```

`--no-deps` keeps compose from starting, or recreating, the services the server depends on. It matters most where the node is in the [same project](#the-node-in-another-compose-project): a node recreated by accident stops for its flush and restarts. The deployment updated this way on 2026-11-14.

**Migrations run by themselves and are one-way.** A new release may add tables to the store; it applies them at start, each once, and logs a `store_migration_applied` line for each. An older release refuses a store a newer one has migrated: `store_open_failed`, and that network runs without a store. So **back up before upgrading**.

To upgrade, read the release's notes, then:

```sh
VERSION=0.2.0
git fetch --depth 1 origin tag "v$VERSION" && git checkout "v$VERSION"
mkdir -p backup                             # then the backup command above
sed -i.bak "s|^SERVER_IMAGE=.*|SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space:$VERSION|" .env && rm .env.bak
docker compose up -d
docker compose logs --no-log-prefix server | grep store_migration_applied
```

Run them from `deploy/`. If the server then stops with `config_invalid`, the new release refuses a setting the old one accepted: the line names it, and the release notes say what changed. It stops before it opens the store, so nothing is migrated until the setting is fixed. Checking out the tag also brings that release's compose file, which may pin a newer rbitcoin; compose then recreates the node too, and the node flushes its state on the way down (it has five minutes).

**Rolling back:** if the new release logged `store_migration_applied`, the old one cannot open the store. Started on it, it logs `store_open_failed` (`database schema version … is newer than this build supports …`) and serves without a store: `/readyz` stays `200` with `store` `open_failed`, and the mining pages and history answer `503`. So restore the backup you took before the upgrade while the server is stopped, and start it again only on the old image (`docker compose start` would restart the new one, which migrates the backup again):

```sh
VERSION=0.1.0                               # the release you go back to
docker compose stop server
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/backup":/backup:ro alpine:3 \
  sh -c 'rm -f /data/mainnet.sqlite-wal /data/mainnet.sqlite-shm && cp /backup/mainnet.sqlite /data/ && chown 65532:65532 /data/mainnet.sqlite'
git fetch --depth 1 origin tag "v$VERSION" && git checkout "v$VERSION"
sed -i.bak "s|^SERVER_IMAGE=.*|SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space:$VERSION|" .env && rm .env.bak
docker compose up -d
```

What the server observed between the backup and the rollback (audits, mempool history, replacements) is lost. Without a backup, delete `mainnet.sqlite` instead: the old release starts empty and backfills again. Without a migration, only the image changes.

## Switching features

All of these are in [`CONFIG.md`](CONFIG.md); change `.env` and run `docker compose up -d`.

- **Broadcast:** `BROADCAST_ENABLED=false` turns off `POST /api/tx`, the only write the server makes to the node.
- **The live mempool,** per network: `MAINNET_MEMPOOL_ENABLED=false` stops the mempool tracker, projected blocks, fee recommendations of our own, mempool history and block audits for that network. Blocks and everything else keep working, and the node is spared about 150 MB a minute of RPC on mainnet.
- **Limits** (rate limits, WebSocket caps, timeouts) have safe defaults derived from what the pages load ([`CONFIG.md`](CONFIG.md#limits)). Raise the per-client ones if many of your users share one address.

### Lightning

Off unless `MAINNET_LIGHTNING_ENABLED=true` is in `.env` ([`CONFIG.md`](CONFIG.md#lightning)). Switched on, the server **connects out to public Lightning nodes** (the defaults on TCP port 9735, at addresses in [`LIGHTNING.md`](LIGHTNING.md#peers)) and keeps three connections open. Nothing is published or listened on: the compose file needs no change, and the default bridge network lets the container connect out. Behind a firewall that filters outbound traffic, allow TCP to the peers' addresses, or list peers you can reach in `MAINNET_LIGHTNING_PEERS`. The peer does not speak Tor: under a Tor-only egress policy, leave it off or point it at a clearnet node of your own.

It keeps a 32-byte node key, its graph and the answers it saved so a restart need not ask the node again (35 MB together, [measured](#one-day-on-mainnet) with 36,200 channels) in `/data/lightning/mainnet/` on the `server-data` volume, beside the SQLite file that holds its history. The key is created on first start, readable by the server's user only; it identifies the peer to the nodes it dials and holds no funds. Deleting the directory costs a fresh sync (273 s and 56 MB of gossip, measured; a restart from the files took 20 s); deleting the SQLite file loses the record of closed channels ([`STORE.md`](STORE.md#ln_channels)). Memory: plan for 250 to 330 MB more with Lightning on (measured in [`LIGHTNING.md`](LIGHTNING.md#measured-in-the-server)).

### Add a network

The compose file runs one node. For a second network, add a node service with its own name, volumes and network, and give the server that network's six variables. For signet beside mainnet, in `compose.yml`:

```yaml
services:
  signet:
    # Everything from `node`, with these differences:
    command:
      - --network=signet
      - --sh-index
      - --listen=0.0.0.0:38333
      - --rpc-listen=0.0.0.0:8332
      - --rpc-cookie-file=/run/secrets/rpc-cookie
      - --electrum-listen=0.0.0.0:50001
      - --esplora-listen=/run/esplora/esplora.sock
    ports: ["38333:38333"]
    volumes:
      - signet-data:/data
      - signet-socket:/run/esplora
  server:
    volumes:
      - esplora-socket:/run/esplora:ro
      - signet-socket:/run/signet:ro

volumes:
  signet-data:
  signet-socket:
    driver_opts: { type: tmpfs, device: tmpfs, o: "uid=10001,gid=10001,mode=0750" }
```

and in `.env`:

```sh
SIGNET_RPC_HOST=signet
SIGNET_RPC_PORT=8332
SIGNET_RPC_USER=rbitcoin-space
SIGNET_RPC_PASSWORD=…                     # the same as in rpc.cookie, or give signet its own secret
SIGNET_ESPLORA_URL=/run/signet/esplora.sock
SIGNET_ELECTRUM_ADDR=signet:50001
```

The server serves it under `/signet` ([`ARCHITECTURE.md`](ARCHITECTURE.md#networks)). P2P ports: mainnet 8333, signet 38333, testnet4 48333, regtest 18444.

## Security checklist

From [`SECURITY.md`](SECURITY.md), for the operator:

- [ ] The node's RPC, Esplora and Electrum are reachable by the server only: on the compose network and the socket, or a private network. Only P2P is published.
- [ ] The server's port is on loopback (`HTTP_PUBLISH` unchanged) and reached only through the proxy, or, with the [proxy in a container](#a-proxy-in-a-container) or [a tunnel](#behind-a-cloudflare-tunnel), not published at all.
- [ ] The site is served over HTTPS, and HTTP redirects to it. Behind Cloudflare, Always Use HTTPS is on: `curl -sI http://explorer.example.com/` must not answer `200`.
- [ ] `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXIES` are set only once the proxy overwrites the header, `TRUSTED_PROXIES` names the proxy's address and nothing clients can reach, and the [check](#client-addresses) showed your own address.
- [ ] The compose network's gateway is not in `TRUSTED_PROXIES` if the server's port is published beyond loopback: a published port can bring every client from the gateway ([client addresses](#client-addresses)).
- [ ] `LOG_CLIENT_ADDR` is off, unless you mean to keep a record of who looked at what.
- [ ] `.env` and `rpc.cookie` are readable by their owners only, and the password is long and random.
- [ ] Behind a tunnel: `cloudflared/credentials.json` is mode `400`, owned by 65532, and nowhere else but your backups; `cert.pem` from `cloudflared tunnel login` is not on the server.
- [ ] The limits are at their defaults or raised for a stated reason; none is switched off (none can be).
- [ ] `BROADCAST_ENABLED=false` if you do not want the site to relay transactions.
- [ ] The image is pinned to a version, and you watch the releases for security fixes.

Report a vulnerability privately through [GitHub's security advisories](https://github.com/smolcars/rbitcoin-space/security/advisories/new) on this repository.

## When it goes wrong

Read the log as [above](#the-log) and `/readyz`.

| Symptom | The log says | Do |
|---|---|---|
| The server stops at once | `config_invalid` with the variable's name (never its value) | Fix that variable. A network needs all six of its variables or none ([`CONFIG.md`](CONFIG.md#networks)) |
| Pages load but nothing from the chain; `/readyz` `503` with `rpc` `unreachable` | `rpc_unreachable`, `electrum_unreachable` and `mempool_poll_failed` with `unavailable`, repeating | The node is down or its address is wrong: `docker compose ps`, `docker compose logs node`, then the `*_HOST`, `*_PORT` and `*_ADDR` settings |
| `/readyz` `503` with `rpc` `wrong_network` and `store` `waiting`; pages show another chain's blocks | `rpc_wrong_network` (an `error`) with `network`, the one configured, and `node_chain`, the node's (`main`, `testnet4`, `signet`, `regtest`) | The `{NET}_*` variables point at another network's node, often a `MAINNET_*` line left in `.env` beside a test network's. Fix them and `docker compose up -d`. Nothing was written to the store meanwhile ([`STORE.md`](STORE.md#chain)), so it needs no clean-up. A node repointed while the server ran may have had up to 30 s of its data written before the check noticed |
| The store did not open: `/readyz` `store` `open_failed` | `store_open_failed` with `… was written for another chain (genesis …)` | The file belongs to another network: the data directory was moved, or files were renamed. The hash names the chain: `000000000019d6…` mainnet, `00000008819873…` signet, `00000000da84f2…` testnet4, `0f9188f13cb7b2…` regtest. Move the file out of the volume (keep it, and give it to the right network if you have one) and restart: an empty file is created and the backfill fills it |
| `/readyz` `store` `wrong_chain`; no new mining rows, audits or mempool chart | `store_wrong_chain` (an `error`) with the `height` of a block row the node does not have | A file from an earlier release, before files recorded their chain, holds another chain's blocks, as an earlier release wrote when the variables pointed at the wrong node. Nothing more is written to it. With the server stopped, move it out of the volume, then start: an empty file is created and backfilled |
| `/readyz` `store` stays `waiting` though `rpc` is `ok` | `store_chain_unverified` (a `warn`) with the file's lowest block `height` and the node's `node_height` | A file from an earlier release that cannot be checked yet: the node is more than 100 blocks behind its rows (syncing again from scratch), and writes resume once it has caught up; or the file's rows span fewer than 100 blocks, too few ever to check, so with the server stopped move it out of the volume and start again |
| `/readyz` `503` with `rpc` `auth_failed` | `rpc_auth_failed` (an `error`), then `mempool_poll_failed` with `auth` | The password in `.env` and the one in `rpc.cookie` differ. Make them equal and `docker compose up -d --force-recreate` |
| Address pages show an error; everything else works; `/readyz` `address_index` `off` | `address_index_off` (a `warn`) once Electrum connects, and `http_request` with `status` `503` and `endpoint` `script_stats` or `script_txs` | The node runs without `--sh-index`, which rbitcoin leaves off by default. Turn it on, as the compose file does, and restart the node: the server asks again when it reconnects and logs `address_index_on` |
| Visitors get `429`, on pages they barely used | `proxy_header_ignored` from the first request on; `requests_refused` every minute with `untrusted_forwarded` or `proxy_keyed` close to `total` | Everyone is counted as the proxy: [client addresses](#client-addresses) are not set up (`untrusted_forwarded`: `TRUSTED_PROXIES` is not the address the proxy arrives from; `proxy_keyed`: the proxy does not send the header named in `TRUSTED_PROXY_HEADER`). Check with `LOG_CLIENT_ADDR=true` |
| The disk filled while the server ran: no new mining rows, audits or mempool chart; `/readyz` `store` `failing` | `store_write_failed` with `error` `disk_full` and SQLite's own message, at the 1st, 2nd, 4th… failed write; `block_rows_failed` with `store` beside it | Free space. Nothing needs a restart: the next write that commits logs `store_write_recovered` and `store` is `ok` again. Block rows are retried and filled in; the minutes of mempool history missed meanwhile are a gap |
| The store will not take writes for another reason; `/readyz` `store` `failing` | `store_write_failed` with `read_only` (the volume is mounted read-only or not owned by uid 65532), `corrupt`, `busy` (another process holds the file's lock, such as a long backup) or `io` | `read_only`: fix the mount or ownership, then `docker compose restart server`. `corrupt`: [restore a backup](#the-data-directory) or delete the file. `busy`: let the other process finish |
| The store did not open; `/readyz` `store` `open_failed` | `store_open_failed` with the reason: `database or disk is full`; `unable to open database file`, when uid 65532 cannot write the directory (no volume at `/data`, or a volume another user owns); `cannot create`, when `DATA_DIR` is outside the volume | Fix what it names, then `docker compose restart server`. Docker gives a new, empty volume the image's owner, but a volume that already holds files keeps its own: `docker run --rm -v rbitcoin-space_server-data:/data alpine:3 chown -R 65532:65532 /data` |
| The store stopped after a rollback | `store_open_failed` with `database schema version 5 is newer than this build supports (2)` | An older release cannot open a store a newer one migrated. [Restore the backup](#upgrading) or delete the file |
| Live updates never arrive; the home page does not move | `ws_origin_refused` with the `origin` and `host` it compared | The proxy changes `Host`. Pass it through as the browser sent it, port included |
| Same, but no `ws_origin_refused` | `http_request` with a route ending `/app/ws` and `status` `400`: the request reached the server without its `Upgrade` header | The proxy does not forward the upgrade. See [any other proxy](#any-other-proxy) |
| `docker compose up` or a pull hangs on a host nobody is logged in to | | A Docker credential helper (`credsStore` in `~/.docker/config.json`: a keychain, `pass`, `secretservice`) is waiting for an unlock prompt. The release image needs no login: pull with `DOCKER_CONFIG` pointing at a directory whose `config.json` sets no `credsStore` |
| `docker compose up` fails: `failed to bind host port 127.0.0.1:8080/tcp: address already in use` | Nothing: the server never started | Another program holds the port. Set `HTTP_PUBLISH` to a free one, and point the proxy at it |
| The disk fills with logs | | Logs rotate under the compose file's `local` driver (100 MB a container). A container started another way uses Docker's default `json-file`, which does not rotate |

## Reference: the image

```sh
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t rbitcoin-space .
```

Without the argument the image reports `revision` `unknown`, since `.git` is not part of the build context.

The [`Dockerfile`](../Dockerfile) has three stages. Base images are multi-arch and pinned by digest; all come from Docker Hub or `gcr.io`.

| Stage | From | Does |
|---|---|---|
| `web` | `oven/bun` | `bun install --frozen-lockfile` and `bun run build`. Runs on the build platform only, since the output is the same on every architecture |
| `server` | `rust` (Debian 13) | `cargo build --release --locked -p rbitcoin-space`. The cargo registry and `target/` are BuildKit cache mounts, so a change recompiles the workspace's own crates and never the dependencies. Every source is touched first: cargo trusts cached output newer than its sources' modification times, and a context's times can be older than the cache (`git archive` gives every file its commit's time), which once left a new migration out of an image without an error. The Rust tag must match `rust-toolchain.toml`, which is not copied in |
| final | `gcr.io/distroless/cc-debian13:nonroot` | The binary at `/usr/local/bin/rbitcoin-space`, the frontend at `/srv/web`. No shell, no package manager |

Defaults inside the image: `LISTEN_ADDR=0.0.0.0:8080` and `WEB_DIR=/srv/web`. Everything else is configured as in [`CONFIG.md`](CONFIG.md). It does not set `DATA_DIR`; without it the server keeps no store.

It runs as uid and gid 65532, needs no capabilities, and writes only to `/data`, an empty directory it owns, so it runs with a read-only root filesystem and a volume at `/data`. **It needs no writable `/tmp`, and has none:** SQLite keeps its temporary data in memory ([`STORE.md`](STORE.md#temporary-data)), so do not add a tmpfs. Releases before 2026-11-14 needed one at mainnet's size; without it their Lightning pages never left "still syncing" and other large reads failed. Its health check is the binary itself: `rbitcoin-space healthcheck` asks the server at `LISTEN_ADDR` for `/healthz` and exits 0 on a 200, 1 otherwise. With `LISTEN_ADDR` port 0 there is nothing to check; do not use port 0 in a container.

[`.dockerignore`](../.dockerignore) is an allow-list: only `Cargo.toml`, `Cargo.lock`, `crates/`, `dev/load/` (a workspace member, whose manifest cargo reads), `web/` (without `node_modules/` and `dist/`) and the parts of `design/` the app imports (`tokens.css`, `logo.svg`, `fonts/`) reach the build. `.env`, `target/` and everything else stay out.

Check those claims on any image:

```sh
docker image inspect -f '{{.Config.User}}' ghcr.io/smolcars/rbitcoin-space:0.1.0      # 65532:65532
c=$(docker create ghcr.io/smolcars/rbitcoin-space:0.1.0)
docker export "$c" | tar -t | grep -E '^(usr/)?(local/)?s?bin/.'                         # usr/local/bin/rbitcoin-space, alone
docker rm "$c"
```

Measured: 57.9 MB unpacked for arm64 (2026-11-13; 57.7 MB on 2026-11-12), and 16.6 MB compressed for amd64 and 17.0 MB for arm64 (2026-11-12). The amd64 image's unpacked size was not measured. A cold build takes about 2 minutes on GitHub's runners, 18 s on an Apple Silicon Mac with the base images pulled. The [release workflow](CI.md#releases) builds and publishes both architectures.

### Hardening in the compose file, and why

| Choice | Applies to | Why |
|---|---|---|
| `read_only: true` | both | Nothing can be written outside the volumes, so a compromised process cannot drop files or alter its binary. Each writes only its own `/data` volume. Neither needs a writable `/tmp`: the server's SQLite temporary data stays in memory ([`STORE.md`](STORE.md#temporary-data)), which the release workflow proves against a mainnet-sized store |
| `cap_drop: [ALL]` | both | Neither binds a port below 1024 or needs any other privilege |
| `no-new-privileges` | both | A setuid binary cannot raise privileges. Neither image has one; this keeps it so |
| Non-root users | both | The server runs as 65532, the node as 10001, as their images set |
| Only P2P published | node | RPC and Electrum listen on the compose network, Esplora on a socket. The browser never reaches the node ([`SECURITY.md`](SECURITY.md) rule 1) |
| Server on loopback | server | Reached through the reverse proxy alone. No proxy header is trusted until you set one up ([above](#client-addresses)) |
| Socket volume is tmpfs, owner 10001, mode 0750 | both | The socket never outlives the stack, and only the node's uid and group can enter the directory |
| `group_add: ["10001"]` | server | rbitcoin creates the socket mode 0660 owned by 10001:10001. The server joins that group to connect, instead of running as the node's uid |
| Socket volume read-only | server | Connecting to a socket needs no write access to its directory |
| Credentials in `.env` and `rpc.cookie` | both | Nothing secret is in an image or in `compose.yml`. The cookie is a file and not compose `content`, because compose cannot copy content into a container whose root filesystem is read-only |
| `local` logging driver | both | Docker's default `json-file` never rotates; `local` keeps five files of 20 MB |
| `stop_grace_period: 5m` | node | rbitcoin flushes its store on SIGTERM |
| Images pinned by digest | node | The tag cannot be moved under a running deployment |

If `docker pull` from ghcr.io does not work on your machine, load the rbitcoin image another way and set `RBITCOIN_IMAGE=ghcr.io/rbitcoin-org/rbitcoin:0.9.2`, since a loaded image has no digest to match.
