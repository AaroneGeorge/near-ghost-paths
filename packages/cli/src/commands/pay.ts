/** pay: derive a one-time address for a registered recipient, pay it, announce on NEAR. */
import {
  type ChainTag,
  type Memo,
  SELF_SUBMIT_WARNING,
  buildAnnouncement,
  isChainTag,
  makeTarget,
  predecessorFor,
} from "@ghost-paths/sdk";
import { chainInfo, formatUnits, parseUnits } from "@ghost-paths/sdk/src/chains/index.ts";
import { CliError, type Ctx, nearTxUrl, resolveAccountId } from "../context.ts";
import { c, kv, short } from "../output.ts";
import { choosePayer, ensureLocalFunds } from "./payers.ts";
import type { Command } from "./types.ts";

export function parseChain(ctx: Ctx): ChainTag {
  const chain = ctx.flags.chain ?? process.env.GHOST_DEFAULT_CHAIN;
  if (!chain || !isChainTag(chain))
    throw new CliError(`--chain must be a chain tag like evm:31337, sol:local (got "${chain}")`);
  chainInfo(chain); // throws for unknown chains
  return chain;
}

export interface PayResult {
  payer: string;
  recipient: string;
  chain: ChainTag;
  amount: string;
  asset: string;
  predecessor: string;
  path: string;
  address: string;
  domain_id: number;
  eph: string;
  tag: number;
  pay_tx?: string;
  pay_tx_url?: string;
  payer_wallet?: string;
  announce_tx?: string;
  announce_tx_url?: string;
  idx?: number;
  announced_via?: string;
}

export const pay: Command<PayResult> = {
  name: "pay",
  summary: "pay a NEAR account at a fresh stealth address on BTC/EVM/Solana and announce it",
  usage:
    "ghost pay RECIPIENT AMOUNT [ASSET] --chain TAG --as PAYER [--memo TEXT] [--no-view-tag] [--from key|env|lechu]\n            [--via relayer|self] [--no-pay] [--no-announce]",
  async run(ctx, pos) {
    const [who, amountStr, assetArg] = pos;
    if (!who || !amountStr)
      throw new CliError("usage: ghost pay RECIPIENT AMOUNT [ASSET] --chain TAG --as PAYER");
    const payerName = ctx.as;
    const chain = parseChain(ctx);
    const info = chainInfo(chain);
    if (info.nearNetwork !== ctx.cfg.network) {
      throw new CliError(
        `${chain} pairs with NEAR ${info.nearNetwork}, but GHOST_NETWORK=${ctx.cfg.network}`,
      );
    }
    const asset = (assetArg ?? info.symbol).toUpperCase();
    if (asset !== info.symbol)
      throw new CliError(`only the native asset (${info.symbol}) is supported on ${chain} in v1`);
    const amount = parseUnits(amountStr, info.decimals);

    const recipient = resolveAccountId(ctx.profiles, who);
    await ctx.checkContract(); // REVIEW M2: the meta and the predecessor come from this contract
    const reg = await ctx.registry(ctx.profiles.near(payerName) ? payerName : undefined);
    const meta = await reg.getMeta(recipient);
    if (!meta)
      throw new CliError(`${recipient} has no Ghost Paths meta-address in ${ctx.cfg.contractId}`);

    const predecessor = predecessorFor(meta.mode, ctx.cfg.contractId, recipient);
    const { target, S } = makeTarget(meta, chain, predecessor, {
      network: ctx.cfg.network,
      noViewTag: !!ctx.flags["no-view-tag"],
    });
    if (ctx.flags["no-view-tag"] && !ctx.flags.memo) ctx.flags.memo = "(no view tag)"; // full-scan needs a memo
    ctx.log(`  one-time address ${c.cyan(target.address)} on ${info.name}`);
    ctx.log(
      c.dim(
        `    = MPC-derive(predecessor ${predecessor}, path ${short(target.path, 14, 6)}, domain ${target.domainId})`,
      ),
    );

    const out: PayResult = {
      payer: payerName,
      recipient,
      chain,
      amount: formatUnits(amount, info.decimals),
      asset,
      predecessor,
      path: target.path,
      address: target.address,
      domain_id: target.domainId,
      eph: target.eph,
      tag: target.tag,
    };

    let txid: string | undefined;
    if (!ctx.flags["no-pay"]) {
      const wallet = await choosePayer(ctx, payerName, chain);
      await ensureLocalFunds(ctx, wallet, amount);
      ctx.log(`  paying ${out.amount} ${asset} from ${wallet.kind} ${short(wallet.address)}…`);
      const { txHash } = await wallet.pay(target.address, amount);
      txid = txHash;
      out.pay_tx = txHash;
      out.pay_tx_url = info.txUrl?.(txHash);
      out.payer_wallet = wallet.address;
    }

    if (!ctx.flags["no-announce"]) {
      const memo: Memo = {
        amount: out.amount,
        asset,
        ...(ctx.flags.memo ? { note: ctx.flags.memo } : {}),
        ...(txid ? { txid } : {}),
      };
      const args = buildAnnouncement(target, S, memo);
      const via = ctx.via();
      if (via === "self") {
        if (!ctx.profiles.near(payerName)) await ctx.nearAccount(payerName, { create: true });
        ctx.log(c.yellow(`  ${SELF_SUBMIT_WARNING}`));
      }
      const r = await (await ctx.registry(via === "self" ? payerName : undefined, via)).announce(
        args,
        via,
      );
      out.announce_tx = r.tx_hash;
      out.announce_tx_url = nearTxUrl(ctx.cfg.network, r.tx_hash);
      out.idx = r.idx;
      out.announced_via = via;
    }
    return out;
  },
  human(r) {
    return [
      c.green(`paid ${r.recipient} ${r.amount} ${r.asset} on ${r.chain}`),
      kv([
        ["stealth address", c.cyan(r.address)],
        ["derived from", `${r.predecessor} + ${r.path}`],
        ["payment tx", r.pay_tx_url ?? r.pay_tx],
        [
          "announcement",
          r.idx !== undefined
            ? `idx ${c.bold(String(r.idx))}: chain ${r.chain}, eph ${short(r.eph, 8, 4)}, tag 0x${r.tag.toString(16).padStart(2, "0")} ${c.dim("(no recipient field)")}`
            : undefined,
        ],
        [
          "NEAR tx",
          r.announce_tx_url
            ? `${r.announce_tx_url} ${c.dim(`(via ${r.announced_via})`)}`
            : undefined,
        ],
      ]),
    ].join("\n");
  },
};
