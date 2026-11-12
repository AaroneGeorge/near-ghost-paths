import { Download, FileKey2, Lock, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import {
  availableTotals,
  chainAddrLink,
  downloadText,
  networkLabel,
  paymentsCsv,
  plural,
  statusOf,
} from "../lib.ts";
import { BundleLoader, Coin, StatusBadge } from "../parts.tsx";
import { useStore } from "../store.tsx";
import type { ScanResult } from "../types.ts";
import { Badge, Button, CopyText, Empty, Explorer, Note, PageHead, Panel, Stat } from "../ui.tsx";

export function AccountantPage() {
  const { cfg, bundle, setBundle } = useStore();
  const [res, setRes] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const run = useCallback(async () => {
    if (!bundle) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.scanBundle(bundle));
    } catch (e) {
      setErr((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }, [bundle]);
  useEffect(() => {
    if (bundle) void run();
    else setRes(null);
  }, [bundle, run]);

  const rows = useMemo(() => {
    const all = res?.payments ?? [];
    const t = q.trim().toLowerCase();
    if (!t) return all;
    return all.filter((p) =>
      [p.chain, p.address, p.memo?.note, p.memo?.txid, p.symbol, statusOf(p)].some((x) =>
        x?.toLowerCase().includes(t),
      ),
    );
  }, [res, q]);

  if (!cfg) return null;
  const totals = res ? availableTotals(res.payments) : [];
  const withdrawn = res?.payments.filter((p) => statusOf(p) === "swept").length ?? 0;

  return (
    <div className="page wide">
      <PageHead title="Accountant view">
        Give your accountant or auditor a read-only key. They see every payment and note. They can
        never move the money.
      </PageHead>

      {!bundle ? (
        <div className="page" style={{ maxWidth: 600, margin: 0 }}>
          <Panel
            title="Open a viewing key"
            sub="The recipient creates it with one command and shares the file."
          >
            <BundleLoader />
          </Panel>
          <Note icon={<Lock size={18} />}>
            A viewing key can find and read payments. It can't withdraw them: that needs a different
            key that never leaves the recipient.
          </Note>
        </div>
      ) : (
        <>
          <Panel className="tint">
            <div className="row between">
              <div className="row" style={{ gap: 12 }}>
                <span className="coin" style={{ background: "var(--card)" }}>
                  <FileKey2 size={19} />
                </span>
                <div>
                  <div style={{ fontWeight: 600 }}>Viewing {bundle.account}</div>
                  <div className="hint">Read only. Forgotten when you close this tab.</div>
                </div>
              </div>
              <div className="row">
                <Badge tone="good">Can't move money</Badge>
                <Button small variant="quiet" onClick={() => setBundle(null)}>
                  Close
                </Button>
              </div>
            </div>
          </Panel>

          {err && (
            <Note tone="bad" title="Couldn't read the payments.">
              {err}
            </Note>
          )}

          {res && (
            <Panel
              title="Payments"
              aside={
                <div className="row">
                  <div className="search">
                    <Search size={15} />
                    <input
                      className="input"
                      placeholder="Search"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      aria-label="Search payments"
                      data-testid="audit-filter"
                    />
                  </div>
                  <Button
                    small
                    variant="dark"
                    icon={<Download size={15} />}
                    disabled={!res.payments.length}
                    data-testid="export-csv"
                    onClick={() =>
                      downloadText(
                        `ghost-paths-${res.account}-${new Date().toISOString().slice(0, 10)}.csv`,
                        paymentsCsv(res.payments),
                      )
                    }
                  >
                    Download CSV
                  </Button>
                </div>
              }
            >
              <div className="stack" style={{ gap: 18 }} data-testid="auditor-result">
                <div className="stats">
                  <Stat
                    label="Payments"
                    value={<span data-testid="audit-count">{res.payments.length}</span>}
                    sub={busy ? "refreshing…" : `from ${plural(res.scanned, "public note")}`}
                  />
                  <Stat
                    label="Still available"
                    value={
                      totals.length ? totals.map((t) => `${t.amount} ${t.symbol}`).join(", ") : "0"
                    }
                  />
                  <Stat label="Withdrawn" value={withdrawn} />
                </div>
                {rows.length ? (
                  <div className="tablewrap">
                    <table data-testid="payments">
                      <thead>
                        <tr>
                          <th>Network</th>
                          <th>Note</th>
                          <th>Address</th>
                          <th className="num">Amount</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p) => (
                          <tr key={p.idx} data-testid="payment-row">
                            <td>
                              <span className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
                                <span style={{ transform: "scale(0.8)", display: "inline-flex" }}>
                                  <Coin cfg={cfg} tag={p.chain} size={17} />
                                </span>
                                {networkLabel(cfg, p.chain)}
                              </span>
                            </td>
                            <td style={{ maxWidth: 220, overflowWrap: "anywhere" }}>
                              {p.memo?.note ?? <span className="none">none</span>}
                            </td>
                            <td>
                              <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                                <CopyText value={p.address} head={8} tail={4} />
                                {chainAddrLink(cfg, p.chain, p.address) && (
                                  <Explorer
                                    href={chainAddrLink(cfg, p.chain, p.address)}
                                    label=""
                                  />
                                )}
                              </span>
                            </td>
                            <td className="num" style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                              {p.balance_error ? "?" : p.balance}{" "}
                              <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                                {p.symbol}
                              </span>
                            </td>
                            <td>
                              <StatusBadge p={p} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={<Search size={22} />}
                    title={res.payments.length ? "No matches" : "No payments yet"}
                  >
                    {res.payments.length
                      ? `Nothing matches "${q}".`
                      : `Nobody has paid ${res.account} privately yet.`}
                  </Empty>
                )}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
