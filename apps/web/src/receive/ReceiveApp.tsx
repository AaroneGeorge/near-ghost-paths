/**
 * "Receive private payments": the recipient's setup guide. Static like the pay page, and like it
 * holds no keys: it reads the public registry on NEAR and shows the commands that make the keys on
 * the recipient's own computer (`ghost init`), publish the public half (`ghost register`) and open
 * their own app (`ghost serve`).
 */
import { parseHandle } from "@ghost-paths/sdk/src/keys.ts";
import {
  BookOpen,
  Check,
  Copy,
  Ghost,
  KeyRound,
  Laptop,
  Megaphone,
  RefreshCw,
  UserCheck,
  UserX,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { type PayConfig, loadPayConfig, nearAccountUrl } from "../pay/config.ts";
import { getMeta } from "../pay/near.ts";
import { Badge, Button, CopyText, Field, More, Note, PageHead, Panel, copyText } from "../ui.tsx";
import {
  CLONE,
  INSTALL_BUN,
  PROFILE,
  isAccountId,
  payUrl,
  placeholderAccount,
  setupCommands,
} from "./setup.ts";

const fade = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2 },
};

export default function ReceiveApp() {
  const [cfg, setCfg] = useState<PayConfig | null>(null);
  useEffect(() => {
    loadPayConfig().then(setCfg);
  }, []);
  return (
    <MotionConfig reducedMotion="user">
      {cfg && <Receive cfg={cfg} />}
      <Toaster position="bottom-center" toastOptions={{ style: { fontFamily: "var(--sans)" } }} />
    </MotionConfig>
  );
}

type Status = "checking" | "ready" | "missing" | "invalid" | null;

