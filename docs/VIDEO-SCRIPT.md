# Demo video script (2:00 maximum)

Goal (HACKATHON.md): one complete moment from a user action to a visible result, no long intros, say what NEAR does. Everything shown is real except where marked. Nothing in this script needs mainnet, an API key or a funded Bitcoin address.
Honesty rule: the on-screen limits card (scene 7) stays in. Do not claim confidential sweeps, Bitcoin payments or mainnet.

## The rendered video

`docs/video/ghost-paths-demo.mp4` (1:52, 1280x720, silent with burned-in captions, 4.5 MB), `docs/video/poster.png` (title, pitch, clone + `make demo`, byline) and `docs/video/demo-capture.txt` (the captured stdout of the run) are produced by `make video` (`scripts/record-video.ts`, no screen recorder needed). The footage is **real**: the terminal text is the stdout of `KEEP=1 make demo` (NEAR testnet and the real Chain Signatures MPC, anvil and a Solana validator in docker; 17/17 checks) and the browser part is the real web UI in Playwright chromium, served by `ghost serve` against that kept run (a fresh payment of 0.01 ETH, scan as recipient and as stranger, sweep). `VIDEO_SOURCE=replay make video` renders from `make demo-replay` and `make web-sim` instead and then says "replayed" / "simulated" in the captions. The script ends with `make demo-clean`.

What it does differently from the timeline below (so nothing in the video claims more than it shows):

| Script | Video |
|---|---|
| Screen recording, voice-over | Rendered terminal playback and a captured browser page; no voice. The voice-over column below is for a narrated cut. |
| Title: "Nobody can link the payment to them" | "The chain never names the recipient; amounts and timing stay public." |
| Scene 5: show the NEAR sweep on testnet.nearblocks.io | The `NEAR tx` links are on screen in the terminal text; the explorer page itself is not opened. |
| Scene 6 ends with the Auditor tab and CSV export | Not shown (the auditor view is in the terminal scene: `viewing key only: no spend key, cannot sweep`). |
| Step 8, the 1Click dry quote | Left out of the video (it is in `demo-capture.txt`). The confidential sweep is neither shown nor claimed. |
| Scene 7 limits card | Kept and extended: public amounts and timing, view-tag leak, consolidation, relayer sees sweep requests, Bitcoin derive-only, confidential 1Click sweep not run, tiny anonymity set, not audited. |
| End card: `make demo-replay` | `git clone https://github.com/AaroneGeorge/near-ghost-paths`, `make demo`, and the Tripwire byline. |

The terminal part is an abridged playback of the real output (a few lines such as funding and gas details are dropped, and a badge says so); the web sweep goes to a "throwaway address" on the local anvil chain, which the UI offers only on local demo chains. Bitcoin is not paid in the video.

## Before recording (10 minutes, one time)

1. Fresh state, images already pulled (the first docker run downloads about 1 GB):
   ```bash
   cd ghost-paths && make demo-clean                          # clean slate; harmless on a fresh machine
   KEEP=1 make demo                                            # rehearsal; expect "demo OK: 17/17 checks passed" in 82 to 90 s
   make demo-clean
   ```
2. Terminal: 110 columns by 30 rows, font 18 pt or larger, dark theme, prompt shortened (`PS1='$ '`). `clear` before each take.
3. Browser: a window at 1280 by 800, zoom 100%, two tabs ready: the UI (the `http://127.0.0.1:8788/?token=…` URL that `make web` prints) and a block explorer tab (filled in during scene 5).
4. Screen recorder at 30 fps (OBS, or `ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :0 raw.mp4`). Record the voice-over separately or at the end; the numbers below leave room for about 150 words per minute.
5. Capture **Take A** (terminal) and **Take B** (browser) separately; cut together. In Take A, speed the waiting parts up (`ffmpeg -i takeA.mp4 -filter:v "setpts=0.35*PTS" -an fast.mp4` for a 3x time lapse) and play the five highlighted frames at normal speed.

## Take A: terminal

```bash
KEEP=1 make demo        # 82 to 90 s raw; edited to about 0:10 to 1:10 of the video
```

## Take B: browser (start after Take A finished; chains and relayer are still running)

```bash
make web                # builds the UI, serves http://127.0.0.1:8788 against the kept run
```

## Timeline

