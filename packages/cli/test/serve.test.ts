/** `ghost serve --dev=1`: the HTTP API behind the web UI (W4). Offline: MemoryRegistry + simulated chains. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type RunningServer, startServer } from "../src/serve.ts";

let srv: RunningServer;
let base = "";
process.env.GHOST_DEV_DELAY_MS = "0";

const post = async (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ghost-token": srv.token, ...headers },
    body: JSON.stringify(body),
  });

const tok = () => ({ "x-ghost-token": srv.token });

beforeAll(async () => {
  srv = await startServer({ dev: "1", port: "0" });
  base = srv.url;
});
afterAll(() => srv.stop());

describe("ghost serve (dev)", () => {
  test("config lists chains, profiles and defaults", async () => {
    const c = (await (await fetch(`${base}/api/config`)).json()) as {
      simulated: boolean;
      defaults: { payer: string; recipient: string };
      chains: { family: string }[];
    };
    expect(c.simulated).toBe(true);
    expect(c.defaults).toEqual({ payer: "alice", recipient: "bob" });
    expect(new Set(c.chains.map((x) => x.family))).toEqual(new Set(["evm", "sol", "btc"]));
  });

  test("pay → recipient finds 1, stranger and carol find 0 → auditor finds 1 → sweep moves the balance", async () => {
    const pay = (await (
      await post("pay", {
        pos: ["bob", "0.01"],
        flags: { chain: "evm:31337", as: "alice", memo: "invoice #42" },
      })
    ).json()) as { ok: boolean; address: string; idx: number };
    expect(pay.ok).toBe(true);
    expect(pay.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const bob = (await (await post("scan", { flags: { as: "bob" } })).json()) as {
      payments: { address: string; balance: string; memo: { note: string } }[];
    };
    expect(bob.payments).toHaveLength(1);
    expect(bob.payments[0]?.address).toBe(pay.address);
    expect(bob.payments[0]?.memo.note).toBe("invoice #42");

    const carol = (await (await post("scan", { flags: { as: "carol" } })).json()) as {
      payments: unknown[];
    };
    expect(carol.payments).toHaveLength(0);
    const stranger = (await (await post("scan-stranger", {})).json()) as {
      payments: unknown[];
      announcements: { idx: number }[];
    };
    expect(stranger.payments).toHaveLength(0);
    expect(stranger.announcements).toHaveLength(1);
    expect(JSON.stringify(stranger.announcements)).not.toContain("bob");

    const { bundle } = (await (
      await fetch(`${base}/api/viewing-bundle?profile=bob`, { headers: tok() })
    ).json()) as {
      bundle: Record<string, unknown>;
    };
    expect(bundle.seed).toBeUndefined();
    const aud = (await (await post("scan-bundle", { bundle })).json()) as {
      payments: unknown[];
      can_sweep: boolean;
    };
    expect(aud.payments).toHaveLength(1);
    expect(aud.can_sweep).toBe(false);

    const { address: dest } = (await (
      await fetch(`${base}/api/fresh-destination?chain=evm:31337`)
    ).json()) as { address: string };
    const sweep = (await (
      await post("sweep", {
        pos: [String(pay.idx)],
        flags: { as: "bob", to: dest, via: "relayer" },
      })
    ).json()) as { ok: boolean; dest_balance_after: string };
    expect(sweep.ok).toBe(true);
    expect(Number(sweep.dest_balance_after)).toBeGreaterThan(0.0099);
    const bal = (await (
      await post("balance", { pos: [dest], flags: { chain: "evm:31337" } })
    ).json()) as { balance: string };
    expect(bal.balance).toBe(sweep.dest_balance_after);
    const again = await post("sweep", { pos: [String(pay.idx)], flags: { as: "bob", to: dest } });
    expect(again.status).toBe(400); // already swept
  });

  test("streams progress as NDJSON", async () => {
    const r = await post("pay", {
      pos: ["bob", "0.1"],
      flags: { chain: "sol:local", as: "alice" },
    });
    expect(r.status).toBe(200);
    const res = await fetch(`${base}/api/pay?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json", ...tok() },
      body: JSON.stringify({ pos: ["bob", "0.1"], flags: { chain: "sol:local", as: "alice" } }),
    });
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { log?: string; ok?: boolean });
    expect(lines.some((l) => l.log?.includes("one-time address"))).toBe(true);
    expect(lines.at(-1)?.ok).toBe(true);
  });

  test("refuses what the browser must not do", async () => {
    expect((await post("scan", { flags: { home: "/etc" } })).status).toBe(400); // flag not allowlisted
    expect((await post("init", {})).status).toBe(404); // command not exposed
    expect((await post("export-viewing-key", {})).status).toBe(404);
    expect(
      (await post("scan", { flags: { as: "bob" } }, { origin: "http://evil.example" })).status,
    ).toBe(403); // CSRF
    expect((await fetch(`${base}/api/config`, { headers: { host: "evil.example" } })).status).toBe(
      403,
    ); // DNS rebinding
    expect(
      (await fetch(`${base}/api/viewing-bundle?profile=../../etc/passwd`, { headers: tok() }))
        .status,
    ).toBe(400);
    const bad = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...tok() },
      body: "{}",
    });
    expect(bad.status).toBe(415);
  });

  test("session token (REVIEW M4): POSTs and the viewing bundle need it; non-loopback needs a fixed one", async () => {
    expect((await post("scan", { flags: { as: "bob" } }, { "x-ghost-token": "" })).status).toBe(
      401,
    );
    expect((await post("sweep", { pos: ["0"] }, { "x-ghost-token": "x".repeat(32) })).status).toBe(
      401,
    );
    expect((await fetch(`${base}/api/viewing-bundle?profile=bob`)).status).toBe(401);
    expect((await fetch(`${base}/api/config`)).status).toBe(200); // public data stays open
    expect(srv.openUrl).toBe(`${base}/?token=${srv.token}`);
    expect(srv.token).toMatch(/^[0-9a-f]{32}$/);
    const saved = process.env.GHOST_SERVE_TOKEN;
    // biome-ignore lint/performance/noDelete: an env var must be removed, not set to "undefined"
    delete process.env.GHOST_SERVE_TOKEN;
    await expect(startServer({ dev: "1", port: "0", host: "0.0.0.0" })).rejects.toThrow(
      /refusing to bind/,
    );
    if (saved !== undefined) process.env.GHOST_SERVE_TOKEN = saved;
  });
});
