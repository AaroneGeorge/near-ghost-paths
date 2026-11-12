import { CircleCheck, Eye, RefreshCw, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmtTime, nameOf, networkLabel } from "../lib.ts";
import { Coin } from "../parts.tsx";
import { useStore } from "../store.tsx";
import type { ScanResult } from "../types.ts";
import { Button, Empty, Note, PageHead, Panel } from "../ui.tsx";

export function PublicPage() {
  const { cfg } = useStore();
  const [res, setRes] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.scanStranger());
      setTries((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void run();
  }, [run]);

  if (!cfg) return null;
  const log = res?.announcements ?? [];

  return (
    <div className="page wide">
      <PageHead title="What everyone else sees">
        Payments are public. Who they're for isn't. This is Ghost Paths seen from the outside, by
        anyone watching the blockchain.
      </PageHead>

      {err && (
        <Note tone="bad" title="Couldn't load the public record.">
          {err}
        </Note>
      )}

      <Panel data-testid="stranger-result">
        <div className="verdict">
          <motion.div
            key={tries}
            className="zero"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", bounce: 0.4 }}
            data-testid="found"
          >
            {res ? res.payments.length : "…"}
          </motion.div>
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <h2>payments traced to anyone</h2>
              <p>
                {res
                  ? `We read ${res.scanned === 1 ? "the only public note" : `all ${res.scanned} public notes`} with a brand-new key, the way an outsider would. Without a recipient's own key, nothing points to a person.`
                  : "Reading the public record…"}
              </p>
            </div>
            <div>
              <Button
                small
                loading={busy}
                onClick={run}
                icon={<RefreshCw size={15} />}
                data-testid="stranger-run"
              >
                Try with another key
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      <div className="compare">
        <div>
          <h3>Anyone can see</h3>
          <ul>
            <li>That money moved to a new address</li>
            <li>How much, and when</li>
            <li>A short encrypted note on NEAR</li>
          </ul>
        </div>
        <div className="priv">
          <h3>Only the recipient can see</h3>
          <ul>
            <li>That the payment is theirs</li>
            <li>What the note says</li>
            <li>Their total across all payments</li>
          </ul>
        </div>
      </div>

      <Panel
        title="The public record"
        sub={`Every note on ${cfg.contract}, exactly as stored.`}
        aside={<Eye size={20} color="var(--faint)" />}
      >
        {log.length === 0 ? (
          <Empty icon={<Eye size={22} />} title="No payments yet">
            Send one and it appears here, with no name attached.
          </Empty>
        ) : (
          <div className="tablewrap">
            <table data-testid="public-log">
              <thead>
                <tr>
                  <th>Network</th>
                  <th>When (UTC)</th>
                  <th>Note</th>
                  <th>Posted by</th>
                  <th>For</th>
                </tr>
              </thead>
              <tbody>
                {log.map((a) => (
                  <tr key={a.idx}>
                    <td>
                      <span className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
                        <span style={{ transform: "scale(0.8)", display: "inline-flex" }}>
                          <Coin cfg={cfg} tag={a.chain} size={17} />
                        </span>
                        {networkLabel(cfg, a.chain)}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtTime(a.timestamp_ms)}</td>
                    <td>
                      {a.has_memo ? (
                        <span className="mono">{a.ct_bytes} encrypted bytes</span>
                      ) : (
                        <span className="none">none</span>
                      )}
                    </td>
                    <td className="mono">{nameOf(cfg, a.announcer)}</td>
                    <td>
                      <span className="none">not recorded</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="What Ghost Paths doesn't hide" className="flat">
        <ul className="limits">
          <li>
            <TriangleAlert size={16} />
            Amounts and timing are visible on the payment's network.
          </li>
          <li>
            <TriangleAlert size={16} />
            Withdrawing several payments to one address links them together.
          </li>
          <li>
            <TriangleAlert size={16} />
            The account that posts each note is public. Payers can use a helper service to post it
            for them.
          </li>
          <li>
            <TriangleAlert size={16} />
            With very few users, a one-byte hint in each note narrows things down. "Extra privacy"
            on Send removes it.
          </li>
          <li className="ok">
            <CircleCheck size={16} />
            The recipient's name is never written anywhere, on NEAR or on the payment's network.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
