import {
  ArrowRight,
  EyeOff,
  Ghost,
  Link2,
  Lock,
  Send as SendIcon,
  UserCheck,
  UserX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { FAMILY_LABEL, chainAddrLink, chainTxLink, nearTxLink, short } from "../lib.ts";
import { ChainChip } from "../parts.tsx";
import { useStore } from "../store.tsx";
import type { Config, Family, MetaResult, PayResult } from "../types.ts";
import {
  Button,
  Callout,
  Card,
  Chip,
  CopyText,
  Explorer,
  Field,
  LogBox,
  Segmented,
  Steps,
} from "../ui.tsx";

const DEFAULT_AMOUNT: Record<Family, string> = { evm: "0.01", sol: "0.1", btc: "0.001" };

export function SendTab() {
  const { cfg, lastPay, setLastPay, go, setWho, setScanView } = useStore();
  if (!cfg) return null;
  return (
    <SendInner
      cfg={cfg}
      lastPay={lastPay}
      setLastPay={setLastPay}
      onScan={(who) => {
        setWho(who);
        setScanView("recipient");
        go("scan");
      }}
    />
  );
}

function SendInner({
  cfg,
  lastPay,
  setLastPay,
  onScan,
}: {
  cfg: Config;
  lastPay: PayResult | null;
  setLastPay: (p: PayResult | null) => void;
  onScan: (who: string) => void;
}) {
  const payers = cfg.profiles.filter((p) => p.wallet || p.near);
  const recipients = cfg.profiles.filter((p) => p.recipient);
  const families = useMemo(() => [...new Set(cfg.chains.map((c) => c.family))] as Family[], [cfg]);

  const [payer, setPayer] = useState(cfg.defaults.payer ?? payers[0]?.name ?? "");
  const [to, setTo] = useState(cfg.defaults.recipient ?? recipients[0]?.name ?? "");
  const [family, setFamily] = useState<Family>(families[0] ?? "evm");
  const chainsInFamily = cfg.chains.filter((c) => c.family === family);
  const [chain, setChain] = useState(chainsInFamily[0]?.tag ?? "");
  const [amount, setAmount] = useState(DEFAULT_AMOUNT[families[0] ?? "evm"]);
  const [memo, setMemo] = useState("invoice #42");
  const [noTag, setNoTag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [meta, setMeta] = useState<MetaResult | "checking" | null>(null);

  const chainCfg = cfg.chains.find((c) => c.tag === chain);

  useEffect(() => {
    if (!chainsInFamily.some((c) => c.tag === chain)) setChain(chainsInFamily[0]?.tag ?? "");
  }, [chainsInFamily, chain]);

  // Registered? (debounced registry lookup)
  const seq = useRef(0);
  useEffect(() => {
    const q = to.trim();
    if (!q) return setMeta(null);
    const n = ++seq.current;
    setMeta("checking");
    const t = setTimeout(() => {
      api
        .meta(q)
        .then((m) => n === seq.current && setMeta(m))
        .catch(() => n === seq.current && setMeta(null));
    }, 300);
    return () => clearTimeout(t);
  }, [to]);

  const send = async () => {
    setBusy(true);
    setErr(null);
    setLog([]);
    setLastPay(null);
    try {
      const r = await api.pay(
        {
          recipient: to.trim(),
          amount: amount.trim(),
          chain,
          as: payer,
          memo: memo.trim() || undefined,
          noViewTag: noTag,
        },
        (l) => setLog((x) => [...x, l]),
      );
      setLastPay(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reached = (re: RegExp) => log.some((l) => re.test(l));
  const registered = meta && meta !== "checking" ? meta.registered : null;

  return (
    <div className="grid">
      <Card title="Send privately" icon={<SendIcon size={17} />}>
        <p className="sub">
          Pay a NEAR account on Bitcoin, Ethereum or Solana. The recipient needs no address on that
          chain, and nothing on-chain names them.
        </p>

        <Field label="From" htmlFor="payer">
          <select
            id="payer"
            className="select"
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
            data-testid="payer"
          >
            {payers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.account ? ` (${p.account})` : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Recipient NEAR account" htmlFor="to">
          <input
            id="to"
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="bob.testnet or ghost:bob.testnet"
            spellCheck={false}
            autoComplete="off"
            data-testid="recipient"
          />
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="chips">
              {recipients.map((p) => (
                <Chip key={p.name} onClick={() => setTo(p.name)} icon={<Ghost size={12} />}>
                  {p.name}
                </Chip>
              ))}
            </div>
            <span data-testid="registered">
              {meta === "checking" && <span className="hint pulse">checking registry…</span>}
              {registered === true && (
                <Chip tone="good" icon={<UserCheck size={13} />}>
                  registered
                </Chip>
              )}
              {registered === false && (
                <Chip tone="bad" icon={<UserX size={13} />}>
                  not registered
                </Chip>
              )}
            </span>
          </div>
        </Field>

        <div className="field">
          <span className="label">Asset</span>
          <div className="row">
            <Segmented
              label="Asset"
              value={family}
              onChange={(f) => {
                setFamily(f);
                setAmount(DEFAULT_AMOUNT[f]);
              }}
              options={families.map((f) => ({
                value: f,
                label: FAMILY_LABEL[f],
                testid: `asset-${f}`,
              }))}
            />
            {chainsInFamily.length > 1 ? (
              <select
                className="select"
                style={{ width: "auto" }}
                value={chain}
                onChange={(e) => setChain(e.target.value)}
                aria-label="Network"
                data-testid="network"
              >
                {chainsInFamily.map((c) => (
                  <option key={c.tag} value={c.tag}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="hint">{chainCfg?.name}</span>
            )}
          </div>
        </div>

        <div className="row" style={{ alignItems: "start", flexWrap: "nowrap" }}>
          <div style={{ flex: 1 }}>
            <Field label="Amount" htmlFor="amount">
              <div className="input-affix">
                <input
                  id="amount"
                  className="input"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  data-testid="amount"
                />
                <span className="affix">{chainCfg?.symbol}</span>
              </div>
            </Field>
          </div>
          <div style={{ flex: 1.4 }}>
            <Field label="Private note" htmlFor="memo">
              <input
                id="memo"
                className="input"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                maxLength={120}
                placeholder="optional, encrypted"
                data-testid="memo"
              />
            </Field>
          </div>
        </div>

        <label
          className="row"
          style={{ marginBottom: 16, cursor: "pointer", fontSize: 13.5, color: "var(--muted)" }}
        >
          <input type="checkbox" checked={noTag} onChange={(e) => setNoTag(e.target.checked)} />
          <EyeOff size={14} /> Hide the view tag (bigger anonymity set, slower recipient scan)
        </label>

        <Button
          variant="primary"
          block
          loading={busy}
          disabled={!to.trim() || !amount.trim() || !chain || registered === false}
          onClick={send}
          icon={<Lock size={16} />}
          data-testid="send"
        >
          {busy ? "Sending…" : "Send privately"}
        </Button>
        {registered === false && (
          <p className="hint" style={{ marginTop: 8 }}>
            This account has no meta-address in {cfg.contract}. Ask them to run{" "}
            <code>ghost register</code>.
          </p>
        )}
        {err && (
          <div style={{ marginTop: 14 }}>
            <Callout tone="bad" title="Could not send.">
              {err}
            </Callout>
          </div>
        )}
      </Card>

      <div className="stack">
        {busy && (
          <Card title="Working…">
            <Steps
              steps={[
                {
                  title: "Derive a one-time address",
                  state: reached(/one-time address/) ? "done" : "active",
                  body: <LogBox lines={log.filter((l) => /one-time|MPC-derive/.test(l))} />,
                },
                {
                  title: `Pay it on ${chainCfg?.name ?? chain}`,
                  state: reached(/paying/) ? (reached(/announced/) ? "done" : "active") : "todo",
                },
                {
                  title: "Announce on NEAR (no recipient field)",
                  state: reached(/announced/) ? "done" : reached(/paying/) ? "active" : "todo",
                },
              ]}
            />
          </Card>
        )}
        {!busy && lastPay && (
          <PayResultCard
            cfg={cfg}
            r={lastPay}
            recipientName={recipients.find((p) => p.account === lastPay.recipient)?.name}
            onScanName={onScan}
          />
        )}
        {!busy && !lastPay && <Explainer />}
      </div>
    </div>
  );
}

function PayResultCard({
  cfg,
  r,
  onScanName,
  recipientName,
}: { cfg: Config; r: PayResult; onScanName: (w: string) => void; recipientName?: string }) {
  const tx = chainTxLink(cfg, r.chain, r.pay_tx ?? "", r.pay_tx_url);
  const addr = chainAddrLink(cfg, r.chain, r.address);
  const ntx = r.announce_tx ? nearTxLink(cfg, r.announce_tx, r.announce_tx_url) : undefined;
  return (
    <Card
      title="Sent"
      icon={<Ghost size={17} />}
      aside={<ChainChip cfg={cfg} tag={r.chain} />}
      className="result"
      reveal
    >
      <div style={{ display: "grid", gap: 16 }} data-testid="pay-result">
        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            One-time address
          </div>
          <div className="bigaddr" data-testid="onetime-address">
            <CopyText value={r.address} full />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Chip tone="good">
              {r.amount} {r.asset}
            </Chip>
            {addr && <Explorer href={addr} label="address on explorer" />}
          </div>
        </div>

        <dl className="kv">
          <dt>Derived from</dt>
          <dd>
            <span className="mono">{r.predecessor}</span> +{" "}
            <span className="mono" title={r.path}>
              {short(r.path, 10, 6)}
            </span>{" "}
            <span className="hint">(MPC domain {r.domain_id})</span>
          </dd>
          <dt>Payment tx</dt>
          <dd>
            {r.pay_tx ? (
              <Explorer href={tx} label={short(r.pay_tx, 12, 8)} title={r.pay_tx} />
            ) : (
              <span className="hint">not sent</span>
            )}
          </dd>
          <dt>NEAR announce</dt>
          <dd>
            {r.announce_tx ? (
              <Explorer href={ntx} label={short(r.announce_tx, 12, 6)} title={r.announce_tx} />
            ) : (
              <span className="hint">not announced</span>
            )}
          </dd>
        </dl>

        {r.idx !== undefined && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Announcement #{r.idx} (this is all the chain sees)
            </div>
            <div className="code" data-testid="announcement">
              <span className="dim">{"{"}</span>
              {"\n"}
              {"  "}
              <span className="k">"idx"</span>: <span className="n">{r.idx}</span>,{"\n"}
              {"  "}
              <span className="k">"chain"</span>: "{r.chain}",{"\n"}
              {"  "}
              <span className="k">"eph"</span>: "{short(r.eph, 10, 6)}",{"\n"}
              {"  "}
              <span className="k">"tag"</span>: <span className="n">{r.tag}</span>,{"\n"}
              {"  "}
              <span className="k">"ct"</span>: "encrypted memo",{"\n"}
              {"  "}
              <span className="dim">"recipient": none, ever</span>
              {"\n"}
              <span className="dim">{"}"}</span>
            </div>
          </div>
        )}

        {cfg.simulated && (
          <Callout tone="warn" title="Simulated chains.">
            Addresses, keys and announcements are real cryptography; the transfer and NEAR
            transaction are simulated in dev mode.
          </Callout>
        )}
        <Button
          variant="primary"
          onClick={() => onScanName(recipientName ?? r.recipient)}
          icon={<ArrowRight size={16} />}
          data-testid="to-scan"
        >
          Scan as {recipientName ?? r.recipient}
        </Button>
      </div>
    </Card>
  );
}

function Explainer() {
  return (
    <Card title="How a Ghost Path works" icon={<Link2 size={17} />}>
      <Steps
        steps={[
          {
            title: "Bob registers two public keys under bob.testnet",
            state: "done",
            body: "A spend key and a view key. He holds no BTC, ETH or SOL key.",
          },
          {
            title: "Alice derives a fresh address for this payment alone",
            state: "done",
            body: "From Bob's keys and a random value, through NEAR Chain Signatures (MPC).",
          },
          {
            title: "She pays it, then posts a short announcement on NEAR",
            state: "done",
            body: "Only Bob's view key can recognise it. Nobody else can tell it is his.",
          },
        ]}
      />
      <div className="world" style={{ marginTop: 18 }}>
        <div>
          <h3>The public sees</h3>
          <ul>
            <li>A payment to a fresh address</li>
            <li>An announcement: ephemeral key, view tag</li>
            <li>The announcer's NEAR account</li>
            <li>
              The amount (hidden: <i>who</i>, not <i>how much</i>)
            </li>
          </ul>
        </div>
        <div>
          <h3>Only Bob sees</h3>
          <ul>
            <li>That it is his</li>
            <li>The memo, decrypted</li>
            <li>His total across payments</li>
            <li>Nobody else can link address to Bob</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
