import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import {
  type Announcement,
  MemoryRegistry,
  type MpcSignature,
  type NearProvider,
  PINNED_CODE_HASH,
  buildAnnouncement,
  buildSweepArgs,
  decodeAnnouncement,
  decryptMemo,
  deriveRecipientKeys,
  encryptMemo,
  generateSeed,
  keysFromKeystore,
  loadKeystore,
  makeKeystore,
  makeTarget,
  metaFromKeys,
  parseViewingBundle,
  predecessorFor,
  saveKeystore,
  scan,
  scanAnnouncements,
  scanOne,
  scanRegistry,
  validateAnnounceArgs,
  verifyContractCode,
  viewingBundle,
} from "../src/index.ts";
import V from "./vectors.json";

const CONTRACT = "v1.ghost-paths.testnet";

describe("memo encryption", () => {
  const v = V["evm:31337"];
  const S = hexToBytes(v.S);
  const E = hexToBytes(v.E);
  test("SPEC vector ciphertext and round-trip", () => {
    const memo = { amount: "0.01", asset: "ETH", note: "invoice #42" };
    expect(encryptMemo(S, E, "evm:31337", memo, hexToBytes("44".repeat(24)))).toBe(v.ct);
    expect(decryptMemo(S, E, "evm:31337", v.ct)).toEqual(memo);
  });
  test("wrong key / wrong chain (AAD) / tampering → null", () => {
    expect(decryptMemo(randomBytes(32), E, "evm:31337", v.ct)).toBeNull();
    expect(decryptMemo(S, E, "evm:1", v.ct)).toBeNull();
    expect(decryptMemo(S, randomBytes(32), "evm:31337", v.ct)).toBeNull();
    const flipped = v.ct.slice(0, -2) + (v.ct.endsWith("00") ? "01" : "00");
    expect(decryptMemo(S, E, "evm:31337", flipped)).toBeNull();
    expect(decryptMemo(S, E, "evm:31337", "zz")).toBeNull();
  });
  test("oversized memo rejected; fits contract ct cap", () => {
    expect(() => encryptMemo(S, E, "evm:1", { note: "x".repeat(300) })).toThrow();
    const ct = encryptMemo(S, E, "evm:1", { note: "x".repeat(150) });
    expect(ct.length).toBeLessThanOrEqual(512);
  });
});

describe("announcement codec", () => {
  test("build → validate → decode round-trip has no recipient field", () => {
    const meta = metaFromKeys(deriveRecipientKeys(randomBytes(32)));
    const { target, S } = makeTarget(meta, "sol:local", CONTRACT);
    const args = buildAnnouncement(target, S, { amount: "0.1", asset: "SOL" });
    expect(Object.keys(args).sort()).toEqual(["chain", "ct", "eph", "tag"]);
    expect(validateAnnounceArgs(args)).toEqual(args);
    const raw = {
      idx: "7",
      ...args,
      block_height: 100,
      timestamp_ms: "1700000000000",
      announcer: "x.testnet",
    };
    const a = decodeAnnouncement(raw);
    expect(a.idx).toBe(7);
    expect(a.timestamp_ms).toBe(1700000000000);
    expect(decodeAnnouncement({ ...raw, ct: null }).ct).toBeUndefined();
  });
  test("validation rejects bad input", () => {
    const ok = { chain: "evm:1" as const, eph: "ab".repeat(32), tag: 3 };
    expect(() => validateAnnounceArgs({ ...ok, chain: "doge:1" as never })).toThrow();
    expect(() => validateAnnounceArgs({ ...ok, eph: "ab" })).toThrow();
    expect(() => validateAnnounceArgs({ ...ok, eph: `0x${"ab".repeat(31)}` })).toThrow();
    expect(() => validateAnnounceArgs({ ...ok, tag: 256 })).toThrow();
    expect(() => validateAnnounceArgs({ ...ok, ct: "a".repeat(514) })).toThrow();
  });
});

