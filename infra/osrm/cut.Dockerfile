FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    osmium-tool=1.15.0-1 time=1.9-0.2 wget=1.21.3-1+deb12u1 ca-certificates=20250419~deb12u2 \
  && rm -rf /var/lib/apt/lists/*
