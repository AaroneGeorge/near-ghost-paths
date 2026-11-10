#!/usr/bin/env bun
/**
 * make video: render the demo video (docs/VIDEO-SCRIPT.md) with no screen recorder.
 *
 *  1. runs `KEEP=1 make demo` (the real run: NEAR testnet + the real Chain Signatures MPC, anvil and a
 *     Solana validator in docker) and captures its stdout. VIDEO_SOURCE=replay uses `make demo-replay`
 *     and `ghost serve --dev=1` instead (offline; every caption then says "replayed"/"simulated").
 *  2. starts `ghost serve` against the kept run and drives the REAL web UI in Playwright chromium
 *     (send, scan as recipient and stranger, sweep). The page is recorded as it happens.
 *  3. plays the captured terminal text back in a rendered terminal page, scene by scene, with captions,
 *     while Playwright records that page; title, limits and end cards are drawn by the same page.
 *  4. ffmpeg joins terminal part, UI part and end cards into one mp4.
 *
 * The video is silent: captions are burned in; the voice-over text is in docs/VIDEO-SCRIPT.md.
 * Needs: bun, make, ffmpeg, docker (live source) and a Playwright chromium build (apps/web already
 * depends on playwright; `bun x playwright install chromium` if none is found).
 * Output: docs/video/ghost-paths-demo.mp4, poster.png, demo-capture.txt. Work files: runs/video-<ts>/.
 * Cleanup: the kept run is removed with `make demo-clean` at the end (VIDEO_KEEP_STATE=1 skips that).
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// playwright lives in apps/web (a workspace dependency); import it by path so this file needs no own dependency
const { chromium } = (await import(join(ROOT, "apps/web/node_modules/playwright"))) as {
  chromium: import("playwright").BrowserType;
};

const replay = process.env.VIDEO_SOURCE === "replay";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const work = join(ROOT, "runs", `video-${stamp}`);
const outDir = join(ROOT, "docs", "video");
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });
const log = (s: string) => console.log(`[video] ${s}`);

async function sh(
  cmd: string[],
  env: Record<string, string> = {},
): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out: out + (code === 0 ? "" : err), code };
}

/** Playwright wants the chromium build it was released with; fall back to any installed one. */
function findChromium(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).sort().reverse()) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = join(base, d, sub);
      if (d.startsWith("chromium-") && existsSync(p)) return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 1. capture the demo
const clean = (s: string) =>
  s
    .replaceAll(ROOT, ".")
    .replace(/\.\/\.secrets\/demo\/(local|replay)-\d+T\d+/g, ".secrets/demo/<run>")
    .split("\n")
    .filter((l) => !/^make(\[\d+\])?: /.test(l))
    .join("\n");

async function captureDemo(): Promise<{ text: string; home: string | undefined }> {
  // development shortcut: reuse an earlier capture and its kept run instead of running the demo again
  const reuse = process.env.VIDEO_REUSE_CAPTURE;
  if (reuse) {
    const text = readFileSync(reuse, "utf8");
    return { text: clean(text), home: process.env.VIDEO_REUSE_HOME };
  }
  const target = replay ? "demo-replay" : "demo";
  log(`running make ${target} (${replay ? "about 35" : "about 90"} s)`);
  const { out, code } = await sh(["make", target], { NO_COLOR: "1", KEEP: replay ? "" : "1" });
  if (code !== 0)
    throw new Error(
      `make ${target} exited ${code}; refusing to render a failed run:\n${out.slice(-800)}`,
    );
  if (!/demo OK: 17\/17 checks passed/.test(out))
    throw new Error("the demo did not report 17/17 checks");
  const home = out.match(/profiles in (\S+) \(GHOST_HOME\)/)?.[1];
  return { text: clean(out), home };
}

// ---------------------------------------------------------------- 2. the real web UI
const UI_PORT = 18788;
const TOKEN = crypto.randomUUID().replaceAll("-", "");
let serve: ChildProcess | undefined;

