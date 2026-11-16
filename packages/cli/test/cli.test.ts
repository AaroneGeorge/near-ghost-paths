/** W3 CLI tests: offline. Every command answers --json with exactly one JSON object. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { scan } from "../src/commands/scan.ts";

const CLI = join(import.meta.dir, "../src/ghost.ts");
const home = mkdtempSync(join(tmpdir(), "gp-cli-"));

async function ghost(args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      GHOST_HOME: home,
      GHOST_REPLAY: "",
      GHOST_TAPE: "",
      GHOST_RELAYER_URL: "",
      GHOST_CODE_HASH: "",
      NEAR_RPC_URL: "http://127.0.0.1:1",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(p.stdout).text();
  return { code: await p.exited, stdout };
}

describe("args", () => {
  test("positionals, values, booleans, = form", () => {
    const r = parseArgs([
      "pay",
      "bob",
      "0.1",
      "--chain",
      "sol:local",
      "--json",
      "--memo=hi there",
      "--dev",
    ]);
    expect(r.cmd).toBe("pay");
    expect(r.pos).toEqual(["bob", "0.1"]);
    expect(r.flags).toMatchObject({ chain: "sol:local", json: "1", memo: "hi there", dev: "1" });
    expect(() => parseArgs(["pay", "--chain"])).toThrow();
  });
});

describe("ghost CLI", () => {
  test("help lists every command", async () => {
    const r = await ghost(["help"]);
    expect(r.code).toBe(0);
    for (const name of Object.keys(COMMANDS)) expect(r.stdout).toContain(name);
  });

  test("link prints a labelled payment link and a QR code, offline", async () => {
    const base = "https://pay.example.com/app/pay.html";
    const r = await ghost([
      "link",
      "bob.testnet",
      "--ref",
      "freelance",
      "--amount",
      "0.05",
      "--base",
      base,
      "--json",
    ]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({
      ok: true,
      command: "link",
      account: "bob.testnet",
      url: "https://pay.example.com/app/pay.html?to=bob.testnet&ref=freelance&amount=0.05",
      ref: "freelance",
    });
    expect(j.qr.split("\n").length).toBeGreaterThan(10);
    expect(
      JSON.parse((await ghost(["link", "bob.testnet", "--base", base, "--no-qr", "--json"])).stdout)
        .qr,
    ).toBeUndefined();
    // the GHOST_PAY_URL variable stands in for --base; a human run prints the QR, then the link
    const human = await ghost(["link", "bob.testnet", "--ref", "inv-1"], { GHOST_PAY_URL: base });
    expect(human.stdout).toContain("pay.html?to=bob.testnet&ref=inv-1");
    expect(human.stdout).toMatch(/[▀▄█]/);
    for (const args of [
      ["link", "bob.testnet", "--json"], // no pay page address
      ["link", "bob.testnet", "--ref", "bad label", "--base", base, "--json"],
      ["link", "bob.testnet", "--amount", "-1", "--base", base, "--json"],
    ]) {
      const e = JSON.parse((await ghost(args)).stdout);
      expect(e.ok).toBe(false);
    }
  }, 60_000);

  test("scan prints a link column only when a payment came through a labelled link", () => {
    const row = (idx: number, memo: Record<string, string>) => ({
      idx,
      chain: "evm:31337",
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
      path: "gp1/aa",
      balance: "0.01",
      balance_base: 10n,
      symbol: "ETH",
      swept: false,
      memo,
    });
    type Human = NonNullable<typeof scan.human>;
    const res = (payments: ReturnType<typeof row>[]) =>
      scan.human?.(
        { as: "bob", can_sweep: true, scanned: 2, payments } as unknown as Parameters<Human>[0],
        {} as unknown as Parameters<Human>[1],
      ) ?? "";
    expect(res([row(1, { note: "a" })])).not.toContain("link");
    const withRef = res([row(1, { note: "a" }), row(2, { ref: "freelance" })]);
    expect(withRef).toContain("link");
    expect(withRef).toContain("freelance");
  });

  test("derive --json is local (no RPC) and matches the MPC derivation format", async () => {
    const r = await ghost(["derive", "--chain", "evm:31337", "--path", "gp1/00", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({
      ok: true,
      command: "derive",
      chain: "evm:31337",
      predecessor: "v1.ghost-paths.testnet",
      domain_id: 0,
    });
    expect(j.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("every command emits one JSON object with --json, even on bad input", async () => {
    for (const name of Object.keys(COMMANDS)) {
      const r = await ghost([name, "--json"]);
      const j = JSON.parse(r.stdout);
      expect(j.command === name || j.command === undefined).toBe(true);
      expect(typeof j.ok).toBe("boolean");
    }
  }, 60_000);

  test("pay refuses mainnet chains on testnet config and unknown chains", async () => {
    const a = JSON.parse(
      (await ghost(["pay", "bob", "1", "--chain", "evm:8453", "--as", "alice", "--json"])).stdout,
    );
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/pairs with NEAR mainnet/);
    const b = JSON.parse(
      (await ghost(["pay", "bob", "1", "--chain", "doge:1", "--as", "alice", "--json"])).stdout,
    );
    expect(b.ok).toBe(false);
  });

  test("Mode B self-sweep without a relayer needs --allow-link (REVIEW L4)", async () => {
    const init = await ghost(["init", "--as", "bob", "--account-id", "bob.testnet", "--json"]);
    expect(JSON.parse(init.stdout).ok).toBe(true);
    const r = JSON.parse(
      (await ghost(["sweep", "0", "--to", "0x00", "--as", "bob", "--json"])).stdout,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--allow-link/);
    // With the opt-in it gets past the guard and fails later, at the first network call: every
    // fetch goes to a dead proxy, which keeps this test offline.
    const dead = "http://127.0.0.1:1";
    const s = JSON.parse(
      (
        await ghost(["sweep", "0", "--to", "0x00", "--as", "bob", "--allow-link", "--json"], {
          HTTP_PROXY: dead,
          HTTPS_PROXY: dead,
          http_proxy: dead,
          https_proxy: dead,
        })
      ).stdout,
    );
    expect(s.ok).toBe(false);
    expect(s.error).not.toMatch(/--allow-link/);
  }, 30_000);
});
