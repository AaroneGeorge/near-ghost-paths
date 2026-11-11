#!/usr/bin/env bun
/**
 * Ghost Paths demo orchestrator (W3) — what the `make demo*` targets run. PLAN §1.10.
 *
 *   bun demo/demo.ts                 local:   NEAR testnet (real MPC) + anvil + solana-test-validator (docker)
 *   bun demo/demo.ts --record        local, and record every HTTP exchange into demo/fixtures/replay/
 *   bun demo/demo.ts --replay        offline: replays demo/fixtures/replay/ (GHOST_REPLAY=1, no docker, no network)
 *   bun demo/demo.ts --testnet       NEAR testnet + Sepolia + Solana devnet, payer = lechu-wallet / FUNDER_* keys
 *   bun demo/demo.ts --live          mainnet: refuses (dry 1Click quote only) unless MAINNET_APPROVED=1 + keys
 *
 * Every step runs the real `ghost` CLI as a subprocess (shown as `$ ghost …`) and checks its JSON result.
 * No owner secrets: NEAR accounts come from the testnet faucet helper; local chains mint test funds.
 * Exit 0 only if every check passes.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { newKeyPair } from "@ghost-paths/sdk";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CLI = join(ROOT, "packages/cli/src/ghost.ts");
const RELAYER = join(ROOT, "packages/relayer/src/server.ts");
const COMPOSE = join(ROOT, "demo/docker-compose.yml");
const REPLAY_DIR = join(ROOT, "demo/fixtures/replay");

type Mode = "local" | "replay" | "testnet" | "live";
const argv = process.argv.slice(2);
const MODE: Mode =
  argv.includes("--replay") || process.env.GHOST_REPLAY === "1"
    ? "replay"
    : argv.includes("--testnet")
      ? "testnet"
      : argv.includes("--live")
        ? "live"
        : "local";
const RECORD = argv.includes("--record");
const CLEAN = argv.includes("--clean");
const KEEP = process.env.KEEP === "1" || argv.includes("--keep");

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = col("1");
const dim = col("2");
const green = col("32");
const red = col("31");
const yellow = col("33");
const cyan = col("36");

const T0 = Date.now();
const clock = () => {
  const s = Math.floor((Date.now() - T0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

class DemoError extends Error {}
const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? green("✓") : red("✗")} ${name}${detail ? dim(` (${detail})`) : ""}`);
  if (!ok) throw new DemoError(`check failed: ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------------------------
// Run directory, environment

const runId =
  MODE === "replay" ? "replay" : new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const RUN_DIR =
  MODE === "replay"
    ? join(process.env.TMPDIR ?? "/tmp", `ghost-paths-replay-${process.pid}`)
    : join(ROOT, ".secrets/demo", `${MODE}-${runId}`);
const HOME = join(RUN_DIR, "home");
const OUT = join(RUN_DIR, "out");
mkdirSync(HOME, { recursive: true, mode: 0o700 });
mkdirSync(OUT, { recursive: true });

interface Manifest {
  seed: string;
  funder: string;
  recorded_at: string;
  contract: string;
  chains: string[];
  dest: Record<string, string>;
  steps: string[];
}

let manifest: Manifest | undefined;
let tapeSeed: string | undefined;
let tapeDir: string | undefined;
if (MODE === "replay") {
  const mf = join(REPLAY_DIR, "manifest.json");
  if (!existsSync(mf)) {
    console.error(red(`no recorded run in ${REPLAY_DIR} (record one with: make demo-record)`));
    process.exit(1);
  }
  manifest = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
  tapeSeed = manifest.seed;
  tapeDir = REPLAY_DIR;
} else if (RECORD) {
  tapeSeed = randomBytes(16).toString("hex");
  tapeDir = join(RUN_DIR, "tape");
  mkdirSync(tapeDir, { recursive: true });
}

const RELAYER_PORT = Number(process.env.GHOST_RELAYER_PORT ?? 8787);
const RELAYER_URL = `http://127.0.0.1:${RELAYER_PORT}`;
const ANVIL_PORT = Number(process.env.GHOST_ANVIL_PORT ?? 8545);
const SOL_PORT = Number(process.env.GHOST_SOLANA_PORT ?? 8899);

const CHAINS =
  MODE === "testnet"
    ? (process.env.GHOST_TESTNET_CHAINS ?? "evm:11155111,sol:devnet").split(",")
    : (manifest?.chains ?? (process.env.GHOST_CHAINS ?? "evm:31337,sol:local").split(","));
const CONTRACT = manifest?.contract ?? process.env.GHOST_CONTRACT ?? "v1.ghost-paths.testnet";

const baseEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GHOST_HOME: HOME,
  GHOST_NETWORK: MODE === "live" ? "mainnet" : "testnet",
  GHOST_CONTRACT: CONTRACT,
  GHOST_RELAYER_URL: RELAYER_URL,
  GHOST_MODE: process.env.GHOST_MODE ?? "contract",
  GHOST_RPC_EVM_31337: `http://127.0.0.1:${ANVIL_PORT}`,
  GHOST_RPC_SOL_LOCAL: `http://127.0.0.1:${SOL_PORT}`,
  GHOST_CHAINS: CHAINS.join(","),
  NO_COLOR: color ? "" : "1",
  FORCE_COLOR: color ? "1" : "0",
};
if (MODE === "replay") baseEnv.GHOST_REPLAY = "1";
// biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
else delete baseEnv.GHOST_REPLAY;

function tapeEnv(step: string): Record<string, string> {
  if (!tapeDir || !tapeSeed) return {};
  return {
    GHOST_TAPE: join(tapeDir, `${step}.jsonl`),
    GHOST_TAPE_MODE: MODE === "replay" ? "replay" : "record",
    GHOST_TAPE_SEED: tapeSeed,
    GHOST_TAPE_PASSTHROUGH: RELAYER_URL,
  };
}

// ---------------------------------------------------------------------------------------------
// Subprocess helpers

let stepNo = 0;
const stepNames: string[] = [];

interface GhostOpts {
  /** print the command's human output (default true) */
  show?: boolean;
  /** allow a non-zero exit (returns the JSON with ok:false) */
  allowFail?: boolean;
  label?: string;
}

