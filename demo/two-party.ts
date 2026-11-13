#!/usr/bin/env bun
/**
 * The product as two people use it, on public testnets (`make two-party`):
 *
 *   payer      http://127.0.0.1:8790/pay.html   static page, no keys; MetaMask signs on Sepolia
 *   recipient  http://127.0.0.1:8791/?token=…   the recipient's own app (`ghost serve`), holding only
 *                                               the recipient's keys
 *   relayer    http://127.0.0.1:8792            posts the payer's note and the recipient's withdrawal
 *                                               on NEAR, so neither needs to appear there
 *
 * Open the two pages in two browser profiles. One-time setup of the recipient and the relayer
 * (testnet, from a funder account): docs/DEMO.md, "Two people, real wallets".
 *
 * Env (defaults in brackets):
 *   TWO_PARTY_DIR        [.secrets/demo/two-party]  holds bob-home/ and relayer-home/
 *   GHOST_CHAINS         [evm:11155111]
 *   PAY_PORT [8790]  TWO_PARTY_APP_PORT [8791]  TWO_PARTY_RELAYER_PORT [8792]
 *   (not 8787/8788, so `make demo` / `make demo-replay` can run next to it)
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIR = resolve(ROOT, process.env.TWO_PARTY_DIR ?? ".secrets/demo/two-party");
const BOB_HOME = join(DIR, "bob-home");
const RELAYER_KEY = join(DIR, "relayer-home/relayer.near.json");
const PAY_PORT = Number(process.env.PAY_PORT ?? 8790);
const SERVE_PORT = Number(process.env.TWO_PARTY_APP_PORT ?? 8791);
const RELAYER_PORT = Number(process.env.TWO_PARTY_RELAYER_PORT ?? 8792);
const CHAINS = process.env.GHOST_CHAINS ?? "evm:11155111";
const relayerUrl = `http://127.0.0.1:${RELAYER_PORT}`;

for (const [what, p] of [
  ["recipient keystore", join(BOB_HOME, "bob.json")],
  ["relayer key", RELAYER_KEY],
] as const) {
  if (!existsSync(p)) {
    console.error(
      `missing ${what}: ${p}\nSet it up first (docs/DEMO.md, "Two people, real wallets").`,
    );
    process.exit(2);
  }
}

const bob = (JSON.parse(readFileSync(join(BOB_HOME, "bob.json"), "utf8")) as { account: string })
  .account;

console.log("building the web app (apps/web/dist: the recipient app and pay.html)…");
const b = spawnSync("bun", ["run", "build"], {
  cwd: join(ROOT, "apps/web"),
  stdio: "inherit",
  env: { ...process.env, VITE_GHOST_RELAYER_URL: relayerUrl, VITE_GHOST_PAY_CHAINS: CHAINS },
});
if (b.status !== 0) process.exit(b.status ?? 1);

const kids: ChildProcess[] = [];
function run(name: string, cmd: string[], env: Record<string, string>, cwd = ROOT) {
  const p = spawn(cmd[0] as string, cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `[${name}] `;
  const out = (d: Buffer) =>
    process.stdout.write(
      d
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((l) => `${tag}${l}\n`)
        .join(""),
    );
  p.stdout?.on("data", out);
  p.stderr?.on("data", out);
  p.on("exit", (c) => {
    console.log(`${tag}exited (${c})`);
    stop(c ?? 1);
  });
  kids.push(p);
}
function stop(code = 0) {
  for (const k of kids) k.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const payOrigins = [`http://127.0.0.1:${PAY_PORT}`, `http://localhost:${PAY_PORT}`];
const serveOrigins = [`http://127.0.0.1:${SERVE_PORT}`, `http://localhost:${SERVE_PORT}`];

run("relayer", ["bun", "packages/relayer/src/server.ts"], {
  GHOST_NETWORK: "testnet",
  RELAYER_KEY_FILE: RELAYER_KEY,
  RELAYER_PORT: String(RELAYER_PORT),
  RELAYER_CORS_ORIGINS: [...payOrigins, ...serveOrigins].join(","),
});
run("bob's app", ["bun", "packages/cli/src/ghost.ts", "serve", "--port", String(SERVE_PORT)], {
  GHOST_HOME: BOB_HOME,
  GHOST_NETWORK: "testnet",
  GHOST_CHAINS: CHAINS,
  GHOST_RELAYER_URL: relayerUrl,
  GHOST_REPLAY: "",
  GHOST_TAPE: "",
});
run(
  "pay page",
  [
    "bun",
    "x",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(PAY_PORT),
    "--strictPort",
  ],
  {},
  join(ROOT, "apps/web"),
);

console.log(`
  payer:      http://127.0.0.1:${PAY_PORT}/pay.html?to=${bob}
  recipient:  the "open http://127.0.0.1:${SERVE_PORT}/?token=…" line below
  Ctrl-C stops all three.
`);
