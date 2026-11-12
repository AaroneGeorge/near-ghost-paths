import { ArrowRight, Check, Ghost, Lock, RotateCcw, UserCheck, UserX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  FAMILY_LABEL,
  FAMILY_NAME,
  chainAddrLink,
  chainTxLink,
  nameOf,
  nearTxLink,
  networkLabel,
  offeredNames,
  short,
} from "../lib.ts";
import { FamilyIcon } from "../parts.tsx";
import { useStore } from "../store.tsx";
import type { Config, Family, MetaResult, PayResult } from "../types.ts";
import {
  Avatar,
  Badge,
  Button,
  CopyText,
  Explorer,
  Field,
  More,
  Note,
  PageHead,
  Panel,
  Progress,
} from "../ui.tsx";

const DEFAULT_AMOUNT: Record<Family, string> = { evm: "0.01", sol: "0.1", btc: "0.001" };
const swap = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.22 },
};

export function SendPage() {
  const { cfg, lastPay, setLastPay, go, setWho } = useStore();
  if (!cfg) return null;
  return (
    <div className="page">
      <PageHead title="Send money privately">
        Pay anyone with a NEAR account on {offeredNames(cfg)}. The money lands at a brand-new
        address that nobody else can trace back to them.
      </PageHead>
      <SendFlow
        cfg={cfg}
        lastPay={lastPay}
        setLastPay={setLastPay}
        openInbox={(name) => {
          setWho(name);
          go("inbox");
        }}
      />
    </div>
  );
}

/** You → a fresh one-time address → them. The one memorable picture of what Ghost Paths does. */
function GhostPath({
  from,
  to,
  address,
  lit,
}: { from: string; to: string; address?: string; lit?: boolean }) {
  const draw = (delay: number) =>
    lit
      ? {
          initial: { pathLength: 0 },
          animate: { pathLength: 1 },
          transition: { duration: 0.6, delay, ease: "easeInOut" as const },
        }
      : {};
  return (
    <div className="path" aria-hidden="true">
      <div className="node">
        <div className="disc you">{from.slice(0, 1).toUpperCase() || "?"}</div>
        <div className="cap">
          <b>{from || "You"}</b>pays
        </div>
      </div>
      <svg className="trail" viewBox="0 0 100 12" preserveAspectRatio="none">
        <title>path</title>
        <line x1="2" y1="6" x2="98" y2="6" />
        {lit && <motion.line x1="2" y1="6" x2="98" y2="6" className="on" {...draw(0)} />}
      </svg>
      <div className="node">
        <motion.div
          className={`disc ghost ${lit ? "lit" : ""}`}
          animate={lit ? { scale: [1, 1.12, 1] } : {}}
          transition={{ duration: 0.5, delay: 0.55 }}
        >
          <Ghost size={22} />
        </motion.div>
        <div className="cap">
          <b>{address ? short(address, 6, 4) : "New address"}</b>used once
        </div>
      </div>
      <svg className="trail" viewBox="0 0 100 12" preserveAspectRatio="none">
        <title>path</title>
        <line x1="2" y1="6" x2="98" y2="6" />
        {lit && <motion.line x1="2" y1="6" x2="98" y2="6" className="on" {...draw(0.7)} />}
      </svg>
      <div className="node">
        <div className="disc them">{to.slice(0, 1).toUpperCase() || "?"}</div>
        <div className="cap">
          <b>{to || "Them"}</b>receives
        </div>
      </div>
    </div>
  );
}

