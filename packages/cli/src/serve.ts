/**
 * `ghost serve` — HTTP API for the web UI (apps/web). Owner: W4.
 *
 * The keystore never enters the browser: every operation runs here, in-process, through the same
 * command table the CLI uses (commands/index.ts), and the browser only receives public data.
 *
 * Routes (JSON; add `?stream=1` to POST routes for NDJSON progress: {"log":"…"} lines, then
 * one {"ok":true,…result} / {"ok":false,"error":…} line):
 *   GET  /api/health
 *   GET  /api/config                  mode, network, contract, chains, default profiles, link templates
 *   GET  /api/profiles                local profiles (names + NEAR account ids only)
 *   GET  /api/announcements           the public log, exactly what any observer can read
 *   GET  /api/viewing-bundle?profile= an auditor bundle (viewing key + spend PUBLIC key; cannot sweep)
 *   GET  /api/fresh-destination?chain= a throwaway destination address for a sweep
 *   POST /api/<command>               {pos?: string[], flags?: {…}}  commands: pay scan sweep meta balance quote status
 *   POST /api/scan-bundle             {bundle: ViewingBundle, full?: boolean}  auditor scan
 *   POST /api/scan-stranger           scan with a random key: finds nothing, returns the public log
 *   anything else                     static files of apps/web/dist (single-process demo), SPA fallback
 *
 * Flags: --port N (GHOST_SERVE_PORT, default 8788), --host H (default 127.0.0.1), plus the usual
 * global flags (--home, --network, --contract, --relayer …) which become defaults for every request.
 * --dev=1 or GHOST_SERVE_DEV=1: MemoryRegistry + simulated chains (serve-dev.ts), no network at all.
 *
 * Security: binds to 127.0.0.1; rejects foreign Host headers (DNS rebinding) and foreign Origins
 * (CSRF); only an allowlist of commands and flags is reachable (no --home, no file paths).
 * REVIEW M4: every POST route and GET /api/viewing-bundle need the session token (header
 * `x-ghost-token`). It is random per start and printed in the URL (`/?token=…`); the UI keeps it in
 * sessionStorage. GHOST_SERVE_TOKEN (or --token) fixes it, and is required to bind anything but
 * loopback: a Host check stops browsers, not other clients.
 * TODO(W3): add "dev" to BOOLEAN in args.ts so `--dev` works without `=1`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import {
  type Announcement,
  type ViewingBundle,
  deriveAddress,
  generateSeed,
  isChainTag,
  makeKeystore,
  networkOf,
  parseViewingBundle,
  viewingBundle,
} from "@ghost-paths/sdk";
import { chainInfo, knownChainTags } from "@ghost-paths/sdk/src/chains/index.ts";
import type { Flags } from "./args.ts";
import { COMMANDS } from "./commands/index.ts";
import { fetchAnnouncements, scanFor } from "./commands/scan.ts";
import { type Config, Ctx, Profiles } from "./context.ts";
import { jsonSafe } from "./output.ts";

// ---- Backend contract (live = CLI commands over NEAR + chains; dev = serve-dev.ts) ----------

export interface ProfileInfo {
  name: string;
  account: string | null;
  /** has a recipient keystore (can receive, scan, sweep) */
  recipient: boolean;
  /** has NEAR credentials (can announce / self-submit) */
  near: boolean;
  /** has a local payer wallet (can pay on local/test chains) */
  wallet: boolean;
}

export interface PublicAnnouncement {
  idx: number;
  chain: string;
  eph: string;
  tag: number;
  has_memo: boolean;
  ct_bytes: number;
  block_height: number;
  timestamp_ms: number;
  announcer: string;
}

export interface ScanView {
  as: string;
  account: string;
  kind: "keystore" | "viewing-key" | "stranger";
  can_sweep: boolean;
  scanned: number;
  payments: unknown[];
}

export interface Backend {
  readonly mode: "live" | "dev";
  readonly cfg: Pick<Config, "network" | "contractId" | "signerId" | "mode" | "replay"> & {
    relayer: boolean;
  };
  profiles(): Promise<ProfileInfo[]>;
  /** Runs one CLI-equivalent command; `log` receives human progress lines. */
  run(
    cmd: string,
    pos: string[],
    flags: Record<string, string>,
    log: (m: string) => void,
  ): Promise<unknown>;
  scanBundle(bundle: ViewingBundle, full: boolean): Promise<ScanView>;
  scanStranger(): Promise<ScanView>;
  announcements(): Promise<Announcement[]>;
  viewingBundle(profile: string): Promise<ViewingBundle>;
}

