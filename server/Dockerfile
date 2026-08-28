FROM rust:1.89-bookworm AS builder
RUN rustup component add rustfmt
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 wget && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/target/release/biclex-hub-server /usr/local/bin/biclex-hub-server
EXPOSE 8123/tcp 40000-40100/udp
ENTRYPOINT ["/usr/local/bin/biclex-hub-server"]