async function startServe(home: string | undefined): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, GHOST_SERVE_TOKEN: TOKEN };
  const args = ["packages/cli/src/ghost.ts", "serve", "--port", String(UI_PORT)];
  if (replay || !home) {
    args.push("--dev=1");
    env.GHOST_DEV_DELAY_MS = "900";
  } else {
    env.GHOST_HOME = home;
    env.GHOST_RELAYER_URL = "http://127.0.0.1:8787";
  }
  serve = spawn("bun", args, { cwd: ROOT, env, stdio: "ignore" });
  const base = `http://127.0.0.1:${UI_PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return base;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  throw new Error("ghost serve did not start");
}

// Injected into the UI page: a caption bar (same look as the terminal part) and a click ripple.
const UI_INIT = `
window.addEventListener('DOMContentLoaded',()=>{
  const s=document.createElement('style');
  s.textContent='body{padding-bottom:110px!important}#gpcap{position:fixed;left:0;right:0;bottom:0;height:92px;z-index:99999;pointer-events:none;background:#10141a;border-top:2px solid #2a3140;padding:12px 28px;font:600 21px/1.3 "DejaVu Sans",sans-serif;color:#f1f3f6;display:flex;align-items:center}.gprip{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border:3px solid #ffd866;border-radius:50%;z-index:99998;pointer-events:none;animation:gprip .6s ease-out forwards}@keyframes gprip{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}';
  document.head.appendChild(s);
  const c=document.createElement('div');c.id='gpcap';document.body.appendChild(c);
  window.__cap=t=>{c.textContent=t};
});
window.addEventListener('mousedown',e=>{const r=document.createElement('div');r.className='gprip';r.style.left=e.clientX+'px';r.style.top=e.clientY+'px';document.body.appendChild(r);setTimeout(()=>r.remove(),700)},true);
`;

async function recordUi(base: string): Promise<Segment> {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: join(work, "webm-ui"), size: { width: 1280, height: 720 } },
  });
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.addInitScript(UI_INIT);
  const cap = (t: string) =>
    page.evaluate((x) => (window as never as { __cap(t: string): void }).__cap(x), t);
  const tid = (id: string) => page.getByTestId(id);
  const center = (id: string, nth = 0) =>
    tid(id)
      .nth(nth)
      .evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "center" }));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/?token=${TOKEN}`);
    await tid("status")
      .getByText(/live|simulated/)
      .waitFor();
    const trim = Math.max(0.4, (Date.now() - t0) / 1000 - 0.35);
    const live = replay
      ? "simulated chains, replayed: no network"
      : "live: real NEAR testnet and MPC, local anvil and Solana";
    await cap(
      `Same flow in the browser (${live}). Keys stay in the server process, never in the page.`,
    );
    await page.getByTestId("recipient").waitFor();
    await page.waitForTimeout(500);
    await tid("payer").selectOption("alice");
    await tid("recipient").fill("bob");
    await tid("registered").getByText("registered", { exact: true }).waitFor();
    await tid("memo").fill("invoice #44");
    await page.waitForTimeout(1500);
    await cap(
      "Send: Alice pays Bob 0.01 ETH. The MPC derives a one-time address, then a relayer posts the announcement to NEAR.",
    );
    await tid("send").click();
    await tid("pay-result").waitFor({ timeout: 120_000 });
    await page.waitForTimeout(600);
    await cap("The payment went to a one-time address. The announcement has no recipient field.");
    await center("onetime-address");
    await page.waitForTimeout(2000);
    await center("announcement");
    await page.waitForTimeout(2500);

    await cap(
      "Scan as the recipient: Bob's viewing key finds the new payment, status unspent. Earlier ones are already swept.",
    );
    await tid("to-scan").click();
    await tid("scan-result").waitFor();
    const row = tid("payment-row").filter({ hasText: "invoice #44" }).first();
    await row.waitFor();
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await page.waitForTimeout(1300);
    await row.evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "center" }));
    await page.waitForTimeout(2200);
    await cap(
      "Scan as a stranger: a random key reads the same public log and finds 0 payments. The log names no recipient.",
    );
    await tid("view-stranger").click();
    await tid("stranger-run").click();
    await tid("stranger-result").waitFor();
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await page.waitForTimeout(2200);
    await center("public-log");
    await page.waitForTimeout(2200);

    await cap(
      "Sweep: a relayer submits, the contract asks the MPC to sign, the funds move to a throwaway address (local demo chain).",
    );
    await tid("tab-sweep").click();
    await tid("payment-option").first().waitFor();
    await page.waitForTimeout(500);
    await page.locator('[data-testid="payment-option"]:not([disabled])').first().click();
    await tid("fresh-dest").click();
    await page.waitForTimeout(1200);
    await tid("sweep").click();
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await tid("sweep-result").waitFor({ timeout: 180_000 });
    await cap(
      "The balance moved. On NEAR the record is a contract call with an opaque path: nothing names Bob.",
    );
    await page.waitForTimeout(400);
    await center("bal-delta");
    await page.waitForTimeout(4200);
    if (errors.length) log(`browser errors: ${errors.join(" | ")}`);
    const seconds = (Date.now() - t0) / 1000 - trim;
    const shot = join(work, "ui-last.png");
    await page.screenshot({ path: shot });
    await ctx.close();
    const webm = readdirSync(join(work, "webm-ui")).find((f) => f.endsWith(".webm"));
    if (!webm) throw new Error("Playwright wrote no UI video");
    return { webm: join(work, "webm-ui", webm), trim, seconds };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- 3. the terminal playback