// ---- Shared helpers ----------------------------------------------------------------------

/** Commands the browser may run, with the flags each may carry. Everything else is refused. */
export const ALLOWED: Record<string, readonly string[]> = {
  pay: ["as", "chain", "memo", "no-view-tag", "via"],
  scan: ["as", "full", "since"],
  sweep: ["as", "to", "via", "amount", "allow-link"],
  meta: ["as"],
  balance: ["chain"],
  quote: ["chain", "amount", "to", "recipient", "confidential", "refund-to"],
  status: ["chains"],
};

export function toPublic(a: Announcement): PublicAnnouncement {
  return {
    idx: a.idx,
    chain: a.chain,
    eph: a.eph,
    tag: a.tag,
    has_memo: !!a.ct,
    ct_bytes: a.ct ? a.ct.length / 2 : 0,
    block_height: a.block_height,
    timestamp_ms: a.timestamp_ms,
    announcer: a.announcer,
  };
}

/** A syntactically valid address nobody holds a key for: a destination for demo sweeps. */
export function freshDestination(
  chain: string,
  network: "testnet" | "mainnet" = "testnet",
): string {
  if (!isChainTag(chain)) throw new Error(`bad chain "${chain}"`);
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const path = `gp1/${Buffer.from(rnd).toString("hex")}`;
  return deriveAddress("throwaway.testnet", path, chain, network).address;
}

