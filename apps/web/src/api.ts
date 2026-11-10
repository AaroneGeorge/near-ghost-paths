/** Typed client for `ghost serve`. Base URL: VITE_GHOST_API (default same-origin `/api`). */
import type {
  BalanceResult,
  Config,
  MetaResult,
  PayResult,
  PublicAnnouncement,
  QuoteResult,
  ScanResult,
  SweepResult,
  ViewingBundle,
} from "./types.ts";

const BASE = (import.meta.env.VITE_GHOST_API as string | undefined)?.replace(/\/$/, "") ?? "/api";

/**
 * Session token printed by `ghost serve` (`/?token=…`). Needed for pay/sweep/scan and the viewing
 * bundle. Kept in sessionStorage and removed from the address bar so it does not end up in
 * bookmarks or history.
 */
function sessionToken(): string {
  if (typeof window === "undefined") return "";
  const u = new URL(window.location.href);
  const t = u.searchParams.get("token");
  if (t) {
    sessionStorage.setItem("ghost-token", t);
    u.searchParams.delete("token");
    window.history.replaceState(null, "", u.toString());
  }
  return sessionStorage.getItem("ghost-token") ?? "";
}
const TOKEN = sessionToken();
const authHeaders = (): Record<string, string> => (TOKEN ? { "x-ghost-token": TOKEN } : {});

export class ApiError extends Error {
  constructor(
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readJson<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`API ${res.status}: not JSON (is \`ghost serve\` running?)`);
  }
  const b = body as { ok?: boolean; error?: string };
  if (!res.ok || b.ok === false) throw new ApiError(b.error ?? `API ${res.status}`, body);
  return body as T;
}

async function get<T>(path: string): Promise<T> {
  try {
    return await readJson<T>(await fetch(`${BASE}/${path}`, { headers: authHeaders() }));
  } catch (e) {
    if (e instanceof TypeError)
      throw new ApiError(
        "Cannot reach `ghost serve`. Start it with `ghost serve` (or `ghost serve --dev=1`).",
      );
    throw e;
  }
}

/** POST with NDJSON streaming: `onLog` gets progress lines, the promise resolves with the final result object. */
async function post<T>(route: string, body: unknown, onLog?: (line: string) => void): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${route}?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "Cannot reach `ghost serve`. Start it with `ghost serve` (or `ghost serve --dev=1`).",
    );
  }
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("ndjson"))
    return readJson<T>(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let final: (T & { ok: boolean; error?: string }) | undefined;
  const take = (line: string) => {
    if (!line.trim()) return;
    const o = JSON.parse(line) as { log?: string; ok?: boolean };
    if (typeof o.log === "string") onLog?.(o.log);
    else final = o as typeof final;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      take(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  take(buf);
  if (!final) throw new ApiError("connection closed before the operation finished");
  if (final.ok === false) throw new ApiError(final.error ?? "failed", final);
  return final;
}

export const api = {
  config: () => get<Config>("config"),
  announcements: () => get<{ count: number; announcements: PublicAnnouncement[] }>("announcements"),
  viewingBundle: (profile: string) =>
    get<{ bundle: ViewingBundle }>(`viewing-bundle?profile=${encodeURIComponent(profile)}`),
  freshDestination: (chain: string) =>
    get<{ address: string }>(`fresh-destination?chain=${encodeURIComponent(chain)}`),

  meta: (account: string) => post<MetaResult>("meta", { pos: [account] }),
  balance: (chain: string, address: string) =>
    post<BalanceResult>("balance", { pos: [address], flags: { chain } }),
  pay: (
    a: {
      recipient: string;
      amount: string;
      chain: string;
      as: string;
      memo?: string;
      noViewTag?: boolean;
    },
    onLog?: (l: string) => void,
  ) =>
    post<PayResult>(
      "pay",
      {
        pos: [a.recipient, a.amount],
        flags: {
          chain: a.chain,
          as: a.as,
          memo: a.memo || undefined,
          "no-view-tag": a.noViewTag || undefined,
        },
      },
      onLog,
    ),
  scan: (as: string) => post<ScanResult>("scan", { flags: { as } }),
  scanBundle: (bundle: ViewingBundle) => post<ScanResult>("scan-bundle", { bundle }),
  scanStranger: () => post<ScanResult>("scan-stranger", {}),
  sweep: (
    a: { idx: number; to: string; as: string; via: "relayer" | "self" },
    onLog?: (l: string) => void,
  ) =>
    post<SweepResult>(
      "sweep",
      {
        pos: [String(a.idx)],
        // Choosing "Self-submit" in the UI is the explicit opt-in to the NEAR link (REVIEW L4).
        flags: { to: a.to, as: a.as, via: a.via, "allow-link": a.via === "self" || undefined },
      },
      onLog,
    ),
  quote: (a: {
    chain: string;
    amount: string;
    to: string;
    recipient: string;
    confidential: string;
  }) => post<QuoteResult>("quote", { flags: a }),
};