function SendFlow({
  cfg,
  lastPay,
  setLastPay,
  openInbox,
}: {
  cfg: Config;
  lastPay: PayResult | null;
  setLastPay: (p: PayResult | null) => void;
  openInbox: (who: string) => void;
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
  const [memo, setMemo] = useState("");
  const [noTag, setNoTag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [meta, setMeta] = useState<MetaResult | "checking" | null>(null);

  const chainCfg = cfg.chains.find((c) => c.tag === chain);

  useEffect(() => {
    if (!chainsInFamily.some((c) => c.tag === chain)) setChain(chainsInFamily[0]?.tag ?? "");
  }, [chainsInFamily, chain]);

  // Is the recipient set up? (debounced registry lookup)
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
  const toName = to.trim();
  const sym = chainCfg?.symbol ?? FAMILY_LABEL[family];
  const stage = busy ? "busy" : lastPay ? "done" : "form";

  return (
    <AnimatePresence mode="wait" initial={false}>
      {stage === "form" && (
        <motion.div key="form" {...swap}>
          <Panel>
            <div className="stack" style={{ gap: 22 }}>
              <GhostPath from={payer} to={toName} />

              {payers.length > 1 && (
                <div className="row">
                  <span className="hint">Paying from</span>
                  <select
                    className="select inline"
                    value={payer}
                    onChange={(e) => setPayer(e.target.value)}
                    aria-label="Paying from"
                    data-testid="payer"
                  >
                    {payers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <Field
                label="Who are you paying?"
                htmlFor="to"
                hint={
                  registered === false ? (
                    <span style={{ color: "var(--rose)" }}>
                      {toName} hasn't set up Ghost Paths yet, so they can't receive private
                      payments.
                    </span>
                  ) : (
                    `Their NEAR account name. They don't need an ${offeredNames(cfg)} address.`
                  )
                }
              >
                <div className="who-input">
                  <input
                    id="to"
                    className="input"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="bob.testnet"
                    spellCheck={false}
                    autoComplete="off"
                    data-testid="recipient"
                    style={{ paddingRight: 130 }}
                  />
                  <span className="status" data-testid="registered">
                    {meta === "checking" && <Badge className="badge pulse">Checking</Badge>}
                    {registered === true && (
                      <Badge tone="good">
                        <UserCheck size={14} /> Ready
                      </Badge>
                    )}
                    {registered === false && (
                      <Badge tone="bad">
                        <UserX size={14} /> Not set up
                      </Badge>
                    )}
                  </span>
                </div>
                {recipients.length > 0 && (
                  <div className="picks">
                    {recipients.map((p) => (
                      <button
                        type="button"
                        key={p.name}
                        className="pick-chip"
                        onClick={() => setTo(p.name)}
                      >
                        <Avatar name={p.name} />
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </Field>

              <div className="field">
                <span className="label">What are you sending?</span>
                <div className="assets" role="radiogroup" aria-label="Currency">
                  {families.map((f) => (
                    <button
                      key={f}
                      type="button"
                      // biome-ignore lint/a11y/useSemanticElements: custom radio tiles
                      role="radio"
                      aria-checked={family === f}
                      className="asset"
                      data-testid={`asset-${f}`}
                      onClick={() => {
                        setFamily(f);
                        setAmount(DEFAULT_AMOUNT[f]);
                      }}
                    >
                      <span className={`coin ${f}`} style={{ width: 34, height: 34 }}>
                        <FamilyIcon family={f} size={17} />
                      </span>
                      <span>
                        <span className="t">{FAMILY_NAME[f]}</span>
                        <br />
                        <span className="d">{FAMILY_LABEL[f]}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {chainsInFamily.length > 1 ? (
                  <select
                    className="select"
                    value={chain}
                    onChange={(e) => setChain(e.target.value)}
                    aria-label="Network"
                    data-testid="network"
                  >
                    {chainsInFamily.map((c) => (
                      <option key={c.tag} value={c.tag}>
                        {networkLabel(cfg, c.tag)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="hint">On {networkLabel(cfg, chain)}</span>
                )}
              </div>

              <Field label="Amount" htmlFor="amount">
                <div className="amount-box">
                  <input
                    id="amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    data-testid="amount"
                    autoComplete="off"
                  />
                  <span className="sym">{sym}</span>
                </div>
              </Field>

              <Field
                label="Note (optional)"
                htmlFor="memo"
                hint={`Encrypted. Only ${toName || "the recipient"} can read it.`}
              >
                <input
                  id="memo"
                  className="input"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  maxLength={120}
                  placeholder="What's it for? e.g. invoice #42"
                  data-testid="memo"
                />
              </Field>

              <More label="More options">
                <label
                  className="row"
                  style={{ cursor: "pointer", alignItems: "flex-start", flexWrap: "nowrap" }}
                >
                  <input
                    type="checkbox"
                    checked={noTag}
                    onChange={(e) => setNoTag(e.target.checked)}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    <b style={{ fontWeight: 600 }}>Extra privacy</b>
                    <br />
                    <span className="hint">
                      Leaves out a small hint that helps {toName || "the recipient"} find the
                      payment quickly. Harder to spot, slower for them to find.
                    </span>
                  </span>
                </label>
              </More>

              <Button
                variant="primary"
                big
                block
                disabled={!toName || !amount.trim() || !chain || registered === false}
                onClick={send}
                icon={<Lock size={17} />}
                data-testid="send"
              >
                Send {amount.trim() || "0"} {sym} privately
              </Button>
              {err && (
                <Note tone="bad" title="The payment didn't go through.">
                  {err}
                </Note>
              )}
            </div>
          </Panel>
        </motion.div>
      )}

      {stage === "busy" && (
        <motion.div key="busy" {...swap}>
          <Panel title={`Sending ${amount} ${sym} to ${toName}`}>
            <div className="stack" style={{ gap: 20 }}>
              <GhostPath from={payer} to={toName} />
              <Progress
                data-testid="send-progress"
                steps={[
                  {
                    title: `Creating a new address for ${toName}`,
                    state: reached(/one-time address/) ? "done" : "active",
                    body: "Made just for this payment. It can't be linked to their other payments.",
                  },
                  {
                    title: `Sending ${amount} ${sym}`,
                    state: reached(/paying/) ? (reached(/announced/) ? "done" : "active") : "todo",
                    body: `On ${networkLabel(cfg, chain)}`,
                  },
                  {
                    title: `Leaving an encrypted note for ${toName} on NEAR`,
                    state: reached(/announced/) ? "done" : reached(/paying/) ? "active" : "todo",
                    body: "Only they can tell it's for them.",
                  },
                ]}
              />
            </div>
          </Panel>
        </motion.div>
      )}

      {stage === "done" && lastPay && (
        <motion.div key="done" {...swap}>
          <Receipt
            cfg={cfg}
            r={lastPay}
            from={payer}
            onInbox={openInbox}
            onAgain={() => setLastPay(null)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Receipt({
  cfg,
  r,
  from,
  onInbox,
  onAgain,
}: {
  cfg: Config;
  r: PayResult;
  from: string;
  onInbox: (w: string) => void;
  onAgain: () => void;
}) {
  const who = nameOf(cfg, r.recipient);
  const canOpenInbox = cfg.profiles.some((p) => p.recipient && p.name === who);
  const tx = chainTxLink(cfg, r.chain, r.pay_tx ?? "", r.pay_tx_url);
  const addr = chainAddrLink(cfg, r.chain, r.address);
  const ntx = r.announce_tx ? nearTxLink(cfg, r.announce_tx, r.announce_tx_url) : undefined;
  return (
    <Panel data-testid="pay-result">
      <div className="stack" style={{ gap: 20 }}>
        <div className="receipt">
          <motion.div
            className="seal"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", bounce: 0.45, duration: 0.5 }}
          >
            <Check size={28} strokeWidth={2.6} />
          </motion.div>
          <div className="sub">Sent privately</div>
          <div className="big">
            {r.amount}
            <small>{r.asset}</small>
          </div>
          <div className="sub">
            to <b style={{ color: "var(--ink)" }}>{who}</b> on {networkLabel(cfg, r.chain)}
          </div>
        </div>

        <GhostPath from={from} to={who} address={r.address} lit />

        <div className="addr-box">
          <span className="l">{who}'s new address, used only for this payment</span>
          <span data-testid="onetime-address">
            <CopyText value={r.address} full />
          </span>
          {addr && <Explorer href={addr} label="View on explorer" />}
        </div>

        <Note tone="good">
          Anyone can see that {r.amount} {r.asset} moved. Nobody but {who} can tell it was for them.
        </Note>

        <div className="row" style={{ gap: 8 }}>
          {canOpenInbox && (
            <Button
              variant="primary"
              onClick={() => onInbox(who)}
              icon={<ArrowRight size={17} />}
              data-testid="to-inbox"
              style={{ flex: 1 }}
            >
              Open {who}'s inbox
            </Button>
          )}
          <Button onClick={onAgain} icon={<RotateCcw size={16} />} data-testid="send-again">
            Send another
          </Button>
        </div>

        <More label="Technical details" data-testid="pay-details">
          <dl className="facts">
            <dt>Payment</dt>
            <dd>
              {r.pay_tx ? (
                <Explorer href={tx} label={short(r.pay_tx, 12, 8)} title={r.pay_tx} />
              ) : (
                <span className="hint">not sent</span>
              )}
            </dd>
            <dt>Note on NEAR</dt>
            <dd>
              {r.announce_tx ? (
                <Explorer href={ntx} label={short(r.announce_tx, 12, 6)} title={r.announce_tx} />
              ) : (
                <span className="hint">not posted</span>
              )}
            </dd>
            <dt>Address made by</dt>
            <dd>
              NEAR Chain Signatures, from <span className="mono">{r.predecessor}</span> and a
              one-time path <span className="mono">{short(r.path, 10, 6)}</span>
            </dd>
          </dl>
          {r.idx !== undefined && (
            <div className="stack" style={{ gap: 8 }}>
              <span className="hint">Everything NEAR recorded about this payment:</span>
              <div className="code" data-testid="announcement">
                <span className="dim">{"{"}</span>
                {"\n  "}
                <span className="k">"idx"</span>: {r.idx},{"\n  "}
                <span className="k">"chain"</span>: "{r.chain}",{"\n  "}
                <span className="k">"eph"</span>: "{short(r.eph, 10, 6)}",{"\n  "}
                <span className="k">"tag"</span>: {r.tag},{"\n  "}
                <span className="k">"ct"</span>: "&lt;encrypted note&gt;"{"\n  "}
                <span className="gone">{"// no recipient field, ever"}</span>
                {"\n"}
                <span className="dim">{"}"}</span>
              </div>
            </div>
          )}
        </More>
      </div>
    </Panel>
  );
}