function setup() {
  const bobSeed = generateSeed();
  const bob = makeKeystore({ seed: bobSeed, account: "bob.testnet", signer: CONTRACT });
  const carol = makeKeystore({ seed: generateSeed(), account: "carol.testnet", signer: CONTRACT });
  const signed: MpcSignature = { r: "11".repeat(32), s: "22".repeat(32), v: 0 };
  const reg = new MemoryRegistry({
    contractId: CONTRACT,
    caller: "alice.testnet",
    signer: async () => signed,
  });
  return { bob, carol, reg, signed };
}

describe("scan", () => {
  test("recipient finds its payments, a stranger finds none, the auditor finds the same", async () => {
    const { bob, carol, reg } = setup();
    await reg.as("bob.testnet").register(metaFromKeys(keysFromKeystore(bob)));
    await reg.as("carol.testnet").register(metaFromKeys(keysFromKeystore(carol)));
    const bobMeta = await reg.getMeta("bob.testnet");
    if (!bobMeta) throw new Error("no meta");
    const pred = predecessorFor(bobMeta.mode, CONTRACT, "bob.testnet");
    const sent: { idx: number; address: string; path: string }[] = [];
    for (const [chain, memo] of [
      ["evm:31337", { amount: "0.01", asset: "ETH", note: "invoice #42" }],
      ["sol:local", undefined],
    ] as const) {
      const { target, S } = makeTarget(bobMeta, chain, pred);
      const r = await reg.announce(buildAnnouncement(target, S, memo));
      sent.push({ idx: r.idx, address: target.address, path: target.path });
    }
    // noise: 300 announcements for carol
    const carolMeta = (await reg.getMeta("carol.testnet")) as NonNullable<
      Awaited<ReturnType<typeof reg.getMeta>>
    >;
    for (let i = 0; i < 300; i++) {
      const { target, S } = makeTarget(carolMeta, "evm:31337", CONTRACT);
      await reg.announce(buildAnnouncement(target, S, i % 2 ? { note: `c${i}` } : undefined));
    }
    const all = await reg.getAnnouncements(0, 200);
    expect(all).toHaveLength(200);

    const { hits, next, scanned } = await scanRegistry(reg, viewingBundle(bob), { pageSize: 100 });
    expect(scanned).toBe(302);
    expect(next).toBe(302);
    // carol's unmemo'd announcements can pass the 1-byte tag (~1/256 of 150); memo'd ones never do
    const real = hits.filter((h) => sent.some((s) => s.idx === h.idx));
    expect(real.map((h) => h.address)).toEqual(sent.map((s) => s.address));
    expect(hits.length - real.length).toBeLessThan(6);
    expect(real[0]?.memo).toEqual({ amount: "0.01", asset: "ETH", note: "invoice #42" });
    expect(real[1]?.domainId).toBe(1);

    const auditor = parseViewingBundle(JSON.parse(JSON.stringify(viewingBundle(bob))));
    expect("seed" in auditor).toBe(false);
    const audHits = (await scanRegistry(reg, auditor)).hits.filter((h) =>
      sent.some((s) => s.idx === h.idx),
    );
    expect(audHits.map((h) => h.path)).toEqual(sent.map((s) => s.path));

    const carolHits = scanAnnouncements(await reg.getAnnouncements(0, 2), viewingBundle(carol));
    expect(carolHits).toHaveLength(0);
  }, 60_000);

  test("no-view-tag announcements are found only in full mode, via the memo AEAD", () => {
    const { bob, carol } = setup();
    const meta = metaFromKeys(keysFromKeystore(bob));
    const { target, S } = makeTarget(meta, "evm:31337", CONTRACT, { noViewTag: true });
    const a: Announcement = {
      idx: 0,
      ...buildAnnouncement(target, S, { note: "hi" }),
      block_height: 1,
      timestamp_ms: 1,
      announcer: "a",
    };
    expect(scanOne(a, viewingBundle(bob), { full: true })?.address).toBe(target.address);
    expect(scanOne(a, viewingBundle(carol), { full: true })).toBeNull();
    const noMemo: Announcement = { ...a, ct: undefined };
    expect(scanOne(noMemo, viewingBundle(bob), { full: true })).toBeNull();
  });

  test("scan() attaches balances and marks swept", async () => {
    const { bob } = setup();
    const meta = metaFromKeys(keysFromKeystore(bob));
    const anns: Announcement[] = [];
    const addrs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { target, S } = makeTarget(meta, "evm:31337", CONTRACT);
      addrs.push(target.address);
      anns.push({
        idx: i,
        ...buildAnnouncement(target, S, { note: `${i}` }),
        block_height: 1,
        timestamp_ms: 1,
        announcer: "a",
      });
    }
    const balances: Record<string, bigint> = {
      [addrs[0] as string]: 10n,
      [addrs[1] as string]: 0n,
      [addrs[2] as string]: 0n,
    };
    const adapter = {
      getBalance: async (a: string) => ({ balance: balances[a] ?? 0n, decimals: 18 }),
    };
    const pays = await scan(
      anns,
      viewingBundle(bob),
      { "evm:31337": adapter },
      { seen: new Set([1]) },
    );
    expect(pays.map((p) => [p.balance, p.swept])).toEqual([
      [10n, false],
      [0n, true],
      [0n, false],
    ]);
    const none = await scan(anns, viewingBundle(bob), {});
    expect(none.every((p) => p.balance === 0n && p.decimals === 18)).toBe(true);
  });
});

