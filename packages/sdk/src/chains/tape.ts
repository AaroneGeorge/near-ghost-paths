/**
 * Record/replay of every HTTP call a process makes (W3) — what makes `make demo-replay` work
 * with no network at all while still running the real code paths.
 *
 *  record: wraps globalThis.fetch; each request/response (NEAR RPC, MPC results inside NEAR
 *          tx outcomes, anvil/Solana JSON-RPC, esplora, 1Click, testnet helper) is appended
 *          to a JSONL tape.
 *  replay: serves responses from the tape. Nothing leaves the machine; a request with no
 *          recorded answer throws a TypeError ("network unreachable"), exactly like being
 *          offline, so the failure is loud.
 *
 * Determinism: with a seed, crypto.getRandomValues / randomUUID / Math.random become a
 * SHA-256 counter DRBG, so a replayed run regenerates byte-identical keys, ephemeral keys and
 * transactions, and therefore byte-identical requests. A seeded DRBG is NOT secure randomness:
 * tape mode is for demos and tests only and refuses to run against mainnet: installTape throws
 * with GHOST_NETWORK=mainnet / MAINNET_APPROVED=1, and the CLI context refuses a mainnet network
 * (e.g. --network mainnet) when `tapeStatus().deterministic`.
 *
 * Matching: key = method + URL + body with JSON-RPC `id` removed; per-key FIFO (polling replays
 * in recorded order, the last answer repeats). If the body differs (e.g. a timestamp in a 1Click
 * deadline) it falls back to the next unused entry with the same method + URL.
 *
 * Env: GHOST_TAPE=<file.jsonl>, GHOST_TAPE_MODE=record|replay, GHOST_TAPE_SEED=<string>,
 *      GHOST_TAPE_PASSTHROUGH=<comma-separated URL prefixes never taped, e.g. the relayer>.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export type TapeMode = "record" | "replay";

interface Entry {
  method: string;
  url: string;
  body: string | null;
  status?: number;
  contentType?: string;
  response?: string;
  /** set when fetch threw (network error) */
  error?: string;
}

interface State {
  mode: TapeMode;
  file: string;
  deterministic: boolean;
  requests: number;
  misses: number;
}

let state: State | null = null;

export function tapeStatus(): Readonly<State> | null {
  return state;
}

function normBody(body: string | null): string {
  if (body == null || body === "") return "";
  try {
    const j = JSON.parse(body) as unknown;
    const strip = (o: unknown): unknown => {
      if (Array.isArray(o)) return o.map(strip);
      if (o && typeof o === "object" && "jsonrpc" in (o as Record<string, unknown>)) {
        const { id: _id, ...rest } = o as Record<string, unknown>;
        return rest;
      }
      return o;
    };
    return JSON.stringify(strip(j));
  } catch {
    return body;
  }
}

function rewriteIds(response: string, reqBody: string | null): string {
  if (!reqBody) return response;
  try {
    const req = JSON.parse(reqBody) as { id?: unknown } | { id?: unknown }[];
    const res = JSON.parse(response) as { id?: unknown } | { id?: unknown }[];
    if (Array.isArray(req) && Array.isArray(res)) {
      res.forEach((r, i) => {
        if (r && typeof r === "object" && req[i]) r.id = req[i]?.id;
      });
      return JSON.stringify(res);
    }
    if (
      !Array.isArray(req) &&
      !Array.isArray(res) &&
      res &&
      typeof res === "object" &&
      "id" in res
    ) {
      res.id = req.id;
      return JSON.stringify(res);
    }
  } catch {
    /* not JSON-RPC */
  }
  return response;
}

async function describe(
  input: unknown,
  init?: RequestInit,
): Promise<{ url: string; method: string; body: string | null }> {
  if (input instanceof Request) {
    const body = init?.body ?? (input.body ? await input.clone().text() : null);
    return {
      url: input.url,
      method: (init?.method ?? input.method).toUpperCase(),
      body: bodyToString(body),
    };
  }
  return {
    url: String(input),
    method: (init?.method ?? "GET").toUpperCase(),
    body: bodyToString(init?.body ?? null),
  };
}

function bodyToString(b: unknown): string | null {
  if (b == null) return null;
  if (typeof b === "string") return b;
  if (b instanceof Uint8Array) return new TextDecoder().decode(b);
  if (b instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(b));
  return String(b);
}

