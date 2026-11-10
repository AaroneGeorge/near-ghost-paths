import { describe, expect, test } from "bun:test";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  addressFromPublicKey,
  checkDerivation,
  checkRootKeys,
  deriveAddress,
  derivePublicKey,
  deriveRecipientKeys,
  makeTarget,
  metaFromKeys,
  networkOf,
  toChecksumAddress,
} from "../src/index.ts";
import V from "./vectors.json";

const CONTRACT = "v1.ghost-paths.testnet";
const PATH_AB = `gp1/${"ab".repeat(32)}`;
/** No network under `make test` (GHOST_REPLAY=1) or OFFLINE=1; live RPC otherwise (free view calls). */
const OFFLINE = process.env.GHOST_REPLAY === "1" || process.env.OFFLINE === "1";

// Recorded 2026-11-09 from v1.signer-prod.testnet `derived_public_key` (block ~276825661).
const RECORDED = [
  {
    predecessor: CONTRACT,
    path: PATH_AB,
    domain_id: 0 as const,
    derived:
      "secp256k1:BSjeAgh1CBr9Cm196WNVyNpsFTfWRAGqeNDtZCfswfuk6XcQL2zqpVx7efXQDUmGBRpwU3svvnfXvQs1MGrHLwv",
  },
  {
    predecessor: CONTRACT,
    path: PATH_AB,
    domain_id: 1 as const,
    derived: "ed25519:8f6Pmk8tuN6sFbMXoSF1FFz2wGmZkk1q72PMdw7zpUvm",
  },
];

describe("derivation (offline)", () => {
  test("local derivation equals recorded signer output", () => {
    for (const r of RECORDED)
      expect(derivePublicKey(r.predecessor, r.path, r.domain_id, "testnet").naj).toBe(r.derived);
  });
  test("addresses match chainsig.js adapters (cross-checked 2026-11-09)", () => {
    expect(deriveAddress(CONTRACT, PATH_AB, "evm:1").address).toBe(
      "0x5c7dad9d2e0B89E71F3ceB876c270AB1013CcAb9",
    );
    expect(deriveAddress(CONTRACT, PATH_AB, "btc:testnet4").address).toBe(
      "tb1qshvntagprslsmtj9306x4nlwgkwq54fl8xucmu",
    );
    expect(deriveAddress(CONTRACT, PATH_AB, "sol:devnet").address).toBe(
      "8f6Pmk8tuN6sFbMXoSF1FFz2wGmZkk1q72PMdw7zpUvm",
    );
    expect(deriveAddress(CONTRACT, PATH_AB, "btc:regtest").address.startsWith("bcrt1q")).toBe(true);
    expect(
      deriveAddress(CONTRACT, PATH_AB, "btc:mainnet", "mainnet").address.startsWith("bc1q"),
    ).toBe(true);
    expect(deriveAddress(CONTRACT, PATH_AB, "btc:testnet4").publicKey).toMatch(
      /^0[23][0-9a-f]{64}$/,
    );
    expect(deriveAddress(CONTRACT, PATH_AB, "evm:1").publicKey).toMatch(/^04[0-9a-f]{128}$/);
  });
  test("predecessor and network both change the key", () => {
    const a = derivePublicKey(CONTRACT, PATH_AB, 0).naj;
    expect(derivePublicKey("other.testnet", PATH_AB, 0).naj).not.toBe(a);
    expect(derivePublicKey(CONTRACT, PATH_AB, 0, "mainnet").naj).not.toBe(a);
  });
  test("helpers", () => {
    expect(networkOf("v1.ghost-paths.testnet")).toBe("testnet");
    expect(networkOf("ghost-paths.near")).toBe("mainnet");
    // EIP-55 reference vector
    expect(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );
    expect(() => addressFromPublicKey("sol:local", new Uint8Array(33))).toThrow();
  });
});

describe.skipIf(OFFLINE)("derivation (live testnet RPC, free view calls)", () => {
  test("root keys in chainsig.js == v1.signer-prod.testnet public_key (domains 0, 1)", async () => {
    const r = await checkRootKeys("testnet");
    expect(r.domains.map((d) => d.ok)).toEqual([true, true]);
  }, 30_000);

  test("deriveAddress(contract, stealth path) == RPC derived_public_key for domains 0 and 1", async () => {
    const meta = metaFromKeys(deriveRecipientKeys(randomBytes(32)));
    const evm = makeTarget(meta, "evm:31337", CONTRACT).target;
    const sol = makeTarget(meta, "sol:local", CONTRACT).target;
    const cases = [
      [CONTRACT, evm.path, 0],
      [CONTRACT, sol.path, 1],
      [CONTRACT, V["evm:31337"].path, 0],
      [CONTRACT, V["sol:local"].path, 1],
      ["bob.testnet", evm.path, 0], // Mode A predecessor
    ] as const;
    for (const [pred, path, d] of cases) {
      const r = await checkDerivation(pred, path, d, "testnet");
      expect(r.remote).toBe(r.local);
    }
    // and the address the SDK pays is built from exactly that key
    const remote0 = derivePublicKey(CONTRACT, evm.path, 0).bytes;
    expect(addressFromPublicKey("evm:31337", remote0)).toBe(evm.address);
  }, 60_000);
});
