/**
 * Dev backend for `ghost serve --dev=1` (owner: W4). No network at all.
 *
 * REAL: all the cryptography. Meta-addresses, ephemeral keys, view tags, memo encryption, the
 * stealth tweak, the MPC-derived address (chainsig.js derivation), scanning, the sweep
 * authorisation signed with d_K, and the contract's checks (SDK MemoryRegistry.verifySweepArgs).
 * SIMULATED: the target chains (an in-memory ledger replaces anvil / Solana / Bitcoin), the NEAR
 * transactions (memtx… ids) and the MPC signature (a placeholder with the right shape).
 * Every response says so via `simulated: true`, and the UI shows a banner.
 *
 * Response shapes mirror the CLI's `--json` output (PayResult, ScanResult, SweepResult).
 */
import { createHash } from "node:crypto";
import {
  type Announcement,
  type ChainTag,
  type Keystore,
  MPC_CONTRACT,
  MemoryRegistry,
  type Meta,
  type Payment,
  type ViewingBundle,
  buildAnnouncement,
  buildSweepArgs,
  generateSeed,
  isChainTag,
  keysFromKeystore,
  makeKeystore,
  makeTarget,
  metaFromKeys,
  predecessorFor,
  scanAnnouncements,
  scanOne,
  toPayments,
  viewingBundle,
} from "@ghost-paths/sdk";
import { chainInfo, formatUnits, parseUnits } from "@ghost-paths/sdk/src/chains/index.ts";
import { CliError } from "./context.ts";
import type { Backend, ProfileInfo, ScanView } from "./serve.ts";

const CONTRACT = "v1.ghost-paths.testnet";
const delay = Number(process.env.GHOST_DEV_DELAY_MS ?? 1400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flat fee a simulated sweep burns, per chain family (base units). */
const FEE: Record<string, bigint> = { evm: 21_000_000_000_000n, sol: 5_000n, btc: 300n };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}
function randomB58(len: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => B58[b % 58]).join("");
}
function fakeChainTx(chain: ChainTag): string {
  return chain.startsWith("evm:")
    ? `0x${randomHex(32)}`
    : chain.startsWith("sol:")
      ? randomB58(87)
      : randomHex(32);
}

interface DevProfile {
  name: string;
  account: string;
  ks?: Keystore;
}

