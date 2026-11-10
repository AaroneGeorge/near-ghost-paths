import { describe, expect, test } from "bun:test";
import { csvCell, delta, parseBundle, paymentsCsv, short, statusOf } from "../src/lib.ts";
import type { PaymentRow } from "../src/types.ts";

const row = (o: Partial<PaymentRow> = {}): PaymentRow => ({
  idx: 3,
  chain: "evm:31337",
  address: "0xabc",
  path: "gp1/aa",
  balance: "0.01",
  balance_base: "10000000000000000",
  symbol: "ETH",
  swept: false,
  ...o,
});

describe("lib", () => {
  test("short keeps short strings", () => {
    expect(short("abc")).toBe("abc");
    expect(short("0123456789abcdef0123456789", 6, 4)).toBe("012345…6789");
  });
  test("status", () => {
    expect(statusOf(row())).toBe("unspent");
    expect(statusOf(row({ balance_base: "0" }))).toBe("unfunded");
    expect(statusOf(row({ balance_base: "0", swept: true }))).toBe("swept");
    expect(statusOf(row({ balance_error: "rpc" }))).toBe("unknown");
  });
  test("csv escapes and defuses formulas", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell(undefined)).toBe("");
    const csv = paymentsCsv([row({ memo: { note: "invoice #42", amount: "0.01", asset: "ETH" } })]);
    expect(csv.split("\n")[0]).toContain("idx,chain,address");
    expect(csv.split("\n")[1]).toBe(
      "3,evm:31337,0xabc,gp1/aa,0.01,ETH,unspent,0.01,ETH,invoice #42,",
    );
  });
  test("delta", () => {
    expect(delta("0.009979", "0")).toBe("+0.009979");
    expect(delta("1", "0.5")).toBe("+0.5");
    expect(delta("0", "0.25")).toBe("-0.25");
    expect(delta("2", "2")).toBe("+0");
  });
  test("parseBundle refuses keystores", () => {
    const ok = {
      v: 1,
      account: "a.testnet",
      view_priv: "11",
      spend_pub: "02",
      signer: "x.testnet",
    };
    expect(parseBundle(JSON.stringify(ok)).account).toBe("a.testnet");
    expect(() => parseBundle(JSON.stringify({ ...ok, seed: "ff" }))).toThrow(/spend seed/);
    expect(() => parseBundle("nope")).toThrow(/JSON/);
    expect(() => parseBundle("{}")).toThrow(/viewing bundle/);
  });
});

describe("paymentsCsv dedupe (REVIEW L3)", () => {
  test("one row per (chain, address)", () => {
    const csv = paymentsCsv([row({ idx: 3 }), row({ idx: 9 })]);
    expect(csv.trim().split("\n")).toHaveLength(2);
    expect(csv.split("\n")[1]?.startsWith("3,")).toBe(true);
  });
});
