/** W3 CLI tests: offline. Every command answers --json with exactly one JSON object. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args.ts";
import { COMMANDS } from "../src/commands/index.ts";

const CLI = join(import.meta.dir, "../src/ghost.ts");
const home = mkdtempSync(join(tmpdir(), "gp-cli-"));

async function ghost(args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      GHOST_HOME: home,
      GHOST_REPLAY: "",
      GHOST_TAPE: "",
      GHOST_RELAYER_URL: "",
      GHOST_CODE_HASH: "",
      NEAR_RPC_URL: "http://127.0.0.1:1",
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
    // With the opt-in it gets past the guard; on mainnet the next check (no pinned contract code
    // hash, REVIEW M2) refuses before any network call, which keeps this test offline.
    const s = JSON.parse(
      (
        await ghost([
          "sweep",
          "0",
          "--to",
          "0x00",
          "--as",
          "bob",
          "--allow-link",
          "--network",
          "mainnet",
          "--json",
        ])
      ).stdout,
    );
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/no pinned Ghost Paths code hash/);
  }, 30_000);
});
