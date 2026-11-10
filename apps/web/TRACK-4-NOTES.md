# Track W4 (web UI): notes, 2026-11-09

## Status

Done. Four tabs (Send, Scan, Sweep, Auditor) in a dark, privacy-themed Vite + React + TS app, backed by `ghost serve`.
`bun run build` (typecheck, Vite build, secret scan of `dist/`) passes; the Playwright smoke test passes against the simulated backend, and a read-only check against W3's kept demo state (`.secrets/demo/local-*/home`, real testnet contract) renders the live data correctly (bob's 2 payments, 7 announcements, "rpc down" when anvil is off).

## Run it

| Command | What |
|---|---|
| `make web-sim` | Build the UI and run `ghost serve --dev=1` on http://127.0.0.1:8788 (no network, no docker) |
| `make web` | Build, then `ghost serve` against the newest kept demo run (`make demo KEEP=1`); override with `WEB_HOME=…`. Needs `make chains-up` and `make relayer` for send/sweep. Scanning needs neither. |
| `make web-dev` | Vite dev server with hot reload (:5173, proxies `/api` to `GHOST_SERVE_PORT`, default 8788). Port 5173 is taken on this host by another project's Vite, so Vite will pick 5174; use :8788, which serves the same UI. |
| `make web-e2e` or `cd apps/web && bun run e2e` | Playwright smoke test. `GHOST_E2E_URL=http://127.0.0.1:8788/?token=<printed token>` drives an already running server (after `make demo KEEP=1` + `make web`) instead of starting its own. Screenshots land in `apps/web/e2e/out/`. |
| `cd apps/web && bun test`, `cd packages/cli && bun test test/serve.test.ts` | Unit tests (CSV escaping, balance delta, bundle parsing; the HTTP API incl. the security refusals) |

## What each tab does

- **Send**: payer, recipient (chips for known recipients plus a live "registered / not registered" registry lookup), asset ETH/BTC/SOL (from `GHOST_CHAINS`, default `evm:31337,sol:local`, plus `btc:regtest` in dev mode), amount, encrypted note, optional "hide the view tag". Streams progress, then shows the one-time address (copy + explorer link), `predecessor + path`, payment tx, NEAR announcement tx, and the announcement as the chain sees it (no recipient field).
- **Scan**: three views over the same public log. Recipient (profile select, spend+view keys, auto-scan, "Sweep" hands the payment to the Sweep tab); auditor (upload or drop a viewing bundle, held in memory only, "cannot sweep"); stranger (random key, 0 payments, then the whole public log with a "recipient: not on chain" column and the honest-limits callout).
- **Sweep**: payment picker, destination (pre-filled with a fresh throwaway address; warns about consolidation), route relayer / self-submit (warning: links to your NEAR account) / 1Click (a confidential dry quote; mainnet-only, labelled as such). Streams the steps, then shows destination balance before, `+delta`, after; NEAR tx, MPC time, chain tx and the "nothing names the recipient" callout.
- **Auditor**: read-only report from a viewing bundle: stats (payments, unspent totals, swept, can sweep = no), filter, table, **CSV export**. Cells starting with `= + - @` are prefixed with `'` (the memo is attacker-controlled, so this blocks CSV formula injection).

## Architecture and API (what W3 / W5 need to know)

`ghost serve` is **my file**: `packages/cli/src/serve.ts` (routes, security, static hosting, live backend) and `packages/cli/src/serve-dev.ts` (dev backend). Both are lazy-loaded through W3's existing `ghost.ts` hook; I did not edit any other W3 file.

