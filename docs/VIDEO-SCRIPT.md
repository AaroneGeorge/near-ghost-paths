# Demo video

Honesty rule: no claim the video does not show. No confidential sweeps, no Bitcoin payments, no mainnet.

## The shipped video: two people, real MetaMask (`docs/video/ghost-paths-demo.mp4`)

1:02, 1920x1080 at 30 fps, silent with burned-in captions; poster `docs/video/poster.png`; every transaction it shows is in
`docs/video/explorer-links.txt`. Recorded on 2026-11-13 with `make two-party` ([`docs/DEMO.md`](DEMO.md#two-people-real-wallets-metamask-on-sepolia)):
NEAR testnet with the real Chain Signatures MPC (`v1.signer-prod.testnet`) and Ethereum Sepolia, the MetaMask extension in
Brave. Alice's pay page (`:8790/pay.html`, no keys) and Bob's own app (`:8791`, `ghost serve` with only Bob's keys) are two
tabs of one browser; MetaMask is on the right.

Edit: the full screen as a rounded window with a soft shadow on a dark gradient; an eased zoom on each moment that matters;
one caption pill per moment, tagged ALICE, BOB or EVERYONE ELSE, fading in and out; 0.35 s crossfades. Waits (the Sepolia
block, Bob's scan, the MPC signature) are cut, not sped up; everything plays at real speed.

| Time | Who | What happens |
|---|---|---|
| 0:00 | Title | "Pay anyone privately by their NEAR name, from your own wallet." |
| 0:03 | Alice | Zoom on the form: recipient `ghostbob.testnet` is **Ready**, note "Invoice #45, logo design", Send. |
| 0:07 | Alice | Zoom on MetaMask: "Sending 0.001 SepoliaETH" from Alice's account to a brand-new one-time address; Confirm. |
| 0:10 | Alice | The three steps; the relayer posts the encrypted note on NEAR (announcement #90). |
| 0:16 | Alice | "Sent privately": the one-time address `0x211D…73C8`, the path picture. |
| 0:24 | Bob | His own app's Inbox, then the new payment with its note decrypted. |
| 0:29 | Bob | Withdraw to his everyday wallet (`0xc527…d509`). |
| 0:37 | Bob | Approving with his key; NEAR's signing network signs for the one-time address (5.7 s on chain). |
| 0:45 | Bob | "+0.000999 ETH arrived" (balance 0.502999 → 0.503999). |
| 0:51 | Everyone else | "What others see": a fresh key reads every public note and traces **0** payments. |
| 0:57 | End card | Repo URL, "Built at NEAR HACKATHON", "Testnet. Amounts and timing stay public." |

How it was made: ffmpeg (avfoundation) captured the screen while the pages were driven by script and the MetaMask Confirm
was clicked by hand; a check at 10 fps confirmed no other window appears in the take; the edit (zooms with ffmpeg
`zoompan` on a 4K upscale, PIL-rendered frame, pills and cards, `xfade` crossfades) was rendered from that one take.
Bob's address was entered by hand: MetaMask shares only its active account with a page, which was Alice's.

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
