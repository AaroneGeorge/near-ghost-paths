/**
 * Ghost Paths SDK shared types. FROZEN 2026-11-10 09:00 UTC (PLAN.md §3).
 * After the freeze, change only by PR with the affected track's ack.
 *
 * Encoding conventions (docs/SPEC.md §1):
 *  - Every `Hex*` value is lowercase hex WITHOUT a `0x` prefix.
 *    Hex32 = 32 bytes (64 chars), Hex33 = 33 bytes (66 chars), Hex64 = 64 bytes (128 chars).
 *  - EVM addresses are the only `0x`-prefixed strings (EIP-55 checksummed).
 *  - u64 values that come from NEAR (idx, block_height, timestamp_ms) are JS numbers.
 */

/** Lowercase hex, no `0x`, any length. */
export type Hex = string;
/** 32 bytes as lowercase hex (64 chars), no `0x`. */
export type Hex32 = string;
/** 33 bytes as lowercase hex (66 chars), no `0x` (compressed secp256k1 point). */
export type Hex33 = string;
/** 64 bytes as lowercase hex (128 chars), no `0x` (uncompressed point x||y, or r||s). */
export type Hex64 = string;

export type NearNetwork = "testnet" | "mainnet";
/** MPC domain: 0 = secp256k1/ECDSA (BTC, EVM), 1 = ed25519/EdDSA (Solana). */
export type DomainId = 0 | 1;
/** contract = Mode B (predecessor is the Ghost Paths contract); account = Mode A fallback. */
export type Mode = "contract" | "account";

export type ChainTag =
  | `evm:${number}`
  | `btc:${"regtest" | "testnet4" | "mainnet"}`
  | `sol:${"local" | "devnet" | "mainnet"}`;

/** Registry entry keyed by NEAR account id. Human form: `ghost:<account>`. */
export interface Meta {
  v: 1;
  mode: Mode;
  spend_pub: Hex33;
  view_pub: Hex32;
}

/** Export for auditors: lets one scan, never sweep. */
export interface ViewingBundle {
  v: 1;
  /** NEAR account id of the recipient (the registry key). */
  account: string;
  view_priv: Hex32;
  spend_pub: Hex33;
  /** Ghost Paths contract id (the MPC predecessor in Mode B), e.g. `v1.ghost-paths.testnet`. */
  signer: string;
  /** Optional; defaults to "contract". Mode A bundles must set "account". */
  mode?: Mode;
  /** Optional; inferred from `signer` (`*.testnet` → testnet, else mainnet) when absent. */
  network?: NearNetwork;
}

/** Full recipient keystore. Never leaves the machine (stored 0600). */
export interface Keystore extends ViewingBundle {
  seed: Hex32;
}

/** Decrypted memo carried in an announcement's `ct`. All fields optional strings. */
export interface Memo {
  amount?: string;
  asset?: string;
  note?: string;
  txid?: string;
}

/** One entry of the contract's announcement log. No recipient field, ever. */
export interface Announcement {
  idx: number;
  chain: ChainTag;
  /** Ephemeral X25519 public key E. */
  eph: Hex32;
  /** View tag, 0..255. */
  tag: number;
  /** Hex of nonce(24) || XChaCha20-Poly1305 ciphertext; absent when no memo. */
  ct?: string;
  block_height: number;
  timestamp_ms: number;
  announcer: string;
}

/** Everything needed to pay (sender) or find/sweep (recipient) one stealth payment. */
export interface StealthTarget {
  chain: ChainTag;
  eph: Hex32;
  tag: number;
  /** Tweak scalar h, 0 < h < n. */
  h: bigint;
  /** Stealth authorisation key K = P_spend + h·G, 65-byte uncompressed (0x04||x||y). */
  K: Uint8Array;
  /** `gp1/` + hex(sha256(x||y)). */
  path: string;
  /** Target-chain address derived by the MPC from (predecessor, path). */
  address: string;
  domainId: DomainId;
}

export interface Payment extends StealthTarget {
  idx: number;
  balance: bigint;
  decimals: number;
  memo?: Memo;
  swept: boolean;
}

/**
 * MPC signature: ECDSA (r, s as hex32; v = recovery id 0|1, as produced by `toMpcSignature`;
 * consumers should still accept 27/28) or EdDSA (64 signature bytes).
 */
export type MpcSignature =
  | { r: Hex32; s: Hex32; v: number }
  | { scheme: "Ed25519"; signature: number[] };

/** Implemented per chain family by W3 in `src/chains/`. */
export interface ChainAdapter {
  tag: ChainTag;
  domainId: DomainId;
  deriveAddress(predecessor: string, path: string): Promise<{ address: string; publicKey: string }>;
  getBalance(address: string): Promise<{ balance: bigint; decimals: number }>;
  prepareSweep(
    from: string,
    publicKey: string,
    to: string,
    amount?: bigint,
  ): Promise<{
    tx: unknown;
    payloads: Uint8Array[];
    /** Amount the destination receives and the network fee, in base units (shown before signing). */
    value?: bigint;
    fee?: bigint;
  }>;
  finalize(tx: unknown, sigs: MpcSignature[]): Promise<string /*serialized*/>;
  broadcast(serialized: string): Promise<string /*tx hash*/>;
  /** Demo only (anvil / local validator / lechu-wallet). */
  fund?(address: string, amount: bigint): Promise<string>;
}

// ---- Contract call shapes (contract/ABI.md) ---------------------------------

/** Args of `announce` (also the relayer's POST /announce body). */
export interface AnnounceArgs {
  chain: ChainTag;
  eph: Hex32;
  tag: number;
  ct?: string;
}
export interface AnnounceResult {
  tx_hash: string;
  idx: number;
}

/** Args of the contract's `sweep` (also the relayer's POST /sweep body). */
export interface SweepArgs {
  path: string;
  domain_id: DomainId;
  /** Hex payloads: 32-byte hashes for ECDSA, message bytes for EdDSA. v1: exactly one. */
  payloads: Hex[];
  expires_block: number;
  /** Uncompressed K without the 0x04 prefix (x||y). */
  k_pub: Hex64;
  /** r||s, low-s. */
  sig: Hex64;
  /** Recovery id 0|1. */
  v: number;
}
export interface SweepResult {
  tx_hash: string;
  signature: MpcSignature;
}

/** Who submits NEAR transactions: the relayer (unlinkable) or the user's own account (links). */
export type Via = "relayer" | "self";

/** Registry/announcement/sweep client. `NearRegistry` (RPC) and `MemoryRegistry` (tests) implement it. */
export interface Registry {
  readonly contractId: string;
  getMeta(account: string): Promise<Meta | null>;
  /** Registers `meta` under the caller's account (the predecessor). */
  register(meta: Meta): Promise<{ tx_hash: string }>;
  announce(args: AnnounceArgs, via?: Via): Promise<AnnounceResult>;
  announcementCount(): Promise<number>;
  getAnnouncements(from: number, limit: number): Promise<Announcement[]>;
  sweep(args: SweepArgs, via?: Via): Promise<SweepResult>;
}
