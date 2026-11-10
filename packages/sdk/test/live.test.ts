/**
 * LIVE test (W5), opt-in: `make test-live` (= LIVE=1 bun test packages/sdk/test/live.test.ts).
 *
 * Signs one ECDSA (secp256k1, domain 0) and one EdDSA (ed25519, domain 1) payload through the
 * deployed Ghost Paths contract (default v1.ghost-paths.testnet) and the real MPC network
 * (v1.signer-prod.testnet), then checks the signatures against the locally derived keys:
 *
 *   recipient seed -> stealth target (real SDK path) -> sweep authorisation signed with d_K
 *   -> v1.ghost-paths.testnet.sweep (ecrecover) -> v1.signer-prod.testnet.sign -> MPC signature
 *   -> ECDSA: recovered public key == derive(contract, path) == signer's derived_public_key view
 *   -> EdDSA: signature verifies under derive(contract, path)
 *
 * The NEAR account that submits the transaction is not a secret-bearing identity: anyone may call
 * `sweep` (it costs about 0.001 NEAR of gas). It is taken from DEMO_FUNDER_FILE, else
 * .secrets/demo/funder.json, else one testnet faucet account is created once and cached there.
 * Needs network. ~30 s. Skipped (reported as skipped) unless LIVE=1.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import {
  DEFAULT_GHOST_CONTRACT,
  DEFAULT_SWEEP_TTL_BLOCKS,
  type MpcSignature,
  NearRegistry,
  blockHeight,
  buildSweepArgs,
  checkRootKeys,
  createFaucetAccount,
  derivePublicKey,
  deriveRecipientKeys,
  fetchDerivedPublicKey,
  generateSeed,
  makeAccount,
  makeTarget,
  metaFromKeys,
  newKeyPair,
  randomTestnetId,
} from "../src/index.ts";

const LIVE = process.env.LIVE === "1";
const ROOT = join(import.meta.dir, "../../..");
const CONTRACT = process.env.GHOST_CONTRACT ?? DEFAULT_GHOST_CONTRACT.testnet;
const NETWORK = "testnet" as const;

interface KeyFile {
  account_id: string;
  secret_key: string;
}

/** A funded testnet account that submits `sweep` (see the header). Never prints the key. */
async function submitter(): Promise<KeyFile> {
  const file = process.env.DEMO_FUNDER_FILE ?? join(ROOT, ".secrets/demo/funder.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as KeyFile;
  console.log("  no submitter account yet: creating one with the NEAR testnet faucet (once)...");
  const id = randomTestnetId("gp-live");
  const kp = newKeyPair();
  try {
    await createFaucetAccount(id, kp);
  } catch (e) {
    throw new Error(
      `${(e as Error).message}\n  The testnet faucet helper rate-limits per IP. Point DEMO_FUNDER_FILE at a JSON {"account_id","secret_key"} of any testnet account with >= 1 NEAR and re-run.`,
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ account_id: id, secret_key: kp.secretKey, network: NETWORK }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { account_id: id, secret_key: kp.secretKey };
}

async function sweepOnce(
  registry: NearRegistry,
  mk: (expiresBlock: number) => ReturnType<typeof buildSweepArgs>,
) {
  let last: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const args = mk((await blockHeight(NETWORK)) + DEFAULT_SWEEP_TTL_BLOCKS);
      const t = Date.now();
      const res = await registry.sweep(args, "self");
      return { args, res, seconds: (Date.now() - t) / 1000 };
    } catch (e) {
      last = e;
      console.log(`  attempt ${attempt} failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  throw last;
}

describe.skipIf(!LIVE)("live: real MPC signatures through v1.ghost-paths.testnet", () => {
  const seed = generateSeed();
  const keys = deriveRecipientKeys(seed);
  const meta = metaFromKeys(keys, "contract");

  test("chainsig.js root keys == v1.signer-prod.testnet public_key (domains 0 and 1)", async () => {
    const r = await checkRootKeys(NETWORK);
    expect(r.ok).toBe(true);
    console.log("  root keys match on domains 0 and 1");
  }, 60_000);

  test("ECDSA (secp256k1, domain 0): MPC signature recovers to derive(contract, path)", async () => {
    const acct = await submitter();
    const registry = new NearRegistry({
      contractId: CONTRACT,
      network: NETWORK,
      account: makeAccount(acct.account_id, acct.secret_key, NETWORK),
      defaultVia: "self",
    });
    const { target } = makeTarget(meta, "evm:11155111", CONTRACT, { network: NETWORK });
    const payload = randomBytes(32);
    payload[0] = (payload[0] as number) & 0x7f; // < secp256k1 order
    const { args, res, seconds } = await sweepOnce(registry, (exp) =>
      buildSweepArgs({
        contractId: CONTRACT,
        target,
        dSpend: keys.dSpend,
        payloads: [payload],
        expiresBlock: exp,
      }),
    );
    const sig: MpcSignature = res.signature;
    if (!("r" in sig)) throw new Error("expected an ECDSA signature from domain 0");
    const rs = hexToBytes(sig.r + sig.s);
    const recovered = secp256k1.Signature.fromBytes(rs, "compact")
      .addRecoveryBit(sig.v)
      .recoverPublicKey(payload)
      .toBytes(false);
    const local = derivePublicKey(CONTRACT, args.path, 0, NETWORK);
    const remote = await fetchDerivedPublicKey(CONTRACT, args.path, 0, NETWORK);
    expect(remote).toBe(local.naj);
    expect(bytesToHex(recovered)).toBe(bytesToHex(local.bytes));
    expect(secp256k1.verify(rs, payload, local.bytes, { prehash: false, lowS: false })).toBe(true);
    // not the key of whoever submitted the transaction (Mode B: the contract is the predecessor)
    const submitterKey = derivePublicKey(acct.account_id, args.path, 0, NETWORK);
    expect(bytesToHex(recovered)).not.toBe(bytesToHex(submitterKey.bytes));
    console.log(
      `  ECDSA ok in ${seconds.toFixed(1)} s, tx ${res.tx_hash}\n` +
        `  recovered key == derive(${CONTRACT}, ${args.path.slice(0, 12)}...) == signer view`,
    );
  }, 180_000);

  test("EdDSA (ed25519, domain 1): MPC signature verifies under derive(contract, path)", async () => {
    const acct = await submitter();
    const registry = new NearRegistry({
      contractId: CONTRACT,
      network: NETWORK,
      account: makeAccount(acct.account_id, acct.secret_key, NETWORK),
      defaultVia: "self",
    });
    const { target } = makeTarget(meta, "sol:devnet", CONTRACT, { network: NETWORK });
    const message = randomBytes(120); // a Solana-sized message, not a 32-byte hash
    const { args, res, seconds } = await sweepOnce(registry, (exp) =>
      buildSweepArgs({
        contractId: CONTRACT,
        target,
        dSpend: keys.dSpend,
        payloads: [message],
        expiresBlock: exp,
      }),
    );
    const sig: MpcSignature = res.signature;
    if (!("signature" in sig)) throw new Error("expected an Ed25519 signature from domain 1");
    const local = derivePublicKey(CONTRACT, args.path, 1, NETWORK);
    const remote = await fetchDerivedPublicKey(CONTRACT, args.path, 1, NETWORK);
    expect(remote).toBe(local.naj);
    expect(ed25519.verify(Uint8Array.from(sig.signature), message, local.bytes)).toBe(true);
    console.log(
      `  EdDSA ok in ${seconds.toFixed(1)} s, tx ${res.tx_hash}\n` +
        `  signature verifies under Solana address ${base58.encode(local.bytes)}`,
    );
  }, 180_000);
});

if (!LIVE) {
  test("live tests are skipped unless LIVE=1 (run `make test-live`)", () => {
    expect(LIVE).toBe(false);
  });
}
