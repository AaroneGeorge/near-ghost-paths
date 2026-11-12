import { ArrowDownToLine, Check, Inbox, RefreshCw, Send, Shuffle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import {
  availableTotals,
  chainTxLink,
  delta,
  fmtAmount,
  nearTxLink,
  networkLabel,
  plural,
  short,
  statusOf,
} from "../lib.ts";
import { Coin, StatusBadge } from "../parts.tsx";
import { useStore } from "../store.tsx";
import type { Config, PaymentRow, QuoteResult, ScanResult, SweepResult } from "../types.ts";
import {
  Badge,
  Button,
  CopyText,
  Empty,
  Explorer,
  Field,
  More,
  Note,
  PageHead,
  Panel,
  Progress,
} from "../ui.tsx";

type Route = "relayer" | "self" | "1click";
type Done = { r: SweepResult; before: string };

const ASSETS = [
  { value: "usdc:base", label: "USDC on Base" },
  { value: "usdc:eth", label: "USDC on Ethereum" },
  { value: "usdc:sol", label: "USDC on Solana" },
  { value: "eth:base", label: "ETH on Base" },
  { value: "btc", label: "BTC" },
  { value: "sol", label: "SOL" },
];

export function InboxPage() {
  const { cfg, who, setWho, go } = useStore();
  const [res, setRes] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [done, setDone] = useState<Record<number, Done>>({});

  const run = useCallback(async (name: string) => {
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.scan(name));
    } catch (e) {
      setErr((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    setOpen(null);
    setDone({});
    void run(who);
  }, [who, run]);

  if (!cfg) return null;
  const recipients = cfg.profiles.filter((p) => p.recipient);
  const totals = res ? availableTotals(res.payments) : [];
  const available = res?.payments.filter((p) => statusOf(p) === "unspent").length ?? 0;

  return (
    <div className="page">
      <PageHead
        title={
          <span className="row" style={{ gap: 12 }}>
            Inbox
            {recipients.length > 1 && (
              <select
                className="select inline"
                value={who}
                onChange={(e) => setWho(e.target.value)}
                aria-label="Whose inbox"
                data-testid="scan-as"
                style={{ fontFamily: "var(--sans)" }}
              >
                {recipients.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </span>
        }
      >
        Private payments sent to {res?.account ?? who}. Only {who}'s keys can find them among
        everyone's notes on NEAR.
      </PageHead>

      <Panel data-testid="scan-result">
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div className="stack" style={{ gap: 4 }}>
            <span className="hint">Ready to withdraw</span>
            <div className="balance">
              {totals.length ? (
                totals.map((t) => (
                  <span className="amt" key={t.symbol}>
                    {t.amount}
                    <small>{t.symbol}</small>
                  </span>
                ))
              ) : (
                <span className="amt" style={{ color: "var(--faint)" }}>
                  {res ? "0" : "…"}
                </span>
              )}
            </div>
            {res && (
              <span className="hint">
                Found <b data-testid="found">{res.payments.length}</b>{" "}
                {res.payments.length === 1 ? "payment" : "payments"} in{" "}
                {plural(res.scanned, "public note")}
              </span>
            )}
          </div>
          <Button
            small
            loading={busy}
            onClick={() => run(who)}
            icon={<RefreshCw size={15} />}
            data-testid="scan-run"
          >
            Check for new
          </Button>
        </div>
      </Panel>

      {err && (
        <Note tone="bad" title="Couldn't check the inbox.">
          {err}
        </Note>
      )}

      {res && (
        <Panel
          title="Payments"
          sub={available ? `${available} ready to withdraw` : undefined}
          data-testid="payments"
        >
          {res.payments.length === 0 ? (
            <Empty icon={<Inbox size={24} />} title="Nothing here yet">
              When someone pays {who} privately, it shows up here.{" "}
              <button
                type="button"
                className="btn quiet small"
                style={{ display: "inline-flex", padding: "2px 6px" }}
                onClick={() => go("send")}
              >
                <Send size={14} /> Send a test payment
              </button>
            </Empty>
          ) : (
            <div className="inbox-list">
              {res.payments.map((p) => (
                <PaymentItem
                  key={p.idx}
                  cfg={cfg}
                  p={p}
                  who={who}
                  open={open === p.idx}
                  toggle={() => setOpen((o) => (o === p.idx ? null : p.idx))}
                  done={done[p.idx]}
                  onDone={(d) => {
                    setDone((x) => ({ ...x, [p.idx]: d }));
                    void run(who);
                  }}
                />
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function PaymentItem({
  cfg,
  p,
  who,
  open,
  toggle,
  done,
  onDone,
}: {
  cfg: Config;
  p: PaymentRow;
  who: string;
  open: boolean;
  toggle: () => void;
  done?: Done;
  onDone: (d: Done) => void;
}) {
  const s = statusOf(p);
  const withdrawn = s === "swept";
  return (
    <div className="pay" data-testid="payment-row">
      <div className="pay-row">
        <Coin cfg={cfg} tag={p.chain} />
        <div style={{ minWidth: 0 }}>
          <div className="t">{p.memo?.note || "Payment"}</div>
          <div className="d">
            {networkLabel(cfg, p.chain)} · <span className="mono">{short(p.address, 6, 4)}</span>
          </div>
        </div>
        <div className={`amt ${withdrawn ? "out" : ""}`}>
          {p.balance_error ? "?" : withdrawn && p.memo?.amount ? p.memo.amount : p.balance}{" "}
          <span style={{ color: "var(--muted)", fontSize: 15 }}>{p.symbol}</span>
        </div>
        <div className="act">
          {s === "unspent" && !done ? (
            <Button
              small
              variant={open ? "dark" : undefined}
              onClick={toggle}
              icon={<ArrowDownToLine size={15} />}
              data-testid="withdraw"
            >
              Withdraw
            </Button>
          ) : (
            <StatusBadge p={p} />
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {(open || done) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            style={{ overflow: "hidden" }}
          >
            <Withdraw cfg={cfg} p={p} who={who} done={done} onDone={onDone} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Withdraw({
  cfg,
  p,
  who,
  done,
  onDone,
}: { cfg: Config; p: PaymentRow; who: string; done?: Done; onDone: (d: Done) => void }) {
  const [dest, setDest] = useState("");
  const [isTest, setIsTest] = useState(false);
  const [route, setRoute] = useState<Route>(cfg.relayer ? "relayer" : "self");
  const [asset, setAsset] = useState(ASSETS[0]?.value ?? "");
  const [to1c, setTo1c] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const local = cfg.simulated || !!cfg.chains.find((c) => c.tag === p.chain)?.local;

  const testAddress = useCallback(async () => {
    try {
      setDest((await api.freshDestination(p.chain)).address);
      setIsTest(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [p.chain]);
  // On demo chains, pre-fill an empty test address so the flow is one click.
  useEffect(() => {
    if (local && !dest && !done) void testAddress();
  }, [local, dest, done, testAddress]);

  const sweep = async () => {
    setBusy(true);
    setErr(null);
    setLog([]);
    try {
      const before = await api
        .balance(p.chain, dest.trim())
        .then((b) => b.balance)
        .catch(() => "0");
      const via = route === "self" ? "self" : "relayer";
      const r = await api.sweep({ idx: p.idx, to: dest.trim(), as: who, via }, (l) =>
        setLog((x) => [...x, l]),
      );
      onDone({ r, before });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const getQuote = async () => {
    setBusy(true);
    setErr(null);
    setQuote(null);
    try {
      setQuote(
        await api.quote({
          chain: p.chain,
          amount: p.balance,
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

  if (done) return <Withdrawn cfg={cfg} d={done} who={who} />;

  if (busy && route !== "1click")
    return (
      <div className="withdraw">
        <Progress
          data-testid="sweep-progress"
          steps={[
            {
              title: `Approving with ${who}'s key`,
              state: reached(/preparing/) ? "done" : "active",
              body: "The approval names only this address and the destination.",
            },
            {
              title: "NEAR signs the transfer",
              state: reached(/submit/) ? (reached(/MPC signature/) ? "done" : "active") : "todo",
              body: "NEAR's signing network signs for the one-time address. It never learns who you are.",
            },
            {
              title: `Sending ${p.balance} ${p.symbol} to your address`,
              state: reached(/MPC signature/) ? "active" : "todo",
            },
          ]}
        />
      </div>
    );

  return (
    <div className="withdraw">
      {route !== "1click" ? (
        <Field
          label="Send it to"
          htmlFor={`dest-${p.idx}`}
          hint="Use a different address each time, so your payments can't be linked together."
        >
          <input
            id={`dest-${p.idx}`}
            className="input mono"
            value={dest}
            onChange={(e) => {
              setDest(e.target.value);
              setIsTest(false);
            }}
            placeholder={`Your ${networkLabel(cfg, p.chain)} address`}
            spellCheck={false}
            data-testid="dest"
          />
          {local && (
            <div className="row">
              {isTest && <Badge tone="warn">Empty test address</Badge>}
              <Button
                small
                variant="quiet"
                onClick={testAddress}
                icon={<Shuffle size={14} />}
                data-testid="fresh-dest"
              >
                New test address
              </Button>
            </div>
          )}
        </Field>
      ) : (
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 160px" }}>
            <Field label="Receive as">
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
          <div style={{ flex: "2 1 220px" }}>
            <Field label="At address">
              <input
                className="input mono"
                value={to1c}
                onChange={(e) => setTo1c(e.target.value)}
                placeholder="address on that network"
                spellCheck={false}
                data-testid="oneclick-recipient"
              />
            </Field>
          </div>
        </div>
      )}

      <More label="Privacy options" open={route !== "relayer"}>
        <div className="route" role="radiogroup" aria-label="How to withdraw">
          <RouteOpt
            value="relayer"
            cur={route}
            set={setRoute}
            title="Private"
            tag={<Badge tone="good">Recommended</Badge>}
            desc="A helper service submits it for you, so nothing on NEAR points to your account."
            disabled={!cfg.relayer}
          />
          <RouteOpt
            value="self"
            cur={route}
            set={setRoute}
            title="From my NEAR account"
            desc="Works without the helper, but anyone reading NEAR can see it was you."
          />
          <RouteOpt
            value="1click"
            cur={route}
            set={setRoute}
            title="Convert and deliver anywhere"
            tag={<Badge tone="warn">Quote only</Badge>}
            desc="Swap into another coin or network with NEAR Intents (1Click). Runs on mainnet only."
          />
        </div>
        {route === "self" && (
          <Note tone="warn">This withdrawal will be linked to {who}'s NEAR account.</Note>
        )}
      </More>

      {route !== "1click" ? (
        <Button
          variant="primary"
          block
          disabled={!dest.trim()}
          onClick={sweep}
          icon={<ArrowDownToLine size={17} />}
          data-testid="sweep"
        >
          Withdraw {p.balance} {p.symbol}
        </Button>
      ) : (
        <Button
          variant="primary"
          block
          loading={busy}
          disabled={!to1c.trim()}
          onClick={getQuote}
          data-testid="quote"
        >
          Get a quote
        </Button>
      )}
      {err && (
        <Note
          tone="bad"
          title={route === "1click" ? "No quote." : "The withdrawal didn't go through."}
        >
          {err}
        </Note>
      )}
      {quote && <Quote q={quote} />}
    </div>
  );
}

function RouteOpt({
  value,
  cur,
  set,
  title,
  tag,
  desc,
  disabled,
}: {
  value: Route;
  cur: Route;
  set: (r: Route) => void;
  title: string;
  tag?: React.ReactNode;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: custom radio buttons
      role="radio"
      aria-checked={cur === value}
      className="route-opt"
      disabled={disabled}
      onClick={() => set(value)}
      data-testid={`route-${value}`}
    >
      <span className="radio" />
      <span>
        <span className="t">
          {title}
          {tag}
        </span>
        <span className="d">{desc}</span>
      </span>
    </button>
  );
}

function Withdrawn({ cfg, d, who }: { cfg: Config; d: Done; who: string }) {
  const { r, before } = d;
  const nt = r.near_txs[0];
  const ms = r.mpc_ms.reduce((a, b) => a + b, 0);
  const after = r.dest_balance_after;
  return (
    <div className="withdraw" data-testid="sweep-result">
      <div className="arrived">
        <motion.span
          className="seal"
          initial={{ scale: 0.5 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", bounce: 0.5 }}
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "var(--pine)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            flex: "none",
          }}
        >
          <Check size={20} strokeWidth={2.6} />
        </motion.span>
        <div style={{ minWidth: 0 }}>
          <div className="plus" data-testid="bal-delta">
            {fmtAmount(after ? delta(after, before) : r.amount)} {r.symbol}
          </div>
          <div className="d">
            arrived at <span className="mono">{short(r.to, 8, 6)}</span>
            {after && (
              <>
                {" "}
                (balance <span data-testid="bal-before">{fmtAmount(before)}</span> →{" "}
                <span data-testid="bal-after">{fmtAmount(after)}</span> {r.symbol})
              </>
            )}
          </div>
        </div>
      </div>
      <Note tone="good">
        On NEAR, the record shows a contract and a random-looking code. Nothing names {who}.
      </Note>
      {r.via === "self" && <Note tone="warn">Sent from {who}'s NEAR account, so it's linked.</Note>}
      <More label="Technical details">
        <dl className="facts">
          <dt>From</dt>
          <dd>
            <CopyText value={r.from} />
          </dd>
          <dt>To</dt>
          <dd>
            <CopyText value={r.to} />
          </dd>
          <dt>NEAR request</dt>
          <dd>
            {nt ? (
              <Explorer
                href={nearTxLink(cfg, nt.tx_hash, nt.tx_url)}
                label={short(nt.tx_hash, 12, 6)}
              />
            ) : (
              "none"
            )}{" "}
            <span className="hint">
              ({r.via === "relayer" ? "sent by the helper" : "sent by you"})
            </span>
          </dd>
          <dt>Signed by NEAR in</dt>
          <dd>{(ms / 1000).toFixed(1)} s (Chain Signatures MPC)</dd>
          <dt>Transfer</dt>
          <dd>
            <Explorer
              href={chainTxLink(cfg, r.chain, r.chain_tx, r.chain_tx_url)}
              label={short(r.chain_tx, 12, 8)}
              title={r.chain_tx}
            />
          </dd>
          <dt>Code signed</dt>
          <dd className="mono">{short(r.path, 10, 6)}</dd>
        </dl>
      </More>
    </div>
  );
}

function Quote({ q }: { q: QuoteResult }) {
  const quote = q.response?.quote;
  return (
    <div className="stack" style={{ gap: 10 }} data-testid="quote-result">
      <div
        className="arrived"
        style={{ background: "var(--card)", justifyContent: "space-between" }}
      >
        <div>
          <div className="d" style={{ color: "var(--muted)" }}>
            You send
          </div>
          <div className="plus" style={{ color: "var(--ink)", fontSize: 22 }}>
            {quote?.amountInFormatted ?? q.amount} {q.symbol}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="d" style={{ color: "var(--muted)" }}>
            You receive about
          </div>
          <div className="plus" style={{ fontSize: 22 }}>
            {quote?.amountOutFormatted ?? "?"}
          </div>
        </div>
      </div>
      <div className="row">
        <Badge tone="warn">Quote only, nothing sent</Badge>
        <Badge tone={q.fallbackFrom ? "warn" : "good"}>
          Privacy: {q.confidentiality}
          {q.fallbackFrom ? ` (asked for ${q.fallbackFrom})` : ""}
        </Badge>
        {quote?.timeEstimate !== undefined && <Badge>about {quote.timeEstimate} s</Badge>}
      </div>
      {q.note && <Note tone="warn">{q.note}</Note>}
    </div>
  );
}
