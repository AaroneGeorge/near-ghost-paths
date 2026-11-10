import { Eye, KeyRound, ScanSearch, ShieldOff, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmtTime, short } from "../lib.ts";
import { BundleLoader, BundleSummary, GoButton, NoPayments, PaymentsTable } from "../parts.tsx";
import { type ScanView, useStore } from "../store.tsx";
import type { Config, ScanResult } from "../types.ts";
import { Button, Callout, Card, Chip, Empty, Field, Segmented, Stat } from "../ui.tsx";

export function ScanTab() {
  const { cfg, scanView, setScanView } = useStore();
  if (!cfg) return null;
  return (
    <div className="stack">
      <div className="row between">
        <Segmented<ScanView>
          label="Who is scanning"
          value={scanView}
          onChange={setScanView}
          options={[
            {
              value: "recipient",
              label: (
                <span className="row" style={{ gap: 7 }}>
                  <UserRound size={15} /> As the recipient
                </span>
              ),
              testid: "view-recipient",
            },
            {
              value: "auditor",
              label: (
                <span className="row" style={{ gap: 7 }}>
                  <Eye size={15} /> As an auditor
                </span>
              ),
              testid: "view-auditor",
            },
            {
              value: "stranger",
              label: (
                <span className="row" style={{ gap: 7 }}>
                  <ShieldOff size={15} /> As a stranger
                </span>
              ),
              testid: "view-stranger",
            },
          ]}
        />
        <span className="hint">Same public announcements, three different keys.</span>
      </div>
      {scanView === "recipient" && <RecipientView cfg={cfg} />}
      {scanView === "auditor" && <AuditorView cfg={cfg} />}
      {scanView === "stranger" && <StrangerView cfg={cfg} />}
    </div>
  );
}

function ScanSummary({ r }: { r: ScanResult }) {
  return (
    <div className="stats">
      <Stat label="Announcements scanned" value={r.scanned} sub="the whole public log" />
      <Stat
        label="Payments found"
        value={<span data-testid="found">{r.payments.length}</span>}
        sub={r.kind === "stranger" ? "for a random key" : `for ${r.account}`}
      />
      <Stat
        label="Can sweep"
        value={r.can_sweep ? "yes" : "no"}
        sub={r.can_sweep ? "holds the spend key" : "view only"}
      />
    </div>
  );
}

