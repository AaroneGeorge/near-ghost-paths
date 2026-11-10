/**
 * Scanning (docs/SPEC.md §5). Needs only the viewing bundle (k_view, P_spend): finds payments,
 * never sweeps. View-tag fast path skips ~255/256 announcements with one X25519 + one SHA-256.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { decryptMemo, isChainTag } from "./announce.ts";
import { NATIVE_DECIMALS } from "./constants.ts";
import { networkOf } from "./derive.ts";
import { fromHex, predecessorFor, targetFromSecret, viewTag } from "./stealth.ts";
import type {
  Announcement,
  ChainAdapter,
  ChainTag,
  Memo,
  Payment,
  Registry,
  StealthTarget,
  ViewingBundle,
} from "./types.ts";

export interface ScanOptions {
  /**
   * Ignore the view tag (for announcements made with `noViewTag`). Then a hit requires a memo
   * that decrypts under S (AEAD), since without the tag every announcement "matches".
   */
  full?: boolean;
}

export interface ScanHit extends StealthTarget {
  idx: number;
  memo?: Memo;
}

/** Shared-secret for an announcement under a viewing key, or null if the ephemeral key is bad. */
function secretFor(a: Announcement, viewPriv: Uint8Array): Uint8Array | null {
  try {
    const S = x25519.getSharedSecret(viewPriv, fromHex(a.eph, 32, "eph"));
    return S.every((b) => b === 0) ? null : S;
  } catch {
    return null;
  }
}

/**
 * One announcement against one viewing bundle → the target (+ decrypted memo) or null.
 * Rules: tag must match (unless `full`); if `ct` is present it must decrypt (drops the 1/256
 * tag false positives); in `full` mode `ct` is mandatory.
 */
export function scanOne(
  a: Announcement,
  bundle: ViewingBundle,
  opts: ScanOptions = {},
): ScanHit | null {
  if (!isChainTag(a.chain)) return null;
  const S = secretFor(a, fromHex(bundle.view_priv, 32, "view_priv"));
  if (!S) return null;
  if (!opts.full && viewTag(S) !== a.tag) return null;
  const E = fromHex(a.eph, 32, "eph");
  let memo: Memo | undefined;
  if (a.ct) {
    const m = decryptMemo(S, E, a.chain, a.ct);
    if (!m) return null;
    memo = m;
  } else if (opts.full) {
    return null;
  }
  const mode = bundle.mode ?? "contract";
  const target = targetFromSecret({
    S,
    E,
    spendPub: fromHex(bundle.spend_pub, 33, "spend_pub"),
    chain: a.chain,
    predecessor: predecessorFor(mode, bundle.signer, bundle.account),
    network: bundle.network ?? networkOf(bundle.signer),
    tag: a.tag,
  });
  return memo ? { ...target, idx: a.idx, memo } : { ...target, idx: a.idx };
}

/** Offline scan of a list of announcements. */
export function scanAnnouncements(
  list: Announcement[],
  bundle: ViewingBundle,
  opts: ScanOptions = {},
): ScanHit[] {
  const out: ScanHit[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const hit = scanOne(a, bundle, opts);
    if (!hit) continue;
    // REVIEW L3: anyone can re-post an announcement; one (E, chain, address) is one payment.
    // Keep the first (lowest idx) so income is not double-counted.
    const key = hitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** Identity of a payment for de-duplication: (E, chain, address). */
export function hitKey(h: Pick<ScanHit, "eph" | "chain" | "address">): string {
  return `${h.eph}|${h.chain}|${h.address}`;
}

/** Pages through the registry's announcement log from `from`. Returns hits and the next cursor. */
export async function scanRegistry(
  registry: Pick<Registry, "getAnnouncements">,
  bundle: ViewingBundle,
  opts: ScanOptions & { from?: number; pageSize?: number } = {},
): Promise<{ hits: ScanHit[]; next: number; scanned: number }> {
  const pageSize = Math.min(opts.pageSize ?? 200, 200);
  let cursor = opts.from ?? 0;
  const hits: ScanHit[] = [];
  const seenKeys = new Set<string>();
  let scanned = 0;
  for (;;) {
    const page = await registry.getAnnouncements(cursor, pageSize);
    if (page.length === 0) break;
    for (const h of scanAnnouncements(page, bundle, opts)) {
      if (!seenKeys.has(hitKey(h))) {
        seenKeys.add(hitKey(h));
        hits.push(h);
      }
    }
    scanned += page.length;
    cursor = (page[page.length - 1] as Announcement).idx + 1;
    if (page.length < pageSize) break;
  }
  return { hits, next: cursor, scanned };
}

export type AdapterLookup =
  | Partial<Record<ChainTag, Pick<ChainAdapter, "getBalance">>>
  | ((chain: ChainTag) => Pick<ChainAdapter, "getBalance"> | undefined);

/**
 * Hits → Payments with balances. `seen` = idx values previously observed funded; a payment is
 * `swept` when its balance is now 0 and it was seen funded before. Chains without an adapter get
 * balance 0 and are never marked swept.
 */
export async function toPayments(
  hits: ScanHit[],
  adapters: AdapterLookup,
  opts: { seen?: ReadonlySet<number> } = {},
): Promise<Payment[]> {
  const lookup = typeof adapters === "function" ? adapters : (c: ChainTag) => adapters[c];
  return Promise.all(
    hits.map(async (hit): Promise<Payment> => {
      // A hit can name a chain the caller has no adapter for (anyone can announce to a public
      // P_view on any chain tag): treat a throwing lookup like a missing adapter, so one crafted
      // announcement cannot fail the whole scan (REVIEW W6-H2).
      let adapter: Pick<ChainAdapter, "getBalance"> | undefined;
      try {
        adapter = lookup(hit.chain);
      } catch {
        adapter = undefined;
      }
      const family = hit.chain.slice(0, 3) as keyof typeof NATIVE_DECIMALS;
      if (!adapter) return { ...hit, balance: 0n, decimals: NATIVE_DECIMALS[family], swept: false };
      const { balance, decimals } = await adapter.getBalance(hit.address);
      return {
        ...hit,
        balance,
        decimals,
        swept: balance === 0n && (opts.seen?.has(hit.idx) ?? false),
      };
    }),
  );
}

/** scan(announcements, viewingBundle, chains) → Payment[] (PLAN §3). */
export async function scan(
  list: Announcement[],
  bundle: ViewingBundle,
  adapters: AdapterLookup,
  opts: ScanOptions & { seen?: ReadonlySet<number> } = {},
): Promise<Payment[]> {
  return toPayments(scanAnnouncements(list, bundle, opts), adapters, opts);
}
