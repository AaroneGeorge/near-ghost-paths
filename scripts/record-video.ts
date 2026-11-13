#!/usr/bin/env bun
/**
 * make video: the product demo video (docs/VIDEO-SCRIPT.md), under 2:00, silent with burned-in captions.
 *
 * Story: the problem → Alice pays Bob in the web app → Bob's inbox and withdrawal → what everyone else
 * sees → Bob's accountant → behind the scenes (animated) → proof (a real macOS Terminal run and the
 * transactions on the public testnet explorers) → what you can build with it → honest limits → end.
 *
 * Everything shown is live: NEAR testnet + the real Chain Signatures signer, Ethereum Sepolia and
 * Solana devnet.
 *  1. The cards (problem, behind the scenes, use cases, limits, end) are HTML rendered as stills.
 *  2. Terminal.app runs `KEEP=1 make demo-testnet` while ffmpeg records that window (macOS only:
 *     needs Screen Recording permission for the app running this script, and nobody using the Mac
 *     for about 3 minutes).
 *  3. Playwright drives the real web app against that kept run: Alice pays, Bob withdraws.
 *  4. Brave (driven by Playwright) opens the explorer pages of that exact payment and withdrawal.
 *  5. ffmpeg cuts out the waits and joins everything.
 *
 * Needs: macOS, bun, make, ffmpeg, Brave, a Playwright chromium build, and testnet funds:
 *   .secrets/demo/testnet-payer.env  FUNDER_EVM_PK=… (Sepolia ETH) and FUNDER_SOL_KEY=… (devnet SOL)
 *   .secrets/demo/funder.json        the NEAR testnet funder (created by make demo on first use)
 * Output: docs/video/automated/ghost-paths-demo.mp4, poster.png, demo-capture.txt, explorer-links.txt, README screenshots.
 * Cleanup: make demo-clean at the end (VIDEO_KEEP_STATE=1 skips it). VIDEO_KEEP=1 keeps runs/video-*.
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
const WEB_MODULES = join(ROOT, "apps/web/node_modules");
// playwright, react and lucide live in apps/web; import them by path so this file needs no own deps
const { chromium } = (await import(join(WEB_MODULES, "playwright"))) as {
  chromium: import("playwright").BrowserType;
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const work = process.env.VIDEO_WORK ?? join(ROOT, "runs", `video-${stamp}`);
// The shipped video (docs/video/ghost-paths-demo.mp4) is the two-party MetaMask take (docs/VIDEO-SCRIPT.md);
// this automated render goes next to it so it never overwrites it.
const outDir = join(ROOT, "docs", "video", "automated");
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });
const log = (s: string) => console.log(`[video] ${s}`);
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const W = 1280;
const H = 720;
const CAP_H = 92; // caption bar height; clips above it are 1280x628
const CLIP_H = H - CAP_H;

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
const ff = async (args: string[], what: string) => {
  const r = await sh(["ffmpeg", "-y", "-loglevel", "error", ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg (${what}) failed: ${r.out.slice(-600)}`);
};

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

// ---------------------------------------------------------------- testnet wallets
const PAYER_ENV = join(ROOT, ".secrets/demo/testnet-payer.env");
const BOB_WALLET = join(ROOT, ".secrets/demo/video-bob-wallet.json");

function payerEnv(): Record<string, string> {
  if (!existsSync(PAYER_ENV))
    throw new Error(
      `${PAYER_ENV} missing: it needs FUNDER_EVM_PK (Sepolia ETH) and FUNDER_SOL_KEY (devnet SOL)`,
    );
  const env: Record<string, string> = {};
  for (const l of readFileSync(PAYER_ENV, "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.+)$/);
    if (m?.[1] && m[2]) env[m[1]] = m[2].trim();
  }
  return env;
}

/** "Bob's everyday wallet": where he withdraws to. Keys kept so the test funds stay recoverable. */
async function bobWallet(): Promise<{ evm: string; sol: string }> {
  if (!existsSync(BOB_WALLET)) {
    const { out, code } = await sh(
      [
        "bun",
        "--cwd",
        join(ROOT, "packages/sdk"),
        "-e",
        `import { privateKeyToAccount } from "viem/accounts";
         import { Keypair } from "@solana/web3.js";
         import { base58 } from "@scure/base";
         const b = new Uint8Array(32); crypto.getRandomValues(b);
         const pk = "0x" + Buffer.from(b).toString("hex"); const kp = Keypair.generate();
         console.log(JSON.stringify({ evm_pk: pk, evm: privateKeyToAccount(pk).address,
           sol_sk: base58.encode(kp.secretKey), sol: kp.publicKey.toBase58() }));`,
      ],
      {},
    );
    if (code !== 0) throw new Error(`could not make Bob's wallet: ${out}`);
    writeFileSync(BOB_WALLET, out.trim(), { mode: 0o600 });
  }
  return JSON.parse(readFileSync(BOB_WALLET, "utf8")) as { evm: string; sol: string };
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  let last = "";
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: unknown };
      if (j.result !== undefined) return j.result;
      last = `HTTP ${r.status} ${JSON.stringify(j.error ?? j)}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw new Error(`${method} on ${url} failed: ${last}`);
}

async function checkFunds(): Promise<void> {
  const env = payerEnv();
  const { out, code } = await sh(
    [
      "bun",
      "--cwd",
      join(ROOT, "packages/sdk"),
      "-e",
      `import { privateKeyToAccount } from "viem/accounts";
     import { Keypair } from "@solana/web3.js";
     import { base58 } from "@scure/base";
     console.log(privateKeyToAccount(process.env.FUNDER_EVM_PK).address,
       Keypair.fromSecretKey(base58.decode(process.env.FUNDER_SOL_KEY)).publicKey.toBase58());`,
    ],
    env,
  );
  if (code !== 0) throw new Error(`could not read the testnet payer addresses: ${out.slice(-400)}`);
  const [evm, sol] = out.trim().split(" ");
  let eth = 0;
  for (const u of [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.gateway.tenderly.co",
    "https://1rpc.io/sepolia",
  ]) {
    try {
      eth = Number(BigInt(String(await rpc(u, "eth_getBalance", [evm, "latest"])))) / 1e18;
      break;
    } catch {
      /* next RPC */
    }
  }
  const lam = (await rpc("https://api.devnet.solana.com", "getBalance", [sol])) as {
    value: number;
  };
  const sols = lam.value / 1e9;
  log(`testnet payer: ${eth} Sepolia ETH (${evm}), ${sols} devnet SOL (${sol})`);
  if (eth < 0.012 || sols < 0.05)
    throw new Error(
      `the testnet payer needs ≥ 0.012 Sepolia ETH at ${evm} and ≥ 0.05 devnet SOL at ${sol}`,
    );
}

// ---------------------------------------------------------------- the stage (cards, captions)
const font = (pkg: string, file: string) => `file://${join(WEB_MODULES, pkg, "files", file)}`;
const FONTS = `
@font-face{font-family:Bricolage;src:url("${font("@fontsource-variable/bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2")}") format("woff2");font-weight:200 800}
@font-face{font-family:Figtree;src:url("${font("@fontsource-variable/figtree", "figtree-latin-wght-normal.woff2")}") format("woff2");font-weight:300 900}
@font-face{font-family:JBMono;src:url("${font("@fontsource/jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2")}") format("woff2");font-weight:400}`;

/** The caption bar used everywhere: who's screen it is, the caption, an optional note on the right. */
const CAPBAR_CSS = `
.capbar{position:absolute;left:0;right:0;bottom:0;height:${CAP_H}px;background:#142320;padding:0 40px;display:flex;align-items:center;gap:18px;
  font:600 21px/1.35 Figtree,"Figtree Variable",-apple-system,sans-serif;color:#f3f7f5;z-index:99999}
.capbar .role{flex:none;font:700 13px/1 Figtree,"Figtree Variable",sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#0a3a2e;background:#8fe3bd;border-radius:999px;padding:7px 12px}
.capbar .note{flex:none;margin-left:auto;font:600 14px/1 JBMono,monospace;color:#8fe3bd;border:1px solid #2f4a42;border-radius:8px;padding:7px 10px}`;