/** Chains the UI offers: GHOST_CHAINS, else the demo defaults. */
export function offeredChains(dev: boolean): string[] {
  const env = (process.env.GHOST_CHAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = env.length
    ? env
    : dev
      ? ["evm:31337", "sol:local", "btc:regtest"]
      : ["evm:31337", "sol:local"];
  return list.filter((t) => isChainTag(t));
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string) => s.replace(ANSI, "");

// ---- Live backend -------------------------------------------------------------------------

class LiveBackend implements Backend {
  readonly mode = "live" as const;
  readonly cfg: Backend["cfg"];
  private readonly profilesDir: Profiles;

  constructor(private readonly base: Flags) {
    const probe = new Ctx({ ...base, json: "1", quiet: "1" });
    this.cfg = {
      network: probe.cfg.network,
      contractId: probe.cfg.contractId,
      signerId: probe.cfg.signerId,
      mode: probe.cfg.mode,
      replay: probe.cfg.replay,
      relayer: !!probe.cfg.relayerUrl,
    };
    this.profilesDir = probe.profiles;
  }

  private ctx(flags: Record<string, string>, log: (m: string) => void): Ctx {
    // Request flags are already allowlisted; --home/--network/--contract/--relayer only come from the server's own argv.
    const ctx = new Ctx({ ...this.base, ...flags, json: "1", quiet: "1" });
    (ctx as { log: (m: string) => void }).log = (m) => log(stripAnsi(m));
    return ctx;
  }

  async profiles(): Promise<ProfileInfo[]> {
    const home = this.profilesDir.home;
    if (!existsSync(home)) return [];
    const names = new Set<string>();
    for (const f of readdirSync(home)) {
      const m = /^([a-z0-9][a-z0-9_-]{0,31})(\.near|\.wallet)?\.json$/.exec(f);
      if (m?.[1] && m[1] !== "relayer") names.add(m[1]); // the relayer's NEAR account is infrastructure, not a person
    }
    const out: ProfileInfo[] = [];
    for (const name of [...names].sort()) {
      const recipient = this.profilesDir.hasKeystore(name);
      const near = existsSync(this.profilesDir.nearPath(name));
      const wallet = existsSync(this.profilesDir.walletPath(name));
      let account: string | null = null;
      try {
        // Only the account field is read out of either file; seeds and secret keys stay on disk.
        if (near)
          account =
            (
              JSON.parse(readFileSync(this.profilesDir.nearPath(name), "utf8")) as {
                account_id?: string;
              }
            ).account_id ?? null;
        if (!account && recipient)
          account =
            (
              JSON.parse(readFileSync(this.profilesDir.keystorePath(name), "utf8")) as {
                account?: string;
              }
            ).account ?? null;
      } catch {
        /* unreadable profile: listed without an account */
      }
      out.push({ name, account, recipient, near, wallet });
    }
    return out;
  }

  async run(
    cmd: string,
    pos: string[],
    flags: Record<string, string>,
    log: (m: string) => void,
  ): Promise<unknown> {
    const command = COMMANDS[cmd];
    if (!command) throw new Error(`unknown command "${cmd}"`);
    return command.run(this.ctx(flags, log), pos);
  }

  /** The recipient profile whose keystore belongs to `account` (shares its "seen funded" memory). */
  private async seenFileFor(ctx: Ctx, account: string): Promise<string | undefined> {
    for (const p of await this.profiles()) {
      if (p.recipient && p.account === account)
        return ctx.profiles.keystorePath(p.name).replace(/\.json$/, ".seen.json");
    }
    return undefined;
  }

  async scanBundle(bundle: ViewingBundle, full: boolean): Promise<ScanView> {
    const ctx = this.ctx(full ? { full: "1" } : {}, () => {});
    const { payments, scanned } = await scanFor(
      ctx,
      bundle,
      await this.seenFileFor(ctx, bundle.account),
    );
    return {
      as: `auditor of ${bundle.account}`,
      account: bundle.account,
      kind: "viewing-key",
      can_sweep: false,
      scanned,
      payments,
    };
  }

  async scanStranger(): Promise<ScanView> {
    const ctx = this.ctx({}, () => {});
    const ks = makeKeystore({
      seed: generateSeed(),
      account: "stranger.testnet",
      signer: ctx.cfg.contractId,
      network: ctx.cfg.network,
    });
    const { payments, scanned } = await scanFor(ctx, viewingBundle(ks));
    return {
      as: "a stranger",
      account: "(random key)",
      kind: "stranger",
      can_sweep: false,
      scanned,
      payments,
    };
  }

  async announcements(): Promise<Announcement[]> {
    return fetchAnnouncements(this.ctx({}, () => {}));
  }

  async viewingBundle(profile: string): Promise<ViewingBundle> {
    return viewingBundle(await this.profilesDir.keystore(Profiles.checkName(profile)));
  }
}

// ---- HTTP ----------------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const DIST = resolve(import.meta.dir, "../../../apps/web/dist");

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(jsonSafe(body))}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function staticFile(pathname: string): Response {
  if (!existsSync(DIST)) {
    return new Response(
      "apps/web is not built yet: run `bun run build` in apps/web (or use the Vite dev server on :5173)\n",
      { status: 404 },
    );
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = resolve(join(DIST, rel));
  if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // SPA fallback
  return new Response(Bun.file(file), {
    headers: {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": file.includes("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
}

const MUTATING = new Set(["pay", "sweep"]);

function checkStrings(v: unknown, what: string, max = 300): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length > max))
    throw new Error(`${what} must be an array of short strings`);
  return v as string[];
}

function cleanFlags(cmd: string, raw: unknown): Record<string, string> {
  const allowed = ALLOWED[cmd] ?? [];
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null) throw new Error("flags must be an object");
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === false) continue;
    if (!allowed.includes(k)) throw new Error(`flag --${k} is not available through the web API`);
    const s = v === true ? "1" : String(v);
    if (s.length > 300) throw new Error(`flag --${k} too long`);
    out[k] = s;
  }
  return out;
}

export interface RunningServer {
  url: string;
  /** Session token for POST routes and the viewing bundle (header `x-ghost-token`). */
  token: string;
  /** `url` + `/?token=…`: what a person opens. */
  openUrl: string;
  port: number;
  stop: () => void;
}

