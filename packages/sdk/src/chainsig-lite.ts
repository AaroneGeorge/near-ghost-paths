/**
 * Browser stand-in for the two parts of chainsig.js the SDK's derive.ts uses (ROOT_PUBLIC_KEYS and
 * the child-key derivation), on @noble/curves. The real package drags a full multi-chain wallet
 * stack (~7 MB) into the pay page. apps/web/vite.config.ts aliases `chainsig.js` here for the web build only;
 * test/chainsig-lite.test.ts checks it byte-for-byte against chainsig.js.
 *
 *   epsilon = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)
 *   secp256k1: child = root + int_be(epsilon)·G      ed25519: child = root + (int_le(epsilon) mod L)·B
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

const epsilon = (predecessor: string, path: string) =>
  sha3_256(utf8ToBytes(`near-mpc-recovery v0.1.0 epsilon derivation:${predecessor},${path}`));

const le = (b: Uint8Array) => BigInt(`0x${bytesToHex(Uint8Array.from(b).reverse()) || "0"}`);

function deriveChildPublicKey(
  parentUncompressedHex: string,
  predecessor: string,
  path = "",
): string {
  const P = secp256k1.Point.fromHex(parentUncompressedHex);
  const e = BigInt(`0x${bytesToHex(epsilon(predecessor, path))}`) % secp256k1.Point.Fn.ORDER;
  return P.add(secp256k1.Point.BASE.multiply(e)).toHex(false);
}

function deriveChildPublicKeyEd25519(rootNaj: string, predecessor: string, path = ""): string {
  const R = ed25519.Point.fromBytes(base58.decode(rootNaj.split(":")[1] as string));
  const e = le(epsilon(predecessor, path)) % ed25519.Point.Fn.ORDER;
  return `ed25519:${base58.encode(R.add(ed25519.Point.BASE.multiply(e)).toBytes())}`;
}

function najToUncompressedPubKeySEC1(naj: string): string {
  return `04${bytesToHex(base58.decode(naj.split(":")[1] as string))}`;
}

export const constants = {
  ROOT_PUBLIC_KEYS: {
    TESTNET: {
      secp256k1:
        "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3",
      ed25519: "ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2",
    },
    MAINNET: {
      secp256k1:
        "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya",
      ed25519: "ed25519:G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF",
    },
  },
};

export const utils = {
  cryptography: { deriveChildPublicKey, deriveChildPublicKeyEd25519, najToUncompressedPubKeySEC1 },
};
