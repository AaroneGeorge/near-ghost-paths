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
const work = process.env.VIDEO_WORK ?? join(ROOT, "runs", `video-${stamp}`);
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

// The terminal playback runs on page timers; Chrome throttles those in pages it considers hidden
// (seen with Chrome for Testing on macOS: the render stalled), so switch the throttling off.
const NO_THROTTLE = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=IntensiveWakeUpThrottling",
];

/** Playwright wants the chromium build it was released with; fall back to any installed one. */
function findChromium(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(homedir(), ".cache", "ms-playwright"));
  if (!existsSync(base)) return undefined;
  const subs = [
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const d of readdirSync(base).sort().reverse()) {
    for (const sub of subs) {
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

// Injected into the UI page: a caption bar in the app's own look, and a click ripple.
const UI_INIT = `
window.addEventListener('DOMContentLoaded',()=>{
  const s=document.createElement('style');
  s.textContent='body{padding-bottom:110px!important}#gpcap{position:fixed;left:0;right:0;bottom:0;height:92px;z-index:99999;pointer-events:none;background:#142320;padding:12px 40px;font:600 21px/1.35 "Figtree Variable",-apple-system,sans-serif;color:#f3f7f5;display:flex;align-items:center;gap:16px}#gpcap:before{content:"";flex:none;width:10px;height:10px;border-radius:50%;background:#8fe3bd;box-shadow:0 0 0 5px rgba(143,227,189,.18)}.gprip{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border:3px solid #0e5e4a;border-radius:50%;z-index:99998;pointer-events:none;animation:gprip .6s ease-out forwards}@keyframes gprip{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}';
  document.head.appendChild(s);
  const c=document.createElement('div');c.id='gpcap';document.body.appendChild(c);
  window.__cap=t=>{c.textContent=t};
});
window.addEventListener('mousedown',e=>{const r=document.createElement('div');r.className='gprip';r.style.left=e.clientX+'px';r.style.top=e.clientY+'px';document.body.appendChild(r);setTimeout(()=>r.remove(),700)},true);
`;

/** The new web app, start to finish: send, receipt, inbox, withdraw, what others see, accountant. */
async function recordUi(base: string): Promise<Segment> {
  const browser = await chromium.launch({ executablePath: findChromium(), args: NO_THROTTLE });
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
  const center = (l: import("playwright").Locator) =>
    l.evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "center" }));
  const top = () => page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  const typeIn = async (id: string, text: string) => {
    await tid(id).fill("");
    await tid(id).pressSequentially(text, { delay: 55 });
  };
  const still = async (name: string) => {
    // README screenshots from the same run, without the caption bar
    if (replay) return;
    await page.evaluate(() => {
      const c = document.getElementById("gpcap");
      if (c) c.style.display = "none";
    });
    await page.screenshot({ path: join(ROOT, "docs", "img", name) });
    await page.evaluate(() => {
      const c = document.getElementById("gpcap");
      if (c) c.style.display = "flex";
    });
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/?token=${TOKEN}`);
    await tid("status")
      .getByText(/NEAR|Demo mode/)
      .waitFor();
    await tid("registered").getByText("Ready").waitFor();
    const trim = Math.max(0.4, (Date.now() - t0) / 1000 - 0.35);
    const where = replay
      ? "Demo mode: simulated networks, real privacy math."
      : "Live on NEAR testnet.";
    await cap(`The Ghost Paths web app. ${where} Alice pays Bob with just his NEAR name.`);
    await page.waitForTimeout(1800);
    await typeIn("memo", "invoice #44");
    await page.waitForTimeout(900);
    await tid("send").click();
    await cap(
      "Ghost Paths makes a brand-new address for this payment, pays it, and leaves Bob an encrypted note on NEAR.",
    );
    await tid("pay-result").waitFor({ timeout: 120_000 });
    await cap("Sent. The money sits at an address used once. Nothing on-chain says it's Bob's.");
    await page.waitForTimeout(1600);
    await still("ui-send.png");
    await page.waitForTimeout(1600);
    await center(tid("onetime-address"));
    await page.waitForTimeout(1600);
    await tid("pay-details").locator("summary").click();
    await page.waitForTimeout(300);
    await center(tid("announcement"));
    await cap(
      "Everything NEAR recorded: a key, a one-byte hint and an encrypted note. No recipient field.",
    );
    await page.waitForTimeout(3000);

    await top();
    await page.waitForTimeout(500);
    await tid("to-inbox").click();
    await cap(
      "Bob's inbox: only his key finds the payment among everyone's notes, with the note decrypted.",
    );
    const row = tid("payment-row").filter({ hasText: "invoice #44" }).last(); // newest
    await row.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    await center(row);
    await page.waitForTimeout(1200);
    await still("ui-inbox.png");
    await page.waitForTimeout(1200);
    await row.getByTestId("withdraw").click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLInputElement>('[data-testid="dest"]')].some(
        (i) => i.value.length > 0,
      ),
    );
    await page.waitForTimeout(500);
    await center(row.getByTestId("sweep"));
    await cap(
      "Withdraw: Bob approves with his key. A helper submits it, so nothing on NEAR points to his account.",
    );
    await page.waitForTimeout(2200);
    await row.getByTestId("sweep").click();
    await cap(
      "NEAR Chain Signatures signs for the one-time address: one NEAR contract, no Ethereum key.",
    );
    await row.getByTestId("sweep-result").waitFor({ timeout: 180_000 });
    await center(row.getByTestId("sweep-result"));
    await cap(
      "Arrived. On NEAR the record is a contract and a random-looking code. It doesn't name Bob.",
    );
    await page.waitForTimeout(3600);

    await tid("tab-public").click();
    await cap(
      "What everyone else sees: a fresh key reads the same public record and traces 0 payments.",
    );
    await tid("public-log").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2800);
    await center(tid("public-log"));
    await cap(
      "The public record has no 'for' column to fill. Amounts and timing stay public: who, not how much.",
    );
    await page.waitForTimeout(3200);

    await tid("tab-accountant").click();
    await cap(
      "An accountant gets a read-only key: every payment and note, a CSV export, and no way to move money.",
    );
    await page.waitForTimeout(1400);
    await tid("bundle-bob").click();
    await tid("auditor-result").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1600);
    await tid("export-csv").hover();
    await page.waitForTimeout(2800);
    if (errors.length) log(`browser errors: ${errors.join(" | ")}`);
    const seconds = (Date.now() - t0) / 1000 - trim;
    await page.screenshot({ path: join(work, "ui-last.png") });
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
    seconds: 8,
    title: "1. Infrastructure: NEAR testnet accounts, contract, local chains, MPC root keys",
    caption: replay
      ? "REPLAYED recording of a real run, no network. The same calls hit NEAR testnet and the Chain Signatures MPC when run live."
      : "A real run. NEAR testnet and the real Chain Signatures MPC (v1.signer-prod.testnet). Only the target chains, anvil and a Solana validator, are local.",
    highlight: /root keys|contract .* deployed|mode +contract/,
    drop: /starting anvil|^ {2}\$ ghost account create/,
  },
  {
    steps: [2],
    seconds: 7,
    title: "2. Bob registers one meta-address",
    caption:
      "Bob registers one meta-address in a NEAR contract: a spend key and a view key. He holds no ETH, SOL or BTC key at all.",
    highlight: /You hold two keys|registered gp-bob|NEAR tx/,
    drop: /keystore +\.|mode +contract \(Mode B/,
  },
  {
    steps: [3, 4],
    seconds: 9,
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
    seconds: 8,
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
    seconds: 9,
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
  const font = (pkg: string, file: string) =>
    `file://${join(ROOT, "apps/web/node_modules", pkg, "files", file)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:Bricolage;src:url("${font("@fontsource-variable/bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2")}") format("woff2");font-weight:200 800}
  @font-face{font-family:Figtree;src:url("${font("@fontsource-variable/figtree", "figtree-latin-wght-normal.woff2")}") format("woff2");font-weight:300 900}
  @font-face{font-family:JBMono;src:url("${font("@fontsource/jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2")}") format("woff2");font-weight:400}
  @font-face{font-family:JBMono;src:url("${font("@fontsource/jetbrains-mono", "jetbrains-mono-latin-700-normal.woff2")}") format("woff2");font-weight:700}
  *{box-sizing:border-box} html,body{margin:0;background:#0f1a17;color:#d3e0db;width:1280px;height:720px;overflow:hidden;
    font-family:JBMono,Menlo,monospace}
  #bar{height:30px;background:#16241f;display:flex;align-items:center;padding:0 14px;font-size:13px;color:#7f9690;gap:8px}
  #bar i{width:11px;height:11px;border-radius:50%;background:#2c3b37;display:inline-block}
  #bar b{margin-left:auto;color:#8fe3bd;font-weight:400}
  #term{position:absolute;top:30px;left:0;right:0;bottom:92px;padding:8px 16px;font-size:15px;line-height:19px;
    white-space:pre-wrap;word-break:break-all;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
  .l{min-height:19px;flex-shrink:0} .h{color:#b9f0d6;font-weight:700} .sc{color:#f3f7f5;font-weight:700}
  #cap{position:absolute;left:0;right:0;bottom:0;height:92px;background:#142320;border-top:1px solid #24352f;
    padding:12px 40px;font:600 21px/1.35 Figtree,-apple-system,sans-serif;color:#f3f7f5;display:flex;align-items:center;gap:16px}
  #cap:before{content:"";flex:none;width:10px;height:10px;border-radius:50%;background:#8fe3bd;box-shadow:0 0 0 5px rgba(143,227,189,.18)}
  #card{position:absolute;inset:0;background:#edf0f2;color:#142320;display:none;flex-direction:column;justify-content:center;
    padding:0 110px;font-family:Figtree,-apple-system,sans-serif}
  #card .mark{width:58px;height:58px;border-radius:50%;background:#b9f0d6;color:#0a4a3a;display:grid;place-items:center;margin-bottom:26px}
  #card h1{font:600 64px/1.05 Bricolage,sans-serif;letter-spacing:-.03em;margin:0 0 18px}
  #card p{font-size:27px;line-height:1.42;margin:6px 0;color:#2c3b37;max-width:30em}
  #card code{font:400 21px JBMono,monospace;white-space:nowrap;color:#0e5e4a;background:#fff;border:1px solid #d7dfdc;border-radius:10px;padding:4px 10px;display:inline-block;margin:4px 0}
  #card small{font-size:19px;line-height:1.4;color:#5d6c68;margin-top:26px;display:block}
  #card ul{list-style:none;font-size:23px;line-height:1.4;margin:10px 0 0;padding:0;color:#2c3b37;display:grid;gap:12px}
  #card li{display:grid;grid-template-columns:24px 1fr;gap:14px} #card li:before{content:"";width:10px;height:10px;border-radius:50%;background:#d08a1c;margin-top:12px}
  #card li.ok:before{background:#0e5e4a} #card li b{color:#142320}
  </style></head><body>
  <div id="bar"><i></i><i></i><i></i><span>ghost-paths: make demo</span><b>${badge}</b></div>
  <div id="term"></div>
  <div id="cap"></div>
  <div id="card"></div>
  <script>
  const term=document.getElementById('term'), cap=document.getElementById('cap'), card=document.getElementById('card');
  window.card=h=>{card.innerHTML=h;card.style.display='flex';cap.style.display='none';};
  window.hideCard=()=>{card.style.display='none';cap.style.display='flex';};
  window.setCaption=t=>{cap.textContent=t};
  // Pacing lives in Node (page.waitForTimeout): page timers stalled mid-render on macOS.
  const add=(cls,text)=>{const d=document.createElement('div');d.className='l'+cls;d.textContent=text||' ';term.appendChild(d);
    while(term.scrollHeight>term.clientHeight+2&&term.children.length>1)term.removeChild(term.firstElementChild);};
  window.addTitle=t=>add(' sc',t);
  window.addLine=(t,hl,beat)=>{add(hl?' h':'',t);if(beat)cap.textContent=beat;};
  </script></body></html>`;
}

/**
 * Renders a page as stills: `snap(seconds)` screenshots the page and holds that frame for the given
 * time; ffmpeg then joins the stills with exact durations. Deterministic, and independent of page
 * timers and real-time screen recording (both stalled mid-render on macOS).
 */
async function renderStills(
  name: string,
  fn: (
    call: (f: string, ...a: unknown[]) => Promise<unknown>,
    snap: (seconds: number) => Promise<void>,
    shot: (path: string) => Promise<void>,
  ) => Promise<void>,
): Promise<Segment> {
  const pagePath = join(work, "terminal.html");
  writeFileSync(pagePath, terminalHtml());
  const dir = join(work, `stills-${name}`);
  mkdirSync(dir, { recursive: true });
  const frames: { file: string; seconds: number }[] = [];
  // The headless browser occasionally vanished or froze mid-render on macOS, leaving Playwright
  // waiting forever. Every step has a deadline; on a miss the browser is relaunched and the page
  // state rebuilt by replaying the calls made so far (the page is a pure function of them).
  const history: string[] = [];
  let browser: import("playwright").Browser | undefined;
  let page: import("playwright").Page | undefined;
  const deadline = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
    ]);
  const open = async () => {
    await browser?.close().catch(() => undefined);
    // Stills need no vsync: with a sleeping or locked display macOS gives Chrome no display link
    // ("CVDisplayLinkCreateWithCGDisplay failed"), which is when the renders stalled.
    const args = [
      ...NO_THROTTLE,
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      "--disable-gpu",
    ];
    browser = await chromium.launch({ executablePath: findChromium(), args });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`file://${pagePath}`);
    await page.evaluate(() => document.fonts.ready);
    for (const expr of history) await page.evaluate(expr);
  };
  const retry = async <T>(what: string, step: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!page) await deadline(open(), 30_000, "browser launch");
        return await deadline(step(), 15_000, what);
      } catch (e) {
        if (attempt >= 3) throw e;
        log(`stills ${name}: ${(e as Error).message}; relaunching the browser (${attempt + 1}/3)`);
        page = undefined;
      }
    }
  };
  const call = async (f: string, ...a: unknown[]) => {
    const expr = `${f}(${a.map((x) => JSON.stringify(x)).join(",")})`;
    await retry(f, async () => page?.evaluate(expr));
    history.push(expr);
  };
  const shot = (path: string) =>
    retry("screenshot", async () => {
      await page?.screenshot({ path, timeout: 12_000 });
    });
  const snap = async (seconds: number) => {
    const file = join(dir, `${String(frames.length).padStart(4, "0")}.png`);
    await shot(file);
    frames.push({ file, seconds });
  };
  try {
    await fn(call, snap, shot);
  } finally {
    await browser?.close().catch(() => undefined);
  }
  const seconds = frames.reduce((x, f) => x + f.seconds, 0);
  const last = frames[frames.length - 1];
  if (!last) throw new Error(`no frames for ${name}`);
  // concat demuxer: each still with its duration; the last file is listed twice (ffmpeg quirk)
  const list = join(dir, "list.txt");
  writeFileSync(
    list,
    `${frames.map((f) => `file '${f.file}'\nduration ${f.seconds.toFixed(3)}`).join("\n")}\nfile '${last.file}'\n`,
  );
  const out = join(work, `${name}.mp4`);
  const enc = await sh([
    "ffmpeg",
    ...["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list],
    ...["-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", out],
  ]);
  if (enc.code !== 0) throw new Error(`ffmpeg (stills ${name}) failed: ${enc.out}`);
  return { webm: out, trim: 0, seconds };
}