describe("MemoryRegistry sweep (contract rules)", () => {
  test("good sig → fake MPC signature; expired / tampered rejected", async () => {
    const { bob, reg, signed } = setup();
    const keys = keysFromKeystore(bob);
    const { target } = makeTarget(metaFromKeys(keys), "evm:31337", CONTRACT);
    const payload = randomBytes(32);
    const exp = reg.blockHeight + 10;
    const args = buildSweepArgs({
      contractId: CONTRACT,
      target,
      dSpend: keys.dSpend,
      payloads: [payload],
      expiresBlock: exp,
    });
    const relayer = reg.as("relayer.testnet");
    expect((await relayer.sweep(args)).signature).toEqual(signed);
    await expect(
      relayer.sweep({ ...args, payloads: [bytesToHex(randomBytes(32))] }),
    ).rejects.toThrow("authorisation");
    await expect(
      relayer.sweep({ ...args, payloads: [args.payloads[0] as string, "00"] }),
    ).rejects.toThrow("one payload");
    reg.advance(20);
    await expect(relayer.sweep(args)).rejects.toThrow("expired");
  });
  test("register validates meta and keys by predecessor", async () => {
    const { reg } = setup();
    await expect(
      reg.register({
        v: 1,
        mode: "contract",
        spend_pub: "00".repeat(33),
        view_pub: "00".repeat(32),
      }),
    ).rejects.toThrow();
    expect(await reg.getMeta("nobody.testnet")).toBeNull();
  });
});

describe("keystore", () => {
  test("save (0600) / load round-trip; tampered keystore rejected", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(`${os.tmpdir()}/ghost-ks-`);
    const ks = makeKeystore({ seed: generateSeed(), account: "bob.testnet", signer: CONTRACT });
    const file = `${dir}/bob.json`;
    await saveKeystore(file, ks);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadKeystore(file)).toEqual(ks);
    expect(ks.network).toBe("testnet");
    await fs.writeFile(
      file,
      JSON.stringify({
        ...ks,
        spend_pub: makeKeystore({ seed: generateSeed(), account: "x", signer: CONTRACT }).spend_pub,
      }),
    );
    await expect(loadKeystore(file)).rejects.toThrow();
    await fs.rm(dir, { recursive: true });
  });
});

