/**
 * sweep: move a stealth payment to a destination. Only the recipient can: it signs a sweep
 * authorisation with the per-payment key d_K = d_spend + h, the relayer (or the user) submits
 * ghost.sweep(...), the contract ecrecovers K and asks v1.signer for the MPC signature, and we
 * broadcast the signed transaction on the target chain.
 *
 * Mode A (keystore mode "account"): the recipient's own NEAR account calls v1.signer.sign
 * directly — works without the contract but links the sweep to the account (printed warning).
 *
 * --via-1click ASSET --recipient ADDR [--confidential basic]: quote a 1Click swap from the
 * stealth balance (mainnet only). Dry by default; with MAINNET_APPROVED=1 and --wet on a mainnet
 * chain the sweep pays the 1Click deposit address instead of --to.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type ChainTag,
  DEFAULT_SWEEP_TTL_BLOCKS,
  type MpcSignature,
  SELF_SUBMIT_WARNING,
  SIGN_DEPOSIT_YOCTO,
  SWEEP_GAS,
  blockHeight,
  buildSweepArgs,
  keysFromKeystore,
  scanOne,
  toMpcSignature,
  viewingBundle,
} from "@ghost-paths/sdk";
import {
  assertSpendAllowed,
  chainInfo,
  formatUnits,
  getAdapter,
  parseUnits,
} from "@ghost-paths/sdk/src/chains/index.ts";
import { OneClick, type SweepQuoteResult, sweepQuote } from "@ghost-paths/sdk/src/oneclick.ts";
import { type Account, CliError, type Ctx, nearTxUrl } from "../context.ts";
import { c, kv, short } from "../output.ts";
import type { Command } from "./types.ts";

export interface SweepResult {
  idx: number;
  chain: ChainTag;
  from: string;
  to: string;
  path: string;
  mode: "contract" | "account";
  via: string;
  amount: string;
  symbol: string;
  near_txs: { tx_hash: string; tx_url: string }[];
  mpc_ms: number[];
  chain_tx: string;
  chain_tx_url?: string;
  dest_balance_after?: string;
  oneclick?: SweepQuoteResult & { used_deposit_address?: boolean };
}

function markSeen(file: string, idx: number): void {
  const seen = new Set<number>(
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as number[]) : [],
  );
  seen.add(idx);
  writeFileSync(file, JSON.stringify([...seen].sort((a, b) => a - b)), { mode: 0o600 });
}

/** Decodes the JSON return value of a NEAR tx outcome. */
function lastResult(res: unknown): unknown {
  const st = (res as { status?: { SuccessValue?: string; Failure?: unknown } }).status;
  if (st?.Failure)
    throw new CliError(`NEAR tx failed: ${JSON.stringify(st.Failure).slice(0, 300)}`);
  if (typeof st?.SuccessValue !== "string") throw new CliError("NEAR tx returned no value");
  return JSON.parse(Buffer.from(st.SuccessValue, "base64").toString("utf8"));
}

/** Mode A: the recipient's account asks the MPC directly (public link: account ↔ path). */
async function signDirect(
  account: Account,
  signerId: string,
  path: string,
  domainId: 0 | 1,
  payload: Uint8Array,
): Promise<{ tx_hash: string; signature: MpcSignature }> {
  const hex = Buffer.from(payload).toString("hex");
  const res = await account.callFunctionRaw({
    contractId: signerId,
    methodName: "sign",
    args: {
      request: {
        payload_v2: domainId === 0 ? { Ecdsa: hex } : { Eddsa: hex },
        path,
        domain_id: domainId,
      },
    },
    deposit: SIGN_DEPOSIT_YOCTO,
    gas: SWEEP_GAS,
  });
  return {
    tx_hash: (res as { transaction: { hash: string } }).transaction.hash,
    signature: toMpcSignature(lastResult(res)),
  };
}

