/**
 * Ghost Paths protocol constants (docs/SPEC.md §2). Changing any string here
 * changes every derived key/address: treat them as part of the wire format.
 */
import type { ChainTag, DomainId, NearNetwork } from "./types.ts";

// ---- KDF domain separation (SPEC §2) --------------------------------------
/** HKDF salt for every Ghost Paths derivation. */
export const PROTOCOL_SALT = "ghost-paths/v1";
/** HKDF `info` labels. Each key/secret has its own label; never reuse one. */
export const HKDF_INFO = {
  spend: "spend",
  view: "view",
  tweak: "tweak",
  memo: "memo",
} as const;
/** Prefix hashed with the ECDH secret to compute the 1-byte view tag. */
export const VIEW_TAG_PREFIX = "ghost-paths/v1/view-tag";
/** Domain tag at the start of the sweep-authorisation preimage. */
export const SWEEP_DOMAIN = "ghost-paths/v1/sweep";
/** Every stealth path starts with this; the rest is hex(sha256(K_unc)). */
export const PATH_PREFIX = "gp1/";
/** `gp1/` + 64 hex chars. */
export const PATH_LENGTH = PATH_PREFIX.length + 64;

// ---- NEAR / Chain Signatures ----------------------------------------------
/** NEAR MPC signer contract per network (PLAN F1). */
export const MPC_CONTRACT: Record<NearNetwork, string> = {
  testnet: "v1.signer-prod.testnet",
  mainnet: "v1.signer",
};
/**
 * Default Ghost Paths contract (registry + announcements + sweep gateway).
 * Override with GHOST_CONTRACT. Mainnet id is decided on Nov 13 (PLAN §5).
 */
export const DEFAULT_GHOST_CONTRACT: Record<NearNetwork, string> = {
  testnet: "v1.ghost-paths.testnet",
  mainnet: "ghost-paths.near",
};
/**
 * Pinned `code_hash` (base58 sha256 of the wasm) of the Ghost Paths contract per network
 * (REVIEW M2). In Mode B the contract is the MPC predecessor of every stealth address, so a client
 * that pays to `derive(contract, path)` must know the contract is this code and not a look-alike.
 * Testnet = contract/res/ghost_paths.wasm (sha256 e88f0b99…874ed9). Mainnet: unset until a
 * mainnet build is released, so live mainnet use is refused. Override: GHOST_CODE_HASH.
 */
export const PINNED_CODE_HASH: Record<NearNetwork, string | undefined> = {
  testnet: "Gep6ZYfa43r5ZJk97EAma1GjyPfuXrfcvTDPbJXN1fF6",
  mainnet: undefined,
};
/** Public NEAR RPC endpoints, tried in order (failover). */
export const RPC_URLS: Record<NearNetwork, string[]> = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};
/** Testnet account creation helper (PLAN F14). */
export const TESTNET_HELPER_URL = "https://helper.nearprotocol.com/account";

/** `sign` on v1.signer needs exactly 1 yoctoNEAR per request (PLAN F5). */
export const SIGN_DEPOSIT_YOCTO = 1n;
/** Gas for `sweep` (our contract forwards ~250 Tgas to `sign`). */
export const SWEEP_GAS = 300_000_000_000_000n;
/** Gas for `announce` / `register`. */
export const CALL_GAS = 30_000_000_000_000n;
/** Attached to `announce`; the contract refunds the excess (≈0.003 NEAR is used). */
export const ANNOUNCE_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
/** Attached to `register`; the contract refunds the excess. */
export const REGISTER_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
/** `get_announcements` page cap enforced by the contract. */
export const MAX_ANNOUNCEMENTS_PAGE = 200;
/** Max length of the announcement `ct` field in hex chars (= 256 bytes). */
export const MAX_CT_HEX = 512;
/** Default sweep authorisation lifetime in NEAR blocks (~1 s each). */
export const DEFAULT_SWEEP_TTL_BLOCKS = 600;

// ---- Chains -----------------------------------------------------------------
/** MPC domain per chain family: 0 = secp256k1 (ECDSA), 1 = ed25519 (EdDSA). */
export function domainForChain(chain: ChainTag): DomainId {
  return chain.startsWith("sol:") ? 1 : 0;
}

/** Chain tags the SDK knows by name (any `evm:<chainId>` is also valid). */
export const KNOWN_CHAINS: readonly ChainTag[] = [
  "evm:31337",
  "evm:11155111",
  "evm:84532",
  "evm:8453",
  "evm:1",
  "btc:regtest",
  "btc:testnet4",
  "btc:mainnet",
  "sol:local",
  "sol:devnet",
  "sol:mainnet",
];

/** Bech32 human-readable part for P2WPKH per BTC network. */
export const BTC_HRP = { regtest: "bcrt", testnet4: "tb", mainnet: "bc" } as const;

/** Native-asset decimals per chain family. */
export const NATIVE_DECIMALS = { evm: 18, btc: 8, sol: 9 } as const;