const TITLE_SECONDS = 5;
const LIMITS_SECONDS = 11;
const END_SECONDS = 6;

const GHOST_MARK = `<div class="mark"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg></div>`;

const TITLE_CARD = `${GHOST_MARK}<h1>Ghost Paths</h1>
  <p>Pay anyone on Ethereum or Solana with just their NEAR account name. The money lands at a brand-new address that nobody else can tie to them.</p>
  <small>NEAR Chain Signatures owns the addresses, so the recipient holds no Ethereum or Solana key. Built at NEAR HACKATHON. Testnet and local chains only.</small>`;

const LIMITS_CARD = `<h1 style="font-size:50px">What Ghost Paths doesn't hide, and what this video doesn't show</h1><ul>
  <li>Amounts and timing are public. Ghost Paths hides who, not how much.</li>
  <li>The one-byte hint in each note can identify the recipient among the three demo accounts.</li>
  <li>Withdrawing several payments to one address links them. The helper (relayer) sees each request.</li>
  <li><b>Bitcoin: addresses derive, no payment shown. Confidential 1Click withdrawals: not run.</b></li>
  <li>${replay ? "Replayed, not live." : "NEAR testnet plus local chains."} Tiny anonymity set. Not audited.</li>
  <li class="ok">The recipient's name is never written on NEAR or on the payment's chain.</li></ul>`;

