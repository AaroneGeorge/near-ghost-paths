/** derive, balance, fund, quote, status */
import {
  type ChainTag,
  checkRootKeys,
  isChainTag,
  makeProvider,
  viewFunction,
} from "@ghost-paths/sdk";
import {
  assertSpendAllowed,
  chainInfo,
  formatUnits,
  getAdapter,
  knownChainTags,
  parseUnits,
} from "@ghost-paths/sdk/src/chains/index.ts";
import { OneClick, sweepQuote } from "@ghost-paths/sdk/src/oneclick.ts";
import { CliError } from "../context.ts";
import { c, kv, short } from "../output.ts";
import { parseChain } from "./pay.ts";
import type { Command } from "./types.ts";

export const derive: Command = {
  name: "derive",
  summary: "address the MPC signs for, from (predecessor, path) — local, no RPC",
  usage: "ghost derive --chain TAG --path PATH [--predecessor ACCOUNT]",
  async run(ctx) {
    const chain = parseChain(ctx);
    const path = ctx.flags.path;
    if (!path) throw new CliError("--path is required");
    const predecessor = ctx.flags.predecessor ?? ctx.cfg.contractId;
    const a = getAdapter(chain, { nearNetwork: ctx.cfg.network });
    const { address, publicKey } = await a.deriveAddress(predecessor, path);
    return {
      chain,
      predecessor,
      path,
      domain_id: a.domainId,
      address,
      public_key: publicKey,
      network: ctx.cfg.network,
    };
  },
  human(r) {
    const x = r as {
      chain: string;
      predecessor: string;
      path: string;
      address: string;
      public_key: string;
    };
    return kv([
      ["chain", x.chain],
      ["predecessor", x.predecessor],
      ["path", x.path],
      ["address", c.cyan(x.address)],
      ["public key", short(x.public_key, 16, 8)],
    ]);
  },
};

export const balance: Command = {
  name: "balance",
  summary: "native balance of an address on a chain",
  usage: "ghost balance ADDRESS --chain TAG",
  async run(ctx, pos) {
    const chain = parseChain(ctx);
    const addr = pos[0];
    if (!addr) throw new CliError("usage: ghost balance ADDRESS --chain TAG");
    const { balance: b, decimals } = await getAdapter(chain, {
      nearNetwork: ctx.cfg.network,
    }).getBalance(addr);
    return {
      chain,
      address: addr,
      balance: formatUnits(b, decimals),
      balance_base: b,
      symbol: chainInfo(chain).symbol,
    };
  },
  human(r) {
    const x = r as { address: string; balance: string; symbol: string; chain: string };
    return `  ${x.address} on ${x.chain}: ${c.bold(`${x.balance} ${x.symbol}`)}`;
  },
};

export const fund: Command = {
  name: "fund",
  summary: "local chains only: mint test funds to an address (anvil_setBalance / airdrop)",
  usage: "ghost fund ADDRESS AMOUNT --chain evm:31337|sol:local",
  async run(ctx, pos) {
    const chain = parseChain(ctx);
    const [addr, amt] = pos;
    if (!addr || !amt) throw new CliError("usage: ghost fund ADDRESS AMOUNT --chain TAG");
    const info = chainInfo(chain);
    if (!info.local)
      throw new CliError(
        `${chain} is not a local chain; use a funded wallet (ghost pay … --from lechu|env)`,
      );
    const a = getAdapter(chain, { nearNetwork: ctx.cfg.network });
    const tx = await a.fund?.(addr, parseUnits(amt, info.decimals));
    return { chain, address: addr, amount: amt, tx };
  },
  human(r) {
    const x = r as { address: string; amount: string; chain: string };
    return c.green(`  funded ${x.address} with ${x.amount} on ${x.chain}`);
  },
};

export const quote: Command = {
  name: "quote",
  summary: "1Click dry quote (mainnet assets, free, nothing is sent)",
  usage:
    "ghost quote --chain TAG --amount X --to ASSET --recipient ADDR [--refund-to ADDR] [--confidential public|basic|advanced]",
  async run(ctx) {
    const chain = parseChain(ctx);
    const info = chainInfo(chain);
    const amountStr = ctx.flags.amount;
    const to = ctx.flags.to;
    const recipient = ctx.flags.recipient;
    if (!amountStr || !to || !recipient)
      throw new CliError("--amount, --to and --recipient are required");
    const refundTo = ctx.flags["refund-to"] ?? defaultRefund(chain);
    const conf = (ctx.flags.confidential ?? "public") as "public" | "basic" | "advanced";
    const q = await sweepQuote(
      {
        chain,
        amount: parseUnits(amountStr, info.decimals),
        to,
        recipient,
        refundTo,
        confidentiality: conf,
        dry: true,
      },
      new OneClick(),
    );
    return { chain, amount: amountStr, symbol: info.symbol, to, recipient, dry: true, ...q };
  },
  human(r) {
    const x = r as {
      amount: string;
      symbol: string;
      to: string;
      confidentiality: string;
      fallbackFrom?: string;
      note?: string;
      response?: {
        quote: { amountOutFormatted: string; amountOutUsd?: string; timeEstimate?: number };
      };
    };
    const q = x.response?.quote;
    return [
      `1Click dry quote: ${x.amount} ${x.symbol} → ${c.bold(`${q?.amountOutFormatted ?? "?"}`)} ${x.to}${q?.amountOutUsd ? ` (~$${Number(q.amountOutUsd).toFixed(2)})` : ""}, ~${q?.timeEstimate ?? "?"} s`,
      kv([
        [
          "confidentiality",
          x.fallbackFrom ? `${x.confidentiality} (wanted ${x.fallbackFrom})` : x.confidentiality,
        ],
        ["note", x.note],
      ]),
    ].join("\n");
  },
};

