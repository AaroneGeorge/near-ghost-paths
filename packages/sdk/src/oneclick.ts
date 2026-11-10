/**
 * NEAR Intents 1Click client (W3). Mainnet only (the API has no testnet).
 *
 *  - Dry quotes (`dry: true`) are free and keyless: always allowed, used by the demo.
 *  - Wet quotes (`dry: false`) return a real deposit address: gated on MAINNET_APPROVED=1, because
 *    the next step is paying it.
 *  - `confidentiality: "basic" | "advanced"` (Confidential Intents) needs an authenticated caller.
 *    Verified 2026-11-09 (spike S6): without ONECLICK_API_KEY the API answers 401 "User
 *    authentication is required for confidential intent quotes". A keyless public quote also
 *    carries a default 20 bps app fee.
 *
 * Docs: https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api
 */
import type { ChainTag } from "./types.ts";

export const ONECLICK_BASE = "https://1click.chaindefuser.com";

export type Confidentiality = "public" | "basic" | "advanced";

/** 1Click asset ids (from GET /v0/tokens, 2026-11-09). */
export const ONECLICK_ASSETS = {
  "eth:base": "nep141:base.omft.near",
  "usdc:base": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "eth:eth": "nep141:eth.omft.near",
  "usdc:eth": "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  sol: "nep141:sol.omft.near",
  "usdc:sol": "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  btc: "nep141:btc.omft.near",
  wnear: "nep141:wrap.near",
} as const;
export type AssetAlias = keyof typeof ONECLICK_ASSETS;

/** Native asset id for the chain a stealth address lives on (1Click origin). */
export function nativeAssetFor(chain: ChainTag): string {
  switch (chain) {
    case "evm:8453":
    case "evm:84532":
      return ONECLICK_ASSETS["eth:base"];
    case "evm:1":
    case "evm:11155111":
    case "evm:31337":
      return ONECLICK_ASSETS["eth:eth"];
    case "sol:mainnet":
    case "sol:devnet":
    case "sol:local":
      return ONECLICK_ASSETS.sol;
    case "btc:mainnet":
    case "btc:testnet4":
    case "btc:regtest":
      return ONECLICK_ASSETS.btc;
    default:
      throw new Error(`no 1Click asset for ${chain}`);
  }
}

export function resolveAsset(a: string): string {
  return (ONECLICK_ASSETS as Record<string, string>)[a.toLowerCase()] ?? a;
}

export interface QuoteRequest {
  dry: boolean;
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";
  slippageTolerance?: number;
  originAsset: string;
  depositType?: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType?: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType?: "DESTINATION_CHAIN" | "INTENTS";
  deadline?: string;
  confidentiality?: Confidentiality;
  referral?: string;
}

export interface Quote {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut?: string;
  timeEstimate?: number;
  depositAddress?: string;
  deadline?: string;
  [k: string]: unknown;
}

export interface QuoteResponse {
  quote: Quote;
  quoteRequest: QuoteRequest & Record<string, unknown>;
  signature?: string;
  timestamp?: string;
  correlationId?: string;
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "OneClickError";
  }
  /** Confidential quote refused for lack of an API key/JWT. */
  get authRequired(): boolean {
    return this.status === 401;
  }
}

export interface OneClickOptions {
  baseUrl?: string;
  /** JWT / API key; env ONECLICK_API_KEY. Never logged. */
  apiKey?: string;
  timeoutMs?: number;
}

export class OneClick {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(o: OneClickOptions = {}) {
    this.base = (o.baseUrl ?? process.env.ONECLICK_BASE_URL ?? ONECLICK_BASE).replace(/\/$/, "");
    this.apiKey = o.apiKey ?? process.env.ONECLICK_API_KEY ?? undefined;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  get hasKey(): boolean {
    return !!this.apiKey;
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        /* keep text */
      }
      throw new OneClickError(
        `1Click ${path}: HTTP ${res.status}: ${msg}`,
        res.status,
        text.slice(0, 1000),
      );
    }
    return JSON.parse(text) as T;
  }

  tokens(): Promise<
    { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number }[]
  > {
    return this.req("GET", "/v0/tokens");
  }

  /** POST /v0/quote. Wet quotes (dry=false) need MAINNET_APPROVED=1. */
  async quote(r: QuoteRequest): Promise<QuoteResponse> {
    if (!r.dry && process.env.MAINNET_APPROVED !== "1") {
      throw new Error(
        "refusing a non-dry 1Click quote: it opens a real deposit address. Set MAINNET_APPROVED=1 with the owner's approval.",
      );
    }
    const body: QuoteRequest = {
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
      confidentiality: "public",
      ...r,
    };
    return this.req("POST", "/v0/quote", body);
  }

  /** Tells 1Click the deposit tx hash (speeds up processing). Mainnet-gated. */
  async submitDeposit(txHash: string, depositAddress: string): Promise<unknown> {
    if (process.env.MAINNET_APPROVED !== "1")
      throw new Error("refusing deposit submit without MAINNET_APPROVED=1");
    return this.req("POST", "/v0/deposit/submit", { txHash, depositAddress });
  }

  status(depositAddress: string): Promise<{ status: string; [k: string]: unknown }> {
    return this.req("GET", `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  }
}

export interface SweepQuoteArgs {
  /** Chain the stealth address lives on (origin). */
  chain: ChainTag;
  /** Amount in origin base units. */
  amount: bigint;
  /** Destination asset id or alias (e.g. "usdc:sol"). */
  to: string;
  recipient: string;
  /** Refund address on the origin chain (the stealth address itself keeps refunds private). */
  refundTo: string;
  confidentiality?: Confidentiality;
  dry?: boolean;
}

export interface SweepQuoteResult {
  ok: boolean;
  confidentiality: Confidentiality;
  /** Set when a confidential quote was refused and we fell back to a public dry quote. */
  fallbackFrom?: Confidentiality;
  note?: string;
  response?: QuoteResponse;
}

/**
 * Quote for a "confidential sweep": stealth balance → 1Click → recipient on any chain.
 * If a confidential level is refused for lack of auth, returns a public dry quote with
 * `fallbackFrom` set and a note, so the caller can say the mitigation is unavailable.
 */
export async function sweepQuote(
  a: SweepQuoteArgs,
  client = new OneClick(),
): Promise<SweepQuoteResult> {
  const conf = a.confidentiality ?? "basic";
  const base: QuoteRequest = {
    dry: a.dry ?? true,
    originAsset: nativeAssetFor(a.chain),
    destinationAsset: resolveAsset(a.to),
    amount: a.amount.toString(),
    recipient: a.recipient,
    refundTo: a.refundTo,
    confidentiality: conf,
  };
  try {
    return { ok: true, confidentiality: conf, response: await client.quote(base) };
  } catch (e) {
    if (e instanceof OneClickError && e.authRequired && conf !== "public") {
      const response = await client.quote({ ...base, dry: true, confidentiality: "public" });
      return {
        ok: true,
        confidentiality: "public",
        fallbackFrom: conf,
        note: `1Click refused confidentiality "${conf}" without an API key (HTTP 401); showing a public dry quote. Set ONECLICK_API_KEY to use Confidential Intents.`,
        response,
      };
    }
    throw e;
  }
}
