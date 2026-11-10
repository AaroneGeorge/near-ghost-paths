/**
 * Stealth math (docs/SPEC.md §3–§5). Pure functions, no I/O.
 * Primitives: @noble/curves (secp256k1, x25519), @noble/hashes (sha256, HKDF).
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import {
  HKDF_INFO,
  PATH_LENGTH,
  PATH_PREFIX,
  PROTOCOL_SALT,
  SWEEP_DOMAIN,
  VIEW_TAG_PREFIX,
  domainForChain,
} from "./constants.ts";
import { deriveAddress, networkOf } from "./derive.ts";
import type {
  ChainTag,
  DomainId,
  Hex,
  Hex64,
  Meta,
  Mode,
  NearNetwork,
  StealthTarget,
  SweepArgs,
} from "./types.ts";

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;

// ---- small helpers -----------------------------------------------------------

/** Strict lowercase-hex decode with expected byte length. Accepts an optional 0x prefix. */
export function fromHex(hex: string, len?: number, what = "hex"): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) throw new Error(`${what}: not hex`);
  const b = hexToBytes(h);
  if (len !== undefined && b.length !== len)
    throw new Error(`${what}: expected ${len} bytes, got ${b.length}`);
  return b;
}
export const toHex = (b: Uint8Array): string => bytesToHex(b);

function bytesToBigInt(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt(`0x${bytesToHex(b)}`);
}
function bigIntTo32(x: bigint): Uint8Array {
  return hexToBytes(x.toString(16).padStart(64, "0"));
}
/** HKDF-SHA256(ikm, salt="ghost-paths/v1", info) → 32 bytes. */
export function kdf(ikm: Uint8Array, info: Uint8Array | string, len = 32): Uint8Array {
  return hkdf(
    sha256,
    ikm,
    utf8ToBytes(PROTOCOL_SALT),
    typeof info === "string" ? utf8ToBytes(info) : info,
    len,
  );
}
/** int(bytes) mod n, rejecting 0 (probability ~2^-256). */
export function scalarFrom(b: Uint8Array, what: string): bigint {
  const s = bytesToBigInt(b) % N;
  if (s === 0n) throw new Error(`${what}: zero scalar`);
  return s;
}
export const scalarToBytes = bigIntTo32;

// ---- ECDH, view tag, tweak --------------------------------------------------

/** S = X25519(priv, pub); rejects the all-zero output (low-order point). */
export function ecdh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  if (priv.length !== 32 || pub.length !== 32) throw new Error("ecdh: keys must be 32 bytes");
  const S = x25519.getSharedSecret(priv, pub);
  if (S.every((x) => x === 0)) throw new Error("ecdh: all-zero shared secret");
  return S;
}

/** tag = sha256("ghost-paths/v1/view-tag" || S)[0]. */
export function viewTag(S: Uint8Array): number {
  return sha256(concatBytes(utf8ToBytes(VIEW_TAG_PREFIX), S))[0] as number;
}

/** h = int(HKDF(S, salt, "tweak" || E || P_spend(33) || utf8(chain))) mod n. */
export function tweak(S: Uint8Array, E: Uint8Array, spendPub: Uint8Array, chain: ChainTag): bigint {
  if (E.length !== 32) throw new Error("tweak: E must be 32 bytes");
  if (spendPub.length !== 33) throw new Error("tweak: P_spend must be 33 bytes compressed");
  const info = concatBytes(utf8ToBytes(HKDF_INFO.tweak), E, spendPub, utf8ToBytes(chain));
  return scalarFrom(kdf(S, info), "tweak");
}

/** K = P_spend + h·G, 65-byte uncompressed. */
export function stealthPub(spendPub: Uint8Array, h: bigint): Uint8Array {
  const K = Point.fromBytes(spendPub).add(Point.BASE.multiply(h));
  if (K.equals(Point.ZERO)) throw new Error("stealthPub: point at infinity");
  return K.toBytes(false);
}

/** x||y (64 bytes) of a 65-byte uncompressed or 33-byte compressed point. */
export function kUnc(K: Uint8Array): Uint8Array {
  return Point.fromBytes(K).toBytes(false).slice(1);
}

/** path = "gp1/" + hex(sha256(x||y)). 68 ASCII chars. */
export function stealthPath(K: Uint8Array): string {
  return PATH_PREFIX + bytesToHex(sha256(kUnc(K)));
}