export async function createDevBackend(): Promise<Backend> {
  const profiles = new Map<string, DevProfile>();
  const ledger = new Map<string, bigint>();
  const seen = new Map<string, Set<number>>(); // account -> announcement idx seen funded
  const key = (chain: string, addr: string) => `${chain}|${addr}`;

  // The fake MPC: returns a placeholder signature of the right shape (the contract-side checks are real).
  const registry = new MemoryRegistry({
    contractId: CONTRACT,
    caller: "alice.testnet",
    signer: async (args) => {
      await sleep(delay);
      const h = createHash("sha256")
        .update(args.payloads[0] ?? "")
        .digest("hex");
      return args.domain_id === 0
        ? { r: h, s: h, v: 0 }
        : { scheme: "Ed25519" as const, signature: Array.from(Buffer.from(h + h, "hex")) };
    },
  });

  profiles.set("alice", { name: "alice", account: "alice.testnet" });
  for (const name of ["bob", "carol"]) {
    const account = `${name}.testnet`;
    const ks = makeKeystore({
      seed: generateSeed(),
      account,
      signer: CONTRACT,
      mode: "contract",
      network: "testnet",
    });
    profiles.set(name, { name, account, ks });
    await registry.as(account).register(metaFromKeys(keysFromKeystore(ks), "contract"));
  }

  const adapters = (chain: ChainTag) => ({
    getBalance: async (addr: string) => ({
      balance: ledger.get(key(chain, addr)) ?? 0n,
      decimals: chainInfo(chain).decimals,
    }),
  });

  function resolveAccount(who: string): string {
    if (who.startsWith("ghost:")) return who.slice(6);
    return profiles.get(who)?.account ?? who;
  }
  function recipientKs(name: string): Keystore {
    const ks = profiles.get(name)?.ks;
    if (!ks) throw new CliError(`no keystore for "${name}" (simulated profiles: bob, carol)`);
    return ks;
  }
  const chainOf = (v: string | undefined): ChainTag => {
    if (!v || !isChainTag(v))
      throw new CliError(`--chain must be a chain tag like evm:31337 (got "${v}")`);
    return chainInfo(v).tag;
  };

  async function allAnnouncements(): Promise<Announcement[]> {
    return registry.getAnnouncements(0, 200);
  }

  async function scanWith(bundle: ViewingBundle, full: boolean, markSeen: boolean) {
    const list = await allAnnouncements();
    const hits = scanAnnouncements(list, bundle, { full });
    const set = seen.get(bundle.account) ?? new Set<number>();
    const payments = await toPayments(hits, adapters, { seen: set });
    if (markSeen) for (const p of payments) if (p.balance > 0n) set.add(p.idx);
    seen.set(bundle.account, set);
    return { scanned: list.length, payments: payments.map(row) };
  }
  const row = (p: Payment) => ({
    idx: p.idx,
    chain: p.chain,
    address: p.address,
    path: p.path,
    balance: formatUnits(p.balance, p.decimals),
    balance_base: p.balance,
    symbol: chainInfo(p.chain).symbol,
    memo: p.memo,
    swept: p.swept,
  });

  const commands: Record<
    string,
    (pos: string[], f: Record<string, string>, log: (m: string) => void) => Promise<unknown>
  > = {
    async pay(pos, f, log) {
      const [who, amountStr] = pos;
      if (!who || !amountStr)
        throw new CliError("usage: pay RECIPIENT AMOUNT --chain TAG --as PAYER");
      const chain = chainOf(f.chain);
      const info = chainInfo(chain);
      const amount = parseUnits(amountStr, info.decimals);
      if (amount <= 0n) throw new CliError("amount must be positive");
      const payer = profiles.get(f.as ?? "alice");
      if (!payer) throw new CliError(`unknown payer "${f.as}"`);
      const recipient = resolveAccount(who);
      const meta: Meta | null = await registry.getMeta(recipient);
      if (!meta) throw new CliError(`${recipient} has no Ghost Paths meta-address in ${CONTRACT}`);
      const predecessor = predecessorFor(meta.mode, CONTRACT, recipient);
      const noViewTag = f["no-view-tag"] === "1";
      const { target, S } = makeTarget(meta, chain, predecessor, { network: "testnet", noViewTag });
      log(`one-time address ${target.address} on ${info.name}`);
      log(
        `  = MPC-derive(predecessor ${predecessor}, path ${target.path.slice(0, 18)}…, domain ${target.domainId})`,
      );
      await sleep(delay / 3);
      const txHash = fakeChainTx(chain);
      ledger.set(
        key(chain, target.address),
        (ledger.get(key(chain, target.address)) ?? 0n) + amount,
      );
      log(`paying ${amountStr} ${info.symbol} (simulated ${info.family} ledger)`);
      const note = f.memo ?? (noViewTag ? "(no view tag)" : undefined);
      const args = buildAnnouncement(target, S, {
        amount: amountStr,
        asset: info.symbol,
        ...(note ? { note } : {}),
        txid: txHash,
      });
      await sleep(delay / 3);
      const r = await registry
        .as(payer.account)
        .announce(args, f.via === "self" ? "self" : "relayer");
      log(`announced on ${CONTRACT} as idx ${r.idx}`);
      return {
        simulated: true,
        payer: payer.name,
        recipient,
        chain,
        amount: formatUnits(amount, info.decimals),
        asset: info.symbol,
        predecessor,
        path: target.path,
        address: target.address,
        domain_id: target.domainId,
        eph: target.eph,
        tag: target.tag,
        pay_tx: txHash,
        payer_wallet: `${payer.account} (simulated wallet)`,
        announce_tx: r.tx_hash,
        idx: r.idx,
        announced_via: f.via === "self" ? "self" : "relayer",
      };
    },

    async scan(_pos, f) {
      const ks = recipientKs(f.as ?? "");
      const { scanned, payments } = await scanWith(viewingBundle(ks), f.full === "1", true);
      return {
        simulated: true,
        as: f.as,
        account: ks.account,
        kind: "keystore",
        can_sweep: true,
        scanned,
        payments,
      };
    },

    async meta(pos, f) {
      const account = resolveAccount(pos[0] ?? f.as ?? "");
      const m = await registry.getMeta(account);
      return { simulated: true, account, contract: CONTRACT, registered: !!m, meta: m };
    },

    async balance(pos, f) {
      const chain = chainOf(f.chain);
      const addr = pos[0];
      if (!addr) throw new CliError("usage: balance ADDRESS --chain TAG");
      const { balance, decimals } = await adapters(chain).getBalance(addr);
      return {
        simulated: true,
        chain,
        address: addr,
        balance: formatUnits(balance, decimals),
        balance_base: balance,
        symbol: chainInfo(chain).symbol,
      };
    },

    async sweep(pos, f, log) {
      const idx = Number(pos[0]);
      if (!Number.isInteger(idx) || idx < 0)
        throw new CliError("usage: sweep IDX --to DEST --as NAME");
      const name = f.as ?? "";
      const ks = recipientKs(name);
      const dest = f.to;
      if (!dest) throw new CliError("--to DEST is required");
      const [a] = await registry.getAnnouncements(idx, 1);
      if (!a || a.idx !== idx) throw new CliError(`announcement ${idx} not found`);
      const hit = scanOne(a, viewingBundle(ks));
      if (!hit) throw new CliError(`announcement ${idx} is not a payment to ${ks.account}`);
      const info = chainInfo(hit.chain);
      const have = ledger.get(key(hit.chain, hit.address)) ?? 0n;
      if (have === 0n)
        throw new CliError(`nothing to sweep at ${hit.address} (balance 0; already swept?)`);
      const family = info.family;
      const okDest =
        family === "evm"
          ? /^0x[0-9a-fA-F]{40}$/.test(dest)
          : family === "sol"
            ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)
            : /^(bcrt1|tb1|bc1)[0-9a-z]{20,80}$/.test(dest);
      if (!okDest) throw new CliError(`"${dest}" is not a valid ${info.name} address`);
      const fee = FEE[family] ?? 0n;
      const send = f.amount ? parseUnits(f.amount, info.decimals) : have - fee;
      if (send <= 0n || send + fee > have)
        throw new CliError("amount exceeds the stealth balance (after the fee)");
      const via = f.via === "self" ? "self" : "relayer";
      const t0 = Date.now();
      log(`preparing ${info.name} transfer ${hit.address.slice(0, 10)}… → ${dest.slice(0, 10)}…`);
      const payload = new Uint8Array(family === "sol" ? 64 : 32);
      crypto.getRandomValues(payload);
      const expires = registry.blockHeight + 600;
      const args = buildSweepArgs({
        contractId: CONTRACT,
        target: hit,
        dSpend: keysFromKeystore(ks).dSpend,
        payloads: [payload],
        expiresBlock: expires,
      });
      if (via === "self")
        log(
          "warning: submitting from your own NEAR account links this transaction to your account on NEAR",
        );
      log(
        `${via === "relayer" ? "relayer submits" : "submitting"} ${CONTRACT}.sweep(path ${hit.path.slice(0, 14)}…, k_pub ${args.k_pub.slice(0, 8)}…); waiting for the MPC…`,
      );
      const res = await registry
        .as(via === "self" ? ks.account : "relayer.testnet")
        .sweep(args, via);
      const ms = Date.now() - t0;
      log(`MPC signature in ${(ms / 1000).toFixed(1)} s (simulated)`);
      ledger.set(key(hit.chain, hit.address), have - send - fee);
      ledger.set(key(hit.chain, dest), (ledger.get(key(hit.chain, dest)) ?? 0n) + send);
      const chainTx = fakeChainTx(hit.chain);
      log("broadcast on the target chain (simulated)");
      const destBal = ledger.get(key(hit.chain, dest)) ?? 0n;
      return {
        simulated: true,
        idx,
        chain: hit.chain,
        from: hit.address,
        to: dest,
        path: hit.path,
        mode: "contract",
        via,
        amount: formatUnits(send, info.decimals),
        symbol: info.symbol,
        near_txs: [{ tx_hash: res.tx_hash, tx_url: "" }],
        mpc_ms: [ms],
        chain_tx: chainTx,
        dest_balance_after: formatUnits(destBal, info.decimals),
      };
    },

    async quote(_pos, f) {
      const chain = chainOf(f.chain);
      const info = chainInfo(chain);
      const amount = f.amount ?? "0";
      const usd: Record<string, number> = { evm: 3400, sol: 180, btc: 98000 };
      const usdIn = Number(amount) * (usd[info.family] ?? 0);
      return {
        simulated: true,
        chain,
        amount,
        symbol: info.symbol,
        to: f.to,
        recipient: f.recipient,
        dry: true,
        ok: true,
        confidentiality: f.confidential ?? "basic",
        note: "Simulated quote (dev mode, no network). With the real backend this is a live dry 1Click quote; 1Click runs on mainnet only.",
        response: {
          quote: {
            amountInFormatted: amount,
            amountInUsd: usdIn.toFixed(2),
            amountOutFormatted: (usdIn * 0.9975).toFixed(4),
            amountOutUsd: (usdIn * 0.9975).toFixed(2),
            timeEstimate: 42,
          },
        },
      };
    },

    async status() {
      return {
        simulated: true,
        network: "testnet",
        signer: MPC_CONTRACT.testnet,
        mode: "contract",
        replay: false,
        contract: {
          id: CONTRACT,
          deployed: true,
          signer_id: MPC_CONTRACT.testnet,
          announcements: await registry.announcementCount(),
        },
      };
    },
  };

  const list = (): ProfileInfo[] =>
    [...profiles.values()].map((p) => ({
      name: p.name,
      account: p.account,
      recipient: !!p.ks,
      near: true,
      wallet: p.name === "alice",
    }));

  return {
    mode: "dev",
    cfg: {
      network: "testnet",
      contractId: CONTRACT,
      signerId: MPC_CONTRACT.testnet,
      mode: "contract",
      replay: false,
      relayer: true,
    },
    async profiles() {
      return list();
    },
    async run(cmd, pos, flags, log) {
      const fn = commands[cmd];
      if (!fn) throw new CliError(`unknown command "${cmd}"`);
      return fn(pos, flags, log);
    },
    async scanBundle(bundle, full): Promise<ScanView> {
      const { scanned, payments } = await scanWith(bundle, full, false);
      return {
        as: `auditor of ${bundle.account}`,
        account: bundle.account,
        kind: "viewing-key",
        can_sweep: false,
        scanned,
        payments,
      };
    },
    async scanStranger(): Promise<ScanView> {
      const ks = makeKeystore({
        seed: generateSeed(),
        account: "stranger.testnet",
        signer: CONTRACT,
        network: "testnet",
      });
      const { scanned, payments } = await scanWith(viewingBundle(ks), false, false);
      return {
        as: "a stranger",
        account: "(random key)",
        kind: "stranger",
        can_sweep: false,
        scanned,
        payments,
      };
    },
    announcements: allAnnouncements,
    async viewingBundle(profile) {
      return viewingBundle(recipientKs(profile));
    },
  };
}