/** Runs `ghost …` with --json-out; streams its human output indented; returns the JSON result. */
async function ghost(args: string[], o: GhostOpts = {}): Promise<Record<string, unknown>> {
  const step = `${String(++stepNo).padStart(2, "0")}-${o.label ?? args[0]}`;
  stepNames.push(step);
  const jsonOut = join(OUT, `${step}.json`);
  console.log(`  ${dim("$")} ${cyan(`ghost ${args.join(" ")}`)}`);
  const show = o.show ?? true;
  const code = await new Promise<number>((res) => {
    const p = spawn("bun", [CLI, ...args, "--json-out", jsonOut], {
      cwd: ROOT,
      env: { ...baseEnv, ...tapeEnv(step) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fwd = (d: Buffer) => {
      if (!show) return;
      for (const line of d.toString().split("\n")) if (line.trim()) console.log(`    ${line}`);
    };
    p.stdout.on("data", fwd);
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      // near-api-js prints retried RPC errors with source excerpts; keep the demo readable.
      if (/^\s*\d+ \|/m.test(s) || /at (parseHandlerError|sendJsonRpc)/.test(s)) return;
      fwd(d);
    });
    p.on("close", (c) => res(c ?? 1));
  });
  const result = existsSync(jsonOut)
    ? (JSON.parse(readFileSync(jsonOut, "utf8")) as Record<string, unknown>)
    : { ok: false };
  if (code !== 0 && !o.allowFail)
    throw new DemoError(
      `ghost ${args[0]} failed (exit ${code}): ${result.error ?? "see output above"}`,
    );
  return result;
}

function header(title: string, time?: string): void {
  console.log(`\n${bold(`[${clock()}]`)} ${bold(title)}${time ? dim(`  (script ${time})`) : ""}`);
}

function dockerCmd(): string[] | null {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0) return ["docker"];
  if (spawnSync("sudo", ["-n", "docker", "info"], { stdio: "ignore" }).status === 0)
    return ["sudo", "-n", "docker"];
  return null;
}

async function rpcOk(url: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitFor(what: string, f: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (await f()) return;
    await Bun.sleep(400);
  }
  throw new DemoError(`${what} not ready after ${timeoutMs / 1000} s`);
}

let relayerProc: ChildProcess | undefined;
let composeUp: string[] | null = null;
/**
 * DEMO_NATIVE_CHAINS=1: run `anvil` and `solana-test-validator` from PATH instead of docker. For
 * Apple Silicon, where the agave image has no arm64 build and crashes under x86 emulation (AVX).
 */
const NATIVE = process.env.DEMO_NATIVE_CHAINS === "1";
const nativeProcs: ChildProcess[] = [];

