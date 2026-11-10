/**
 * Registry / announcement / sweep clients (contract ABI: PLAN §1.8, contract/ABI.md).
 *  - MemoryRegistry: in-memory fake with the contract's checks, for tests and offline demos.
 *  - NearRegistry:   near-api-js 7.4 client (views via RPC failover, calls via an Account or the relayer).
 */
import { utils as csUtils } from "chainsig.js";
import { type Account, getTransactionLastResult } from "near-api-js";
import { decodeAnnouncement, validateAnnounceArgs } from "./announce.ts";
import {
  ANNOUNCE_DEPOSIT_YOCTO,
  CALL_GAS,
  MAX_ANNOUNCEMENTS_PAGE,
  REGISTER_DEPOSIT_YOCTO,
  SIGN_DEPOSIT_YOCTO,
  SWEEP_GAS,
} from "./constants.ts";
import { parseMeta } from "./keys.ts";
import { type NearProvider, makeProvider, viewFunction } from "./near.ts";
import { verifySweepArgs } from "./stealth.ts";
import type {
  AnnounceArgs,
  AnnounceResult,
  Announcement,
  Meta,
  MpcSignature,
  NearNetwork,
  Registry,
  SweepArgs,
  SweepResult,
  Via,
} from "./types.ts";

/** Printed by callers when a sweep/announcement is submitted from the user's own account. */
export const SELF_SUBMIT_WARNING =
  "warning: submitting from your own NEAR account links this transaction to your account on NEAR";

const strip0x = (h: string): string => h.toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** 27/28 (chainsig.js toRSV, Ethereum legacy) → 0/1. */
function recoveryId(v: number): number {
  const id = v >= 27 ? v - 27 : v;
  if (id !== 0 && id !== 1) throw new Error(`bad recovery id v=${v}`);
  return id;
}

/**
 * Converts the signer's `sign` return value (or a relayer's) into MpcSignature.
 * ECDSA `v` is normalised to the recovery id 0|1 (chainsig.js's toRSV yields 27/28).
 */
export function toMpcSignature(raw: unknown): MpcSignature {
  const r = raw as Record<string, unknown>;
  if (r && typeof r === "object") {
    if (typeof r.r === "string" && typeof r.s === "string" && typeof r.v === "number") {
      return { r: strip0x(r.r), s: strip0x(r.s), v: recoveryId(r.v) };
    }
    if (
      Array.isArray(r.signature) &&
      (r.scheme === undefined || String(r.scheme).toLowerCase() === "ed25519")
    ) {
      return { scheme: "Ed25519", signature: r.signature as number[] };
    }
    if ("big_r" in r || "bigR" in r) {
      // biome-ignore lint/suspicious/noExplicitAny: chainsig.js MPCSignature union
      const rsv = csUtils.cryptography.toRSV(r as any);
      return { r: strip0x(rsv.r), s: strip0x(rsv.s), v: recoveryId(rsv.v) };
    }
  }
  throw new Error(`unrecognised MPC signature: ${JSON.stringify(raw).slice(0, 200)}`);
}

// ---- MemoryRegistry -----------------------------------------------------------

interface MemoryState {
  metas: Map<string, Meta>;
  announcements: Announcement[];
  blockHeight: number;
  txCounter: number;
}

export interface MemoryRegistryOptions {
  contractId?: string;
  /** Predecessor for register/announce calls. */
  caller?: string;
  /** Start block height (default 1000). */
  blockHeight?: number;
  /** Fake MPC: called after the contract-side checks pass. Without it `sweep` throws. */
  signer?: (args: SweepArgs) => Promise<MpcSignature>;
}

/**
 * In-memory registry with the contract's validation rules. `as(account)` returns a view sharing
 * the same state with another predecessor. Each call advances the block height by 1.
 */
export class MemoryRegistry implements Registry {
  readonly contractId: string;
  readonly caller: string;
  private readonly state: MemoryState;
  private readonly signer?: MemoryRegistryOptions["signer"];

