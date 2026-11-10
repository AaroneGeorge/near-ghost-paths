import type { ChainCfg, Config, PaymentRow } from "./types.ts";

export function short(s: string, head = 8, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export type Status = "unspent" | "swept" | "unfunded" | "unknown";

export function statusOf(p: Pick<PaymentRow, "swept" | "balance_base" | "balance_error">): Status {
  if (p.balance_error) return "unknown";
  if (p.swept) return "swept";
  return BigInt(p.balance_base || "0") > 0n ? "unspent" : "unfunded";
}

const fill = (tpl: string | null | undefined, id: string) =>
  tpl ? tpl.replace("{id}", encodeURIComponent(id)) : undefined;

export const nearTxLink = (cfg: Config, hash: string, url?: string) =>
  cfg.simulated ? undefined : url || fill(cfg.links.near_tx, hash);
export const nearAccountLink = (cfg: Config, account: string) =>
  cfg.simulated ? undefined : fill(cfg.links.near_account, account);
export const chainOf = (cfg: Config, tag: string): ChainCfg | undefined =>
  cfg.chains.find((c) => c.tag === tag);
export const chainTxLink = (cfg: Config, tag: string, hash: string, url?: string) =>
  cfg.simulated ? undefined : url || fill(chainOf(cfg, tag)?.tx_url, hash);
export const chainAddrLink = (cfg: Config, tag: string, addr: string) =>
  cfg.simulated ? undefined : fill(chainOf(cfg, tag)?.addr_url, addr);

export const FAMILY_LABEL = { evm: "ETH", btc: "BTC", sol: "SOL" } as const;

export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : String(v);
  // Memos are written by the payer: neutralise spreadsheet formula injection (OWASP CSV injection).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function paymentsCsv(rows: PaymentRow[]): string {
  const head = [
    "idx",
    "chain",
    "address",
    "path",
    "balance",
    "symbol",
    "status",
    "amount_memo",
    "asset_memo",
    "note",
    "payment_txid",
  ];
  const lines = [head.join(",")];
  // REVIEW L3: a re-posted announcement is the same payment (same chain + derived address, which
  // fixes E): list it once so totals are not double-counted. The server already dedupes.
  const seen = new Set<string>();
  for (const p of rows) {
    const key = `${p.chain}|${p.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      [
        p.idx,
        p.chain,
        p.address,
        p.path,
        p.balance,
        p.symbol,
        statusOf(p),
        p.memo?.amount,
        p.memo?.asset,
        p.memo?.note,
        p.memo?.txid,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function downloadText(
  filename: string,
  text: string,
  mime = "text/csv;charset=utf-8",
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Decimal-string subtraction a-b for display ("0.009979" - "0" → "+0.009979"). */
export function delta(after: string, before: string): string {
  const [aw = "0", af = ""] = after.split(".");
  const [bw = "0", bf = ""] = before.split(".");
  const d = Math.max(af.length, bf.length);
  const A = BigInt(aw + af.padEnd(d, "0"));
  const B = BigInt(bw + bf.padEnd(d, "0"));
  const x = A - B;
  const neg = x < 0n;
  const abs = (neg ? -x : x).toString().padStart(d + 1, "0");
  const whole = abs.slice(0, abs.length - d);
  const frac = abs.slice(abs.length - d).replace(/0+$/, "");
  return `${neg ? "-" : "+"}${whole}${frac ? `.${frac}` : ""}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function parseBundle(text: string): import("./types.ts").ViewingBundle {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error("That file is not JSON.");
  }
  const b = o as Record<string, unknown>;
  if (b.seed || b.d_spend)
    throw new Error(
      "That file contains a spend seed. Upload a viewing bundle (ghost export-viewing-key), never a keystore.",
    );
  if (
    !b ||
    b.v !== 1 ||
    typeof b.account !== "string" ||
    typeof b.view_priv !== "string" ||
    typeof b.spend_pub !== "string" ||
    typeof b.signer !== "string"
  ) {
    throw new Error(
      "Not a Ghost Paths viewing bundle (expected v, account, view_priv, spend_pub, signer).",
    );
  }
  return b as unknown as import("./types.ts").ViewingBundle;
}
