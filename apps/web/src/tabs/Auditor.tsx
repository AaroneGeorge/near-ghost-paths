import { Download, Eye, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { downloadText, paymentsCsv, statusOf } from "../lib.ts";
import { BundleLoader, BundleSummary, NoPayments, PaymentsTable } from "../parts.tsx";
import { useStore } from "../store.tsx";
import type { ScanResult } from "../types.ts";
import { Button, Callout, Card, Chip, Stat } from "../ui.tsx";

export function AuditorTab() {
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
  const totals = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  for (const p of res?.payments ?? []) {
    if (statusOf(p) !== "unspent") continue;
    totals.set(p.symbol, (totals.get(p.symbol) ?? 0n) + toUnits(p.balance, 18));
    decimals.set(p.symbol, 18);
  }
  const swept = res?.payments.filter((p) => statusOf(p) === "swept").length ?? 0;
  const unspent = res?.payments.filter((p) => statusOf(p) === "unspent").length ?? 0;

  return (
    <div className="stack">
      <Card
        title="Auditor view"
        icon={<ShieldCheck size={17} />}
        aside={
          <Chip tone="warn" icon={<Eye size={13} />}>
            read only
          </Chip>
        }
      >
        <p className="sub">
          Everything an accountant needs, nothing that moves money. Load the viewing bundle the
          recipient exported and read the books; no spend key is involved at any point.
        </p>
        {bundle ? (
          <BundleSummary bundle={bundle} onClear={() => setBundle(null)} />
        ) : (
          <BundleLoader />
        )}
        {err && (
          <div style={{ marginTop: 14 }}>
            <Callout tone="bad" title="Scan failed.">
              {err}
            </Callout>
          </div>
        )}
      </Card>

      {bundle && res && (
        <Card
          title={`Payments to ${res.account}`}
          aside={
            <div className="row">
              <div style={{ position: "relative" }}>
                <Search
                  size={14}
                  style={{ position: "absolute", left: 10, top: 11, color: "var(--faint)" }}
                />
                <input
                  className="input"
                  style={{ paddingLeft: 30, width: 200, padding: "7px 10px 7px 30px" }}
                  placeholder="Filter"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Filter payments"
                  data-testid="audit-filter"
                />
              </div>
              <Button
                small
                icon={<Download size={14} />}
                disabled={!res.payments.length}
                data-testid="export-csv"
                onClick={() =>
                  downloadText(
                    `ghost-paths-${res.account}-${new Date().toISOString().slice(0, 10)}.csv`,
                    paymentsCsv(res.payments),
                  )
                }
              >
                Export CSV
              </Button>
            </div>
          }
        >
          <div style={{ display: "grid", gap: 16 }} data-testid="auditor-result">
            <div className="stats">
              <Stat
                label="Payments"
                value={<span data-testid="audit-count">{res.payments.length}</span>}
                sub={`${res.scanned} announcement${res.scanned === 1 ? "" : "s"} scanned`}
              />
              <Stat
                label="Unspent"
                value={unspent}
                sub={[...totals].map(([s, v]) => `${fromUnits(v, 18)} ${s}`).join(" · ") || "none"}
              />
              <Stat label="Swept" value={swept} sub="moved out by the recipient" />
              <Stat label="Can sweep" value="no" sub="no spend key in this bundle" />
            </div>
            {rows.length ? (
              <PaymentsTable rows={rows} cfg={cfg} />
            ) : res.payments.length ? (
              <NoPayments>No rows match "{q}".</NoPayments>
            ) : (
              <NoPayments>No announced payments for this account.</NoPayments>
            )}
            <Callout tone="accent" title="CSV safety.">
              Memo text is written by the payer, so cells that start with = + - or @ are prefixed
              with an apostrophe before export.
            </Callout>
          </div>
        </Card>
      )}
    </div>
  );
}

/** Decimal string → bigint scaled by 10^dec (display aggregation only). */
function toUnits(s: string, dec: number): bigint {
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(dec) + BigInt(f.padEnd(dec, "0").slice(0, dec) || "0");
}
function fromUnits(v: bigint, dec: number): string {
  const base = 10n ** BigInt(dec);
  const frac = (v % base).toString().padStart(dec, "0").replace(/0+$/, "");
  return `${v / base}${frac ? `.${frac}` : ""}`;
}