/** A syntactically valid placeholder refund address per family (dry quotes only). */
function defaultRefund(chain: ChainTag): string {
  const f = chain.slice(0, 3);
  if (f === "evm") return "0x4200000000000000000000000000000000000006";
  if (f === "sol") return "So11111111111111111111111111111111111111112";
  return "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
}

export const status: Command = {
  name: "status",
  summary: "configuration and health: MPC root keys, contract, relayer, chains",
  usage: "ghost status [--chains evm:31337,sol:local]",
  async run(ctx) {
    const cfg = ctx.cfg;
    const roots = await checkRootKeys(cfg.network).catch((e) => ({
      ok: false,
      error: String(e?.message ?? e),
      domains: [],
    }));
    let contract: Record<string, unknown> = { id: cfg.contractId };
    try {
      const p = makeProvider(cfg.network);
      const acc = (await p.viewAccount({
        accountId: cfg.contractId,
        blockQuery: { finality: "final" },
      } as never)) as {
        code_hash?: string;
      };
      contract.deployed =
        acc.code_hash !== undefined && acc.code_hash !== "11111111111111111111111111111111";
      if (contract.deployed) {
        contract.signer_id = await viewFunction<string>(
          cfg.network,
          cfg.contractId,
          "signer_id",
        ).catch(() => undefined);
        contract.announcements = await viewFunction<number>(
          cfg.network,
          cfg.contractId,
          "announcement_count",
        ).catch(() => undefined);
      }
    } catch (e) {
      contract = {
        ...contract,
        deployed: false,
        error: String((e as Error).message ?? e).slice(0, 160),
      };
    }
    let relayer: Record<string, unknown> | undefined;
    if (cfg.relayerUrl) {
      try {
        const r = await fetch(`${cfg.relayerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        relayer = {
          url: cfg.relayerUrl,
          ok: r.ok,
          ...((await r.json()) as Record<string, unknown>),
        };
      } catch (e) {
        relayer = {
          url: cfg.relayerUrl,
          ok: false,
          error: String((e as Error).message ?? e).slice(0, 120),
        };
      }
    }
    const tags = (ctx.flags.chains ?? process.env.GHOST_CHAINS ?? "").split(",").filter(Boolean);
    const chains = await Promise.all(
      tags.map(async (t) => {
        if (!isChainTag(t)) return { chain: t, ok: false, error: "bad tag" };
        try {
          const a = getAdapter(t, { nearNetwork: cfg.network });
          const probe = t.startsWith("evm")
            ? "0x0000000000000000000000000000000000000000"
            : t.startsWith("sol")
              ? "11111111111111111111111111111111"
              : "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
          await a.getBalance(probe);
          return { chain: t, ok: true, rpc: chainInfo(t).rpc[0] };
        } catch (e) {
          return {
            chain: t,
            ok: false,
            rpc: chainInfo(t as ChainTag).rpc[0],
            error: String((e as Error).message ?? e).slice(0, 120),
          };
        }
      }),
    );
    return {
      network: cfg.network,
      signer: cfg.signerId,
      mode: cfg.mode,
      home: cfg.home,
      replay: cfg.replay,
      root_keys: roots,
      contract,
      relayer,
      chains,
      known_chains: knownChainTags(),
    };
  },
  human(r) {
    const x = r as {
      network: string;
      signer: string;
      mode: string;
      root_keys: { ok: boolean; domains: { domainId: number; local: string; ok: boolean }[] };
      contract: { id: string; deployed?: boolean; signer_id?: string; announcements?: number };
      relayer?: { url: string; ok: boolean; account?: string; balance?: string };
      chains: { chain: string; ok: boolean; rpc?: string; error?: string }[];
    };
    const ok = (b: boolean | undefined) => (b ? c.green("ok") : c.red("FAIL"));
    return kv([
      ["NEAR network", x.network],
      ["MPC signer", x.signer],
      [
        "root keys",
        `${ok(x.root_keys.ok)} ${x.root_keys.ok ? `(${x.signer} public_key matches chainsig.js for domains 0 and 1)` : ""}`,
      ],
      [
        "contract",
        `${x.contract.id} ${x.contract.deployed ? `${c.green("deployed")}, signer ${x.contract.signer_id}, ${x.contract.announcements ?? "?"} announcements` : c.red("not deployed")}`,
      ],
      ["mode", x.mode === "contract" ? "contract (Mode B)" : "account (Mode A fallback)"],
      [
        "relayer",
        x.relayer
          ? `${x.relayer.url} ${ok(x.relayer.ok)} ${x.relayer.account ?? ""}`
          : "none (self-submit)",
      ],
      ...x.chains.map((ch): [string, string] => [
        ch.chain,
        `${ok(ch.ok)} ${ch.rpc ?? ""} ${ch.error ?? ""}`,
      ]),
    ]);
  },
};

export { assertSpendAllowed };
