# Voice-over script for the demo video

The demo video (`docs/video/ghost-paths-demo.mp4`, 1:31) has no sound. Record these 15 lines and the editing is
automatic: `python3 scripts/add-voiceover.py <recording>` cuts the recording into the lines, cleans it, and places
each line at its moment in the video.

## How to record

- A phone voice memo is fine. A quiet room with soft things around (not a bathroom). Phone about 20 cm from the mouth,
  slightly to the side.
- Read **all 15 lines in one take, in order**, and leave a **2-second pause** between lines. If you fluff a line,
  stop, wait 2 seconds, and record the whole take again (or send one file per line instead: `01.m4a` … `15.m4a`).
- Calm, friendly, a little slower than talking: like explaining something to a smart friend. Each line has a time
  budget below; read it once against a stopwatch. Up to 15% over is fixed automatically by a slight speed-up.
- Say "NEAR" as the word *near*. "MetaMask": *meta-mask*. "Etherscan": *ether-scan*.
- Send the file as it is (m4a, mp3 and wav are all fine). No editing needed.

## The lines

| # | At | Seconds | On screen | Read |
|---|---|---|---|---|
| 1 | 0:00.2 | 3.3 | Title card | Ghost Paths. Private payments by NEAR name. |
| 2 | 0:03.7 | 6.1 | Alice types a note and presses Send | Alice pays Bob using only his NEAR name. Her own MetaMask signs the payment. |
| 3 | 0:10.1 | 5.8 | Payment in progress | It lands at a brand-new address made just for Bob. A sealed note goes to NEAR. |
| 4 | 0:16.3 | 7.0 | Alice's receipt | On chain, nothing names Bob. To everyone else, Alice just paid a stranger. |
| 5 | 0:23.9 | 5.1 | Bob's app finds the payment | Bob's app finds it. Only his key can open the note. |
| 6 | 0:29.4 | 7.4 | Bob enters his wallet address | He withdraws to his everyday wallet. Nobody ever holds a private key for the one-time address. |
| 7 | 0:37.2 | 7.4 | NEAR signs the withdrawal | Bob approves, and NEAR Chain Signatures signs the transfer. His NEAR account never shows up. |
| 8 | 0:45.0 | 6.0 | The money arrives | Seconds later, the money is in his wallet. |
| 9 | 0:51.4 | 5.8 | What others see | And everyone else? Reading the whole public record, they trace zero payments to anyone. |
| 10 | 0:57.6 | 8.8 | Behind the scenes diagram | How it works: Bob publishes two keys on NEAR, once. Each payment gets a fresh address and a sealed note. NEAR signs the withdrawal. |
| 11 | 1:06.6 | 3.7 | Etherscan: Alice's payment | Check it yourself: a payment to a brand-new address. |
| 12 | 1:10.5 | 6.0 | NearBlocks: the note | NEAR: the note came from a relayer, and it has no recipient. |
| 13 | 1:16.8 | 6.4 | NearBlocks and Etherscan: the withdrawal | The withdrawal is just a signature for an opaque path, sent to the wallet Bob chose. |
| 14 | 1:23.4 | 4.3 | Bob's NEAR account page | Bob's NEAR account: one transaction, ever. His sign-up. |
| 15 | 1:28.0 | 3.0 | End card | Ghost Paths. Built at NEAR Hackathon. |

## Then

```bash
python3 scripts/add-voiceover.py ~/Downloads/voiceover.m4a      # → docs/video/ghost-paths-demo-voice.mp4
```

It prints where each line landed and how much it was sped up. If a take has a different number of pauses than
15 lines, it says how many it found; re-record with clearer 2-second pauses, or send one file per line.
