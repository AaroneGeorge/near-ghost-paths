/** scan: find payments for a profile (keystore) or an auditor (viewing-key bundle). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Announcement,
  type ChainTag,
  type Payment,
  type ScanHit,
  type ViewingBundle,
  parseViewingBundle,
  scanAnnouncements,
  toPayments,
  viewingBundle,
} from "@ghost-paths/sdk";
import { chainInfo, formatUnits, getAdapter } from "@ghost-paths/sdk/src/chains/index.ts";
import { CliError, type Ctx } from "../context.ts";
import { c, short, table } from "../output.ts";
import type { Command } from "./types.ts";

export interface ScanRow {
  idx: number;
  chain: ChainTag;
  address: string;
  path: string;
  balance: string;
  balance_base: bigint;
  symbol: string;
  memo?: Payment["memo"];
  swept: boolean;
  /** chain RPC unreachable: balance unknown */
  balance_error?: string;
}

export interface ScanResult {
  as: string;
  account: string;
  kind: "keystore" | "viewing-key";
  can_sweep: boolean;
  scanned: number;
  payments: ScanRow[];
}

/** All announcements (paginated view calls; no indexer). */
export async function fetchAnnouncements(ctx: Ctx, from = 0): Promise<Announcement[]> {
  const reg = await ctx.registry();
  const out: Announcement[] = [];
  let cursor = from;
  for (;;) {
    const page = await reg.getAnnouncements(cursor, 200);
    out.push(...page);
    if (page.length < 200) break;
    cursor = (page[page.length - 1] as Announcement).idx + 1;
  }
  return out;
}

async function loadBundle(
  ctx: Ctx,
): Promise<{ bundle: ViewingBundle; kind: ScanResult["kind"]; label: string }> {
  const vk = ctx.flags["viewing-key"];
  if (vk) {
    if (!existsSync(vk)) throw new CliError(`viewing-key file not found: ${vk}`);
    return {
      bundle: parseViewingBundle(JSON.parse(readFileSync(vk, "utf8"))),
      kind: "viewing-key",
      label: `auditor (${vk})`,
    };
  }
  const name = ctx.as;
  return {
    bundle: viewingBundle(await ctx.profiles.keystore(name)),
    kind: "keystore",
    label: name,
  };
}

/** chainInfo() without throwing (a hit may name a chain this host has no RPC for). */
function decimalsOf(chain: ChainTag): number {
  try {
    return chainInfo(chain).decimals;
  } catch {
    return chain.startsWith("sol:") ? 9 : chain.startsWith("btc:") ? 8 : 18;
  }
}
function symbolOf(chain: ChainTag): string {
  try {
    return chainInfo(chain).symbol;
  } catch {
    return "?";
  }
}

export async function scanFor(
  ctx: Ctx,
  bundle: ViewingBundle,
  seenFile?: string,
): Promise<{ hits: ScanHit[]; payments: ScanRow[]; scanned: number }> {
  const list = await fetchAnnouncements(ctx, Number(ctx.flags.since ?? 0));
  const hits = scanAnnouncements(list, bundle, { full: !!ctx.flags.full });
  const seen = new Set<number>(
    seenFile && existsSync(seenFile)
      ? (JSON.parse(readFileSync(seenFile, "utf8")) as number[])
      : [],
  );
  const errors = new Map<number, string>();
  const payments = await toPayments(
    hits,
    (chain) => {
      // REVIEW W6-H2: anyone can post an announcement *to* a recipient (P_view is public) on a chain
      // tag this host has no adapter/RPC for (e.g. evm:424242). getAdapter/chainInfo throw for it,
      // and that used to reject the whole scan, permanently (the log is append-only). Keep such a
      // hit as a row with a balance error instead.
      let a: ReturnType<typeof getAdapter> | undefined;
      let setupError: unknown;
      try {
        a = getAdapter(chain, { nearNetwork: ctx.cfg.network });
      } catch (e) {
        setupError = e;
      }
      return {
        getBalance: async (addr: string) => {
          try {
            if (!a) throw setupError;
            return await a.getBalance(addr);
          } catch (e) {
            const h = hits.find((x) => x.address === addr);
            if (h) errors.set(h.idx, String((e as Error)?.message ?? e).slice(0, 120));
            return { balance: 0n, decimals: decimalsOf(chain) };
          }
        },
      };
    },
    { seen },
  );
  for (const p of payments) if (p.balance > 0n) seen.add(p.idx);
  if (seenFile)
    writeFileSync(seenFile, JSON.stringify([...seen].sort((a, b) => a - b)), { mode: 0o600 });
  const rows = payments.map(
    (p): ScanRow => ({
      idx: p.idx,
      chain: p.chain,
      address: p.address,
      path: p.path,
      balance: formatUnits(p.balance, p.decimals),
      balance_base: p.balance,
      symbol: symbolOf(p.chain),
      memo: p.memo,
      swept: p.swept && !errors.has(p.idx),
      balance_error: errors.get(p.idx),
    }),
  );
  return { hits, payments: rows, scanned: list.length };
}

export const scan: Command<ScanResult> = {
  name: "scan",
  summary: "find your payments (or an auditor's view with --viewing-key)",
  usage: "ghost scan --as NAME | --viewing-key FILE [--since IDX] [--full]",
  async run(ctx) {
    const { bundle, kind, label } = await loadBundle(ctx);
    const seenFile =
      kind === "keystore"
        ? ctx.profiles.keystorePath(label).replace(/\.json$/, ".seen.json")
        : undefined;
    const { payments, scanned } = await scanFor(ctx, bundle, seenFile);
    return {
      as: label,
      account: bundle.account,
      kind,
      can_sweep: kind === "keystore",
      scanned,
      payments,
    };
  },
  human(r) {
    const head = `${c.bold(r.as)} scanned ${r.scanned} announcement${r.scanned === 1 ? "" : "s"}: ${
      r.payments.length === 0
        ? c.yellow("0 payments")
        : c.green(`${r.payments.length} payment${r.payments.length === 1 ? "" : "s"}`)
    }`;
    const lines = [head];
    if (r.payments.length) {
      lines.push(
        table(
          ["idx", "chain", "address", "balance", "memo", "status"],
          r.payments.map((p) => [
            String(p.idx),
            p.chain,
            short(p.address, 10, 6),
            p.balance_error ? "?" : `${p.balance} ${p.symbol}`,
            p.memo?.note ?? "",
            p.balance_error
              ? "rpc down"
              : p.swept
                ? "swept"
                : p.balance_base > 0n
                  ? "unspent"
                  : "unfunded",
          ]),
        ),
      );
    }
    if (!r.can_sweep) lines.push(c.dim("  viewing key only: no spend key, cannot sweep"));
    return lines.join("\n");
  },
};
