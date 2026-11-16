import { describe, expect, test } from "bun:test";
import {
  isAccountId,
  labelledLink,
  payUrl,
  receiveUrl,
  setupCommands,
  setupMessage,
} from "../src/receive/setup.ts";

const cfg = {
  network: "testnet" as const,
  contract: "v1.ghost-paths.testnet",
  relayer: "https://relay.example.com/",
  chains: ["evm:11155111" as const],
};

describe("receive setup guide", () => {
  test("only valid NEAR account ids reach a shell command", () => {
    for (const ok of ["alice.testnet", "a-b_c.testnet", "ghostbob.testnet", "x1.near"])
      expect(isAccountId(ok)).toBe(true);
    for (const bad of ["", "a", "$(id).testnet", "a;rm -rf ~", "Alice.testnet", "a..testnet"])
      expect(isAccountId(bad)).toBe(false);
  });

  test("commands carry the account, network, chains and relayer", () => {
    const c = setupCommands(cfg, "alice.testnet");
    expect(c.createAccount).toBe(
      "GHOST_NETWORK=testnet bun packages/cli/src/ghost.ts account create --as me --account-id alice.testnet",
    );
    expect(c.importAccount).toContain("read -rs GHOST_NEAR_SECRET_KEY");
    expect(c.importAccount).toContain("account import --as me --account-id alice.testnet");
    expect(c.register).toBe("GHOST_NETWORK=testnet bun packages/cli/src/ghost.ts register --as me");
    expect(c.serve).toContain("GHOST_CHAINS=evm:11155111");
    expect(c.serve).toContain("GHOST_RELAYER_URL=https://relay.example.com \\");
    expect(c.serve).not.toContain("GHOST_CONTRACT");
    expect(setupCommands({ ...cfg, contract: "other.testnet" }, "a.testnet").init).toContain(
      "GHOST_CONTRACT=other.testnet",
    );
  });

  test("links resolve next to the current page", () => {
    const base = "https://pay.example.com/sub/pay.html?to=x";
    expect(receiveUrl(base, "bob.testnet")).toBe(
      "https://pay.example.com/sub/receive.html?account=bob.testnet",
    );
    expect(payUrl(base, "bob.testnet")).toBe("https://pay.example.com/sub/pay.html?to=bob.testnet");
    expect(setupMessage(base, "bob.testnet")).toContain("receive.html?account=bob.testnet");
  });
});

describe("labelled links on the receive page", () => {
  const base = "https://pay.example.com/sub/receive.html?account=bob.testnet";
  test("builds a link to the pay page next to this page", () => {
    expect(
      labelledLink(base, "bob.testnet", { ref: "freelance", amount: "0.05", note: "" }),
    ).toEqual({
      url: "https://pay.example.com/sub/pay.html?to=bob.testnet&ref=freelance&amount=0.05",
    });
    expect(labelledLink(base, "bob.testnet", {})).toEqual({
      url: "https://pay.example.com/sub/pay.html?to=bob.testnet",
    });
  });
  test("a bad entry is a message for the form, not an exception", () => {
    const r = labelledLink(base, "bob.testnet", { ref: "two words" });
    expect("error" in r && r.error).toMatch(/^label:/);
    const a = labelledLink(base, "bob.testnet", { amount: "ten" });
    expect("error" in a && a.error).toMatch(/bad amount/);
  });
});
