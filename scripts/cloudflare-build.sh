#!/usr/bin/env bash
# Cloudflare Pages build entry-point.
# Configure in the dashboard:
#   Build command:        bash scripts/cloudflare-build.sh
#   Build output dir:     ens-app-v3/out
#   Submodules:           CF_PAGES_SUBMODULES=true (or this script pulls them)
#
# Required env vars (set in Cloudflare → Settings → Environment variables):
#   NODE_VERSION=22
#   NEXT_PUBLIC_CHAIN_NAME=sepolia
#   NEXT_PUBLIC_SIMPLEX_TLD=testing
#   NEXT_PUBLIC_IPFS=1
set -euo pipefail

# Belt + braces: make sure submodules are populated even if Cloudflare's
# submodule-checkout step is disabled.
git submodule update --init --recursive

# A pnpm-installed git dep (`clones-with-immutable-args`) runs its `prepare`
# step via yarn. Corepack picks yarn 4.x; yarn 4 enables immutable mode by
# default when `CI=true` (which Cloudflare Pages sets), then refuses because
# migrating the lockfile would mutate it. Override that just for this build.
export YARN_ENABLE_IMMUTABLE_INSTALLS=false

corepack enable

pnpm install --frozen-lockfile

(
  cd ens-contracts
  pnpm install --frozen-lockfile
  npx hardhat compile
)

(
  cd ens-app-v3
  # ens-app-v3 pins `packageManager: pnpm@10.23.0` and uses 10 patched
  # dependencies. pnpm 10.23 validates patch-file content hashes against the
  # lockfile and rejects --frozen-lockfile if any patch file's hash drifted.
  # Use the lockfile as the resolution source but allow patch hashes to
  # refresh in place — no actual dependency-version changes happen.
  pnpm install --no-frozen-lockfile --prefer-frozen-lockfile
  # Bake the Sepolia deployment addresses into the static export.
  # Read from the committed JSON so we don't have to paste it into the
  # Cloudflare env-var UI every time addresses change.
  export NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES="$(jq -c . ../deployments.sepolia.json)"
  pnpm build
  pnpm export
)
