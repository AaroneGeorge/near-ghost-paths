/** account, init, register, meta, export-viewing-key */
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Keystore,
  formatHandle,
  generateSeed,
  keysFromKeystore,
  makeKeystore,
  metaFromKeys,
  saveKeystore,
  viewingBundle,
} from "@ghost-paths/sdk";
import { CliError, type Ctx, nearTxUrl, resolveAccountId } from "../context.ts";
import { c, kv } from "../output.ts";
import type { Command } from "./types.ts";

export const account: Command = {
  name: "account",
  summary: "create | import | show the NEAR account of a profile",
  usage:
    "ghost account create --as NAME [--account-id ID] [--fund NEAR]   (GHOST_FUNDER_FILE: create from a funder, else faucet)\n  ghost account delete --as NAME --beneficiary ID\n  ghost account import --as NAME --account-id ID   (secret key from env GHOST_NEAR_SECRET_KEY)\n  ghost account show --as NAME",
  async run(ctx, pos) {
    const sub = pos[0] ?? "show";
    const name = ctx.as;
    if (sub === "create") {
      if (ctx.profiles.near(name) && !ctx.flags.force)
        throw new CliError(`profile "${name}" already has a NEAR account (use --force)`);
      const creds = await ctx.createNearAccount(
        name,
        ctx.flags["account-id"],
        ctx.flags.fund ?? "1",
      );
      return { profile: name, account_id: creds.account_id, network: creds.network, created: true };
    }
    if (sub === "delete") {
      // Testnet clean-up: deletes the profile's NEAR account, sending its balance to --beneficiary.
      const beneficiary = ctx.flags.beneficiary;
      if (!beneficiary) throw new CliError("account delete needs --beneficiary ACCOUNT");
      if (ctx.cfg.network !== "testnet") throw new CliError("account delete is testnet-only");
      const { account: acc, creds } = await ctx.nearAccount(name);
      const res = await (
        acc as unknown as { deleteAccount(b: string): Promise<{ transaction: { hash: string } }> }
      ).deleteAccount(beneficiary);
      return {
        profile: name,
        account_id: creds.account_id,
        network: creds.network,
        deleted: true,
        beneficiary,
        tx_hash: res.transaction.hash,
      };
    }
    if (sub === "import") {
      const id = ctx.flags["account-id"];
      const sk = process.env.GHOST_NEAR_SECRET_KEY;
      if (!id || !sk)
        throw new CliError(
          "import needs --account-id and env GHOST_NEAR_SECRET_KEY (never pass keys on argv)",
        );
      ctx.profiles.saveNear(name, { account_id: id, secret_key: sk, network: ctx.cfg.network });
      return { profile: name, account_id: id, network: ctx.cfg.network, imported: true };
    }
    if (sub === "show") {
      const creds = ctx.profiles.near(name);
      if (!creds) throw new CliError(`profile "${name}" has no NEAR account`);
      const { account: acc } = await ctx.nearAccount(name);
      const bal = await acc.getBalance().catch(() => undefined);
      return {
        profile: name,
        account_id: creds.account_id,
        network: creds.network,
        balance_yocto: bal,
      };
    }
    throw new CliError(`unknown subcommand "account ${sub}"`);
  },
  human(r) {
    const x = r as { profile: string; account_id: string; network: string; balance_yocto?: bigint };
    return kv([
      ["profile", x.profile],
      ["NEAR account", c.cyan(x.account_id)],
      ["network", x.network],
      [
        "balance",
        x.balance_yocto !== undefined
          ? `${(Number(x.balance_yocto) / 1e24).toFixed(4)} NEAR`
          : undefined,
      ],
    ]);
  },
};

export const init: Command = {
  name: "init",
  summary: "create a recipient keystore (spend + viewing keys) for a profile",
  usage: "ghost init --as NAME [--account-id ID] [--mode contract|account] [--force]",
  async run(ctx) {
    const name = ctx.as;
    const path = ctx.profiles.keystorePath(name);
    if (existsSync(path) && !ctx.flags.force) {
      const ks = await ctx.profiles.keystore(name);
      return describeKeystore(ctx, name, ks, false);
    }
    // The registry key is the NEAR account: make sure the profile has one (testnet: auto-create).
    let accountId = ctx.flags["account-id"];
    if (!accountId) accountId = (await ctx.nearAccount(name, { create: true })).creds.account_id;
    const ks = makeKeystore({
      seed: generateSeed(),
      account: accountId,
      signer: ctx.cfg.contractId,
      mode: ctx.cfg.mode,
      network: ctx.cfg.network,
    });
    await saveKeystore(path, ks);
    return describeKeystore(ctx, name, ks, true);
  },
  human(r) {
    const x = r as ReturnType<typeof describeKeystore>;
    return [
      x.created ? c.green(`keystore created for ${x.profile}`) : `keystore exists for ${x.profile}`,
      kv([
        ["handle", c.cyan(x.handle)],
        ["spend pub (secp256k1)", x.meta.spend_pub],
        ["view pub (X25519)", x.meta.view_pub],
        [
          "mode",
          x.meta.mode === "contract"
            ? "contract (Mode B: predecessor = Ghost Paths contract)"
            : "account (Mode A)",
        ],
        ["keystore", `${x.keystore} (0600, holds the seed)`],
      ]),
      c.dim("  You hold two keys and no BTC/ETH/SOL key: the MPC network signs for every chain."),
    ].join("\n");
  },
};

