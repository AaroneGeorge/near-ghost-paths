/**
 * Per-chain configuration (W3). RPC endpoints, explorers, native asset, and the
 * mainnet/local classification every live action is gated on.
 *
 * Override any RPC with env `GHOST_RPC_<TAG>` where TAG is the chain tag upper-cased with
 * non-alphanumerics replaced by `_` (e.g. GHOST_RPC_EVM_31337, GHOST_RPC_SOL_LOCAL,
 * GHOST_RPC_BTC_TESTNET4).
 *
 * Infra facts (PLAN §0 F11–F13, re-verified 2026-11-09 by W3):
 *  - mempool.space is IPv6-only from the dev host → BTC uses mempool.emzy.de, then blockstream.info.
 *  - Solana devnet public airdrop is closed (410) → devnet funding goes through lechu-wallet / FUNDER_SOL_KEY.
 */
import type { ChainTag, NearNetwork } from "../types.ts";

export type ChainFamily = "evm" | "btc" | "sol";

export interface ChainInfo {
  tag: ChainTag;
  family: ChainFamily;
  /** Human name for logs. */
  name: string;
  /** RPC endpoints tried in order (EVM JSON-RPC, Solana JSON-RPC, or esplora/mempool REST base). */
  rpc: string[];
  /** Explorer tx URL builder (undefined for local chains). */
  txUrl?: (hash: string) => string;
  addressUrl?: (addr: string) => string;
  symbol: string;
  decimals: number;
  /** Spending on this chain costs real money: gated by MAINNET_APPROVED=1. */
  mainnet: boolean;
  /** Local docker chain (anvil / solana-test-validator): free, auto-funded. */
  local: boolean;
  /** NEAR network whose MPC signer pairs with this chain by default. */
  nearNetwork: NearNetwork;
  /** lechu-wallet network name (dev-host funder), if it serves this chain. */
  lechuNetwork?: string;
  /** EVM chain id. */
  chainId?: number;
}

const env = (k: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[k] || undefined : undefined;

export function rpcEnvKey(tag: string): string {
  return `GHOST_RPC_${tag.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

const solExplorer = (cluster: string) => ({
  txUrl: (h: string) => `https://explorer.solana.com/tx/${h}${cluster}`,
  addressUrl: (a: string) => `https://explorer.solana.com/address/${a}${cluster}`,
});