async function startRelayer(keyFile: string): Promise<void> {
  const logFile = join(RUN_DIR, "relayer.log");
  const env = {
    ...baseEnv,
    ...tapeEnv("relayer"),
    RELAYER_KEY_FILE: keyFile,
    RELAYER_PORT: String(RELAYER_PORT),
  };
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
  delete (env as Record<string, string | undefined>).GHOST_TAPE_PASSTHROUGH;
  const { openSync } = await import("node:fs");
  const fd = openSync(logFile, "w");
  relayerProc = spawn("bun", [RELAYER], { cwd: ROOT, env, stdio: ["ignore", fd, fd] });
  await waitFor(
    "relayer",
    async () => {
      if (relayerProc?.exitCode != null)
        throw new DemoError(`relayer exited: ${readFileSync(logFile, "utf8").slice(-400)}`);
      try {
        return (await fetch(`${RELAYER_URL}/health`, { signal: AbortSignal.timeout(3_000) })).ok;
      } catch {
        return false;
      }
    },
    20_000,
  );
}

function cleanup(): void {
  if (relayerProc && relayerProc.exitCode == null) {
    if (KEEP && MODE !== "replay") {
      relayerProc.unref(); // keep serving for `make web`
      writeFileSync(join(RUN_DIR, "relayer.pid"), String(relayerProc.pid));
      console.log(
        dim(
          `  KEEP=1: relayer still running (pid ${relayerProc.pid}, ${RELAYER_URL}); stop it with: kill ${relayerProc.pid}`,
        ),
      );
    } else relayerProc.kill("SIGTERM");
  }
  // Without KEEP the run's NEAR accounts are deleted, so its keys are useless: drop them, keep logs/summary.
  if (!KEEP && MODE !== "replay") rmSync(HOME, { recursive: true, force: true });
  for (const p of nativeProcs) {
    if (p.exitCode != null) continue;
    if (KEEP)
      p.unref(); // keep the chains for `make web`; `make demo-clean` stops them
    else p.kill("SIGTERM");
  }
  if (composeUp && !KEEP) {
    spawnSync(
      composeUp[0] as string,
      [...composeUp.slice(1), "compose", "-f", COMPOSE, "down", "-v", "--remove-orphans"],
      {
        stdio: "ignore",
      },
    );
  }
  if (MODE === "replay") rmSync(RUN_DIR, { recursive: true, force: true });
}

/** Deterministic per-run destination addresses (fresh, never reused across runs). */
function destinations(seed: string): Record<string, string> {
  const h = (label: string) =>
    createHash("sha256").update(`ghost-paths-demo/${seed}/${label}`).digest();
  const evm = `0x${h("evm-dest").subarray(0, 20).toString("hex")}`;
  // Solana: any 32 bytes are a valid (off-curve or not) system-account address for receiving.
  const b58 = (buf: Buffer) => {
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt(`0x${buf.toString("hex")}`);
    let s = "";
    while (n > 0n) {
      s = A[Number(n % 58n)] + s;
      n /= 58n;
    }
    for (const b of buf) {
      if (b !== 0) break;
      s = `1${s}`;
    }
    return s;
  };
  return { evm, sol: b58(h("sol-dest")) };
}

// ---------------------------------------------------------------------------------------------
// Funder + account lifecycle

const created: string[] = [];