describe("toMpcSignature", () => {
  test("parses v1.signer Secp256k1 / Ed25519 results and relayer {r,s,v}", async () => {
    const { toMpcSignature } = await import("../src/index.ts");
    const R = `02${"AB".repeat(32)}`;
    expect(
      toMpcSignature({
        scheme: "Secp256k1",
        big_r: { affine_point: R },
        s: { scalar: "CD".repeat(32) },
        recovery_id: 1,
      }),
    ).toEqual({ r: "ab".repeat(32), s: "cd".repeat(32), v: 1 });
    expect(toMpcSignature({ scheme: "Ed25519", signature: [1, 2, 3] })).toEqual({
      scheme: "Ed25519",
      signature: [1, 2, 3],
    });
    expect(toMpcSignature({ r: `0x${"AA".repeat(32)}`, s: "bb".repeat(32), v: 27 })).toEqual({
      r: "aa".repeat(32),
      s: "bb".repeat(32),
      v: 0,
    });
    expect(() => toMpcSignature({ r: "aa", s: "bb", v: 5 })).toThrow();
    expect(() => toMpcSignature({ foo: 1 })).toThrow();
  });
});

describe("scan robustness (REVIEW W6-H2)", () => {
  test("an announcement crafted on an unsupported chain cannot fail the whole scan", async () => {
    const ks = makeKeystore({ seed: generateSeed(), account: "bob.testnet", signer: CONTRACT });
    const meta = metaFromKeys(deriveRecipientKeys(hexToBytes(ks.seed)));
    // The attacker needs only the public meta-address.
    const evil = makeTarget(meta, "evm:424242", CONTRACT, { network: "testnet" });
    const good = makeTarget(meta, "evm:31337", CONTRACT, { network: "testnet" });
    const list: Announcement[] = [evil, good].map(({ target, S }, idx) => ({
      idx,
      ...buildAnnouncement(target, S, { note: `#${idx}` }),
      block_height: 1,
      timestamp_ms: 1,
      announcer: "mallory.testnet",
    }));
    const payments = await scan(list, viewingBundle(ks), (chain) => {
      if (chain !== "evm:31337") throw new Error(`no RPC for ${chain}`);
      return { getBalance: async () => ({ balance: 5n, decimals: 18 }) };
    });
    expect(payments.map((p) => [p.idx, p.balance])).toEqual([
      [0, 0n],
      [1, 5n],
    ]);
  });
});

describe("REVIEW L3 / M2", () => {
  test("a re-posted announcement is one payment (dedupe by E, chain, address)", () => {
    const ks = makeKeystore({ seed: generateSeed(), account: "bob.testnet", signer: CONTRACT });
    const meta = metaFromKeys(deriveRecipientKeys(hexToBytes(ks.seed)));
    const { target, S } = makeTarget(meta, "evm:31337", CONTRACT, { network: "testnet" });
    const args = buildAnnouncement(target, S, { note: "once" });
    const list: Announcement[] = [0, 1, 2].map((idx) => ({
      idx,
      ...args,
      block_height: 1,
      timestamp_ms: 1,
      announcer: idx ? "mallory.testnet" : "alice.testnet",
    }));
    const hits = scanAnnouncements(list, viewingBundle(ks));
    expect(hits.map((h) => h.idx)).toEqual([0]);
  });

  test("verifyContractCode: pinned testnet hash, refuses a different code, refuses unpinned mainnet", async () => {
    const provider = (code_hash: string) =>
      ({ viewAccount: async () => ({ code_hash }) }) as unknown as NearProvider;
    const saved = process.env.GHOST_CODE_HASH;
    process.env.GHOST_CODE_HASH = "";
    try {
      const pin = PINNED_CODE_HASH.testnet as string;
      expect(
        (await verifyContractCode("testnet", CONTRACT, { provider: provider(pin) })).codeHash,
      ).toBe(pin);
      await expect(
        verifyContractCode("testnet", "evil.testnet", {
          provider: provider("11111111111111111111111111111111"),
        }),
      ).rejects.toThrow(/not the pinned/);
      await expect(
        verifyContractCode("mainnet", "ghost-paths.near", { provider: provider(pin) }),
      ).rejects.toThrow(/no pinned Ghost Paths code hash/);
    } finally {
      // biome-ignore lint/performance/noDelete: an env var must be removed, not set to "undefined"
      if (saved === undefined) delete process.env.GHOST_CODE_HASH;
      else process.env.GHOST_CODE_HASH = saved;
    }
  });
});