export function isStealthPath(path: string): boolean {
  return (
    path.length === PATH_LENGTH &&
    path.startsWith(PATH_PREFIX) &&
    /^[0-9a-f]{64}$/.test(path.slice(4))
  );
}

/** d_K = (d_spend + h) mod n. Never stored. */
export function stealthPriv(dSpend: bigint, h: bigint): bigint {
  const d = (dSpend + h) % N;
  if (d === 0n) throw new Error("stealthPriv: zero key");
  return d;
}

/** MPC predecessor for a meta-address: the Ghost Paths contract (Mode B) or the recipient account (Mode A). */
export function predecessorFor(mode: Mode, contractId: string, account: string): string {
  return mode === "contract" ? contractId : account;
}

/** Recompute the full target from S (shared by sender and scanner). */
export function targetFromSecret(args: {
  S: Uint8Array;
  E: Uint8Array;
  spendPub: Uint8Array;
  chain: ChainTag;
  predecessor: string;
  network: NearNetwork;
  tag?: number;
}): StealthTarget {
  const { S, E, spendPub, chain, predecessor, network } = args;
  const h = tweak(S, E, spendPub, chain);
  const K = stealthPub(spendPub, h);
  const path = stealthPath(K);
  const domainId: DomainId = domainForChain(chain);
  const { address } = deriveAddress(predecessor, path, chain, network);
  return { chain, eph: bytesToHex(E), tag: args.tag ?? viewTag(S), h, K, path, address, domainId };
}

/**
 * Sender side (SPEC §3): fresh ephemeral key → one-time target for `meta` on `chain`.
 * `predecessor` = predecessorFor(meta.mode, contractId, recipientAccount).
 * `noViewTag` replaces the tag with a random byte (bigger anonymity set; recipient must
 * then scan in `full` mode and the announcement must carry a memo, SPEC §5).
 */
export function makeTarget(
  meta: Meta,
  chain: ChainTag,
  predecessor: string,
  opts: { eph?: Uint8Array; network?: NearNetwork; noViewTag?: boolean } = {},
): { target: StealthTarget; S: Uint8Array; ephPriv: Uint8Array } {
  const ephPriv = opts.eph ?? randomBytes(32);
  const E = x25519.getPublicKey(ephPriv);
  const S = ecdh(ephPriv, fromHex(meta.view_pub, 32, "view_pub"));
  const tag = opts.noViewTag ? (randomBytes(1)[0] as number) : viewTag(S);
  const target = targetFromSecret({
    S,
    E,
    spendPub: fromHex(meta.spend_pub, 33, "spend_pub"),
    chain,
    predecessor,
    network: opts.network ?? networkOf(predecessor),
    tag,
  });
  return { target, S, ephPriv };
}

// ---- Sweep authorisation (SPEC §6, contract/SWEEP-MESSAGE.md) ---------------

export interface SweepMessageArgs {
  contractId: string;
  path: string;
  domainId: DomainId;
  payloads: Uint8Array[];
  expiresBlock: bigint | number;
}

/**
 * Sweep preimage, byte-for-byte as in contract/SWEEP-MESSAGE.md and contract/src/sweep.rs:
 *   utf8("ghost-paths/v1/sweep")            20 bytes
 *   contract_id                             ASCII, no length prefix (NEAR ids never contain "/")
 *   path                                    ASCII, exactly 68 bytes ("gp1/" + 64 lowercase hex)
 *   u8(domain_id)
 *   u64be(expires_block)
 *   u8(n_payloads)
 *   n × ( u16be(len_i) || payload_i )       raw bytes (hex-decoded)
 * Injective because the contract id cannot contain "/" and the path has a fixed format/length
 * (both enforced here and by the contract), so the contract_id/path boundary is unambiguous.
 */