export const sweep: Command<SweepResult> = {
  name: "sweep",
  summary: "sweep a stealth payment to a destination (MPC-signed via the Ghost Paths contract)",
  usage:
    "ghost sweep IDX --to DEST --as NAME [--via relayer|self] [--allow-link] [--amount X] [--max-fee-pct P]\n            [--via-1click ASSET --recipient ADDR [--confidential basic|advanced|public] [--wet]]",
  async run(ctx, pos) {
    const idx = Number(pos[0]);
    if (!Number.isInteger(idx) || idx < 0)
      throw new CliError("usage: ghost sweep IDX --to DEST --as NAME");
    const name = ctx.as;
    const ks = await ctx.profiles.keystore(name);
    const keys = keysFromKeystore(ks);
    const bundle = viewingBundle(ks);
    const mode = bundle.mode ?? "contract";

    // REVIEW L4: in Mode B, submitting from your own NEAR account links you to the path forever.
    // Without a relayer that would be the silent default, so require an explicit opt-in.
    if (
      mode === "contract" &&
      ctx.via() === "self" &&
      !ctx.cfg.relayerUrl &&
      !ctx.flags["allow-link"]
    ) {
      throw new CliError(
        "no relayer configured (GHOST_RELAYER_URL): a self-submitted sweep publicly links your NEAR account to this payment. Set GHOST_RELAYER_URL, or pass --allow-link to accept the link.",
      );
    }
    await ctx.checkContract(); // REVIEW M2
    const reg = await ctx.registry();
    const [a] = await reg.getAnnouncements(idx, 1);
    if (!a || a.idx !== idx) throw new CliError(`announcement ${idx} not found`);
    const hit = scanOne(a, bundle, { full: !!ctx.flags.full });
    if (!hit) throw new CliError(`announcement ${idx} is not a payment to ${ks.account}`);
    const info = chainInfo(hit.chain);
    assertSpendAllowed(hit.chain, "sweep");
    const adapter = getAdapter(hit.chain, { nearNetwork: ctx.cfg.network });
    const predecessor = mode === "contract" ? ks.signer : ks.account;
    const { address, publicKey } = await adapter.deriveAddress(predecessor, hit.path);
    if (address !== hit.address) throw new CliError(`derived ${address} != scanned ${hit.address}`);
    const { balance } = await adapter.getBalance(address);
    if (balance === 0n)
      throw new CliError(`nothing to sweep at ${address} (balance 0; already swept?)`);

    const amount = ctx.flags.amount ? parseUnits(ctx.flags.amount, info.decimals) : undefined;
    let dest = ctx.flags.to;
    let oneclick: SweepResult["oneclick"];
    if (ctx.flags["via-1click"]) {
      const recipient = ctx.flags.recipient;
      if (!recipient)
        throw new CliError("--via-1click needs --recipient ADDR (on the destination chain)");
      const conf = (ctx.flags.confidential ?? "basic") as "public" | "basic" | "advanced";
      const wet = !!ctx.flags.wet && info.mainnet && process.env.MAINNET_APPROVED === "1";
      ctx.log(
        `  1Click ${wet ? "quote" : "dry quote"} (${conf}) ${info.symbol} → ${ctx.flags["via-1click"]}${info.mainnet ? "" : c.dim(" (1Click is mainnet-only: priced as the mainnet asset, nothing is sent)")}`,
      );
      const q = await sweepQuote(
        {
          chain: hit.chain,
          amount: amount ?? balance,
          to: ctx.flags["via-1click"],
          recipient,
          refundTo: address,
          confidentiality: conf,
          dry: !wet,
        },
        new OneClick(),
      );
      oneclick = q;
      if (q.note) ctx.log(c.yellow(`  ${q.note}`));
      const dep = q.response?.quote.depositAddress;
      if (wet && dep) {
        dest = dep;
        oneclick.used_deposit_address = true;
      } else if (!dest) {
        throw Object.assign(new CliError("dry 1Click quote only (no --to given): nothing swept"), {
          result: { oneclick: q },
        });
      }
    }
    if (!dest) throw new CliError("--to DEST is required");

    ctx.log(`  preparing ${info.name} transfer ${short(address)} → ${short(dest)}`);
    const { tx, payloads, value, fee } = await adapter.prepareSweep(
      address,
      publicKey,
      dest,
      amount,
    );
    // REVIEW L1: fees come from the chain's RPC. Show them, and refuse an outsized one before
    // anything is signed (GHOST_MAX_FEE_PCT / --max-fee-pct, default 20% of what is moved).
    if (fee !== undefined && value !== undefined) {
      const maxPct = Number(ctx.flags["max-fee-pct"] ?? process.env.GHOST_MAX_FEE_PCT ?? 20);
      ctx.log(
        `  sending ${formatUnits(value, info.decimals)} ${info.symbol}, network fee ${formatUnits(fee, info.decimals)} ${info.symbol}`,
      );
      if (!(maxPct >= 0) || fee * 10_000n > BigInt(Math.round(maxPct * 100)) * (value + fee)) {
        throw new CliError(
          `network fee ${formatUnits(fee, info.decimals)} ${info.symbol} is more than ${maxPct}% of ${formatUnits(value + fee, info.decimals)} ${info.symbol}: refusing (raise --max-fee-pct if you mean it)`,
        );
      }
    }
    const sigs: MpcSignature[] = [];
    const near_txs: SweepResult["near_txs"] = [];
    const mpc_ms: number[] = [];
    let via: string = mode === "contract" ? ctx.via() : "self (Mode A: direct v1.signer.sign)";
    for (const [i, payload] of payloads.entries()) {
      const t0 = Date.now();
      let r: { tx_hash: string; signature: MpcSignature };
      if (mode === "contract") {
        const expiresBlock =
          (await blockHeight(ctx.cfg.network)) + Number(ctx.flags.ttl ?? DEFAULT_SWEEP_TTL_BLOCKS);
        const args = buildSweepArgs({
          contractId: ks.signer,
          target: hit,
          dSpend: keys.dSpend,
          payloads: [payload],
          expiresBlock,
        });
        const v = ctx.via();
        via = v;
        if (v === "self") ctx.log(c.yellow(`  ${SELF_SUBMIT_WARNING}`));
        ctx.log(
          `  ${v === "relayer" ? "relayer submits" : "submitting"} ${ks.signer}.sweep(path ${short(hit.path, 14, 6)}, k_pub ${short(args.k_pub, 8, 4)})${payloads.length > 1 ? ` [${i + 1}/${payloads.length}]` : ""}; waiting for the MPC…`,
        );
        const sreg = await ctx.registry(v === "self" ? name : undefined, v);
        r = await sreg.sweep(args, v);
      } else {
        ctx.log(
          c.yellow(
            "  Mode A: your NEAR account calls v1.signer.sign directly; this publicly links the sweep to your account",
          ),
        );
        const { account } = await ctx.nearAccount(name);
        r = await signDirect(account, ctx.cfg.signerId, hit.path, hit.domainId, payload);
      }
      const ms = Date.now() - t0;
      mpc_ms.push(ms);
      ctx.log(
        `  MPC signature in ${(ms / 1000).toFixed(1)} s${process.env.GHOST_REPLAY === "1" ? c.dim(" (replayed)") : ""}`,
      );
      sigs.push(r.signature);
      near_txs.push({ tx_hash: r.tx_hash, tx_url: nearTxUrl(ctx.cfg.network, r.tx_hash) });
    }

    const serialized = await adapter.finalize(tx, sigs);
    const chainTx = await adapter.broadcast(serialized);
    const sent = (tx as { tx?: { value?: bigint } }).tx?.value;
    const destBal = await adapter.getBalance(dest).catch(() => undefined);
    markSeen(ctx.profiles.keystorePath(name).replace(/\.json$/, ".seen.json"), idx);
    return {
      idx,
      chain: hit.chain,
      from: address,
      to: dest,
      path: hit.path,
      mode,
      via,
      amount: formatUnits(sent ?? amount ?? balance, info.decimals),
      symbol: info.symbol,
      near_txs,
      mpc_ms,
      chain_tx: chainTx,
      chain_tx_url: info.txUrl?.(chainTx),
      dest_balance_after: destBal ? formatUnits(destBal.balance, destBal.decimals) : undefined,
      oneclick,
    };
  },
  human(r) {
    const q = r.oneclick?.response?.quote;
    return [
      c.green(`swept payment ${r.idx} on ${r.chain}`),
      kv([
        ["from (stealth)", r.from],
        ["to", r.to],
        ["NEAR tx", r.near_txs.map((t) => t.tx_url).join(", ")],
        ["MPC time", r.mpc_ms.map((m) => `${(m / 1000).toFixed(1)} s`).join(", ")],
        ["chain tx", r.chain_tx_url ?? r.chain_tx],
        [
          "destination balance",
          r.dest_balance_after ? `${r.dest_balance_after} ${r.symbol}` : undefined,
        ],
        [
          "1Click",
          q
            ? `${q.amountInFormatted} → ${q.amountOutFormatted} (${r.oneclick?.confidentiality}${r.oneclick?.fallbackFrom ? `, wanted ${r.oneclick.fallbackFrom}` : ""})`
            : undefined,
        ],
      ]),
      r.mode === "contract"
        ? c.dim(
            `  On NEAR: ${r.via === "relayer" ? "the relayer" : "you"} asked the contract to sign path ${short(r.path, 14, 6)}; nothing names the recipient.`,
          )
        : c.yellow("  Mode A: the sign call came from your account and is publicly linkable."),
    ].join("\n");
  },
};
