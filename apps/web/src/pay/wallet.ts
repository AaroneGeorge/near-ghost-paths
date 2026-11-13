/**
 * Browser wallets over EIP-1193, discovered with EIP-6963 so MetaMask is picked even when another
 * wallet (Brave Wallet, Rabby…) also injects `window.ethereum`.
 */

export interface Eip1193 {
  request(a: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}
export interface WalletInfo {
  name: string;
  icon?: string;
  rdns?: string;
  provider: Eip1193;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

/** Wallets that announced themselves, MetaMask first. */
export function discoverWallets(timeoutMs = 400): Promise<WalletInfo[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletInfo>();
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        info: { name: string; icon?: string; rdns?: string; uuid: string };
        provider: Eip1193;
      };
      if (d?.provider && !found.has(d.info.uuid))
        found.set(d.info.uuid, { ...d.info, provider: d.provider });
    };
    window.addEventListener("eip6963:announceProvider", on);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", on);
      const list = [...found.values()].sort(
        (a, b) => Number(b.rdns === "io.metamask") - Number(a.rdns === "io.metamask"),
      );
      if (!list.length && window.ethereum)
        list.push({ name: "Browser wallet", provider: window.ethereum });
      resolve(list);
    }, timeoutMs);
  });
}

const hex = (n: bigint | number) => `0x${n.toString(16)}`;

export async function connect(w: WalletInfo): Promise<string> {
  const accts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accts[0]) throw new Error(`${w.name} returned no account`);
  return accts[0];
}

/**
 * Always shows the wallet's account picker (EIP-2255), so the person chooses which addresses to share even if this
 * site was connected before. Returns every address the wallet shared: wallets list their *active* account first, which
 * is not necessarily the one the person meant, so a caller with more than one should let them choose.
 */
export async function pickAccounts(w: WalletInfo): Promise<string[]> {
  try {
    await w.provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch (e) {
    if (isUserReject(e)) throw e;
  }
  const accts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  const seen = new Set<string>();
  const out = accts.filter((a) => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
  if (!out.length) throw new Error(`${w.name} returned no account`);
  return out;
}

/** Asks the wallet to switch to `chainId` (it shows its own prompt when it needs consent). */
export async function ensureChain(
  w: WalletInfo,
  chainId: number,
  add: { name: string; rpc: string; symbol: string; explorer?: string },
): Promise<void> {
  const cur = Number(await w.provider.request({ method: "eth_chainId" }));
  if (cur === chainId) return;
  try {
    await w.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex(chainId) }],
    });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await w.provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex(chainId),
          chainName: add.name,
          rpcUrls: [add.rpc],
          nativeCurrency: { name: add.symbol, symbol: add.symbol, decimals: 18 },
          ...(add.explorer ? { blockExplorerUrls: [add.explorer] } : {}),
        },
      ],
    });
  }
}

export async function sendNative(
  w: WalletInfo,
  from: string,
  to: string,
  wei: bigint,
): Promise<string> {
  return (await w.provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to, value: hex(wei) }],
  })) as string;
}

/** Polls the wallet's node until the transaction is mined; throws if it reverted. */
export async function waitMined(w: WalletInfo, hash: string, timeoutMs = 180_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = (await w.provider
      .request({ method: "eth_getTransactionReceipt", params: [hash] })
      .catch(() => null)) as { status?: string } | null;
    if (r?.status) {
      if (r.status !== "0x1") throw new Error(`transaction ${hash} failed on chain`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`transaction ${hash} not mined after ${timeoutMs / 1000} s`);
}

/** Balance on the payment chain itself (public RPC), whatever network the wallet is showing. */
export async function balanceOf(rpcs: string[], addr: string): Promise<bigint> {
  let last: unknown;
  for (const url of rpcs) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [addr, "latest"],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json()) as { result?: string };
      if (j.result) return BigInt(j.result);
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("no RPC answered");
}

/** A rejected wallet prompt reads as a choice, not an error. */
export const isUserReject = (e: unknown) => (e as { code?: number })?.code === 4001;
