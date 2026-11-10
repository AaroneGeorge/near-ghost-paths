# Ghost Paths. Each track owner edits only their own section.
SHELL := /bin/bash
NOT_YET = @echo "not implemented yet: $@"

.PHONY: lint check test demo demo-replay demo-testnet demo-live test-live test-contract-live test-ts test-contract install clean

# ---- W0 (scaffold) ----
install:
	bun install

# Lint + format check (biome).
lint:
	bun x biome check .

# Everything offline in one go: lint, tests, replayed demo.
check: lint test demo-replay

# Unit + contract + fixture tests. No network.
test: test-ts test-contract

test-ts:
	GHOST_REPLAY=1 bun test packages apps

# Rust contract tests: unit tests + near-workspaces sandbox tests (need cargo, cargo-near, the
# wasm32-unknown-unknown target and network for the near-sandbox download). Skipped, with a message,
# when the Rust toolchain is absent, so `make test` still passes on a bun-only machine.
test-contract:
	@if [ ! -f contract/Cargo.toml ]; then echo "contract/ not present, skipping cargo test"; \
	elif ! command -v cargo >/dev/null 2>&1 || ! cargo near --version >/dev/null 2>&1; then \
	  echo "cargo / cargo-near not installed: SKIPPING the Rust contract tests (the TypeScript tests above still ran). Install Rust, cargo-near and the wasm32-unknown-unknown target to run them."; \
	else cargo test --manifest-path contract/Cargo.toml; fi

clean:
	rm -rf node_modules runs contract/target apps/web/dist

# ---- W3 (demo orchestration: chains, CLI, relayer) ----
GHOST := bun packages/cli/src/ghost.ts
DOCKER_OK := $(shell (docker info >/dev/null 2>&1 && echo docker) || (sudo -n docker info >/dev/null 2>&1 && echo sudo))
DOCKER := $(if $(filter sudo,$(DOCKER_OK)),sudo -n docker,docker)

.PHONY: demo-record demo-replay-airgap demo-clean chains-up chains-down relayer ghost video

# NEAR testnet (real MPC) + local chains (anvil, solana-test-validator in docker).
# Without docker it runs the offline replay instead and says so.
demo:
	@if [ -n "$(DOCKER_OK)" ]; then bun demo/demo.ts; \
	else echo "docker not available: running the offline replay (make demo-replay) instead"; bun demo/demo.ts --replay; fi

# Same as demo, and records every HTTP exchange into demo/fixtures/replay/ for demo-replay.
demo-record:
	bun demo/demo.ts --record

# No network at all: replays the recorded run in demo/fixtures/replay (GHOST_REPLAY=1)
demo-replay:
	GHOST_REPLAY=1 bun demo/demo.ts --replay

# demo-replay inside a network namespace with only loopback (proves it is offline).
# Unprivileged user namespaces first; else sudo (Debian/Ubuntu often disable the former).
demo-replay-airgap:
	@if unshare -rn true 2>/dev/null; then \
	  unshare -rn sh -c 'ip link set lo up 2>/dev/null; GHOST_REPLAY=1 bun demo/demo.ts --replay'; \
	else \
	  sudo -n unshare -n sh -c "ip link set lo up && exec sudo -u $$USER env PATH='$$PATH' HOME='$$HOME' GHOST_REPLAY=1 $$(command -v bun) demo/demo.ts --replay"; \
	fi

# Public testnets (Sepolia, Solana devnet); payer = lechu-wallet on the dev host or FUNDER_EVM_PK/FUNDER_SOL_KEY
demo-testnet:
	bun demo/demo.ts --testnet

# Mainnet, tiny amounts; refuses (dry 1Click quote only) unless MAINNET_APPROVED=1 and mainnet keys are set
demo-live:
	bun demo/demo.ts --live

# Render docs/video/ghost-paths-demo.mp4 (+ poster.png, demo-capture.txt) from a real `KEEP=1 make demo` run and the
# real web UI in Playwright chromium; needs docker, network, ffmpeg. Stops what it started (make demo-clean).
# VIDEO_SOURCE=replay uses the offline replay and the simulated UI instead (captions then say replayed/simulated).
video:
	bun scripts/record-video.ts

# Undo KEEP=1: stop the kept relayer, delete kept runs' NEAR accounts (NEAR returns to the funder), stop the chains
demo-clean:
	bun demo/demo.ts --clean

# Local chains only (for development / the web UI); stop with chains-down
chains-up:
	$(DOCKER) compose -f demo/docker-compose.yml up -d --force-recreate

chains-down:
	$(DOCKER) compose -f demo/docker-compose.yml down -v --remove-orphans

# Relayer on 127.0.0.1:8787 (RELAYER_KEY_FILE or RELAYER_AUTO_CREATE=1 on testnet)
relayer:
	bun packages/relayer/src/server.ts

# make ghost ARGS="status"
ghost:
	$(GHOST) $(ARGS)

# ---- W5 (tests, fixtures) ----
# One real ECDSA and one real EdDSA signature through v1.ghost-paths.testnet and the testnet MPC
# (v1.signer-prod.testnet), ~30 s, needs network. Checks that the recovered/verified key equals the
# locally derived key. The submitting account is DEMO_FUNDER_FILE or .secrets/demo/funder.json
# (created once from the testnet faucet if absent).
test-live:
	env -u GHOST_REPLAY LIVE=1 bun test packages/sdk/test/live.test.ts

# Same check from the Rust side (needs cargo and the key in .secrets/near/ghost-paths.testnet.json; owner machine only)
test-contract-live:
	LIVE=1 cargo test --manifest-path contract/Cargo.toml --test live_testnet -- --nocapture

# ---- W2 (contract) ----
.PHONY: build-contract deploy-testnet
build-contract:
	cd contract && cargo near build non-reproducible-wasm

# Deploys the committed wasm to a NEW faucet account; prints GHOST_CONTRACT=<id>
deploy-testnet:
	contract/scripts/deploy-testnet.sh

# ---- W4 (web UI) ----
# The UI is static files + `ghost serve` (keys stay server-side). One process serves both at http://127.0.0.1:8788
.PHONY: web web-build web-sim web-dev web-e2e
web-build:
	cd apps/web && bun run build

# Real state: profiles of the newest kept demo run (`make demo KEEP=1`), or WEB_HOME=/path/to/GHOST_HOME. Needs
# the local chains (make chains-up) and the relayer (make relayer) for send/sweep; scanning needs neither.
WEB_HOME ?= $(shell ls -d $(CURDIR)/.secrets/demo/*/home 2>/dev/null | tail -1)
web: web-build
	@test -n "$(WEB_HOME)" || { echo "no demo profiles found: run 'make demo KEEP=1' first, or 'make web-sim' for the simulated UI"; exit 1; }
	GHOST_HOME=$(WEB_HOME) GHOST_RELAYER_URL=$${GHOST_RELAYER_URL-http://127.0.0.1:8787} $(GHOST) serve --port $${GHOST_SERVE_PORT-8788}

# No network, no docker: MemoryRegistry + simulated chains (real stealth cryptography)
web-sim: web-build
	$(GHOST) serve --dev=1 --port $${GHOST_SERVE_PORT-8788}

# Vite dev server with hot reload on :5173, proxying /api to ghost serve (start `make web` or `make web-sim` first)
web-dev:
	cd apps/web && bun run dev

# Playwright smoke test (send, scan finds 1, sweep, balance moves) against a self-started `ghost serve --dev=1`.
# Against a running server instead: GHOST_E2E_URL=http://127.0.0.1:8788 make web-e2e
web-e2e: web-build
	cd apps/web && bun run e2e
