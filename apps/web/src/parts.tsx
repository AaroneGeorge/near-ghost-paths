import { ArrowRight, Bitcoin, Eye, FileJson, Hexagon, KeyRound, Sun, Upload } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { api } from "./api.ts";
import { chainAddrLink, chainOf, parseBundle, statusOf } from "./lib.ts";
import { useStore } from "./store.tsx";
import type { Config, Family, PaymentRow, ViewingBundle } from "./types.ts";
import { Button, Callout, Chip, CopyText, Empty, Explorer } from "./ui.tsx";

export const FAMILY_ICON: Record<Family, ReactNode> = {
  evm: <Hexagon size={13} />,
  btc: <Bitcoin size={13} />,
  sol: <Sun size={13} />,
};

export function ChainChip({ cfg, tag }: { cfg: Config; tag: string }) {
  const c = chainOf(cfg, tag);
  return (
    <Chip icon={c ? FAMILY_ICON[c.family] : undefined} title={c?.name ?? tag}>
      {tag}
    </Chip>
  );
}

export function StatusChip({ p }: { p: PaymentRow }) {
  const s = statusOf(p);
  if (s === "unspent")
    return (
      <Chip tone="good" icon={<span className="dot" />}>
        unspent
      </Chip>
    );
  if (s === "swept") return <Chip tone="accent">swept</Chip>;
  if (s === "unknown")
    return (
      <Chip tone="warn" title={p.balance_error}>
        rpc down
      </Chip>
    );
  return <Chip>unfunded</Chip>;
}

export function PaymentsTable({
  rows,
  cfg,
  action,
}: { rows: PaymentRow[]; cfg: Config; action?: (p: PaymentRow) => ReactNode }) {
  return (
    <div className="tablewrap">
      <table data-testid="payments">
        <thead>
          <tr>
            <th>#</th>
            <th>Chain</th>
            <th>One-time address</th>
            <th className="num">Amount</th>
            <th>Memo</th>
            <th>Status</th>
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.idx} data-testid="payment-row">
              <td className="mono">{p.idx}</td>
              <td>
                <ChainChip cfg={cfg} tag={p.chain} />
              </td>
              <td>
                <div className="row" style={{ gap: 8 }}>
                  <CopyText value={p.address} head={10} tail={6} />
                  {chainAddrLink(cfg, p.chain, p.address) && (
                    <Explorer href={chainAddrLink(cfg, p.chain, p.address)} label="view" />
                  )}
                </div>
              </td>
              <td className="num amount">
                {p.balance_error ? "?" : p.balance}{" "}
                <span style={{ color: "var(--muted)" }}>{p.symbol}</span>
              </td>
              <td style={{ maxWidth: 220, overflowWrap: "anywhere" }}>
                {p.memo?.note ?? <span style={{ color: "var(--faint)" }}>none</span>}
              </td>
              <td>
                <StatusChip p={p} />
              </td>
              {action && <td className="num">{action(p)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NoPayments({ children }: { children?: ReactNode }) {
  return (
    <Empty icon={<KeyRound size={28} />} title="0 payments found">
      {children}
    </Empty>
  );
}

/** Drag-and-drop / file picker for an auditor's viewing bundle, plus the demo shortcut that asks the server for one. */
export function BundleLoader({ onLoaded }: { onLoaded?: (b: ViewingBundle) => void }) {
  const { cfg, setBundle, bundle } = useStore();
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const accept = (b: ViewingBundle) => {
    setErr(null);
    setBundle(b);
    onLoaded?.(b);
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      if (f.size > 64 * 1024) throw new Error("File too large for a viewing bundle.");
      accept(parseBundle(await f.text()));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const recipients = cfg?.profiles.filter((p) => p.recipient) ?? [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <button
        type="button"
        className={`drop ${over ? "over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void readFile(e.dataTransfer.files[0]);
        }}
      >
        <Upload size={26} />
        <b style={{ color: "var(--text)" }}>
          {bundle ? "Replace viewing bundle" : "Drop a viewing bundle here"}
        </b>
        <span>
          JSON from <code>ghost export-viewing-key</code>. Read in your browser, held in memory
          only.
        </span>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          data-testid="bundle-file"
          hidden
          onChange={(e) => void readFile(e.target.files?.[0])}
        />
      </button>
      {recipients.length > 0 && (
        <div className="row">
          <span className="hint">Demo shortcut: ask the local server for</span>
          {recipients.map((p) => (
            <Chip
              key={p.name}
              onClick={async () => {
                try {
                  accept((await api.viewingBundle(p.name)).bundle);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
              icon={<FileJson size={13} />}
            >
              {p.name}'s bundle
            </Chip>
          ))}
        </div>
      )}
      {err && <Callout tone="bad">{err}</Callout>}
    </div>
  );
}

export function BundleSummary({ bundle, onClear }: { bundle: ViewingBundle; onClear: () => void }) {
  return (
    <div className="callout accent">
      <Eye size={18} />
      <div style={{ flex: 1 }}>
        <b>Viewing key loaded for {bundle.account}.</b> It can see every payment to this account and
        can never sweep one: it holds the view key and the spend <i>public</i> key, no spend key.
        <div className="row" style={{ marginTop: 8 }}>
          <Chip>contract {bundle.signer}</Chip>
          <Chip>view_priv ••••••••</Chip>
          <Button small variant="ghost" onClick={onClear}>
            Forget
          </Button>
        </div>
      </div>
    </div>
  );
}

export function GoButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button small onClick={onClick} icon={<ArrowRight size={14} />}>
      {children}
    </Button>
  );
}
