#!/usr/bin/env bash
# Deploy the committed wasm (contract/res/ghost_paths.wasm) to a NEW faucet-funded testnet account
# and initialise it with the testnet MPC signer. Needs near-cli-rs (`near`), nothing else.
#
#   contract/scripts/deploy-testnet.sh                 # -> ghost-paths-<random>.testnet
#   GHOST_ACCOUNT=my-ghost.testnet contract/scripts/deploy-testnet.sh
#
# The new account's key is saved by near-cli to ~/.near-credentials/testnet/<account>.json (legacy
# keychain). Prints `GHOST_CONTRACT=<account>` on success. The contract has no upgrade method: to
# ship a new version, deploy to a new account (that is the point of this script).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wasm="$here/res/ghost_paths.wasm"
signer="${GHOST_SIGNER:-v1.signer-prod.testnet}"
account="${GHOST_ACCOUNT:-ghost-paths-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n').testnet}"
[ -f "$wasm" ] || { echo "missing $wasm (run: make build-contract)" >&2; exit 1; }
command -v near >/dev/null || { echo "near-cli-rs not found (npm i -g near-cli-rs)" >&2; exit 1; }

echo "creating $account via the testnet faucet..." >&2
near account create-account sponsor-by-faucet-service "$account" \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create >&2
sleep 3
echo "deploying $(sha256sum "$wasm" | cut -c1-16)... and calling new(signer_id=$signer)" >&2
near contract deploy "$account" use-file "$wasm" \
  with-init-call new json-args "{\"signer_id\":\"$signer\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send >&2
echo "GHOST_CONTRACT=$account"