function describeKeystore(ctx: Ctx, name: string, ks: Keystore, created: boolean) {
  const keys = keysFromKeystore(ks);
  return {
    profile: name,
    account: ks.account,
    handle: formatHandle(ks.account),
    meta: metaFromKeys(keys, ks.mode ?? "contract"),
    contract: ks.signer,
    keystore: ctx.profiles.keystorePath(name),
    created,
  };
}

export const register: Command = {
  name: "register",
  summary: "publish the profile's meta-address in the Ghost Paths registry (NEAR tx)",
  usage: "ghost register --as NAME",
  async run(ctx) {
    const name = ctx.as;
    const ks = await ctx.profiles.keystore(name);
    if (ks.signer !== ctx.cfg.contractId) {
      throw new CliError(
        `keystore was made for contract ${ks.signer}, but GHOST_CONTRACT=${ctx.cfg.contractId}`,
      );
    }
    const meta = metaFromKeys(keysFromKeystore(ks), ks.mode ?? "contract");
    await ctx.checkContract(); // REVIEW M2
    const reg = await ctx.registry(name, "self");
    const existing = await reg.getMeta(ks.account).catch(() => null);
    if (
      existing &&
      existing.spend_pub === meta.spend_pub &&
      existing.view_pub === meta.view_pub &&
      !ctx.flags.force
    ) {
      return {
        profile: name,
        account: ks.account,
        contract: ctx.cfg.contractId,
        meta,
        already: true,
      };
    }
    const { tx_hash } = await reg.register(meta);
    return {
      profile: name,
      account: ks.account,
      contract: ctx.cfg.contractId,
      meta,
      tx_hash,
      tx_url: nearTxUrl(ctx.cfg.network, tx_hash),
    };
  },
  human(r) {
    const x = r as {
      account: string;
      contract: string;
      tx_hash?: string;
      tx_url?: string;
      already?: boolean;
    };
    return [
      x.already
        ? `${x.account} is already registered with these keys`
        : c.green(`registered ${x.account}`),
      kv([
        ["contract", x.contract],
        ["NEAR tx", x.tx_url],
      ]),
    ].join("\n");
  },
};

export const meta: Command = {
  name: "meta",
  summary: "look up a meta-address in the registry",
  usage: "ghost meta ACCOUNT|ghost:ACCOUNT|PROFILE",
  async run(ctx, pos) {
    const who = pos[0] ?? ctx.flags.as;
    if (!who) throw new CliError("usage: ghost meta ACCOUNT");
    const accountId = resolveAccountId(ctx.profiles, who);
    const reg = await ctx.registry();
    const m = await reg.getMeta(accountId);
    return { account: accountId, contract: ctx.cfg.contractId, registered: !!m, meta: m };
  },
  human(r) {
    const x = r as {
      account: string;
      registered: boolean;
      meta: { spend_pub: string; view_pub: string; mode: string } | null;
    };
    if (!x.meta) return `${x.account}: ${c.yellow("not registered")}`;
    return kv([
      ["account", x.account],
      ["mode", x.meta.mode],
      ["spend pub", x.meta.spend_pub],
      ["view pub", x.meta.view_pub],
    ]);
  },
};

export const exportViewingKey: Command = {
  name: "export-viewing-key",
  summary: "write an auditor bundle (viewing key + spend PUBLIC key): can scan, cannot sweep",
  usage: "ghost export-viewing-key --as NAME [--out FILE]",
  async run(ctx) {
    const name = ctx.as;
    const bundle = viewingBundle(await ctx.profiles.keystore(name));
    const out = resolve(ctx.flags.out ?? `${name}.view.json`);
    writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    chmodSync(out, 0o600); // REVIEW L6: `mode` only applies when the file is created
    // The bundle holds the viewing PRIVATE key: it reveals every incoming payment, so print only the path.
    return { profile: name, account: bundle.account, file: out, can_sweep: false };
  },
  human(r) {
    const x = r as { file: string; account: string };
    return [
      c.green(`viewing-key bundle for ${x.account} written to ${x.file}`),
      c.dim(
        "  It reveals every incoming payment (share it only with your auditor) but cannot sweep.",
      ),
    ].join("\n");
  },
};
