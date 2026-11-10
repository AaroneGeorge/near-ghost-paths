/**
 * CLI context: configuration (env + flags), local profiles, NEAR accounts, registry client.
 *
 * Profiles live in GHOST_HOME (default ~/.ghost; `make demo` uses .secrets/demo/<run>/home):
 *   <name>.json        recipient keystore (seed!) — W1 format, 0600
 *   <name>.near.json   { account_id, secret_key, network } — NEAR credentials, 0600
 *   <name>.wallet.json { evm_pk, sol_sk } — payer keys for local/test chains, 0600
 * Secret values are never printed; JSON output only ever carries public data.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_GHOST_CONTRACT,
  type Keystore,
  MPC_CONTRACT,
  type Mode,
  type NearNetwork,
  NearRegistry,
  type Via,
  createFaucetAccount,
  loadKeystore,
  makeAccount,
  newKeyPair,
  randomTestnetId,
  tapeStatus,
  verifyContractCode,
} from "@ghost-paths/sdk";
import type { Flags } from "./args.ts";

export type Account = ReturnType<typeof makeAccount>;

export interface NearCreds {
  account_id: string;
  secret_key: string;
  network: NearNetwork;
}

export interface WalletKeys {
  evm_pk?: string;
  sol_sk?: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

const env = (k: string): string | undefined => process.env[k] || undefined;

export interface Config {
  network: NearNetwork;
  contractId: string;
  signerId: string;
  relayerUrl?: string;
  mode: Mode;
  home: string;
  replay: boolean;
}

export function loadConfig(f: Flags): Config {
  const network = (f.network ?? env("GHOST_NETWORK") ?? "testnet") as NearNetwork;
  if (network !== "testnet" && network !== "mainnet")
    throw new CliError(`bad network "${network}"`);
  const relayer = f["no-relayer"] ? undefined : (f.relayer ?? env("GHOST_RELAYER_URL"));
  return {
    network,
    contractId: f.contract ?? env("GHOST_CONTRACT") ?? DEFAULT_GHOST_CONTRACT[network],
    signerId: env("GHOST_SIGNER") ?? MPC_CONTRACT[network],
    relayerUrl: relayer,
    mode: (f.mode ?? env("GHOST_MODE") ?? "contract") as Mode,
    home: resolve(f.home ?? env("GHOST_HOME") ?? join(homedir(), ".ghost")),
    replay: env("GHOST_REPLAY") === "1",
  };
}

function writeSecret(file: string, data: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export class Profiles {
  constructor(readonly home: string) {}

  static checkName(name: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name))
      throw new CliError(`bad profile name "${name}" (a-z0-9_-)`);
    return name;
  }
  keystorePath(name: string) {
    return join(this.home, `${Profiles.checkName(name)}.json`);
  }
  nearPath(name: string) {
    return join(this.home, `${Profiles.checkName(name)}.near.json`);
  }
  walletPath(name: string) {
    return join(this.home, `${Profiles.checkName(name)}.wallet.json`);
  }

  hasKeystore(name: string) {
    return existsSync(this.keystorePath(name));
  }
  async keystore(name: string): Promise<Keystore> {
    const p = this.keystorePath(name);
    if (!existsSync(p))
      throw new CliError(
        `no keystore for "${name}" in ${this.home}: run \`ghost init --as ${name}\``,
      );
    return loadKeystore(p);
  }

  near(name: string): NearCreds | null {
    const p = this.nearPath(name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as NearCreds) : null;
  }
  saveNear(name: string, c: NearCreds) {
    writeSecret(this.nearPath(name), c);
  }

  wallet(name: string): WalletKeys {
    const p = this.walletPath(name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as WalletKeys) : {};
  }
  saveWallet(name: string, w: WalletKeys) {
    writeSecret(this.walletPath(name), w);
  }
}

/** Resolves a recipient argument: profile name (has a .near.json) → its account id; `ghost:x` → x; else as-is. */
export function resolveAccountId(p: Profiles, who: string): string {
  if (who.startsWith("ghost:")) return who.slice(6);
  if (/^[a-z0-9_-]+$/.test(who) && !who.includes(".")) {
    const c = existsSync(p.nearPath(who)) ? p.near(who) : null;
    if (c) return c.account_id;
    if (p.hasKeystore(who)) {
      const ks = JSON.parse(readFileSync(p.keystorePath(who), "utf8")) as Keystore;
      return ks.account;
    }
  }
  return who;
}

