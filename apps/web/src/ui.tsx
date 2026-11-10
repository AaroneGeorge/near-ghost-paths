/** Small design-system pieces. Icons: lucide-react (Code Garage item frontend.design.icon-sets). */
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Info,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { short } from "./lib.ts";

// ---- toasts ----
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 2200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className="toast">
            {i.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- layout ----
export function Card({
  title,
  icon,
  aside,
  children,
  className = "",
  reveal,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  reveal?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  // Results appear beside the form; make sure they are on screen when they do.
  useEffect(() => {
    if (!reveal) return;
    const r = ref.current?.getBoundingClientRect();
    if (r && (r.top < 0 || r.top > window.innerHeight * 0.6))
      ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [reveal]);
  return (
    <section ref={ref} className={`card ${className}`}>
      {(title || aside) && (
        <div className="card-head">
          <h2>
            {icon}
            {title}
          </h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Button({
  variant,
  loading,
  icon,
  children,
  small,
  block,
  ...rest
}: {
  variant?: "primary" | "ghost";
  loading?: boolean;
  icon?: ReactNode;
  small?: boolean;
  block?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`btn ${variant ?? ""} ${small ? "small" : ""} ${block ? "block" : ""} ${rest.className ?? ""}`}
    >
      {loading ? <LoaderCircle size={16} className="spin" /> : icon}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  full,
}: {
  options: { value: T; label: ReactNode; testid?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  full?: boolean;
}) {
  return (
    <div className={`seg ${full ? "full" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: custom radio buttons
          role="radio"
          aria-checked={value === o.value}
          data-testid={o.testid}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  tone,
  children,
  icon,
  onClick,
  title,
}: {
  tone?: "accent" | "good" | "warn" | "bad";
  children: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const cls = `chip ${tone ?? ""} ${onClick ? "button" : ""}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={title}>
      {icon}
      {children}
    </button>
  ) : (
    <span className={cls} title={title}>
      {icon}
      {children}
    </span>
  );
}

export function Callout({
  tone,
  title,
  children,
  icon,
}: {
  tone?: "good" | "warn" | "bad" | "accent";
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  const Ico =
    tone === "good"
      ? CircleCheck
      : tone === "bad"
        ? CircleAlert
        : tone === "warn"
          ? TriangleAlert
          : Info;
  return (
    <div className={`callout ${tone ?? ""}`} role={tone === "bad" ? "alert" : undefined}>
      {icon ?? <Ico size={18} />}
      <div>
        {title && <b>{title} </b>}
        {children}
      </div>
    </div>
  );
}

export function CopyText({
  value,
  text,
  head = 10,
  tail = 6,
  full,
}: { value: string; text?: string; head?: number; tail?: number; full?: boolean }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  const label = text ?? (full ? value : short(value, head, tail));
  return (
    <button
      type="button"
      className="copy"
      title={`${value}\n(click to copy)`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          /* clipboard blocked: still show feedback */
        }
        setDone(true);
        toast("Copied to clipboard");
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <span>{label}</span>
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** Explorer link when a URL exists, otherwise the plain value (local chains / simulated mode). */
export function Explorer({ href, label, title }: { href?: string; label: string; title?: string }) {
  return href ? (
    <a className="ext" href={href} target="_blank" rel="noreferrer noopener" title={title ?? href}>
      {label}
      <ExternalLink size={12} />
    </a>
  ) : (
    <span className="mono" title={title}>
      {label}
    </span>
  );
}

export type StepState = "todo" | "active" | "done" | "failed";
export function Steps({
  steps,
}: { steps: { title: ReactNode; state: StepState; body?: ReactNode }[] }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static ordered list
        <li key={i} className={s.state}>
          <span className="step-ico">
            {s.state === "done" ? (
              <Check size={15} />
            ) : s.state === "active" ? (
              <LoaderCircle size={15} className="spin" />
            ) : s.state === "failed" ? (
              "!"
            ) : (
              i + 1
            )}
          </span>
          <div>
            <div className="step-title">{s.title}</div>
            {s.body && s.state !== "todo" && <div className="step-body">{s.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function LogBox({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="log" data-testid="log">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
}: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <b>{title}</b>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}
