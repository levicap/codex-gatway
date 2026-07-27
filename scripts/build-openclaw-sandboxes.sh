#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$(mktemp -d /tmp/openclaw-sandbox-source.XXXXXX)"

cleanup() {
  rm -rf -- "$source_dir"
}
trap cleanup EXIT

docker build \
  --tag openclaw-sandbox:bookworm-slim \
  --file "$repo_root/openclaw/Dockerfile.sandbox" \
  "$repo_root"

git clone \
  --quiet \
  --depth 1 \
  --branch v2026.7.1 \
  https://github.com/openclaw/openclaw.git \
  "$source_dir"

docker build \
  --tag openclaw-sandbox-browser:bookworm-slim \
  --file "$source_dir/scripts/docker/sandbox/Dockerfile.browser" \
  "$source_dir"

docker image inspect \
  openclaw-sandbox:bookworm-slim \
  openclaw-sandbox-browser:bookworm-slim \
  >/dev/null
