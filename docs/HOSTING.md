# Hosting the pay page and the relayer

Two pieces are meant to be hosted. The third, the recipient's app, is not.

| Piece | What it is | Holds keys? | Host it? |
|---|---|---|---|
| **Pay page** (`apps/web/dist/pay.html` + `assets/`) | Static files. The payer's own wallet (MetaMask) signs; the one-time address is computed in the browser from the recipient's public meta-address on NEAR. | no | yes, any static host |
| **Relayer** (`packages/relayer/src/server.ts`) | Posts the payer's encrypted note (`announce`) and recipients' withdrawals (`sweep`) on NEAR from its own account, so neither person appears there. | its own NEAR account key (pays gas and each note's storage) | yes, one small process |
| Recipient app (`ghost serve`, `apps/web/dist/index.html`) | Scans, decrypts notes, authorises withdrawals. | the recipient's seed | **no**: each recipient runs it on their own machine (`ghost serve` binds to 127.0.0.1) |

The relayer cannot steal: a withdrawal's destination is inside the message the recipient's one-time key signed, and the
contract re-checks that signature. It can only refuse to relay (censor). The pay page never sees a private key.

Network: NEAR **testnet** (contract `v1.ghost-paths.testnet`, MPC `v1.signer-prod.testnet`) and **Ethereum Sepolia**.
Keep both up until at least 2026-11-18 (judging), ideally 2026-11-25.

Below, `pay.example.com` and `relay.example.com` stand for your two hostnames.

---

## 1. Build the pay page

On any machine with `bun`:

```bash
git clone https://github.com/AaroneGeorge/near-ghost-paths && cd near-ghost-paths
bun install
cd apps/web
VITE_GHOST_RELAYER_URL=https://relay.example.com bun run build
```

See: `check-bundle: 30 files, no secrets found`. Copy `apps/web/dist/` to the web root of `pay.example.com`.
The page is `https://pay.example.com/pay.html`; `https://pay.example.com/pay.html?to=ghostbob.testnet` pre-fills the recipient.
(The same `dist/` also contains `index.html`, the recipient app. Served without `ghost serve` it only shows "Can't reach the
Ghost Paths server", so you can delete it, or redirect `/` to `/pay.html`.)

### Change settings without rebuilding: `pay-config.json`

The page reads an optional `pay-config.json` from its own folder at load time; any field overrides the build default:

```json
{
  "network": "testnet",
  "contract": "v1.ghost-paths.testnet",
  "relayer": "https://relay.example.com",
  "chains": ["evm:11155111"]
}
```

| Field | Default | Notes |
|---|---|---|
| `network` | `testnet` | NEAR network |
| `contract` | `v1.ghost-paths.testnet` | the page checks its code hash against the pinned one and refuses to pay if it differs |
| `codeHash` | pinned in `packages/sdk/src/constants.ts` | only change together with `contract` |
| `relayer` | `VITE_GHOST_RELAYER_URL`, else `http://127.0.0.1:8787` | no trailing slash needed |
| `chains` | `["evm:11155111"]` (Sepolia) | EVM chain tags; the first is used. `evm:84532` (Base Sepolia) also works |
| `nearRpc` | `["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]` | read-only NEAR RPC, tried in order |

Serve over **HTTPS**. MetaMask works on `http://localhost` but expects HTTPS everywhere else.

## 2. Run the relayer

It needs a funded NEAR testnet account. Measured on 2026-11-13: 3 payment notes and 1 withdrawal cost the relayer 0.0145
NEAR in total (each call attaches a 0.01 NEAR deposit; the contract keeps only the storage it uses). 5 testnet NEAR covers
well over a thousand payments. Create one from
any testnet account you control (here `.secrets/demo/funder.json`, a JSON `{account_id, secret_key}`):

```bash
mkdir -p ~/ghost-relayer
GHOST_HOME=~/ghost-relayer GHOST_NETWORK=testnet GHOST_FUNDER_FILE=/path/funder.json \
  bun packages/cli/src/ghost.ts account create --as relayer --fund 5
# → ~/ghost-relayer/relayer.near.json (0600): {account_id, secret_key, network}
```

Start it, bound to loopback behind your reverse proxy:

```bash
GHOST_NETWORK=testnet \
RELAYER_KEY_FILE=$HOME/ghost-relayer/relayer.near.json \
RELAYER_HOST=127.0.0.1 RELAYER_PORT=8787 \
RELAYER_CORS_ORIGINS=https://pay.example.com \
RELAYER_TRUST_PROXY=1 \
RELAYER_RATE_PER_IP=10 RELAYER_RATE_GLOBAL=60 \
bun packages/relayer/src/server.ts
```

See: `[relayer] listening on http://127.0.0.1:8787 as gp-relayer-….testnet → v1.ghost-paths.testnet (testnet)`.

| Variable | Why |
|---|---|
| `RELAYER_CORS_ORIGINS` | the pay page's origin (comma-separated if several). Any other browser origin gets 403. **Required**: without it only the local `ghost serve` origins are allowed and the pay page fails with "origin not allowed". Recipient apps need no entry: `ghost serve` calls the relayer server to server, without an Origin header |
| `RELAYER_TRUST_PROXY=1` | take the client IP from the proxy's `X-Forwarded-For` (only when the request comes from loopback), so the per-IP limit is per visitor and not one shared limit |
| `RELAYER_RATE_PER_IP`, `RELAYER_RATE_GLOBAL` | POSTs per minute (defaults 30 and 120). Every accepted `announce` spends a few thousandths of a NEAR of the relayer's balance |
| `RELAYER_TOKEN` | **do not set it for a public pay page**: a browser page cannot keep a secret, and the page sends no token. Use it only for a private relayer used by CLIs (`GHOST_RELAYER_TOKEN`) |

Requests are validated before any gas is spent (announcement format; withdrawal signature, path and expiry). A replayed
withdrawal is answered from a cache. The worst a spammer can do is spend the relayer's balance at the rate limit, so keep
the balance small and top it up. Check it at `https://relay.example.com/health`
(`{"ok":true,"account":…,"balance":"<yoctoNEAR>",…}`).

### systemd unit

`/etc/systemd/system/ghost-relayer.service`:

```ini
[Unit]
Description=Ghost Paths relayer (NEAR testnet)
After=network-online.target

[Service]
User=ghost
WorkingDirectory=/opt/near-ghost-paths
Environment=GHOST_NETWORK=testnet
Environment=RELAYER_KEY_FILE=/home/ghost/ghost-relayer/relayer.near.json
Environment=RELAYER_HOST=127.0.0.1
Environment=RELAYER_PORT=8787
Environment=RELAYER_CORS_ORIGINS=https://pay.example.com
Environment=RELAYER_TRUST_PROXY=1
Environment=RELAYER_RATE_PER_IP=10
Environment=RELAYER_RATE_GLOBAL=60
ExecStart=/home/ghost/.bun/bin/bun packages/relayer/src/server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ghost-relayer
journalctl -u ghost-relayer -f      # one line per announce / sweep, with the NEAR tx hash
```

## 3. Reverse proxy (TLS)

### Caddy

```caddy
pay.example.com {
	root * /var/www/ghost-pay
	file_server
	redir / /pay.html
	header {
		Content-Security-Policy "default-src 'self'; connect-src 'self' https://relay.example.com https://test.rpc.fastnear.com https://rpc.testnet.near.org https://ethereum-sepolia-rpc.publicnode.com https://sepolia.gateway.tenderly.co https://1rpc.io; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
	}
}

relay.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Caddy sets `X-Forwarded-For` itself. The `connect-src` list is the relayer, the NEAR RPCs from `nearRpc` and the Sepolia RPCs the
page reads balances from; add your own if you change them. (The wallet talks to its own nodes; that traffic is not the page's.)

### nginx

```nginx
server {
    server_name pay.example.com;
    root /var/www/ghost-pay;
    location = / { return 302 /pay.html; }
    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    location = /pay-config.json { add_header Cache-Control "no-store"; }
    # listen 443 ssl; ssl_certificate …; (certbot)
}
server {
    server_name relay.example.com;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header X-Forwarded-For $remote_addr;   # one entry: the visitor
        proxy_read_timeout 120s;                         # a withdrawal waits 5–30 s for the MPC signature
    }
    # listen 443 ssl; …
}
```

## 4. Check it

1. `curl https://relay.example.com/health` shows `"ok":true` and a balance.
2. `curl -i -X OPTIONS -H 'Origin: https://pay.example.com' https://relay.example.com/announce` answers `204` with
   `access-control-allow-origin: https://pay.example.com`.
3. Open `https://pay.example.com/pay.html?to=ghostbob.testnet`. The recipient field shows **Ready** (read live from NEAR).
4. Connect MetaMask, pay 0.001 Sepolia ETH, confirm. See: "Sent privately", the one-time address, and under Technical details the
   Sepolia transaction and the NEAR note (`https://testnet.nearblocks.io/txns/…`). The relayer log shows
   `announce evm:11155111 → idx N tx …`.
5. The recipient sees it in their own app: `make two-party` on their machine (or `ghost scan --as bob`).

## Pointing a recipient's app at your relayer

A recipient who withdraws through your relayer runs, on their own machine:

```bash
GHOST_HOME=~/.ghost GHOST_NETWORK=testnet GHOST_CHAINS=evm:11155111 \
GHOST_RELAYER_URL=https://relay.example.com \
bun packages/cli/src/ghost.ts serve
```

Nothing to add on the relayer side: the browser never calls the relayer for withdrawals, `ghost serve` does, server to server.
