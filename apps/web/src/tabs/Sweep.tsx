import { ArrowRightLeft, Dices, EyeOff, Handshake, Radio, ShieldAlert, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { chainTxLink, delta, nearTxLink, short, statusOf } from "../lib.ts";
import { ChainChip, NoPayments, StatusChip } from "../parts.tsx";
import { useStore } from "../store.tsx";
import type { Config, PaymentRow, QuoteResult, ScanResult, SweepResult } from "../types.ts";
import {
  Button,
  Callout,
  Card,
  Chip,
  CopyText,
  Empty,
  Explorer,
  Field,
  LogBox,
  Steps,
} from "../ui.tsx";

type Route = "relayer" | "self" | "1click";

const ASSETS = [
  { value: "usdc:base", label: "USDC on Base" },
  { value: "usdc:eth", label: "USDC on Ethereum" },
  { value: "usdc:sol", label: "USDC on Solana" },
  { value: "eth:base", label: "ETH on Base" },
  { value: "btc", label: "BTC" },
  { value: "sol", label: "SOL" },
];

export function SweepTab() {
  const { cfg, who, setWho, sweepPick, setSweepPick } = useStore();
  if (!cfg) return null;
  return (
    <SweepInner
      cfg={cfg}
      who={who}
      setWho={setWho}
      pre={sweepPick}
      clearPre={() => setSweepPick(null)}
    />
  );
}

function SweepInner({
  cfg,
  who,
  setWho,
  pre,
  clearPre,
}: {
  cfg: Config;
  who: string;
  setWho: (w: string) => void;
  pre: PaymentRow | null;
  clearPre: () => void;
}) {
  const recipients = cfg.profiles.filter((p) => p.recipient);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pickIdx, setPickIdx] = useState<number | null>(pre?.idx ?? null);
  const [dest, setDest] = useState("");
  const [route, setRoute] = useState<Route>(cfg.relayer ? "relayer" : "self");
  const [asset, setAsset] = useState(ASSETS[0]?.value ?? "");
  const [to1c, setTo1c] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ r: SweepResult; before: string } | null>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);

  const refresh = useCallback(async () => {
    if (!who) return;
    setLoading(true);
    setScanErr(null);
    try {
      const r = await api.scan(who);
      setScan(r);
      setPickIdx((cur) => {
        if (cur !== null && r.payments.some((p) => p.idx === cur && statusOf(p) === "unspent"))
          return cur;
        return r.payments.find((p) => statusOf(p) === "unspent")?.idx ?? null;
      });
    } catch (e) {
      setScanErr((e as Error).message);
      setScan(null);
    } finally {
      setLoading(false);
    }
  }, [who]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (pre) {
      setPickIdx(pre.idx);
      clearPre();
    }
  }, [pre, clearPre]);

  const pick = useMemo(
    () => scan?.payments.find((p) => p.idx === pickIdx) ?? null,
    [scan, pickIdx],
  );
  const unspent = scan?.payments.filter((p) => statusOf(p) === "unspent") ?? [];

  // A fresh destination per payment is the privacy-preserving default; pre-fill it, never overwrite typing.
  const [auto, setAuto] = useState(true);
  const fresh = useCallback(async () => {
    if (!pick) return;
    try {
      setDest((await api.freshDestination(pick.chain)).address);
      setAuto(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [pick]);
  const pickKey = pick ? `${pick.idx}:${pick.chain}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the selected payment changes
  useEffect(() => {
    if (pickKey && (auto || !dest)) void fresh();
  }, [pickKey]);

  const sweep = async () => {
    if (!pick || route === "1click") return;
    setBusy(true);
    setErr(null);
    setLog([]);
    setResult(null);
    try {
      const before = await api
        .balance(pick.chain, dest.trim())
        .then((b) => b.balance)
        .catch(() => "0");
      const r = await api.sweep({ idx: pick.idx, to: dest.trim(), as: who, via: route }, (l) =>
        setLog((x) => [...x, l]),
      );
      setResult({ r, before });
      void refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const getQuote = async () => {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    setQuote(null);
    try {
      setQuote(
        await api.quote({
          chain: pick.chain,
          amount: pick.balance,
          to: asset,
          recipient: to1c.trim(),
          confidential: "basic",
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reached = (re: RegExp) => log.some((l) => re.test(l));
  const canSweep = !!pick && statusOf(pick) === "unspent" && dest.trim().length > 0;

  return (
    <div className="grid">
      <div className="stack">
        <Card
          title="1. Pick a payment"
          icon={<Wallet size={17} />}
          aside={
            <select
              className="select"
              style={{ width: "auto" }}
              value={who}
              onChange={(e) => setWho(e.target.value)}
              aria-label="Sweep as"
              data-testid="sweep-as"
            >
              {recipients.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          }
        >
          {scanErr && <Callout tone="bad">{scanErr}</Callout>}
          {loading && !scan && <p className="hint pulse">scanning…</p>}
          {scan && scan.payments.length === 0 && (
            <NoPayments>Send something first, then come back.</NoPayments>
          )}
          {scan && scan.payments.length > 0 && (
            <div
              className="pick"
              role="radiogroup"
              aria-label="Payments"
              data-testid="payment-list"
            >
              {scan.payments.map((p) => {
                const s = statusOf(p);
                return (
                  <button
                    key={p.idx}
                    type="button"
                    // biome-ignore lint/a11y/useSemanticElements: custom radio buttons
                    role="radio"
                    aria-checked={pickIdx === p.idx}
                    className="option"
                    disabled={s !== "unspent"}
                    onClick={() => setPickIdx(p.idx)}
                    data-testid="payment-option"
                  >
                    <span className="radio" />
                    <span>
                      <span className="t">
                        #{p.idx} · <span className="mono">{short(p.address, 8, 6)}</span>
                      </span>
                      <br />
                      <span className="d">{p.memo?.note ?? "no memo"}</span>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      <span className="amount">
                        {p.balance} {p.symbol}
                      </span>
                      <br />
                      <span className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        <ChainChip cfg={cfg} tag={p.chain} />
                        <StatusChip p={p} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {scan && scan.payments.length > 0 && unspent.length === 0 && (
            <p className="hint" style={{ marginTop: 10 }}>
              Everything found has been swept.
            </p>
          )}
        </Card>

        <Card title="2. Where to" icon={<ArrowRightLeft size={17} />}>
          <Field
            label="Destination address"
            htmlFor="dest"
            hint="Use a different destination for each payment. Sweeping several to one address links them."
          >
            <input
              id="dest"
              className="input mono"
              value={dest}
              onChange={(e) => {
                setDest(e.target.value);
                setAuto(false);
              }}
              placeholder="address on the same chain"
              spellCheck={false}
              data-testid="dest"
            />
          </Field>
          <Button
            small
            onClick={fresh}
            disabled={!pick}
            icon={<Dices size={14} />}
            data-testid="fresh-dest"
          >
            Fresh throwaway address
          </Button>

          <div className="field" style={{ marginTop: 18 }}>
            <span className="label">Route</span>
            <div className="pick" role="radiogroup" aria-label="Route">
              <RouteOption
                value="relayer"
                cur={route}
                set={setRoute}
                icon={<Radio size={16} />}
                title="Relayer"
                tag="recommended"
                desc="A relayer submits the NEAR transaction. Nothing on NEAR links the sweep to your account."
                disabled={!cfg.relayer}
              />
              <RouteOption
                value="self"
                cur={route}
                set={setRoute}
                icon={<EyeOff size={16} />}
                title="Self-submit"
                desc="You submit from your own NEAR account. Works without a relayer, but links the sweep to your account."
              />
              <RouteOption
                value="1click"
                cur={route}
                set={setRoute}
                icon={<Handshake size={16} />}
                title="1Click (NEAR Intents)"
                tag="mainnet"
                desc="Swap and deliver on any chain, confidentially. Quote only on test networks."
              />
            </div>
          </div>

          {route === "self" && (
            <Callout tone="warn" title="This links the sweep to your NEAR account.">
              Anyone reading NEAR will see who asked for the signature. Prefer the relayer.
            </Callout>
          )}
          {route === "1click" && (
            <div style={{ marginTop: 6 }}>
              <div className="row" style={{ alignItems: "start", flexWrap: "nowrap" }}>
                <div style={{ flex: 1 }}>
                  <Field label="Deliver as">
                    <select
                      className="select"
                      value={asset}
                      onChange={(e) => setAsset(e.target.value)}
                      data-testid="oneclick-asset"
                    >
                      {ASSETS.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div style={{ flex: 1.4 }}>
                  <Field label="Recipient address there">
                    <input
                      className="input mono"
                      value={to1c}
                      onChange={(e) => setTo1c(e.target.value)}
                      placeholder="address on the destination chain"
                      spellCheck={false}
                      data-testid="oneclick-recipient"
                    />
                  </Field>
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            {route !== "1click" ? (
              <Button
                variant="primary"
                block
                loading={busy}
                disabled={!canSweep}
                onClick={sweep}
                icon={<ArrowRightLeft size={16} />}
                data-testid="sweep"
              >
                {busy ? "Sweeping…" : `Sweep${pick ? ` ${pick.balance} ${pick.symbol}` : ""}`}
              </Button>
            ) : (
              <Button
                variant="primary"
                block
                loading={busy}
                disabled={!pick || !to1c.trim()}
                onClick={getQuote}
                icon={<Handshake size={16} />}
                data-testid="quote"
              >
                Get a confidential 1Click quote
              </Button>
            )}
          </div>
          {err && (
            <div style={{ marginTop: 14 }}>
              <Callout tone="bad" title={route === "1click" ? "No quote." : "Sweep failed."}>
                {err}
              </Callout>
            </div>
          )}
        </Card>
      </div>

      <div className="stack">
        {busy && route !== "1click" && (
          <Card title="Sweeping…">
            <Steps
              steps={[
                {
                  title: "Sign a sweep authorisation with this payment's own key",
                  state: reached(/preparing/) ? "done" : "active",
                  body: "Binds the contract, the path, the destination and an expiry. A relayer can censor it, never redirect it.",
                },
                {
                  title: route === "relayer" ? "Relayer calls ghost.sweep" : "You call ghost.sweep",
                  state: reached(/submit/)
                    ? reached(/MPC signature/)
                      ? "done"
                      : "active"
                    : "todo",
                },
                {
                  title: "The MPC network signs the transaction",
                  state: reached(/MPC signature/) ? "done" : reached(/submit/) ? "active" : "todo",
                  body: "Chain Signatures: a threshold of node operators signs for the derived address.",
                },
                {
                  title: "Broadcast on the target chain",
                  state: reached(/MPC signature/) ? "active" : "todo",
                },
              ]}
            />
            <div style={{ marginTop: 14 }}>
              <LogBox lines={log} />
            </div>
          </Card>
        )}
        {!busy && result && <SweepResultCard cfg={cfg} r={result.r} before={result.before} />}
        {!busy && quote && <QuoteCard q={quote} cfg={cfg} />}
        {!busy && !result && !quote && (
          <Card title="What a sweep does" icon={<ShieldAlert size={17} />}>
            <Empty icon={<ArrowRightLeft size={28} />} title="Move a stealth payment out">
              <p style={{ maxWidth: 380, margin: 0 }}>
                Pick a payment, a destination and a route. The Ghost Paths contract checks your
                signature, asks the MPC network to sign for the one-time address, and the funds land
                at the destination.
              </p>
            </Empty>
          </Card>
        )}
      </div>
    </div>
  );
}

function RouteOption({
  value,
  cur,
  set,
  icon,
  title,
  tag,
  desc,
  disabled,
}: {
  value: Route;
  cur: Route;
  set: (r: Route) => void;
  icon: React.ReactNode;
  title: string;
  tag?: string;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: custom radio buttons
      role="radio"
      aria-checked={cur === value}
      className="option"
      disabled={disabled}
      onClick={() => set(value)}
      data-testid={`route-${value}`}
    >
      <span className="radio" />
      <span>
        <span className="t row" style={{ gap: 8 }}>
          {icon}
          {title}
          {tag && <Chip tone={tag === "recommended" ? "good" : "warn"}>{tag}</Chip>}
        </span>
        <span className="d">{desc}</span>
      </span>
      <span />
    </button>
  );
}

function SweepResultCard({ cfg, r, before }: { cfg: Config; r: SweepResult; before: string }) {
  const nt = r.near_txs[0];
  const ms = r.mpc_ms.reduce((a, b) => a + b, 0);
  const afterBal = r.dest_balance_after ?? "?";
  return (
    <Card
      title="Swept"
      icon={<ArrowRightLeft size={17} />}
      aside={<ChainChip cfg={cfg} tag={r.chain} />}
      reveal
    >
      <div style={{ display: "grid", gap: 16 }} data-testid="sweep-result">
        <div className="delta">
          <div className="col">
            <span className="l">Destination before</span>
            <span className="v" data-testid="bal-before">
              {before} {r.symbol}
            </span>
          </div>
          <span className="plus" data-testid="bal-delta">
            {afterBal === "?" ? "→" : delta(afterBal, before)} {r.symbol}
          </span>
          <div className="col" style={{ textAlign: "right" }}>
            <span className="l">Destination after</span>
            <span className="v" data-testid="bal-after">
              {afterBal} {r.symbol}
            </span>
          </div>
        </div>
        <Steps
          steps={[
            {
              title: "Sweep authorised",
              state: "done",
              body: (
                <span>
                  From <CopyText value={r.from} head={10} tail={6} /> to{" "}
                  <CopyText value={r.to} head={10} tail={6} />
                </span>
              ),
            },
            {
              title:
                r.via === "relayer" ? "Relayer called the contract" : "You called the contract",
              state: "done",
              body: nt ? (
                <Explorer
                  href={nearTxLink(cfg, nt.tx_hash, nt.tx_url)}
                  label={short(nt.tx_hash, 12, 6)}
                />
              ) : undefined,
            },
            {
              title: `MPC signature in ${(ms / 1000).toFixed(1)} s`,
              state: "done",
              body: (
                <span className="mono" title={r.path}>
                  path {short(r.path, 10, 6)}
                </span>
              ),
            },
            {
              title: `${r.amount} ${r.symbol} broadcast`,
              state: "done",
              body: (
                <Explorer
                  href={chainTxLink(cfg, r.chain, r.chain_tx, r.chain_tx_url)}
                  label={short(r.chain_tx, 12, 8)}
                  title={r.chain_tx}
                />
              ),
            },
          ]}
        />
        <Callout tone="good" title="On NEAR the contract asked for a signature on a path.">
          <span className="mono">{cfg.contract}</span> requested a signature for{" "}
          <span className="mono">{short(r.path, 10, 6)}</span>. Nothing in that transaction names
          the recipient.
        </Callout>
        {r.via === "self" && (
          <Callout tone="warn" title="Self-submitted.">
            This sweep is linked to your NEAR account.
          </Callout>
        )}
        {cfg.simulated && (
          <Callout tone="warn" title="Simulated chains.">
            The authorisation signature and the contract's checks are real; the MPC signature,
            transfer and NEAR transaction are simulated.
          </Callout>
        )}
      </div>
    </Card>
  );
}

function QuoteCard({ q, cfg }: { q: QuoteResult; cfg: Config }) {
  const quote = q.response?.quote;
  return (
    <Card
      title="1Click quote"
      icon={<Handshake size={17} />}
      aside={<Chip tone="warn">dry run, nothing sent</Chip>}
      reveal
    >
      <div style={{ display: "grid", gap: 14 }} data-testid="quote-result">
        <div className="delta">
          <div className="col">
            <span className="l">You send</span>
            <span className="v">
              {quote?.amountInFormatted ?? q.amount} {q.symbol}
            </span>
            {quote?.amountInUsd && (
              <span className="hint">~${Number(quote.amountInUsd).toFixed(2)}</span>
            )}
          </div>
          <span className="plus">→</span>
          <div className="col" style={{ textAlign: "right" }}>
            <span className="l">They receive</span>
            <span className="v">{quote?.amountOutFormatted ?? "?"}</span>
            {quote?.amountOutUsd && (
              <span className="hint">~${Number(quote.amountOutUsd).toFixed(2)}</span>
            )}
          </div>
        </div>
        <div className="row">
          <Chip tone={q.fallbackFrom ? "warn" : "good"}>
            confidentiality: {q.confidentiality}
            {q.fallbackFrom ? ` (wanted ${q.fallbackFrom})` : ""}
          </Chip>
          {quote?.timeEstimate !== undefined && <Chip>~{quote.timeEstimate} s</Chip>}
        </div>
        {q.note && <Callout tone="warn">{q.note}</Callout>}
        <Callout tone="accent" title="How it protects you.">
          The sweep pays a 1Click deposit address instead of your destination, and the recipient is
          paid on any chain through NEAR Intents. With Confidential Intents the hop between the two
          is not publicly linkable. 1Click runs on mainnet only
          {cfg.network === "testnet" ? ", so on testnet this stays a quote" : ""}.
        </Callout>
      </div>
    </Card>
  );
}