  constructor(opts: MemoryRegistryOptions = {}, state?: MemoryState) {
    this.contractId = opts.contractId ?? "v1.ghost-paths.testnet";
    this.caller = opts.caller ?? "alice.testnet";
    this.signer = opts.signer;
    this.state = state ?? {
      metas: new Map(),
      announcements: [],
      blockHeight: opts.blockHeight ?? 1000,
      txCounter: 0,
    };
  }

  /** Same state, different predecessor. */
  as(caller: string): MemoryRegistry {
    return new MemoryRegistry(
      { contractId: this.contractId, caller, signer: this.signer },
      this.state,
    );
  }

  get blockHeight(): number {
    return this.state.blockHeight;
  }
  advance(blocks = 1): void {
    this.state.blockHeight += blocks;
  }
  private tx(): string {
    this.state.blockHeight += 1;
    this.state.txCounter += 1;
    return `memtx${this.state.txCounter.toString().padStart(6, "0")}`;
  }

  async getMeta(account: string): Promise<Meta | null> {
    return this.state.metas.get(account) ?? null;
  }
  async register(meta: Meta): Promise<{ tx_hash: string }> {
    this.state.metas.set(this.caller, parseMeta(meta));
    return { tx_hash: this.tx() };
  }
  async announce(args: AnnounceArgs, _via?: Via): Promise<AnnounceResult> {
    const a = validateAnnounceArgs(args);
    const tx_hash = this.tx();
    const idx = this.state.announcements.length;
    this.state.announcements.push({
      idx,
      ...a,
      block_height: this.state.blockHeight,
      timestamp_ms: 1_762_646_400_000 + idx * 1000,
      announcer: this.caller,
    });
    return { tx_hash, idx };
  }
  async announcementCount(): Promise<number> {
    return this.state.announcements.length;
  }
  async getAnnouncements(from: number, limit: number): Promise<Announcement[]> {
    if (limit > MAX_ANNOUNCEMENTS_PAGE) throw new Error(`limit > ${MAX_ANNOUNCEMENTS_PAGE}`);
    return this.state.announcements.slice(from, from + limit).map((a) => ({ ...a }));
  }
  async sweep(args: SweepArgs, _via?: Via): Promise<SweepResult> {
    if (this.state.blockHeight > args.expires_block) throw new Error("expired");
    if (args.payloads.length !== 1) throw new Error("v1: exactly one payload");
    if (args.domain_id === 0 && args.payloads[0]?.length !== 64)
      throw new Error("ecdsa payload must be 32 bytes");
    if (!verifySweepArgs(this.contractId, args)) throw new Error("bad sweep authorisation");
    if (!this.signer) throw new Error("MemoryRegistry: no fake signer configured");
    const signature = await this.signer(args);
    return { tx_hash: this.tx(), signature };
  }
}

// ---- NearRegistry ---------------------------------------------------------------

export interface NearRegistryOptions {
  contractId: string;
  network?: NearNetwork;
  /** Signs register/announce/sweep when submitting "self". */
  account?: Account;
  /** Relayer base URL (e.g. http://127.0.0.1:8787). */
  relayerUrl?: string;
  /** Shared secret for a relayer started with RELAYER_TOKEN (sent as `Authorization: Bearer`). */
  relayerToken?: string;
  /** Default submission route when the call doesn't specify one (default: relayer if relayerUrl, else self). */
  defaultVia?: Via;
  provider?: NearProvider;
  /** Relayer HTTP timeout (default 90 s: MPC signing takes 10–30 s). */
  timeoutMs?: number;
}

export class NearRegistry implements Registry {
  readonly contractId: string;
  readonly network: NearNetwork;
  private readonly account?: Account;
  private readonly relayerUrl?: string;
  private readonly relayerToken?: string;
  private readonly defaultVia: Via;
  private readonly provider: NearProvider;
  private readonly timeoutMs: number;

