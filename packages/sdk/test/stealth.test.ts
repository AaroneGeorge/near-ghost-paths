import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import {
  PATH_LENGTH,
  buildSweepArgs,
  deriveAddress,
  deriveRecipientKeys,
  ecdh,
  isStealthPath,
  makeTarget,
  metaFromKeys,
  recoverSweepKey,
  scalarToBytes,
  signSweep,
  stealthPath,
  stealthPriv,
  sweepMessage,
  sweepPreimage,
  verifySweepArgs,
  viewTag,
} from "../src/index.ts";
import V from "./vectors.json";

const CONTRACT = "v1.ghost-paths.testnet";
const N = secp256k1.Point.Fn.ORDER;
const G = secp256k1.Point.BASE;

describe("keys", () => {
  test("seed → keys is deterministic and matches the SPEC vector", () => {
    const k = deriveRecipientKeys(hexToBytes(V.seed));
    expect(k.dSpend.toString(16).padStart(64, "0")).toBe(V.d_spend);
    expect(bytesToHex(k.spendPub)).toBe(V.spend_pub);
    expect(bytesToHex(k.viewPriv)).toBe(V.view_priv);
    expect(bytesToHex(k.viewPub)).toBe(V.view_pub);
    expect(deriveRecipientKeys(hexToBytes(V.seed)).dSpend).toBe(k.dSpend);
  });
  test("spend and view keys are domain-separated", () => {
    const k = deriveRecipientKeys(randomBytes(32));
    expect(bytesToHex(scalarToBytes(k.dSpend))).not.toBe(bytesToHex(k.viewPriv));
    expect(() => deriveRecipientKeys(new Uint8Array(31))).toThrow();
  });
});

describe("stealth math", () => {
  test("K == (d_spend + h)·G for random keys on every chain family", () => {
    for (let i = 0; i < 20; i++) {
      const k = deriveRecipientKeys(randomBytes(32));
      const meta = metaFromKeys(k);
      for (const chain of ["evm:31337", "btc:regtest", "sol:local"] as const) {
        const { target } = makeTarget(meta, chain, CONTRACT);
        const dK = stealthPriv(k.dSpend, target.h);
        expect(bytesToHex(G.multiply(dK).toBytes(false))).toBe(bytesToHex(target.K));
        expect(target.h > 0n && target.h < N).toBe(true);
      }
    }
  });

  test("SPEC vector: tag, h, K, path, address, d_K", () => {
    const k = deriveRecipientKeys(hexToBytes(V.seed));
    for (const chain of ["evm:31337", "sol:local", "btc:testnet4"] as const) {
      const v = V[chain];
      const { target, S } = makeTarget(metaFromKeys(k), chain, CONTRACT, {
        eph: hexToBytes("33".repeat(32)),
      });
      expect(target.eph).toBe(v.E);
      expect(bytesToHex(S)).toBe(v.S);
      expect(target.tag).toBe(v.tag);
      expect(target.h.toString(16).padStart(64, "0")).toBe(v.h);
      expect(bytesToHex(target.K)).toBe(v.K);
      expect(target.path).toBe(v.path);
      expect(target.address).toBe(v.address);
      expect(target.domainId).toBe(v.domainId as 0 | 1);
      expect(stealthPriv(k.dSpend, target.h).toString(16).padStart(64, "0")).toBe(v.d_K);
    }
  });

  test("chain tag is bound into h: same E gives different K per chain", () => {
    const meta = metaFromKeys(deriveRecipientKeys(randomBytes(32)));
    const eph = randomBytes(32);
    const a = makeTarget(meta, "evm:31337", CONTRACT, { eph }).target;
    const b = makeTarget(meta, "evm:11155111", CONTRACT, { eph }).target;
    expect(a.tag).toBe(b.tag);
    expect(a.path).not.toBe(b.path);
  });

  test("path format: gp1/ + 64 lowercase hex = 68 chars", () => {
    const { target } = makeTarget(
      metaFromKeys(deriveRecipientKeys(randomBytes(32))),
      "evm:1",
      CONTRACT,
    );
    expect(target.path).toMatch(/^gp1\/[0-9a-f]{64}$/);
    expect(target.path.length).toBe(PATH_LENGTH);
    expect(isStealthPath(target.path)).toBe(true);
    expect(isStealthPath(target.path.toUpperCase())).toBe(false);
    // compressed and uncompressed K give the same path
    const compressed = secp256k1.Point.fromBytes(target.K).toBytes(true);
    expect(stealthPath(compressed)).toBe(target.path);
  });

  test("Mode A uses the recipient account as predecessor (different address)", () => {
    const meta = metaFromKeys(deriveRecipientKeys(randomBytes(32)), "account");
    const eph = randomBytes(32);
    const a = makeTarget(meta, "evm:1", CONTRACT, { eph }).target;
    const b = makeTarget(meta, "evm:1", "bob.testnet", { eph }).target;
    expect(a.path).toBe(b.path);
    expect(a.address).not.toBe(b.address);
    expect(b.address).toBe(deriveAddress("bob.testnet", b.path, "evm:1").address);
  });

  test("view-tag filter: ~1/256 of foreign announcements pass", () => {
    const k = deriveRecipientKeys(randomBytes(32));
    let pass = 0;
    const trials = 4_000;
    for (let i = 0; i < trials; i++) {
      const E = x25519.getPublicKey(randomBytes(32));
      const foreignTag = randomBytes(1)[0] as number;
      if (viewTag(ecdh(k.viewPriv, E)) === foreignTag) pass++;
    }
    // expected 15.6 (sd 3.9); accept 2..40 (> 3.5 sigma either side)
    expect(pass).toBeGreaterThanOrEqual(2);
    expect(pass).toBeLessThanOrEqual(40);
  }, 30_000);

  test("ecdh rejects low-order points (all-zero secret)", () => {
    expect(() => ecdh(randomBytes(32), new Uint8Array(32))).toThrow();
  });
});

