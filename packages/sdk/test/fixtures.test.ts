/**
 * Offline fixture tests (W5). They check the recorded, real MPC signatures in
 * demo/fixtures/live-sweep-testnet.json against the SDK, with no network at all:
 *
 *   1. the derived key in the fixture == local derivation from the MPC root key (the "address
 *      equals what v1.signer signs for" claim);
 *   2. the MPC signature recovers to / verifies under that derived key, for secp256k1 (ECDSA,
 *      domain 0) and ed25519 (EdDSA, domain 1);
 *   3. the key is derived from the Ghost Paths *contract* (the MPC predecessor), not from the
 *      account that submitted the transaction (Mode B);
 *   4. the recorded sweep authorisation verifies under the SDK, and every tamper is rejected;
 *   5. the replay tapes used by `make demo-replay` are complete and carry no key material.
 *
 * Re-record with `LIVE=1 cargo test --manifest-path contract/Cargo.toml --test live_testnet -- --nocapture`
 * (then copy contract/fixtures/live-sweep-testnet.json to demo/fixtures/). `make test-live` is the
 * TypeScript equivalent that signs fresh payloads and never touches these files.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import {
  type SweepArgs,
  deriveAddress,
  derivePublicKey,
  isStealthPath,
  rootPublicKey,
  toMpcSignature,
  verifySweepArgs,
} from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = join(ROOT, "demo/fixtures/live-sweep-testnet.json");
const REPLAY = join(ROOT, "demo/fixtures/replay");

interface Case {
  predecessor: string;
  caller: string;
  path: string;
  domain_id: 0 | 1;
  derived_pub: string;
  address: string;
  payload: string;
  signature: unknown;
  recovered_ok: boolean;
  sweep_args: SweepArgs;
  tx_hash: string;
}
interface Fixture {
  network: "testnet";
  signer: string;
  contract: string;
  root_keys: Record<"0" | "1", string>;
  k_pub: string;
  cases: Case[];
}

const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
const ecdsaCase = fx.cases.find((c) => c.domain_id === 0) as Case;
const eddsaCase = fx.cases.find((c) => c.domain_id === 1) as Case;

describe("recorded MPC signatures (v1.signer-prod.testnet via v1.ghost-paths.testnet)", () => {
  test("fixture shape: one ECDSA and one EdDSA case from the Ghost Paths contract", () => {
    expect(fx.network).toBe("testnet");
    expect(fx.signer).toBe("v1.signer-prod.testnet");
    expect(fx.contract).toBe("v1.ghost-paths.testnet");
    expect(fx.cases.map((c) => c.domain_id).sort()).toEqual([0, 1]);
    for (const c of fx.cases) {
      expect(c.predecessor).toBe(fx.contract);
      expect(isStealthPath(c.path)).toBe(true);
      expect(c.recovered_ok).toBe(true);
      expect(c.tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    }
  });

  test("root keys recorded from the signer equal the keys hardcoded in chainsig.js", () => {
    expect(fx.root_keys["0"]).toBe(rootPublicKey("testnet", 0));
    expect(fx.root_keys["1"]).toBe(rootPublicKey("testnet", 1));
  });

  test("derived key and address in the fixture == local derivation (both domains)", () => {
    for (const c of fx.cases) {
      const d = derivePublicKey(c.predecessor, c.path, c.domain_id, "testnet");
      expect(d.naj).toBe(c.derived_pub);
    }
    // domain 0 -> EVM address; domain 1 -> the Solana address is the base58 ed25519 key
    expect(
      deriveAddress(ecdsaCase.predecessor, ecdsaCase.path, "evm:1").address.toLowerCase(),
    ).toBe(ecdsaCase.address.toLowerCase());
    expect(deriveAddress(eddsaCase.predecessor, eddsaCase.path, "sol:devnet").address).toBe(
      eddsaCase.address,
    );
  });

  test("secp256k1 (domain 0): the MPC ECDSA signature recovers to derive(contract, path)", () => {
    const sig = toMpcSignature(ecdsaCase.signature);
    if (!("r" in sig)) throw new Error("expected an ECDSA signature");
    const payload = hexToBytes(ecdsaCase.payload);
    expect(payload.length).toBe(32);
    const rs = hexToBytes(sig.r + sig.s);
    const recovered = secp256k1.Signature.fromBytes(rs, "compact")
      .addRecoveryBit(sig.v)
      .recoverPublicKey(payload)
      .toBytes(false);
    const expected = derivePublicKey(ecdsaCase.predecessor, ecdsaCase.path, 0).bytes;
    expect(bytesToHex(recovered)).toBe(bytesToHex(expected));
    // and it is a valid signature under that key
    expect(
      secp256k1.verify(rs, payload, expected, { prehash: false, lowS: false, format: "compact" }),
    ).toBe(true);
  });

  test("ed25519 (domain 1): the MPC EdDSA signature verifies under derive(contract, path)", () => {
    const sig = toMpcSignature(eddsaCase.signature);
    if (!("signature" in sig)) throw new Error("expected an Ed25519 signature");
    const message = hexToBytes(eddsaCase.payload);
    expect(message.length).toBeGreaterThan(32); // a full Solana message, not a 32-byte hash
    const pub = derivePublicKey(eddsaCase.predecessor, eddsaCase.path, 1).bytes;
    expect(base58.encode(pub)).toBe(eddsaCase.address);
    expect(ed25519.verify(Uint8Array.from(sig.signature), message, pub)).toBe(true);
    // negative control: one flipped bit in the message must fail
    const bad = Uint8Array.from(message);
    bad[0] = (bad[0] as number) ^ 1;
    expect(ed25519.verify(Uint8Array.from(sig.signature), bad, pub)).toBe(false);
  });

  test("Mode B: the key is derived from the contract, not from the submitting account", () => {
    for (const c of fx.cases) {
      expect(c.caller).not.toBe(c.predecessor);
      const callerKey = derivePublicKey(c.caller, c.path, c.domain_id, "testnet").naj;
      expect(callerKey).not.toBe(c.derived_pub);
    }
    // the ECDSA signature does not recover to the caller-derived key either
    const sig = toMpcSignature(ecdsaCase.signature);
    if (!("r" in sig)) throw new Error("expected an ECDSA signature");
    const recovered = secp256k1.Signature.fromBytes(hexToBytes(sig.r + sig.s), "compact")
      .addRecoveryBit(sig.v)
      .recoverPublicKey(hexToBytes(ecdsaCase.payload))
      .toBytes(false);
    const callerBytes = derivePublicKey(ecdsaCase.caller, ecdsaCase.path, 0).bytes;
    expect(bytesToHex(recovered)).not.toBe(bytesToHex(callerBytes));
  });
});

describe("recorded sweep authorisations (the ecrecover check the contract performs)", () => {
  test("path = gp1/sha256(k_pub) and the signature by K verifies for both cases", () => {
    for (const c of fx.cases) {
      const a = c.sweep_args;
      expect(a.k_pub).toBe(fx.k_pub);
      expect(a.path).toBe(`gp1/${bytesToHex(sha256(hexToBytes(a.k_pub)))}`);
      expect(a.payloads).toEqual([c.payload]);
      expect(verifySweepArgs(fx.contract, a)).toBe(true);
    }
  });

  test("tampering with any bound field makes the authorisation fail", () => {
    const a = ecdsaCase.sweep_args;
    const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    expect(verifySweepArgs("v1.other.testnet", a)).toBe(false); // other deployment
    expect(verifySweepArgs(fx.contract, { ...a, payloads: [flip(a.payloads[0] as string)] })).toBe(
      false,
    ); // other destination / payload
    expect(verifySweepArgs(fx.contract, { ...a, expires_block: a.expires_block + 1 })).toBe(false);
    expect(verifySweepArgs(fx.contract, { ...a, domain_id: 1 })).toBe(false);
    expect(verifySweepArgs(fx.contract, { ...a, sig: flip(a.sig) })).toBe(false);
    expect(verifySweepArgs(fx.contract, { ...a, v: a.v ^ 1 })).toBe(false);
    expect(verifySweepArgs(fx.contract, { ...a, path: `gp1/${"00".repeat(32)}` })).toBe(false);
  });
});

describe("replay tapes (make demo-replay)", () => {
  const manifest = JSON.parse(readFileSync(join(REPLAY, "manifest.json"), "utf8")) as {
    steps: string[];
    contract: string;
    chains: string[];
  };

  test("manifest lists the recorded run and every step has a tape", () => {
    expect(manifest.contract).toBe("v1.ghost-paths.testnet");
    expect(manifest.chains).toEqual(["evm:31337", "sol:local"]);
    expect(manifest.steps.length).toBeGreaterThanOrEqual(20);
    for (const s of manifest.steps) expect(existsSync(join(REPLAY, `${s}.jsonl`))).toBe(true);
    expect(existsSync(join(REPLAY, "relayer.jsonl"))).toBe(true);
  });

  test("every tape line is JSON, and no fixture file contains a secret-key field", () => {
    const files = readdirSync(REPLAY).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(20);
    const forbidden = /"(secret_key|private_key|privateKey|view_priv|d_spend|seed)"\s*:/;
    for (const f of files) {
      const text = readFileSync(join(REPLAY, f), "utf8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        JSON.parse(line);
      }
      expect(forbidden.test(text)).toBe(false);
    }
    expect(forbidden.test(readFileSync(FIXTURE, "utf8"))).toBe(false);
  });
});
