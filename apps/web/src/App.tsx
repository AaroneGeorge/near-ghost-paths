import {
  ArrowRightLeft,
  ExternalLink,
  Ghost,
  ScanSearch,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { StoreProvider, type TabId, useStore } from "./store.tsx";
import { AuditorTab } from "./tabs/Auditor.tsx";
import { ScanTab } from "./tabs/Scan.tsx";
import { SendTab } from "./tabs/Send.tsx";
import { SweepTab } from "./tabs/Sweep.tsx";
import { Button, Callout, Chip, ToastProvider } from "./ui.tsx";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "send", label: "Send", icon: <Send size={16} /> },
  { id: "scan", label: "Scan", icon: <ScanSearch size={16} /> },
  { id: "sweep", label: "Sweep", icon: <ArrowRightLeft size={16} /> },
  { id: "auditor", label: "Auditor", icon: <ShieldCheck size={16} /> },
];

function Shell() {
  const { cfg, cfgError, reload, tab, go } = useStore();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Ghost size={22} />
          </div>
          <div>
            <h1>Ghost Paths</h1>
            <p>Stealth addresses on Bitcoin, Ethereum and Solana, from one NEAR account</p>
          </div>
        </div>
        <div className="status" data-testid="status">
          {cfg ? (
            <>
              <Chip tone={cfg.simulated ? "warn" : "good"} icon={<span className="dot" />}>
                {cfg.simulated ? "simulated" : "live"}
              </Chip>
              <Chip>NEAR {cfg.network}</Chip>
              <a
                className="chip"
                href={cfg.simulated ? undefined : cfg.links.contract}
                target="_blank"
                rel="noreferrer noopener"
                title="Ghost Paths contract"
              >
                {cfg.contract}
                {!cfg.simulated && <ExternalLink size={12} />}
              </a>
            </>
          ) : cfgError ? (
            <Chip tone="bad" icon={<span className="dot" />}>
              API offline
            </Chip>
          ) : (
            <Chip>
              <span className="pulse">connecting…</span>
            </Chip>
          )}
        </div>
      </header>

      {cfg?.simulated && (
        <div className="banner">
          <TriangleAlert size={17} style={{ flex: "none", marginTop: 2 }} />
          <span>
            <b>Dev mode, no network.</b> The cryptography is real (stealth keys, one-time addresses,
            scanning, sweep authorisations). Chains, NEAR transactions and the MPC signature are
            simulated. Run <code>make demo</code> and <code>ghost serve</code> for the real thing.
          </span>
        </div>
      )}

      <nav className="nav" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => go(t.id)}
            data-testid={`tab-${t.id}`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {cfgError && (
          <div className="stack">
            <Callout tone="bad" title="Cannot reach ghost serve.">
              {cfgError}
            </Callout>
            <div>
              <Button onClick={reload}>Retry</Button>
            </div>
          </div>
        )}
        {cfg && tab === "send" && <SendTab />}
        {cfg && tab === "scan" && <ScanTab />}
        {cfg && tab === "sweep" && <SweepTab />}
        {cfg && tab === "auditor" && <AuditorTab />}
      </main>

      <footer className="foot">
        <span>Keys never leave the server: this page only receives public data.</span>
        <span>Ghost Paths · NEAR Chain Signatures · MIT</span>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ToastProvider>
  );
}