/** Starts the HTTP server and returns (used by `serve` and by tests; port 0 picks a free one). */
export async function startServer(flags: Flags): Promise<RunningServer> {
  const dev = flags.dev === "1" || process.env.GHOST_SERVE_DEV === "1";
  const backend: Backend = dev
    ? await (await import("./serve-dev.ts")).createDevBackend()
    : new LiveBackend(flags);
  const port = Number(flags.port ?? process.env.GHOST_SERVE_PORT ?? 8788);
  const hostname = flags.host ?? process.env.GHOST_SERVE_HOST ?? "127.0.0.1";
  const fixedToken = flags.token ?? process.env.GHOST_SERVE_TOKEN;
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  if (!loopback && !fixedToken) {
    throw new Error(
      `refusing to bind ${hostname}: ghost serve holds your keys and can pay and sweep. Set GHOST_SERVE_TOKEN (long random) to expose it beyond loopback.`,
    );
  }
  if (fixedToken !== undefined && fixedToken.length < 16)
    throw new Error("GHOST_SERVE_TOKEN must be at least 16 characters");
  const token = fixedToken ?? randomBytes(16).toString("hex");
  const tokenOk = (req: Request) => {
    const got = Buffer.from(req.headers.get("x-ghost-token") ?? "");
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const extraHosts = (process.env.GHOST_SERVE_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const okHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...extraHosts]);
  const webOrigin = process.env.GHOST_WEB_ORIGIN ?? "http://localhost:5173";
  const mutex = new Mutex();

  const configBody = async () => {
    const tags = offeredChains(dev);
    const chains = tags.map((t) => {
      const i = chainInfo(t as never);
      return {
        tag: i.tag,
        family: i.family,
        name: i.name,
        symbol: i.symbol,
        decimals: i.decimals,
        local: i.local,
        mainnet: i.mainnet,
        tx_url: i.txUrl?.("{id}") ?? null,
        addr_url: i.addressUrl?.("{id}") ?? null,
      };
    });
    const profiles = await backend.profiles();
    const pick = (want: string | undefined, pred: (p: ProfileInfo) => boolean) =>
      profiles.find((p) => p.name === want && pred(p))?.name ?? profiles.find(pred)?.name ?? null;
    const near = backend.cfg.network;
    const base = near === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io";
    return {
      ok: true,
      mode: backend.mode,
      simulated: backend.mode === "dev",
      network: near,
      contract: backend.cfg.contractId,
      signer: backend.cfg.signerId,
      ghost_mode: backend.cfg.mode,
      replay: backend.cfg.replay,
      relayer: backend.cfg.relayer,
      chains,
      known_chains: knownChainTags(),
      defaults: {
        payer: pick(process.env.GHOST_WEB_PAYER ?? "alice", (p) => p.wallet || p.near),
        recipient: pick(process.env.GHOST_WEB_RECIPIENT ?? "bob", (p) => p.recipient),
      },
      links: {
        near_tx: `${base}/txns/{id}`,
        near_account: `${base}/address/{id}`,
        contract: `${base}/address/${backend.cfg.contractId}`,
        signer: `${base}/address/${backend.cfg.signerId}`,
      },
      profiles,
    };
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
    if (!okHosts.has(host))
      return json(403, { ok: false, error: `host "${host}" not allowed (set GHOST_SERVE_HOSTS)` });
    const origin = req.headers.get("origin");
    const sameOrigin = !origin || new URL(origin).host === req.headers.get("host");
    const cors: Record<string, string> =
      origin &&
      !sameOrigin &&
      (origin === webOrigin || origin === webOrigin.replace("localhost", "127.0.0.1"))
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-headers": "content-type, x-ghost-token",
            vary: "origin",
          }
        : {};
    if (origin && !sameOrigin && !cors["access-control-allow-origin"])
      return json(403, { ok: false, error: "origin not allowed" });
    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "GET, POST" },
      });

    const { pathname } = url;
    if (!pathname.startsWith("/api/")) return staticFile(pathname);
    const route = pathname.slice(5);
    const reply = (status: number, body: unknown) => json(status, body, cors);

    try {
      if (req.method === "GET") {
        if (route === "health")
          return reply(200, { ok: true, mode: backend.mode, network: backend.cfg.network });
        if (route === "config") return reply(200, await configBody());
        if (route === "profiles")
          return reply(200, { ok: true, profiles: await backend.profiles() });
        if (route === "announcements") {
          const list = await backend.announcements();
          return reply(200, {
            ok: true,
            contract: backend.cfg.contractId,
            count: list.length,
            announcements: list.map(toPublic),
          });
        }
        if (route === "viewing-bundle") {
          if (!tokenOk(req))
            return reply(401, {
              ok: false,
              error: "missing or bad session token (open the URL ghost serve printed)",
            });
          const profile = url.searchParams.get("profile") ?? "";
          return reply(200, { ok: true, bundle: await backend.viewingBundle(profile) });
        }
        if (route === "fresh-destination") {
          const chain = url.searchParams.get("chain") ?? "";
          // REVIEW W6-H3: this address is derived from a random path that is thrown away, so
          // nobody can ever spend from it: sweeping to it burns the funds. Only offer it where
          // the funds are play money (simulated backend, or a local anvil/validator/regtest).
          if (backend.mode === "live" && !(isChainTag(chain) && chainInfo(chain).local)) {
            return reply(400, {
              ok: false,
              error: `no throwaway destination on ${chain || "this chain"}: it would be unspendable (burn). Enter a fresh address you control.`,
            });
          }
          return reply(200, {
            ok: true,
            chain,
            address: freshDestination(chain, backend.cfg.network),
          });
        }
        return reply(404, { ok: false, error: `no such route GET /api/${route}` });
      }
      if (req.method !== "POST") return reply(405, { ok: false, error: "method not allowed" });
      if (!tokenOk(req))
        return reply(401, {
          ok: false,
          error: "missing or bad session token (open the URL ghost serve printed)",
        });
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
        return reply(415, { ok: false, error: "content-type must be application/json" });
      }
      const text = await req.text();
      if (text.length > 256 * 1024) return reply(413, { ok: false, error: "body too large" });
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      const stream = url.searchParams.get("stream") === "1";

      const exec = async (log: (m: string) => void): Promise<unknown> => {
        if (route === "scan-bundle") {
          const bundle = parseViewingBundle(body.bundle);
          return backend.scanBundle(bundle, body.full === true);
        }
        if (route === "scan-stranger") {
          const [scan, list] = [await backend.scanStranger(), await backend.announcements()];
          return { ...scan, announcements: list.map(toPublic) };
        }
        if (!(route in ALLOWED))
          throw Object.assign(new Error(`no such route POST /api/${route}`), { status: 404 });
        const pos = checkStrings(body.pos, "pos");
        const flagsIn = cleanFlags(route, body.flags);
        const go = () => backend.run(route, pos, flagsIn, log);
        return MUTATING.has(route) ? mutex.run(go) : go();
      };

      if (!stream) {
        const result = await exec(() => {});
        return reply(200, { ok: true, command: route, ...(result as object) });
      }
      const enc = new TextEncoder();
      const body$ = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const line = (o: unknown) => ctrl.enqueue(enc.encode(`${JSON.stringify(jsonSafe(o))}\n`));
          try {
            const result = await exec((m) => line({ log: m }));
            line({ ok: true, command: route, ...(result as object) });
          } catch (e) {
            line({
              ok: false,
              command: route,
              error: (e as Error).message ?? String(e),
              ...((e as { result?: object }).result ?? {}),
            });
          }
          ctrl.close();
        },
      });
      return new Response(body$, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", ...cors },
      });
    } catch (e) {
      const err = e as Error & { status?: number; result?: object };
      return reply(err.status ?? 400, {
        ok: false,
        error: err.message ?? String(e),
        ...(err.result ?? {}),
      });
    }
  };

  const server = Bun.serve({ port, hostname, idleTimeout: 255, fetch: handle });
  return {
    url: `http://${hostname}:${server.port}`,
    token,
    openUrl: `http://${hostname}:${server.port}/?token=${token}`,
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}

export async function serve(flags: Flags): Promise<void> {
  const dev = flags.dev === "1" || process.env.GHOST_SERVE_DEV === "1";
  const s = await startServer(flags);
  const cfg = new Ctx({ ...flags, json: "1", quiet: "1" }).cfg;
  process.stdout.write(
    `ghost serve (${dev ? "dev: simulated chains, no network" : "live"}) on ${s.url}\n` +
      `  open ${s.openUrl}  (the token authorises pay/sweep for this session; Vite: http://localhost:5173/?token=${s.token})\n` +
      `  network ${cfg.network}, contract ${cfg.contractId}${existsSync(DIST) ? "\n  web UI: same URL (apps/web/dist)" : "\n  web UI: build it with `bun run build` in apps/web, or run Vite on :5173"}\n`,
  );
  await new Promise<void>(() => {}); // run until killed
}
