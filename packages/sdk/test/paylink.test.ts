import { describe, expect, test } from "bun:test";
import { buildPayLink, cleanRef, parsePayLink, parseRef } from "../src/paylink.ts";
import { qrSvg, qrTerminal } from "../src/qr.ts";

describe("payment links", () => {
  const base = "https://pay.example.com/app/pay.html?to=someone.testnet#x";

  test("builds a link next to the page, with the label, amount and note", () => {
    expect(buildPayLink(base, { to: "bob.testnet" })).toBe(
      "https://pay.example.com/app/pay.html?to=bob.testnet",
    );
    expect(
      buildPayLink(base, {
        to: "bob.testnet",
        ref: "freelance",
        amount: "0.05",
        note: "Invoice 42",
      }),
    ).toBe(
      "https://pay.example.com/app/pay.html?to=bob.testnet&ref=freelance&amount=0.05&note=Invoice+42",
    );
  });

  test("build refuses what the pay page would ignore", () => {
    expect(() => buildPayLink(base, { to: "" })).toThrow(/recipient/);
    for (const ref of ["a b", "-x", "x".repeat(33), "a&to=evil", "é"])
      expect(() => buildPayLink(base, { to: "bob.testnet", ref })).toThrow(/label/);
    for (const amount of ["-1", "1e3", "0x10", "1.", ".5", "1,5", "abc"])
      expect(() => buildPayLink(base, { to: "bob.testnet", amount })).toThrow(/amount/);
    expect(() => buildPayLink(base, { to: "bob.testnet", note: "n".repeat(141) })).toThrow(/note/);
  });

  test("empty label / amount / note mean none", () => {
    expect(buildPayLink(base, { to: "b.testnet", ref: "", amount: "", note: "  " })).toBe(
      "https://pay.example.com/app/pay.html?to=b.testnet",
    );
    expect(parseRef(undefined)).toBeUndefined();
    expect(parseRef("  ")).toBeUndefined();
    expect(parseRef(" invoice-42 ")).toBe("invoice-42");
  });

  test("parse round-trips, and never throws on a link somebody crafted", () => {
    const url = new URL(
      buildPayLink(base, { to: "bob.testnet", ref: "a.b_c-1", amount: "1.5", note: "hi there" }),
    );
    expect(parsePayLink(url.search)).toEqual({
      to: "bob.testnet",
      ref: "a.b_c-1",
      amount: "1.5",
      note: "hi there",
    });
    expect(
      parsePayLink(`?to=bob.testnet&ref=%3Cscript%3E&amount=-5&note=${"n".repeat(200)}`),
    ).toEqual({ to: "bob.testnet" });
    expect(parsePayLink("")).toEqual({});
    expect(parsePayLink("?ref=ok&ref=%3C")).toEqual({ ref: "ok" }); // first one wins, like URLSearchParams.get
  });

  test("cleanRef accepts only plain labels", () => {
    expect(cleanRef("freelance")).toBe("freelance");
    expect(cleanRef(5)).toBeUndefined();
    expect(cleanRef("a\nb")).toBeUndefined();
  });
});

describe("QR codes", () => {
  const url = "https://pay.example.com/pay.html?to=bob.testnet&ref=freelance";
  test("svg is a well-formed image of the link and carries no markup from it", () => {
    const svg = qrSvg(url);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("freelance");
    expect(qrSvg("<script>alert(1)</script>")).not.toContain("<script");
  });
  test("terminal output is rows of block characters; light theme inverts it", () => {
    const dark = qrTerminal(url);
    const light = qrTerminal(url, { light: true });
    expect(dark.split("\n").length).toBeGreaterThan(10);
    expect(dark).not.toBe(light);
    expect(dark).toMatch(/^[ ▀▄█\n]+$/);
  });
});
