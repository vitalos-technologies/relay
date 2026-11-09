# syntax=docker/dockerfile:1.7
# Tiny helper image for the Relay kit: age (backup encryption), tar, coreutils. Always run with --network none.
ARG ALPINE_IMAGE=alpine:3.22
FROM ${ALPINE_IMAGE}
# Optional egress-proxy CA for restricted build environments (BuildKit secret "extra_ca"); used for apk only.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    apk add --no-cache age tar coreutils