export class Ctx {
  readonly cfg: Config;
  readonly profiles: Profiles;
  readonly flags: Flags;
  /** Human progress lines go to stderr in --json mode so stdout stays one JSON object. */
  readonly log: (msg: string) => void;

  constructor(flags: Flags) {
    this.flags = flags;
    this.cfg = loadConfig(flags);
    // REVIEW L2: predictable (tape-seeded) randomness must never meet mainnet, whatever the flags say.
    const tape = tapeStatus();
    if (tape?.deterministic && this.cfg.network === "mainnet")
      throw new CliError("refusing: deterministic tape randomness (GHOST_TAPE_SEED) on mainnet");
    this.profiles = new Profiles(this.cfg.home);
    const quiet = !!flags.quiet;
    this.log = flags.json
      ? (m) => {
          if (!quiet) process.stderr.write(`${m}\n`);
        }
      : (m) => {
          if (!quiet) process.stdout.write(`${m}\n`);
        };
  }

  get as(): string {
    const a = this.flags.as;
    if (!a) throw new CliError("this command needs --as <profile>");
    return Profiles.checkName(a);
  }

  /** NEAR account for a profile; on testnet creates one through the faucet helper if missing. */
  async nearAccount(
    name: string,
    opts: { create?: boolean } = {},
  ): Promise<{ account: Account; creds: NearCreds }> {
    let creds = this.profiles.near(name);
    if (!creds) {
      if (!opts.create)
        throw new CliError(
          `profile "${name}" has no NEAR account: run \`ghost account create --as ${name}\``,
        );
      creds = await this.createNearAccount(name);
    }
    if (creds.network !== this.cfg.network) {
      throw new CliError(
        `profile "${name}" is a ${creds.network} account but GHOST_NETWORK=${this.cfg.network}`,
      );
    }
    return { account: makeAccount(creds.account_id, creds.secret_key, creds.network), creds };
  }

  /**
   * New testnet account for a profile. With GHOST_FUNDER_FILE (JSON {account_id, secret_key}) it is
   * created by the funder through the `testnet` registrar (`create_account`, `fundNear` NEAR, default 1);
   * otherwise through the faucet helper (10 NEAR; the helper rate-limits per IP).
   */
  async createNearAccount(name: string, accountId?: string, fundNear = "1"): Promise<NearCreds> {
    if (this.cfg.network !== "testnet") {
      throw new CliError(
        "automatic account creation is testnet-only; import a mainnet account with `ghost account import`",
      );
    }
    const id = accountId ?? randomTestnetId(`gp-${name}`);
    const kp = newKeyPair();
    const funderFile = process.env.GHOST_FUNDER_FILE || process.env.DEMO_FUNDER_FILE;
    if (funderFile) {
      const f = JSON.parse(readFileSync(funderFile, "utf8")) as {
        account_id: string;
        secret_key: string;
      };
      const funder = makeAccount(f.account_id, f.secret_key, "testnet");
      const deposit = BigInt(Math.round(Number(fundNear) * 1000)) * 10n ** 21n;
      this.log(
        `  creating NEAR testnet account ${id} (${fundNear} NEAR from funder ${f.account_id})…`,
      );
      const res = await funder.callFunctionRaw({
        contractId: "testnet",
        methodName: "create_account",
        args: { new_account_id: id, new_public_key: kp.publicKey },
        deposit,
        gas: 30_000_000_000_000n,
      });
      const st = (res as { status?: { SuccessValue?: string } }).status;
      if (st?.SuccessValue !== Buffer.from("true").toString("base64")) {
        throw new CliError(
          `testnet.create_account(${id}) failed: ${JSON.stringify(st).slice(0, 200)}`,
        );
      }
    } else {
      this.log(`  creating NEAR testnet account ${id} (faucet helper, 10 NEAR)…`);
      try {
        await createFaucetAccount(id, kp);
      } catch (e) {
        const m = (e as Error).message;
        if (/429/.test(m)) {
          throw new CliError(
            `${m}\n  The testnet faucet helper rate-limits per IP. Use an existing testnet account as funder: GHOST_FUNDER_FILE (or DEMO_FUNDER_FILE)=<json {account_id, secret_key}>`,
          );
        }
        throw e;
      }
    }
    const creds: NearCreds = { account_id: id, secret_key: kp.secretKey, network: "testnet" };
    this.profiles.saveNear(name, creds);
    await waitForAccount(this.cfg.network, id);
    return creds;
  }