const END_CARD = `${GHOST_MARK}<h1>Ghost Paths</h1>
  <p>Private payments on Ethereum and Solana from one NEAR account, signed by Chain Signatures.</p>
  <p style="margin-top:22px"><code>git clone https://github.com/AaroneGeorge/near-ghost-paths</code><br><code>make demo</code> <span style="color:#5d6c68;font-size:21px">or <code style="font-size:20px">make demo-replay</code> offline</span></p>
  <small>Aarone George. Built at NEAR HACKATHON. Also by the same submitter: Tripwire (injection-proof policy changes for agent wallets).</small>`;

async function renderTerminal(text: string, scale = 1): Promise<Segment> {
  const { steps } = splitSteps(text);
  return renderStills("term", async (call, snap) => {
    await call("window.card", TITLE_CARD);
    await snap(TITLE_SECONDS);
    await call("window.hideCard");
    for (const plan of PLANS) {
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
      await call("window.addTitle", plan.title);
      const seconds = plan.seconds * scale;
      const w = lines.map((_, i) => (hl.includes(i) ? 2.6 : 1));
      const total = w.reduce((x, y) => x + y, 0) || 1;
      for (let i = 0; i < lines.length; i++) {
        await call("window.addLine", lines[i], hl.includes(i), beats[i] ?? null);
        // the scene's last line also holds the closing pause
        const hold = (seconds * 0.85 * (w[i] ?? 1)) / total;
        await snap(i === lines.length - 1 ? hold + seconds * 0.15 : hold);
      }
    }
  });
}