  constructor(o: NearRegistryOptions) {
    this.contractId = o.contractId;
    this.network = o.network ?? (o.contractId.endsWith(".testnet") ? "testnet" : "mainnet");
    this.account = o.account;
    this.relayerUrl = o.relayerUrl?.replace(/\/$/, "");
    this.relayerToken = o.relayerToken;
    this.defaultVia = o.defaultVia ?? (o.relayerUrl ? "relayer" : "self");
    this.provider = o.provider ?? makeProvider(this.network);
    this.timeoutMs = o.timeoutMs ?? 90_000;
  }

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return viewFunction<T>(this.network, this.contractId, method, args, this.provider);
  }

  private async call(
    methodName: string,
    args: Record<string, unknown>,
    deposit: bigint,
    gas: bigint,
  ) {
    if (!this.account)
      throw new Error(`NearRegistry.${methodName}: no NEAR account configured for self-submission`);
    const res = await this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName,
      args,
      deposit,
      gas,
    });
    return {
      tx_hash: res.transaction.hash as string,
      result: getTransactionLastResult(res) as unknown,
    };
  }

  private async relayer<T>(route: string, body: unknown): Promise<T> {
    if (!this.relayerUrl) throw new Error("NearRegistry: no relayer URL configured");
    const res = await fetch(`${this.relayerUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.relayerToken ? { authorization: `Bearer ${this.relayerToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`relayer ${route}: HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async getMeta(account: string): Promise<Meta | null> {
    const raw = await this.view<unknown>("get_meta", { account_id: account });
    return raw == null ? null : parseMeta(raw);
  }

  async register(meta: Meta): Promise<{ tx_hash: string }> {
    const m = parseMeta(meta);
    const { tx_hash } = await this.call(
      "register",
      { spend_pub: m.spend_pub, view_pub: m.view_pub, mode: m.mode },
      REGISTER_DEPOSIT_YOCTO,
      CALL_GAS,
    );
    return { tx_hash };
  }

  async announce(args: AnnounceArgs, via: Via = this.defaultVia): Promise<AnnounceResult> {
    const a = validateAnnounceArgs(args);
    if (via === "relayer") return this.relayer<AnnounceResult>("/announce", a);
    const body: Record<string, unknown> = {
      chain: a.chain,
      eph: a.eph,
      tag: a.tag,
      ct: a.ct ?? null,
    };
    const { tx_hash, result } = await this.call("announce", body, ANNOUNCE_DEPOSIT_YOCTO, CALL_GAS);
    return { tx_hash, idx: Number(result) };
  }

  async announcementCount(): Promise<number> {
    return Number(await this.view<number | string>("announcement_count"));
  }

  async getAnnouncements(from: number, limit: number): Promise<Announcement[]> {
    const raw = await this.view<Record<string, unknown>[]>("get_announcements", {
      from,
      limit: Math.min(limit, MAX_ANNOUNCEMENTS_PAGE),
    });
    return (raw ?? []).map(decodeAnnouncement);
  }

  async sweep(args: SweepArgs, via: Via = this.defaultVia): Promise<SweepResult> {
    if (!verifySweepArgs(this.contractId, args))
      throw new Error("sweep: authorisation does not verify locally");
    if (via === "relayer") {
      const r = await this.relayer<{ tx_hash: string; signature: unknown }>("/sweep", args);
      return { tx_hash: r.tx_hash, signature: toMpcSignature(r.signature) };
    }
    const deposit = SIGN_DEPOSIT_YOCTO * BigInt(args.payloads.length);
    const { tx_hash, result } = await this.call("sweep", { ...args }, deposit, SWEEP_GAS);
    return { tx_hash, signature: toMpcSignature(result) };
  }

  /** `signer_id` view: the MPC contract this Ghost Paths contract forwards to. */
  signerId(): Promise<string> {
    return this.view<string>("signer_id");
  }
}
