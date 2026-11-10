/**
 * Picks the wallet that pays a stealth address (the payer side is ordinary chain usage).
 *   --from key    the profile's own payer key (created on first use; local chains auto-fund it)
 *   --from env    FUNDER_EVM_PK / FUNDER_SOL_KEY
 *   --from lechu  the dev host's lechu-wallet (sudo -n -u claude lechu-wallet)
 * Default: local chain → key; public testnet → env if set, else lechu if available, else key;
 * mainnet → env/lechu, and pay() refuses without MAINNET_APPROVED=1.
 */
import type { ChainTag } from "@ghost-paths/sdk";
import {
  type EvmAdapter,
  EvmKeyPayer,
  LechuPayer,
  type PayerWallet,
  SolKeyPayer,
  type SolanaAdapter,
  chainInfo,
  getAdapter,
  lechuAvailable,
  parseSolSecret,
} from "@ghost-paths/sdk/src/chains/index.ts";
import { CliError, type Ctx } from "../context.ts";

function profileKeyPayer(ctx: Ctx, name: string, chain: ChainTag): PayerWallet {
  const info = chainInfo(chain);
  const w = ctx.profiles.wallet(name);
  const rand = () => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return Buffer.from(b).toString("hex");
  };
  if (info.family === "evm") {
    if (!w.evm_pk) {
      w.evm_pk = rand();
      ctx.profiles.saveWallet(name, w);
    }
    return new EvmKeyPayer(
      getAdapter(chain, { nearNetwork: ctx.cfg.network }) as EvmAdapter,
      w.evm_pk,
    );
  }
  if (info.family === "sol") {
    if (!w.sol_sk) {
      w.sol_sk = rand(); // 32-byte seed
      ctx.profiles.saveWallet(name, w);
    }
    return new SolKeyPayer(
      getAdapter(chain, { nearNetwork: ctx.cfg.network }) as SolanaAdapter,
      Uint8Array.from(Buffer.from(w.sol_sk, "hex")),
    );
  }
  throw new CliError(
    `no local payer key type for ${chain}: pay the printed address from any wallet and use --no-pay`,
  );
}

function envPayer(ctx: Ctx, chain: ChainTag): PayerWallet | null {
  const info = chainInfo(chain);
  const a = getAdapter(chain, { nearNetwork: ctx.cfg.network });
  if (info.family === "evm" && process.env.FUNDER_EVM_PK)
    return new EvmKeyPayer(a as EvmAdapter, process.env.FUNDER_EVM_PK);
  if (info.family === "sol" && process.env.FUNDER_SOL_KEY) {
    return new SolKeyPayer(a as SolanaAdapter, parseSolSecret(process.env.FUNDER_SOL_KEY));
  }
  return null;
}

export async function choosePayer(ctx: Ctx, name: string, chain: ChainTag): Promise<PayerWallet> {
  const info = chainInfo(chain);
  const from = ctx.flags.from;
  if (from === "key") return profileKeyPayer(ctx, name, chain);
  if (from === "env") {
    const p = envPayer(ctx, chain);
    if (!p)
      throw new CliError(`--from env: set FUNDER_${info.family === "evm" ? "EVM_PK" : "SOL_KEY"}`);
    return p;
  }
  if (from === "lechu") return new LechuPayer(chain, getAdapter(chain)).init();
  if (from) throw new CliError(`--from must be key|env|lechu (got "${from}")`);
  if (info.local) return profileKeyPayer(ctx, name, chain);
  const e = envPayer(ctx, chain);
  if (e) return e;
  if (info.lechuNetwork && (await lechuAvailable()))
    return new LechuPayer(chain, getAdapter(chain)).init();
  return profileKeyPayer(ctx, name, chain);
}

/** Local chains: top up the payer so `amount` + fees is covered. */
export async function ensureLocalFunds(
  ctx: Ctx,
  payer: PayerWallet,
  amount: bigint,
): Promise<void> {
  const info = chainInfo(payer.chain);
  if (!info.local) return;
  const bal = await payer.balance();
  const need = amount + 10n ** BigInt(info.decimals - 2); // + 0.01 for fees
  if (bal >= need) return;
  const top = need * 2n;
  ctx.log(`  funding payer ${payer.address} on ${info.name} (local faucet)…`);
  const a = getAdapter(payer.chain, { nearNetwork: ctx.cfg.network });
  if (!a.fund) throw new CliError(`${payer.chain}: no local faucet`);
  await a.fund(payer.address, top);
}
