#!/usr/bin/env bash
# Build the Relay production images (web, worker, migrate) with docker buildx.
#
#   infra/oracle/build.sh                         # native platform, loaded into the local Docker (on the VM: arm64)
#   infra/oracle/build.sh --platform linux/arm64  # cross-build (needs QEMU/binfmt on a non-arm64 machine)
#   infra/oracle/build.sh --platform linux/arm64 --tar relay-images.tar   # for `docker load` on the VM
#   infra/oracle/build.sh --check-only --platform linux/arm64,linux/amd64 # build both, keep nothing (CI-style check)
#
# Options: --tag <tag> (default <yyyymmdd>-<git short sha>[-dirty]), --platform <list>, --tar <file>, --check-only,
#          --node-image <ref> (base image override, e.g. a registry mirror). Prints the tag on the last line.
# In proxied sandboxes HTTPS_PROXY and the proxy CA (/root/.ccr/ca-bundle.crt) are passed through as a BuildKit secret
# that never reaches the runtime images.
set -euo pipefail
SELF=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$0")/../.."

TAG="" PLATFORM="" TAR="" CHECK_ONLY=0 NODE_IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=$2; shift 2 ;;
    --platform) PLATFORM=$2; shift 2 ;;
    --tar) TAR=$2; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --node-image) NODE_IMAGE=$2; shift 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TAG" ]; then
  sha=$(git rev-parse --short=10 HEAD 2>/dev/null || echo nogit)
  dirty=$(git status --porcelain 2>/dev/null | head -1)
  TAG="$(date -u +%Y%m%d)-${sha}${dirty:+-dirty}"
fi
case "$TAG" in *[!A-Za-z0-9._-]*) echo "invalid tag: $TAG" >&2; exit 2 ;; esac
if [ -z "$PLATFORM" ]; then
  case "$(docker info --format '{{.Architecture}}')" in
    aarch64|arm64) PLATFORM=linux/arm64 ;;
    *) PLATFORM=linux/amd64 ;;
  esac
fi
if [[ "$PLATFORM" == *,* && $CHECK_ONLY -eq 0 ]]; then
  echo "Several platforms at once only with --check-only (a local image store holds one platform per tag)." >&2; exit 2
fi

export TAG PLATFORM
[ -n "$NODE_IMAGE" ] && export NODE_IMAGE
SETS=()
if [ -n "${HTTPS_PROXY:-}" ]; then
  SETS+=(--allow=network.host --set "*.network=host" --set "*.args.HTTPS_PROXY=$HTTPS_PROXY" --set "*.args.https_proxy=$HTTPS_PROXY" --set "*.args.NO_PROXY=${NO_PROXY:-}")
fi
# shellcheck disable=SC2054 # the comma is part of the secret spec, not an array separator
[ -f /root/.ccr/ca-bundle.crt ] && SETS+=(--set "*.secrets=id=extra_ca,src=/root/.ccr/ca-bundle.crt")
if [ $CHECK_ONLY -eq 1 ]; then SETS+=(--set "*.output=type=cacheonly"); else SETS+=(--load); fi
echo ">> building relay-{migrate,worker,web}:$TAG for $PLATFORM" >&2
docker buildx bake -f infra/oracle/docker-bake.hcl "${SETS[@]}" >&2

if [ -n "$TAR" ] && [ $CHECK_ONLY -eq 0 ]; then
  docker save -o "$TAR" "relay-migrate:$TAG" "relay-worker:$TAG" "relay-web:$TAG"
  echo ">> saved $TAR (copy it to the VM, then: sudo infra/oracle/update.sh --images-tar <file> --tag $TAG)" >&2
fi
echo "$TAG"
