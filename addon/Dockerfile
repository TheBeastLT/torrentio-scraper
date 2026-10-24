FROM --platform=$BUILDPLATFORM rust:1-alpine AS build
ARG TARGETARCH
RUN apk add --no-cache musl-dev build-base cmake zig
RUN cargo install --locked cargo-zigbuild
RUN case "$TARGETARCH" in \
      amd64) echo x86_64-unknown-linux-musl ;; \
      arm64) echo aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac > /rust-target
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN rustup target add "$(cat /rust-target)" \
    && cargo zigbuild --release --locked --target "$(cat /rust-target)" -p torrentio-addon \
    && cp "target/$(cat /rust-target)/release/torrentio-addon" /torrentio-addon

FROM alpine:3
RUN apk add --no-cache ca-certificates
WORKDIR /home/app
COPY --from=build /torrentio-addon /usr/local/bin/torrentio-addon
COPY static static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