describe("sweep message", () => {
  const v = V["evm:31337"];
  const base = {
    contractId: CONTRACT,
    path: v.path,
    domainId: 0 as const,
    payloads: [hexToBytes("55".repeat(32))],
    expiresBlock: 123456789,
  };

  test("preimage and msg match the pinned layout (contract/SWEEP-MESSAGE.md)", () => {
    expect(bytesToHex(sweepPreimage(base))).toBe(V.sweep.preimage);
    expect(bytesToHex(sweepMessage(base))).toBe(V.sweep.msg);
    const pre = sweepPreimage(base);
    expect(new TextDecoder().decode(pre.slice(0, 20))).toBe("ghost-paths/v1/sweep");
    expect(new TextDecoder().decode(pre.slice(20, 20 + CONTRACT.length + 68))).toBe(
      CONTRACT + v.path,
    );
    expect(pre.length).toBe(20 + 22 + 68 + 1 + 8 + 1 + 2 + 32);
    expect(() => sweepPreimage({ ...base, path: "gp1/xyz" })).toThrow();
    expect(() => sweepPreimage({ ...base, contractId: "a/b" })).toThrow();
  });

  test("signature is deterministic, low-s, and recovers to k_pub", () => {
    const msg = sweepMessage(base);
    const s = signSweep(msg, BigInt(`0x${v.d_K}`));
    expect(s.sig).toBe(V.sweep.sig);
    expect(s.v).toBe(V.sweep.v);
    expect(recoverSweepKey(msg, s.sig, s.v)).toBe(V.sweep.k_pub);
    expect(recoverSweepKey(msg, s.sig, s.v ^ 1)).not.toBe(V.sweep.k_pub);
    for (let i = 0; i < 50; i++) {
      const r = signSweep(
        randomBytes(32),
        BigInt(`0x${bytesToHex(secp256k1.utils.randomSecretKey())}`),
      );
      expect(BigInt(`0x${r.sig.slice(64)}`) <= N / 2n).toBe(true);
    }
  });

  test("high-s variant is rejected (contract uses malleability_flag=true)", () => {
    const msg = sweepMessage(base);
    const s = signSweep(msg, BigInt(`0x${v.d_K}`));
    const hi = (N - BigInt(`0x${s.sig.slice(64)}`)).toString(16).padStart(64, "0");
    expect(recoverSweepKey(msg, s.sig.slice(0, 64) + hi, s.v ^ 1)).toBeNull();
  });

  test("every field is bound: changing any input changes msg", () => {
    const m0 = bytesToHex(sweepMessage(base));
    const variants = [
      { ...base, contractId: "v2.ghost-paths.testnet" },
      { ...base, path: `gp1/${"0".repeat(64)}` },
      { ...base, domainId: 1 as const },
      { ...base, expiresBlock: 123456790 },
      { ...base, payloads: [hexToBytes(`${"55".repeat(31)}56`)] },
      { ...base, payloads: [hexToBytes("55".repeat(32)), hexToBytes("55")] },
      { ...base, payloads: [hexToBytes("55".repeat(33))] },
    ];
    for (const x of variants) expect(bytesToHex(sweepMessage(x))).not.toBe(m0);
  });

  test("W2 canonical inputs (contract/src/tests.rs::canonical_vectors) → pinned digest + sig", () => {
    for (const c of V.contract_vectors) {
      const K = secp256k1.getPublicKey(hexToBytes(c.d_K), false);
      expect(bytesToHex(K.slice(1))).toBe(c.k_pub);
      expect(stealthPath(K)).toBe(c.path);
      const msg = sweepMessage({
        contractId: CONTRACT,
        path: c.path,
        domainId: c.domain_id as 0 | 1,
        payloads: [hexToBytes(c.payload)],
        expiresBlock: 123456789,
      });
      expect(bytesToHex(msg)).toBe(c.digest);
      expect(signSweep(msg, BigInt(`0x${c.d_K}`))).toEqual({ sig: c.sig, v: c.v });
    }
  });

  test("buildSweepArgs / verifySweepArgs round-trip and rejections", () => {
    const k = deriveRecipientKeys(hexToBytes(V.seed));
    const { target } = makeTarget(metaFromKeys(k), "evm:31337", CONTRACT, {
      eph: hexToBytes("33".repeat(32)),
    });
    const args = buildSweepArgs({
      contractId: CONTRACT,
      target,
      dSpend: k.dSpend,
      payloads: base.payloads,
      expiresBlock: base.expiresBlock,
    });
    expect(args).toEqual({
      path: v.path,
      domain_id: 0,
      payloads: ["55".repeat(32)],
      expires_block: 123456789,
      k_pub: V.sweep.k_pub,
      sig: V.sweep.sig,
      v: V.sweep.v,
    });
    expect(verifySweepArgs(CONTRACT, args)).toBe(true);
    expect(verifySweepArgs("other.testnet", args)).toBe(false);
    expect(verifySweepArgs(CONTRACT, { ...args, payloads: ["66".repeat(32)] })).toBe(false);
    expect(verifySweepArgs(CONTRACT, { ...args, expires_block: args.expires_block + 1 })).toBe(
      false,
    );
    const otherK = bytesToHex(G.multiply(5n).toBytes(false).slice(1));
    expect(verifySweepArgs(CONTRACT, { ...args, k_pub: otherK })).toBe(false);
    // wrong spend key cannot build args for this target
    const wrong = deriveRecipientKeys(randomBytes(32));
    expect(() =>
      buildSweepArgs({
        contractId: CONTRACT,
        target,
        dSpend: wrong.dSpend,
        payloads: base.payloads,
        expiresBlock: 1,
      }),
    ).toThrow();
  });
});
