# syntax=docker/dockerfile:1
# The rbitcoin.space server and its built frontend in one image. docs/DEPLOY.md explains it.
# Base images are multi-arch (linux/amd64, linux/arm64) and pinned by digest.

# The Rust tag must match rust-toolchain.toml. That file is not copied in: rustup would
# download rustfmt and clippy, which a release build does not need.
ARG RUST_IMAGE=docker.io/library/rust:1.99.1-slim-trixie@sha256:f6c4a35d21dbb3c89d7a8d056c193e94fc09037f2b58dd858b09c39a47dd02d7
ARG BUN_IMAGE=docker.io/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
# Debian 13 like the Rust image, so the binary finds the glibc it was linked against.
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:cc66d222f0a7ec996b78a99fe76a969bc80b539a5016ad866c14d1949bc6d0ab

# The frontend is the same on every architecture, so it is built once, natively.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY web/ ./
# The app imports its tokens, logo and font from design/, beside web/.
COPY design/tokens.css design/logo.svg /src/design/
COPY design/fonts/ /src/design/fonts/
# The docs' /openapi.json names the server's version, from the workspace's Cargo.toml.
COPY Cargo.toml /src/Cargo.toml
RUN bun run build

FROM ${RUST_IMAGE} AS server
ARG TARGETPLATFORM
# The commit being built, reported at /healthz; the context has no .git to read it from.
# `unknown` when not given. release.yml passes the same commit as the image's revision label.
ARG SOURCE_REVISION=unknown
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
# A workspace member: cargo reads every member's manifest even to build one package.
COPY dev/load/ dev/load/
# Cached target/ and registry: a change recompiles our own crates, never the dependency tree.
# Cargo trusts a cached output newer than its sources' mtimes, and a context's mtimes need not
# be newer (`git archive` stamps every file with its commit's time), so they are made new here.
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target-$TARGETPLATFORM,target=/src/target \
    find Cargo.toml Cargo.lock crates dev -exec touch {} + \
    && cargo build --release --locked -p rbitcoin-space \
    && cp target/release/rbitcoin-space /rbitcoin-space \
    && mkdir /data

FROM ${RUNTIME_IMAGE}
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=${SOURCE_REVISION}
COPY --from=server /rbitcoin-space /usr/local/bin/rbitcoin-space
COPY --from=web /src/web/dist /srv/web
# The one writable place, for the SQLite store. A volume mounted here starts with this owner.
COPY --from=server --chown=65532:65532 /data /data
ENV LISTEN_ADDR=0.0.0.0:8080 \
    WEB_DIR=/srv/web
EXPOSE 8080
# distroless "nonroot": uid and gid 65532. Only /data, for a volume, is writable by it.
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=6s --start-period=10s --start-interval=1s \
    CMD ["/usr/local/bin/rbitcoin-space", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/rbitcoin-space"]