function Receive({ cfg }: { cfg: PayConfig }) {
  const [input, setInput] = useState(
    () => new URLSearchParams(window.location.search).get("account") ?? "",
  );
  const [status, setStatus] = useState<Status>(null);
  const [tick, setTick] = useState(0);
  const [path, setPath] = useState<"import" | "create">("import");
  const testnet = cfg.network === "testnet";

  const account = (() => {
    const t = input.trim().toLowerCase();
    try {
      return t ? parseHandle(t) : "";
    } catch {
      return t;
    }
  })();
  const valid = isAccountId(account);
  const name = valid ? account : placeholderAccount(cfg.network);
  const cmds = setupCommands(cfg, name);

  // Live registry lookup (debounced), again whenever the person comes back to this tab.
  const seq = useRef(0);
  useEffect(() => {
    const again = () => document.visibilityState === "visible" && setTick((n) => n + 1);
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);
  useEffect(() => {
    void tick;
    if (!account) return setStatus(null);
    if (!valid) return setStatus("invalid");
    const n = ++seq.current;
    setStatus((s) => (s === "ready" || s === "missing" ? s : "checking"));
    const t = setTimeout(() => {
      getMeta(cfg, account)
        .then((m) => n === seq.current && setStatus(m ? "ready" : "missing"))
        .catch(() => n === seq.current && setStatus("missing"));
    }, 300);
    return () => clearTimeout(t);
  }, [cfg, account, valid, tick]);
  useEffect(() => {
    // Keep the address bar shareable: receive.html?account=<name>.
    const u = new URL(window.location.href);
    if (valid) u.searchParams.set("account", account);
    else u.searchParams.delete("account");
    window.history.replaceState(null, "", u);
  }, [account, valid]);

  const share = valid ? payUrl(window.location.href, account) : "";

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
            NEAR {cfg.network}
          </div>
          <div className="wallet-slot top-links">
            <a className="btn small quiet" href="./how.html" data-testid="to-how">
              <BookOpen size={15} />
              <span className="long">How it works</span>
              <span className="short">How</span>
            </a>
            <a className="btn small" href="./pay.html" data-testid="to-pay">
              Pay someone
            </a>
          </div>
        </div>
      </header>

      <main>
        <div className="page">
          <PageHead title="Receive private payments">
            People pay you by your NEAR account name, and nobody else can tell the money is yours.
            You set up once, in about 5 minutes, on your own computer.
          </PageHead>

          <Panel>
            <div className="stack" style={{ gap: 14 }}>
              <Field
                label="Your NEAR account"
                htmlFor="account"
                hint={
                  status === "invalid" ? (
                    <span style={{ color: "var(--rose)" }}>
                      That isn't a NEAR account name. It looks like{" "}
                      {placeholderAccount(cfg.network)}.
                    </span>
                  ) : status === "missing" ? (
                    <span data-testid="setup-missing">
                      {account} isn't set up yet. Follow the steps below; this page checks again
                      when you come back to it.
                    </span>
                  ) : (
                    "We read the public Ghost Paths registry on NEAR. Nothing is sent anywhere."
                  )
                }
              >
                <div className="who-input">
                  <input
                    id="account"
                    className="input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={placeholderAccount(cfg.network)}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="none"
                    data-testid="account"
                    style={{ paddingRight: 130 }}
                  />
                  <span className="status" data-testid="setup-status">
                    {status === "checking" && <Badge className="badge pulse">Checking</Badge>}
                    {status === "ready" && (
                      <Badge tone="good">
                        <UserCheck size={14} /> Ready
                      </Badge>
                    )}
                    {status === "missing" && (
                      <Badge tone="bad">
                        <UserX size={14} /> Not set up
                      </Badge>
                    )}
                  </span>
                </div>
              </Field>

              <AnimatePresence initial={false}>
                {status === "ready" && (
                  <motion.div key="ready" {...fade} data-testid="setup-ready">
                    <Note tone="good" title="You're set up.">
                      Share this link; anyone can pay you privately from it:
                      <div className="share-link">
                        <CopyText value={share} full data-testid="share-link" />
                      </div>
                      To see and withdraw payments, open your own app (step 6).
                    </Note>
                  </motion.div>
                )}
                {status === "missing" && (
                  <motion.div key="missing" {...fade}>
                    <Button
                      small
                      variant="quiet"
                      icon={<RefreshCw size={14} />}
                      onClick={() => setTick((n) => n + 1)}
                      data-testid="check-again"
                    >
                      Check again
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Panel>

          <Panel title="What happens">
            <ul className="limits how" data-testid="how">
              <li className="ok">
                <KeyRound size={17} />
                <span>Your keys are made on your computer and never leave it.</span>
              </li>
              <li className="ok">
                <Megaphone size={17} />
                <span>
                  You publish only their public half on NEAR, once, so people can pay you by name.
                </span>
              </li>
              <li className="ok">
                <Laptop size={17} />
                <span>You open your own app to see your payments and withdraw them.</span>
              </li>
            </ul>
          </Panel>

          <Panel
            title="Set up, step by step"
            sub={`In a terminal on your own computer (macOS or Linux; on Windows, WSL). Each command is filled in for ${name} on NEAR ${cfg.network}.`}
          >
            <ol className="steps" data-testid="steps">
              <StepItem n={1} title="Install git and bun">
                <p>
                  Check for git with <code>git --version</code>. Install bun, then open a new
                  terminal so it is found:
                </p>
                <Cmd id="bun" text={INSTALL_BUN} />
              </StepItem>

              <StepItem n={2} title="Get the Ghost Paths app">
                <Cmd id="clone" text={CLONE} />
                <p className="see">Run every next command in this near-ghost-paths folder.</p>
              </StepItem>

              <StepItem n={3} title="Connect your NEAR account">
                <div
                  className="route"
                  role="radiogroup"
                  aria-label="Your NEAR account"
                  data-testid="account-path"
                >
                  <PathOpt
                    value="import"
                    cur={path}
                    set={setPath}
                    title="Use my existing NEAR account"
                    desc={`${name} already exists in a wallet.`}
                  />
                  {testnet && (
                    <PathOpt
                      value="create"
                      cur={path}
                      set={setPath}
                      title="I don't have one: make a new testnet account"
                      desc="Free, with 10 test NEAR from the testnet faucet."
                    />
                  )}
                </div>
                {path === "import" || !testnet ? (
                  <>
                    <p>
                      In your NEAR wallet, export the account's private key (it starts with{" "}
                      <code>ed25519:</code>). The first line asks for it without showing it; it is
                      saved only in your own <code>~/.ghost</code> folder.
                    </p>
                    <Cmd id="import" text={cmds.importAccount} />
                    <p className="see">
                      <b>See:</b> <code>profile {PROFILE}</code>, <code>NEAR account {name}</code>,{" "}
                      <code>network {cfg.network}</code>. Keep a little NEAR on it (0.02 is plenty)
                      for step 5.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Pick a free name ending in <code>.testnet</code>.
                    </p>
                    <Cmd id="create" text={cmds.createAccount} />
                    <p className="see">
                      <b>See:</b>{" "}
                      <code>creating NEAR testnet account {name} (faucet helper, 10 NEAR)…</code>,
                      then <code>NEAR account {name}</code>. The faucet allows a few new accounts
                      per internet address: if it answers <code>429</code>, wait a while or use an
                      existing account.
                    </p>
                  </>
                )}
              </StepItem>

              <StepItem n={4} title="Make your keys">
                <Cmd id="init" text={cmds.init} />
                <p className="see">
                  <b>See:</b> <code>keystore created for {PROFILE}</code>, your handle{" "}
                  <code>ghost:{name}</code> and{" "}
                  <code>keystore …/.ghost/{PROFILE}.json (0600, holds the seed)</code>. That file is
                  your keys: back it up.
                </p>
              </StepItem>

              <StepItem n={5} title="Publish the public half, once">
                <Cmd id="register" text={cmds.register} />
                <p className="see">
                  <b>See:</b> <code>registered {name}</code> and a <code>NEAR tx</code> link. It is
                  one transaction from your own account. This page then shows <b>Ready</b>.
                </p>
              </StepItem>

              <StepItem n={6} title="Open your app">
                <p>Build it once (a few seconds):</p>
                <Cmd id="build" text={cmds.build} />
                <p className="see">
                  <b>See:</b> <code>check-bundle: … no secrets found</code>.
                </p>
                <p>Then start it, now and whenever you want to check for payments:</p>
                <Cmd id="serve" text={cmds.serve} />
                <p className="see">
                  <b>See:</b> <code>ghost serve (live) on http://127.0.0.1:8788</code> and a line{" "}
                  <code>open http://127.0.0.1:8788/?token=…</code>. Open that full address in your
                  browser: <b>Inbox</b> lists your payments and <b>Withdraw</b> sends one to your
                  own wallet. It runs only on your computer; Ctrl-C stops it.
                </p>
              </StepItem>
            </ol>
          </Panel>

          <Panel title="Questions" className="faq">
            <div className="stack" style={{ gap: 4 }}>
              <More label="What does it cost?" data-testid="faq-cost">
                <p>
                  {testnet
                    ? "Nothing real: this is NEAR testnet, and test NEAR is free. "
                    : "A few thousandths of a NEAR. "}
                  Publishing your keys is one NEAR transaction from your account: it attaches 0.01
                  NEAR for storage and most of it comes back; in total it costs about 0.0016 NEAR.
                  Receiving costs you nothing, and payers don't need a NEAR account.
                </p>
              </More>
              <More label="What if I lose my keys?" data-testid="faq-lose">
                <p>
                  They are in <code>~/.ghost/{PROFILE}.json</code> on your computer, readable only
                  by you (0600), next to your NEAR key in <code>{PROFILE}.near.json</code>. Back up
                  the <code>~/.ghost</code> folder somewhere safe and private. Without it nobody, us
                  included, can find or withdraw your payments; with it, anyone can.
                </p>
              </More>
              <More label="Why can't this site set it up for me?" data-testid="faq-why">
                <p>
                  Because then the site would hold your keys. Your keys never leave your computer:
                  this page and the pay page only read public data from NEAR, and only the app on
                  your own machine can find and withdraw your payments.
                </p>
              </More>
            </div>
          </Panel>
        </div>
      </main>

      <footer className="foot">
        <span>This page holds no keys. It reads the public registry on NEAR and nothing else.</span>
        <span>
          <a href={nearAccountUrl(cfg, cfg.contract)} target="_blank" rel="noreferrer noopener">
            View the contract
          </a>
          {" · "}
          <a
            href="https://github.com/AaroneGeorge/near-ghost-paths"
            target="_blank"
            rel="noreferrer noopener"
          >
            Source code
          </a>
        </span>
      </footer>
    </div>
  );
}

function StepItem({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="n">{n}</span>
      <div className="body">
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  );
}

/** A command in a code block with its own copy button. */
function Cmd({ id, text }: { id: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="cmd">
      <div className="cmd-bar">
        <span>Terminal</span>
        <button
          type="button"
          className="cmd-copy"
          aria-label="Copy command"
          data-testid={`copy-${id}`}
          onClick={async () => {
            await copyText(text, "Command copied");
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          }}
        >
          {done ? <Check size={14} /> : <Copy size={14} />}
          {done ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code" data-testid={`cmd-${id}`}>
        {text}
      </pre>
    </div>
  );
}

function PathOpt<T extends string>({
  value,
  cur,
  set,
  title,
  desc,
}: { value: T; cur: T; set: (v: T) => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: custom radio buttons, as in the Withdraw form
      role="radio"
      aria-checked={cur === value}
      className="route-opt"
      onClick={() => set(value)}
      data-testid={`path-${value}`}
    >
      <span className="radio" />
      <span>
        <span className="t">{title}</span>
        <span className="d">{desc}</span>
      </span>
    </button>
  );
}