- Keys never reach the browser. The live backend runs `COMMANDS[name].run(ctx, pos)` in-process with the same `Ctx` the CLI uses, so behaviour is identical to the CLI, and the UI receives the same JSON (`PayResult`, `ScanResult`, `SweepResult`). It overrides `ctx.log` so progress lines stream to the browser as NDJSON (`POST /api/<cmd>?stream=1`).
- Routes: `GET /api/{health,config,profiles,announcements,viewing-bundle?profile=,fresh-destination?chain=}`, `POST /api/{pay,scan,sweep,meta,balance,quote,status}` (`{pos, flags}`), `POST /api/scan-bundle`, `POST /api/scan-stranger`; anything else serves `apps/web/dist`. Full table in the header comment of `serve.ts`.
- Allowlist: only the commands and flags in `ALLOWED` are reachable (no `--home`, no file paths, no `init/register/fund/export-viewing-key`). Binds to 127.0.0.1; foreign `Host` headers (DNS rebinding) and foreign `Origin`s (CSRF) are refused; JSON content-type required; `pay` and `sweep` are serialised by a mutex. Remote viewing needs `GHOST_SERVE_HOSTS=name1,name2`, `--host` and `GHOST_SERVE_TOKEN` (ghost serve refuses a non-loopback bind without it). Every POST route and `/api/viewing-bundle` need the session token (`x-ghost-token`; the UI reads it from `/?token=…`, printed at start). REVIEW M4.
- Profiles are read from `GHOST_HOME`: `X.json` = recipient, `X.near.json` = NEAR account, `X.wallet.json` = payer wallet; `relayer` is hidden. Defaults: payer `alice`, recipient `bob` (`GHOST_WEB_PAYER`, `GHOST_WEB_RECIPIENT`).
- `/api/viewing-bundle` returns a viewing bundle (view key plus spend public key, no seed) for the "demo shortcut" chips. It is a view-only secret over loopback HTTP; remove the route (or the chips) if the server is ever exposed.
- 1Click route: calls the `quote` command (a dry quote of the stealth balance), never `sweep --via-1click`, because the latter also sweeps to `--to`. A real 1Click sweep stays CLI-only (`--wet`, `MAINNET_APPROVED=1`).
- Dev mode (`ghost serve --dev=1` or `GHOST_SERVE_DEV=1`): `MemoryRegistry` plus an in-memory ledger. **Real**: meta-addresses, ephemeral keys, view tags, memo encryption, stealth tweak, MPC-derived addresses (chainsig.js derivation), scanning, the sweep authorisation signed with `d_K`, and the contract's checks (`verifySweepArgs`). **Simulated**: the target chains, NEAR transactions (`memtx…`), and the MPC signature (placeholder of the right shape). Every response carries `simulated: true`, the UI shows a banner and drops explorer links. `GHOST_DEV_DELAY_MS` (default 1400) paces the fake MPC.

## TODO for W3 (small, all optional)

- `args.ts`: add `"dev"` to `BOOLEAN` so `ghost serve --dev` works without `=1` (right now `--dev=1` or the env var).
- `make demo` could print "run `make web`" at the end (the KEEP=1 message already mentions it).
- Root `package.json` has no `build` script; `cd apps/web && bun run build` is the build (the Makefile target is `web-build`). If the coordinator wants `bun run build` at the root: `"build": "bun --cwd apps/web run build"`.

## Known limits

- Auditor `swept` status relies on the recipient profile's `.seen.json` (shared when the bundle's account matches a local profile); for a bundle with no local profile an unfunded payment shows "unfunded", not "swept".
- Sweep progress steps are inferred from the CLI's log lines, so they track W3's wording (`preparing`, `submit`, `MPC signature`); if those lines change the steps degrade to the plain log box, nothing breaks.
- BTC appears in Send only when `GHOST_CHAINS` includes a BTC chain (dev mode includes `btc:regtest`); the UI itself handles any chain tag.
- The smoke test finds a Chromium itself: the installed one is build 1248 but Playwright 1.65 wants 1254, so it falls back to any `~/.cache/ms-playwright/chromium-*`.
- `bun.lock` changed (apps/web deps: react 19, react-dom, lucide-react, vite 8, @vitejs/plugin-react, playwright, @types/react*). A backup of the pre-change lock is not kept in the repo; `git diff bun.lock` shows it.

## Reuse (Code Garage)

Searched three ways (UI kits and dashboards, icons and Tailwind, Playwright). Used:
- `frontend.design.icon-sets` -> **lucide** (`lucide-react`, ISC) for all icons.
- `frontend.testing.playwright-for-ui` -> **Playwright** (Apache-2.0) for the smoke test.

Not used, on purpose: the shadcn/headless/Tailwind kits and dashboard templates (`frontend.templates.shadcn-dashboards`, `frontend.components.headless-react`, `frontend.styling.tailwind`). They are Next.js/Tailwind scaffolding that would add a design system and several dependencies to a four-tab app; the components here (Card, Segmented, Steps, Chip, Callout, CopyText, tables) are ~250 lines of plain CSS variables and React, written to fit the privacy theme. Fonts are the system stack (no network fetch, works offline).

## No secrets in the bundle

The app holds no keys; the only sensitive thing it ever touches is an auditor's viewing bundle, kept in React state (never `localStorage`) and never rendered. `bun run build` ends with `scripts/check-bundle.ts`, which fails the build if `dist/` contains a private-key block, an `ed25519:`/`secp256k1:` secret key, a 64-hex blob, a `seed`/`view_priv` assignment, an API-key assignment, or the value of any secret-looking env var present at build time. The smoke test also asserts that the uploaded `view_priv` never appears in the DOM.

## AI-generated code

All of `apps/web/**`, `packages/cli/src/serve.ts`, `packages/cli/src/serve-dev.ts` and `packages/cli/test/serve.test.ts` were written by Claude (Sonnet 5.5) under the W4 brief; list under "Libraries and AI-generated code" in the README.
