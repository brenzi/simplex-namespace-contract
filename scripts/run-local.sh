#!/bin/bash
set -e

cd "$(dirname "$0")/.."

TLD="${SIMPLEX_TLD:-testing}"

echo "=== Starting Hardhat node ==="
(cd ens-contracts && npx hardhat node) &
NODE_PID=$!
sleep 4

echo "=== Deploying .${TLD} contracts ==="
DEPLOY_OUTPUT=$(SIMPLEX_TLD="$TLD" node scripts/deploy-local.mjs 2>&1)
echo "$DEPLOY_OUTPUT" | grep -v "^$"

ADDRS=$(echo "$DEPLOY_OUTPUT" | grep "^NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=" | sed "s/^NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=//")
if [ -z "$ADDRS" ]; then
  echo "ERROR: Failed to extract deployment addresses"
  kill $NODE_PID 2>/dev/null
  exit 1
fi

echo ""
echo "=== Starting frontend ==="
cd ens-app-v3
NEXT_PUBLIC_DEPLOYMENT_ADDRESSES="$ADDRS" \
NEXT_PUBLIC_PROVIDER=http://127.0.0.1:8545 \
NEXT_PUBLIC_SIMPLEX_TLD="$TLD" \
exec pnpm dev