async function icon(name: string, size = 26): Promise<string> {
  const React = (await import(join(WEB_MODULES, "react"))) as typeof import("react");
  const { renderToStaticMarkup } = (await import(join(WEB_MODULES, "react-dom/server"))) as {
    renderToStaticMarkup(e: unknown): string;
  };
  const lucide = (await import(join(WEB_MODULES, "lucide-react"))) as Record<string, unknown>;
  const C = lucide[name];
  if (!C) throw new Error(`no lucide icon ${name}`);
  return renderToStaticMarkup(React.createElement(C as never, { size, strokeWidth: 2 } as never));
}

function stageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
  *{box-sizing:border-box} html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#edf0f2;color:#142320;font-family:Figtree,sans-serif}
  .mono{font-family:JBMono,monospace}
  #stage{position:absolute;inset:0}
  [data-a]{opacity:0}
  .kicker{font:700 15px/1 Figtree,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#0e5e4a}
  h1,h2{font-family:Bricolage,sans-serif;letter-spacing:-.03em;margin:0}
  .mark{width:64px;height:64px;border-radius:50%;background:#b9f0d6;color:#0a4a3a;display:grid;place-items:center}

  /* problem */
  .hook{display:grid;grid-template-columns:1fr 560px;gap:56px;align-items:center;padding:0 80px;height:100%}
  .hook h1{font-size:60px;line-height:1.02;margin:18px 0 22px}
  .hook p{font-size:25px;line-height:1.4;color:#2c3b37;margin:0}
  .ledger{background:#fff;border:1px solid #d7dfdc;border-radius:22px;box-shadow:0 30px 60px -30px rgba(20,35,32,.35);padding:22px 24px}
  .ledger .lh{display:flex;justify-content:space-between;align-items:center;font-size:16px;color:#5d6c68}
  .pub{font:700 12px Figtree;letter-spacing:.08em;text-transform:uppercase;color:#a3360f;background:#fde6dc;border-radius:999px;padding:5px 10px}
  .ledger .bal{font:600 38px Bricolage;margin:10px 0 14px}
  .ledger .bal small{display:block;font:500 14px Figtree;color:#5d6c68}
  .row{display:grid;grid-template-columns:110px 1fr auto;gap:12px;align-items:center;border-top:1px solid #edf0f2;padding:13px 0;font-size:16px}
  .row .in{font-weight:700;color:#0e5e4a}
  .row .from{color:#5d6c68;font-size:14px;white-space:nowrap}
  .row .tag{font-weight:700;font-size:14px;color:#7a2a0c;background:#ffe9c7;border-radius:8px;padding:5px 9px}
  .title{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:0 120px;height:100%}
  .title h1{font-size:96px;line-height:1;margin:28px 0 20px}
  .title p{font-size:32px;line-height:1.35;color:#2c3b37;margin:0;max-width:28em}

  /* behind the scenes */
  .bts{padding:0 70px 20px;height:100%;display:flex;flex-direction:column;justify-content:center}
  .bts h2{font-size:42px;margin:10px 0 26px}
  .near{border:2px solid #142320;border-radius:20px;background:#fff;padding:16px 20px;display:flex;align-items:center;gap:16px;transition:none}
  .near .lbl{font:700 22px Bricolage;margin-right:8px}
  .chip{border:1.5px solid #d7dfdc;border-radius:999px;padding:9px 16px;font-weight:700;font-size:17px;color:#5d6c68;background:#f6f8f7;display:flex;gap:8px;align-items:center}
  .flow{display:grid;grid-template-columns:200px 1fr 260px 1fr 200px;align-items:center;margin:30px 0 26px}
  .node{border:2px solid #d7dfdc;border-radius:20px;background:#fff;padding:18px;text-align:center;font-weight:700;font-size:19px;color:#5d6c68}
  .node .av{width:46px;height:46px;border-radius:50%;margin:0 auto 10px;display:grid;place-items:center;font:700 20px Bricolage;background:#e3e8e6;color:#5d6c68}
  .node small{display:block;font-weight:500;font-size:14px;margin-top:5px}
  .node.ghost{border-style:dashed}
  .arrow{height:3px;background:#d7dfdc;margin:0 10px;position:relative}
  .arrow:after{content:"";position:absolute;right:-2px;top:-7px;border:8.5px solid transparent;border-left:12px solid #d7dfdc;border-right:0}
  .on{opacity:1!important}
  .lit.node,.lit.chip{border-color:#0e5e4a;color:#142320;background:#e9faf2}
  .lit.node .av{background:#0e5e4a;color:#fff}
  .lit.arrow{background:#0e5e4a} .lit.arrow:after{border-left-color:#0e5e4a}
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
  .step{border-radius:16px;padding:16px 18px;background:#e3e8e6;color:#7d8b87;font-size:18px;line-height:1.38}
  .step b{display:block;font:700 15px Figtree;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
  .step.lit{background:#142320;color:#f3f7f5} .step.lit b{color:#8fe3bd}

  /* use cases */
  .cases{padding:0 70px 20px;height:100%;display:flex;flex-direction:column;justify-content:center}
  .cases h2{font-size:46px;margin:10px 0 26px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .case{background:#fff;border:1px solid #d7dfdc;border-radius:18px;padding:18px 20px;display:grid;grid-template-columns:48px 1fr;gap:4px 14px;align-items:start}
  .case .ic{grid-row:span 2;width:48px;height:48px;border-radius:14px;background:#b9f0d6;color:#0a4a3a;display:grid;place-items:center}
  .case b{font:700 21px Bricolage;letter-spacing:-.01em}
  .case span{font-size:17px;line-height:1.35;color:#3b4a46}
  .biz{margin-top:20px;background:#142320;color:#f3f7f5;border-radius:18px;padding:18px 24px;font-size:19px;line-height:1.4;display:flex;gap:14px;align-items:center}
  .biz b{color:#8fe3bd;flex:none}

  /* limits, end */
  .limits{display:flex;flex-direction:column;justify-content:center;padding:0 110px;height:100%}
  .limits h2{font-size:52px;margin:0 0 26px}
  .limits ul{list-style:none;padding:0;margin:0;display:grid;gap:16px;font-size:26px;line-height:1.38;color:#2c3b37}
  .limits li{display:grid;grid-template-columns:22px 1fr;gap:14px}
  .limits li:before{content:"";width:11px;height:11px;border-radius:50%;background:#d08a1c;margin-top:13px}
  .end small{font-size:20px;color:#5d6c68;margin-top:30px}
  ${CAPBAR_CSS}
  </style></head><body><div id="stage"></div><div id="cap"></div>
  <script>
  const stage=document.getElementById('stage'), cap=document.getElementById('cap');
  window.show=h=>{stage.innerHTML=h;cap.innerHTML='';};
  // reveal(k,p): elements tagged data-a=k fade/slide in; p from 0 to 1
  window.reveal=(k,p)=>{for(const e of document.querySelectorAll('[data-a="'+k+'"]')){e.style.opacity=p;e.style.transform='translateY('+((1-p)*14)+'px)';}};
  // lit(ids): exactly these ids are highlighted
  window.lit=ids=>{for(const e of document.querySelectorAll('.lit'))e.classList.remove('lit');for(const i of ids){const e=document.getElementById(i);if(e)e.classList.add('lit');}};
  window.capbar=(role,text,note)=>{stage.innerHTML='';cap.innerHTML='<div class="capbar">'+(role?'<span class="role"></span>':'')+'<span class="t"></span>'+(note?'<span class="note"></span>':'')+'</div>';
    if(role)cap.querySelector('.role').textContent=role;cap.querySelector('.t').textContent=text;if(note)cap.querySelector('.note').textContent=note;};
  </script></body></html>`;
}

interface Piece {
  /** an mp4 or webm */
  file: string;
  /** [start, end] seconds of the source to keep, in order */
  keep: [number, number][];
}
const pieceSeconds = (p: Piece) => p.keep.reduce((x, [a, b]) => x + (b - a), 0);

/**
 * Renders the stage as stills: `snap(seconds)` screenshots the page and holds that frame; ffmpeg joins
 * the stills with exact durations. Deterministic; no page timers or real-time recording (both stalled
 * mid-render on macOS). Every step has a deadline; on a miss the browser is relaunched and the page
 * rebuilt by replaying the calls so far (the page is a pure function of them).
 */
async function renderStills(
  name: string,
  fn: (
    call: (f: string, ...a: unknown[]) => Promise<void>,
    snap: (seconds: number) => Promise<void>,
    shot: (
      path: string,
      clip?: { x: number; y: number; width: number; height: number },
    ) => Promise<void>,
  ) => Promise<void>,
): Promise<Piece> {
  const pagePath = join(work, "stage.html");
  writeFileSync(pagePath, stageHtml());
  const dir = join(work, `stills-${name}`);
  mkdirSync(dir, { recursive: true });
  const frames: { file: string; seconds: number }[] = [];
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
    // no vsync: with a sleeping display macOS gives Chrome no display link and renders stalled
    const args = [
      ...NO_THROTTLE,
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      "--disable-gpu",
    ];
    browser = await chromium.launch({ executablePath: findChromium(), args });
    page = await browser.newPage({ viewport: { width: W, height: H } });
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
  const shot = (path: string, clip?: { x: number; y: number; width: number; height: number }) =>
    retry("screenshot", async () => {
      await page?.evaluate(() => document.fonts.ready);
      await page?.screenshot({ path, timeout: 12_000, clip });
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
  if (!last) return { file: "", keep: [] };
  // concat demuxer: each still with its duration; the last file is listed twice (ffmpeg quirk)
  const list = join(dir, "list.txt");
  writeFileSync(
    list,
    `${frames.map((f) => `file '${f.file}'\nduration ${f.seconds.toFixed(3)}`).join("\n")}\nfile '${last.file}'\n`,
  );
  const out = join(work, `${name}.mp4`);
  await ff(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-vf",
      "fps=30,format=yuv420p",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      out,
    ],
    `stills ${name}`,
  );
  return { file: out, keep: [[0, seconds]] };
}

/** Fade elements tagged data-a=k in over `t` seconds (15 fps steps). */
const fadeIn = async (
  call: (f: string, ...a: unknown[]) => Promise<void>,
  snap: (s: number) => Promise<void>,
  k: string,
  t = 0.4,
) => {
  const n = Math.max(2, Math.round(t * 15));
  for (let i = 1; i <= n; i++) {
    await call("window.reveal", k, i / n);
    await snap(1 / 15);
  }
};

const GHOST_SVG = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>`;

const TITLE_HTML = `<div class="title"><div class="mark">${GHOST_SVG}</div><h1>Ghost Paths</h1>
  <p>Get paid privately, on any chain, with one NEAR account.</p></div>`;

const ledgerRow = (amt: string, from: string, when: string, tag: string, k: number) =>
  `<div class="row"><span class="in">${amt}</span><span><span class="from mono">from ${from} · ${when}</span></span><span class="tag" data-a="t${k}">${tag}</span></div>`;

const HOOK_HTML = `<div class="hook"><div>
  <div class="kicker">On today's blockchains</div>
  <h1>Your wallet is a public bank statement.</h1>
  <p data-a="p">Anyone who knows your address can see who pays you, how much, and when.</p></div>
  <div class="ledger"><div class="lh"><span class="mono">0x3f9a…c21e</span><span class="pub">Public to everyone</span></div>
  <div class="bal"><small>Balance</small>14.20 ETH</div>
  ${ledgerRow("+2.40 ETH", "0x8b1d…4e02", "3d ago", "Salary · Acme Studio", 1)}
  ${ledgerRow("+0.85 ETH", "0x51c0…9a7f", "1w ago", "Client · Northwind", 2)}
  ${ledgerRow("+0.20 ETH", "0xe4a2…03bc", "2w ago", "Side project", 3)}
  ${ledgerRow("+2.40 ETH", "0x8b1d…4e02", "1mo ago", "Salary · Acme Studio", 4)}
  </div></div>`;

const STEPS = [
  {
    head: "1 · Set up once",
    text: "Bob publishes a privacy key on NEAR, linked to his account name.",
    lit: ["near", "c-key", "s1"],
  },
  {
    head: "2 · Every payment",
    text: "Alice's app turns that key into a brand-new address and leaves a sealed note only Bob can open.",
    lit: ["alice", "a1", "ghost", "c-note", "s2"],
  },
  {
    head: "3 · Withdraw",
    text: "NEAR's signing network signs for that address at Bob's request. No extra wallets or seed phrases.",
    lit: ["ghost", "a2", "bobw", "c-sign", "near", "s3"],
  },
];

async function btsHtml(): Promise<string> {
  const chip = async (id: string, ic: string, t: string) =>
    `<span class="chip" id="${id}">${await icon(ic, 18)}${t}</span>`;
  return `<div class="bts"><div class="kicker">Behind the scenes</div>
  <h2>How Bob got paid without anyone else knowing</h2>
  <div class="near" id="near"><span class="lbl">NEAR</span>
    ${await chip("c-key", "KeyRound", "Bob's privacy key")}
    ${await chip("c-note", "Mail", "Sealed note")}
    ${await chip("c-sign", "PenLine", "Signing network")}
    <span style="margin-left:auto;font-size:15px;color:#5d6c68">one account, any chain</span></div>
  <div class="flow">
    <div class="node" id="alice"><div class="av">A</div>Alice<small>pays from any wallet</small></div>
    <div class="arrow" id="a1"></div>
    <div class="node ghost" id="ghost"><div class="av">${GHOST_SVG.replace(/34/g, "24")}</div>New address<small>used once, on Ethereum or Solana</small></div>
    <div class="arrow" id="a2"></div>
    <div class="node" id="bobw"><div class="av">B</div>Bob's wallet<small>wherever he wants it</small></div>
  </div>
  <div class="steps">${STEPS.map((s, i) => `<div class="step" id="s${i + 1}"><b>${s.head}</b>${s.text}</div>`).join("")}</div></div>`;
}

const CASES: [string, string, string][] = [
  ["Briefcase", "Payroll", "Pay a team without publishing everyone's salary."],
  ["PenTool", "Freelancers & agencies", "Get paid without exposing your other clients."],
  ["Store", "Merchants", "Take crypto without showing competitors your revenue."],
  ["Heart", "Creators & donations", "Accept tips without revealing your whole income."],
  ["Users", "DAOs & grants", "Pay contributors privately, with an accountant view for audits."],
  ["Bot", "AI agents", "Let agents pay each other without leaking their strategy."],
];

async function casesHtml(): Promise<string> {
  const cards = await Promise.all(
    CASES.map(
      async ([ic, t, d], i) =>
        `<div class="case" data-a="c${i}"><span class="ic">${await icon(ic, 24)}</span><b>${t}</b><span>${d}</span></div>`,
    ),
  );
  return `<div class="cases"><div class="kicker">What you can build with it</div>
  <h2>Private payments for real businesses</h2>
  <div class="grid">${cards.join("")}</div>
  <div class="biz" data-a="biz"><b>The business</b>A "Receive privately" button for any wallet, a small fee on private withdrawals, and accountant access for teams that need it.</div></div>`;
}

const LIMITS_HTML = `<div class="limits"><div class="kicker" style="margin-bottom:14px">Honest limits</div><h2>What Ghost Paths doesn't hide</h2><ul>
  <li>Amounts and timing stay public. It hides who got paid, not how much.</li>
  <li>Withdrawing several payments to one address links them together.</li>
  <li>Testnet only and not audited. Bitcoin and confidential cross-chain withdrawals aren't shown here.</li></ul></div>`;

const END_HTML = `<div class="title end"><div class="mark">${GHOST_SVG}</div><h1>Ghost Paths</h1>
  <p>Get paid privately, on any chain, with one NEAR account.</p>
  <small>Live on NEAR testnet with Chain Signatures · Ethereum Sepolia · Solana devnet</small></div>`;

const HOOK_SECONDS = { problem: 5.2, title: 2.6 };
const BTS_SECONDS = [4.6, 5.6, 6.0];
const CASES_SECONDS = 10;
const LIMITS_SECONDS = 5.5;
const END_SECONDS = 4.5;

async function renderCards(): Promise<{ hook: Piece; bts: Piece; cases: Piece; outro: Piece }> {
  const hook = await renderStills("hook", async (call, snap, shot) => {
    await call("window.show", HOOK_HTML);
    await snap(0.6);
    await fadeIn(call, snap, "p", 0.4);
    await snap(0.5);
    for (let k = 1; k <= 4; k++) {
      await fadeIn(call, snap, `t${k}`, 0.27);
      await snap(0.15);
    }
    await snap(HOOK_SECONDS.problem - 0.6 - 0.4 - 0.5 - 4 * 0.42);
    await call("window.show", TITLE_HTML);
    await shot(join(outDir, "poster.png"));
    await snap(HOOK_SECONDS.title);
  });
  const bts = await renderStills("bts", async (call, snap) => {
    await call("window.show", await btsHtml());
    await call("window.lit", []);
    await snap(0.5);
    for (const [i, s] of STEPS.entries()) {
      await call("window.lit", s.lit);
      await snap((BTS_SECONDS[i] ?? 5) - (i === 0 ? 0.5 : 0));
    }
  });
  const cases = await renderStills("cases", async (call, snap) => {
    await call("window.show", await casesHtml());
    await snap(0.4);
    for (let i = 0; i < CASES.length; i++) await fadeIn(call, snap, `c${i}`, 0.27);
    await snap(0.4);
    await fadeIn(call, snap, "biz", 0.4);
    await snap(CASES_SECONDS - 0.4 - CASES.length * 0.27 - 0.4 - 0.4);
  });
  const outro = await renderStills("outro", async (call, snap) => {
    await call("window.show", LIMITS_HTML);
    await snap(LIMITS_SECONDS);
    await call("window.show", END_HTML);
    await snap(END_SECONDS);
  });
  return { hook, bts, cases, outro };
}

/** Caption bars (1280x92 PNGs) for the clips that have no caption of their own. */
async function renderCaptions(caps: { name: string; role: string; text: string; note?: string }[]) {
  const files: Record<string, string> = {};
  await renderStills("captions", async (call, _snap, shot) => {
    for (const c of caps) {
      await call("window.capbar", c.role, c.text, c.note ?? null);
      const f = join(work, `cap-${c.name}.png`);
      await shot(f, { x: 0, y: CLIP_H, width: W, height: CAP_H });
      files[c.name] = f;
    }
  });
  return files;
}

// ---------------------------------------------------------------- the real Terminal take (macOS)
const osa = async (script: string) => {
  const r = await sh(["osascript", "-e", script]);
  if (r.code !== 0) throw new Error(`osascript failed: ${r.out}`);
  return r.out.trim();
};

interface TermLine {
  t: number;
  text: string;
}

/**
 * Opens a Terminal.app window, runs the given shell script in it and records just that window
 * (screencapture -l, by window id: works with the window in the background and never films the
 * rest of the screen, so the Mac stays usable). Returns the video, the output and when each output
 * line appeared (video seconds).
 */
async function terminalTake(
  runScript: string,
  name: string,
  maxSeconds: number,
): Promise<{ video: string; lines: TermLine[]; text: string }> {
  const logFile = join(work, `${name}.log`);
  const doneFile = join(work, `${name}.done`);
  const video = join(work, `${name}.mp4`);
  rmSync(logFile, { force: true });
  for (const f of [doneFile, `${doneFile}.release`, `${doneFile}.go`]) rmSync(f, { force: true });
  const sh1 = join(work, `${name}.sh`);
  // script(1) keeps a real tty (colours) and also writes the output to the log
  writeFileSync(
    sh1,
    `#!/bin/zsh
cd ${JSON.stringify(ROOT)}
${runScript.split("\n")[0]}
while [ ! -f ${JSON.stringify(`${doneFile}.go`)} ]; do sleep 0.1; done
clear
sleep 1.2
p='\\033[1;32m➜\\033[0m \\033[1;36mghost-paths\\033[0m '
printf "$p"
cmd=${JSON.stringify(runScript.split("\n").slice(1).join("\n"))}
for ((i=1;i<=\${#cmd};i++)); do printf '%s' "\${cmd[i]}"; sleep 0.045; done
sleep 0.5; printf '\\n'
# HUP ignored so anything the command leaves running (KEEP=1's relayer) survives the pty closing.
script -q ${JSON.stringify(logFile)} zsh -c "trap '' HUP; $cmd"
echo $? > ${JSON.stringify(doneFile)}
while [ ! -f ${JSON.stringify(`${doneFile}.release`)} ]; do sleep 0.2; done
`,
    { mode: 0o700 },
  );
  // window: 1180x579 points (16:7.85, the clip area's ratio) inside the main display
  const [x, y, w, h] = [140, 210, 1180, 579];
  const basic = await osa(
    'tell application "Terminal" to get {font name, font size} of settings set "Basic"',
  );
  const [fontName, fontSize] = basic.split(", ");
  // the new window is found through its tab: "front window" can still be another Terminal window
  const wid = await osa(
    `tell application "Terminal"
      set font name of settings set "Basic" to "SFMono-Regular"
      set font size of settings set "Basic" to 14
      set t to do script "exec zsh ${sh1}"
      delay 0.5
      set current settings of t to settings set "Basic"
      set custom title of t to "ghost-paths"
      set wid to id of (first window whose selected tab is t)
      set bounds of window id wid to {${x}, ${y}, ${x + w}, ${y + h}}
      return wid
    end tell`,
  );
  await Bun.sleep(600);
  const actual = await osa(`tell application "Terminal" to get bounds of window id ${wid}`);
  if (actual.replace(/\s/g, "") !== `${x},${y},${x + w},${y + h}`)
    log(`Terminal window bounds are ${actual}, wanted ${x}, ${y}, ${x + w}, ${y + h}`);
  // window-only frames, ~7 per second, each stamped with its time since t0
  const framesDir = join(work, `${name}-frames`);
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const frames: { file: string; t: number }[] = [];
  let capturing = true;
  let captureErr = "";
  const t0 = Date.now();
  const capture = (async () => {
    for (let n = 0; capturing; n++) {
      const started = Date.now();
      const file = join(framesDir, `f${String(n).padStart(5, "0")}.png`);
      const r = await sh(["screencapture", `-l${wid}`, "-o", "-x", "-t", "png", file]);
      if (r.code === 0 && existsSync(file)) frames.push({ file, t: (started - t0) / 1000 });
      else captureErr = r.out;
      await Bun.sleep(Math.max(0, 140 - (Date.now() - started)));
    }
  })();
  await Bun.sleep(700);
  writeFileSync(`${doneFile}.go`, "");
  const lines: TermLine[] = [];
  let seen = 0;
  // drop terminal escape sequences (colours, titles) and control characters
  const strip = (s: string) => {
    let o = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 27) {
        const n = s[i + 1];
        if (n === "[") {
          i += 2;
          while (i < s.length && !/[A-Za-z]/.test(s[i] ?? "")) i++;
        } else if (n === "]") {
          i += 2;
          while (i < s.length && s.charCodeAt(i) !== 7) i++;
        } else i++;
        continue;
      }
      if (c < 32 && c !== 9) continue;
      o += s[i];
    }
    return o;
  };
  try {
    while (!existsSync(doneFile)) {
      if ((Date.now() - t0) / 1000 > maxSeconds)
        throw new Error(`${name} ran over ${maxSeconds} s`);
      if ((Date.now() - t0) / 1000 > 5 && frames.length === 0)
        throw new Error(`cannot capture the Terminal window: ${captureErr}`);
      if (existsSync(logFile)) {
        const all = readFileSync(logFile, "utf8").split("\n");
        for (; seen < all.length - 1; seen++)
          lines.push({ t: (Date.now() - t0) / 1000, text: strip(all[seen] ?? "") });
      }
      await Bun.sleep(100);
    }
    await Bun.sleep(2500); // hold the last screen
    const all = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : [];
    for (; seen < all.length; seen++)
      lines.push({ t: (Date.now() - t0) / 1000, text: strip(all[seen] ?? "") });
  } finally {
    capturing = false;
    await capture;
    writeFileSync(`${doneFile}.release`, "");
    await Bun.sleep(800);
    await osa(
      `tell application "Terminal"
        set font name of settings set "Basic" to "${fontName}"
        set font size of settings set "Basic" to ${fontSize}
        try
          close window id ${wid} saving no
        end try
      end tell`,
    ).catch((e) => log(`could not tidy Terminal: ${(e as Error).message}`));
  }
  const code = Number(existsSync(doneFile) ? readFileSync(doneFile, "utf8").trim() : 1);
  const text = lines.map((l) => l.text).join("\n");
  if (code !== 0) throw new Error(`${name} exited ${code}:\n${text.slice(-1200)}`);
  // frames → video on the same clock as `lines` (the first frame also covers 0..its time)
  if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frames captured`);
  const list = frames
    .map((f, i) => {
      const end = frames[i + 1]?.t ?? f.t + 0.5;
      const start = i === 0 ? 0 : f.t;
      return `file '${f.file}'\nduration ${(end - start).toFixed(3)}`;
    })
    .join("\n");
  const listFile = join(framesDir, "list.txt");
  writeFileSync(listFile, `${list}\nfile '${frames[frames.length - 1]?.file}'\n`);
  await ff(
    [
      ...["-f", "concat", "-safe", "0", "-i", listFile],
      ...["-vf", `scale=${W}:${CLIP_H}:flags=lanczos,fps=30,format=yuv420p`],
      ...["-c:v", "libx264", "-preset", "medium", "-crf", "18", video],
    ],
    `${name} frames`,
  );
  rmSync(framesDir, { recursive: true, force: true });
  const result = { video, lines, text };
  writeFileSync(join(work, `${name}-result.json`), JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------- the real web app (Playwright)
const UI_PORT = 18788;
const TOKEN = crypto.randomUUID().replaceAll("-", "");
let serve: ChildProcess | undefined;

async function startServe(home: string): Promise<string> {
  // The testnet demo's alice pays from the funded testnet wallet (FUNDER_* env) and has no profile
  // file, so the web app would offer only bob and carol as payers. An empty wallet profile lists her
  // (on test networks the env wallet still pays; no key is stored).
  const alice = join(home, "alice.wallet.json");
  if (!existsSync(alice)) writeFileSync(alice, "{}\n", { mode: 0o600 });
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...payerEnv(),
    GHOST_SERVE_TOKEN: TOKEN,
    GHOST_HOME: home,
    GHOST_RELAYER_URL: "http://127.0.0.1:8787",
    GHOST_NETWORK: "testnet",
    GHOST_CHAINS: process.env.VIDEO_CHAINS ?? "evm:11155111,sol:devnet",
  };
  serve = spawn("bun", ["packages/cli/src/ghost.ts", "serve", "--port", String(UI_PORT)], {
    cwd: ROOT,
    env,
    stdio: "ignore",
  });
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

// Injected into the app: the caption bar (whose screen + caption) and a click ripple.
const UI_INIT = `
window.addEventListener('DOMContentLoaded',()=>{
  const s=document.createElement('style');
  s.textContent=${JSON.stringify(`body{padding-bottom:110px!important}${CAPBAR_CSS}.gprip{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border:3px solid #0e5e4a;border-radius:50%;z-index:99998;pointer-events:none;animation:gprip .6s ease-out forwards}@keyframes gprip{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}.capbar{position:fixed}`)};
  document.head.appendChild(s);
  const c=document.createElement('div');c.className='capbar';c.innerHTML='<span class="role"></span><span class="t"></span>';document.body.appendChild(c);
  window.__cap=(t,r)=>{c.querySelector('.t').textContent=t;const e=c.querySelector('.role');e.textContent=r||'';e.style.display=r?'':'none';};
});
window.addEventListener('mousedown',e=>{const r=document.createElement('div');r.className='gprip';r.style.left=e.clientX+'px';r.style.top=e.clientY+'px';document.body.appendChild(r);setTimeout(()=>r.remove(),700)},true);
`;

interface UiTake extends Piece {
  urls: { pay?: string; announce?: string; sweepNear?: string; sweepChain?: string };
  oneTime?: string;
  bob?: string;
}

/** Alice pays Bob, Bob withdraws, what others see, the accountant. Long waits are cut out later. */
async function recordUi(base: string, bobEvm: string): Promise<UiTake> {
  const browser = await chromium.launch({ executablePath: findChromium(), args: NO_THROTTLE });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: join(work, "webm-ui"), size: { width: W, height: H } },
  });
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const page = await ctx.newPage();
  await page.addInitScript(UI_INIT);
  const urls: UiTake["urls"] = {};
  page.on("response", async (r) => {
    const u = r.url();
    if (!/\/api\/(pay|sweep)/.test(u)) return;
    const body = await r.text().catch(() => "");
    writeFileSync(join(work, `api-${u.includes("/api/pay") ? "pay" : "sweep"}.txt`), body);
    const find = (re: RegExp) => body.match(re)?.[0];
    if (u.includes("/api/pay")) {
      urls.pay = find(/https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-f]+/i) ?? urls.pay;
      urls.announce = find(/https:\/\/testnet\.nearblocks\.io\/txns\/\w+/) ?? urls.announce;
    } else {
      urls.sweepChain =
        find(/https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-f]+/i) ?? urls.sweepChain;
      urls.sweepNear = find(/https:\/\/testnet\.nearblocks\.io\/txns\/\w+/) ?? urls.sweepNear;
    }
  });
  const cap = (t: string, role: string) =>
    page.evaluate(
      ([x, r]) => (window as never as { __cap(t: string, r: string): void }).__cap(x, r),
      [t, role],
    );
  const tid = (id: string) => page.getByTestId(id);
  const center = (l: import("playwright").Locator) =>
    l.evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "center" }));
  const top = () => page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  const typeIn = async (id: string, text: string) => {
    await tid(id).fill("");
    await tid(id).pressSequentially(text, { delay: 60 });
  };
  const still = async (name: string) => {
    // README screenshots from the same run, without the caption bar
    await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>(".capbar");
      if (c) c.style.display = "none";
    });
    await page.screenshot({ path: join(ROOT, "docs", "img", name) });
    await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>(".capbar");
      if (c) c.style.display = "flex";
    });
  };
  // the edit keeps [start, end] spans; cut() ends a span (a wait follows), resume() starts the next
  const keep: [number, number][] = [];
  let spanStart = 0;
  const cut = () => keep.push([spanStart, now()]);
  const resume = () => {
    spanStart = now();
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/?token=${TOKEN}`);
    await tid("status").getByText(/NEAR/).waitFor();
    await tid("registered").getByText("Ready").waitFor({ timeout: 60_000 });
    // Alice's screen must show Alice paying (before the take starts, so it is not in the cut)
    const payerSel = tid("payer");
    if (await payerSel.count()) {
      await payerSel.selectOption("alice");
      if ((await payerSel.inputValue()) !== "alice")
        throw new Error("could not pick alice as the payer");
    }
    await page.waitForTimeout(400);
    resume();
    const ALICE = "Alice's screen";
    const BOB = "Bob's screen";
    await cap("Alice runs a design studio. Bob, a freelancer, just sent her invoice #44.", ALICE);
    await page.waitForTimeout(3200);
    await cap("She pays him with just his NEAR account name. No wallet address to ask for.", ALICE);
    await typeIn("amount", "0.005");
    await page.waitForTimeout(300);
    await typeIn("memo", "Invoice #44");
    await page.waitForTimeout(900);
    await tid("send").click();
    await cap(
      "Behind the scenes, Ghost Paths makes a brand-new address just for this payment.",
      ALICE,
    );
    await page.waitForTimeout(2600);
    cut();
    await page
      .locator('[data-testid="pay-result"], .note.bad')
      .first()
      .waitFor({ timeout: 180_000 });
    if (await page.locator(".note.bad").first().isVisible())
      throw new Error(`payment failed: ${await page.locator(".note.bad").first().textContent()}`);
    await page.waitForTimeout(150);
    resume();
    await cap(
      "Paid. The money sits at an address used once. Nothing public links it to Bob.",
      ALICE,
    );
    await page.waitForTimeout(1500);
    await still("ui-send.png");
    await center(tid("onetime-address"));
    await page.waitForTimeout(2600);
    const oneTime = ((await tid("onetime-address").first().textContent()) ?? "").trim();

    await top();
    await page.waitForTimeout(400);
    await tid("tab-inbox").click();
    await cap(
      "Bob opens his inbox. Only his key can spot payments meant for him, note included.",
      BOB,
    );
    // this payment's row: its short one-time address (0x1234…abcd) is unique
    const row = tid("payment-row")
      .filter({ hasText: "Invoice #44" })
      .filter({ hasText: oneTime.slice(0, 6) });
    cut();
    await row.waitFor({ timeout: 120_000 });
    resume();
    await page.waitForTimeout(700);
    await center(row);
    await page.waitForTimeout(2300);
    await still("ui-inbox.png");
    await row.getByTestId("withdraw").click();
    await cap("He withdraws it to his everyday wallet.", BOB);
    await page.waitForTimeout(600);
    await center(row.getByTestId("dest"));
    // local chains pre-fill a throwaway address (async); let it land, then type Bob's wallet
    if (
      await row
        .getByTestId("fresh-dest")
        .isVisible()
        .catch(() => false)
    )
      await page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLInputElement>('[data-testid="dest"]')].some(
          (i) => i.value.length > 0,
        ),
      );
    // type over a selection: an empty box makes the app (local chains) fetch a new throwaway address
    await row.getByTestId("dest").selectText();
    await row.getByTestId("dest").pressSequentially(bobEvm, { delay: 14 });
    const typed = await row.getByTestId("dest").inputValue();
    if (typed !== bobEvm) throw new Error(`destination box holds ${typed}, not ${bobEvm}`);
    await page.waitForTimeout(500);
    await center(row.getByTestId("sweep"));
    await page.waitForTimeout(900);
    await row.getByTestId("sweep").click();
    await cap(
      "NEAR's signing network signs the transfer. Bob never had a key for this address.",
      BOB,
    );
    await page.waitForTimeout(3400);
    cut();
    await row
      .locator('[data-testid="sweep-result"], .note.bad')
      .first()
      .waitFor({ timeout: 240_000 });
    if (await row.locator(".note.bad").isVisible())
      throw new Error(`withdrawal failed: ${await row.locator(".note.bad").first().textContent()}`);
    await page.waitForTimeout(150);
    resume();
    await center(row.getByTestId("sweep-result"));
    await cap("Arrived in Bob's wallet.", BOB);
    await page.waitForTimeout(3000);

    await tid("tab-public").click();
    await cap(
      "Everyone else sees money going to an address nobody has seen before. Traced to Bob: 0.",
      "Everyone else",
    );
    await tid("public-log").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await center(tid("public-log"));
    await cap(
      "The public record has no recipient. Amounts stay visible; who got paid doesn't.",
      "Everyone else",
    );
    await page.waitForTimeout(3000);

    await tid("tab-accountant").click();
    await cap(
      "Bob can still give his accountant a read-only view: every payment, a CSV, no way to move money.",
      "Bob's accountant",
    );
    await page.waitForTimeout(1300);
    await tid("bundle-bob").click();
    await tid("auditor-result").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await tid("export-csv").hover();
    await page.waitForTimeout(2400);
    cut();
    if (errors.length) log(`browser errors: ${errors.join(" | ")}`);
    await ctx.close();
    const webm = readdirSync(join(work, "webm-ui")).find((f) => f.endsWith(".webm"));
    if (!webm) throw new Error("Playwright wrote no UI video");
    return { file: join(work, "webm-ui", webm), keep, urls, oneTime };
  } catch (e) {
    await page.screenshot({ path: join(work, "ui-failure.png") }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- the explorers (Brave)
interface ExplorerShot {
  name: string;
  url: string;
  /** exact texts to highlight; the first one found is scrolled into view */
  mark: string[];
  role: string;
  caption: string;
  seconds: number;
  /** a tab to open first (link text) */
  tab?: string;
}
interface ExplorerTake {
  file: string;
  clips: { name: string; keep: [number, number] }[];
}

async function recordExplorers(shots: ExplorerShot[]): Promise<ExplorerTake> {
  const browser = await chromium.launch({
    headless: false,
    executablePath: BRAVE,
    args: ["--disable-blink-features=AutomationControlled", "--window-size=1300,760"],
  });
  const ctx = await browser.newContext({
    viewport: { width: W, height: CLIP_H },
    recordVideo: { dir: join(work, "webm-explorer"), size: { width: W, height: CLIP_H } },
    colorScheme: "light",
  });
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const page = await ctx.newPage();
  const clips: ExplorerTake["clips"] = [];
  try {
    for (const s of shots) {
      // explorers index new transactions with a delay: reload until the page is a real tx page
      for (let i = 0; ; i++) {
        await page.goto(s.url, { timeout: 60_000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3500);
        const body = await page.evaluate(() => document.body.innerText);
        const missing =
          /unexpected error|could not find|not found|unable to locate|try again later/i.test(
            body.slice(0, 3000),
          );
        if (!missing) break;
        if (i >= 12) throw new Error(`${s.name}: the explorer never showed ${s.url}`);
        log(`explorer ${s.name}: not indexed yet, retrying`);
        await page.waitForTimeout(8000);
      }
      for (const b of ["Got it!", "Accept", "Got it"]) {
        const btn = page.getByText(b, { exact: true }).first();
        if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
      }
      if (s.tab) {
        await page.getByText(s.tab, { exact: true }).first().click();
        await page.waitForTimeout(3500);
      }
      // highlight the parts that matter, scroll the first into the middle
      const found = await page.evaluate((marks) => {
        const leaves = [...document.querySelectorAll<HTMLElement>("body *")].filter(
          (e) =>
            !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName) &&
            e.getClientRects().length > 0 &&
            (e.children.length === 0 || [...e.childNodes].every((n) => n.nodeType === 3)),
        );
        let first: HTMLElement | undefined;
        let n = 0;
        for (const m of marks) {
          for (const e of leaves) {
            const t = (e.textContent ?? "").trim().toLowerCase();
            const want = m.toLowerCase();
            if (!want || (t !== want && !(want.length > 20 && t.includes(want)))) continue;
            e.style.outline = "3px solid #0e5e4a";
            e.style.outlineOffset = "3px";
            e.style.background = "#b9f0d6";
            e.style.borderRadius = "6px";
            e.style.color = "#0a3a2e";
            first ??= e;
            n++;
          }
        }
        first?.scrollIntoView({ block: "center" });
        return n;
      }, s.mark);
      log(`explorer ${s.name}: ${found} highlighted`);
      await page.waitForTimeout(700);
      const a = now();
      await page.waitForTimeout(s.seconds * 1000);
      clips.push({ name: s.name, keep: [a, now()] });
    }
    await ctx.close();
    const webm = readdirSync(join(work, "webm-explorer")).find((f) => f.endsWith(".webm"));
    if (!webm) throw new Error("Playwright wrote no explorer video");
    return { file: join(work, "webm-explorer", webm), clips };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- editing
/** One source cut down to its keep spans, optionally sped up, as a 1280x720 30 fps mp4. */
async function cutPiece(p: Piece, out: string, speed = 1, capPng?: string): Promise<number> {
  const parts = p.keep
    .map(
      ([a, b], i) =>
        `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[p${i}]`,
    )
    .join(";");
  const cat = `${p.keep.map((_, i) => `[p${i}]`).join("")}concat=n=${p.keep.length}:v=1:a=0[c]`;
  const base = `[c]setpts=PTS/${speed.toFixed(4)},fps=30`;
  const graph = capPng
    ? `${parts};${cat};${base},scale=${W}:${CLIP_H},setsar=1[top];[top][1:v]vstack=inputs=2:shortest=1,format=yuv420p[out]`
    : `${parts};${cat};${base},scale=${W}:${H},setsar=1,format=yuv420p[out]`;
  await ff(
    [
      "-i",
      p.file,
      ...(capPng ? ["-loop", "1", "-i", capPng] : []),
      "-filter_complex",
      graph,
      "-map",
      "[out]",
      "-shortest",
      ...["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "30", out],
    ],
    `cut ${out}`,
  );
  return pieceSeconds(p) / speed;
}

/** One frame of a video held for `seconds`, with a caption bar under it. */
async function holdFrame(video: string, t: number, seconds: number, capPng: string, out: string) {
  const png = `${out}.png`;
  await ff(["-ss", t.toFixed(3), "-i", video, "-frames:v", "1", png], `frame ${out}`);
  await ff(
    [
      ...[
        "-loop",
        "1",
        "-t",
        seconds.toFixed(3),
        "-i",
        png,
        "-loop",
        "1",
        "-t",
        seconds.toFixed(3),
        "-i",
        capPng,
      ],
      "-filter_complex",
      `[0:v]scale=${W}:${CLIP_H},setsar=1[top];[top][1:v]vstack=inputs=2:shortest=1,fps=30,format=yuv420p[out]`,
      ...["-map", "[out]", "-c:v", "libx264", "-crf", "18", "-r", "30", out],
    ],
    `hold ${out}`,
  );
}

/** The terminal take, fast-forwarded to the sweeps, held there, then the final summary held. */
async function terminalClip(
  take: { video: string; lines: TermLine[] },
  capFF: string,
  capHold: string,
): Promise<string[]> {
  const at = (re: RegExp, last = false) => {
    const hits = take.lines.filter((l) => re.test(l.text));
    return (last ? hits[hits.length - 1] : hits[0])?.t;
  };
  const tSwept = at(/now shows as swept/, true);
  const tOk = at(/demo OK: \d+\/\d+ checks passed/);
  if (tSwept === undefined || tOk === undefined)
    throw new Error("terminal take: no sweep/summary lines");
  const ffEnd = tSwept + 0.6;
  const FF_SECONDS = 5.5;
  const speed = ffEnd / FF_SECONDS;
  const a = join(work, "proof-term-ff.mp4");
  const b = join(work, "proof-term-hold.mp4");
  const c = join(work, "proof-term-ok.mp4");
  await cutPiece({ file: take.video, keep: [[0, ffEnd]] }, a, speed, capFF);
  // hold the screen with the MPC signatures, then the summary (each as a frozen frame)
  await holdFrame(take.video, ffEnd, 2.6, capHold, b);
  await holdFrame(
    take.video,
    Math.min(tOk + 0.8, take.lines[take.lines.length - 1]?.t ?? tOk),
    1.6,
    capHold,
    c,
  );
  return [a, b, c];
}

async function joinAll(files: string[], out: string): Promise<void> {
  const inputs = files.flatMap((f) => ["-i", f]);
  const norm = files
    .map((_, i) => `[${i}:v]scale=${W}:${H},fps=30,setsar=1,format=yuv420p[v${i}]`)
    .join(";");
  const cat = `${files.map((_, i) => `[v${i}]`).join("")}concat=n=${files.length}:v=1:a=0[out]`;
  await ff(
    [
      ...inputs,
      "-filter_complex",
      `${norm};${cat}`,
      "-map",
      "[out]",
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p"],
      ...["-movflags", "+faststart", out],
    ],
    "final join",
  );
}

const duration = async (f: string) =>
  Number(
    (
      await sh([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        f,
      ])
    ).out.trim(),
  );

// ---------------------------------------------------------------- child processes
/** Browsers run in child processes: on macOS a second Playwright browser in one process hung. */
async function child<T>(part: string, env: Record<string, string>): Promise<T> {
  const out = join(work, `${part}-result.json`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    rmSync(out, { force: true });
    const { out: o, code } = await sh(["bun", "scripts/record-video.ts"], {
      VIDEO_PART: part,
      VIDEO_WORK: work,
      ...env,
    });
    if (code === 0 && existsSync(out)) return JSON.parse(readFileSync(out, "utf8")) as T;
    log(`${part} take ${attempt} failed: ${o.trim().split("\n").slice(-4).join(" | ")}`);
    rmSync(join(work, `webm-${part}`), { recursive: true, force: true });
  }
  throw new Error(`the ${part} take failed twice`);
}

// ---------------------------------------------------------------- main
const MAX_SECONDS = 119.5;

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("make video records Terminal.app: macOS only");
  if (!existsSync(BRAVE)) throw new Error(`Brave not found at ${BRAVE}`);
  // VIDEO_RESUME=1 VIDEO_WORK=<dir>: reuse the live takes already saved there (redo only the edit)
  const saved = <T>(file: string): T | undefined => {
    const f = join(work, file);
    if (process.env.VIDEO_RESUME !== "1" || !existsSync(f)) return undefined;
    log(`reusing ${file}`);
    return JSON.parse(readFileSync(f, "utf8")) as T;
  };
  const savedTerm = saved<{ video: string; lines: TermLine[]; text: string }>(
    "terminal-result.json",
  );
  if (!savedTerm) await checkFunds();
  const bob = await bobWallet();

  // 1. cards first (stills rendered after a live browser take stalled on macOS)
  const cards = await renderCards();
  const caps = await renderCaptions([
    {
      name: "term-ff",
      role: "Proof",
      text: "Not a mock-up: the same engine in a real Mac Terminal, live on NEAR, Ethereum and Solana test networks.",
      note: "fast-forward",
    },
    {
      name: "term-hold",
      role: "Proof",
      text: "Each withdrawal was signed by NEAR's signing network in seconds. Nothing on NEAR names Bob.",
    },
    {
      name: "pay",
      role: "Sepolia Etherscan",
      text: "Alice's payment on Ethereum: it went to a one-time address, not to Bob.",
    },
    {
      name: "sign",
      role: "NearBlocks",
      text: "Bob's withdrawal on NEAR: the Ghost Paths contract asks NEAR's signer to sign. Bob isn't named.",
    },
    {
      name: "sweep",
      role: "Sepolia Etherscan",
      text: "The signed transfer: from the one-time address to Bob's wallet.",
    },
    {
      name: "sol",
      role: "Solana Explorer",
      text: "The Terminal run paid on Solana devnet the same way.",
    },
  ]);

  // 2. the real Terminal: the full testnet run, kept for the web app
  if (!savedTerm)
    log(
      "Terminal.app: KEEP=1 make demo-testnet (about 2 minutes; window-only capture, the Mac stays usable)",
    );
  const term =
    savedTerm ??
    (await terminalTake(
      `set -a; source .secrets/demo/testnet-payer.env; set +a; export KEEP=1 DEMO_EVM_DEST=${bob.evm} DEMO_SOL_DEST=${bob.sol}
make demo-testnet`,
      "terminal",
      420,
    ));
  if (!/demo OK: 17\/17 checks passed/.test(term.text))
    throw new Error("the demo did not report 17/17");
  // Local runs print "profiles in <home> (GHOST_HOME)"; testnet runs only print the run dir
  // ("mode=testnet  run=<dir>"), whose profiles live in <dir>/home (demo.ts HOME).
  const runDir = term.text.match(/mode=\S+(?: \(recording\))?\s+run=(\S+)/)?.[1];
  const savedUi = saved<UiTake>("ui-result.json");
  const home =
    term.text.match(/profiles in (\S+) \(GHOST_HOME\)/)?.[1] ??
    (runDir && existsSync(join(runDir, "home")) ? join(runDir, "home") : undefined);
  if (!home && !savedUi) throw new Error("no kept GHOST_HOME in the demo output");
  // The web app announces through the relayer the demo kept running (KEEP=1).
  const relayerUp = await fetch("http://127.0.0.1:8787/health")
    .then((r) => r.status < 500)
    .catch(() => false);
  if (!relayerUp && !savedUi)
    throw new Error("the demo's relayer on :8787 is not running after the take");
  writeFileSync(
    join(outDir, "demo-capture.txt"),
    `# Output of KEEP=1 make demo-testnet in Terminal.app (NEAR testnet + Chain Signatures, Ethereum Sepolia, Solana devnet), ${new Date().toISOString()}.\n# The video shows this run fast-forwarded. No keys are printed by the demo.\n\n${term.text.replaceAll(ROOT, ".")}`,
  );

  // 3. the web app against the kept run
  let ui = savedUi;
  if (!ui) {
    log("building the web app (ghost serve serves apps/web/dist)");
    const built = await sh(["make", "web-build"]);
    if (built.code !== 0) throw new Error(`web build failed:\n${built.out.slice(-800)}`);
    ui = await child<UiTake>("ui", {
      VIDEO_PART_HOME: resolve(ROOT, home as string),
      VIDEO_BOB: bob.evm,
    });
  }
  log(`UI take: ${pieceSeconds(ui).toFixed(1)} s kept; ${JSON.stringify(ui.urls)}`);
  const { pay, sweepNear, sweepChain } = ui.urls;
  if (!pay || !sweepNear || !sweepChain) throw new Error("the UI take did not return the tx links");

  // 4. the explorers: that exact payment and withdrawal
  const solTx = term.text.match(/https:\/\/explorer\.solana\.com\/tx\/\w+\?cluster=devnet/)?.[0];
  const shots: ExplorerShot[] = [
    {
      name: "pay",
      url: pay,
      mark: [ui.oneTime ?? "", "0.005 ETH"],
      role: "",
      caption: "",
      seconds: 3.6,
    },
    {
      name: "sign",
      url: `${sweepNear}/execution`,
      mark: ["v1.signer-prod.testnet", "sign"],
      role: "",
      caption: "",
      seconds: 4.2,
    },
    {
      name: "sweep",
      url: sweepChain,
      mark: [bob.evm, ui.oneTime ?? ""],
      role: "",
      caption: "",
      seconds: 3.4,
    },
  ];
  if (solTx)
    shots.push({
      name: "sol",
      url: solTx,
      mark: ["Success", "SUCCESS"],
      role: "",
      caption: "",
      seconds: 2.6,
    });
  const ex =
    saved<ExplorerTake>("explorer-result.json") ??
    (await child<ExplorerTake>("explorer", { VIDEO_SHOTS: JSON.stringify(shots) }));

  // 5. edit
  const pieces: string[] = [];
  const hook = join(work, "e-hook.mp4");
  await cutPiece(cards.hook, hook);
  const fixed =
    pieceSeconds(cards.hook) +
    pieceSeconds(cards.bts) +
    pieceSeconds(cards.cases) +
    pieceSeconds(cards.outro) +
    5.5 +
    2.6 +
    1.6 +
    ex.clips.reduce((x, c) => x + (c.keep[1] - c.keep[0]), 0);
  const uiRaw = pieceSeconds(ui);
  const room = MAX_SECONDS - fixed;
  const uiSpeed = uiRaw > room ? uiRaw / room : 1;
  log(`fixed parts ${fixed.toFixed(1)} s, UI ${uiRaw.toFixed(1)} s → UI at ${uiSpeed.toFixed(2)}x`);
  if (uiSpeed > 1.3) throw new Error(`the UI part (${uiRaw.toFixed(0)} s) is too long to fit 2:00`);
  const uiOut = join(work, "e-ui.mp4");
  await cutPiece(ui, uiOut, uiSpeed);
  const bts = join(work, "e-bts.mp4");
  await cutPiece(cards.bts, bts);
  pieces.push(hook, uiOut, bts);
  pieces.push(
    ...(await terminalClip(term, caps["term-ff"] as string, caps["term-hold"] as string)),
  );
  for (const c of ex.clips) {
    const out = join(work, `e-ex-${c.name}.mp4`);
    await cutPiece({ file: ex.file, keep: [c.keep] }, out, 1, caps[c.name]);
    pieces.push(out);
  }
  const cases = join(work, "e-cases.mp4");
  await cutPiece(cards.cases, cases);
  const outro = join(work, "e-outro.mp4");
  await cutPiece(cards.outro, outro);
  pieces.push(cases, outro);

  const mp4 = join(outDir, "ghost-paths-demo.mp4");
  await joinAll(pieces, mp4);
  const dur = await duration(mp4);
  const mb = statSync(mp4).size / 1e6;
  log(`wrote ${mp4}: ${dur.toFixed(1)} s, ${mb.toFixed(2)} MB`);
  if (dur > 120) throw new Error(`video is ${dur.toFixed(1)} s, over the 2:00 limit`);
  if (mb > 20) throw new Error(`video is ${mb.toFixed(1)} MB, over 20 MB`);
  writeFileSync(
    join(outDir, "explorer-links.txt"),
    `# The transactions shown in the video (NEAR testnet, Ethereum Sepolia, Solana devnet)\npayment (Sepolia)        ${pay}\nannouncement (NEAR)      ${ui.urls.announce ?? ""}\nwithdrawal (NEAR, signer) ${sweepNear}/execution\nwithdrawal (Sepolia)     ${sweepChain}\n${solTx ? `terminal run payment (Solana devnet) ${solTx}\n` : ""}`,
  );
  if (process.env.VIDEO_KEEP !== "1") rmSync(work, { recursive: true, force: true });
}

if (process.env.VIDEO_PART === "ui") {
  try {
    const base = await startServe(process.env.VIDEO_PART_HOME as string);
    const ui = await recordUi(base, process.env.VIDEO_BOB as string);
    writeFileSync(join(work, "ui-result.json"), JSON.stringify(ui));
  } catch (e) {
    console.error(`[video] UI take failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    serve?.kill();
  }
  process.exit(process.exitCode ?? 0);
}
if (process.env.VIDEO_PART === "explorer") {
  try {
    const ex = await recordExplorers(
      JSON.parse(process.env.VIDEO_SHOTS as string) as ExplorerShot[],
    );
    writeFileSync(join(work, "explorer-result.json"), JSON.stringify(ex));
  } catch (e) {
    console.error(`[video] explorer take failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
if (process.env.VIDEO_PART === "uitest") {
  // rehearse the web app take against a kept local run (KEEP=1 DEMO_NATIVE_CHAINS=1 make demo):
  // VIDEO_PART=uitest VIDEO_PART_HOME=… VIDEO_CHAINS=evm:31337,sol:local VIDEO_BOB=0x… bun scripts/record-video.ts
  const ui = await child<UiTake>("ui", {
    VIDEO_PART_HOME: process.env.VIDEO_PART_HOME as string,
    VIDEO_BOB: process.env.VIDEO_BOB as string,
  });
  const out = join(work, "uitest.mp4");
  log(
    `UI kept ${pieceSeconds(ui).toFixed(1)} s in ${ui.keep.length} spans; ${JSON.stringify(ui.urls)}`,
  );
  await cutPiece(ui, out);
  log(`wrote ${out}`);
  process.exit(0);
}
if (process.env.VIDEO_PART === "cards") {
  // preview the cards only: VIDEO_PART=cards VIDEO_KEEP=1 bun scripts/record-video.ts
  const c = await renderCards();
  for (const [k, p] of Object.entries(c)) log(`${k}: ${p.file} (${pieceSeconds(p).toFixed(1)} s)`);
  process.exit(0);
}
if (process.env.VIDEO_PART === "termtest") {
  // check the Terminal window capture: VIDEO_PART=termtest bun scripts/record-video.ts
  const t = await terminalTake("true\nls -la && sleep 2 && echo done", "termtest", 60);
  log(`termtest: ${t.video}, ${t.lines.length} lines`);
  process.exit(0);
}

try {
  await main();
} catch (e) {
  console.error(`[video] failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  serve?.kill();
  if (process.env.VIDEO_KEEP_STATE !== "1") {
    log("make demo-clean (stops the relayer, deletes the kept NEAR accounts)");
    await sh(["make", "demo-clean"]);
  }
}
process.exit(process.exitCode ?? 0);
