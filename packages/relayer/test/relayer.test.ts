/** W3 relayer tests: input validation happens before any NEAR call (offline). */
import { afterAll, describe, expect, test } from "bun:test";
import { newKeyPair } from "@ghost-paths/sdk";
import { RateLimiter, clientIp, parseSweepBody, startRelayer } from "../src/server.ts";

const server = startRelayer({
  network: "testnet",
  contractId: "v1.ghost-paths.testnet",
  accountId: "nobody-gp-test.testnet",
  secretKey: newKeyPair().secretKey,
  port: 0,
  log: () => {},
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("relayer", () => {
  test("rejects a sweep whose authorisation does not verify (no gas spent)", async () => {
    const r = await post("/sweep", {
      path: `gp1/${"0".repeat(64)}`,
      domain_id: 0,
      payloads: ["00"],
      expires_block: 1,
      k_pub: "00".repeat(64),
      sig: "00".repeat(64),
      v: 0,
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/does not verify/);
  });
  test("shape checks", async () => {
    expect((await post("/sweep", { path: "x", domain_id: 2 })).status).toBe(400);
    expect((await post("/sweep", "not json")).status).toBe(400);
    expect((await post("/announce", { chain: "doge:1", eph: "00", tag: 1 })).status).toBe(400);
    expect((await post("/nope", {})).status).toBe(404);
    expect((await post("/announce", "x".repeat(70_000))).status).toBe(413);
  });
  test("v must be 0|1 and exactly one payload (v1)", () => {
    const ok = {
      path: "p",
      domain_id: 0,
      payloads: ["00"],
      expires_block: 5,
      k_pub: "a",
      sig: "b",
      v: 1,
    };
    expect(parseSweepBody(ok).v).toBe(1);
    expect(() => parseSweepBody({ ...ok, v: 27 })).toThrow();
    expect(() => parseSweepBody({ ...ok, payloads: ["00", "01"] })).toThrow();
  });
});

describe("relayer abuse limits (REVIEW M3)", () => {
  const strict = startRelayer({
    network: "testnet",
    contractId: "v1.ghost-paths.testnet",
    accountId: "nobody-gp-test.testnet",
    secretKey: newKeyPair().secretKey,
    port: 0,
    log: () => {},
    token: "s3cret",
    ratePerIp: 2,
  });
  const sbase = `http://127.0.0.1:${strict.port}`;
  afterAll(() => strict.stop(true));
  const spost = (headers: Record<string, string>) =>
    fetch(`${sbase}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ chain: "doge:1", eph: "00", tag: 1 }),
    });

  test("a foreign browser origin is refused, even as a no-preflight text/plain POST", async () => {
    const r = await fetch(`${base}/announce`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await fetch(`${base}/announce`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:8788" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8788");
  });
  test("token is required when configured; then a per-IP rate limit applies", async () => {
    expect((await spost({})).status).toBe(401);
    expect((await spost({ authorization: "Bearer nope" })).status).toBe(401);
    const auth = { authorization: "Bearer s3cret" };
    expect((await spost(auth)).status).toBe(400); // passes auth, fails validation
    expect((await spost(auth)).status).toBe(400);
    expect((await spost(auth)).status).toBe(429);
  });
  test("rate limiter: per key and global windows", () => {
    const l = new RateLimiter(2, 3);
    const t = 1_000_000;
    expect([l.allow("a", t), l.allow("a", t), l.allow("a", t)]).toEqual([true, true, false]);
    expect([l.allow("b", t), l.allow("b", t)]).toEqual([true, false]); // global cap 3
    expect(l.allow("a", t + 60_000)).toBe(true); // next window
  });
  test("client IP: X-Forwarded-For only with RELAYER_TRUST_PROXY and from a loopback peer", () => {
    expect(clientIp("203.0.113.9", "1.2.3.4", true)).toBe("203.0.113.9"); // not from the local proxy
    expect(clientIp("127.0.0.1", "1.2.3.4", false)).toBe("127.0.0.1"); // not enabled
    expect(clientIp("127.0.0.1", "9.9.9.9, 1.2.3.4", true)).toBe("1.2.3.4"); // proxy-appended entry
    expect(clientIp("::ffff:127.0.0.1", "1.2.3.4", true)).toBe("1.2.3.4");
  });
});
