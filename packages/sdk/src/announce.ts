/**
 * Announcement codec and memo encryption (docs/SPEC.md §5).
 * memo_ct = nonce(24) || XChaCha20-Poly1305(key = HKDF(S, salt, "memo"), nonce, aad = E || utf8(chain), pt = JSON memo)
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HKDF_INFO, KNOWN_CHAINS, MAX_CT_HEX } from "./constants.ts";
import { fromHex, kdf } from "./stealth.ts";
import type { AnnounceArgs, Announcement, ChainTag, Memo, StealthTarget } from "./types.ts";

const MEMO_FIELDS = ["amount", "asset", "note", "txid"] as const;
/** Max plaintext bytes so that hex(nonce || ct || tag) ≤ MAX_CT_HEX. */
export const MAX_MEMO_BYTES = MAX_CT_HEX / 2 - 24 - 16;

export function isChainTag(s: string): s is ChainTag {
  return /^evm:[1-9][0-9]{0,15}$/.test(s) || (KNOWN_CHAINS as readonly string[]).includes(s);
}

function memoKey(S: Uint8Array): Uint8Array {
  return kdf(S, HKDF_INFO.memo);
}
function memoAad(E: Uint8Array, chain: ChainTag): Uint8Array {
  return concatBytes(E, utf8ToBytes(chain));
}

/** Encrypts a memo → hex(nonce24 || ciphertext||tag16). */
export function encryptMemo(
  S: Uint8Array,
  E: Uint8Array,
  chain: ChainTag,
  memo: Memo,
  nonce?: Uint8Array,
): string {
  const clean: Memo = {};
  for (const f of MEMO_FIELDS) if (memo[f] !== undefined) clean[f] = String(memo[f]);
  const pt = utf8ToBytes(JSON.stringify(clean));
  if (pt.length > MAX_MEMO_BYTES)
    throw new Error(`memo too long (${pt.length} > ${MAX_MEMO_BYTES} bytes)`);
  const n = nonce ?? randomBytes(24);
  if (n.length !== 24) throw new Error("memo nonce must be 24 bytes");
  const ct = xchacha20poly1305(memoKey(S), n, memoAad(E, chain)).encrypt(pt);
  return bytesToHex(concatBytes(n, ct));
}

/** Decrypts a memo; null if the AEAD check fails (wrong recipient, tampered, malformed). */
export function decryptMemo(
  S: Uint8Array,
  E: Uint8Array,
  chain: ChainTag,
  ctHex: string,
): Memo | null {
  try {
    const raw = fromHex(ctHex, undefined, "ct");
    if (raw.length < 24 + 16) return null;
    const pt = xchacha20poly1305(memoKey(S), raw.slice(0, 24), memoAad(E, chain)).decrypt(
      raw.slice(24),
    );
    const obj = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    const memo: Memo = {};
    for (const f of MEMO_FIELDS) if (typeof obj[f] === "string") memo[f] = obj[f] as string;
    return memo;
  } catch {
    return null;
  }
}

/** Sender: the `announce` args for a target (+ optional encrypted memo). No recipient field. */
export function buildAnnouncement(target: StealthTarget, S: Uint8Array, memo?: Memo): AnnounceArgs {
  const args: AnnounceArgs = { chain: target.chain, eph: target.eph, tag: target.tag };
  if (memo) args.ct = encryptMemo(S, fromHex(target.eph, 32, "eph"), target.chain, memo);
  return args;
}

/** Validates AnnounceArgs (relayer and MemoryRegistry use this before storing). */
export function validateAnnounceArgs(a: AnnounceArgs): AnnounceArgs {
  if (!isChainTag(a.chain)) throw new Error(`announce: bad chain tag ${a.chain}`);
  fromHex(a.eph, 32, "announce.eph");
  if (a.eph !== a.eph.toLowerCase() || a.eph.startsWith("0x"))
    throw new Error("announce: eph must be lowercase hex");
  if (!Number.isInteger(a.tag) || a.tag < 0 || a.tag > 255)
    throw new Error("announce: tag must be a u8");
  if (a.ct !== undefined && a.ct !== null) {
    if (a.ct.length > MAX_CT_HEX) throw new Error("announce: ct too long");
    fromHex(a.ct, undefined, "announce.ct");
  }
  return a.ct == null
    ? { chain: a.chain, eph: a.eph, tag: a.tag }
    : { chain: a.chain, eph: a.eph, tag: a.tag, ct: a.ct };
}

/** Normalises a contract JSON announcement (u64 as number|string, ct null → absent). */
export function decodeAnnouncement(raw: Record<string, unknown>): Announcement {
  const a: Announcement = {
    idx: Number(raw.idx),
    chain: String(raw.chain) as ChainTag,
    eph: String(raw.eph).toLowerCase(),
    tag: Number(raw.tag),
    block_height: Number(raw.block_height ?? 0),
    timestamp_ms: Number(raw.timestamp_ms ?? 0),
    announcer: String(raw.announcer ?? ""),
  };
  if (typeof raw.ct === "string" && raw.ct.length > 0) a.ct = raw.ct.toLowerCase();
  return a;
}
