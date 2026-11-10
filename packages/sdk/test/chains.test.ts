/**
 * W3 chain-layer tests. Offline: local Bun.serve fakes stand in for esplora / 1Click, and local
 * keys stand in for the MPC (the adapters only care that the signature verifies for `from`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  BtcAdapter,
  EvmAdapter,
  MainnetNotApprovedError,
  SolanaAdapter,
  assertSpendAllowed,
  chainInfo,
  compressPub,
  ecdsaParts,
  extractTxHash,
  formatUnits,
  p2wpkhScript,
  p2wpkhVsize,
  parseUnits,
} from "../src/chains/index.ts";
import { OneClick, nativeAssetFor, sweepQuote } from "../src/oneclick.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

describe("config", () => {
  test("parseUnits / formatUnits are exact", () => {
    expect(parseUnits("0.01", 18)).toBe(10_000_000_000_000_000n);
    expect(parseUnits("1", 9)).toBe(1_000_000_000n);
    expect(formatUnits(99_995_000n, 9)).toBe("0.099995");
    expect(formatUnits(0n, 8)).toBe("0");
    expect(() => parseUnits("0.0000000001", 9)).toThrow();
    expect(() => parseUnits("1e3", 9)).toThrow();
  });
  test("chain table and env override", () => {
    expect(chainInfo("evm:31337").local).toBe(true);
    expect(chainInfo("evm:8453").mainnet).toBe(true);
    expect(chainInfo("btc:testnet4").rpc[0]).toContain("emzy"); // mempool.space is IPv6-only here (F11)
    process.env.GHOST_RPC_SOL_LOCAL = "http://127.0.0.1:1";
    expect(chainInfo("sol:local").rpc[0]).toBe("http://127.0.0.1:1");
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
    delete process.env.GHOST_RPC_SOL_LOCAL;
    expect(() => chainInfo("evm:999999")).toThrow(/GHOST_RPC_EVM_999999/);
  });
  test("mainnet spend gate", () => {
    const prev = process.env.MAINNET_APPROVED;
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
    delete process.env.MAINNET_APPROVED;
    expect(() => assertSpendAllowed("evm:8453", "pay")).toThrow(MainnetNotApprovedError);
    expect(() => assertSpendAllowed("sol:mainnet", "sweep")).toThrow(MainnetNotApprovedError);
    expect(() => assertSpendAllowed("evm:11155111", "pay")).not.toThrow();
    if (prev !== undefined) process.env.MAINNET_APPROVED = prev;
  });
  test("ecdsaParts accepts v in {0,1,27,28}", () => {
    expect(ecdsaParts({ r: "01", s: "02", v: 28 }).yParity).toBe(1);
    expect(ecdsaParts({ r: "01", s: "02", v: 0 }).yParity).toBe(0);
    expect(() => ecdsaParts({ r: "01", s: "02", v: 5 })).toThrow();
  });
  test("extractTxHash", () => {
    expect(extractTxHash(`sent: 0x${"ab".repeat(32)}\n`, "evm")).toBe(`0x${"ab".repeat(32)}`);
    expect(extractTxHash(JSON.stringify({ tx_hash: "XYZ" }), "sol")).toBe("XYZ");
  });
});

describe("EVM adapter (local key in place of the MPC)", () => {
  test("finalize attaches the signature and rejects a wrong signer", async () => {
    const a = new EvmAdapter("evm:31337");
    const sk = secp256k1.utils.randomSecretKey();
    const from = privateKeyToAccount(`0x${hex(sk)}`).address;
    const tx = {
      type: "legacy" as const,
      chainId: 31337,
      nonce: 0,
      to: "0x000000000000000000000000000000000000dEaD" as const,
      value: 1n,
      gas: 21000n,
      gasPrice: 1n,
    };
    const { keccak256, serializeTransaction } = await import("viem");
    const h = Buffer.from(keccak256(serializeTransaction(tx)).slice(2), "hex");
    const sig = secp256k1.sign(h, sk, { prehash: false, format: "recovered" });
    const mpc = { r: hex(sig.slice(1, 33)), s: hex(sig.slice(33)), v: sig[0] as number };
    const ser = await a.finalize({ kind: "evm", tx, from }, [mpc]);
    expect(ser.startsWith("0x")).toBe(true);
    await expect(
      a.finalize({ kind: "evm", tx, from: "0x0000000000000000000000000000000000000001" }, [mpc]),
    ).rejects.toThrow(/recovers to/);
  });
});

describe("Solana adapter", () => {
  test("finalize verifies the EdDSA signature against the stealth address", async () => {
    const a = new SolanaAdapter("sol:local");
    const sk = ed25519.utils.randomSecretKey();
    const from = base58.encode(ed25519.getPublicKey(sk));
    const tx = new Transaction({
      feePayer: new PublicKey(from),
      recentBlockhash: base58.encode(new Uint8Array(32).fill(7)),
    }).add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(from),
        toPubkey: new PublicKey("11111111111111111111111111111112"),
        lamports: 5,
      }),
    );
    const msg = tx.serializeMessage();
    const unsigned = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString("base64");
    const good = ed25519.sign(msg, sk);
    const out = await a.finalize({ kind: "sol", unsigned, from }, [
      { scheme: "Ed25519", signature: Array.from(good) },
    ]);
    expect(Transaction.from(Buffer.from(out, "base64")).verifySignatures()).toBe(true);
    const bad = ed25519.sign(msg, ed25519.utils.randomSecretKey());
    await expect(
      a.finalize({ kind: "sol", unsigned, from }, [
        { scheme: "Ed25519", signature: Array.from(bad) },
      ]),
    ).rejects.toThrow();
  });
});

describe("BTC adapter against a fake esplora", () => {
  test("sweeps all UTXOs into one output, one payload per input, finalizes", async () => {
    const sk = secp256k1.utils.randomSecretKey();
    const pubC = hex(secp256k1.getPublicKey(sk, true));
    const fakeTxid = (n: number) => n.toString(16).padStart(64, "0");
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url).pathname;
        if (u.endsWith("/utxo"))
          return Response.json([
            { txid: fakeTxid(1), vout: 0, value: 30_000 },
            { txid: fakeTxid(2), vout: 1, value: 20_000 },
          ]);
        if (u === "/v1/fees/recommended") return Response.json({ halfHourFee: 2 });
        if (u === "/tx" && req.method === "POST") return new Response("f".repeat(64));
        return new Response("nope", { status: 404 });
      },
    });
    servers.push(srv);
    const a = new BtcAdapter("btc:testnet4", { rpc: [`http://127.0.0.1:${srv.port}`] });
    const { addressFromPublicKey } = await import("../src/derive.ts");
    const from = addressFromPublicKey("btc:testnet4", secp256k1.getPublicKey(sk, false));
    const { tx, payloads } = await a.prepareSweep(
      from,
      pubC,
      "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    );
    expect(payloads.length).toBe(2);
    expect((tx as { fee: number }).fee).toBe(2 * p2wpkhVsize(2, 1));
    const sigs = payloads.map((p) => {
      const s = secp256k1.sign(p, sk, { prehash: false, format: "recovered", lowS: true });
      return { r: hex(s.slice(1, 33)), s: hex(s.slice(33)), v: s[0] as number };
    });
    const raw = await a.finalize(tx, sigs);
    expect(raw).toMatch(/^02000000/); // version 2 segwit tx hex
    expect(await a.broadcast(raw)).toBe("f".repeat(64));
  });
  test("helpers", () => {
    const sk = secp256k1.utils.randomSecretKey();
    const unc = hex(secp256k1.getPublicKey(sk, false));
    expect(compressPub(unc)).toBe(hex(secp256k1.getPublicKey(sk, true)));
    expect(p2wpkhScript(compressPub(unc)).length).toBe(22);
  });
});

describe("1Click client", () => {
  test("asset mapping", () => {
    expect(nativeAssetFor("evm:8453")).toBe("nep141:base.omft.near");
    expect(nativeAssetFor("sol:local")).toBe("nep141:sol.omft.near");
  });
  test("wet quotes are refused without MAINNET_APPROVED", async () => {
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
    delete process.env.MAINNET_APPROVED;
    await expect(
      new OneClick({ baseUrl: "http://127.0.0.1:1" }).quote({
        dry: false,
        originAsset: "a",
        destinationAsset: "b",
        amount: "1",
        refundTo: "x",
        recipient: "y",
      }),
    ).rejects.toThrow(/MAINNET_APPROVED/);
  });
  test("confidential 401 falls back to a public dry quote (S6 behaviour)", async () => {
    const seen: string[] = [];
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const b = (await req.json()) as { confidentiality: string; dry: boolean };
        seen.push(b.confidentiality);
        if (b.confidentiality !== "public") {
          return Response.json(
            { message: "User authentication is required for confidential intent quotes" },
            { status: 401 },
          );
        }
        return Response.json({
          quote: { amountIn: "1", amountInFormatted: "1", amountOut: "2", amountOutFormatted: "2" },
          quoteRequest: b,
        });
      },
    });
    servers.push(srv);
    const r = await sweepQuote(
      {
        chain: "evm:8453",
        amount: 10n ** 15n,
        to: "usdc:sol",
        recipient: "R",
        refundTo: "0x1",
        confidentiality: "basic",
      },
      new OneClick({ baseUrl: `http://127.0.0.1:${srv.port}` }),
    );
    expect(seen).toEqual(["basic", "public"]);
    expect(r.fallbackFrom).toBe("basic");
    expect(r.confidentiality).toBe("public");
    expect(r.response?.quoteRequest.dry).toBe(true);
  });
});

describe("tape (record/replay)", () => {
  test("a recorded exchange replays offline, with JSON-RPC ids rewritten and deterministic randomness", async () => {
    let hits = 0;
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        hits++;
        const b = (await req.json()) as { id: number; method: string };
        return Response.json({ jsonrpc: "2.0", id: b.id, result: `${b.method}-${hits}` });
      },
    });
    servers.push(srv);
    const dir = mkdtempSync(join(tmpdir(), "gp-tape-"));
    const tape = join(dir, "t.jsonl");
    const script = join(import.meta.dir, "fixtures-tape-child.ts");
    await Bun.write(
      script,
      `import { installTape } from "../src/chains/tape.ts";
installTape();
const url = process.argv[2];
const call = async (id, method) => (await (await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method }) })).json());
const a = await call(1, "eth_chainId"); const b = await call(2, "eth_chainId"); const c = await call(7, "eth_blockNumber");
const r = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
console.log(JSON.stringify({ a, b, c, r }));
`,
    );
    const env = { ...process.env, GHOST_TAPE: tape, GHOST_TAPE_SEED: "s1", GHOST_REPLAY: "" };
    const url = `http://127.0.0.1:${srv.port}`;
    const run = async (mode: string) => {
      const p = Bun.spawn(["bun", script, url], {
        env: { ...env, GHOST_TAPE_MODE: mode },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(p.stdout).text();
      return { status: await p.exited, stdout, stderr: await new Response(p.stderr).text() };
    };
    const rec = await run("record");
    expect(rec.stderr).toBe("");
    expect(rec.status).toBe(0);
    srv.stop(true);
    const rep = await run("replay");
    expect(rep.stderr).toBe("");
    expect(rep.status).toBe(0);
    const R = JSON.parse(rec.stdout);
    const P = JSON.parse(rep.stdout);
    expect(P).toEqual(R);
    expect(P.b).toEqual({ jsonrpc: "2.0", id: 2, result: "eth_chainId-2" });
    expect(P.c.id).toBe(7);
    expect(readFileSync(tape, "utf8").trim().split("\n").length).toBe(3);
    (await import("node:fs")).rmSync(script);
  }, 30_000);
});

describe("REVIEW L2: tape randomness never meets mainnet", () => {
  test("installTape throws with a seed and GHOST_NETWORK=mainnet / MAINNET_APPROVED=1", async () => {
    for (const extra of [{ GHOST_NETWORK: "mainnet" }, { MAINNET_APPROVED: "1" }]) {
      const p = Bun.spawn(
        [
          "bun",
          "-e",
          `import { installTape } from "${join(import.meta.dir, "../src/chains/tape.ts")}"; installTape();`,
        ],
        {
          env: {
            ...process.env,
            GHOST_REPLAY: "",
            GHOST_TAPE: join(tmpdir(), "gp-tape-guard.jsonl"),
            GHOST_TAPE_MODE: "record",
            GHOST_TAPE_SEED: "x",
            GHOST_NETWORK: "testnet",
            MAINNET_APPROVED: "",
            ...extra,
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const err = await new Response(p.stderr).text();
      expect(await p.exited).not.toBe(0);
      expect(err).toMatch(/refusing deterministic tape randomness/);
    }
  });
});
