FROM rust:1.85-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig
WORKDIR /app
COPY relay/Cargo.toml ./
COPY relay/src ./src
RUN cargo build --release

FROM alpine:latest
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/target/release/pandora-relay /usr/local/bin/pandora-relay
ENV DATA_DIR=/data PORT=8080 TTL_MINUTES=30 MAX_BYTES=2147483648
EXPOSE 8080
VOLUME ["/data"]
CMD ["pandora-relay"]
