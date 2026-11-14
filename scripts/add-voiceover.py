#!/usr/bin/env python3
"""
Add a recorded voice-over to the demo video (docs/video/ghost-paths-demo.mp4, 1:31).

  python3 scripts/add-voiceover.py --guide > docs/VOICEOVER.md     # the script to read (already in the repo)
  python3 scripts/add-voiceover.py RECORDING [--out FILE] [--video FILE]

RECORDING is either
  - one audio file with all 15 lines read in order, with a pause of about 2 seconds between lines, or
  - a folder with one file per line, named so they sort in order (01.m4a, 02.m4a, … 15.m4a).
Any format ffmpeg reads (m4a, mp3, wav, aiff, ogg, webm…).

What it does: cleans the voice (rumble filter, light noise reduction, gentle compression), splits a single take on the
pauses into the 15 lines, trims each line's leading and trailing silence, places each line at its moment in the video
(CUES below), speeds a line up by at most 15% if it runs long, normalises loudness to -16 LUFS (web/X standard), and writes
the video with the voice track. The picture is copied untouched. Needs only python3 and ffmpeg.
Default output: docs/video/ghost-paths-demo-voice.mp4.
"""
import argparse, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIDEO = os.path.join(ROOT, "docs/video/ghost-paths-demo.mp4")

# (start s, room s, what is on screen, line). Start times are the sections of the 1:31 cut (docs/VIDEO-SCRIPT.md).
CUES = [
    (0.25, 3.3, "Title card", "Ghost Paths. Private payments by NEAR name."),
    (3.70, 6.1, "Alice types a note and presses Send", "Alice pays Bob using only his NEAR name. Her own MetaMask signs the payment."),
    (10.10, 5.8, "Payment in progress", "It lands at a brand-new address made just for Bob. A sealed note goes to NEAR."),
    (16.30, 7.0, "Alice's receipt", "On chain, nothing names Bob. To everyone else, Alice just paid a stranger."),
    (23.90, 5.1, "Bob's app finds the payment", "Bob's app finds it. Only his key can open the note."),
    (29.40, 7.4, "Bob enters his wallet address", "He withdraws to his everyday wallet. Nobody ever holds a private key for the one-time address."),
    (37.20, 7.4, "NEAR signs the withdrawal", "Bob approves, and NEAR Chain Signatures signs the transfer. His NEAR account never shows up."),
    (45.00, 6.0, "The money arrives", "Seconds later, the money is in his wallet."),
    (51.40, 5.8, "What others see", "And everyone else? Reading the whole public record, they trace zero payments to anyone."),
    (57.60, 8.8, "Behind the scenes diagram", "How it works: Bob publishes two keys on NEAR, once. Each payment gets a fresh address and a sealed note. NEAR signs the withdrawal."),
    (66.60, 3.7, "Etherscan: Alice's payment", "Check it yourself: a payment to a brand-new address."),
    (70.50, 6.0, "NearBlocks: the note", "NEAR: the note came from a relayer, and it has no recipient."),
    (76.80, 6.4, "NearBlocks and Etherscan: the withdrawal", "The withdrawal is just a signature for an opaque path, sent to the wallet Bob chose."),
    (83.40, 4.3, "Bob's NEAR account page", "Bob's NEAR account: one transaction, ever. His sign-up."),
    (88.00, 3.0, "End card", "Ghost Paths. Built at NEAR Hackathon."),
]
MAX_TEMPO = 1.15
CLEAN = "highpass=f=80,afftdn=nf=-28,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2"


def guide():
    print("# Voice-over script for the demo video\n")
    print("The demo video (`docs/video/ghost-paths-demo.mp4`, 1:31) has no sound. Record these 15 lines and the editing is")
    print("automatic: `python3 scripts/add-voiceover.py <recording>` cuts the recording into the lines, cleans it, and places")
    print("each line at its moment in the video.\n")
    print("## How to record\n")
    print("- A phone voice memo is fine. A quiet room with soft things around (not a bathroom). Phone about 20 cm from the mouth,")
    print("  slightly to the side.")
    print("- Read **all 15 lines in one take, in order**, and leave a **2-second pause** between lines. If you fluff a line,")
    print("  stop, wait 2 seconds, and record the whole take again (or send one file per line instead: `01.m4a` … `15.m4a`).")
    print("- Calm, friendly, a little slower than talking: like explaining something to a smart friend. Each line has a time")
    print("  budget below; read it once against a stopwatch. Up to 15% over is fixed automatically by a slight speed-up.")
    print("- Say \"NEAR\" as the word *near*. \"MetaMask\": *meta-mask*. \"Etherscan\": *ether-scan*.")
    print("- Send the file as it is (m4a, mp3 and wav are all fine). No editing needed.\n")
    print("## The lines\n")
    print("| # | At | Seconds | On screen | Read |")
    print("|---|---|---|---|---|")
    for i, (start, room, screen, line) in enumerate(CUES, 1):
        m, s = divmod(start, 60)
        print(f"| {i} | {int(m)}:{s:04.1f} | {room:.1f} | {screen} | {line} |")
    print("\n## Then\n")
    print("```bash")
    print("python3 scripts/add-voiceover.py ~/Downloads/voiceover.m4a      # → docs/video/ghost-paths-demo-voice.mp4")
    print("```")
    print("\nIt prints where each line landed and how much it was sped up. If a take has a different number of pauses than")
    print("15 lines, it says how many it found; re-record with clearer 2-second pauses, or send one file per line.")