async function nearBalance(accountId: string): Promise<bigint | null> {
  for (const url of ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "gp",
          method: "query",
          params: { request_type: "view_account", finality: "final", account_id: accountId },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const j = (await r.json()) as { result?: { amount: string }; error?: unknown };
      if (j.result) return BigInt(j.result.amount);
      if (j.error) return null;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * The demo funder: DEMO_FUNDER_FILE, else .secrets/demo/funder.json, else one faucet-helper account
 * created now and cached there. In replay a placeholder file is written (the funder's transactions
 * replay from the tape; its key is never needed).
 */
async function ensureFunder(): Promise<{ file: string; account: string }> {
  if (MODE === "replay") {
    const file = join(RUN_DIR, "funder.json");
    // The placeholder key signs different bytes than the recorded run; tape.ts matches those RPC
    // calls by order instead of body (see tape.ts "Matching").
    writeFileSync(
      file,
      JSON.stringify({ account_id: manifest?.funder, secret_key: newKeyPair().secretKey }),
      { mode: 0o600 },
    );
    return { file, account: String(manifest?.funder) };
  }
  const file = process.env.DEMO_FUNDER_FILE ?? join(ROOT, ".secrets/demo/funder.json");
  if (!existsSync(file)) {
    console.log(
      dim(
        "  no demo funder yet: creating one with the NEAR testnet faucet helper (once per machine)…",
      ),
    );
    const fh = join(ROOT, ".secrets/demo/funder-home");
    const r = spawnSync("bun", [CLI, "account", "create", "--as", "funder", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...baseEnv, GHOST_HOME: fh, GHOST_FUNDER_FILE: "", DEMO_FUNDER_FILE: "" },
    });
    if (r.status !== 0) {
      throw new DemoError(
        `could not create the demo funder: ${(JSON.parse(r.stdout || "{}") as { error?: string }).error ?? r.stderr.slice(-300)}\n  Point DEMO_FUNDER_FILE at a JSON {account_id, secret_key} of any testnet account with ≥ 3 NEAR, or run make demo-replay.`,
      );
    }
    cpSync(join(fh, "funder.near.json"), file);
  }
  const f = JSON.parse(readFileSync(file, "utf8")) as { account_id: string };
  const bal = await nearBalance(f.account_id);
  if (bal === null)
    throw new DemoError(`demo funder ${f.account_id} not found on testnet (${file})`);
  if (bal < 25n * 10n ** 23n)
    throw new DemoError(
      `demo funder ${f.account_id} has ${Number(bal / 10n ** 21n) / 1000} NEAR; it needs ≥ 2.5 (top it up or set DEMO_FUNDER_FILE)`,
    );
  return { file, account: f.account_id };
}

/** Deletes this run's accounts, returning their NEAR to the funder (so a recorded seed controls nothing). */
async function deleteAccounts(beneficiary: string): Promise<void> {
  if (!created.length) return;
  if (relayerProc && relayerProc.exitCode == null) {
    relayerProc.kill("SIGTERM");
    await Bun.sleep(200);
  }
  console.log(
    dim(`\n  cleaning up: deleting this run's NEAR accounts (balances return to ${beneficiary})`),
  );
  const names = created.splice(0);
  await Promise.all(
    names.map((p) =>
      ghost(["account", "delete", "--as", p, "--beneficiary", beneficiary], {
        show: false,
        allowFail: true,
        label: `delete-${p}`,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Flows

const AMOUNTS: Record<string, [string, string]> = {
  "evm:31337": ["0.01", "ETH"],
  "sol:local": ["0.1", "SOL"],
  "evm:11155111": ["0.001", "ETH"],
  "evm:84532": ["0.001", "ETH"],
  "sol:devnet": ["0.02", "SOL"],
};

async function lechuAddresses(): Promise<Record<string, string>> {
  const r = spawnSync("sudo", ["-n", "-u", "claude", "lechu-wallet", "info"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status !== 0) return {};
  try {
    const j = JSON.parse(r.stdout) as { networks: Record<string, { address: string }> };
    return Object.fromEntries(Object.entries(j.networks).map(([k, v]) => [k, v.address]));
  } catch {
    return {};
  }
}

async function mainFlow(): Promise<void> {
  const seed = tapeSeed ?? randomBytes(16).toString("hex");
  let dest = manifest?.dest ?? destinations(seed);

  console.log(
    bold("Ghost Paths demo"),
    dim(`mode=${MODE}${RECORD ? " (recording)" : ""}  run=${RUN_DIR}`),
  );
  if (MODE === "replay") {
    console.log(
      yellow(
        "  REPLAY: no network. Every NEAR/MPC/chain response below is replayed from a real recorded run",
      ),
    );
    console.log(
      yellow(
        `  (${manifest?.recorded_at}); the CLI, SDK and relayer code run for real against those responses.`,
      ),
    );
  }

  // 1. Infra
  header("1. Infrastructure: NEAR testnet accounts, contract, local chains, MPC root keys", "0:00");
  if (MODE === "local" && NATIVE) {
    console.log(dim("  starting anvil + solana-test-validator natively (DEMO_NATIVE_CHAINS=1)…"));
    const { openSync } = await import("node:fs");
    const start = (name: string, cmd: string, args: string[]) => {
      const fd = openSync(join(RUN_DIR, `${name}.log`), "w");
      const p = spawn(cmd, args, { cwd: RUN_DIR, stdio: ["ignore", fd, fd], detached: true });
      p.on("error", (e) => console.error(red(`  ${cmd}: ${e.message} (is it on PATH?)`)));
      nativeProcs.push(p);
    };
    start("anvil", "anvil", [
      ...["--host", "127.0.0.1", "--port", String(ANVIL_PORT), "--chain-id", "31337", "--silent"],
    ]);
    start("solana", "solana-test-validator", [
      ...["--ledger", join(RUN_DIR, "solana-ledger"), "--reset", "--quiet"],
      ...["--rpc-port", String(SOL_PORT)],
    ]);
    writeFileSync(
      join(RUN_DIR, "native-chains.pid"),
      nativeProcs.map((p) => String(p.pid)).join("\n"),
    );
  } else if (MODE === "local") {
    const d = dockerCmd();
    if (!d)
      throw new DemoError("docker is not available (make demo falls back to make demo-replay)");
    console.log(
      dim(
        `  starting anvil + solana-test-validator (${d.join(" ")} compose, demo/docker-compose.yml)…`,
      ),
    );
    const up = spawnSync(
      d[0] as string,
      [...d.slice(1), "compose", "-f", COMPOSE, "up", "-d", "--force-recreate"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GHOST_ANVIL_PORT: String(ANVIL_PORT),
          GHOST_SOLANA_PORT: String(SOL_PORT),
          GHOST_SOLANA_WS_PORT: String(SOL_PORT + 1),
        },
      },
    );
    if (up.status !== 0) throw new DemoError(`docker compose up failed: ${up.stderr.slice(-500)}`);
    composeUp = d;
  }
  if (MODE === "local") {
    await waitFor(
      "anvil",
      () =>
        rpcOk(baseEnv.GHOST_RPC_EVM_31337 as string, {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
        }),
      60_000,
    );
    await waitFor(
      "solana-test-validator",
      () =>
        rpcOk(baseEnv.GHOST_RPC_SOL_LOCAL as string, {
          jsonrpc: "2.0",
          id: 1,
          method: "getHealth",
        }),
      90_000,
    );
    console.log(`  ${green("✓")} anvil (evm:31337) and solana-test-validator (sol:local) up`);
  }
  if (MODE === "testnet") {
    const l = await lechuAddresses();
    dest = {
      evm: process.env.DEMO_EVM_DEST ?? l.sepolia ?? (dest.evm as string),
      sol: process.env.DEMO_SOL_DEST ?? l["solana-devnet"] ?? (dest.sol as string),
    };
  }

  // NEAR accounts: one cached funder (a single faucet call per machine), per-run accounts created
  // from it through the `testnet` registrar and deleted at the end (their NEAR goes back).
  const funder = await ensureFunder();
  baseEnv.GHOST_FUNDER_FILE = funder.file;
  console.log(
    dim(
      `  creating fresh NEAR testnet accounts from the demo funder ${funder.account} (no owner keys)…`,
    ),
  );
  const people: [string, string][] = [
    ["bob", "0.5"],
    ["carol", "0.5"],
    ["relayer", "1.5"],
  ];
  // Sequential: all three are signed by the funder key (parallel txs would race on its nonce).
  const accts: Record<string, unknown>[] = [];
  for (const [p, amt] of people) {
    accts.push(
      await ghost(["account", "create", "--as", p, "--fund", amt], {
        show: false,
        label: `account-${p}`,
      }),
    );
    created.push(p);
  }
  for (const [i, [p]] of people.entries())
    console.log(`  ${green("✓")} ${p.padEnd(8)} ${cyan(String(accts[i]?.account_id))}`);
  console.log(
    `  ${green("✓")} alice    ${dim("pays from a local wallet and needs no NEAR account: the relayer posts her announcement")}`,
  );
  await startRelayer(join(HOME, "relayer.near.json"));
  console.log(`  ${green("✓")} relayer listening on ${RELAYER_URL} as ${accts[2]?.account_id}`);
  const st = await ghost(["status"], { label: "status" });
  check(
    "MPC root keys: v1.signer-prod.testnet public_key matches chainsig.js",
    (st.root_keys as { ok: boolean }).ok,
  );
  check(
    `Ghost Paths contract ${CONTRACT} is deployed`,
    !!(st.contract as { deployed?: boolean }).deployed,
  );
  for (const ch of st.chains as { chain: string; ok: boolean }[])
    check(`${ch.chain} RPC reachable`, ch.ok);

  // 2. Recipient keys + registry
  header("2. Bob creates his keys and registers one meta-address on NEAR", "0:15");
  await ghost(["init", "--as", "carol"], { show: false, label: "init-carol" });
  const bobInit = await ghost(["init", "--as", "bob"]);
  const [, , regBob] = await Promise.all([
    ghost(["register", "--as", "carol"], { show: false, label: "register-carol" }),
    Bun.sleep(0),
    ghost(["register", "--as", "bob"]),
  ]);
  const bobAccount = String(bobInit.account);
  check("bob registered", !!regBob.tx_hash || !!regBob.already);
  const m = await ghost(["meta", "bob"], { show: false });
  check(
    "registry returns bob's meta-address",
    (m.meta as { spend_pub?: string } | null)?.spend_pub ===
      (bobInit.meta as { spend_pub: string }).spend_pub,
  );
  console.log(dim("  carol (a stranger with her own keys) registered too"));

  // 3–4. Payments
  const payments: {
    chain: string;
    idx: number;
    address: string;
    amount: string;
    symbol: string;
  }[] = [];
  let n = 3;
  for (const chain of CHAINS) {
    const [amount, symbol] = AMOUNTS[chain] ?? ["0.001", chain.startsWith("sol") ? "SOL" : "ETH"];
    header(
      `${n}. Alice pays bob ${amount} ${symbol} on ${chain} at a one-time address`,
      n === 3 ? "0:30" : "0:45",
    );
    n++;
    const memo = chain.startsWith("evm") ? "invoice #42" : "invoice #43";
    const r = await ghost([
      "pay",
      "bob",
      amount,
      symbol,
      "--chain",
      chain,
      "--as",
      "alice",
      "--memo",
      memo,
    ]);
    check(
      `payment on ${chain} announced`,
      typeof r.idx === "number",
      `idx ${r.idx}, via ${r.announced_via}`,
    );
    payments.push({ chain, idx: Number(r.idx), address: String(r.address), amount, symbol });
  }

  // 5. Scans
  header(`${n}. Who can see the payments? stranger, recipient, auditor`, "1:00");
  n++;
  const sc = await ghost(
    ["scan", "--as", "carol", "--since", String(Math.min(...payments.map((p) => p.idx)))],
    { label: "scan-carol" },
  );
  check("carol (different viewing key) finds 0 payments", (sc.payments as unknown[]).length === 0);
  const sb = await ghost(["scan", "--as", "bob"], { label: "scan-bob" });
  const bobRows = sb.payments as { idx: number; balance: string; memo?: { note?: string } }[];
  for (const p of payments) {
    const row = bobRows.find((x) => x.idx === p.idx);
    check(
      `bob finds idx ${p.idx} on ${p.chain} with balance ${p.amount} ${p.symbol}`,
      !!row && row.balance === p.amount,
      row?.memo?.note,
    );
  }
  const vk = join(RUN_DIR, "bob.view.json");
  await ghost(["export-viewing-key", "--as", "bob", "--out", vk], { label: "export-vk" });
  const sa = await ghost(["scan", "--viewing-key", vk], { label: "scan-auditor" });
  check(
    "auditor (viewing key only) sees the same payments",
    payments.every((p) => (sa.payments as { idx: number }[]).some((x) => x.idx === p.idx)),
  );
  check("auditor cannot sweep", sa.can_sweep === false);

  // 6. Sweeps
  for (const p of payments) {
    header(
      `${n}. Bob sweeps idx ${p.idx} (${p.chain}) through the relayer → MPC → ${p.chain}`,
      "1:15",
    );
    n++;
    const to = p.chain.startsWith("evm") ? (dest.evm as string) : (dest.sol as string);
    const r = await ghost(["sweep", String(p.idx), "--to", to, "--as", "bob"], {
      label: `sweep-${p.chain.replace(":", "-")}`,
    });
    check(
      `swept ${p.chain} via ${r.via}`,
      !!r.chain_tx,
      `MPC ${((r.mpc_ms as number[])[0] ?? 0) / 1000} s`,
    );
    const nearTx = (r.near_txs as { tx_hash: string }[])[0]?.tx_hash;
    console.log(
      dim(
        `  NEAR explorer: ${CONTRACT} requested a signature for path ${String(r.path).slice(0, 14)}… from tx ${nearTx}; nothing names ${bobAccount}`,
      ),
    );
  }
  const after = await ghost(["scan", "--as", "bob"], { label: "scan-bob-after" });
  for (const p of payments) {
    const row = (after.payments as { idx: number; swept: boolean }[]).find((x) => x.idx === p.idx);
    check(`idx ${p.idx} now shows as swept`, !!row?.swept);
  }

  // 7. 1Click (mainnet-only; dry quote, keyless). Non-fatal: it is a public third-party API.
  header(
    `${n}. Breaking the consolidation link on mainnet: 1Click dry quote (nothing is sent)`,
    "1:50",
  );
  const q = await ghost(
    [
      "quote",
      "--chain",
      "evm:8453",
      "--amount",
      "0.002",
      "--to",
      "usdc:sol",
      "--recipient",
      dest.sol as string,
      "--confidential",
      "basic",
    ],
    { allowFail: true },
  );
  if (q.ok)
    console.log(
      dim(
        `  ${q.fallbackFrom ? "confidential quotes need ONECLICK_API_KEY; the public quote shows the route works" : "confidential quote ok"}`,
      ),
    );
  else console.log(yellow(`  1Click unreachable (${q.error}); skipped (optional step)`));

  if (!KEEP) await deleteAccounts(funder.account);

  if (MODE !== "replay") {
    writeFileSync(
      join(RUN_DIR, "summary.json"),
      JSON.stringify(
        { mode: MODE, contract: CONTRACT, bob: bobAccount, payments, dest, checks },
        null,
        2,
      ),
    );
  }
  if (RECORD && tapeDir && tapeSeed) {
    const mf: Manifest = {
      seed: tapeSeed,
      funder: funder.account,
      recorded_at: new Date().toISOString(),
      contract: CONTRACT,
      chains: CHAINS,
      dest,
      steps: stepNames,
    };
    writeFileSync(join(tapeDir, "manifest.json"), `${JSON.stringify(mf, null, 2)}\n`);
    rmSync(REPLAY_DIR, { recursive: true, force: true });
    mkdirSync(REPLAY_DIR, { recursive: true });
    for (const f of readdirSync(tapeDir)) cpSync(join(tapeDir, f), join(REPLAY_DIR, f));
    console.log(
      dim(
        `\n  recorded ${readdirSync(tapeDir).length} tapes into demo/fixtures/replay/ (no secrets: HTTP traffic + seed of throwaway testnet keys)`,
      ),
    );
  }
}

/** demo-live: mainnet. Refuses (exit 0 after a dry quote) unless MAINNET_APPROVED=1 and keys exist. */
async function liveFlow(): Promise<void> {
  header("demo-live: NEAR mainnet + Base + 1Click confidential sweep");
  const missing: string[] = [];
  if (process.env.MAINNET_APPROVED !== "1")
    missing.push("MAINNET_APPROVED=1 (the owner's explicit approval to spend mainnet funds)");
  if (!process.env.GHOST_CONTRACT || process.env.GHOST_CONTRACT.endsWith(".testnet"))
    missing.push("GHOST_CONTRACT=<mainnet Ghost Paths contract>");
  if (!process.env.GHOST_CODE_HASH)
    missing.push("GHOST_CODE_HASH=<code hash of the released mainnet wasm> (no mainnet pin yet)");
  const liveHome = process.env.GHOST_LIVE_HOME;
  if (
    !liveHome ||
    !existsSync(join(liveHome, "bob.near.json")) ||
    !existsSync(join(liveHome, "alice.near.json"))
  ) {
    missing.push(
      "GHOST_LIVE_HOME with mainnet profiles alice + bob (ghost account import --network mainnet …)",
    );
  }
  if (
    !process.env.FUNDER_EVM_PK &&
    spawnSync("sudo", ["-n", "-u", "claude", "lechu-wallet", "info"], { stdio: "ignore" })
      .status !== 0
  ) {
    missing.push("a Base payer: FUNDER_EVM_PK or lechu-wallet");
  }
  if (missing.length) {
    console.log(yellow("  REFUSED: no mainnet action was taken. Missing:"));
    for (const m of missing) console.log(yellow(`   - ${m}`));
    console.log(
      dim("\n  What would run: ghost pay bob 0.002 ETH --chain evm:8453 --as alice; then"),
    );
    console.log(
      dim(
        "  ghost sweep <idx> --via-1click usdc:sol --recipient <addr> --confidential basic --wet --as bob",
      ),
    );
    console.log(dim("\n  Free, keyless part (1Click dry quote, mainnet prices, nothing sent):"));
    await ghost(
      [
        "quote",
        "--chain",
        "evm:8453",
        "--amount",
        "0.002",
        "--to",
        "usdc:sol",
        "--recipient",
        destinations("live").sol as string,
        "--confidential",
        "basic",
      ],
      { allowFail: true },
    );
    console.log(`\n${yellow("demo-live refused cleanly (dry run only).")}`);
    return;
  }
  // Approved and configured: the real flow (never run by the builders; see TRACK-3-NOTES.md).
  baseEnv.GHOST_HOME = liveHome as string;
  baseEnv.GHOST_NETWORK = "mainnet";
  baseEnv.GHOST_RELAYER_URL = process.env.LIVE_RELAYER_URL ?? ""; // no demo relayer on mainnet: self-submit (warned)
  const recipient = process.env.LIVE_RECIPIENT;
  if (!recipient) throw new DemoError("set LIVE_RECIPIENT=<Solana address that receives USDC>");
  const r = await ghost([
    "pay",
    "bob",
    "0.002",
    "ETH",
    "--chain",
    "evm:8453",
    "--as",
    "alice",
    "--memo",
    "live demo",
  ]);
  await ghost(["scan", "--as", "bob"]);
  await ghost([
    "sweep",
    String(r.idx),
    "--via-1click",
    "usdc:sol",
    "--recipient",
    recipient,
    "--confidential",
    process.env.LIVE_CONFIDENTIAL ?? "basic",
    "--wet",
    "--allow-link", // no mainnet relayer: self-submission, accepted explicitly (REVIEW L4)
    "--as",
    "bob",
  ]);
}

/** make demo-clean: stop what KEEP=1 left running and delete kept runs' NEAR accounts (back to the funder). */
async function cleanKept(): Promise<number> {
  const root = join(ROOT, ".secrets/demo");
  const funderFile = process.env.DEMO_FUNDER_FILE ?? join(root, "funder.json");
  const funder = existsSync(funderFile)
    ? (JSON.parse(readFileSync(funderFile, "utf8")) as { account_id: string }).account_id
    : undefined;
  for (const run of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, run);
    const chainPids = join(dir, "native-chains.pid");
    if (existsSync(chainPids)) {
      for (const pid of readFileSync(chainPids, "utf8").split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGTERM");
          console.log(`stopped native chain process ${pid} of ${run}`);
        } catch {
          /* already gone */
        }
      }
      rmSync(chainPids);
    }
    const pidFile = join(dir, "relayer.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
        console.log(`stopped relayer of ${run}`);
      } catch {
        /* already gone */
      }
      rmSync(pidFile);
    }
    const home = join(dir, "home");
    if (!existsSync(home) || run === "funder-home") continue;
    for (const f of readdirSync(home).filter((x) => x.endsWith(".near.json"))) {
      const name = f.replace(/\.near\.json$/, "");
      if (!funder) break;
      const r = spawnSync(
        "bun",
        [CLI, "account", "delete", "--as", name, "--beneficiary", funder, "--json"],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, GHOST_HOME: home, GHOST_REPLAY: "" },
        },
      );
      console.log(
        `${run}: delete ${name} → ${r.status === 0 ? "ok" : "failed (already deleted?)"}`,
      );
    }
    rmSync(home, { recursive: true, force: true });
  }
  const d = dockerCmd();
  if (d)
    spawnSync(
      d[0] as string,
      [...d.slice(1), "compose", "-f", COMPOSE, "down", "-v", "--remove-orphans"],
      { stdio: "inherit" },
    );
  return 0;
}

async function main(): Promise<number> {
  if (CLEAN) return cleanKept();
  const onSig = () => {
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  try {
    if (MODE === "live") await liveFlow();
    else await mainFlow();
    const secs = ((Date.now() - T0) / 1000).toFixed(0);
    if (checks.length)
      console.log(
        `\n${green(bold(`demo OK: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed in ${secs} s`))}${MODE === "replay" ? dim(" (replayed, offline)") : ""}`,
      );
    if (KEEP && (composeUp || nativeProcs.length)) {
      console.log(
        dim(
          `  KEEP=1: chains still running (make chains-down to stop); profiles in ${HOME} (GHOST_HOME)`,
        ),
      );
      console.log(dim("  web UI against this state: make web  →  http://127.0.0.1:8788"));
    }
    return 0;
  } catch (e) {
    console.error(`\n${red(bold("demo FAILED:"))} ${(e as Error).message}`);
    if (
      MODE !== "replay" &&
      !KEEP &&
      process.env.GHOST_FUNDER_FILE === undefined &&
      baseEnv.GHOST_FUNDER_FILE
    ) {
      const f = JSON.parse(readFileSync(baseEnv.GHOST_FUNDER_FILE, "utf8")) as {
        account_id: string;
      };
      await deleteAccounts(f.account_id).catch(() => undefined);
    }
    if (relayerProc) console.error(dim(`  relayer log: ${join(RUN_DIR, "relayer.log")}`));
    return 1;
  } finally {
    cleanup();
  }
}

process.exit(await main());
