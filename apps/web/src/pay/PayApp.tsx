/**
 * The payer's page. No server, no keys: the payer's own wallet (MetaMask) signs the payment, the
 * one-time address is computed here from the recipient's public meta-address on NEAR, and a relayer
 * posts the encrypted note so the payer needs no NEAR account. Static files; host anywhere.
 */
import { buildAnnouncement } from "@ghost-paths/sdk/src/announce.ts";
import { chainInfo, formatUnits, parseUnits } from "@ghost-paths/sdk/src/chains/config.ts";
import { parseHandle } from "@ghost-paths/sdk/src/keys.ts";
import { makeTarget, predecessorFor } from "@ghost-paths/sdk/src/stealth.ts";
import type { AnnounceArgs, ChainTag, Memo } from "@ghost-paths/sdk/src/types.ts";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Copy,
  Ghost,
  Inbox,
  Laptop,
  Lock,
  Megaphone,
  RotateCcw,
  Send,
  UserCheck,
  UserX,
  Wallet,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { GhostPath } from "../ghostpath.tsx";
import { short } from "../lib.ts";
import { receiveUrl, setupMessage } from "../receive/setup.ts";
import {
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
  type StepState,
  copyText,
} from "../ui.tsx";
import { type PayConfig, loadPayConfig, nearAccountUrl, nearTxUrl } from "./config.ts";
import { announce, checkContract, getMeta } from "./near.ts";
import {
  type WalletInfo,
  balanceOf,
  connect,
  discoverWallets,
  ensureChain,
  isUserReject,
  sendNative,
  waitMined,
} from "./wallet.ts";

const swap = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.22 },
};

type Step = "wallet" | "mining" | "note";
interface Paid {
  recipient: string;
  amount: string;
  symbol: string;
  chain: ChainTag;
  address: string;
  path: string;
  predecessor: string;
  payTx: string;
  args: AnnounceArgs;
  note?: { tx_hash: string; idx: number };
}

const fromQuery = (k: string) => new URLSearchParams(window.location.search).get(k) ?? "";

export default function PayApp() {
  const [cfg, setCfg] = useState<PayConfig | null>(null);
  useEffect(() => {
    loadPayConfig().then(setCfg);
  }, []);
  return (
    <MotionConfig reducedMotion="user">
      {cfg && <Pay cfg={cfg} />}
      <Toaster position="bottom-center" toastOptions={{ style: { fontFamily: "var(--sans)" } }} />
    </MotionConfig>
  );
}