export function sweepPreimage(a: SweepMessageArgs): Uint8Array {
  const cid = utf8ToBytes(a.contractId);
  const path = utf8ToBytes(a.path);
  if (cid.length < 2 || cid.length > 64 || !/^[a-z0-9._-]+$/.test(a.contractId))
    throw new Error("sweep: contract id");
  if (!isStealthPath(a.path)) throw new Error("sweep: path must be gp1/ + 64 lowercase hex");
  if (a.domainId !== 0 && a.domainId !== 1) throw new Error("sweep: domain_id");
  if (a.payloads.length < 1 || a.payloads.length > 255) throw new Error("sweep: payload count");
  const exp = BigInt(a.expiresBlock);
  if (exp < 0n || exp > 0xffff_ffff_ffff_ffffn) throw new Error("sweep: expires_block");
  const u64 = new Uint8Array(8);
  new DataView(u64.buffer).setBigUint64(0, exp, false);
  const parts: Uint8Array[] = [
    utf8ToBytes(SWEEP_DOMAIN),
    cid,
    path,
    new Uint8Array([a.domainId]),
    u64,
    new Uint8Array([a.payloads.length]),
  ];
  for (const p of a.payloads) {
    if (p.length < 1 || p.length > 0xffff) throw new Error("sweep: payload length");
    parts.push(new Uint8Array([p.length >> 8, p.length & 0xff]), p);
  }
  return concatBytes(...parts);
}

/** msg = sha256(sweepPreimage(args)) — the 32-byte hash K signs and the contract ecrecovers. */
export function sweepMessage(a: SweepMessageArgs): Uint8Array {
  return sha256(sweepPreimage(a));
}

/** ECDSA over the 32-byte msg (no extra hashing), RFC 6979, low-s. → r||s hex + v ∈ {0,1}. */
export function signSweep(msg: Uint8Array, dK: bigint): { sig: Hex64; v: number } {
  if (msg.length !== 32) throw new Error("signSweep: msg must be 32 bytes");
  const rec = secp256k1.sign(msg, bigIntTo32(dK), {
    prehash: false,
    lowS: true,
    format: "recovered",
  });
  return { sig: bytesToHex(rec.slice(1)), v: rec[0] as number };
}

/** What the contract does with env::ecrecover: returns x||y hex of the signer, or null. Rejects high-s. */
export function recoverSweepKey(msg: Uint8Array, sig: Hex64, v: number): Hex64 | null {
  try {
    const s = secp256k1.Signature.fromBytes(fromHex(sig, 64, "sig"), "compact").addRecoveryBit(v);
    if (s.hasHighS()) return null;
    return bytesToHex(s.recoverPublicKey(msg).toBytes(false).slice(1));
  } catch {
    return null;
  }
}

/** Builds the full `sweep` call args for one payment (SPEC §6). */
export function buildSweepArgs(a: {
  contractId: string;
  target: Pick<StealthTarget, "path" | "domainId" | "K" | "h">;
  dSpend: bigint;
  payloads: Uint8Array[];
  expiresBlock: bigint | number;
}): SweepArgs {
  const { target } = a;
  const dK = stealthPriv(a.dSpend, target.h);
  const kPub = bytesToHex(kUnc(target.K));
  if (bytesToHex(secp256k1.getPublicKey(bigIntTo32(dK), false).slice(1)) !== kPub) {
    throw new Error("buildSweepArgs: d_spend does not match this target");
  }
  const msg = sweepMessage({
    contractId: a.contractId,
    path: target.path,
    domainId: target.domainId,
    payloads: a.payloads,
    expiresBlock: a.expiresBlock,
  });
  const { sig, v } = signSweep(msg, dK);
  return {
    path: target.path,
    domain_id: target.domainId,
    payloads: a.payloads.map((p): Hex => bytesToHex(p)),
    expires_block: Number(a.expiresBlock),
    k_pub: kPub,
    sig,
    v,
  };
}

/** Relayer/contract-side check of SweepArgs (mirrors the contract's checks except block height). */
export function verifySweepArgs(contractId: string, a: SweepArgs): boolean {
  if (!isStealthPath(a.path)) return false;
  let kBytes: Uint8Array;
  try {
    kBytes = fromHex(a.k_pub, 64, "k_pub");
  } catch {
    return false;
  }
  if (bytesToHex(sha256(kBytes)) !== a.path.slice(PATH_PREFIX.length)) return false;
  const msg = sweepMessage({
    contractId,
    path: a.path,
    domainId: a.domain_id,
    payloads: a.payloads.map((p) => fromHex(p, undefined, "payload")),
    expiresBlock: a.expires_block,
  });
  return recoverSweepKey(msg, a.sig, a.v) === a.k_pub;
}
