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

/** Plain names for people who do not think in chain tags. */
export const FAMILY_NAME = { evm: "Ethereum", btc: "Bitcoin", sol: "Solana" } as const;

/** "Ethereum · local test network" style label for a chain tag. */
export function networkLabel(cfg: Config, tag: string): string {
  const c = chainOf(cfg, tag);
  if (!c) return tag;
  return c.local ? `${FAMILY_NAME[c.family]} (local test network)` : c.name;
}

/** Profile name ("bob") for a NEAR account, when this server knows it. */
export function nameOf(cfg: Config, account: string): string {
  return cfg.profiles.find((p) => p.account === account || p.name === account)?.name ?? account;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Decimal string → bigint scaled by 10^dec (display aggregation only). */
export function toUnits(s: string, dec = 18): bigint {
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w || "0") * 10n ** BigInt(dec) + BigInt(f.padEnd(dec, "0").slice(0, dec) || "0");
}
export function fromUnits(v: bigint, dec = 18): string {
  const base = 10n ** BigInt(dec);
  const frac = (v % base).toString().padStart(dec, "0").replace(/0+$/, "");
  return `${v / base}${frac ? `.${frac}` : ""}`;
}

/** Sum of available (unspent) balances per symbol, in display order. */
export function availableTotals(rows: PaymentRow[]): { symbol: string; amount: string }[] {
  const totals = new Map<string, bigint>();
  for (const p of rows) {
    if (statusOf(p) !== "unspent") continue;
    totals.set(p.symbol, (totals.get(p.symbol) ?? 0n) + toUnits(p.balance));
  }
  return [...totals].map(([symbol, v]) => ({ symbol, amount: fromUnits(v) }));
}

/** "Ethereum or Solana" / "Ethereum, Solana or Bitcoin": the chains this server actually offers. */
export function offeredNames(cfg: Config, join = "or"): string {
  const names = [...new Set(cfg.chains.map((c) => FAMILY_NAME[c.family]))];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${join} ${names[names.length - 1]}`;
}

/** Display amount: at most `max` decimals (rounded down), trailing zeros dropped. Keeps a sign. */
export function fmtAmount(s: string, max = 6): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) return s;
  const frac = (m[3] ?? "").slice(0, max).replace(/0+$/, "");
  return `${m[1]}${m[2] || "0"}${frac ? `.${frac}` : ""}`;
}