/** Static table; `chainInfo()` applies env overrides. */
const TABLE: Record<string, Omit<ChainInfo, "tag">> = {
  "evm:31337": {
    family: "evm",
    name: "anvil (local)",
    rpc: ["http://127.0.0.1:8545"],
    symbol: "ETH",
    decimals: 18,
    mainnet: false,
    local: true,
    nearNetwork: "testnet",
    chainId: 31337,
  },
  "evm:11155111": {
    family: "evm",
    name: "Ethereum Sepolia",
    rpc: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"],
    txUrl: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    addressUrl: (a) => `https://sepolia.etherscan.io/address/${a}`,
    symbol: "ETH",
    decimals: 18,
    mainnet: false,
    local: false,
    nearNetwork: "testnet",
    lechuNetwork: "sepolia",
    chainId: 11155111,
  },
  "evm:84532": {
    family: "evm",
    name: "Base Sepolia",
    rpc: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
    txUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
    addressUrl: (a) => `https://sepolia.basescan.org/address/${a}`,
    symbol: "ETH",
    decimals: 18,
    mainnet: false,
    local: false,
    nearNetwork: "testnet",
    lechuNetwork: "base-sepolia",
    chainId: 84532,
  },
  "evm:8453": {
    family: "evm",
    name: "Base",
    rpc: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    txUrl: (h) => `https://basescan.org/tx/${h}`,
    addressUrl: (a) => `https://basescan.org/address/${a}`,
    symbol: "ETH",
    decimals: 18,
    mainnet: true,
    local: false,
    nearNetwork: "mainnet",
    lechuNetwork: "base",
    chainId: 8453,
  },
  "evm:1": {
    family: "evm",
    name: "Ethereum",
    rpc: ["https://ethereum-rpc.publicnode.com"],
    txUrl: (h) => `https://etherscan.io/tx/${h}`,
    addressUrl: (a) => `https://etherscan.io/address/${a}`,
    symbol: "ETH",
    decimals: 18,
    mainnet: true,
    local: false,
    nearNetwork: "mainnet",
    lechuNetwork: "ethereum",
    chainId: 1,
  },
  "sol:local": {
    family: "sol",
    name: "solana-test-validator (local)",
    rpc: ["http://127.0.0.1:8899"],
    symbol: "SOL",
    decimals: 9,
    mainnet: false,
    local: true,
    nearNetwork: "testnet",
  },
  "sol:devnet": {
    family: "sol",
    name: "Solana devnet",
    rpc: ["https://api.devnet.solana.com"],
    ...solExplorer("?cluster=devnet"),
    symbol: "SOL",
    decimals: 9,
    mainnet: false,
    local: false,
    nearNetwork: "testnet",
    lechuNetwork: "solana-devnet",
  },
  "sol:mainnet": {
    family: "sol",
    name: "Solana",
    rpc: ["https://api.mainnet-beta.solana.com"],
    ...solExplorer(""),
    symbol: "SOL",
    decimals: 9,
    mainnet: true,
    local: false,
    nearNetwork: "mainnet",
    lechuNetwork: "solana",
  },
  "btc:testnet4": {
    family: "btc",
    name: "Bitcoin testnet4",
    // mempool.space is IPv6-only from the dev host (F11); emzy is mempool-compatible, blockstream is esplora.
    rpc: ["https://mempool.emzy.de/testnet4/api", "https://blockstream.info/testnet4/api"],
    txUrl: (h) => `https://mempool.space/testnet4/tx/${h}`,
    addressUrl: (a) => `https://mempool.space/testnet4/address/${a}`,
    symbol: "BTC",
    decimals: 8,
    mainnet: false,
    local: false,
    nearNetwork: "testnet",
  },
  "btc:mainnet": {
    family: "btc",
    name: "Bitcoin",
    rpc: ["https://mempool.emzy.de/api", "https://blockstream.info/api"],
    txUrl: (h) => `https://mempool.space/tx/${h}`,
    addressUrl: (a) => `https://mempool.space/address/${a}`,
    symbol: "BTC",
    decimals: 8,
    mainnet: true,
    local: false,
    nearNetwork: "mainnet",
  },
  "btc:regtest": {
    family: "btc",
    name: "Bitcoin regtest (esplora at GHOST_RPC_BTC_REGTEST)",
    rpc: ["http://127.0.0.1:3002"],
    symbol: "BTC",
    decimals: 8,
    mainnet: false,
    local: true,
    nearNetwork: "testnet",
  },
};

export function familyOf(tag: string): ChainFamily {
  const f = tag.slice(0, 3);
  if (f === "evm" || f === "btc" || f === "sol") return f;
  throw new Error(`unknown chain family in "${tag}"`);
}

/** Config for a chain tag. Any `evm:<id>` not in the table needs GHOST_RPC_EVM_<id>. */
export function chainInfo(tag: ChainTag): ChainInfo {
  const base = TABLE[tag];
  const override = env(rpcEnvKey(tag));
  if (base) {
    return { tag, ...base, rpc: override ? [override, ...base.rpc] : base.rpc };
  }
  if (tag.startsWith("evm:")) {
    const chainId = Number(tag.slice(4));
    if (!override) throw new Error(`no RPC for ${tag}: set ${rpcEnvKey(tag)}`);
    return {
      tag,
      family: "evm",
      name: `EVM chain ${chainId}`,
      rpc: [override],
      symbol: "ETH",
      decimals: 18,
      mainnet: env("GHOST_EVM_TESTNET") !== "1", // unknown chains are treated as mainnet (safe default)
      local: false,
      nearNetwork: "testnet",
      chainId,
    };
  }
  throw new Error(`unsupported chain tag: ${tag}`);
}

export const knownChainTags = (): ChainTag[] => Object.keys(TABLE) as ChainTag[];

/** Thrown when an action would spend mainnet funds without MAINNET_APPROVED=1. */
export class MainnetNotApprovedError extends Error {
  constructor(what: string) {
    super(
      `refusing to ${what}: it spends real mainnet funds. Set MAINNET_APPROVED=1 only with the owner's explicit approval.`,
    );
    this.name = "MainnetNotApprovedError";
  }
}

/** Throws unless the chain is a test chain or MAINNET_APPROVED=1. */
export function assertSpendAllowed(tag: ChainTag, what: string): void {
  if (chainInfo(tag).mainnet && env("MAINNET_APPROVED") !== "1")
    throw new MainnetNotApprovedError(`${what} on ${tag}`);
}

/** Decimal string → base units (no float math). */
export function parseUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad amount "${amount}"`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units → decimal string, trailing zeros trimmed. */
export function formatUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
