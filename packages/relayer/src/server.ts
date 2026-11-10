#!/usr/bin/env bun
/**
 * Ghost Paths relayer (W3): submits `announce` and `sweep` to the Ghost Paths contract from its
 * own NEAR account, so neither the payer's nor the recipient's account appears on NEAR.
 *
 * It cannot steal: the destination is inside the transaction the recipient's stealth key signed
 * (sweep message covers the payloads), and the contract re-checks the signature. It can only
 * censor; users can always submit themselves (`--via self`, linkable).
 *
 *   POST /announce {chain, eph, tag, ct?}                                   → {tx_hash, idx}
 *   POST /sweep    {path, domain_id, payloads, expires_block, k_pub, sig, v} → {tx_hash, signature}
 *   GET  /health                                                            → {ok, account, balance, contract, network}
 *
 * Env: GHOST_NETWORK (testnet), GHOST_CONTRACT, RELAYER_HOST (127.0.0.1), RELAYER_PORT (8787),
 *      RELAYER_KEY_FILE (JSON {account_id, secret_key}) or RELAYER_ACCOUNT_ID + RELAYER_SECRET_KEY,
 *      RELAYER_AUTO_CREATE=1 (testnet: create a faucet account into RELAYER_KEY_FILE if missing).
 * Bad requests are rejected locally (signature, path, expiry) before any gas is spent.
 *
 * Abuse limits (REVIEW M3; all optional, so `make demo` needs no configuration):
 *   RELAYER_TOKEN         shared secret; POSTs need `Authorization: Bearer <token>` (clients: GHOST_RELAYER_TOKEN)
 *   RELAYER_ALLOW_IPS     comma-separated client IPs allowed to POST (default: any)
 *   RELAYER_RATE_PER_IP   POSTs per client IP per minute (default 30)
 *   RELAYER_RATE_GLOBAL   POSTs per minute in total (default 120)
 *   RELAYER_CORS_ORIGINS  browser origins allowed (default the `ghost serve` origins on :8788). Any other
 *                         Origin is refused with 403, so a web page cannot drive a local relayer.
 * A sweep that was already submitted (same args) is answered from cache until it expires, so copying
 * a public sweep and replaying it to the relayer spends nothing.
 */
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AnnounceArgs,
  DEFAULT_GHOST_CONTRACT,
  type NearNetwork,
  NearRegistry,
  type SweepArgs,
  blockHeight,
  createFaucetAccount,
  installTape,
  makeAccount,
  newKeyPair,
  randomTestnetId,
  validateAnnounceArgs,
  verifySweepArgs,
} from "@ghost-paths/sdk";

export interface RelayerOptions {
  network: NearNetwork;
  contractId: string;
  accountId: string;
  secretKey: string;
  host?: string;
  port?: number;
  log?: (m: string) => void;
  /** Shared secret required on POSTs (Authorization: Bearer). */
  token?: string;
  /** Client IPs allowed to POST; empty/undefined = any. */
  allowIps?: string[];
  /** Browser origins allowed; any other Origin header is refused. */
  corsOrigins?: string[];
  /** POSTs per IP per minute (default 30) and in total per minute (default 120). */
  ratePerIp?: number;
  rateGlobal?: number;
}

const MAX_BODY = 64 * 1024;
const DEFAULT_CORS = ["http://127.0.0.1:8788", "http://localhost:8788"];
/** A cached sweep answer lives this long (the default sweep TTL is 600 blocks, about 10 minutes). */
const SWEEP_CACHE_MS = 20 * 60_000;