  private contractChecked?: Promise<void>;
  /**
   * REVIEW M2: before paying to / registering in / sweeping through the Ghost Paths contract,
   * check that it runs the pinned wasm (one free `view_account` call per process). Mode B makes
   * the contract the MPC predecessor of every stealth address, so a look-alike contract (a typo in
   * GHOST_CONTRACT, a squatted mainnet name) could spend every payment derived from it.
   */
  checkContract(): Promise<void> {
    this.contractChecked ??= verifyContractCode(this.cfg.network, this.cfg.contractId).then(
      () => undefined,
      (e) => {
        throw new CliError((e as Error).message);
      },
    );
    return this.contractChecked;
  }

  /** Registry client acting as profile `name` (or read-only when name is undefined). */
  async registry(name?: string, via?: Via): Promise<NearRegistry> {
    const account = name ? (await this.nearAccount(name)).account : undefined;
    return new NearRegistry({
      contractId: this.cfg.contractId,
      network: this.cfg.network,
      account,
      relayerUrl: this.cfg.relayerUrl,
      relayerToken: env("GHOST_RELAYER_TOKEN"),
      defaultVia: via ?? (this.cfg.relayerUrl ? "relayer" : "self"),
    });
  }

  /** --via flag → Via (default: relayer when configured). */
  via(): Via {
    const v = this.flags.via;
    if (v === "self") return "self";
    if (v === "relayer") {
      if (!this.cfg.relayerUrl)
        throw new CliError("--via relayer needs GHOST_RELAYER_URL or --relayer");
      return "relayer";
    }
    if (v) throw new CliError(`--via must be relayer|self (got "${v}")`);
    return this.cfg.relayerUrl ? "relayer" : "self";
  }
}

/** Waits until a freshly created account is visible to RPC (helper returns before finality). */
export async function waitForAccount(
  network: NearNetwork,
  accountId: string,
  timeoutMs = 20_000,
): Promise<void> {
  // Raw JSON-RPC (near-api-js logs every UNKNOWN_ACCOUNT error to stderr).
  const { RPC_URLS } = await import("@ghost-paths/sdk");
  const urls = process.env.NEAR_RPC_URL
    ? [process.env.NEAR_RPC_URL, ...RPC_URLS[network]]
    : RPC_URLS[network];
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < timeoutMs) {
    const url = urls[i++ % urls.length] as string;
    try {
      const res = await fetch(url, {
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
      const j = (await res.json()) as { result?: unknown };
      if (j.result) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new CliError(`account ${accountId} not visible after ${timeoutMs} ms`);
}

export function nearTxUrl(network: NearNetwork, hash: string): string {
  return network === "testnet"
    ? `https://testnet.nearblocks.io/txns/${hash}`
    : `https://nearblocks.io/txns/${hash}`;
}
