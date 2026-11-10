/**
 * Recipient keys (docs/SPEC.md §2): one 32-byte seed → secp256k1 spend key + X25519 viewing key,
 * domain-separated with HKDF-SHA256(salt "ghost-paths/v1", info "spend" | "view").
 * Keystore I/O uses node:fs via dynamic import so browser bundles that import the SDK don't break.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { HKDF_INFO } from "./constants.ts";
import { networkOf } from "./derive.ts";
import { fromHex, kdf, scalarFrom, scalarToBytes } from "./stealth.ts";
import type { Keystore, Meta, Mode, NearNetwork, ViewingBundle } from "./types.ts";

export interface RecipientKeys {
  /** Spend scalar d_spend (secret). */
  dSpend: bigint;
  /** P_spend, 33-byte compressed secp256k1. */
  spendPub: Uint8Array;
  /** k_view, 32 bytes (secret; x25519 clamps on use). */
  viewPriv: Uint8Array;
  /** P_view, 32-byte X25519. */
  viewPub: Uint8Array;
}

/** 32 random bytes from the platform CSPRNG. */
export function generateSeed(): Uint8Array {
  return randomBytes(32);
}

/** seed → {d_spend, P_spend, k_view, P_view}. Deterministic. */
export function deriveRecipientKeys(seed: Uint8Array): RecipientKeys {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const dSpend = scalarFrom(kdf(seed, HKDF_INFO.spend), "spend key");
  const spendPub = secp256k1.getPublicKey(scalarToBytes(dSpend), true);
  const viewPriv = kdf(seed, HKDF_INFO.view);
  const viewPub = x25519.getPublicKey(viewPriv);
  return { dSpend, spendPub, viewPriv, viewPub };
}

/** Registry entry for these keys. */
export function metaFromKeys(
  keys: Pick<RecipientKeys, "spendPub" | "viewPub">,
  mode: Mode = "contract",
): Meta {
  return { v: 1, mode, spend_pub: bytesToHex(keys.spendPub), view_pub: bytesToHex(keys.viewPub) };
}

/** Validates and normalises a meta-address (e.g. from `get_meta`). Throws on bad input. */
export function parseMeta(raw: unknown): Meta {
  const m = raw as Partial<Meta> | null;
  if (!m || typeof m !== "object") throw new Error("meta: not an object");
  const mode = m.mode ?? "contract";
  if (mode !== "contract" && mode !== "account") throw new Error("meta: bad mode");
  const spend = fromHex(String(m.spend_pub ?? ""), 33, "meta.spend_pub");
  secp256k1.Point.fromBytes(spend); // on-curve check
  fromHex(String(m.view_pub ?? ""), 32, "meta.view_pub");
  return {
    v: 1,
    mode,
    spend_pub: String(m.spend_pub).toLowerCase(),
    view_pub: String(m.view_pub).toLowerCase(),
  };
}

/** `ghost:<account>` ↔ account id. */
export function formatHandle(account: string): string {
  return `ghost:${account}`;
}
export function parseHandle(handle: string): string {
  return handle.startsWith("ghost:") ? handle.slice("ghost:".length) : handle;
}

export function makeKeystore(a: {
  seed: Uint8Array;
  account: string;
  signer: string;
  mode?: Mode;
  network?: NearNetwork;
}): Keystore {
  const k = deriveRecipientKeys(a.seed);
  return {
    v: 1,
    account: a.account,
    view_priv: bytesToHex(k.viewPriv),
    spend_pub: bytesToHex(k.spendPub),
    signer: a.signer,
    mode: a.mode ?? "contract",
    network: a.network ?? networkOf(a.signer),
    seed: bytesToHex(a.seed),
  };
}

/** Keystore → auditor bundle (drops the seed; cannot sweep). */
export function viewingBundle(ks: Keystore | ViewingBundle): ViewingBundle {
  const { v, account, view_priv, spend_pub, signer, mode, network } = ks;
  return {
    v,
    account,
    view_priv,
    spend_pub,
    signer,
    mode: mode ?? "contract",
    network: network ?? networkOf(signer),
  };
}

/** Recipient keys from a keystore, verifying the stored public parts match the seed. */
export function keysFromKeystore(ks: Keystore): RecipientKeys {
  const k = deriveRecipientKeys(fromHex(ks.seed, 32, "seed"));
  if (bytesToHex(k.spendPub) !== ks.spend_pub || bytesToHex(k.viewPriv) !== ks.view_priv) {
    throw new Error("keystore: seed does not match stored keys");
  }
  return k;
}

/** Validates a viewing bundle (e.g. an uploaded auditor file). */
export function parseViewingBundle(raw: unknown): ViewingBundle {
  const b = raw as Partial<ViewingBundle> | null;
  if (!b || typeof b !== "object" || b.v !== 1) throw new Error("viewing bundle: bad version");
  if (typeof b.account !== "string" || typeof b.signer !== "string")
    throw new Error("viewing bundle: account/signer");
  fromHex(String(b.view_priv ?? ""), 32, "view_priv");
  secp256k1.Point.fromBytes(fromHex(String(b.spend_pub ?? ""), 33, "spend_pub"));
  return viewingBundle(b as ViewingBundle);
}

/** Writes a keystore with mode 0600 (creating parent dirs 0700). Node/bun only. */
export async function saveKeystore(file: string, ks: Keystore): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(ks, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Reads and validates a keystore. Node/bun only. */
export async function loadKeystore(file: string): Promise<Keystore> {
  const fs = await import("node:fs/promises");
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Keystore;
  const ks = { ...parseViewingBundle(raw), seed: raw.seed };
  keysFromKeystore(ks);
  return ks;
}
