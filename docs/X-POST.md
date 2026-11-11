# X post draft (the owner posts it and gives the link)

Rules from HACKATHON.md (section 2): say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, attach the demo video or screenshots.
Optional: @NearLegion and @NearBuilders (more amplification). The post URL goes into the submission as `demoUrl`.
The first line must make sense to someone who does not know the project; show one complete moment; say concretely what NEAR does; end with a next step.

Replace `<repo-url>` with the public repository URL before posting. Attach `docs/video/ghost-paths-demo.mp4` (1:48; shot list in `docs/VIDEO-SCRIPT.md`).

## Option A: single post (265 characters without the link line)

```
Pay a NEAR account privately on Ethereum or Solana. One-time stealth addresses, derived and signed by @NEARProtocol Chain Signatures: the recipient never holds an ETH or SOL key, and the on-chain log never names them. Built at NEAR HACKATHON #NEARHackathon

Video + code: <repo-url>
Where would you break it?
```

## Option B: post + one reply (for accounts that prefer short posts)

Post:
```
Every crypto payment is a public link between two people. Ghost Paths: pay a NEAR account at a one-time Ethereum or Solana address; the public log never names them. Built at NEAR HACKATHON with @NEARProtocol Chain Signatures. #NEARHackathon
```

Reply (same thread):
```
How NEAR is used: Chain Signatures derives a public address for (contract, path) and only that contract can get it signed, so one MPC key serves Ethereum AND ed25519 chains like Solana. Our contract checks a per-payment stealth signature (ecrecover) before asking v1.signer to sign. Recipient: one NEAR account, no ETH/SOL key.

Honest limits: amounts and timing stay public, Bitcoin is derive-only, confidential 1Click sweeps need an API key. Try it offline: git clone <repo-url> && make demo-replay
```

## Optional tags (only if the owner wants them)

Add at the end of option A: `@NearLegion @NearBuilders`.

## Claims check (do not edit these into something stronger)

- "Built at NEAR HACKATHON": true (code written from 2026-11-09).
- "The on-chain log never names them": the announcement has no recipient field and a stranger's scan finds 0 payments (shown in the video). Stronger unlinkability holds only for the protocol as described in `docs/THREAT-MODEL.md`, with the listed exceptions (consolidation, view-tag leak in small registries, timing). The post is a one-line summary; the README has the honest section.
- Do not say "Bitcoin works", "mainnet", or "confidential" without the owner confirming that the matching step was really run (`make demo-live` with approval, an API key, funded Bitcoin testnet payments).
