# Bake definition for the three Relay production images (one build, one context snapshot, shared stages).
# Used by infra/oracle/build.sh; variables come from the environment (TAG, PLATFORM, NODE_IMAGE).
variable "TAG" { default = "dev" }
variable "PLATFORM" { default = "linux/arm64" }
variable "NODE_IMAGE" { default = "node:22-bookworm-slim" }

group "default" { targets = ["migrate", "worker", "web"] }

target "_common" {
  context    = "."
  dockerfile = "infra/oracle/Dockerfile"
  platforms  = split(",", PLATFORM)
  args       = { RELAY_VERSION = TAG, NODE_IMAGE = NODE_IMAGE }
}
target "migrate" {
  inherits = ["_common"]
  target   = "migrate"
  tags     = ["relay-migrate:${TAG}"]
}
target "worker" {
  inherits = ["_common"]
  target   = "worker"
  tags     = ["relay-worker:${TAG}"]
}
target "web" {
  inherits = ["_common"]
  target   = "web"
  tags     = ["relay-web:${TAG}"]
}
