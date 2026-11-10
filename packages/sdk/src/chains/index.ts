/**
 * Chain adapters (W3): `getAdapter(tag)` returns the ChainAdapter for a chain tag, cached.
 *  evm:*        EvmAdapter (viem)
 *  sol:*        SolanaAdapter (@solana/web3.js)
 *  btc:*        BtcAdapter (chainsig.js PSBT + esplora/mempool REST)
 * In GHOST_REPLAY=1 mode the same adapters run against tape.ts (recorded HTTP), not fakes.
 */
import type { ChainAdapter, ChainTag, NearNetwork } from "../types.ts";
import { BtcAdapter } from "./btc.ts";
import { familyOf } from "./config.ts";
import { EvmAdapter } from "./evm.ts";
import { SolanaAdapter } from "./solana.ts";

export * from "./config.ts";
export { BtcAdapter, compressPub, p2wpkhScript, p2wpkhVsize } from "./btc.ts";
export { EvmAdapter } from "./evm.ts";
export { SolanaAdapter, SOL_FEE_PER_SIG, makeConnection } from "./solana.ts";
export { bytesToHexStr, ecdsaParts, ed25519Bytes, hexToBytesStrict } from "./sig.ts";
export {
  EvmKeyPayer,
  LechuPayer,
  type PayerWallet,
  SolKeyPayer,
  extractTxHash,
  lechuAvailable,
  parseSolSecret,
} from "./wallets.ts";
export { installTape, tapeStatus, type TapeMode } from "./tape.ts";

export type AnyAdapter = EvmAdapter | SolanaAdapter | BtcAdapter;

const cache = new Map<string, AnyAdapter>();

/** Adapter for `tag`; `nearNetwork` selects the MPC root key used for derivation. */
export function getAdapter(tag: ChainTag, opts: { nearNetwork?: NearNetwork } = {}): AnyAdapter {
  const key = `${tag}|${opts.nearNetwork ?? ""}`;
  let a = cache.get(key);
  if (!a) {
    const fam = familyOf(tag);
    a =
      fam === "evm"
        ? new EvmAdapter(tag, opts)
        : fam === "sol"
          ? new SolanaAdapter(tag, opts)
          : new BtcAdapter(tag, opts);
    cache.set(key, a);
  }
  return a;
}

/** Lookup function in the shape scan.ts `toPayments` accepts. */
export function adapterLookup(
  opts: { nearNetwork?: NearNetwork } = {},
): (chain: ChainTag) => ChainAdapter {
  return (chain) => getAdapter(chain, opts);
}
