import { Eye, FileSpreadsheet, Ghost, Inbox, Send } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { AccountantPage } from "./pages/Accountant.tsx";
import { InboxPage } from "./pages/Inbox.tsx";
import { PublicPage } from "./pages/Public.tsx";
import { SendPage } from "./pages/Send.tsx";
import { StoreProvider, type TabId, useStore } from "./store.tsx";
import { Button, Note } from "./ui.tsx";

const TABS: { id: TabId; label: string; long?: string; icon: React.ReactNode }[] = [
  { id: "send", label: "Send", icon: <Send size={15} /> },
  { id: "inbox", label: "Inbox", icon: <Inbox size={15} /> },
  { id: "public", label: "Public view", long: "What others see", icon: <Eye size={15} /> },
  { id: "accountant", label: "Accountant", icon: <FileSpreadsheet size={15} /> },
];

function Shell() {
  const { cfg, cfgError, reload, tab, go } = useStore();
  // A recipient's own app (no local payer wallet) has nothing to send from: payers use the pay page
  // with their own wallet. The Send tab stays for the local all-in-one demo.
  const canSend = !cfg || cfg.simulated || cfg.profiles.some((p) => p.wallet);
  const tabs = TABS.filter((t) => t.id !== "send" || canSend);
  useEffect(() => {
    if (cfg && !canSend && tab === "send") go("inbox");
  }, [cfg, canSend, tab, go]);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <div className="shell">
      <header className={`top ${scrolled ? "scrolled" : ""}`}>
        <div className="top-in">
          <button type="button" className="brand" onClick={() => go(canSend ? "send" : "inbox")}>
            <Ghost size={24} strokeWidth={2.2} />
            Ghost Paths
          </button>
          <nav className="nav" role="tablist" aria-label="Sections">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => go(t.id)}
                data-testid={`tab-${t.id}`}
              >
                {tab === t.id && (
                  <motion.span
                    layoutId="nav-pill"
                    className="pill"
                    transition={{ type: "spring", bounce: 0.18, duration: 0.45 }}
                  />
                )}
                <span>
                  {t.icon}
                  {t.long ? (
                    <>
                      <span className="lbl-long">{t.long}</span>
                    </>
                  ) : (
                    t.label
                  )}
                </span>
              </button>
            ))}
          </nav>
          <div
            className={`net ${cfgError ? "off" : cfg?.simulated ? "sim" : ""}`}
            data-testid="status"
          >
            <span className="dot" />
            {cfg ? (
              cfg.simulated ? (
                "Demo mode"
              ) : (
                `NEAR ${cfg.network}`
              )
            ) : cfgError ? (
              "Offline"
            ) : (
              <span className="pulse">Connecting</span>
            )}
          </div>
        </div>
      </header>

      {cfg?.simulated && (
        <div className="demo-strip">
          <div>
            <b>Demo mode.</b> The privacy math is real; the networks are simulated, so no real money
            moves.
          </div>
        </div>
      )}

      <main>
        {cfgError && (
          <div className="page">
            <Note tone="bad" title="Can't reach the Ghost Paths server.">
              {cfgError}
            </Note>
            <div>
              <Button variant="dark" onClick={reload}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {cfg && tab === "send" && <SendPage />}
        {cfg && tab === "inbox" && <InboxPage />}
        {cfg && tab === "public" && <PublicPage />}
        {cfg && tab === "accountant" && <AccountantPage />}
      </main>

      <footer className="foot">
        <span>
          Your keys stay in your Ghost Paths app on this computer. This page only ever sees public
          data.
        </span>
        <span>
          Built on NEAR Chain Signatures.
          {cfg && !cfg.simulated && (
            <>
              {" "}
              <a href={cfg.links.contract} target="_blank" rel="noreferrer noopener">
                View the contract
              </a>
            </>
          )}
        </span>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <StoreProvider>
        <Shell />
      </StoreProvider>
      <Toaster position="bottom-center" toastOptions={{ style: { fontFamily: "var(--sans)" } }} />
    </MotionConfig>
  );
}