async function renderCards(): Promise<Segment> {
  return renderStills("cards", async (call, snap, shot) => {
    await call("window.card", LIMITS_CARD);
    await snap(LIMITS_SECONDS);
    await call("window.card", END_CARD);
    await shot(join(outDir, "poster.png"));
    await snap(END_SECONDS);
  });
}

// ---------------------------------------------------------------- main
/**
 * The live browser take runs in its own process: on macOS a second Playwright browser in the same
 * process crashed or hung, while the first one in a fresh process always worked. One retry.
 */
async function recordUiInChild(home: string | undefined): Promise<Segment> {
  const out = join(work, "ui-segment.json");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { out: log2, code } = await sh(["bun", "scripts/record-video.ts"], {
      VIDEO_PART: "ui",
      VIDEO_WORK: work,
      VIDEO_PART_HOME: home ?? "",
    });
    if (code === 0 && existsSync(out)) return JSON.parse(readFileSync(out, "utf8")) as Segment;
    log(`UI take ${attempt} failed: ${log2.trim().split("\n").slice(-3).join(" | ")}`);
    rmSync(join(work, "webm-ui"), { recursive: true, force: true });
  }
  throw new Error("the web app take failed twice");
}

async function main(): Promise<void> {
  const { text, home } = await captureDemo();
  writeFileSync(
    join(outDir, "demo-capture.txt"),
    `# Captured stdout of ${replay ? "make demo-replay (offline replay)" : "KEEP=1 make demo (real run: NEAR testnet + MPC, local anvil + Solana validator)"}, ${new Date().toISOString()}.\n# The video plays an abridged selection of these lines; step 8 (1Click dry quote) is not in the video.\n# Local paths are shortened; no keys are printed by the demo.\n\n${text}`,
  );
  // Stills first: on macOS the still renders stalled when they ran after the live browser take
  // in the same process, and never when they ran first.
  const term = await renderTerminal(text);
  log(`terminal part (incl. title card): ${term.seconds.toFixed(1)} s`);
  const cards = await renderCards();

  log("building the web app (ghost serve serves apps/web/dist)");
  const built = await sh(["make", "web-build"]);
  if (built.code !== 0) throw new Error(`web build failed:\n${built.out.slice(-800)}`);
  const ui = await recordUiInChild(home);
  log(`UI part: ${ui.seconds.toFixed(1)} s`);
  // Fit under 2:00: the live waits (payment, MPC signature) make the browser part vary; if it runs
  // long it is played slightly faster (at most 1.35x).
  const TARGET = 118;
  const over = term.seconds + ui.seconds + cards.seconds - TARGET;
  const uiSpeed = over > 0 ? ui.seconds / (ui.seconds - over) : 1;
  if (uiSpeed > 1.35)
    throw new Error(`UI part is ${ui.seconds.toFixed(0)} s: too long to fit 2:00`);
  log(`UI played at ${uiSpeed.toFixed(2)}x`);

  const mp4 = join(outDir, "ghost-paths-demo.mp4");
  // input 0 and 2 are mp4s made from stills, input 1 the Playwright webm of the web app
  const f = (i: number, s: Segment, speed = 1) =>
    `[${i}:v]trim=start=${s.trim.toFixed(2)}:duration=${s.seconds.toFixed(2)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},scale=1280:720,fps=30,setsar=1[v${i}]`;
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
    `${f(0, term)};${f(1, ui, uiSpeed)};${f(2, cards)};[v0][v1][v2]concat=n=3:v=1:a=0[out]`,
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

if (process.env.VIDEO_PART === "ui") {
  // child process: record the live web app take only, report the segment as JSON
  try {
    const base = await startServe(process.env.VIDEO_PART_HOME || undefined);
    const ui = await recordUi(base);
    writeFileSync(join(work, "ui-segment.json"), JSON.stringify(ui));
  } catch (e) {
    console.error(`[video] UI take failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    serve?.kill();
  }
  process.exit(process.exitCode ?? 0);
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
// A stuck Playwright promise must not keep the process alive after a failure.
process.exit(process.exitCode ?? 0);
