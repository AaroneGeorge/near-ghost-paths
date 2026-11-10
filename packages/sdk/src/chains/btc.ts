/**
 * Bitcoin ChainAdapter (W3): P2WPKH stealth addresses, esplora/mempool REST with failover.
 * PSBT construction and per-input BIP143 sighashes come from chainsig.js `Bitcoin`
 * (bitcoinjs-lib inside); UTXO selection, fees and broadcast are ours so a sweep spends every
 * UTXO into one output (no change back to the stealth address).
 *
 * One MPC payload per input. The Ghost Paths contract signs one payload per `sweep` call (v1),
 * so callers loop over `payloads`.
 *
 * Endpoints: mempool.emzy.de first, then blockstream.info (mempool.space is IPv6-only from the
 * dev host, PLAN F11).
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chainAdapters, contracts } from "chainsig.js";
import { MPC_CONTRACT } from "../constants.ts";
import { deriveAddress } from "../derive.ts";
import type { ChainAdapter, ChainTag, MpcSignature, NearNetwork } from "../types.ts";
import { type ChainInfo, chainInfo } from "./config.ts";
import { bytesToHexStr, ecdsaParts, hexToBytesStrict } from "./sig.ts";

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed: boolean };
}

export interface BtcSweepTx {
  kind: "btc";
  /** chainsig.js serialized { psbt hex, publicKey } */
  serialized: string;
  from: string;
  fee: number;
}

/** P2WPKH vsize estimate: 10.5 + 68·in + 31·out (rounded up). */
export function p2wpkhVsize(nIn: number, nOut: number): number {
  return Math.ceil(10.5 + 68 * nIn + 31 * nOut);
}

export class BtcAdapter implements ChainAdapter {
  readonly tag: ChainTag;
  readonly domainId = 0 as const;
  readonly info: ChainInfo;
  /** No faucet for BTC: fund testnet4 addresses from a faucet / wallet. */
  readonly fund?: (address: string, amount: bigint) => Promise<string> = undefined;
  private readonly nearNetwork: NearNetwork;
  private readonly urls: string[];
  private readonly cs: InstanceType<typeof chainAdapters.btc.Bitcoin>;

  constructor(tag: ChainTag, opts: { nearNetwork?: NearNetwork; rpc?: string[] } = {}) {
    this.tag = tag;
    this.info = chainInfo(tag);
    this.nearNetwork = opts.nearNetwork ?? this.info.nearNetwork;
    this.urls = opts.rpc ?? this.info.rpc;
    const net = tag === "btc:mainnet" ? "mainnet" : tag === "btc:regtest" ? "regtest" : "testnet";
    // The contract instance is only used by chainsig.js for derivation, which we do ourselves.
    const contract = new contracts.ChainSignatureContract({
      networkId: this.nearNetwork,
      contractId: MPC_CONTRACT[this.nearNetwork],
    });
    this.cs = new chainAdapters.btc.Bitcoin({
      network: net,
      contract,
      btcRpcAdapter: new chainAdapters.btc.BTCRpcAdapters.Mempool(this.urls[0] as string),
    });
  }

  /** GET/POST against each endpoint in turn. */
  private async req(path: string, init?: RequestInit): Promise<Response> {
    let last: unknown;
    for (const base of this.urls) {
      try {
        const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
        if (res.ok) return res;
        last = new Error(`${base}${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        if (res.status === 400) break; // bad tx: other endpoints will say the same
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  async deriveAddress(predecessor: string, path: string) {
    const { address, publicKey } = deriveAddress(predecessor, path, this.tag, this.nearNetwork);
    return { address, publicKey };
  }

  async utxos(address: string): Promise<Utxo[]> {
    return (await (await this.req(`/address/${address}/utxo`)).json()) as Utxo[];
  }

  async getBalance(address: string) {
    const j = (await (await this.req(`/address/${address}`)).json()) as {
      chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
      mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number };
    };
    const c = j.chain_stats;
    const m = j.mempool_stats ?? { funded_txo_sum: 0, spent_txo_sum: 0 };
    return {
      balance: BigInt(c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum),
      decimals: 8,
    };
  }

  /** sat/vB: mempool `/v1/fees/recommended` (halfHourFee), else esplora `/fee-estimates` (3 blocks), min 1. */
  async feeRate(): Promise<number> {
    try {
      const j = (await (await this.req("/v1/fees/recommended")).json()) as { halfHourFee?: number };
      if (j.halfHourFee) return Math.max(1, Math.ceil(j.halfHourFee));
    } catch {
      /* fall through */
    }
    try {
      const j = (await (await this.req("/fee-estimates")).json()) as Record<string, number>;
      return Math.max(1, Math.ceil(j["3"] ?? j["6"] ?? 1));
    } catch {
      return 2;
    }
  }

  /** Spends every UTXO of `from` into one output to `to` (amount undefined = all minus fee). */
  async prepareSweep(from: string, publicKey: string, to: string, amount?: bigint) {
    const compressed = compressPub(publicKey);
    const script = p2wpkhScript(compressed);
    const utxos = await this.utxos(from);
    if (utxos.length === 0) throw new Error(`${this.tag}: no UTXOs at ${from}`);
    const total = utxos.reduce((a, u) => a + u.value, 0);
    const rate = await this.feeRate();
    const withChange = amount !== undefined;
    const fee = rate * p2wpkhVsize(utxos.length, withChange ? 2 : 1);
    const send = amount === undefined ? total - fee : Number(amount);
    if (send <= 546) throw new Error(`${this.tag}: ${total} sat minus fee ${fee} is below dust`);
    const change = total - send - fee;
    if (change < 0) throw new Error(`${this.tag}: amount + fee exceeds ${total} sat`);
    const outputs: { address: string; value: number }[] = [{ address: to, value: send }];
    if (withChange && change > 546) outputs.push({ address: from, value: change });
    const { transaction, hashesToSign } = await this.cs.prepareTransactionForSigning({
      publicKey: compressed,
      inputs: utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        scriptPubKey: Buffer.from(script),
      })),
      outputs,
    });
    const tx: BtcSweepTx = {
      kind: "btc",
      serialized: this.cs.serializeTransaction(transaction),
      from,
      fee,
    };
    return {
      tx: tx as unknown,
      payloads: hashesToSign.map((h) => Uint8Array.from(h)),
      value: BigInt(send),
      fee: BigInt(fee),
    };
  }

  async finalize(tx: unknown, sigs: MpcSignature[]): Promise<string> {
    const t = tx as BtcSweepTx;
    const transaction = this.cs.deserializeTransaction(t.serialized);
    const rsv = sigs.map((s) => {
      const p = ecdsaParts(s);
      return { r: p.r, s: p.s, v: p.yParity + 27 };
    });
    return this.cs.finalizeTransactionSigning({ transaction, rsvSignatures: rsv });
  }

  async broadcast(serialized: string): Promise<string> {
    const res = await this.req("/tx", { method: "POST", body: serialized });
    return (await res.text()).trim();
  }
}

/** Accepts uncompressed `04…`/compressed `02|03…` hex; returns compressed hex. */
export function compressPub(pub: string): string {
  const p = secp256k1.Point.fromBytes(hexToBytesStrict(pub));
  return bytesToHexStr(p.toBytes(true));
}

/** P2WPKH scriptPubKey: OP_0 PUSH20 hash160(pubkey). */
export function p2wpkhScript(compressedPubHex: string): Uint8Array {
  const h = ripemd160(sha256(hexToBytesStrict(compressedPubHex)));
  return Uint8Array.from([0x00, 0x14, ...h]);
}
