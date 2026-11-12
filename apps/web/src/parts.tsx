import { Bitcoin, FileKey2, Hexagon, Sun, Upload } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { api } from "./api.ts";
import { chainOf, parseBundle, statusOf } from "./lib.ts";
import { useStore } from "./store.tsx";
import type { Config, Family, PaymentRow, ViewingBundle } from "./types.ts";
import { Badge, Note } from "./ui.tsx";

const FAMILY_ICON: Record<Family, (size: number) => ReactNode> = {
  evm: (s) => <Hexagon size={s} />,
  btc: (s) => <Bitcoin size={s} />,
  sol: (s) => <Sun size={s} />,
};

export function Coin({ cfg, tag, size = 19 }: { cfg: Config; tag: string; size?: number }) {
  const f = chainOf(cfg, tag)?.family ?? "evm";
  return <span className={`coin ${f}`}>{FAMILY_ICON[f](size)}</span>;
}

export function FamilyIcon({ family, size = 18 }: { family: Family; size?: number }) {
  return <>{FAMILY_ICON[family](size)}</>;
}

/** Payment state in words a person uses. */
export function StatusBadge({ p }: { p: PaymentRow }) {
  const s = statusOf(p);
  if (s === "unspent")
    return (
      <Badge tone="good" dot data-testid="status">
        Available
      </Badge>
    );
  if (s === "swept") return <Badge data-testid="status">Withdrawn</Badge>;
  if (s === "unknown")
    return (
      <Badge tone="warn" title={p.balance_error} data-testid="status">
        Can't check balance
      </Badge>
    );
  return <Badge data-testid="status">Empty</Badge>;
}

/** Drop a viewing key file, or (demo) ask the local server for a profile's. */
export function BundleLoader() {
  const { cfg, setBundle } = useStore();
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const accept = (b: ViewingBundle) => {
    setErr(null);
    setBundle(b);
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      if (f.size > 64 * 1024) throw new Error("That file is too large to be a viewing key.");
      accept(parseBundle(await f.text()));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const recipients = cfg?.profiles.filter((p) => p.recipient) ?? [];

  return (
    <div className="stack" style={{ gap: 12 }}>
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
        <Upload size={24} />
        <b>Drop a viewing key file</b>
        <span>
          or click to choose one. It stays in this browser tab and is forgotten when you close it.
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
        <div className="picks">
          <span className="hint">Demo: use the viewing key of</span>
          {recipients.map((p) => (
            <button
              type="button"
              key={p.name}
              className="pick-chip"
              data-testid={`bundle-${p.name}`}
              onClick={async () => {
                try {
                  accept((await api.viewingBundle(p.name)).bundle);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              <span className="avatar">
                <FileKey2 size={12} />
              </span>
              {p.name}
            </button>
          ))}
        </div>
      )}
      {err && <Note tone="bad">{err}</Note>}
    </div>
  );
}
