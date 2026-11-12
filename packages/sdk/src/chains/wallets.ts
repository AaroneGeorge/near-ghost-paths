/**
 * Payer wallets (W3): who sends the payment to a stealth address. Ghost Paths does not care how
 * the payer pays; these exist so the demo/CLI can pay end-to-end:
 *  - KeyPayer (EVM / Solana): a local private key. Used for the payer's demo key on local chains
 *    (auto-funded by anvil_setBalance / airdrop) and for FUNDER_EVM_PK / FUNDER_SOL_KEY on public
 *    testnets.
 *  - LechuPayer: the dev host's `lechu-wallet` (`sudo -n -u claude lechu-wallet send …`). Test
 *    networks send at once; mainnet needs the owner's fingerprint, and we gate it on
 *    MAINNET_APPROVED=1 before even asking.
 * Every pay() on a mainnet chain throws MainnetNotApprovedError unless MAINNET_APPROVED=1.
 */
import { spawn } from "node:child_process";
import { base58 } from "@scure/base";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainTag } from "../types.ts";
import { assertSpendAllowed, chainInfo, formatUnits } from "./config.ts";
import type { EvmAdapter } from "./evm.ts";
import type { SolanaAdapter } from "./solana.ts";

export interface PayerWallet {
  chain: ChainTag;
  /** "key" | "lechu-wallet" */
  kind: string;
  address: string;
  balance(): Promise<bigint>;
  pay(to: string, amount: bigint): Promise<{ txHash: string }>;
}

export class EvmKeyPayer implements PayerWallet {
  readonly kind = "key";
  readonly chain: ChainTag;
  readonly address: string;
  private readonly account;
  constructor(
    private readonly adapter: EvmAdapter,
    privateKeyHex: string,
  ) {
    this.chain = adapter.tag;
    const pk = (
      privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`
    ) as `0x${string}`;
    this.account = privateKeyToAccount(pk);
    this.address = this.account.address;
  }
  async balance() {
    return (await this.adapter.getBalance(this.address)).balance;
  }
  async pay(to: string, amount: bigint) {
    assertSpendAllowed(this.chain, "pay");
    const c = this.adapter.client;
    const [chainId, nonce, fees, gas] = await Promise.all([
      c.getChainId(),
      c.getTransactionCount({ address: this.address as `0x${string}`, blockTag: "pending" }),
      this.adapter.fees(),
      this.adapter.transferGas(this.address, to, amount),
    ]);
    const signed = await this.account.signTransaction({
      type: "eip1559",
      chainId,
      nonce,
      to: to as `0x${string}`,
      value: amount,
      gas,
      ...fees,
    });
    const hash = await c.sendRawTransaction({ serializedTransaction: signed });
    await this.adapter.waitForTx(hash);
    return { txHash: hash };
  }
}

/** Accepts base58 64-byte secret, a JSON byte array (solana-keygen file format), or hex. */
export function parseSolSecret(s: string): Uint8Array {
  const t = s.trim();
  if (t.startsWith("[")) return Uint8Array.from(JSON.parse(t) as number[]);
  if (/^[0-9a-fA-F]{128}$/.test(t)) return Uint8Array.from(Buffer.from(t, "hex"));
  return base58.decode(t);
}

export class SolKeyPayer implements PayerWallet {
  readonly kind = "key";
  readonly chain: ChainTag;
  readonly address: string;
  private readonly kp: Keypair;
  constructor(
    private readonly adapter: SolanaAdapter,
    secret: Uint8Array,
  ) {
    this.chain = adapter.tag;
    this.kp = secret.length === 32 ? Keypair.fromSeed(secret) : Keypair.fromSecretKey(secret);
    this.address = this.kp.publicKey.toBase58();
  }
  async balance() {
    return (await this.adapter.getBalance(this.address)).balance;
  }
  async pay(to: string, amount: bigint) {
    assertSpendAllowed(this.chain, "pay");
    const conn = this.adapter.connection;
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: this.kp.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({
        fromPubkey: this.kp.publicKey,
        toPubkey: new PublicKey(to),
        lamports: amount,
      }),
    );
    tx.sign(this.kp);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    await this.adapter.waitForSignature(sig);
    return { txHash: sig };
  }
}

/** Runs a command; resolves stdout, rejects with stderr. Secrets are never passed on argv. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `${cmd} ${args.slice(0, 4).join(" ")} exited ${code}: ${(err || out).slice(0, 400)}`,
          ),
        );
    });
  });
}

/** Command prefix for lechu-wallet: env LECHU_WALLET_CMD or `sudo -n -u claude lechu-wallet`. */
function lechuCmd(): string[] {
  const env = process.env.LECHU_WALLET_CMD;
  return env ? env.split(" ").filter(Boolean) : ["sudo", "-n", "-u", "claude", "lechu-wallet"];
}

/** Is lechu-wallet usable on this host? (dev host only) */
export async function lechuAvailable(): Promise<boolean> {
  const [cmd, ...rest] = lechuCmd();
  try {
    await run(cmd as string, [...rest, "info"], 15_000);
    return true;
  } catch {
    return false;
  }
}

export class LechuPayer implements PayerWallet {
  readonly kind = "lechu-wallet";
  readonly chain: ChainTag;
  address = "(lechu-wallet)";
  private readonly network: string;
  constructor(
    chain: ChainTag,
    private readonly adapter?: { getBalance(a: string): Promise<{ balance: bigint }> },
  ) {
    const info = chainInfo(chain);
    if (!info.lechuNetwork) throw new Error(`lechu-wallet does not serve ${chain}`);
    this.chain = chain;
    this.network = info.lechuNetwork;
  }
  async init(): Promise<this> {
    const [cmd, ...rest] = lechuCmd();
    const info = JSON.parse(await run(cmd as string, [...rest, "info"], 15_000)) as {
      networks: Record<string, { address: string }>;
    };
    const n = info.networks[this.network];
    if (!n) throw new Error(`lechu-wallet: no ${this.network} network`);
    this.address = n.address;
    return this;
  }
  async balance() {
    if (!this.adapter) return 0n;
    return (await this.adapter.getBalance(this.address)).balance;
  }
  async pay(to: string, amount: bigint) {
    assertSpendAllowed(this.chain, "pay via lechu-wallet");
    const info = chainInfo(this.chain);
    const [cmd, ...rest] = lechuCmd();
    const out = await run(
      cmd as string,
      [
        ...rest,
        "send",
        this.network,
        to,
        formatUnits(amount, info.decimals),
        "--why",
        "Ghost Paths demo payment",
      ],
      info.mainnet ? 35 * 60_000 : 180_000,
    );
    const txHash = extractTxHash(out, info.family);
    if (!txHash)
      throw new Error(`lechu-wallet: sent, but no tx hash in output: ${out.slice(0, 300)}`);
    return { txHash };
  }
}

/** Pulls a tx hash out of lechu-wallet output (JSON field or the first hash-looking token). */
export function extractTxHash(out: string, family: string): string | undefined {
  try {
    const j = JSON.parse(out) as Record<string, unknown>;
    for (const k of ["tx_hash", "txHash", "hash", "signature", "txid", "tx"]) {
      if (typeof j[k] === "string") return j[k] as string;
    }
  } catch {
    /* not JSON */
  }
  if (family === "evm") return out.match(/0x[0-9a-fA-F]{64}/)?.[0];
  return out.match(/[1-9A-HJ-NP-Za-km-z]{86,90}/)?.[0];
}