function RecipientView({ cfg }: { cfg: Config }) {
  const { who, setWho, go, setSweepPick } = useStore();
  const recipients = cfg.profiles.filter((p) => p.recipient);
  const [res, setRes] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async (name: string) => {
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.scan(name));
    } catch (e) {
      setErr((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }, []);
  // Scan on arrival and whenever the profile changes (cheap: one view call + local math).
  useEffect(() => {
    void run(who);
  }, [who, run]);

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
      <Card
        title="Scan as the recipient"
        icon={<ScanSearch size={17} />}
        aside={
          <Chip tone="accent" icon={<KeyRound size={13} />}>
            spend + view keys
          </Chip>
        }
      >
        <p className="sub">
          Your viewing key recognises payments addressed to you among everyone's announcements. Your
          spend key, which never leaves the server, is what lets you sweep them.
        </p>
        <div className="row" style={{ alignItems: "end", marginBottom: 16 }}>
          <div style={{ minWidth: 260 }}>
            <Field label="Scan as">
              <select
                className="select"
                value={who}
                onChange={(e) => setWho(e.target.value)}
                data-testid="scan-as"
              >
                {recipients.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.account ? ` (${p.account})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => run(who)}
            icon={<ScanSearch size={16} />}
            data-testid="scan-run"
            style={{ marginBottom: 14 }}
          >
            Scan registry
          </Button>
        </div>
        {err && (
          <Callout tone="bad" title="Scan failed.">
            {err}
          </Callout>
        )}
        {res && (
          <div style={{ display: "grid", gap: 16 }} data-testid="scan-result">
            <ScanSummary r={res} />
            {res.payments.length ? (
              <PaymentsTable
                rows={res.payments}
                cfg={cfg}
                action={(p) => (
                  <GoButton
                    onClick={() => {
                      setSweepPick(p);
                      go("sweep");
                    }}
                  >
                    Sweep
                  </GoButton>
                )}
              />
            ) : (
              <NoPayments>
                Nothing has been announced for {res.account} yet. Try the Send tab.
              </NoPayments>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function AuditorView({ cfg }: { cfg: Config }) {
  const { bundle, setBundle, go } = useStore();
  const [res, setRes] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  return (
    <Card
      title="Scan as an auditor"
      icon={<Eye size={17} />}
      aside={
        <Chip tone="warn" icon={<Eye size={13} />}>
          view key only
        </Chip>
      }
    >
      <p className="sub">
        The recipient exports a viewing bundle and hands it to an accountant. It lets them see every
        payment and memo, and nothing more: no spend key, so no sweep.
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
      {bundle && (
        <div style={{ display: "grid", gap: 16, marginTop: 16 }} data-testid="auditor-scan-result">
          <div className="row">
            <Button loading={busy} onClick={run} small icon={<ScanSearch size={14} />}>
              Rescan
            </Button>
            <Button small variant="ghost" onClick={() => go("auditor")}>
              Open the Auditor report
            </Button>
          </div>
          {res && (
            <>
              <ScanSummary r={res} />
              {res.payments.length ? (
                <PaymentsTable rows={res.payments} cfg={cfg} />
              ) : (
                <NoPayments>This bundle's account has no announced payments.</NoPayments>
              )}
              <Callout tone="accent" title="No spend key:">
                cannot sweep. The Sweep button is not offered, and the server would have nothing to
                sign with.
              </Callout>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function StrangerView({ cfg }: { cfg: Config }) {
  const [res, setRes] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.scanStranger());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div className="stack">
      <Card
        title="Scan as a stranger"
        icon={<ShieldOff size={17} />}
        aside={<Chip tone="bad">no keys</Chip>}
      >
        <p className="sub">
          A brand-new random key tries to find payments in the very same public log. It cannot, and
          neither can anyone watching the chain.
        </p>
        <div className="row" style={{ marginBottom: 16 }}>
          <Button
            variant="primary"
            loading={busy}
            onClick={run}
            icon={<ShieldOff size={16} />}
            data-testid="stranger-run"
          >
            Scan with a random key
          </Button>
        </div>
        {err && (
          <Callout tone="bad" title="Scan failed.">
            {err}
          </Callout>
        )}
        {res && (
          <div style={{ display: "grid", gap: 16 }} data-testid="stranger-result">
            <ScanSummary r={res} />
            <NoPayments>
              A key that is not the recipient's matches none of the {res.scanned} announcement
              {res.scanned === 1 ? "" : "s"}.
            </NoPayments>
          </div>
        )}
      </Card>
      {res?.announcements && (
        <Card
          title="What is actually public"
          icon={<Eye size={17} />}
          aside={
            <span className="hint">
              {res.announcements.length} on {cfg.contract}
            </span>
          }
        >
          <p className="sub">
            This is the whole log. There is no recipient column to fill in, no address that appears
            twice, and the memo is ciphertext.
          </p>
          {res.announcements.length === 0 ? (
            <Empty icon={<Eye size={26} />} title="Nothing announced yet" />
          ) : (
            <div className="tablewrap">
              <table data-testid="public-log">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Chain</th>
                    <th>Ephemeral key</th>
                    <th className="num">Tag</th>
                    <th>Memo</th>
                    <th>Announcer</th>
                    <th>Recipient</th>
                    <th>Time (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {res.announcements.map((a) => (
                    <tr key={a.idx}>
                      <td className="mono">{a.idx}</td>
                      <td className="mono">{a.chain}</td>
                      <td className="mono" title={a.eph}>
                        {short(a.eph, 8, 6)}
                      </td>
                      <td className="num mono">0x{a.tag.toString(16).padStart(2, "0")}</td>
                      <td className="mono" style={{ color: "var(--faint)" }}>
                        {a.has_memo ? `${a.ct_bytes} B ciphertext` : "none"}
                      </td>
                      <td className="mono">{a.announcer}</td>
                      <td style={{ color: "var(--faint)" }}>not on chain</td>
                      <td className="mono">{fmtTime(a.timestamp_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <Callout tone="warn" title="Honest limits.">
              The announcer, the time and the amount on the target chain are public, and the
              one-byte view tag leaks a little in a small registry. Ghost Paths hides who got paid,
              not that a payment happened.
            </Callout>
          </div>
        </Card>
      )}
    </div>
  );
}