/** Fixed one-minute windows: a per-key counter and a global one. */
export class RateLimiter {
  private readonly perKey = new Map<string, { t: number; n: number }>();
  private global = { t: 0, n: 0 };
  constructor(
    private readonly perMin: number,
    private readonly globalPerMin: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const w = Math.floor(now / 60_000);
    if (this.global.t !== w) this.global = { t: w, n: 0 };
    let k = this.perKey.get(key);
    if (!k || k.t !== w) {
      if (this.perKey.size > 10_000) this.perKey.clear();
      k = { t: w, n: 0 };
      this.perKey.set(key, k);
    }
    if (k.n >= this.perMin || this.global.n >= this.globalPerMin) return false;
    k.n++;
    this.global.n++;
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";

/** Serialises NEAR transactions from the relayer key (avoids nonce races). */
class Mutex {
  private p: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.p.then(f, f);
    this.p = next.catch(() => undefined);
    return next;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, "body too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "body too large");
  try {
    const j = JSON.parse(text) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error();
    return j as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

export function parseSweepBody(b: Record<string, unknown>): SweepArgs {
  const { path, domain_id, payloads, expires_block, k_pub, sig, v } = b;
  if (typeof path !== "string") throw new HttpError(400, "path");
  if (domain_id !== 0 && domain_id !== 1) throw new HttpError(400, "domain_id must be 0 or 1");
  if (!Array.isArray(payloads) || payloads.length !== 1 || typeof payloads[0] !== "string") {
    throw new HttpError(400, "payloads: exactly one hex payload (v1)");
  }
  if (typeof expires_block !== "number" || !Number.isSafeInteger(expires_block))
    throw new HttpError(400, "expires_block");
  if (typeof k_pub !== "string" || typeof sig !== "string") throw new HttpError(400, "k_pub/sig");
  if (v !== 0 && v !== 1) throw new HttpError(400, "v must be 0 or 1");
  return { path, domain_id, payloads: payloads as string[], expires_block, k_pub, sig, v };
}

export function startRelayer(o: RelayerOptions) {
  const log = o.log ?? ((m: string) => console.log(`[relayer] ${m}`));
  const account = makeAccount(o.accountId, o.secretKey, o.network);
  const registry = new NearRegistry({
    contractId: o.contractId,
    network: o.network,
    account,
    defaultVia: "self",
  });
  const mutex = new Mutex();
  const origins = new Set(o.corsOrigins ?? DEFAULT_CORS);
  const allowIps = new Set((o.allowIps ?? []).filter(Boolean));
  const limiter = new RateLimiter(o.ratePerIp ?? 30, o.rateGlobal ?? 120);
  const sweeps = new Map<string, { at: number; p: Promise<unknown> }>();

  const handle = async (req: Request, ip: string): Promise<Response> => {
    const url = new URL(req.url);
    // CORS: only the `ghost serve` origins. A foreign Origin is refused outright, because a
    // "simple" cross-site POST (text/plain) would otherwise execute without a preflight.
    const origin = req.headers.get("origin");
    if (origin && !origins.has(origin)) throw new HttpError(403, "origin not allowed");
    const cors: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, vary: "origin" }
      : {};
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "GET,POST",
          "access-control-allow-headers": "content-type,authorization",
        },
      });
    }
    if (req.method === "POST") {
      if (allowIps.size && !allowIps.has(ip)) throw new HttpError(403, "client not allowed");
      if (o.token) {
        const auth = req.headers.get("authorization") ?? "";
        if (!safeEqual(auth, `Bearer ${o.token}`)) throw new HttpError(401, "bad or missing token");
      }
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json"))
        throw new HttpError(415, "content-type must be application/json");
      if (!limiter.allow(ip)) throw new HttpError(429, "rate limit: try again in a minute");
    }
    if (req.method === "GET" && url.pathname === "/health") {
      const balance = await account.getBalance().catch(() => undefined);
      return json(
        200,
        {
          ok: true,
          account: o.accountId,
          balance: balance?.toString(),
          contract: o.contractId,
          network: o.network,
        },
        cors,
      );
    }
    if (req.method === "POST" && url.pathname === "/announce") {
      const body = await readBody(req);
      let args: AnnounceArgs;
      try {
        args = validateAnnounceArgs(body as unknown as AnnounceArgs);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const t0 = Date.now();
      const r = await mutex.run(() => registry.announce(args, "self"));
      log(`announce ${args.chain} → idx ${r.idx} tx ${r.tx_hash} (${Date.now() - t0} ms)`);
      return json(200, r, cors);
    }
    if (req.method === "POST" && url.pathname === "/sweep") {
      const args = parseSweepBody(await readBody(req));
      if (!verifySweepArgs(o.contractId, args))
        throw new HttpError(400, "sweep authorisation does not verify");
      const h = await blockHeight(o.network);
      if (args.expires_block < h)
        throw new HttpError(400, `expired: expires_block ${args.expires_block} < height ${h}`);
      // Same authorisation again (a retry, or a replay copied from the public NEAR receipt):
      // answer from cache instead of paying for another MPC signature.
      const key = JSON.stringify(args);
      const now = Date.now();
      for (const [k, v] of sweeps) if (now - v.at > SWEEP_CACHE_MS) sweeps.delete(k);
      const cached = sweeps.get(key);
      if (cached) return json(200, await cached.p, cors);
      const t0 = now;
      const p = mutex.run(() => registry.sweep(args, "self"));
      sweeps.set(key, { at: now, p });
      p.catch(() => sweeps.delete(key));
      const r = await p;
      log(
        `sweep ${args.path.slice(0, 14)}… domain ${args.domain_id} tx ${r.tx_hash} (${Date.now() - t0} ms)`,
      );
      return json(200, r, cors);
    }
    throw new HttpError(404, "not found");
  };

