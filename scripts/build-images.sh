#!/usr/bin/env bash
# Build web + worker images. In proxied sandboxes, pass the proxy and its CA through (see infra/docker/Dockerfile).
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=${1:-local}
ARGS=()
if [ -n "${HTTPS_PROXY:-}" ]; then ARGS+=(--network host --build-arg "HTTPS_PROXY=$HTTPS_PROXY" --build-arg "https_proxy=$HTTPS_PROXY" --build-arg "NO_PROXY=${NO_PROXY:-}"); fi
if [ -f /root/.ccr/ca-bundle.crt ]; then ARGS+=(--secret id=extra_ca,src=/root/.ccr/ca-bundle.crt); fi
for t in worker web; do
  docker build -f infra/docker/Dockerfile --target "$t" -t "social-lite-$t:$TAG" "${ARGS[@]}" .
done
