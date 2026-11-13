# Demo video

Honesty rule: no claim the video does not show. No confidential sweeps, no Bitcoin payments, no mainnet.

## The shipped video: two people, real MetaMask (`docs/video/ghost-paths-demo.mp4`)

1:39, 1920x1080, 3.6 MB, silent with burned-in captions; poster `docs/video/poster.png`; every transaction it shows is in
`docs/video/explorer-links.txt`. Recorded on 2026-11-13 with `make two-party` ([`docs/DEMO.md`](DEMO.md#two-people-real-wallets-metamask-on-sepolia)):
NEAR testnet with the real Chain Signatures MPC (`v1.signer-prod.testnet`) and Ethereum Sepolia, the real MetaMask
extension in Brave, nothing replayed or simulated. One browser plays both people (the title card says so): Alice's pay
page (`:8790/pay.html`, no keys) and Bob's own app (`:8791`, `ghost serve` with only Bob's keys) are separate apps in two
tabs; MetaMask is the side panel on the right. The browser bar is cropped out. Only the 8-second Sepolia block wait plays
at 2x (the caption says so); other waits are cut.

| Time | Whose screen | What happens |
|---|---|---|
| 0:00 to 0:04 | Title card | "Pay anyone privately by their NEAR name, from your own wallet." Live on NEAR testnet + Sepolia; one browser plays both people. |
| 0:04 to 0:13 | Alice, pay page | Recipient `ghostbob.testnet` shows **Ready** (live NEAR lookup); she types the note "Invoice #43, logo design". |
| 0:13 to 0:26 | Alice, MetaMask | **Send 0.001 ETH privately** → MetaMask's Confirm screen: 0.001 SepoliaETH from Account 1 to `0x3c98…D59C`, a brand-new address computed in her browser → Confirm. |
| 0:26 to 0:30 | Alice (2x) | Sepolia confirms; the relayer posts the encrypted note on NEAR (announcement #88). |
| 0:30 to 0:44 | Alice, receipt | "Sent privately", the path picture, then Technical details: what NEAR recorded, with no recipient field. |
| 0:44 to 0:53 | Bob, his own app | The Inbox shows the new payment without a click, note decrypted. |
| 0:53 to 1:04 | Bob, MetaMask | Withdraw → **Use my wallet's address** → MetaMask's account picker → Connect. |
| 1:04 to 1:22 | Bob, NEAR Chain Signatures | Approving with his key; the relayer submits; NEAR's signing network signs for the one-time address (6.6 s); "+0.000999 ETH arrived". |
| 1:22 to 1:27 | Bob's wallet | The arrival; MetaMask's balance for `0xc527…d509` reads 0.501 → 0.502. |
| 1:27 to 1:34 | Everyone else | "What others see": a fresh key reads every public note and traces **0** payments. |
| 1:34 to 1:39 | End card | Repo URL, "Built at NEAR HACKATHON · NEAR Chain Signatures", limits: amounts and timing stay public; testnet only, not audited. |

How it was made: the screen was captured with ffmpeg (avfoundation) while the browser was driven and the two MetaMask
clicks were made by hand; every frame where another window covered Brave was detected (page-area brightness at 10 fps) and
cut, then the clips were captioned (PIL) and joined with ffmpeg. In the take, MetaMask returned its active account (Alice's)
first after Connect, so Bob's address was typed in; the cut goes from the picker to the withdrawal. The app now lets the
person choose when the wallet shares several addresses.

## The automated video (`make video`)

`make video` (`scripts/record-video.ts`) renders an older, fully automated cut into `docs/video/automated/` (not committed;
`demo-capture.txt` and `explorer-links.txt` there are from its 2026-11-11 run): the web app's all-in-one local demo in Brave,
a real Terminal.app run of `make demo-testnet`, the explorer pages, and cards. Everything in it is live on NEAR testnet,
Sepolia and Solana devnet. Each caption bar names whose screen it is.

### Storyboard of the automated cut

| Time | Scene | What is on screen |
|---|---|---|
| 0:00 to 0:08 | **Hook** | "Your wallet is a public bank statement." A wallet ledger whose rows get tagged (Salary · Acme Studio, Client · Northwind, Side project). Then the title: "Ghost Paths. Get paid privately, on any chain, with one NEAR account." |
| 0:08 to 0:48 | **Alice and Bob** (the real web app in Brave) | *Alice's screen*: she runs a design studio and pays Bob's invoice #44 (0.005 ETH on Sepolia) with just his NEAR account name; the three steps; the receipt with the one-time address. *Bob's screen*: his inbox finds it with the note decrypted; he withdraws to his everyday wallet; NEAR's signing network signs; "+0.004999 ETH arrived". *Everyone else*: "0 payments traced", and the public record has no recipient. *Bob's accountant*: a read-only viewing key, every payment, **Download CSV**. |
| 0:48 to 1:04 | **Behind the scenes** (card) | Alice → new address → Bob's wallet, with NEAR underneath: (1) Bob publishes a privacy key on NEAR, (2) every payment gets a brand-new address and a sealed note only Bob can open, (3) NEAR's signing network signs the withdrawal at Bob's request. |
| 1:04 to 1:14 | **Proof: real Terminal** | `make demo-testnet` in Terminal.app, fast-forwarded (badge), then held on the MPC signatures ("nothing names the recipient") and "demo OK: 17/17 checks passed". |
| 1:14 to 1:28 | **Proof: explorers** (Brave) | Sepolia Etherscan: Alice's payment to the one-time address. NearBlocks: the withdrawal's execution, `v1.ghost-paths.testnet` calling `sign` on `v1.signer-prod.testnet`. Sepolia Etherscan: the signed transfer from the one-time address to Bob's wallet. Solana Explorer: the Terminal run's Solana withdrawal. The relevant fields are highlighted. |
| 1:28 to 1:38 | **What you can build** (card) | Payroll, freelancers and agencies, merchants, creators and donations, DAOs and grants, AI agents. The business: a "Receive privately" button for any wallet, a small fee on private withdrawals, and accountant access for teams. |
| 1:38 to 1:43 | **Honest limits** (card) | Amounts and timing stay public; withdrawing several payments to one address links them; testnet only and not audited; Bitcoin and confidential cross-chain withdrawals are not shown. |
| 1:43 to 1:48 | **End card** | "Ghost Paths. Get paid privately, on any chain, with one NEAR account." "Live on NEAR testnet with Chain Signatures · Ethereum Sepolia · Solana devnet". |

The web app part plays at normal speed; only waits (for blocks and the MPC) are cut out. If the web part grows, the script
plays it up to 1.3x faster to stay under 2:00, and fails rather than going over.

### Recording it

macOS only (it drives Terminal.app and Brave). Needs:

- `brew install ffmpeg`, Brave in `/Applications`, and Playwright's ffmpeg (`cd apps/web && bun x playwright install ffmpeg`).
- Terminal and the shell running `make video` allowed to control Terminal (Automation) and to record the screen
  (Screen Recording); macOS asks the first time.
- A funded testnet payer in `.secrets/demo/testnet-payer.env` (gitignored, mode 0600):
  ```bash
  FUNDER_EVM_PK=0x…     # needs about 0.012 Sepolia ETH per take
  FUNDER_SOL_KEY=…      # base58; needs about 0.05 devnet SOL per take
  ```
  The script checks both balances before it starts. One take spends about 0.006 ETH and 0.02 SOL plus fees; the money ends
  up in "Bob's everyday wallet", whose keys are kept in `.secrets/demo/video-bob-wallet.json` so they stay recoverable.
- The NEAR testnet funder that `make demo-testnet` uses (`.secrets/demo/funder.json`).

Then:

```bash
make video          # about 7 minutes; the Mac stays usable
```

What it does: renders the cards as stills; runs `KEEP=1 make demo-testnet` in a new Terminal window and records **only
that window** (`screencapture -l <window id>`, so other apps are never filmed, and the window can sit behind them); serves
the web app with `ghost serve` against the kept run and records Alice's and Bob's flow in Brave (Playwright; only the page
is recorded); opens the resulting transactions on the explorers in Brave; cuts it all together with ffmpeg; and ends with
`make demo-clean`, which stops the relayer and deletes the throwaway NEAR accounts.

Options: `VIDEO_KEEP=1` keeps the work folder in `runs/video-<time>/`; `VIDEO_RESUME=1 VIDEO_WORK=runs/video-<time>`
reuses the live takes saved there and only redoes the edit; `VIDEO_KEEP_STATE=1` skips `make demo-clean`;
`VIDEO_PART=cards` renders only the cards and `VIDEO_PART=termtest` checks the Terminal window capture.

### Shot checklist

- [ ] No secret on screen: the UI shows no keys and the demo never prints one.
- [ ] The `gp-*.testnet` accounts are throwaway and deleted by `make demo-clean` (the script runs it).
- [ ] Watch the whole cut once: captions match the screens, the payer on Alice's screen is `alice`, the explorer pages are indexed (not "not found").
- [ ] Upload and attach to the X post (`docs/X-POST.md`); keep a copy in case the upload is re-encoded.