  const hostname = o.host ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: o.port ?? 8787,
    idleTimeout: 120, // MPC signing takes 5–30 s
    async fetch(req, srv) {
      try {
        return await handle(req, srv.requestIP(req)?.address ?? "?");
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 502;
        const msg = (e as Error)?.message ?? String(e);
        log(`${req.method} ${new URL(req.url).pathname} → ${status}: ${msg.slice(0, 200)}`);
        return json(status, { error: msg.slice(0, 500) });
      }
    },
  });
  if (!isLoopback(hostname) && !o.token && !allowIps.size)
    log(
      `warning: listening on ${hostname} with no RELAYER_TOKEN or RELAYER_ALLOW_IPS: anyone who can reach it spends this account's NEAR (rate limits apply)`,
    );
  log(
    `listening on http://${server.hostname}:${server.port} as ${o.accountId} → ${o.contractId} (${o.network})`,
  );
  return server;
}

/** Loads relayer credentials from env / key file; on testnet with RELAYER_AUTO_CREATE=1 creates one. */
export async function loadCreds(
  network: NearNetwork,
): Promise<{ accountId: string; secretKey: string }> {
  const env = process.env;
  if (env.RELAYER_ACCOUNT_ID && env.RELAYER_SECRET_KEY) {
    return { accountId: env.RELAYER_ACCOUNT_ID, secretKey: env.RELAYER_SECRET_KEY };
  }
  const file = env.RELAYER_KEY_FILE ?? ".secrets/relayer.json";
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8")) as { account_id: string; secret_key: string };
    return { accountId: j.account_id, secretKey: j.secret_key };
  }
  if (env.RELAYER_AUTO_CREATE === "1" && network === "testnet") {
    const id = randomTestnetId("gp-relayer");
    const r = await createFaucetAccount(id, newKeyPair());
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      `${JSON.stringify({ account_id: id, secret_key: r.secretKey, network })}\n`,
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    console.log(`[relayer] created testnet account ${id} (key in ${file})`);
    await new Promise((r) => setTimeout(r, 3_000)); // let the account reach finality
    return { accountId: id, secretKey: r.secretKey };
  }
  throw new Error(
    `no relayer credentials: set RELAYER_KEY_FILE (missing: ${file}) or RELAYER_ACCOUNT_ID + RELAYER_SECRET_KEY`,
  );
}

if (import.meta.main) {
  installTape();
  const network = (process.env.GHOST_NETWORK ?? "testnet") as NearNetwork;
  const contractId = process.env.GHOST_CONTRACT ?? DEFAULT_GHOST_CONTRACT[network];
  const creds = await loadCreds(network);
  startRelayer({
    network,
    contractId,
    ...creds,
    host: process.env.RELAYER_HOST,
    port: Number(process.env.RELAYER_PORT ?? 8787),
    token: process.env.RELAYER_TOKEN || undefined,
    allowIps: process.env.RELAYER_ALLOW_IPS?.split(",").map((x) => x.trim()),
    corsOrigins: process.env.RELAYER_CORS_ORIGINS?.split(",").map((x) => x.trim()),
    ratePerIp: process.env.RELAYER_RATE_PER_IP
      ? Number(process.env.RELAYER_RATE_PER_IP)
      : undefined,
    rateGlobal: process.env.RELAYER_RATE_GLOBAL
      ? Number(process.env.RELAYER_RATE_GLOBAL)
      : undefined,
  });
}
