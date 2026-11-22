# Running rbitcoin.space

The operator's guide. What you run is one image, `ghcr.io/smolcars/rbitcoin-space`, holding the server and the built frontend, beside an rbitcoin node. Settings are listed once, in [`CONFIG.md`](CONFIG.md); this guide links there.

## Choose a scenario

A deployment is one choice from each table. Each scenario is a section you can follow alone, top to bottom: what you need, numbered steps, and a last step that checks it worked.

**1. Where the server runs**

| Scenario | Pick it when |
|---|---|
| [Same host, with the compose file](#same-host-with-the-compose-file) | The default. A new host: the compose file runs the node and the server together |
| [The node on another host](#the-node-on-another-host) | Your node already runs on another machine |
| [The node in another compose project](#the-node-in-another-compose-project) | Your node already runs on this host, in a compose project of its own |
| [Try it on regtest first](#try-it-on-regtest-first) | You want a private chain to try every step on, in minutes |

**2. How visitors reach it**

| Scenario | Pick it when |
|---|---|
| [Caddy on the host](#caddy-on-the-host) | The default. You have a domain and can open ports 80 and 443 |
| [Any other proxy](#any-other-proxy) | You already run nginx, HAProxy or another proxy |
| [A proxy in a container](#a-proxy-in-a-container) | You want Caddy managed by the same compose file |
| [Behind a Cloudflare Tunnel](#behind-a-cloudflare-tunnel) | You cannot or do not want to open any port. Cloudflare sees every request |
| [Under mempool.space's frontend](#under-mempoolspaces-frontend) | You want mempool.space's own pages, with this server as their backend |
| [As a Tor onion service](#as-a-tor-onion-service) | Also, beside any of the above: visitors reach the site over Tor, without Cloudflare and without revealing their address |

After that, [the reference](#reference): health, the data directory, the first start, watching it, upgrading, switching features, the security checklist and what to do when it goes wrong.

## What every scenario needs

### The node

rbitcoin at **v0.9.2**, the version this release was built and tested against. The compose file runs one for you; if you bring your own, it needs these switched on:

| Flag | The explorer uses it for | Without it |
|---|---|---|
| `--esplora-listen` | Blocks, transactions, addresses, spends, broadcast, fee estimates: most of what a page shows | Nothing works |
| `--electrum-listen` | Being told about new blocks and about changes to followed addresses and transactions | Nothing is live, and `/readyz` stays `503` |
| `--rpc-listen` with `--rpc-cookie-file` | The live mempool, projected blocks, block statistics and the backfill. The cookie file holds `user:password`; rbitcoin has no `--rpcuser` | No mempool, no block table, no mining pages |
| `--sh-index` | Address pages and the address and scripthash API routes | Those answer `503` `address index is disabled on this server`; everything else works. The server logs `address_index_off` and `/readyz` says `address_index` `off`. It is off by default in rbitcoin |

Esplora and Electrum have no authentication: never let anything but the server reach them. What the explorer relies on from each interface is in [`RBITCOIN.md`](RBITCOIN.md).

**Large addresses.** Keep `--max-sh-creates` at rbitcoin's default (10,000 paying transactions) on a node that serves anyone but the server: raising it lets anyone start joins of millions of transactions. With the server on the node's Esplora unix socket and a node that has rbitcoin PR 1628 (nightly images from `nightly-20261114` on; no release yet), the server adds up an address above the cap through the socket, and logs `ledger_totals_route` `uncapped: true` ([`RBITCOIN.md`](RBITCOIN.md#totals-of-large-addresses)); such an address shows its totals and newest 200 transactions, and older pages are refused. On v0.9.2, or over TCP, it is shown as too large for this server ([`API.md`](API.md#very-large-addresses)).

#### Testnet 5

Testnet 5 (BIP 95) needs an rbitcoin newer than v0.9.2: the nightly of 2026-11-14 (master `94dce31b`) or later, which knows `--network testnet5`. Set `RBITCOIN_IMAGE` to such a build. It has no DNS seeds yet, so add `--connect=<host>:18353` to the node's `command`, naming a Testnet 5 node you trust. There is no Lightning on it ([`CONFIG.md`](CONFIG.md#lightning)).

### The host

Linux with Docker Engine and the Compose plugin, on amd64 or arm64. The node needs what rbitcoin needs for the chain; the server needs little ([measured](#one-day-on-mainnet) with mainnet, signet and testnet4, the mempool engine on each and Lightning on mainnet, without visitors):

| | Expect |
|---|---|
| Memory | 251 MB resident. Lightning adds 250 to 330 MB by the process's physical footprint ([`LIGHTNING.md`](LIGHTNING.md#measured-in-the-server)); how much of the 251 MB it was is not known. More with open WebSockets (64 MB with 5,000, [`WS.md`](WS.md)) and as the block summaries and kept answers fill, up to `BLOCK_SUMMARY_CACHE_MB` and `ANSWER_CACHE_MB` (32 MB each) per network |
| CPU | About 6% of one core; 8% with 5,000 WebSockets open, in a load test |
| Disk | After the full backfill: 547 MB for mainnet's store, 133 MB for signet's, 72 MB for testnet4's, 35 MB for the Lightning graph. Then about 150 MB a year on mainnet, estimated, nearly all audits. The log was 6.6 MB a day; it is capped at 256 KiB a second, so at worst 22.6 GB a day ([`LOGGING.md`](LOGGING.md#for-operators)). The compose file's `local` driver keeps 100 MB of it; a host that keeps the log another way must rotate it or lower `LOG_MAX_BYTES_PER_SEC` |
| Network | Nothing published but the node's P2P port and, through the proxy, 443. Behind a Cloudflare Tunnel, only P2P |

More than 1,024 open pages at once: see [many WebSockets](#many-websockets).

## Same host, with the compose file

[`deploy/compose.yml`](../deploy/compose.yml) runs rbitcoin v0.9.2 and the server side by side:

```text
 internet ── reverse proxy (TLS) ──► server :8080 ─┬─ unix socket ──► node  Esplora
                                                   ├─ TCP 8332 ─────► node  JSON-RPC
                                                   └─ TCP 50001 ────► node  Electrum
 bitcoin peers ──────────────────────────────────────────────────────► node  P2P (published)
```

Esplora is a unix socket, on no network at all; it also carries rbitcoin's bulk `/internal/*` routes, which exist on no TCP listener ([`RBITCOIN.md`](RBITCOIN.md#what-it-does-not-give-us)). RPC and Electrum are on the compose network only.

**You need:** [the host](#the-host), `git`, `openssl` and `sudo`.

1. Get the compose file at the release you run (the newest on the [releases page](https://github.com/smolcars/rbitcoin-space/releases)):

   ```sh
   VERSION=0.5.0
   git clone --depth 1 --branch "v$VERSION" https://github.com/smolcars/rbitcoin-space.git
   cd rbitcoin-space/deploy
   ```

2. Make `.env` with a random RPC password and the image:

   ```sh
   cp .env.example .env && chmod 600 .env
   pass=$(openssl rand -hex 32)
   sed -i.bak "s/^MAINNET_RPC_PASSWORD=.*/MAINNET_RPC_PASSWORD=$pass/" .env && rm .env.bak
   echo "SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space:$VERSION" >> .env
   ```

   Without `SERVER_IMAGE`, compose builds the image from the checkout instead of pulling it.

3. Write the same user and password to the node's cookie file, in the same shell:

   ```sh
   touch rpc.cookie && chmod 600 rpc.cookie
   printf 'rbitcoin-space:%s' "$pass" > rpc.cookie
   sudo chown 10001:10001 rpc.cookie
   ```

   The node reads it as its uid 10001, `user:password` with no newline, and refuses to start if others may read it. The server reads the same pair from `MAINNET_RPC_USER` and `MAINNET_RPC_PASSWORD`. `.env` and `rpc.cookie` are git-ignored.

4. Start both:

   ```sh
   docker compose up -d
   ```

5. Check:

   ```sh
   docker compose ps --format '{{.Service}} {{.Status}}'          # node Up …, server Up … (healthy)
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/readyz   # 200
   ```

   `/readyz` may answer `503` for the first seconds while the node starts. The first mainnet sync takes as long as rbitcoin takes; the site serves what the node has meanwhile, and `tip_age_secs` in `/readyz` says how far behind it is ([health](#health)).

The server listens on `127.0.0.1:8080` (`HTTP_PUBLISH` changes it): nothing outside the host can reach it. Now pick [how visitors reach it](#choose-a-scenario). For a second network beside the first, see [add a network](#add-a-network).

## The node on another host

**You need:** Docker on this host; a node with [the flags above](#the-node) on another host, reachable from this one over a private network or a tunnel (WireGuard, SSH) that nothing else can reach; the node's RPC `user:password` from its cookie file.

1. Write `server.env` with the node's six addresses ([`CONFIG.md`](CONFIG.md#networks)), here for mainnet with the node at `node.internal`:

   ```sh
   touch server.env && chmod 600 server.env
   cat > server.env <<'EOF'
   MAINNET_RPC_HOST=node.internal
   MAINNET_RPC_PORT=8332
   MAINNET_RPC_USER=<user from the node's cookie>
   MAINNET_RPC_PASSWORD=<password from the node's cookie>
   MAINNET_ESPLORA_URL=http://node.internal:3000
   MAINNET_ELECTRUM_ADDR=node.internal:50001
   EOF
   ```

2. Run the server alone, with the compose file's hardening:

   ```sh
   docker run -d --name rbitcoin-space --restart unless-stopped --log-driver local \
     --read-only --cap-drop ALL --security-opt no-new-privileges --ulimit nofile=65536 \
     --env-file server.env -e DATA_DIR=/data -v rbitcoin-space-data:/data \
     -p 127.0.0.1:8080:8080 ghcr.io/smolcars/rbitcoin-space:0.5.0
   ```

3. Check:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/readyz   # 200
   ```

   `503` with `rpc` `unreachable` or `auth_failed` in its body: see [when it goes wrong](#when-it-goes-wrong).

What differs from the same host:

- **The node's interfaces are on a network.** None encrypts, and Esplora and Electrum do not authenticate.
- **Every node call crosses it.** With the mempool engine on, 120 to 200 MB a minute of RPC answers on mainnet, 7 to 12 GB an hour, measured ([`CONFIG.md`](CONFIG.md#the-live-mempool)). The backfill is mostly round trips and runs slower ([`STORE.md`](STORE.md#backfill)).
- **No bulk routes.** `/internal/*` is only on the node's unix socket, so addresses above the node's `--max-sh-creates` are shown as too large ([large addresses](#the-node)).

Where this guide says `docker compose up -d` to apply a change, remove the container (`docker rm -f rbitcoin-space`) and run step 2 again; the volume keeps the store.

## The node in another compose project

Add the server to the project that already runs rbitcoin, instead of running a second node. The first public deployment ran this way on 2026-11-14: one server beside three nodes (mainnet, signet, testnet4).

**You need:** the project's compose file; each node started with [the flags above](#the-node), Esplora on a unix socket in a directory on the host.

1. Add the server to the project's compose file: the service from [`compose.yml`](../deploy/compose.yml) with its hardening, a release image in place of its `build`, and what reaches the nodes:

   ```yaml
   services:
     server:
       image: ghcr.io/smolcars/rbitcoin-space:0.5.0
       read_only: true
       cap_drop: [ALL]
       security_opt: [no-new-privileges:true]
       restart: unless-stopped
       logging:
         driver: local
       ulimits:
         nofile: 65536
       environment:
         DATA_DIR: /data
       ports:
         - 127.0.0.1:8080:8080
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

   The socket's group id is `stat -c %g <socket>` on the host. The server connects as a member of that group.

2. Write `rbitcoin-space.env` beside the project's compose file, with each network's six variables ([`CONFIG.md`](CONFIG.md#networks)). For mainnet:

   ```sh
   touch rbitcoin-space.env && chmod 600 rbitcoin-space.env
   cat > rbitcoin-space.env <<'EOF'
   MAINNET_RPC_HOST=<node service>
   MAINNET_RPC_PORT=<its --rpc-listen port>
   MAINNET_RPC_USER=<user from the node's cookie>
   MAINNET_RPC_PASSWORD=<password from the node's cookie>
   MAINNET_ESPLORA_URL=/run/mainnet/esplora.sock
   MAINNET_ELECTRUM_ADDR=<node service>:<its --electrum-listen port>
   EOF
   ```

   Add the same six with `SIGNET_` and `TESTNET4_` for the other nodes, each `ESPLORA_URL` at its own mount. RPC and Electrum are reached by service name on the project's network; neither is published.

3. Start the server alone, leaving the nodes as they are:

   ```sh
   docker compose up -d --no-deps server
   ```

   Without `--no-deps`, compose also starts, and may recreate, every node the server depends on. Use it every time you touch the server.

4. Check, on the port you published:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/readyz   # 200
   ```

If a node's cookie changes, copy it again and run `docker compose up -d --no-deps --force-recreate server`; until then the server logs `rpc_auth_failed`. The volume is `<project>_server-data` wherever this guide says `rbitcoin-space_server-data`. The deployment ran all three networks this way; the YAML above was not run as written, since its paths and names are the host's.

## Try it on regtest first

The same compose file runs a private regtest chain, a safe place to try every step of this guide.

**You need:** Docker with Compose, `git`, `openssl`, `sudo` and `curl`.

1. Get the compose file and write a regtest `.env` and cookie:

   ```sh
   VERSION=0.5.0
   git clone --depth 1 --branch "v$VERSION" https://github.com/smolcars/rbitcoin-space.git
   cd rbitcoin-space/deploy
   pass=$(openssl rand -hex 32)
   touch .env rpc.cookie && chmod 600 .env rpc.cookie
   cat > .env <<EOF
   NETWORK=regtest
   P2P_PORT=18444
   P2P_PUBLISH=127.0.0.1:0
   HTTP_PUBLISH=127.0.0.1:0
   SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space:$VERSION
   REGTEST_RPC_HOST=node
   REGTEST_RPC_PORT=8332
   REGTEST_RPC_USER=rbitcoin-space
   REGTEST_RPC_PASSWORD=$pass
   REGTEST_ESPLORA_URL=/run/esplora/esplora.sock
   REGTEST_ELECTRUM_ADDR=node:50001
   EOF
   printf 'rbitcoin-space:%s' "$pass" > rpc.cookie
   sudo chown 10001:10001 rpc.cookie
   ```

   `.env` has no `MAINNET_*` line: one left in would point the explorer's mainnet at the regtest node (`rpc_wrong_network`). `127.0.0.1:0` lets Docker choose free host ports.

2. Start both:

   ```sh
   docker compose up -d
   ```

3. Mine 101 blocks, from a container on the compose network:

   ```sh
   docker run --rm --network rbitcoin-space_default curlimages/curl:8.11.1 -su "rbitcoin-space:$pass" \
     -d '{"method":"generatetoaddress","params":[101,"bcrt1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqseac85"]}' http://node:8332/
   ```

4. Check:

   ```sh
   addr=$(docker compose port server 8080)
   curl -s -o /dev/null -w '%{http_code}\n' "http://$addr/readyz"   # 200
   curl -s "http://$addr/regtest/api/blocks/tip/height"; echo       # 101
   ```

   The site is at `http://$addr/regtest/`. A proxy in front uses `$addr` in place of `127.0.0.1:8080`.

`docker compose down -v` removes the chain and the store.

## Behind a reverse proxy with TLS

A proxy in front of the server must serve HTTPS on the same origin as the WebSocket, pass the browser's `Host` through, compress `/api` and `/app` answers, and tell the server who the client is. Each scenario below does all four.

### Caddy on the host

**You need:** the server running on `127.0.0.1:8080` ([where it runs](#choose-a-scenario)); a domain, here `explorer.example.com`, whose DNS points at this host; ports 80 and 443 open; [Caddy](https://caddyserver.com/docs/install) installed as a service.

1. Write the site into `/etc/caddy/Caddyfile`:

   ```caddyfile
   explorer.example.com {
   	encode zstd gzip
   	reverse_proxy 127.0.0.1:8080 {
   		header_up X-Real-IP {remote_host}
   	}
   }
   ```

   Caddy gets and renews the certificate, redirects HTTP to HTTPS, proxies WebSockets and passes `Host` through. `encode` compresses JSON and leaves the frontend's precompressed files alone. `header_up` overwrites any `X-Real-IP` the client sent.

2. Load it: `sudo systemctl reload caddy`.

3. Tell the server the client's address: [client addresses](#client-addresses), with `X-Real-IP`.

4. Check from another machine: [check it from outside](#check-it-from-outside). Expect `200 zstd`, `101` and `308`.

Tested with Caddy 2.11.9, with a certificate from a file in place of an automatic one (`tls cert.pem key.pem` inside the site block).

### Any other proxy

**You need:** the server running on `127.0.0.1:8080`; a proxy on the same host with a certificate for your domain.

1. Configure the proxy to do every row:

   | Do | Why | nginx, for example (not tested here) |
   |---|---|---|
   | Terminate TLS and redirect HTTP to HTTPS | Browsers switch features off on plain HTTP (the clipboard API among them), and anything on the path can read or change the pages | `listen 443 ssl`, `return 301 https://$host$request_uri` |
   | Forward every path unchanged, every network prefix included | The app, `/api`, `/app` and `/signet/…` are one site | `location / { proxy_pass http://127.0.0.1:8080; }` |
   | Pass `Host` as the browser sent it, port included | `/app/ws` refuses an upgrade whose `Origin` is not that host ([`SECURITY.md`](SECURITY.md) rule 21) | `proxy_set_header Host $http_host;` |
   | Upgrade WebSockets on `/app/ws` and `/api/v1/ws`, under every prefix | Live blocks, mempool and followed transactions | `proxy_http_version 1.1;` and the `Upgrade` and `Connection` headers |
   | Keep an idle WebSocket open for at least 60 s | The server pings a quiet socket every 30 s (`WS_IDLE_TIMEOUT_SECS`) | `proxy_read_timeout` is 60 s by default |
   | Overwrite the client-address header, or append to `X-Forwarded-For` | Otherwise a client chooses its own address | `proxy_set_header X-Real-IP $remote_addr;` |
   | Compress `application/json` | The server does not compress what it computes; uncompressed, a list of blocks is about four times larger | `gzip on; gzip_types application/json;` |
   | Accept request bodies of 1 MB | A broadcast transaction may be 800,000 hex characters ([`API.md`](API.md#broadcast)) | `client_max_body_size` is 1 MB by default |

2. Tell the server the client's address: [client addresses](#client-addresses), with the header your proxy writes.

3. Check from another machine: [check it from outside](#check-it-from-outside). Expect `200` with your proxy's compression, `101`, and a redirect.

A CDN in front must also honour the server's `Cache-Control` (confirmed blocks are cacheable for long, live answers are `no-store`) and key pages on the whole URL, query string included, since a page's head names that page for link previews ([`FRONTEND.md`](FRONTEND.md#link-previews)).

Whatever the proxy, set `SITE_URL` in `.env` to the site's public address (`https://explorer.example.com`), so a link pasted into a chat app shows the site's picture and not only text ([`CONFIG.md`](CONFIG.md#site-address)).

### A proxy in a container

Caddy as a container beside the server, from [`deploy/compose.proxy.yml`](../deploy/compose.proxy.yml). It puts the proxy and the server on a network of their own, `edge`, with a fixed subnet and the proxy at the pinned address `172.30.111.2`, which the server trusts; nothing is published on the host for the server.

**You need:** the [same-host](#same-host-with-the-compose-file) stack, from `deploy/`; a domain whose DNS points at this host; ports 80 and 443 free.

1. Next to `compose.yml`, write a `Caddyfile`:

   ```caddyfile
   explorer.example.com {
   	encode zstd gzip
   	reverse_proxy server:8080 {
   		header_up X-Real-IP {remote_host}
   	}
   }
   ```

2. Add the proxy to `.env`:

   ```sh
   TRUSTED_PROXY_HEADER=X-Real-IP
   TRUSTED_PROXIES=172.30.111.2
   ```

3. Start everything with both files:

   ```sh
   docker compose -f compose.yml -f compose.proxy.yml up -d
   ```

   Every later command needs both `-f` flags, or compose leaves the proxy out. Caddy keeps its certificates in the `proxy-data` volume. If `172.30.111.0/29` overlaps a network the host has, compose refuses to start: change the subnet, the `ip_range` and the address in `compose.proxy.yml`, and `TRUSTED_PROXIES`, together.

4. Check from another machine: [check it from outside](#check-it-from-outside). Expect `200 zstd`, `101` and `308`. Then load a page with `LOG_CLIENT_ADDR=true` as in [client addresses](#client-addresses), step 4: the `client` must be your own address, not `172.30.111.1`. Ports published by Docker may hide visitors' addresses (that section says why); if they do, every visitor shares one allowance and none can choose another's address.

Tested on 2026-11-13 with Caddy 2.11.9 over plain HTTP, visitors as containers on a network only the proxy joined: two visitors had separate limits and were logged by their own addresses; headers they forged were ignored; a container that skipped the proxy was keyed on its own address, with `proxy_header_ignored`; the pinned address held after the proxy was recreated and after `down`, another network and `up` (without the pin it moved); responses came `zstd` and `/regtest/app/ws` upgraded. Not tested: the published ports' handling of real visitors, and IPv6 visitors to this IPv4 network.

## Behind a Cloudflare Tunnel

`cloudflared` runs as a container beside the server and dials out to Cloudflare, whose edge holds the certificate and sends each request down that connection. Nothing is published on the host and no port is opened on the router. The first public deployment ran this way on 2026-11-14, with a locally managed tunnel and the free plan.

**The trade:** Cloudflare terminates TLS. It sees every page, block, transaction and address a visitor looks up, and the visitor's address, and could change what it serves.

**You need:** the [same-host](#same-host-with-the-compose-file) stack, from `deploy/`; a Cloudflare account with your domain's DNS hosted there (change the nameservers at the registrar; the registration stays where it is); [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and a browser on any machine.

1. Create the tunnel, on the machine with `cloudflared`:

   ```sh
   cloudflared tunnel login                                    # writes ~/.cloudflared/cert.pem
   cloudflared tunnel create explorer                          # prints the tunnel's id, writes ~/.cloudflared/<id>.json
   cloudflared tunnel route dns explorer explorer.example.com
   cloudflared tunnel route dns explorer www.explorer.example.com   # only if you serve a www name too
   ```

   `cert.pem` is the account's login for managing tunnels: leave it off the server.

2. Move the credentials file to the server's host, beside `compose.yml`, readable by the container's user (65532) alone. Whoever holds it can answer for your hostname.

   ```sh
   mkdir -p cloudflared
   mv <id>.json cloudflared/credentials.json
   sudo chown 65532:65532 cloudflared/credentials.json && sudo chmod 400 cloudflared/credentials.json
   ```

3. Write `cloudflared/config.yml`:

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

   Validate it, no account needed:

   ```sh
   docker compose -f compose.yml -f compose.tunnel.yml run --rm --no-deps tunnel \
     tunnel --config /etc/cloudflared/config.yml ingress validate             # OK
   ```

4. Tell the server, in `.env`:

   ```sh
   TRUSTED_PROXY_HEADER=X-Forwarded-For
   TRUSTED_PROXIES=172.30.111.2
   ```

   Cloudflare appends the visitor's address to `X-Forwarded-For`, and the server walks it from the right, so a client's own header is harmless ([`CONFIG.md`](CONFIG.md#client-addresses)). `CF-Connecting-IP` would work too; nobody has tried it here.

5. Start everything with [`deploy/compose.tunnel.yml`](../deploy/compose.tunnel.yml), which adds the tunnel at the pinned address on the `edge` network, hardened like the server, and removes the server's published port:

   ```sh
   docker compose -f compose.yml -f compose.tunnel.yml up -d
   ```

   Every later command needs both `-f` flags. Use this file or `compose.proxy.yml`, not both: they pin the same address.

6. In Cloudflare's dashboard, switch on **Always Use HTTPS** (SSL/TLS, Edge Certificates). Until then `http://` answers `200`, with the page in the clear.

7. Check from another machine: [check it from outside](#check-it-from-outside), with `br` in `Accept-Encoding`. Expect `200 br`, `101` and `301`. Then compare addresses: with `LOG_CLIENT_ADDR=true` ([client addresses](#client-addresses), step 4), the `client` of your request must equal the `ip=` line of `https://explorer.example.com/cdn-cgi/trace` from the same browser; an IPv6 address is logged as its `/64`, so the first four groups must match. Remove `LOG_CLIENT_ADDR` after.

If you switch on Cloudflare's Web Analytics, set `CLOUDFLARE_WEB_ANALYTICS=true`, or the Content-Security-Policy refuses the beacon Cloudflare injects ([`CONFIG.md`](CONFIG.md#cloudflare-web-analytics)).

Observed in the deployment, with nothing configured at Cloudflare but the tunnel, its DNS records and Always Use HTTPS: each visitor keyed by their own address; `/api` JSON arrived `br`, so compression needs no setting; API answers were not cached (`cf-cache-status: DYNAMIC`), the frontend's immutable files were; `/app/ws` and `/api/v1/ws` upgraded. Not observed: whether bot protection challenges script clients of `/api`; Cloudflare's idle limit for a WebSocket (the server pings a socket quiet for 30 to 45 s by default, so a limit of `WS_IDLE_TIMEOUT_SECS` or more is enough); a request body near 1 MB. This compose file was checked with `config` and `ingress validate`, without an account; the deployment ran an equivalent service, not this file.

## As a Tor onion service

A Tor container beside the server publishes the site as a v3 onion service. Tor carries each visitor to it end to end, encrypted and authenticated by the address itself: no TLS, no certificate, no port opened, and no proxy or CDN that sees the visitor's address.

**You need:** the [same-host](#same-host-with-the-compose-file) stack, from `deploy/`. The tunnel or the proxy overlay is optional.

1. Start it with [`deploy/compose.onion.yml`](../deploy/compose.onion.yml):

   ```sh
   docker compose -f compose.yml -f compose.onion.yml up -d
   ```

   With the tunnel or the proxy, put its `-f` before the onion's, here and in every later command. Tor runs from our own image ([`deploy/tor/Dockerfile`](../deploy/tor/Dockerfile): Alpine and its `tor` package, nothing else), pinned on `edge` at `172.30.111.3`, hardened like the server, with the proof-of-work defence on.

2. Read the address. Tor writes it on the first start, and the service is reachable a minute or so later:

   ```sh
   docker compose -f compose.yml -f compose.onion.yml exec onion cat /var/lib/tor/site/hostname
   ```

3. Back up the key, and keep the file offline, owner-only. Whoever holds it can serve that address; losing it loses the address for good.

   ```sh
   (umask 077; docker compose -f compose.yml -f compose.onion.yml exec -T onion tar -C /var/lib/tor -cf - site > onion-site.tar)
   ```

   To restore it into an empty volume, with the `onion` container stopped:

   ```sh
   docker compose -f compose.yml -f compose.onion.yml run --rm --no-deps -T --entrypoint tar onion -C /var/lib/tor -xf - < onion-site.tar
   ```

4. If the site is also served over HTTPS, point Tor Browser's visitors at the onion: set `ONION_LOCATION=http://<address>` in `.env` and run step 1's command again ([`CONFIG.md`](CONFIG.md#onion-location)). Tor Browser ignores the header on plain HTTP.

5. Check from another machine running Tor (`9050`; with Tor Browser open instead, `9150`):

   ```sh
   curl -s --socks5-hostname 127.0.0.1:9050 http://<address>/healthz                  # {"status":"ok",…}
   curl -sI https://explorer.example.com/ | grep -i onion-location                    # with step 4: http://<address>/
   ```

   Then open `http://<address>/` in Tor Browser: the block list says **Live**.

**Every onion visitor shares one allowance.** They all arrive from `172.30.111.3`, so the per-client limits count them as one client ([`CONFIG.md`](CONFIG.md#per-client-defaults)). Measured on regtest through a real Tor circuit: 10 browsers clicking through four pages at once, none refused; 12 cold loads at the same instant, a few connections reset (`connections_refused`, past `CLIENT_MAX_CONNECTIONS`); at most 16 open tabs get live updates (`WS_CLIENT_MAX_SOCKETS`). A flood over Tor costs the other onion visitors, never the clearnet ones. **Never list `172.30.111.3` in `TRUSTED_PROXIES`:** Tor passes a visitor's own `X-Forwarded-For` through, so every onion visitor could choose their address.

`/api` and `/app` answers go out uncompressed, since no proxy sits in front; pages and `/assets` are precompressed.

**To bump Tor:** set `TOR_VERSION` in `deploy/tor/Dockerfile` to the version Alpine's pinned release ships (move the Alpine digest too if it needs a newer release) and merge. The release workflow publishes `ghcr.io/smolcars/rbitcoin-space-tor:<version>` once ([`CI.md`](CI.md#releases)); then set that tag and its digest in `compose.onion.yml` and run step 1's command. The address and the key stay the same.

## Under mempool.space's frontend

mempool.space's own frontend serves the pages, and this server is its backend: a reverse proxy sends every API path to this server and everything else to the frontend. The frontend runs unmodified and needs no patch.

```text
 internet ── Caddy (TLS) ─┬─ /api/*, /signet/api/*, /testnet4/api/* ──► this server :8080
                          └─ everything else ─────────────────────────► mempool frontend :8081
```

mempool.space's frontend is AGPL-licensed and its name and logo are trademarks: this project does not ship it, and whoever runs it follows its licence and trademark policy. Which of its pages work, and what they lack, is the table in [`COMPAT.md`](COMPAT.md#mempoolspaces-frontend-on-this-server).

**You need:** the server running on `127.0.0.1:8080` ([where it runs](#choose-a-scenario)) with a store (`DATA_DIR`, which the compose file sets) and the mempool engine on (the default); Caddy and a domain as in [Caddy on the host](#caddy-on-the-host).

1. Run release 0.2.0 or later ([upgrading](#upgrading)): 0.1.0 lacks what this frontend asks of the socket.

2. Run the frontend, published on its own loopback port:

   ```sh
   docker run -d --name mempool-frontend --restart unless-stopped --log-driver local \
     --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
     -e FRONTEND_HTTP_PORT=8080 -e BACKEND_MAINNET_HTTP_HOST=127.0.0.1 -e ACCELERATOR_BUTTON=false \
     -e SIGNET_ENABLED=false -e TESTNET4_ENABLED=false \
     -p 127.0.0.1:8081:8080 \
     mempool/frontend:v3.3.2@sha256:83c5d1e20cd4fad358584f5921ca547d69ab80162d0e2f3138c2d142a91dbadd
   ```

   - `SIGNET_ENABLED` and `TESTNET4_ENABLED`: `true` for each network this server serves.
   - `BACKEND_MAINNET_HTTP_HOST` must resolve, or the frontend's nginx refuses to start; its own proxying is never reached.
   - It cannot run with a read-only root filesystem: it writes its configuration at start.

3. Write the site into `/etc/caddy/Caddyfile`:

   ```caddyfile
   explorer.example.com {
   	encode zstd gzip
   	@api path /api/* /signet/api/* /testnet4/api/*
   	reverse_proxy @api 127.0.0.1:8080 {
   		header_up X-Real-IP {remote_host}
   	}
   	reverse_proxy 127.0.0.1:8081
   }
   ```

   The WebSocket is `/api/v1/ws` under the same paths, so it goes to this server too. Load it: `sudo systemctl reload caddy`.

4. Tell the server the client's address: [client addresses](#client-addresses), with `X-Real-IP`.

5. Check from another machine:

   ```sh
   curl -s https://explorer.example.com/ | grep -o '<title>[^<]*</title>'   # <title>mempool - Bitcoin Explorer</title>
   curl -s https://explorer.example.com/api/blocks/tip/height; echo         # your node's height
   curl -s -o /dev/null --max-time 3 -w '%{http_code}\n' --http1.1 \
     -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     https://explorer.example.com/api/v1/ws                                  # 101
   ```

   The height must equal `/readyz`'s `tip_height` on the server. The last command prints `101`, then waits until `--max-time` because the socket stays open. Then open the site: the home page shows your node's blocks and projected blocks, and moves when a block arrives.

To try it on regtest first, add `/regtest/api/*` to the `@api` line, `-e REGTEST_ENABLED=true` to the frontend, and open `/regtest`.

## Shared steps

### Client addresses

Rate limits are per client. Behind a proxy, the server reads the client's address from a header only when you name the header and the proxy's address; until then it ignores the header, so a client cannot choose its own address ([`SECURITY.md`](SECURITY.md) rule 7). How the header is read, and chains of proxies, are in [`CONFIG.md`](CONFIG.md#client-addresses).

This is for a proxy on the host. [A proxy in a container](#a-proxy-in-a-container) and [a tunnel](#behind-a-cloudflare-tunnel) trust their pinned address instead.

1. Find the address the proxy's connections arrive from, as the server sees them inside its container. It is not `127.0.0.1`: a proxy on the host reaches the published port through the gateway of the server's network (`rbitcoin-space_default` with the compose file, `bridge` for a `docker run`, `<project>_default` in another compose project):

   ```sh
   docker network inspect rbitcoin-space_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'   # 172.18.0.1, for example
   ```

2. Add to the server's env file (`.env`, `server.env` or `rbitcoin-space.env`), with the header your proxy writes and the address from step 1:

   ```sh
   TRUSTED_PROXY_HEADER=X-Real-IP
   TRUSTED_PROXIES=172.18.0.1
   LOG_CLIENT_ADDR=true                       # only while you check; it is off for privacy
   ```

3. Apply it: `docker compose up -d`.

4. Load the site from your own machine, then read the `client` of your request:

   ```sh
   docker compose logs --no-log-prefix server | grep '"http_request"' | tail -n 3
   ```

   It must be your own address. If it is the gateway, the server is not reading the header: check both settings. A `proxy_header_ignored` warning names in `peer` the address `TRUSTED_PROXIES` is missing.

5. Remove `LOG_CLIENT_ADDR` and run `docker compose up -d` again.

**Never trust the gateway when the server's port is reachable from anywhere but this host.** Anything that connects to the published port arrives from the gateway, so it is trusted like the proxy; that is why the port stays on loopback. And a published port may not pass on anyone's address: on 2026-11-14, on a Linux host (Docker Engine 28, Ubuntu 24.04) with the port published on specific host addresses, every connection reached the server from the gateway, whether from the LAN, a VPN or a proxy on another machine; on a Mac (OrbStack, Docker Engine 29.8.2) a connection from the host and one from a container on another network did too. Why was not found. On such a host every client of the port shares one allowance; leave the gateway untrusted (what the deployment did), or run the public proxy as a container on `edge` ([a proxy in a container](#a-proxy-in-a-container), [a tunnel](#behind-a-cloudflare-tunnel)). To see which host you have, load a page from another machine with `LOG_CLIENT_ADDR=true`: the gateway as its `client` means the port hides addresses.

Docker may give the network another subnet when it is recreated after `docker compose down`, and then the gateway changes. Check it again after one, and watch for `proxy_header_ignored`.

### Check it from outside

From any machine, against your domain:

```sh
curl -s -o /dev/null -H 'Accept-Encoding: zstd, gzip' -w '%{http_code} %header{content-encoding}\n' \
  https://explorer.example.com/api/blocks                  # 200 zstd: compressed
curl -s -o /dev/null --max-time 3 -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://explorer.example.com' \
  https://explorer.example.com/app/ws                      # 101: the WebSocket upgrades
curl -s -o /dev/null -w '%{http_code}\n' http://explorer.example.com/   # 301 or 308: HTTP redirects
```

The second prints `101` and then waits until `--max-time`, because the socket stays open. A `403` there means the proxy changed `Host`. Behind Cloudflare, put `br` in `Accept-Encoding`.

## Reference

### Health

| Route | Answers | Use it for |
|---|---|---|
| `/healthz` | `200` `{"status":"ok","version":"0.5.0","revision":…}` while the process serves HTTP. `revision` is the commit the binary was built from, or `unknown`. Never asks the node | Liveness; it is the image's health check, so `docker compose ps` shows `healthy`. After an upgrade, `revision` must be the new release's commit |
| `/readyz` | `200` with `"status":"ready"` when every enabled network's node answers RPC with our credentials and its Electrum connection is up, `503` otherwise. Per network: `ready`, `rpc` (`ok`, `auth_failed`, `wrong_network`, `unreachable` with `rpc_error`, or `pending` before the first check), `rpc_checked_secs_ago`, `electrum`, `tip_height`, and `tip_age_secs`, the newest block's age by its timestamp. Four more do not count towards `ready`: `lightning` (`off`, `starting`, `syncing`, `synced` once its pages answer, `failed`, `stopped`); `address_index` (`on`, `off`, `unknown` until the node answers); `store` (`ok`; `waiting` until the node is found on this network's chain; `failing` while SQLite refuses writes; `wrong_chain`; `open_failed`; `off` without `DATA_DIR`); and `store_written_secs_ago` | Readiness, for a load balancer or monitor. A syncing node shows as a growing `tip_age_secs`. Alert on `address_index` `off` and `store` other than `ok` too |

- `/readyz` costs the node nothing per request: it reads the Electrum client's state and the last RPC check, made at startup and every 30 s. The address index is asked when Electrum connects and after every reconnect: one lookup, about 20 ms of the node's time. Neither route is logged when it passes.
- Lightning, the address index and the store are left out of `ready` on purpose: blocks, transactions and the mempool work without them. Without the index, address pages answer `503`; with the store failing, pages still answer but history (block rows, audits, the mempool chart, replacements) is not recorded. `/app/lightning/status` says when the Lightning pages have data.
- Both routes answer anyone the proxy lets through, with the version, the commit and the labels above, never a reason: why the RPC failed, SQLite's message, paths and the node's addresses stay in the log ([`SECURITY.md`](SECURITY.md) rule 17). Hide them in the proxy if even that is too much.
- `revision` comes from the image's build argument `SOURCE_REVISION` (the release workflow passes the commit, the same as the image's `org.opencontainers.image.revision` label), else `git` when building from a checkout, else `unknown`. Uncommitted changes are not marked. Compare: `docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/smolcars/rbitcoin-space:0.5.0` and `curl -s http://127.0.0.1:8080/healthz`.
- The compose file adds no health check of its own and restarts on exit, not on health: the usual reason for not being ready is the node, and restarting the server would not help.

### The data directory

One SQLite file per network, `<network>.sqlite`, with `-wal` and `-shm` beside it while it runs; in the compose setup, the `rbitcoin-space_server-data` volume at `/data`. It holds only what the server derived or observed ([`STORE.md`](STORE.md)):

| Kept | Rebuilt if lost |
|---|---|
| One row per block: totals, fee rates, miner | Yes, by the backfill |
| Block audits: what we expected against what was mined | No: observed as each block arrived |
| Mempool history, a sample a minute, rolled into hours and days | No |
| The replacement record: what replaced what, and when it was first seen | No |
| With Lightning on: channels opened and closed, and in `lightning/<network>/` the peer's node key and graph | The graph by a fresh sync of a few minutes; the closed channels no |

Deleting it costs the backfill's time and loses the audits, the mempool chart's past and the replacement history for good. The node is untouched.

**Size on mainnet:** 547 MB [measured](#one-day-on-mainnet) after the backfill and a day recorded. Estimated by table: block rows about 220 bytes a block, 215 MB for the whole chain; audits about 150 MB a year; mempool history under 3 MB; replacements about 2 MB; the write-ahead log up to 64 MB. The measured file is larger than those add up to; it was not split by table.

**Back up while it runs,** with SQLite's own backup from a throwaway container (the image has no shell or `sqlite3`). Copying the `.sqlite` file alone can give a corrupt copy, since recent writes live in `-wal`:

```sh
mkdir -p backup
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/backup":/backup alpine:3 \
  sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -readonly /data/mainnet.sqlite ".backup /backup/mainnet.sqlite"'
```

**Restore** with the server stopped, removing the old `-wal` and `-shm`:

```sh
docker compose stop server
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/backup":/backup:ro alpine:3 \
  sh -c 'rm -f /data/mainnet.sqlite-wal /data/mainnet.sqlite-shm && cp /backup/mainnet.sqlite /data/ && chown 65532:65532 /data/mainnet.sqlite'
docker compose start server
```

**Seed a new instance from one that has caught up,** to skip the backfill (about 18 hours for mainnet's block totals) and keep the audits, mempool history and replacements, which no backfill rebuilds. On the old instance, beside its compose file, copy each network's file and the Lightning graph without its node key:

```sh
mkdir -p seed
for net in mainnet signet testnet4; do
  docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/seed":/seed alpine:3 \
    sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 -readonly /data/$net.sqlite '.backup /seed/$net.sqlite'"
done
docker run --rm -v rbitcoin-space_server-data:/data:ro -v "$PWD/seed":/seed alpine:3 \
  sh -c 'mkdir -p /seed/lightning/mainnet && cp -p /data/lightning/mainnet/graph /data/lightning/mainnet/verified /seed/lightning/mainnet/'
```

Copy `seed/` to the new host and, before the server's first start there, into its volume:

```sh
docker compose up --no-start                # creates the volume
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/seed":/seed:ro alpine:3 \
  sh -c 'cp -Rp /seed/. /data/ && chown -R 65532:65532 /data'
docker compose up -d
```

- List only the networks you run; leave out the Lightning line without Lightning.
- `cp -p` keeps the graph's modification time, which records when it was last caught up. The node key (`node_key`) stays behind: the new instance makes its own.
- A file from another network's node is refused (`store_open_failed`), and so is one from a newer release; an older release's is migrated forward ([upgrading](#upgrading)).
- It worked when the first `block_backfill_progress` has `totals_done` and `rates_done` both `true`. The deployment seeded its three networks and the graph this way on 2026-11-14.

### The first start

With an empty store the server runs the **backfill**: it fills the block table from the node, newest first, with every block's totals and the last year's fee rates, and resumes where it stopped after a restart. The site works meanwhile: blocks, transactions and addresses come from the node, the newest 100 rows follow the tip, and the mining pages cover the rows filled so far. The mempool chart starts empty and fills a minute at a time; audits start with the first block the server watches arrive.

| | |
|---|---|
| How long | On mainnet about 19 hours, [measured](#one-day-on-mainnet), on a node with the block listing route; through `getblock` on v0.9.2, which lacks it, about a day more for the fee rates, estimated ([`STORE.md`](STORE.md#backfill)) |
| What the node reads | About 18 GB with the listing route; about 550 GB through `getblock`, estimated. A node on the same host matters here |
| Gentler | `BACKFILL_BUSY_PERCENT` (default 50), the share of time it keeps the node busy. `BACKFILL_FEE_RATE_DEPTH` (default 52560, a year); `0` skips fee rates, computed on demand instead ([`CONFIG.md`](CONFIG.md#block-table)) |
| Pause | `BACKFILL_ENABLED=false` and `docker compose up -d`; set it back to resume |
| Progress | `block_backfill_progress` every minute while it writes: `rows` and `rated` against `tip`. A line without them means the count timed out |

### After a restart

No backfill, but, as observed in the deployment:

- **Fee routes** answer `503` `not ready yet; retry` for some seconds. `fees_fallback_started` with `warming_up` follows every start; the first `fees_summary`, a minute in, names the `source` served ([`API.md`](API.md)).
- **The Lightning pages** take up to a minute: `lightning_started` with `graph` `loaded`, `lightning_synced` with `from_disk`, then `lightning_index_built`, when `/readyz` `lightning` turns `synced`. Measured: graph loaded in 62 ms, synced in 20 s.
- **Everything else** answers as soon as the node does.

### Watching it

**The log** is one JSON object per line on stdout: `ts`, `level`, `event`, then the event's fields, all listed in [`LOGGING.md`](LOGGING.md). The compose file's `local` driver rotates it. Read it with:

```sh
docker compose logs --no-log-prefix server | jq -c 'select(.level != "info")'
```

**A healthy minute** without visitors: one `mempool_summary` and one `fees_summary` per network, `block_backfill_progress` while a backfill writes, `tracking_summary` for a network that saw a replacement, `lightning_summary` with Lightning on, then `block_audited`, `mempool_block`, `difficulty_computed` and two to four `ws_fanout` when a block arrives, and one `http_request` per request (`LOG_REQUESTS=failures` keeps only errors). Refused requests are counted in one `requests_refused` a minute ([`LOGGING.md`](LOGGING.md#for-operators)). [Measured](#one-day-on-mainnet): 11 lines a minute, 6.1 MB a day, two `warn` lines in five and a half hours (`mempool_poll_failed` with `timeout`).

Normal, not alarms: `electrum_unreachable`, `mempool_poll_failed` and `block_rows_failed` in the first seconds after a start; `fees_fallback_started` (`info`) with `warming_up`, meaning our fee recommendations are not served yet: nothing until the first whole minute of arrivals is watched, then the node's estimates, capped, until five minutes have passed ([`MEMPOOL.md`](MEMPOOL.md#while-warming-up)); `chain_reorg` and `block_rows_reorged`, several a day on testnet4.

**Alert on:**

| Event or check | Means |
|---|---|
| Any `error`: `config_invalid`, `listen_failed`, `rpc_auth_failed`, `rpc_wrong_network`, `store_open_failed`, `store_wrong_chain`, `panic` | Act now: [when it goes wrong](#when-it-goes-wrong) |
| `store_read_failed` | A read the store refused; `read` names which (`lightning_index` is the Lightning pages' index) and `error` why. Pages that need it fail or fall back to the node |
| `lightning_index_failed`, or `/readyz` `lightning` `failed` | The Lightning pages answer `503`. `stage` and `error` say why |
| `store_write_failed`, or `/readyz` `store` not `ok` | History is not recorded. `failing`: `error` says why (`disk_full`, `read_only`, `corrupt`, `busy`, `io`). `waiting` over a minute: the node is unreachable or on another chain, or `store_chain_unverified` |
| `address_index_off`, or `/readyz` `address_index` `off` | The node runs without `--sh-index`: address pages are down |
| `/readyz` not `200` for more than a few minutes | The node is down, unreachable or refusing our password |
| `tip_age_secs` over two hours on mainnet | The node has stopped following the chain |
| `rpc_unreachable`, `electrum_unreachable`, `mempool_poll_failed`, `block_rows_failed` repeating | The node is failing or overloaded. Logged at the 1st, 2nd, 4th, 8th… in a row, so a rising count is a long outage |
| `store_slow_write`, `store_read_timed_out`, `replacements_store_failed`, `mempool_history_skipped` with `store_failed` | The disk is slow or full, or the machine stalls: the read limit is wall-clock time ([`STORE.md`](STORE.md#using-it)) |
| `proxy_header_ignored` | Every visitor shares the proxy's allowance ([client addresses](#client-addresses)) |
| `connections_refused` | One address holds many connections |
| `accept_failed` | Out of file descriptors; nobody is accepted ([many WebSockets](#many-websockets)) |
| `requests_refused` every minute | One address flooding, or a proxy set up wrong; its fields say which ([`LOGGING.md`](LOGGING.md#refusals)) |
| `log_events_dropped` | `queue_full`: the log's output cannot keep up; `over_budget`: past the log's ceiling ([`LOGGING.md`](LOGGING.md#for-operators)) |

**Memory and CPU:** `docker stats`. The figures to expect are in [the host](#the-host); memory grows with open WebSockets and the block summary cache, not with time.

### One day on mainnet

The figures marked measured in this guide come from one server, on one machine, from 2026-11-12 09:11 UTC to 2026-11-13 10:13 UTC: mainnet, signet and testnet4, each with the mempool engine and the backfill on from an empty store, and Lightning on mainnet. The nodes were on another host of the same private network and had the block listing route ([`STORE.md`](STORE.md#backfill)). The server was restarted twelve times for new builds and had no visitors from 21:52; the site was offline from about 23:11 to 03:40, which did not stop the backfill. Memory and CPU were read at the end, 11 hours after the last restart.

| | Measured | Not confirmed |
|---|---|---|
| Memory, CPU | 251 MB resident, about 6% of one core, all three networks | Mainnet alone; without Lightning; with real visitors |
| Stores | 547 MB mainnet (975,660 block rows, a year of fee rates, a day of audits and mempool history, 36,200 Lightning channels), 133 MB signet, 72 MB testnet4; Lightning graph and saved answers 35 MB | Growth per year: 150 MB for audits is an estimate |
| Backfill | Mainnet: every block's totals in 18 h 11 min, the year of fee rates 59 min later; signet 3 h 13 min and 5 h 20 min; testnet4 1 h 21 min and 2 h 17 min | A run with no restarts; a node without the listing route |
| Node load, mempool | 120 MB a minute of RPC answers on mainnet with 39,000 transactions in the mempool, 200 MB with 63,000; about 45 tracker cycles a minute of 2.6 to 4.3 MB each; the slowest cycle in a minute took 230 ms at the median | |
| Lightning | First sync from an empty directory 273 s (36,826 outputs looked up in 126 requests, 56 MB of gossip). A restart from its own files: graph loaded in 62 ms, synced in 20 s, one lookup | A first sync with the build that paces lookups (PR #89) |
| Log | 6.6 MB a day; without visitors 11 lines a minute | |
| Requests and WebSockets | 4,255 requests over the first 13 hours, 3,109 of them in one hour, and 166 WebSocket upgrades; at most two clients on a topic | The cost of real traffic |

### Many WebSockets

Every open page holds one WebSocket. At the default `WS_MAX_SOCKETS` (1,024) the host needs nothing more than the compose file sets. For more, raise `WS_MAX_SOCKETS` ([`CONFIG.md`](CONFIG.md#websocket)) and check each line. Measured on Linux up to 20,000 sockets, every message delivered ([`PERFORMANCE.md`](PERFORMANCE.md#on-linux)); what stopped it each time was one of these.

| Limit | Needed | Check | When it is short |
|---|---|---|---|
| The server's open files | More than `WS_MAX_SOCKETS` + `WS_V1_MAX_SOCKETS` + `MAX_CONNECTIONS`, plus about 100. The compose file sets 65,536; Docker's default can be 1,024, too few even for the default caps | `grep 'open files' /proc/$(docker inspect -f '{{.State.Pid}}' $(docker compose ps -q server))/limits` (the image has no shell) | `accept_failed` with `Too many open files`: new visitors time out, and the server's own new connections to the node fail |
| `WS_MAX_SOCKETS` | The sockets you expect, every network together | `ws_max_sockets` in `server_starting` | New sockets get `503`, counted in `requests_refused` with `server_sockets` |
| `net.core.somaxconn` | 4,096, Linux's default since 5.4. The server asks for the host's maximum | `sysctl net.core.somaxconn` | After a restart, pages reconnecting past the listen queue retry after 1 s, then 2 s. Slower; nothing fails. `nstat -az TcpExtListenOverflows` counts them |
| Local ports on the proxy's host | One per socket, each a connection from the proxy to the server's one address and port. The default range, 32768 to 60999, allows 28,232, those closed in the last minute included | `sysctl net.ipv4.ip_local_port_range` | The proxy logs `address not available`; visitors get `502`. Widen it: `sysctl -w net.ipv4.ip_local_port_range="1024 65535"`, and in `/etc/sysctl.d/` to keep it |
| The proxy's open files | Two per socket | Its service's limit (for Caddy under systemd, `LimitNOFILE`) | The proxy's own errors |
| Memory | 16 KB a socket on top of [the host's figures](#the-host): about 5 KB in the server, 6 KB in the kernel. 128 MB in the server with 20,000 | `docker stats` | |
| CPU | With 20,000 sockets, a new block reached the last client 54 ms (median) after queueing, on a quarter of a core on average; on one core instead of four, three times slower | `docker stats` | Updates arrive later. Nothing is dropped unless one client's own queue fills (`ws_clients_dropped`, `too_slow`) |

Not measured: connection tracking (`nf_conntrack_max`; a socket through the proxy and Docker's published port can take two entries); Docker's proxy process for the published port, with the daemon's limits; `net.ipv4.tcp_mem`, whose default on a host with a few GB is far above the 52 MB of socket buffers measured for 16,000 sockets.

### Upgrading

**Tags.** Each release is published once as `ghcr.io/smolcars/rbitcoin-space:X.Y.Z`, never moved, and as `latest`, which moves. Pin `X.Y.Z` in `SERVER_IMAGE`: `latest` would upgrade the store whenever compose pulls. Every image is for linux/amd64 and linux/arm64 and carries a signed record of the commit and workflow that built it:

```sh
gh attestation verify oci://ghcr.io/smolcars/rbitcoin-space:0.5.0 --repo smolcars/rbitcoin-space
```

**Migrations are one-way, so back up first.** A new release may add tables to the store; it applies each once at start and logs `store_migration_applied`. An older release refuses a store a newer one migrated.

To upgrade, read the release's notes, then, from `deploy/`:

```sh
VERSION=0.5.0
git fetch --depth 1 origin tag "v$VERSION" && git checkout "v$VERSION"
mkdir -p backup                             # then the backup command in "The data directory"
sed -i.bak "s|^SERVER_IMAGE=.*|SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space:$VERSION|" .env && rm .env.bak
docker compose up -d
docker compose logs --no-log-prefix server | grep store_migration_applied
```

- If the server stops with `config_invalid`, the new release refuses a setting the old one accepted: the line names it, and the notes say what changed. Nothing is migrated until it is fixed.
- The tag brings that release's compose file, which may pin a newer rbitcoin: compose then recreates the node too, which flushes its state on the way down (it has five minutes).
- Where the node is in [another compose project](#the-node-in-another-compose-project), replace the server alone: `docker compose pull server && docker compose up -d --no-deps server`.

**Rolling back.** If the new release logged `store_migration_applied`, the old one cannot open the store: it logs `store_open_failed` (`database schema version … is newer than this build supports …`), `/readyz` stays `200` with `store` `open_failed`, and the mining pages and history answer `503`. Restore the backup with the server stopped, and start only the old image (`docker compose start` would restart the new one, which migrates the backup again):

```sh
VERSION=0.1.0                               # the release you go back to
docker compose stop server
docker run --rm -v rbitcoin-space_server-data:/data -v "$PWD/backup":/backup:ro alpine:3 \
  sh -c 'rm -f /data/mainnet.sqlite-wal /data/mainnet.sqlite-shm && cp /backup/mainnet.sqlite /data/ && chown 65532:65532 /data/mainnet.sqlite'
git fetch --depth 1 origin tag "v$VERSION" && git checkout "v$VERSION"
sed -i.bak "s|^SERVER_IMAGE=.*|SERVER_IMAGE=ghcr.io/smolcars/rbitcoin-space:$VERSION|" .env && rm .env.bak
docker compose up -d
```

What was observed between the backup and the rollback is lost. Without a backup, delete `mainnet.sqlite`: the old release starts empty and backfills. Without a migration, only the image changes.

#### Images of `master`

Every merge to `master` that changes the image is published as `sha-<full commit>`, never moved, and as `master`, which moves forward only. They pass the same checks and carry the same attestation, but no release notes and no promise: a release is what to run, a `master` image is for trying a change first. Its `version` is the one in `Cargo.toml`. Moving to one, between one and a release, or from one to the next is an upgrade like any other. From `deploy/` in the checkout:

1. Back up ([the data directory](#the-data-directory)): migrations are one-way.
2. Pull the newest `master` image, pin it by digest so a pull never changes it, and check out the compose file of its commit (`.env` and `rpc.cookie` are git-ignored and stay):

   ```sh
   docker pull ghcr.io/smolcars/rbitcoin-space:master
   image=$(docker image inspect -f '{{index .RepoDigests 0}}' ghcr.io/smolcars/rbitcoin-space:master)
   rev=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
   git fetch --depth 1 origin "$rev" && git checkout "$rev"
   sed -i.bak "s|^SERVER_IMAGE=.*|SERVER_IMAGE=$image|" .env && rm .env.bak
   ```

3. Replace the server alone, and check:

   ```sh
   docker compose up -d --no-deps server
   curl -s http://127.0.0.1:8080/healthz; echo; echo "$rev"   # its "revision" is the commit printed below it
   ```

Without a checkout, run the first three lines of step 2 (the pull, `image` and `rev`), then put `$image` where the image is named: in [the node on another host](#the-node-on-another-host), remove the container and run its step 2 with `$image` in place of the release; in [another compose project](#the-node-in-another-compose-project), set the service's `image:` to it and run `docker compose up -d --no-deps server`.

The deployment follows `master` this way.

### Switching features

All in [`CONFIG.md`](CONFIG.md): change `.env` and run `docker compose up -d`.

- **Broadcast:** `BROADCAST_ENABLED=false` turns off `POST /api/tx`, the only write the server makes to the node.
- **The live mempool,** per network: `MAINNET_MEMPOOL_ENABLED=false` stops the tracker, projected blocks, our own fee recommendations, mempool history and audits for that network, and spares the node about 150 MB a minute of RPC on mainnet. Everything else keeps working.
- **Limits** (rate limits, WebSocket caps, timeouts) have safe defaults ([`CONFIG.md`](CONFIG.md#limits)). Raise the per-client ones if many of your users share one address.

#### Lightning

Off unless `MAINNET_LIGHTNING_ENABLED=true` ([`CONFIG.md`](CONFIG.md#lightning)). On, the server **connects out to public Lightning nodes** (TCP 9735 by default, at addresses in [`LIGHTNING.md`](LIGHTNING.md#peers)) and keeps three connections open. Nothing is published or listened on, so the compose file needs no change. Behind an outbound firewall, allow TCP to the peers, or list peers you can reach in `MAINNET_LIGHTNING_PEERS`. The peer does not speak Tor: under a Tor-only egress policy, leave it off or point it at a clearnet node of your own.

It keeps a 32-byte node key (created on first start, readable by the server's user only; it identifies the peer and holds no funds), its graph and saved answers (35 MB with 36,200 channels) in `/data/lightning/mainnet/`. Deleting that directory costs a fresh sync (273 s and 56 MB of gossip); deleting the SQLite file loses the record of closed channels ([`STORE.md`](STORE.md#ln_channels)). Plan for 250 to 330 MB more memory.

#### Add a network

The compose file runs one node. For a second, add a node service with its own name and volumes, and give the server that network's six variables. For signet beside mainnet, in `compose.yml`:

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

It is served under `/signet` ([`ARCHITECTURE.md`](ARCHITECTURE.md#networks)). P2P ports: mainnet 8333, signet 38333, testnet4 48333, testnet5 18353 ([Testnet 5](#testnet-5)), regtest 18444.

### Security checklist

From [`SECURITY.md`](SECURITY.md), for the operator:

- [ ] The node's RPC, Esplora and Electrum are reachable by the server only: the compose network and the socket, or a private network. Only P2P is published.
- [ ] The server's port is on loopback (`HTTP_PUBLISH` unchanged) and reached only through the proxy or, with a proxy in a container or a tunnel, not published at all.
- [ ] The site is HTTPS only on its domain: `curl -sI http://explorer.example.com/` must not answer `200`. The onion address is plain HTTP by design. Behind Cloudflare, Always Use HTTPS is on.
- [ ] `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXIES` are set only once the proxy overwrites the header, name the proxy's address and nothing clients can reach, and the [check](#client-addresses) showed your own address.
- [ ] The network's gateway is not in `TRUSTED_PROXIES` if the server's port is published beyond loopback.
- [ ] `LOG_CLIENT_ADDR` is off, unless you mean to keep a record of who looked at what.
- [ ] `.env`, `server.env` and `rpc.cookie` are readable by their owners only, and the password is long and random.
- [ ] Behind a tunnel: `cloudflared/credentials.json` is mode `400`, owned by 65532, and nowhere else but your backups; `cert.pem` is not on the server.
- [ ] As an onion service: `172.30.111.3` is not in `TRUSTED_PROXIES`, and the key backup is owner-only and offline.
- [ ] The limits are at their defaults or raised for a stated reason; none is switched off (none can be).
- [ ] `BROADCAST_ENABLED=false` if you do not want the site to relay transactions.
- [ ] The image is pinned to a version, and you watch the releases for security fixes.

Report a vulnerability privately through [GitHub's security advisories](https://github.com/smolcars/rbitcoin-space/security/advisories/new) on this repository.

### When it goes wrong

Read [the log](#watching-it) and `/readyz`.

| Symptom | The log says | Do |
|---|---|---|
| The server stops at once | `config_invalid` with the variable's name (never its value) | Fix that variable. A network needs all six of its variables or none ([`CONFIG.md`](CONFIG.md#networks)) |
| Pages load but nothing from the chain; `/readyz` `503` with `rpc` `unreachable` | `rpc_unreachable`, `electrum_unreachable` and `mempool_poll_failed` with `unavailable`, repeating | The node is down or its address is wrong: `docker compose ps`, `docker compose logs node`, then the `*_HOST`, `*_PORT` and `*_ADDR` settings |
| `/readyz` `503` with `rpc` `wrong_network` and `store` `waiting`; pages show another chain's blocks | `rpc_wrong_network` with `network`, the one configured, and `node_chain`, the node's | The `{NET}_*` variables point at another network's node, often a `MAINNET_*` line left beside a test network's. Fix them and `docker compose up -d`. Nothing was written to the store meanwhile ([`STORE.md`](STORE.md#chain)); a node repointed while the server ran may have had up to 30 s of its data written |
| `/readyz` `503` with `rpc` `auth_failed` | `rpc_auth_failed`, then `mempool_poll_failed` with `auth` | The password in `.env` and the one in `rpc.cookie` differ. Make them equal and `docker compose up -d --force-recreate` |
| Address pages show an error; `/readyz` `address_index` `off` | `address_index_off`, and `http_request` with `status` `503` and `endpoint` `script_stats` or `script_txs` | Turn on the node's `--sh-index` and restart the node; the server asks again on reconnect and logs `address_index_on` |
| Visitors get `429` on pages they barely used | `proxy_header_ignored`; `requests_refused` every minute with `untrusted_forwarded` or `proxy_keyed` close to `total` | [Client addresses](#client-addresses) are not set up. `untrusted_forwarded`: `TRUSTED_PROXIES` is not the proxy's address; `proxy_keyed`: the proxy does not send `TRUSTED_PROXY_HEADER` |
| Live updates never arrive | `ws_origin_refused` with the `origin` and `host` it compared | The proxy changes `Host`. Pass it through as the browser sent it, port included |
| Same, but no `ws_origin_refused` | `http_request` on a route ending `/app/ws` with `status` `400` | The proxy does not forward the upgrade ([any other proxy](#any-other-proxy)) |
| `/readyz` `store` `open_failed`, another chain | `store_open_failed` with `… was written for another chain (genesis …)` | The file belongs to another network. The hash names it: `000000000019d6…` mainnet, `00000008819873…` signet, `00000000da84f2…` testnet4, `00000000000008c1…` Testnet 5, `0f9188f13cb7b2…` regtest. Move the file out of the volume (keep it for the right network) and restart: an empty one is created and backfilled |
| `/readyz` `store` `open_failed`, other reasons | `store_open_failed` with `database or disk is full`; `unable to open database file` (uid 65532 cannot write the directory: no volume at `/data`, or one another user owns); or `cannot create` (`DATA_DIR` outside the volume) | Fix what it names, then `docker compose restart server`. A new, empty volume gets the image's owner; one that holds files keeps its own: `docker run --rm -v rbitcoin-space_server-data:/data alpine:3 chown -R 65532:65532 /data` |
| The store stopped after a rollback | `store_open_failed` with `database schema version 5 is newer than this build supports (2)` | [Restore the backup](#upgrading) or delete the file |
| `/readyz` `store` `wrong_chain`; no new mining rows, audits or mempool chart | `store_wrong_chain` with the `height` of a row the node does not have | A file from an earlier release, before files recorded their chain, holds another chain's blocks. With the server stopped, move it out of the volume and start: an empty one is backfilled |
| `/readyz` `store` stays `waiting` though `rpc` is `ok` | `store_chain_unverified` with the file's lowest `height` and the node's `node_height` | An earlier release's file that cannot be checked yet. The node is more than 100 blocks behind its rows: writes resume once it catches up. Or the rows span fewer than 100 blocks: with the server stopped, move it out and start again |
| The disk filled: no new rows, audits or mempool chart; `/readyz` `store` `failing` | `store_write_failed` with `disk_full`; `block_rows_failed` with `store` | Free space. No restart needed: the next write logs `store_write_recovered`. Block rows are filled in; missed mempool minutes are a gap |
| `/readyz` `store` `failing`, other reasons | `store_write_failed` with `read_only` (a read-only mount, or not owned by uid 65532), `corrupt`, `busy` (another process holds the lock, such as a long backup) or `io` | `read_only`: fix the mount or ownership, then `docker compose restart server`. `corrupt`: [restore a backup](#the-data-directory) or delete the file. `busy`: let the other process finish |
| `docker compose up` or a pull hangs on a host nobody is logged in to | | A Docker credential helper (`credsStore` in `~/.docker/config.json`) waits for an unlock prompt. The release image needs no login: pull with `DOCKER_CONFIG` pointing at a directory whose `config.json` sets no `credsStore` |
| `docker pull` from ghcr.io does not work at all | | Load the rbitcoin image another way and set `RBITCOIN_IMAGE=ghcr.io/rbitcoin-org/rbitcoin:0.9.2`: a loaded image has no digest to match the compose file's pin |
| `failed to bind host port 127.0.0.1:8080/tcp: address already in use` | Nothing: the server never started | Set `HTTP_PUBLISH` to a free port, and point the proxy at it |
| The disk fills with logs | | The compose file's `local` driver rotates (100 MB a container). A container started another way uses `json-file`, which does not: add `--log-driver local` |

### The image

```sh
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t rbitcoin-space .
```

Without the argument it reports `revision` `unknown`, since `.git` is not in the build context. The [`Dockerfile`](../Dockerfile) has three stages, from base images that are multi-arch and pinned by digest, from Docker Hub or `gcr.io`:

| Stage | From | Does |
|---|---|---|
| `web` | `oven/bun` | `bun install --frozen-lockfile` and `bun run build`, on the build platform only: the output is the same on every architecture |
| `server` | `rust` (Debian 13) | `cargo build --release --locked -p rbitcoin-space`, with the registry and `target/` as BuildKit cache mounts. Every source is touched first: cargo trusts cached output newer than its sources, and a context's times can be older (`git archive` gives each file its commit's time), which once left a new migration out of an image silently. The Rust tag must match `rust-toolchain.toml`, which is not copied in |
| final | `gcr.io/distroless/cc-debian13:nonroot` | The binary at `/usr/local/bin/rbitcoin-space`, the frontend at `/srv/web`. No shell, no package manager |

- Defaults inside: `LISTEN_ADDR=0.0.0.0:8080` and `WEB_DIR=/srv/web`; `WEB_DIR=` runs it as API only. No `DATA_DIR`: without it the server keeps no store.
- It runs as uid and gid 65532 with no capabilities and writes only to `/data`, so it runs with a read-only root filesystem. **It needs no writable `/tmp`:** SQLite keeps temporary data in memory ([`STORE.md`](STORE.md#temporary-data)), so do not add a tmpfs. Releases before 2026-11-14 needed one at mainnet's size.
- Its health check is the binary: `rbitcoin-space healthcheck` asks `/healthz` at `LISTEN_ADDR` and exits 0 on a 200. Do not use port 0 in a container: there is nothing to check.
- [`.dockerignore`](../.dockerignore) is an allow-list: `Cargo.toml`, `Cargo.lock`, `crates/`, `dev/load/` (a workspace member), `web/` (without `node_modules/` and `dist/`), and `design/`'s `tokens.css`, `logo.svg` and `fonts/`. `.env`, `target/` and the rest stay out.
- Measured: 57.9 MB unpacked for arm64 (2026-11-13); 16.6 MB compressed for amd64 and 17.0 MB for arm64 (2026-11-12). A cold build takes about 2 minutes on GitHub's runners, 18 s on an Apple Silicon Mac with the base images pulled. The [release workflow](CI.md#releases) builds and publishes both architectures.

Check those claims on any image:

```sh
docker image inspect -f '{{.Config.User}}' ghcr.io/smolcars/rbitcoin-space:0.5.0      # 65532:65532
c=$(docker create ghcr.io/smolcars/rbitcoin-space:0.5.0)
docker export "$c" | tar -t | grep -E '^(usr/)?(local/)?s?bin/.'                         # usr/local/bin/rbitcoin-space, alone
docker rm "$c"
```

#### Hardening in the compose file

| Choice | Applies to | Why |
|---|---|---|
| `read_only: true` | both | A compromised process cannot drop files or alter its binary; each writes only its own `/data` volume. Neither needs a writable `/tmp`, which the release workflow proves against a mainnet-sized store |
| `cap_drop: [ALL]` | both | Neither binds a port below 1024 or needs any other privilege |
| `no-new-privileges` | both | A setuid binary cannot raise privileges. Neither image has one; this keeps it so |
| Non-root users | both | The server runs as 65532, the node as 10001, as their images set |
| Only P2P published | node | RPC and Electrum on the compose network, Esplora on a socket. The browser never reaches the node ([`SECURITY.md`](SECURITY.md) rule 1) |
| Server on loopback | server | Reached through the reverse proxy alone. No proxy header is trusted until you set one up |
| Socket volume is tmpfs, owner 10001, mode 0750 | both | The socket never outlives the stack, and only the node's uid and group can enter |
| `group_add: ["10001"]` | server | rbitcoin creates the socket 0660, owned by 10001:10001. The server joins that group instead of running as the node's uid |
| Socket volume read-only | server | Connecting to a socket needs no write access to its directory |
| Credentials in `.env` and `rpc.cookie` | both | Nothing secret in an image or in `compose.yml`. The cookie is a file, not compose `content`, which compose cannot copy into a read-only container |
| `local` logging driver | both | Docker's default `json-file` never rotates; `local` keeps five files of 20 MB |
| `ulimits: nofile: 65536` | server | One descriptor per open socket ([many WebSockets](#many-websockets)) |
| `stop_grace_period: 5m` | node | rbitcoin flushes its store on SIGTERM |
| Images pinned by digest | node | The tag cannot be moved under a running deployment |