def run(cmd, capture=False):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ffmpeg failed: {' '.join(cmd)[:200]}\n{r.stderr[-1500:]}")
    return r.stderr if capture else None


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out)


def speech_spans(wav, noise_db, min_sil):
    err = run(["ffmpeg", "-hide_banner", "-i", wav, "-af", f"silencedetect=n={noise_db}dB:d={min_sil}", "-f", "null", "-"],
              capture=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
    total = duration(wav)
    spans, cur = [], 0.0
    for s, e in zip(starts, ends + [total] * (len(starts) - len(ends))):
        if s - cur > 0.25:
            spans.append((cur, s))
        cur = e
    if total - cur > 0.25:
        spans.append((cur, total))
    return spans


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording", nargs="?")
    ap.add_argument("--video", default=VIDEO)
    ap.add_argument("--out", default=os.path.join(ROOT, "docs/video/ghost-paths-demo-voice.mp4"))
    ap.add_argument("--guide", action="store_true", help="print the recording script (docs/VOICEOVER.md)")
    a = ap.parse_args()
    if a.guide:
        return guide()
    if not a.recording:
        ap.error("give the recording (one file, or a folder of 01…15 files)")
    tmp = tempfile.mkdtemp(prefix="voiceover-")
    n = len(CUES)
    clips = []
    if os.path.isdir(a.recording):
        files = sorted(f for f in os.listdir(a.recording) if not f.startswith("."))
        if len(files) != n:
            sys.exit(f"the folder has {len(files)} files; expected {n} (one per line, sorted in order)")
        for i, f in enumerate(files):
            out = f"{tmp}/l{i:02d}.wav"
            run(["ffmpeg", "-y", "-i", os.path.join(a.recording, f), "-ac", "1", "-ar", "48000", "-af", CLEAN, out])
            clips.append(out)
    else:
        full = f"{tmp}/full.wav"
        run(["ffmpeg", "-y", "-i", a.recording, "-ac", "1", "-ar", "48000", "-af", CLEAN, full])
        spans = None
        for d in (1.2, 1.0, 0.8, 1.5, 0.6):          # longest pause first: commas inside a line are short
            for nd in (-35, -40, -30, -45):
                s = speech_spans(full, nd, d)
                if len(s) == n:
                    spans = s
                    break
            if spans:
                break
        if not spans:
            got = speech_spans(full, -35, 1.0)
            sys.exit(f"found {len(got)} spoken parts separated by pauses; expected {n}.\n"
                     f"Re-record with a clear 2-second pause between lines, or send one file per line.\n"
                     f"Parts (seconds): {[round(e - s, 1) for s, e in got]}")
        for i, (s, e) in enumerate(spans):
            out = f"{tmp}/l{i:02d}.wav"
            run(["ffmpeg", "-y", "-i", full, "-ss", f"{max(0, s - 0.08):.3f}", "-to", f"{e + 0.12:.3f}", out])
            clips.append(out)
    # trim each line's own silence at both ends
    trimmed = []
    for i, c in enumerate(clips):
        out = f"{tmp}/t{i:02d}.wav"
        run(["ffmpeg", "-y", "-i", c, "-af",
             "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,"
             "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12,areverse", out])
        trimmed.append(out)

    vdur = duration(a.video)
    inputs, filters, labels = [], [], []
    print(f"{'#':>2}  {'at':>6}  {'room':>5}  {'said':>5}  {'speed':>5}  line")
    for i, (clip, (start, room, _, line)) in enumerate(zip(trimmed, CUES)):
        d = duration(clip)
        nxt = CUES[i + 1][0] if i + 1 < n else vdur
        limit = nxt - start - 0.15                     # must end before the next line starts
        target = min(room, limit)
        tempo = 1.0 if d <= target else min(MAX_TEMPO, d / target)
        if d / tempo > limit:
            sys.exit(f"line {i + 1} is {d:.1f} s; even at {MAX_TEMPO:.0%} speed it would run into line {i + 2}. "
                     f"Re-record it a little faster (room: {room:.1f} s): \"{line}\"")
        inputs += ["-i", clip]
        f = f"[{i}:a]" + (f"atempo={tempo:.3f}," if tempo > 1 else "") + f"adelay={int(start * 1000)}:all=1[a{i}]"
        filters.append(f); labels.append(f"[a{i}]")
        print(f"{i + 1:>2}  {start:6.1f}  {room:5.1f}  {d:5.1f}  {tempo:5.2f}  {line[:60]}")
    mix = (";".join(filters) + ";" + "".join(labels) +
           f"amix=inputs={n}:normalize=0,apad=whole_dur={vdur:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[voice]")
    voice = f"{tmp}/voice.m4a"
    run(["ffmpeg", "-y", *inputs, "-filter_complex", mix, "-map", "[voice]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
         "-t", f"{vdur:.3f}", voice])
    run(["ffmpeg", "-y", "-i", a.video, "-i", voice, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy",
         "-shortest", "-movflags", "+faststart", a.out])
    print(f"\nwrote {a.out} ({duration(a.out):.1f} s, voice at -16 LUFS). Work files: {tmp}")


if __name__ == "__main__":
    main()
