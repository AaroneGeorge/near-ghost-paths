/** App-wide state. The accountant's viewing key lives in memory only (never localStorage): it reveals every incoming payment. */
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
import type { Config, PayResult, ViewingBundle } from "./types.ts";

export type TabId = "send" | "inbox" | "public" | "accountant";

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
  /** Whose inbox is open (a recipient profile). Shared between Send → Inbox. */
  who: string;
  setWho: (w: string) => void;
}

const Ctx = createContext<Store | null>(null);
export const useStore = (): Store => {
  const s = useContext(Ctx);
  if (!s) throw new Error("no store");
  return s;
};

const TABS: TabId[] = ["send", "inbox", "public", "accountant"];
// Old links (#scan, #sweep, #auditor) keep working.
const ALIAS: Record<string, TabId> = { scan: "inbox", sweep: "inbox", auditor: "accountant" };
const fromHash = (): TabId => {
  const h = window.location.hash.replace("#", "");
  return ALIAS[h] ?? (TABS.includes(h as TabId) ? (h as TabId) : "send");
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(fromHash);
  const [bundle, setBundle] = useState<ViewingBundle | null>(null);
  const [lastPay, setLastPay] = useState<PayResult | null>(null);
  const [who, setWho] = useState("");

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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    }),
    [cfg, cfgError, reload, tab, go, bundle, lastPay, who],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