function Pay({ cfg }: { cfg: PayConfig }) {
  const chain = cfg.chains[0] as ChainTag;
  const info = chainInfo(chain);

  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const wallet = wallets?.[0];

  const [to, setTo] = useState(fromQuery("to") || cfg.defaultRecipient || "");
  const [amount, setAmount] = useState(fromQuery("amount") || "0.001");
  const [memo, setMemo] = useState("");
  const [meta, setMeta] = useState<"checking" | "ready" | "missing" | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);

  useEffect(() => {
    discoverWallets().then(async (ws) => {
      setWallets(ws);
      // Already approved for this site? Restore it without a prompt.
      const a = (await ws[0]?.provider.request({ method: "eth_accounts" }).catch(() => [])) as
        | string[]
        | undefined;
      if (a?.[0]) setAccount(a[0]);
    });
  }, []);

  const refreshBalance = useCallback(async () => {
    if (wallet && account) setBalance(await balanceOf(info.rpc, account).catch(() => null));
  }, [wallet, account, info.rpc]);
  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);
  useEffect(() => {
    const p = wallet?.provider;
    if (!p?.on) return;
    const onAccounts = (a: unknown) => setAccount((a as string[])[0] ?? null);
    const onChain = () => refreshBalance();
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet, refreshBalance]);

  // Is the recipient set up? (debounced registry lookup on NEAR)
  const seq = useRef(0);
  const recipient = (() => {
    try {
      return to.trim() ? parseHandle(to.trim()) : "";
    } catch {
      return to.trim();
    }
  })();
  useEffect(() => {
    if (!recipient) return setMeta(null);
    const n = ++seq.current;
    setMeta("checking");
    const t = setTimeout(() => {
      getMeta(cfg, recipient)
        .then((m) => n === seq.current && setMeta(m ? "ready" : "missing"))
        .catch(() => n === seq.current && setMeta("missing"));
    }, 300);
    return () => clearTimeout(t);
  }, [cfg, recipient]);

  const doConnect = async () => {
    if (!wallet) return;
    setErr(null);
    try {
      setAccount(await connect(wallet));
    } catch (e) {
      if (!isUserReject(e)) setErr((e as Error).message);
    }
  };

  const postNote = async (p: Paid) => {
    setStep("note");
    const note = await announce(cfg, p.args);
    const done = { ...p, note };
    setPaid(done);
    setStep(null);
    refreshBalance();
  };

  const send = async () => {
    if (!wallet) return;
    setErr(null);
    setPaid(null);
    let pending: Paid | null = null;
    try {
      setStep("wallet");
      const from = account ?? (await connect(wallet));
      setAccount(from);
      await ensureChain(wallet, info.chainId as number, {
        name: info.name,
        rpc: info.rpc[0] as string,
        symbol: info.symbol,
        explorer: info.addressUrl?.("x").replace(/address\/x$/, ""),
      });
      await checkContract(cfg);
      const m = await getMeta(cfg, recipient);
      if (!m) throw new Error(`${recipient} hasn't set up Ghost Paths yet`);
      const wei = parseUnits(amount.trim(), info.decimals);
      const predecessor = predecessorFor(m.mode, cfg.contract, recipient);
      const { target, S } = makeTarget(m, chain, predecessor, { network: cfg.network });

      const payTx = await sendNative(wallet, from, target.address, wei);
      setStep("mining");
      await waitMined(wallet, payTx);

      const memoObj: Memo = {
        amount: formatUnits(wei, info.decimals),
        asset: info.symbol,
        txid: payTx,
        ...(memo.trim() ? { note: memo.trim() } : {}),
      };
      pending = {
        recipient,
        amount: memoObj.amount as string,
        symbol: info.symbol,
        chain,
        address: target.address,
        path: target.path,
        predecessor,
        payTx,
        args: buildAnnouncement(target, S, memoObj),
      };
      setPaid(pending);
      await postNote(pending);
    } catch (e) {
      setStep(null);
      if (isUserReject(e)) return setErr("You cancelled in your wallet. Nothing was sent.");
      setErr((e as Error).message);
    }
  };

  const stage = step ? "busy" : paid?.note ? "done" : paid ? "stuck" : "form";
  const sym = info.symbol;
  const insufficient =
    balance !== null &&
    (() => {
      try {
        return parseUnits(amount.trim() || "0", info.decimals) > balance;
      } catch {
        return false;
      }
    })();

  return (
    <div className="shell">
      <header className="top">
        <div className="top-in pay-top">
          <a className="brand" href="./pay.html">
            <Ghost size={24} strokeWidth={2.2} />
            Ghost Paths
          </a>
          <div className="net">
            <span className="dot" />
            NEAR {cfg.network} · {info.name}
          </div>
          <div className="wallet-slot">
            {account ? (
              <span className="wallet-chip" data-testid="wallet" title={account}>
                {wallet?.icon && <img src={wallet.icon} alt="" width={18} height={18} />}
                {short(account, 6, 4)}
                {balance !== null && (
                  <span className="dim">
                    {Number(formatUnits(balance, info.decimals)).toFixed(4)} {sym}
                  </span>
                )}
              </span>
            ) : (
              <Button
                small
                variant="dark"
                icon={<Wallet size={15} />}
                onClick={doConnect}
                disabled={!wallet}
                data-testid="connect"
              >
                {wallet ? `Connect ${wallet.name}` : wallets ? "No wallet found" : "Connect wallet"}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main>
        <div className="page">
          <PageHead title="Pay someone privately">
            Pay anyone by their NEAR account name. The money lands at a brand-new {info.name}{" "}
            address that nobody else can link to them.
          </PageHead>

          {cfg.network === "testnet" && (
            <p className="hint" data-testid="testnet-note">
              Test network: no real money. You need MetaMask with a little Sepolia ETH, free from a{" "}
              <a
                href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
                target="_blank"
                rel="noreferrer noopener"
              >
                Sepolia faucet
              </a>
              .
              {cfg.defaultRecipient
                ? ` ${cfg.defaultRecipient} is a demo recipient you can pay.`
                : ""}
            </p>
          )}

          {wallets && !wallet && (
            <Note tone="bad" title="No Ethereum wallet in this browser.">
              Install MetaMask (or any EIP-1193 wallet), then reload this page.
            </Note>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {stage === "form" && (
              <motion.div key="form" {...swap}>
                <Panel>
                  <div className="stack" style={{ gap: 22 }}>
                    <GhostPath from="You" to={recipient} />
                    <Field
                      label="Who are you paying?"
                      htmlFor="to"
                      hint={
                        meta === "missing" ? (
                          <span style={{ color: "var(--rose)" }}>
                            {recipient} hasn't set up Ghost Paths yet, so they can't receive private
                            payments.
                          </span>
                        ) : (
                          `Their NEAR account name. They don't need to give you an ${info.name} address.`
                        )
                      }
                    >
                      <div className="who-input">
                        <input
                          id="to"
                          className="input"
                          value={to}
                          onChange={(e) => setTo(e.target.value)}
                          placeholder="name.testnet"
                          spellCheck={false}
                          autoComplete="off"
                          data-testid="recipient"
                          style={{ paddingRight: 130 }}
                        />
                        <span className="status" data-testid="registered">
                          {meta === "checking" && <Badge className="badge pulse">Checking</Badge>}
                          {meta === "ready" && (
                            <Badge tone="good">
                              <UserCheck size={14} /> Ready
                            </Badge>
                          )}
                          {meta === "missing" && (
                            <Badge tone="bad">
                              <UserX size={14} /> Not set up
                            </Badge>
                          )}
                        </span>
                      </div>
                    </Field>

                    <AnimatePresence initial={false}>
                      {meta === "missing" && recipient && (
                        <motion.div key="setup" {...swap}>
                          <SetupNudge recipient={recipient} />
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <Field label="Amount" htmlFor="amount" hint={`On ${info.name}`}>
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
                      hint={`Encrypted. Only ${recipient || "the recipient"} can read it.`}
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

                    <Button
                      variant="primary"
                      big
                      block
                      disabled={
                        !wallet || !recipient || !amount.trim() || meta !== "ready" || insufficient
                      }
                      onClick={send}
                      icon={<Lock size={17} />}
                      data-testid="send"
                    >
                      {insufficient
                        ? `Not enough ${sym} in your wallet`
                        : `Send ${amount.trim() || "0"} ${sym} privately`}
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
                <Panel title={`Sending ${amount} ${sym} to ${recipient}`}>
                  <div className="stack" style={{ gap: 20 }}>
                    <GhostPath from="You" to={recipient} address={paid?.address} />
                    <Progress
                      data-testid="send-progress"
                      steps={[
                        {
                          title: "Confirm in your wallet",
                          state: stepState(step, "wallet"),
                          body: `${wallet?.name ?? "Your wallet"} shows a payment to a new address made just for ${recipient}.`,
                        },
                        {
                          title: `Sending ${amount} ${sym}`,
                          state: stepState(step, "mining"),
                          body: `Waiting for ${info.name} to confirm it.`,
                        },
                        {
                          title: `Leaving an encrypted note for ${recipient} on NEAR`,
                          state: stepState(step, "note"),
                          body: "Only they can tell it's for them. You don't need a NEAR account.",
                        },
                      ]}
                    />
                  </div>
                </Panel>
              </motion.div>
            )}

            {stage === "stuck" && paid && (
              <motion.div key="stuck" {...swap}>
                <Panel title="Your payment went through. The note didn't, yet.">
                  <div className="stack" style={{ gap: 16 }}>
                    <Note tone="bad" title="Couldn't post the note on NEAR.">
                      {err ?? "The relayer did not answer."} {recipient} needs the note to find the
                      payment. The money is safe at {short(paid.address, 8, 6)}; try again.
                    </Note>
                    <Button
                      variant="primary"
                      onClick={() =>
                        postNote(paid).catch((e) => {
                          setStep(null);
                          setErr((e as Error).message);
                        })
                      }
                    >
                      Post the note again
                    </Button>
                  </div>
                </Panel>
              </motion.div>
            )}

            {stage === "done" && paid?.note && (
              <motion.div key="done" {...swap}>
                <Receipt
                  cfg={cfg}
                  p={paid}
                  onAgain={() => {
                    setPaid(null);
                    setMemo("");
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <HowItWorks cfg={cfg} chainName={info.name} />
        </div>
      </main>

      <footer className="foot">
        <span>
          This page holds no keys. Your wallet signs the payment; the one-time address is computed
          in your browser.
        </span>
        <span>
          Built on NEAR Chain Signatures.{" "}
          <a href={nearAccountUrl(cfg, cfg.contract)} target="_blank" rel="noreferrer noopener">
            View the contract
          </a>
        </span>
      </footer>
    </div>
  );
}

/** The whole path in four lines, and where a recipient finds their money (not on this page). */
function HowItWorks({ cfg, chainName }: { cfg: PayConfig; chainName: string }) {
  const guide = new URL("receive.html", window.location.href).href;
  return (
    <Panel title="How it works" className="how-it-works" data-testid="how-it-works">
      <div className="stack" style={{ gap: 18 }}>
        <ol className="limits how">
          <li className="ok">
            <Send size={17} />
            <span>
              <b>You pay a name, not an address.</b> This page reads the recipient's public keys
              from NEAR and works out a brand-new {chainName} address for this payment only. Your
              wallet sends the money there, as a plain transfer.
            </span>
          </li>
          <li className="ok">
            <Megaphone size={17} />
            <span>
              <b>An encrypted note goes on NEAR.</b> A relayer posts it from its own account, so
              neither of you appears there. Only the recipient can read it.
            </span>
          </li>
          <li className="ok">
            <Inbox size={17} />
            <span>
              <b>The recipient finds it in their own app.</b> On their own computer, their keys pick
              out their payments among everyone's notes, and their Inbox lists them.
            </span>
          </li>
          <li className="ok">
            <ArrowDownToLine size={17} />
            <span>
              <b>They withdraw to any wallet.</b> NEAR Chain Signatures signs the transfer out of
              the one-time address; the recipient never holds a private key for that address.
            </span>
          </li>
        </ol>
        <div className="stack" style={{ gap: 4 }}>
          <More label="I'm the recipient: where do I see my money?" data-testid="how-recipient">
            <p>
              Not on this site, on purpose. Each payment sits at its own new address, and only your
              keys can tell which ones are yours. Those keys never leave your computer, so your
              payments show in your own Ghost Paths app (<code>ghost serve</code>): <b>Inbox</b>{" "}
              lists them and <b>Withdraw</b> sends them to your wallet. Not set up yet?{" "}
              <a href={guide}>Set up to receive</a>.
            </p>
          </More>
          <More label="What can others see?" data-testid="how-public">
            <p>
              That some address on {chainName} received money, and that a note was posted on NEAR.
              Not who it is for: the note has no recipient field, the address has no history, and
              the recipient's NEAR account shows one transaction ever, its setup, however many
              payments it gets.{" "}
              <a href={nearAccountUrl(cfg, cfg.contract)} target="_blank" rel="noreferrer noopener">
                See the public record
              </a>
              .
            </p>
          </More>
        </div>
      </div>
    </Panel>
  );
}

/** Not set up yet: what the payer can send them, and the guide they follow on their own computer. */
function SetupNudge({ recipient }: { recipient: string }) {
  const here = window.location.href;
  return (
    <div className="setup-nudge" data-testid="setup-nudge">
      <p>
        <Laptop size={18} />
        <span>
          {recipient} can set up once, in about 5 minutes, on their own computer. Their keys stay
          there; this page never sees them.
        </span>
      </p>
      <div className="row">
        <Button
          small
          icon={<Copy size={14} />}
          onClick={() => copyText(setupMessage(here, recipient), "Message copied")}
          data-testid="copy-setup-message"
        >
          Copy message
        </Button>
        <a className="btn small quiet" href={receiveUrl(here, recipient)} data-testid="setup-guide">
          How to set up <ArrowRight size={15} />
        </a>
      </div>
    </div>
  );
}

const ORDER: Step[] = ["wallet", "mining", "note"];
function stepState(cur: Step | null, s: Step): StepState {
  if (!cur) return "todo";
  const a = ORDER.indexOf(cur);
  const b = ORDER.indexOf(s);
  return b < a ? "done" : b === a ? "active" : "todo";
}

function Receipt({ cfg, p, onAgain }: { cfg: PayConfig; p: Paid; onAgain: () => void }) {
  const info = chainInfo(p.chain);
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
            {p.amount}
            <small>{p.symbol}</small>
          </div>
          <div className="sub">
            to <b style={{ color: "var(--ink)" }}>{p.recipient}</b> on {info.name}
          </div>
        </div>

        <GhostPath from="You" to={p.recipient} address={p.address} lit />

        <div className="addr-box">
          <span className="l">{p.recipient}'s new address, used only for this payment</span>
          <span data-testid="onetime-address">
            <CopyText value={p.address} full />
          </span>
          <Explorer href={info.addressUrl?.(p.address)} label="View on explorer" />
        </div>

        <Note tone="good">
          Anyone can see that {p.amount} {p.symbol} moved. Nobody but {p.recipient} can tell it was
          for them.
        </Note>

        <Button onClick={onAgain} icon={<RotateCcw size={16} />} data-testid="send-again">
          Send another
        </Button>

        <More label="Technical details" data-testid="pay-details">
          <dl className="facts">
            <dt>Payment</dt>
            <dd>
              <Explorer
                href={info.txUrl?.(p.payTx)}
                label={short(p.payTx, 12, 8)}
                title={p.payTx}
              />
            </dd>
            <dt>Note on NEAR</dt>
            <dd>
              {p.note && (
                <Explorer
                  href={nearTxUrl(cfg, p.note.tx_hash)}
                  label={short(p.note.tx_hash, 12, 6)}
                  title={p.note.tx_hash}
                />
              )}
            </dd>
            <dt>Address made by</dt>
            <dd>
              NEAR Chain Signatures, from <span className="mono">{p.predecessor}</span> and a
              one-time path <span className="mono">{short(p.path, 10, 6)}</span>
            </dd>
          </dl>
          <div className="stack" style={{ gap: 8 }}>
            <span className="hint">Everything NEAR recorded about this payment:</span>
            <div className="code" data-testid="announcement">
              <span className="dim">{"{"}</span>
              {"\n  "}
              <span className="k">"idx"</span>: {p.note?.idx},{"\n  "}
              <span className="k">"chain"</span>: "{p.chain}",{"\n  "}
              <span className="k">"eph"</span>: "{short(p.args.eph, 10, 6)}",{"\n  "}
              <span className="k">"tag"</span>: {p.args.tag},{"\n  "}
              <span className="k">"ct"</span>: "&lt;encrypted note&gt;"{"\n  "}
              <span className="gone">{"// no recipient field, ever"}</span>
              {"\n"}
              <span className="dim">{"}"}</span>
            </div>
          </div>
        </More>
      </div>
    </Panel>
  );
}
