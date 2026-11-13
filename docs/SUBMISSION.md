# Submission checklist (owner and coordinator)

Source: `research/dl/HACKATHON.md` (re-read the live version at https://nearhackathon.com/HACKATHON.md before submitting; dates and rules may change).
Window: 2026-11-01T00:00Z to **2026-11-14T23:59Z**. One attempt per repository (a second submission of the same repository is rejected with 409). Mistakes are fixed at https://nearhackathon.com/request-changes.

## Before submitting (all must be true)

- [ ] Repository is **public** (it may be private until now). URL: `https://github.com/AaroneGeorge/near-ghost-paths`.
- [ ] `LICENSE` is present (MIT, Aarone George): yes.
- [ ] README has "do X, see Y" steps, names the NEAR technology, lists libraries and AI-generated code, names the other project (Tripwire): yes. Re-read it once more for stale numbers (test counts, timings).
- [ ] **TODO(coordinator): decide the testnet admin key.** `v1.ghost-paths.testnet` still has one full-access key (`ed25519:Akhn79Sm91NX...`). The README says it will be deleted before judging. Delete it
      (`near account delete-keys v1.ghost-paths.testnet ...`; first check that nothing else needs a redeploy) and then update the "Admin key" row in the README table (a `TODO(coordinator)` comment marks it) and the matching paragraph in `docs/THREAT-MODEL.md`.
- [ ] **TODO(coordinator): mainnet.** No mainnet contract exists. If one is deployed, update README "Testnet deployment" and "Limitations". If not, nothing to change; the README already says so.
- [ ] `make demo-replay`, `make test-ts` and `make web-sim` pass on a fresh clone of the **public** repository (this was checked on a fresh local clone; repeat once on the public URL).
- [ ] The NEAR testnet funder for `make demo`/`make test-live` is not required for judges (they can use `make demo-replay`), but if you want `make demo` to work on their machine the faucet helper must not be rate-limited for them (it limits per IP).
- [ ] No secrets committed: `.secrets/` is git-ignored. Check with `git ls-files | grep -E '^\.secrets|(^|/)\.env$|\.pem$|secret'` (expect no output). (The replay tapes contain NEAR transaction signatures that look like keys; they are not keys, and `packages/sdk/test/fixtures.test.ts` asserts that no secret-key field is present.)
- [x] Demo video recorded: `docs/video/ghost-paths-demo.mp4` (1:31, real MetaMask on NEAR testnet + Sepolia; `docs/VIDEO-SCRIPT.md`). Upload it with the X post.
- [ ] X post published per `docs/X-POST.md` (built at NEAR HACKATHON, @NEARProtocol, #NEARHackathon, video attached). Keep the URL.
- [ ] Hosted demo (optional, Q-012): none. A local demo is acceptable if the repository is public and reproducible.

## What the owner must provide

| Item | Notes |
|---|---|
| Lead name | `Aarone George` |
| Email | the owner's contact email (max 160 characters; at most 2 submissions per email; Tripwire is the other one) |
| Team size | `1` (exactly this string) |
| Tracks | `privacy`, `realworld`, `open` (one or more; each once) |
| NEAR payout account (mainnet) | `aarex.near` (given by the owner on 2026-11-12) |
| Repository URL | `https://github.com/AaroneGeorge/near-ghost-paths` (max 300 characters, unique) |
| Demo URL | the public X post URL |
| Consent | read verbatim to the owner: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." Then `consent: true` |

## Payload (build it from the owner's answers; print it and wait for a yes before sending)

Do not commit the filled-in payload: it contains personal data. Generate `requestId` once (`uuidgen | tr A-Z a-z`) and reuse it on retries.

```json
{
  "requestId": "<uuid>",
  "projectName": "Ghost Paths",
  "leadName": "Aarone George",
  "email": "<owner email>",
  "size": "1",
  "tracks": ["privacy", "realworld", "open"],
  "nearAddress": "aarex.near",
  "projectUrl": "https://github.com/AaroneGeorge/near-ghost-paths",
  "demoUrl": "<X post URL>",
  "idea": "<see below>",
  "consent": true
}
```

```sh
curl -sS -X POST https://nearhackathon.com/api/applications -H 'Content-Type: application/json' -d @payload.json   # payload.json stays out of git
```

Do not add other fields (`website` is a spam trap). Expected: HTTP 201. 400 means fix the listed `fields` and resend with the same `requestId`; 403 means outside the window, so tell the owner and do not retry;
409 means already submitted (use the request-changes page); 503 means wait a minute and resend with the same `requestId`.

### `idea` text (1402 characters; limit 20 to 2000)

```
Ghost Paths lets anyone pay a NEAR account privately on Ethereum or Solana: stealth addresses (ERC-5564) rebuilt on NEAR Chain Signatures. The recipient registers one meta-address under their NEAR account. A payer opens a static pay page, types the recipient's NEAR name, and their own MetaMask pays a one-time address computed in the browser; a relayer posts an encrypted note with no recipient field to a NEAR contract, so the payer needs no NEAR account. The recipient's own app, or an auditor holding only a viewing key, scans the notes and finds the payment. Only the recipient can withdraw, by signing an authorisation that the contract checks with ecrecover before it asks v1.signer for an MPC signature. The recipient never holds an ETH or SOL key, and on NEAR a withdrawal names only the contract and an opaque path. NEAR makes this possible because Chain Signatures key derivation is public while only the predecessor contract can obtain a signature, which also covers ed25519 chains like Solana that ERC-5564 cannot. Built: a near-sdk contract on testnet (v1.ghost-paths.testnet), a TypeScript SDK, CLI and relayer, a MetaMask pay page and the recipient's own app, demos that run offline or live on NEAR testnet and Sepolia, and a threat model. Limits: amounts and timing stay public, Bitcoin is derive-only, the 1Click confidential withdrawal needs an API key and was not run, testnet only.
```

## After submitting

- Keep the 201 response and the `requestId`.
- The repository must stay public through judging; keep any hosted demo up to 2026-11-18 (ideally 2026-11-25).
- Nothing new should merge after the submission except README or typo fixes; a change to code the judges run risks breaking their reproduction.
- Related submission: Tripwire (`github.com/AaroneGeorge/near-tripwire`) is a separate submission with its own repository and its own README naming Ghost Paths.
