/** App-wide state. The auditor's viewing bundle lives in memory only (never localStorage): it reveals every incoming payment. */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "./api.ts";
import type { Config, PayResult, PaymentRow, ViewingBundle } from "./types.ts";

export type TabId = "send" | "scan" | "sweep" | "auditor";
export type ScanView = "recipient" | "auditor" | "stranger";

interface Store {
  cfg: Config | null;
  cfgError: string | null;
  reload: () => void;
  tab: TabId;
  go: (t: TabId) => void;
  bundle: ViewingBundle | null;
  setBundle: (b: ViewingBundle | null) => void;
  lastPay: PayResult | null;
  setLastPay: (p: PayResult | null) => void;
  /** Recipient profile to scan/sweep as (shared between Send → Scan → Sweep). */
  who: string;
  setWho: (w: string) => void;
  /** Payment handed from Scan to Sweep. */
  sweepPick: PaymentRow | null;
  setSweepPick: (p: PaymentRow | null) => void;
  scanView: ScanView;
  setScanView: (v: ScanView) => void;
}

const Ctx = createContext<Store | null>(null);
export const useStore = (): Store => {
  const s = useContext(Ctx);
  if (!s) throw new Error("no store");
  return s;
};

const TABS: TabId[] = ["send", "scan", "sweep", "auditor"];
const fromHash = (): TabId => {
  const h = window.location.hash.replace("#", "") as TabId;
  return TABS.includes(h) ? h : "send";
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(fromHash);
  const [bundle, setBundle] = useState<ViewingBundle | null>(null);
  const [lastPay, setLastPay] = useState<PayResult | null>(null);
  const [who, setWho] = useState("");
  const [sweepPick, setSweepPick] = useState<PaymentRow | null>(null);
  const [scanView, setScanView] = useState<ScanView>("recipient");

  const reload = useCallback(() => {
    api
      .config()
      .then((c) => {
        setCfg(c);
        setCfgError(null);
        setWho((w) => w || c.defaults.recipient || "");
      })
      .catch((e: Error) => setCfgError(e.message));
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => {
    const on = () => setTab(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const go = useCallback((t: TabId) => {
    window.location.hash = t;
    setTab(t);
  }, []);

  const value = useMemo<Store>(
    () => ({
      cfg,
      cfgError,
      reload,
      tab,
      go,
      bundle,
      setBundle,
      lastPay,
      setLastPay,
      who,
      setWho,
      sweepPick,
      setSweepPick,
      scanView,
      setScanView,
    }),
    [cfg, cfgError, reload, tab, go, bundle, lastPay, who, sweepPick, scanView],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
