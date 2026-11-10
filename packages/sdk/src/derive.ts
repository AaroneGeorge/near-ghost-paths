/**
 * Chain Signatures derivation (docs/SPEC.md §4). Local and synchronous: wraps chainsig.js
 * `utils.cryptography.deriveChildPublicKey[Ed25519]`, which implements near/mpc's
 *   epsilon = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)
 * and is checked byte-for-byte against the signer's `derived_public_key` view in the tests.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, bech32 } from "@scure/base";
import { constants as csConstants, utils as csUtils } from "chainsig.js";
import { BTC_HRP, MPC_CONTRACT, domainForChain } from "./constants.ts";
import type { ChainTag, DomainId, NearNetwork } from "./types.ts";

const { deriveChildPublicKey, deriveChildPublicKeyEd25519, najToUncompressedPubKeySEC1 } =
  csUtils.cryptography;

/** `*.testnet` (and the bare `testnet`) → testnet; everything else → mainnet. */
export function networkOf(accountId: string): NearNetwork {
  return accountId === "testnet" || accountId.endsWith(".testnet") ? "testnet" : "mainnet";
}

/** MPC root public key (NAJ form) hardcoded in chainsig.js, per network and domain. */
export function rootPublicKey(network: NearNetwork, domainId: DomainId): string {
  const env = network === "testnet" ? "TESTNET" : "MAINNET";
  const k = csConstants.ROOT_PUBLIC_KEYS[env];
  return domainId === 0 ? k.secp256k1 : k.ed25519;
}

export interface DerivedKey {
  domainId: DomainId;
  /** domain 0: 65-byte uncompressed SEC1 (04||x||y); domain 1: 32-byte ed25519. */
  bytes: Uint8Array;
  /** NAJ string, the exact format the signer's `derived_public_key` view returns. */
  naj: string;
}

/** Derive the MPC child key for (predecessor, path) on `network`'s signer. */
export function derivePublicKey(
  predecessor: string,
  path: string,
  domainId: DomainId,
  network: NearNetwork = "testnet",
): DerivedKey {
  if (domainId === 0) {
    const root = najToUncompressedPubKeySEC1(rootPublicKey(network, 0) as `secp256k1:${string}`);
    const child = deriveChildPublicKey(root, predecessor, path);
    const bytes = hexToBytes(child);
    return { domainId, bytes, naj: `secp256k1:${base58.encode(bytes.slice(1))}` };
  }
  const naj = deriveChildPublicKeyEd25519(
    rootPublicKey(network, 1) as `ed25519:${string}`,
    predecessor,
    path,
  );
  return { domainId, bytes: base58.decode(naj.slice("ed25519:".length)), naj };
}

/** EIP-55 checksummed address from 20 lowercase-hex bytes. */
export function toChecksumAddress(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(utf8ToBytes(a)));
  let out = "0x";
  for (let i = 0; i < a.length; i++) {
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? (a[i] as string).toUpperCase() : a[i];
  }
  return out;
}

/**
 * Target-chain address for a derived key.
 *  evm: EIP-55 0x + keccak256(x||y)[12..]
 *  btc: P2WPKH bech32 (hrp bc / tb / bcrt) of hash160(compressed pubkey)
 *  sol: base58(ed25519 pubkey)
 */
export function addressFromPublicKey(chain: ChainTag, pub: Uint8Array): string {
  const family = chain.slice(0, 3);
  if (family === "sol") {
    if (pub.length !== 32) throw new Error("sol address needs a 32-byte ed25519 key");
    return base58.encode(pub);
  }
  const point = secp256k1.Point.fromBytes(pub);
  if (family === "evm") {
    return toChecksumAddress(bytesToHex(keccak_256(point.toBytes(false).slice(1)).slice(12)));
  }
  if (family === "btc") {
    const net = chain.slice(4) as keyof typeof BTC_HRP;
    const hrp = BTC_HRP[net];
    if (!hrp) throw new Error(`unknown btc network: ${chain}`);
    const h160 = ripemd160(sha256(point.toBytes(true)));
    return bech32.encode(hrp, [0, ...bech32.toWords(h160)]);
  }
  throw new Error(`unknown chain: ${chain}`);
}

/**
 * The address the MPC network will sign for, given the predecessor (Ghost Paths contract in
 * Mode B, recipient account in Mode A) and the stealth path.
 * `publicKey` matches the chainsig.js adapter of that chain: evm → uncompressed SEC1 hex `04…`;
 * btc → compressed SEC1 hex `02|03…`; sol → base58.
 */
export function deriveAddress(
  predecessor: string,
  path: string,
  chain: ChainTag,
  network: NearNetwork = networkOf(predecessor),
): { address: string; publicKey: string; domainId: DomainId } {
  const domainId = domainForChain(chain);
  const k = derivePublicKey(predecessor, path, domainId, network);
  return {
    address: addressFromPublicKey(chain, k.bytes),
    publicKey:
      domainId === 1
        ? base58.encode(k.bytes)
        : chain.startsWith("btc:")
          ? bytesToHex(secp256k1.Point.fromBytes(k.bytes).toBytes(true))
          : bytesToHex(k.bytes),
    domainId,
  };
}

/** Signer contract id for a network. */
export function mpcContract(network: NearNetwork): string {
  return MPC_CONTRACT[network];
}