/** SHA-256 counter DRBG; replaces the process's randomness sources. */
function installDeterministicRandom(seed: string): void {
  let counter = 0n;
  let pool = new Uint8Array(0);
  const key = sha256(utf8ToBytes(`ghost-paths/tape-drbg/${seed}`));
  const next = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      if (pool.length === 0) {
        const c = new Uint8Array(8);
        new DataView(c.buffer).setBigUint64(0, counter++);
        const block = new Uint8Array(40);
        block.set(key, 0);
        block.set(c, 32);
        pool = sha256(block);
      }
      const take = Math.min(pool.length, n - off);
      out.set(pool.subarray(0, take), off);
      pool = pool.subarray(take);
      off += take;
    }
    return out;
  };
  const c = globalThis.crypto as Crypto;
  const getRandomValues = <T extends ArrayBufferView | null>(arr: T): T => {
    if (!arr) return arr;
    const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    view.set(next(view.length));
    return arr;
  };
  Object.defineProperty(c, "getRandomValues", {
    value: getRandomValues,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(c, "randomUUID", {
    value: () => {
      const b = next(16);
      b[6] = ((b[6] as number) & 0x0f) | 0x40;
      b[8] = ((b[8] as number) & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
    configurable: true,
    writable: true,
  });
  Math.random = () => {
    const b = next(6);
    return (b.reduce((a, x) => a * 256 + x, 0) as number) / 2 ** 48;
  };
}

/**
 * Installs the tape for this process. Idempotent per process (second call is ignored).
 * Returns false when no tape is configured.
 */
export function installTape(
  opts: { mode?: TapeMode; file?: string; seed?: string; passthrough?: string[] } = {},
): boolean {
  if (state) return true;
  const env = process.env;
  const file = opts.file ?? env.GHOST_TAPE;
  const mode = (opts.mode ??
    env.GHOST_TAPE_MODE ??
    (env.GHOST_REPLAY === "1" ? "replay" : undefined)) as TapeMode | undefined;
  if (!file || !mode) {
    if (env.GHOST_REPLAY === "1")
      throw new Error("GHOST_REPLAY=1 needs GHOST_TAPE=<recorded tape> (use `make demo-replay`)");
    return false;
  }
  const seed = opts.seed ?? env.GHOST_TAPE_SEED;
  const passthrough =
    opts.passthrough ?? (env.GHOST_TAPE_PASSTHROUGH ?? "").split(",").filter(Boolean);
  // REVIEW L2: a seeded DRBG makes every key this process generates predictable from the seed.
  // Never allow it next to anything that can touch mainnet funds.
  if (seed && (env.GHOST_NETWORK === "mainnet" || env.MAINNET_APPROVED === "1")) {
    throw new Error(
      "refusing deterministic tape randomness (GHOST_TAPE_SEED) with GHOST_NETWORK=mainnet or MAINNET_APPROVED=1: unset GHOST_TAPE*",
    );
  }
  if (seed) installDeterministicRandom(`${seed}/${file.split("/").pop()}`);
  const st: State = { mode, file, deterministic: !!seed, requests: 0, misses: 0 };
  state = st;
  const realFetch = globalThis.fetch.bind(globalThis);
  const isPass = (url: string) => passthrough.some((p) => url.startsWith(p));

  if (mode === "record") {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, "");
    const tapedFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
      const d = await describe(input, init);
      if (isPass(d.url)) return realFetch(input as RequestInfo, init);
      st.requests++;
      let res: Response;
      try {
        res = await realFetch(input as RequestInfo, init);
      } catch (e) {
        appendFileSync(
          file,
          `${JSON.stringify({ ...d, error: String((e as Error)?.message ?? e) } satisfies Entry)}\n`,
        );
        throw e;
      }
      const text = await res.text();
      const entry: Entry = {
        ...d,
        status: res.status,
        contentType: res.headers.get("content-type") ?? undefined,
        response: text,
      };
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
      return new Response(text, { status: res.status, headers: res.headers });
    };
    globalThis.fetch = Object.assign(tapedFetch, {
      preconnect: () => {},
    }) as unknown as typeof fetch;
    return true;
  }

  // replay
  if (!existsSync(file)) throw new Error(`replay tape not found: ${file}`);
  const entries: (Entry & { used?: boolean })[] = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry);
  const byKey = new Map<string, (Entry & { used?: boolean })[]>();
  const byUrl = new Map<string, (Entry & { used?: boolean })[]>();
  for (const e of entries) {
    const k = `${e.method} ${e.url} ${normBody(e.body)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)?.push(e);
    const u = `${e.method} ${e.url}`;
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u)?.push(e);
  }
  const lastServed = new Map<string, Entry>();
  const replayFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const d = await describe(input, init);
    if (isPass(d.url)) return realFetch(input as RequestInfo, init);
    st.requests++;
    const k = `${d.method} ${d.url} ${normBody(d.body)}`;
    let e = byKey.get(k)?.find((x) => !x.used);
    if (!e) e = lastServed.get(k);
    if (!e) e = byUrl.get(`${d.method} ${d.url}`)?.find((x) => !x.used);
    if (!e) {
      st.misses++;
      if (process.env.GHOST_TAPE_DEBUG) console.error(`[tape] miss ${k.slice(0, 300)}`);
      throw new TypeError(`replay: no recorded response for ${d.method} ${d.url} (offline)`);
    }
    e.used = true;
    lastServed.set(k, e);
    if (e.error) throw new TypeError(`replay: recorded network error: ${e.error}`);
    const headers = e.contentType ? { "content-type": e.contentType } : undefined;
    return new Response(rewriteIds(e.response ?? "", d.body), { status: e.status ?? 200, headers });
  };
  globalThis.fetch = Object.assign(replayFetch, {
    preconnect: () => {},
  }) as unknown as typeof fetch;
  return true;
}
