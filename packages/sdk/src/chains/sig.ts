/** MPC signature normalisation shared by the chain adapters (W3). */
import type { MpcSignature } from "../types.ts";

export function hexToBytesStrict(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHexStr(b: Uint8Array | number[]): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** ECDSA MpcSignature → 32-byte r, s (hex, no 0x) and yParity ∈ {0,1}. Accepts v ∈ {0,1,27,28}. */
export function ecdsaParts(sig: MpcSignature): { r: string; s: string; yParity: 0 | 1 } {
  if (!("r" in sig)) throw new Error("expected an ECDSA (r, s, v) MPC signature, got Ed25519");
  const r = sig.r.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const s = sig.s.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const v = sig.v >= 27 ? sig.v - 27 : sig.v;
  if (v !== 0 && v !== 1) throw new Error(`bad recovery id v=${sig.v}`);
  return { r, s, yParity: v };
}

/** Ed25519 MpcSignature → 64 bytes. */
export function ed25519Bytes(sig: MpcSignature): Uint8Array {
  if (!("signature" in sig)) throw new Error("expected an Ed25519 MPC signature, got ECDSA");
  const b = Uint8Array.from(sig.signature);
  if (b.length !== 64) throw new Error(`Ed25519 signature must be 64 bytes, got ${b.length}`);
  return b;
}