| Time | Scene | On screen (exact) | Voice-over |
|---|---|---|---|
| 0:00 to 0:08 | **Title card** (static) | Large: "Ghost Paths". Under it: "Pay anyone on Ethereum, Solana or Bitcoin. They only need a NEAR account. Nobody can link the payment to them." Footer: "Built at NEAR HACKATHON" | "A public blockchain turns every payment into a public link between two people. Ghost Paths fixes that for Ethereum, Solana and Bitcoin, using one NEAR account." |
| 0:08 to 0:18 | **Scene 1, setup** (terminal, type `KEEP=1 make demo`, Enter; time lapse) | Highlight `root keys ok (v1.signer-prod.testnet public_key matches chainsig.js for domains 0 and 1)` and `contract v1.ghost-paths.testnet deployed`. Caption: "Real NEAR testnet and the real Chain Signatures MPC. Target chains run locally." | "This runs against the real NEAR testnet and the real MPC network. Only the target chains are local." |
| 0:18 to 0:30 | **Scene 2, register** (play at normal speed at the key frame) | Step 2 block. Highlight `You hold two keys and no BTC/ETH/SOL key`. Caption: "One meta-address in a NEAR contract. No chain keys." | "Bob registers one meta-address. He holds a spend key and a viewing key, and no Ethereum, Solana or Bitcoin key at all." |
| 0:30 to 0:45 | **Scene 3, pay** (normal speed on the two `one-time address` lines, then time lapse) | Highlight `one-time address 0x... = MPC-derive(predecessor v1.ghost-paths.testnet, path gp1/..., domain 0)` and `announcement idx N: ... (no recipient field)`; then the SOL block's `domain 1`. Caption: "Alice pays a fresh address. The NEAR announcement has no recipient field." | "Alice pays Bob 0.01 ETH, then 0.1 SOL. Each goes to a fresh one-time address that the MPC derives from the Ghost Paths contract and a hash. The announcement on NEAR names nobody." |
| 0:45 to 0:58 | **Scene 4, who sees what** (normal speed) | Step 5. Highlight `carol scanned 2 announcements: 0 payments`, then bob's table (`invoice #42`, `invoice #43`, `unspent`), then `viewing key only: no spend key, cannot sweep`. Captions: "Stranger: 0", "Recipient: 2", "Auditor: read-only". | "A stranger scanning the same log finds nothing. Bob finds both payments. An accountant with only a viewing key sees them too, and cannot spend." |
| 0:58 to 1:12 | **Scene 5, sweep** (normal speed on `MPC signature in`; then switch to the browser tab with the sweep tx on testnet.nearblocks.io: open the `NEAR tx` link from the step 6 block) | Terminal highlight: `MPC signature in 7 s`, `destination balance 0.00995 ETH`, `nothing names <bob>`. Explorer: the transaction goes to `v1.ghost-paths.testnet`, which calls `v1.signer-prod.testnet`. Caption: "On NEAR: the contract asked for a signature for an opaque path. No recipient." | "To spend, Bob signs an authorisation. A relayer submits it, the contract verifies it and asks the MPC to sign. On NEAR the record shows a contract and an opaque path, not Bob." |
| 1:12 to 1:40 | **Scene 6, web UI** (Take B, browser) | In order: **Send**: recipient `bob` shows `registered`; amount `0.01`, note `invoice #44`; click **Send privately**; show the one-time address and the announcement JSON with `"recipient": none, ever` (3 s). **Scan** > "As the recipient": new row `unspent`. "As a stranger": `0` payments and the public log. **Sweep**: pick the row, **Sweep**, show the balance `+0.00995 ETH` and the line "nothing names the recipient". **Auditor**: open and show **CSV export** (2 s). Caption: "Same flow in the browser. Keys never leave the server." | "The same flow in the web UI. Send, scan as the recipient, as a stranger, then sweep and watch the balance move. The auditor tab exports a read-only report." |
| 1:40 to 1:52 | **Scene 7, honest limits** (static card, 12 s) | Title "What is not private". Bullets: "Amounts and timing are public." "The view tag leaks one byte in small registries." "Sweeping many payments to one address links them." "Bitcoin: addresses derive, no payment demoed." "Confidential 1Click sweep: needs an API key, not run." "Testnet only." | "Honest limits: amounts and timing are public, consolidating payments links them, Bitcoin is derive-only, and confidential sweeps need an API key we did not use." |
| 1:52 to 2:00 | **End card** | "Ghost Paths: ERC-5564 stealth addresses on NEAR Chain Signatures". "Try it with nothing installed but bun: `git clone <repo-url> && make demo-replay`". "Aarone George. Built at NEAR HACKATHON. Also by the same submitter: Tripwire." | "Clone it and run make demo-replay. Built at NEAR HACKATHON." |

Total 2:00. If the cut runs long, shorten scene 6 (drop the Auditor tab) before touching scene 7.

## Voice-over notes

- The NEAR role has to be said out loud once, in plain words (scene 3 or 5): "Chain Signatures lets a NEAR contract own addresses on other chains. The derivation is public, but only the contract can get a signature, so one MPC key covers Ethereum and Solana, and our contract decides who may spend."
  If time is short, move that sentence into the title card voice-over and trim scene 1.
- Say "testnet" when showing hashes. Do not say "private by default", "untraceable" or "anonymous".

## Shot checklist

- [ ] No secret on screen: `.secrets/` paths are fine, never `cat` a keystore; the UI shows no keys.
- [ ] The testnet account names (`gp-bob-....testnet`) are throwaway and are deleted by `make demo-clean` after recording.
- [ ] After the last take: stop `make web` (Ctrl-C), then `make demo-clean` (stops the relayer and the docker chains, deletes the kept accounts).
- [ ] Export as MP4 (H.264, 1080p) under 100 MB; add captions (burned in) for the on-screen text column above.
- [ ] Upload and attach to the X post (`docs/X-POST.md`); keep a copy in case the upload is re-encoded.

## Fallback if the testnet MPC is slow on the recording day

Use `make demo-replay` for Take A (no network; it prints "REPLAY" at the top, so say so in the voice-over: "this is a replay of a recorded real run") and keep Take B on `make web-sim` (it shows a "simulated" banner). Prefer the live take.
