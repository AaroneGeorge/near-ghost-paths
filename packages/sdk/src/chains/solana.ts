/**
 * Solana ChainAdapter over @solana/web3.js 1.98 (W3). MPC domain 1 (ed25519): the stealth
 * address is the base58 ed25519 key the MPC derives from (predecessor, path). The EdDSA payload
 * is the full serialized transaction message (ed25519 cannot be pre-hashed).
 *
 * No websockets: confirmation polls getSignatureStatuses, so the record/replay tape (tape.ts)
 * sees every network call.
 */
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { deriveAddress } from "../derive.ts";
import type { ChainAdapter, ChainTag, MpcSignature, NearNetwork } from "../types.ts";
import { type ChainInfo, chainInfo } from "./config.ts";
import { ed25519Bytes } from "./sig.ts";

/** Base fee per signature (lamports). */
export const SOL_FEE_PER_SIG = 5_000n;

export interface SolSweepTx {
  kind: "sol";
  /** base64 of the unsigned transaction (message + empty signature slot). */
  unsigned: string;
  from: string;
}

export interface SolanaAdapterOptions {
  nearNetwork?: NearNetwork;
  rpc?: string;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connection that always calls the *current* globalThis.fetch (so tape.ts can wrap it). */
export function makeConnection(url: string): Connection {
  return new Connection(url, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    // biome-ignore lint/suspicious/noExplicitAny: web3.js FetchFn typing differs per runtime
    fetch: ((input: any, init: any) => globalThis.fetch(input, init)) as any,
  });
}

export class SolanaAdapter implements ChainAdapter {
  readonly tag: ChainTag;
  readonly domainId = 1 as const;
  readonly info: ChainInfo;
  readonly connection: Connection;
  private readonly nearNetwork: NearNetwork;
  private readonly pollMs: number;

  constructor(tag: ChainTag, opts: SolanaAdapterOptions = {}) {
    this.tag = tag;
    this.info = chainInfo(tag);
    this.nearNetwork = opts.nearNetwork ?? this.info.nearNetwork;
    this.pollMs = opts.pollMs ?? (this.info.local ? 300 : 1_500);
    this.connection = makeConnection(opts.rpc ?? (this.info.rpc[0] as string));
  }

  async deriveAddress(predecessor: string, path: string) {
    const { address, publicKey } = deriveAddress(predecessor, path, this.tag, this.nearNetwork);
    return { address, publicKey };
  }

  async getBalance(address: string) {
    const lamports = await this.connection.getBalance(new PublicKey(address), "confirmed");
    return { balance: BigInt(lamports), decimals: 9 };
  }

  /** Rent-exempt minimum for a 0-data system account (a fresh destination must receive at least this). */
  async rentExemptMin(): Promise<bigint> {
    return BigInt(await this.connection.getMinimumBalanceForRentExemption(0));
  }

  /**
   * Unsigned SystemProgram.transfer from the stealth address, fee paid by the stealth address.
   * `amount` undefined = everything minus the 5000-lamport fee (closes the account).
   */
  async prepareSweep(from: string, _publicKey: string, to: string, amount?: bigint) {
    const fromKey = new PublicKey(from);
    const [{ balance }, { blockhash }] = await Promise.all([
      this.getBalance(from),
      this.connection.getLatestBlockhash("confirmed"),
    ]);
    const value = amount ?? balance - SOL_FEE_PER_SIG;
    if (value <= 0n)
      throw new Error(`${this.tag}: balance ${balance} lamports does not cover the fee`);
    if (value + SOL_FEE_PER_SIG > balance)
      throw new Error(`${this.tag}: amount + fee exceeds balance ${balance}`);
    const tx = new Transaction({ feePayer: fromKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: fromKey, toPubkey: new PublicKey(to), lamports: value }),
    );
    const message = new Uint8Array(tx.serializeMessage());
    const unsigned = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString("base64");
    const sweepTx: SolSweepTx = { kind: "sol", unsigned, from };
    return { tx: sweepTx as unknown, payloads: [message], value, fee: SOL_FEE_PER_SIG };
  }

  /** Adds the MPC EdDSA signature and verifies it against the stealth address. */
  async finalize(tx: unknown, sigs: MpcSignature[]): Promise<string> {
    const t = tx as SolSweepTx;
    const sig = sigs[0];
    if (!sig) throw new Error("sol finalize: no signature");
    const transaction = Transaction.from(Buffer.from(t.unsigned, "base64"));
    transaction.addSignature(new PublicKey(t.from), Buffer.from(ed25519Bytes(sig)));
    if (!transaction.verifySignatures()) {
      throw new Error(`sol finalize: MPC signature does not verify for ${t.from}`);
    }
    return Buffer.from(transaction.serialize()).toString("base64");
  }

  async broadcast(serialized: string): Promise<string> {
    const sig = await this.connection.sendRawTransaction(Buffer.from(serialized, "base64"), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await this.waitForSignature(sig);
    return sig;
  }

  async waitForSignature(
    sig: string,
    timeoutMs = this.info.local ? 30_000 : 90_000,
  ): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const { value } = await this.connection.getSignatureStatuses([sig]);
      const st = value[0];
      if (st?.err) throw new Error(`${this.tag}: tx ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"))
        return;
      await sleep(this.pollMs);
    }
    throw new Error(`${this.tag}: tx ${sig} not confirmed within ${timeoutMs} ms`);
  }

  /** Demo only: requestAirdrop on the local validator. */
  async fund(address: string, amount: bigint): Promise<string> {
    if (!this.info.local) {
      throw new Error(
        `${this.tag}: airdrop only on the local validator (public devnet airdrop is closed)`,
      );
    }
    const sig = await this.connection.requestAirdrop(new PublicKey(address), Number(amount));
    await this.waitForSignature(sig);
    return sig;
  }
}
