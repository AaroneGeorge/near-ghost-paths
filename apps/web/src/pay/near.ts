/** Read-only NEAR calls from the browser: public RPC, no account, no keys. */
import { parseMeta } from "@ghost-paths/sdk/src/keys.ts";
import type { AnnounceArgs, Meta } from "@ghost-paths/sdk/src/types.ts";
import type { PayConfig } from "./config.ts";

async function rpc<T>(c: PayConfig, method: string, params: unknown): Promise<T> {
  let last = "no NEAR RPC reachable";
  for (const url of c.nearRpc) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "gp", method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      const j = (await r.json()) as { result?: T; error?: { cause?: { name?: string } } };
      if (j.result !== undefined) return j.result;
      last = JSON.stringify(j.error).slice(0, 200);
      if (j.error?.cause?.name === "UNKNOWN_ACCOUNT") break;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(last);
}

async function view<T>(c: PayConfig, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>(c, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: c.contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

/** The recipient's published meta-address, or null if they have not set up Ghost Paths. */
export async function getMeta(c: PayConfig, account: string): Promise<Meta | null> {
  const raw = await view<unknown>(c, "get_meta", { account_id: account });
  return raw == null ? null : parseMeta(raw);
}

/**
 * The contract is the MPC predecessor of every one-time address, so paying to an address derived
 * from a look-alike contract would hand the money to whoever controls that contract. Check its code.
 */
export async function checkContract(c: PayConfig): Promise<void> {
  if (!c.codeHash) return;
  const a = await rpc<{ code_hash: string }>(c, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: c.contract,
  });
  if (a.code_hash !== c.codeHash)
    throw new Error(
      `${c.contract} does not run the audited Ghost Paths code (code hash ${a.code_hash}, expected ${c.codeHash})`,
    );
}

/** Posts the announcement through the relayer: the payer needs no NEAR account. */
export async function announce(
  c: PayConfig,
  args: AnnounceArgs,
): Promise<{ tx_hash: string; idx: number }> {
  const r = await fetch(`${c.relayer.replace(/\/$/, "")}/announce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const j = (await r.json().catch(() => ({}))) as {
    tx_hash?: string;
    idx?: number;
    error?: string;
  };
  if (!r.ok || !j.tx_hash) throw new Error(j.error ?? `relayer answered HTTP ${r.status}`);
  return { tx_hash: j.tx_hash, idx: j.idx ?? -1 };
}
