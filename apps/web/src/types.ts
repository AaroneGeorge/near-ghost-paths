/** Shapes of the `ghost serve` JSON API (packages/cli/src/serve.ts). Public data only: no keys live here. */

export type Family = "evm" | "btc" | "sol";

export interface ChainCfg {
  tag: string;
  family: Family;
  name: string;
  symbol: string;
  decimals: number;
  local: boolean;
  mainnet: boolean;
  /** explorer URL templates with `{id}`; null on local chains */
  tx_url: string | null;
  addr_url: string | null;
}

export interface ProfileInfo {
  name: string;
  account: string | null;
  recipient: boolean;
  near: boolean;
  wallet: boolean;
}

export interface Config {
  ok: true;
  mode: "live" | "dev";
  simulated: boolean;
  network: "testnet" | "mainnet";
  contract: string;
  signer: string;
  ghost_mode: "contract" | "account";
  replay: boolean;
  relayer: boolean;
  chains: ChainCfg[];
  defaults: { payer: string | null; recipient: string | null };
  links: { near_tx: string; near_account: string; contract: string; signer: string };
  profiles: ProfileInfo[];
}

export interface Memo {
  amount?: string;
  asset?: string;
  note?: string;
  txid?: string;
}

export interface PayResult {
  simulated?: boolean;
  payer: string;
  recipient: string;
  chain: string;
  amount: string;
  asset: string;
  predecessor: string;
  path: string;
  address: string;
  domain_id: number;
  eph: string;
  tag: number;
  pay_tx?: string;
  pay_tx_url?: string;
  payer_wallet?: string;
  announce_tx?: string;
  announce_tx_url?: string;
  idx?: number;
  announced_via?: string;
}

export interface PaymentRow {
  idx: number;
  chain: string;
  address: string;
  path: string;
  balance: string;
  balance_base: string;
  symbol: string;
  memo?: Memo;
  swept: boolean;
  balance_error?: string;
}

export interface ScanResult {
  simulated?: boolean;
  as: string;
  account: string;
  kind: "keystore" | "viewing-key" | "stranger";
  can_sweep: boolean;
  scanned: number;
  payments: PaymentRow[];
  announcements?: PublicAnnouncement[];
}

export interface PublicAnnouncement {
  idx: number;
  chain: string;
  eph: string;
  tag: number;
  has_memo: boolean;
  ct_bytes: number;
  block_height: number;
  timestamp_ms: number;
  announcer: string;
}

export interface ViewingBundle {
  v: 1;
  account: string;
  view_priv: string;
  spend_pub: string;
  signer: string;
  mode?: string;
  network?: string;
}

export interface SweepResult {
  simulated?: boolean;
  idx: number;
  chain: string;
  from: string;
  to: string;
  path: string;
  mode: "contract" | "account";
  via: string;
  amount: string;
  symbol: string;
  near_txs: { tx_hash: string; tx_url: string }[];
  mpc_ms: number[];
  chain_tx: string;
  chain_tx_url?: string;
  dest_balance_after?: string;
}

export interface QuoteResult {
  simulated?: boolean;
  chain: string;
  amount: string;
  symbol: string;
  to: string;
  recipient: string;
  confidentiality: string;
  fallbackFrom?: string;
  note?: string;
  response?: {
    quote: {
      amountInFormatted: string;
      amountInUsd?: string;
      amountOutFormatted: string;
      amountOutUsd?: string;
      timeEstimate?: number;
    };
  };
}

export interface BalanceResult {
  address: string;
  balance: string;
  symbol: string;
}

export interface MetaResult {
  account: string;
  registered: boolean;
  meta: { mode: string; spend_pub: string; view_pub: string } | null;
}