interface Segment {
  webm: string;
  /** seconds of blank video before the first content */
  trim: number;
  /** seconds of content */
  seconds: number;
}
interface Scene {
  title: string;
  lines: string[];
}
interface Beat {
  /** first line matching this sets the caption */
  re: RegExp;
  text: string;
}
interface Plan {
  /** demo step numbers played together as one scene */
  steps: number[];
  seconds: number;
  title: string;
  caption: string;
  highlight: RegExp;
  beats?: Beat[];
  drop?: RegExp;
}

function splitSteps(text: string): { intro: string[]; steps: Map<number, Scene> } {
  const lines = text.replace(/\r/g, "").split("\n");
  const intro: string[] = [];
  const steps = new Map<number, Scene>();
  let cur: Scene | undefined;
  for (const l of lines) {
    const m = l.match(/^\[\d+:\d\d\] (\d+)\. (.*)$/);
    if (m) {
      cur = { title: l, lines: [] };
      steps.set(Number(m[1]), cur);
      continue;
    }
    if (/^demo OK/.test(l)) break;
    (cur?.lines ?? intro).push(l);
  }
  return { intro, steps };
}

const PLANS: Plan[] = [
  {
    steps: [1],
    seconds: 9,
    title: "1. Infrastructure: NEAR testnet accounts, contract, local chains, MPC root keys",
    caption: replay
      ? "REPLAYED recording of a real run, no network. The same calls hit NEAR testnet and the Chain Signatures MPC when run live."
      : "A real run. NEAR testnet and the real Chain Signatures MPC (v1.signer-prod.testnet). Only the target chains, anvil and a Solana validator, are local.",
    highlight: /root keys|contract .* deployed|mode +contract/,
    drop: /starting anvil|^ {2}\$ ghost account create/,
  },
  {
    steps: [2],
    seconds: 8,
    title: "2. Bob registers one meta-address",
    caption:
      "Bob registers one meta-address in a NEAR contract: a spend key and a view key. He holds no ETH, SOL or BTC key at all.",
    highlight: /You hold two keys|registered gp-bob|NEAR tx/,
    drop: /keystore +\.|mode +contract \(Mode B/,
  },
  {
    steps: [3, 4],
    seconds: 12,
    title: "3. Alice pays Bob: 0.01 ETH, then 0.1 SOL",
    caption:
      "Alice pays a fresh one-time address the MPC derives for the Ghost Paths contract. The NEAR announcement has no recipient field.",
    highlight: /one-time address|= MPC-derive|announcement +idx/,
    drop: /funding payer|paying 0\.|^ {6}stealth address|^ {6}payment tx/,
    beats: [
      {
        re: /sol:local at a|one-time address \S+ on solana/,
        text: "Solana: the same call with MPC domain 1 (ed25519). One NEAR account, two chains, no chain keys.",
      },
    ],
  },
  {
    steps: [5],
    seconds: 12,
    title: "4. Who can see the payments? stranger, recipient, auditor",
    caption: "A stranger scanning the same log finds nothing.",
    highlight: /carol scanned|bob scanned|invoice #4[23]|viewing key only|auditor \(/,
    drop: /export-viewing-key|viewing-key bundle|It reveals every/,
    beats: [
      { re: /bob scanned/, text: "The recipient finds both payments, with the memos decrypted." },
      {
        re: /auditor \(/,
        text: "An auditor holding only a viewing key sees them too, and cannot sweep.",
      },
    ],
  },
  {
    steps: [6, 7],
    seconds: 12,
    title: "5. Bob sweeps both payments through the relayer and the MPC",
    caption:
      "Bob signs a sweep authorisation. A relayer submits it, the contract verifies it and asks the MPC to sign. The destination is inside the signed digest.",
    highlight: /MPC signature in|destination balance|nothing names/,
    drop: /preparing |^ {6}from \(stealth\)|^ {6}to +|^ {6}MPC time|^ {2}✓ swept|NEAR explorer:|^ {6}chain tx/,
    beats: [
      {
        re: /destination balance/,
        text: "Funds arrive at a fresh destination. On NEAR: a contract call with an opaque path. It names a relayer, not Bob.",
      },
    ],
  },
];

function terminalHtml(): string {
  const badge = replay
    ? "REPLAYED recording of a real run (offline), abridged"
    : "make demo: real run, output abridged";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0;background:#0b0e13;color:#d7dce2;width:1280px;height:720px;overflow:hidden;
    font-family:"DejaVu Sans Mono",monospace}
  #bar{height:30px;background:#171b22;display:flex;align-items:center;padding:0 14px;font-size:13px;color:#8b93a1;gap:8px}
  #bar i{width:11px;height:11px;border-radius:50%;background:#394150;display:inline-block}
  #bar b{margin-left:auto;color:#e0b341;font-weight:400}
  #term{position:absolute;top:30px;left:0;right:0;bottom:92px;padding:8px 16px;font-size:15px;line-height:19px;
    white-space:pre-wrap;word-break:break-all;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
  .l{min-height:19px;flex-shrink:0} .h{color:#ffd866;font-weight:700} .sc{color:#7fd1ff;font-weight:700}
  #cap{position:absolute;left:0;right:0;bottom:0;height:92px;background:#10141a;border-top:2px solid #2a3140;
    padding:12px 28px;font:600 21px/1.3 "DejaVu Sans",sans-serif;color:#f1f3f6;display:flex;align-items:center}
  #card{position:absolute;inset:0;background:#0b0e13;display:none;flex-direction:column;justify-content:center;
    padding:0 80px;font-family:"DejaVu Sans",sans-serif}
  #card h1{font-size:58px;margin:0 0 16px;letter-spacing:.5px} #card p{font-size:26px;line-height:1.42;margin:6px 0;color:#c9cfd8}
  #card code{font:600 27px "DejaVu Sans Mono",monospace;color:#ffd866}
  #card small{font-size:19px;line-height:1.4;color:#8b93a1;margin-top:22px;display:block}
  #card ul{font-size:24px;line-height:1.42;margin:8px 0;padding-left:28px;color:#c9cfd8} #card li b{color:#fff}
  </style></head><body>
  <div id="bar"><i></i><i></i><i></i><span>ghost-paths: make demo</span><b>${badge}</b></div>
  <div id="term"></div>
  <div id="cap"></div>
  <div id="card"></div>
  <script>
  const term=document.getElementById('term'), cap=document.getElementById('cap'), card=document.getElementById('card');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  window.card=h=>{card.innerHTML=h;card.style.display='flex';cap.style.display='none';};
  window.hideCard=()=>{card.style.display='none';cap.style.display='flex';};
  window.setCaption=t=>{cap.textContent=t};
  window.playScene=async(title,lines,seconds,hl,beats)=>{
    const t=document.createElement('div');t.className='l sc';t.textContent=title;term.appendChild(t);
    const w=lines.map((l,i)=>hl.includes(i)?2.6:1);const total=w.reduce((a,b)=>a+b,0)||1;
    const budget=seconds*1000*0.85;
    for(let i=0;i<lines.length;i++){
      const d=document.createElement('div');d.className='l'+(hl.includes(i)?' h':'');d.textContent=lines[i]||' ';
      term.appendChild(d);
      while(term.scrollHeight>term.clientHeight+2&&term.firstChild&&term.children.length>1)term.removeChild(term.firstChild);
      if(beats[i])cap.textContent=beats[i];
      await sleep(budget*w[i]/total);
    }
    await sleep(seconds*1000*0.15);
  };
  </script></body></html>`;
}

async function recordPage(
  name: string,
  fn: (
    call: (f: string, ...a: unknown[]) => Promise<unknown>,
    page: import("playwright").Page,
  ) => Promise<void>,
): Promise<Segment> {
  const pagePath = join(work, "terminal.html");
  writeFileSync(pagePath, terminalHtml());
  const browser = await chromium.launch({ executablePath: findChromium() });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: join(work, `webm-${name}`), size: { width: 1280, height: 720 } },
  });
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.goto(`file://${pagePath}`);
  const call = (f: string, ...a: unknown[]) =>
    page.evaluate(`${f}(${a.map((x) => JSON.stringify(x)).join(",")})`);
  const trim = (Date.now() - t0) / 1000;
  const t1 = Date.now();
  await fn(call, page);
  const seconds = (Date.now() - t1) / 1000;
  await ctx.close();
  await browser.close();
  const webm = readdirSync(join(work, `webm-${name}`)).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("Playwright wrote no video");
  return { webm: join(work, `webm-${name}`, webm), trim, seconds };
}

const TITLE_SECONDS = 5;
const LIMITS_SECONDS = 11;
const END_SECONDS = 6;

const TITLE_CARD = `<h1>Ghost Paths</h1>
  <p>Pay a NEAR account at a fresh one-time address on Ethereum or Solana. The chain never names the recipient; amounts and timing stay public.</p>
  <p>One NEAR account and no chain keys: NEAR Chain Signatures (MPC) own the addresses.</p>
  <small>Built at NEAR HACKATHON · testnet and local chains only</small>`;

const LIMITS_CARD = `<h1 style="font-size:46px">What is not private, and what was not shown</h1><ul>
  <li>Amounts and timing are public. Ghost Paths hides who, not how much.</li>
  <li>The view tag leaks one byte; with three demo accounts that can identify the recipient.</li>
  <li>Sweeping several payments to one address links them. A relayer sees each sweep request.</li>
  <li><b>Bitcoin: addresses derive, no payment demoed.</b></li>
  <li><b>Confidential 1Click sweep: needs an API key, not run, not shown.</b></li>
  <li>${replay ? "Replayed, not live." : "Testnet NEAR plus local chains."} Tiny anonymity set. Not audited.</li></ul>`;

const END_CARD = `<h1>Ghost Paths</h1>
  <p>ERC-5564-style stealth addresses on Ethereum and Solana from one NEAR account, signed by Chain Signatures.</p>
  <p style="margin-top:26px"><code>git clone https://github.com/AaroneGeorge/near-ghost-paths</code><br><code>make demo</code> <span style="color:#8b93a1;font-size:22px">(or <code style="font-size:22px">make demo-replay</code>, offline)</span></p>
  <small>Aarone George · built at NEAR HACKATHON · same submitter: Tripwire (injection-proof policy changes for agent wallets)</small>`;

async function renderTerminal(text: string): Promise<Segment> {
  const { steps } = splitSteps(text);
  return recordPage("term", async (call, page) => {
    await call("window.card", TITLE_CARD);
    await page.waitForTimeout(TITLE_SECONDS * 1000);
    await call("window.hideCard");
    for (const [n, plan] of PLANS.entries()) {
      const lines: string[] = [];
      for (const s of plan.steps) {
        const sc = steps.get(s);
        if (!sc) throw new Error(`demo output has no step ${s}`);
        lines.push(...sc.lines.filter((l) => l.trim() && !plan.drop?.test(l)));
      }
      const hl = lines.flatMap((l, i) => (plan.highlight.test(l) ? [i] : []));
      const beats: Record<number, string> = {};
      for (const b of plan.beats ?? []) {
        const i = lines.findIndex((l) => b.re.test(l));
        if (i >= 0) beats[i] = b.text;
      }
      await call("window.setCaption", plan.caption);
      await call("window.playScene", plan.title, lines, plan.seconds, hl, beats);
    }
  });
}

async function renderCards(): Promise<Segment> {
  return recordPage("cards", async (call, page) => {
    await call("window.card", LIMITS_CARD);
    await page.waitForTimeout(LIMITS_SECONDS * 1000);
    await call("window.card", END_CARD);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "poster.png") });
    await page.waitForTimeout(END_SECONDS * 1000 - 500);
  });
}

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
  const { text, home } = await captureDemo();
  writeFileSync(
    join(outDir, "demo-capture.txt"),
    `# Captured stdout of ${replay ? "make demo-replay (offline replay)" : "KEEP=1 make demo (real run: NEAR testnet + MPC, local anvil + Solana validator)"}, ${new Date().toISOString()}.\n# The video plays an abridged selection of these lines; step 8 (1Click dry quote) is not in the video.\n# Local paths are shortened; no keys are printed by the demo.\n\n${text}`,
  );
  const base = await startServe(home);
  const ui = await recordUi(base);
  log(`UI part: ${ui.seconds.toFixed(1)} s`);
  serve?.kill();
  const term = await renderTerminal(text);
  log(`terminal part (incl. title card): ${term.seconds.toFixed(1)} s`);
  const cards = await renderCards();

  const mp4 = join(outDir, "ghost-paths-demo.mp4");
  const f = (i: number, s: Segment) =>
    `[${i}:v]trim=start=${s.trim.toFixed(2)}:duration=${s.seconds.toFixed(2)},setpts=PTS-STARTPTS,scale=1280:720,fps=30,setsar=1[v${i}]`;
  const enc = await sh([
    "ffmpeg",
    "-y",
    "-loglevel",
    "error",
    "-i",
    term.webm,
    "-i",
    ui.webm,
    "-i",
    cards.webm,
    "-filter_complex",
    `${f(0, term)};${f(1, ui)};${f(2, cards)};[v0][v1][v2]concat=n=3:v=1:a=0[out]`,
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  if (enc.code !== 0) throw new Error(`ffmpeg failed: ${enc.out}`);
  const probe = await sh([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration,size",
    "-of",
    "default=nw=1",
    mp4,
  ]);
  log(`wrote ${mp4}`);
  console.log(probe.out.trim());
  const dur = Number(probe.out.match(/duration=([\d.]+)/)?.[1] ?? 0);
  const mb = statSync(mp4).size / 1e6;
  if (dur > 120) throw new Error(`video is ${dur.toFixed(1)} s, over the 2:00 limit`);
  if (mb > 20) throw new Error(`video is ${mb.toFixed(1)} MB, over 20 MB`);
  if (process.env.VIDEO_KEEP !== "1") {
    for (const d of readdirSync(work)) rmSync(join(work, d), { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (e) {
  console.error(`[video] failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  serve?.kill();
  if (!replay && process.env.VIDEO_KEEP_STATE !== "1") {
    log("make demo-clean (stops the relayer and docker chains, deletes the kept NEAR accounts)");
    await sh(["make", "demo-clean"]);
  }
}
