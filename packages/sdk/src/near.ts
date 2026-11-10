/**
 * NEAR helpers over near-api-js 7.4: RPC provider with failover, view calls, account
 * construction, testnet account creation via the helper (PLAN F14), MPC root-key check.
 */
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair } from "near-api-js";
import { MPC_CONTRACT, PINNED_CODE_HASH, RPC_URLS, TESTNET_HELPER_URL } from "./constants.ts";
import { derivePublicKey, rootPublicKey } from "./derive.ts";
import type { DomainId, NearNetwork } from "./types.ts";

export type NearProvider = FailoverRpcProvider;

const providers = new Map<string, NearProvider>();

/** RPC provider for `network` that fails over across `urls` (default: constants.RPC_URLS or $NEAR_RPC_URL). */
export function makeProvider(network: NearNetwork = "testnet", urls?: string[]): NearProvider {
  const env = typeof process !== "undefined" ? process.env?.NEAR_RPC_URL : undefined;
  const list = urls ?? (env ? [env, ...RPC_URLS[network]] : RPC_URLS[network]);
  const key = `${network}|${list.join(",")}`;
  let p = providers.get(key);
  if (!p) {
    p = new FailoverRpcProvider(
      list.map((url) => new JsonRpcProvider({ url }, { retries: 2, backoff: 2, wait: 500 })),
    );
    providers.set(key, p);
  }
  return p;
}

/** JSON view call (free, no account needed). */
export async function viewFunction<T>(
  network: NearNetwork,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
  provider: NearProvider = makeProvider(network),
): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

/** Latest final block height (for `expires_block`). */
export async function blockHeight(
  network: NearNetwork,
  provider: NearProvider = makeProvider(network),
): Promise<number> {
  const b = await provider.viewBlock({ finality: "final" });
  return Number(b.header.height);
}

/** Account that can sign transactions with an `ed25519:…` secret key. */
export function makeAccount(
  accountId: string,
  secretKey: string,
  network: NearNetwork = "testnet",
  provider: NearProvider = makeProvider(network),
): Account {
  return new Account(accountId, provider, secretKey as `ed25519:${string}`);
}

/** Fresh ed25519 NEAR key pair. `secretKey` is a secret: never log it. */
export function newKeyPair(): { publicKey: string; secretKey: string } {
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}

/**
 * Creates a funded (10 NEAR) testnet account through helper.nearprotocol.com (PLAN F14).
 * `accountId` must end in `.testnet`. Returns the key pair; persist `secretKey` in `.secrets/`.
 */
export async function createFaucetAccount(
  accountId: string,
  keyPair: { publicKey: string; secretKey: string } = newKeyPair(),
): Promise<{ accountId: string; publicKey: string; secretKey: string }> {
  if (!accountId.endsWith(".testnet")) throw new Error("createFaucetAccount: testnet only");
  const res = await fetch(TESTNET_HELPER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.publicKey }),
  });
  if (!res.ok)
    throw new Error(
      `createFaucetAccount: helper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  return { accountId, ...keyPair };
}

/** Random `<prefix>-<hex>.testnet` id for throwaway demo accounts. */
export function randomTestnetId(prefix: string): string {
  return `${prefix}-${bytesToHex(randomBytes(5))}.testnet`;
}

/**
 * REVIEW M2: checks that `contractId` runs the pinned Ghost Paths wasm (`code_hash` from
 * `view_account`). `expected` defaults to GHOST_CODE_HASH, else PINNED_CODE_HASH[network]; with
 * neither (mainnet today) it throws, so live use of an unpinned network is refused.
 */
export async function verifyContractCode(
  network: NearNetwork,
  contractId: string,
  opts: { expected?: string; provider?: NearProvider } = {},
): Promise<{ codeHash: string; expected: string }> {
  const envPin = typeof process !== "undefined" ? process.env?.GHOST_CODE_HASH : undefined;
  const expected = opts.expected ?? (envPin || undefined) ?? PINNED_CODE_HASH[network];
  if (!expected) {
    throw new Error(
      `no pinned Ghost Paths code hash for NEAR ${network}: refusing to use ${contractId} (set GHOST_CODE_HASH to the released wasm's hash)`,
    );
  }
  const provider = opts.provider ?? makeProvider(network);
  const acc = (await provider.viewAccount({
    accountId: contractId,
    blockQuery: { finality: "final" },
  })) as {
    code_hash?: string;
    codeHash?: string;
  };
  const codeHash = String(acc.code_hash ?? acc.codeHash ?? "");
  if (codeHash !== expected) {
    throw new Error(
      `${contractId} runs code ${codeHash || "(none)"}, not the pinned Ghost Paths wasm ${expected}: refusing (wrong GHOST_CONTRACT, or an unreleased build: set GHOST_CODE_HASH)`,
    );
  }
  return { codeHash, expected };
}

/** `derived_public_key` view on the MPC signer (NAJ string). Free. */
export async function fetchDerivedPublicKey(
  predecessor: string,
  path: string,
  domainId: DomainId,
  network: NearNetwork = "testnet",
  provider?: NearProvider,
): Promise<string> {
  return viewFunction<string>(
    network,
    MPC_CONTRACT[network],
    "derived_public_key",
    { path, predecessor, domain_id: domainId },
    provider,
  );
}

/** `public_key` view on the MPC signer for a domain (NAJ string). Free. */
export async function fetchRootPublicKey(
  domainId: DomainId,
  network: NearNetwork = "testnet",
  provider?: NearProvider,
): Promise<string> {
  return viewFunction<string>(
    network,
    MPC_CONTRACT[network],
    "public_key",
    { domain_id: domainId },
    provider,
  );
}

/** Startup sanity check: chainsig.js root keys == the live signer's `public_key` for domains 0 and 1. */
export async function checkRootKeys(
  network: NearNetwork = "testnet",
  provider?: NearProvider,
): Promise<{
  ok: boolean;
  domains: { domainId: DomainId; local: string; remote: string; ok: boolean }[];
}> {
  const domains = await Promise.all(
    ([0, 1] as const).map(async (domainId) => {
      const local = rootPublicKey(network, domainId);
      const remote = await fetchRootPublicKey(domainId, network, provider);
      return { domainId, local, remote, ok: local === remote };
    }),
  );
  return { ok: domains.every((d) => d.ok), domains };
}

/** Local derivation vs the signer's `derived_public_key` view (one free RPC call). */
export async function checkDerivation(
  predecessor: string,
  path: string,
  domainId: DomainId,
  network: NearNetwork = "testnet",
  provider?: NearProvider,
): Promise<{ ok: boolean; local: string; remote: string }> {
  const local = derivePublicKey(predecessor, path, domainId, network).naj;
  const remote = await fetchDerivedPublicKey(predecessor, path, domainId, network, provider);
  return { ok: local === remote, local, remote };
}
