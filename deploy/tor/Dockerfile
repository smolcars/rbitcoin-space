# Tor for the onion service beside the server (deploy/compose.onion.yml). release.yml publishes it
# as ghcr.io/smolcars/rbitcoin-space-tor:<TOR_VERSION>; docs/DEPLOY.md says how to bump it.
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
# Alpine's build has the proof-of-work defence (`tor --list-modules` prints `pow: yes`).
ARG TOR_VERSION=0.4.9.17-r0
RUN apk add --no-cache "tor=$TOR_VERSION"
# The package's user, uid 100. Its data directory is the volume compose mounts.
USER tor
ENTRYPOINT ["tor"]
