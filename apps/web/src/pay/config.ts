/**
 * Pay page settings. Defaults come from the build (VITE_*); a `pay-config.json` next to pay.html
 * overrides them at run time, so a host can point the same build at its own relayer (docs/HOSTING.md).
 */
import {
  DEFAULT_GHOST_CONTRACT,
  PINNED_CODE_HASH,
  RPC_URLS,
} from "@ghost-paths/sdk/src/constants.ts";
import type { ChainTag, NearNetwork } from "@ghost-paths/sdk/src/types.ts";

export interface PayConfig {
  network: NearNetwork;
  /** Ghost Paths contract: registry, announcements, MPC predecessor of every one-time address. */
  contract: string;
  /** Pinned code hash of `contract` (base58); the page refuses to pay if the deployed code differs. */
  codeHash?: string;
  /** Relayer that posts the encrypted note on NEAR, so the payer needs no NEAR account. */
  relayer: string;
  /** EVM chains offered, in order. The first is the default. */
  chains: ChainTag[];
  nearRpc: string[];
}

const env = import.meta.env;
const network = (env.VITE_GHOST_NETWORK as NearNetwork | undefined) ?? "testnet";

export const DEFAULTS: PayConfig = {
  network,
  contract: env.VITE_GHOST_CONTRACT || DEFAULT_GHOST_CONTRACT[network],
  codeHash: env.VITE_GHOST_CODE_HASH || PINNED_CODE_HASH[network],
  relayer: env.VITE_GHOST_RELAYER_URL || "http://127.0.0.1:8787",
  chains: ((env.VITE_GHOST_PAY_CHAINS as string | undefined)?.split(",") as ChainTag[]) ?? [
    network === "testnet" ? "evm:11155111" : "evm:8453",
  ],
  nearRpc: RPC_URLS[network],
};

export async function loadPayConfig(): Promise<PayConfig> {
  try {
    const r = await fetch("./pay-config.json", { cache: "no-store" });
    if (!r.ok) return DEFAULTS;
    const j = (await r.json()) as Partial<PayConfig>;
    const net = j.network ?? DEFAULTS.network;
    return {
      ...DEFAULTS,
      ...(net !== DEFAULTS.network
        ? {
            contract: DEFAULT_GHOST_CONTRACT[net],
            codeHash: PINNED_CODE_HASH[net],
            nearRpc: RPC_URLS[net],
          }
        : {}),
      ...j,
      network: net,
    };
  } catch {
    return DEFAULTS;
  }
}

export const nearTxUrl = (c: PayConfig, hash: string) =>
  `https://${c.network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;
export const nearAccountUrl = (c: PayConfig, id: string) =>
  `https://${c.network === "testnet" ? "testnet." : ""}nearblocks.io/address/${id}`;
