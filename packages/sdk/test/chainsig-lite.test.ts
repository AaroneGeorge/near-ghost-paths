/** chainsig-lite (the web build's stand-in for chainsig.js) must derive exactly what chainsig.js derives. */
import { describe, expect, test } from "bun:test";
import { constants as real, utils as realUtils } from "chainsig.js";
import { constants, utils } from "../src/chainsig-lite.ts";

const R = realUtils.cryptography;
const S = utils.cryptography;
const cases: [string, string][] = [
  ["v1.ghost-paths.testnet", "gp1/00"],
  ["v1.ghost-paths.testnet", `gp1/${"ab".repeat(32)}`],
  ["ghost-paths.near", `gp1/${"0f".repeat(32)}`],
  ["alice.testnet", ""],
  ["x", "ethereum-1"],
];

describe("chainsig-lite", () => {
  test("root keys match", () => {
    expect(constants.ROOT_PUBLIC_KEYS).toEqual(real.ROOT_PUBLIC_KEYS as never);
  });
  for (const env of ["TESTNET", "MAINNET"] as const) {
    test(`secp256k1 + ed25519 child keys match (${env})`, () => {
      const k = real.ROOT_PUBLIC_KEYS[env];
      const root = R.najToUncompressedPubKeySEC1(k.secp256k1 as never);
      expect(S.najToUncompressedPubKeySEC1(k.secp256k1)).toBe(root);
      for (const [p, path] of cases) {
        expect(S.deriveChildPublicKey(root, p, path)).toBe(
          R.deriveChildPublicKey(root as never, p, path),
        );
        expect(S.deriveChildPublicKeyEd25519(k.ed25519, p, path)).toBe(
          R.deriveChildPublicKeyEd25519(k.ed25519 as never, p, path),
        );
      }
    });
  }
});
