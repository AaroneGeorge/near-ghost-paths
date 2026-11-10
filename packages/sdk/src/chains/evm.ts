/**
 * EVM ChainAdapter over viem (W3). One adapter instance per `evm:<chainId>` tag.
 * The sweep is a plain EIP-1559 value transfer from the stealth address A (derived by the MPC
 * from (predecessor, path)) to the destination; the MPC signs keccak256(unsigned tx).
 */
import {
  http,
  type PublicClient,
  type TransactionSerializableLegacy,
  createPublicClient,
  fallback,
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
} from "viem";
import { deriveAddress } from "../derive.ts";
import type { ChainAdapter, ChainTag, MpcSignature, NearNetwork } from "../types.ts";
import { type ChainInfo, chainInfo } from "./config.ts";
import { ecdsaParts, hexToBytesStrict } from "./sig.ts";

const TRANSFER_GAS = 21_000n;

export interface EvmSweepTx {
  kind: "evm";
  tx: TransactionSerializableLegacy;
  from: `0x${string}`;
}

export interface EvmAdapterOptions {
  /** NEAR network whose MPC root key derives the address (default: from the chain table). */
  nearNetwork?: NearNetwork;
  rpc?: string[];
  /** Receipt polling interval (ms). */
  pollMs?: number;
}

export class EvmAdapter implements ChainAdapter {
  readonly tag: ChainTag;
  readonly domainId = 0 as const;
  readonly info: ChainInfo;
  readonly client: PublicClient;
  private readonly nearNetwork: NearNetwork;
  private readonly pollMs: number;

  constructor(tag: ChainTag, opts: EvmAdapterOptions = {}) {
    this.tag = tag;
    this.info = chainInfo(tag);
    this.nearNetwork = opts.nearNetwork ?? this.info.nearNetwork;
    this.pollMs = opts.pollMs ?? (this.info.local ? 250 : 2_000);
    const urls = opts.rpc ?? this.info.rpc;
    this.client = createPublicClient({
      transport: fallback(urls.map((u) => http(u, { timeout: 20_000, retryCount: 2 }))),
      pollingInterval: this.pollMs,
    }) as PublicClient;
  }

  async deriveAddress(predecessor: string, path: string) {
    const { address, publicKey } = deriveAddress(predecessor, path, this.tag, this.nearNetwork);
    return { address, publicKey };
  }

  async getBalance(address: string) {
    const balance = await this.client.getBalance({ address: address as `0x${string}` });
    return { balance, decimals: 18 };
  }

  /** Fee parameters for one 21k-gas transfer. */
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.client.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? (await this.client.getGasPrice());
    let prio: bigint;
    try {
      prio = await this.client.estimateMaxPriorityFeePerGas();
    } catch {
      prio = 1_000_000_000n;
    }
    if (prio === 0n) prio = 1n;
    return { maxFeePerGas: base * 2n + prio, maxPriorityFeePerGas: prio };
  }

  /**
   * Unsigned transfer from the stealth address. Uses a legacy (EIP-155) gas price so the fee is
   * exactly 21000 × gasPrice and `amount` undefined sweeps the balance to exactly zero (an
   * EIP-1559 tx would leave the unused max-fee as dust at A).
   */
  async prepareSweep(from: string, _publicKey: string, to: string, amount?: bigint) {
    const fromAddr = from as `0x${string}`;
    const [chainId, nonce, gasPrice0, balance] = await Promise.all([
      this.client.getChainId(),
      this.client.getTransactionCount({ address: fromAddr, blockTag: "pending" }),
      this.client.getGasPrice(),
      this.client.getBalance({ address: fromAddr }),
    ]);
    // REVIEW L1: the RPC must not choose the chain. The derived key (hence the address) is the
    // same on every EVM chain, so a tx signed for a lying RPC's chainId is valid elsewhere.
    if (this.info.chainId !== undefined && chainId !== this.info.chainId) {
      throw new Error(`${this.tag}: RPC reports chainId ${chainId}, expected ${this.info.chainId}`);
    }
    const gasPrice = gasPrice0 + gasPrice0 / 5n + 1n; // +20% headroom for the next block's base fee
    const fee = TRANSFER_GAS * gasPrice;
    const value = amount ?? balance - fee;
    if (value <= 0n)
      throw new Error(`${this.tag}: balance ${balance} wei does not cover the fee (${fee} wei)`);
    if (value + fee > balance)
      throw new Error(`${this.tag}: amount + fee exceeds balance ${balance} wei`);
    const tx: TransactionSerializableLegacy = {
      type: "legacy",
      chainId,
      nonce,
      to: to as `0x${string}`,
      value,
      gas: TRANSFER_GAS,
      gasPrice,
    };
    const hash = keccak256(serializeTransaction(tx));
    const sweepTx: EvmSweepTx = { kind: "evm", tx, from: fromAddr };
    return { tx: sweepTx as unknown, payloads: [hexToBytesStrict(hash)], value, fee };
  }

  /** Attaches the MPC signature and checks it recovers to the stealth address. */
  async finalize(tx: unknown, sigs: MpcSignature[]): Promise<string> {
    const t = tx as EvmSweepTx;
    const sig = sigs[0];
    if (!sig) throw new Error("evm finalize: no signature");
    const { r, s, yParity } = ecdsaParts(sig);
    // EIP-155: v = chainId·2 + 35 + yParity (viem derives it from yParity + chainId).
    const serialized = serializeTransaction(t.tx, {
      r: `0x${r}`,
      s: `0x${s}`,
      yParity,
      v: BigInt(t.tx.chainId ?? 0) * 2n + 35n + BigInt(yParity),
    });
    const recovered = await recoverTransactionAddress({
      serializedTransaction: serialized as never,
    });
    if (recovered.toLowerCase() !== t.from.toLowerCase()) {
      throw new Error(`evm finalize: MPC signature recovers to ${recovered}, expected ${t.from}`);
    }
    return serialized;
  }

  /** Broadcasts and waits for the receipt (status must be success). */
  async broadcast(serialized: string): Promise<string> {
    const hash = await this.client.sendRawTransaction({
      serializedTransaction: serialized as `0x${string}`,
    });
    await this.waitForTx(hash);
    return hash;
  }

  async waitForTx(
    hash: `0x${string}`,
    timeoutMs = this.info.local ? 30_000 : 180_000,
  ): Promise<void> {
    const receipt = await this.client.waitForTransactionReceipt({
      hash,
      pollingInterval: this.pollMs,
      timeout: timeoutMs,
    });
    if (receipt.status !== "success") throw new Error(`${this.tag}: tx ${hash} reverted`);
  }

  /** Demo only: anvil_setBalance on the local chain (adds `amount` to the current balance). */
  async fund(address: string, amount: bigint): Promise<string> {
    if (!this.info.local)
      throw new Error(`${this.tag}: fund() only works on local anvil; use a payer wallet`);
    const { balance } = await this.getBalance(address);
    await this.client.request({
      method: "anvil_setBalance" as never,
      params: [address, `0x${(balance + amount).toString(16)}`] as never,
    });
    return "anvil_setBalance";
  }
}
