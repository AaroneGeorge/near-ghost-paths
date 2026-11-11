/**
 * Small design-system pieces.
 * From the Code Garage: icons lucide-react (frontend.design.icon-sets), toasts sonner
 * (frontend.components.toasts-drawers-command-hotkeys), motion (frontend.animation.motion).
 */
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Info,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { short } from "./lib.ts";

export function Panel({
  title,
  sub,
  aside,
  children,
  className = "",
  ...rest
}: {
  title?: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`panel ${className}`} {...rest}>
      {(title || aside) && (
        <div className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <p>{sub}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHead({
  title,
  children,
  aside,
}: { title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className={`page-head ${aside ? "split" : ""}`}>
      <div className="stack" style={{ gap: 8 }}>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {aside}
    </header>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
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
  big,
  block,
  ...rest
}: {
  variant?: "primary" | "dark" | "quiet";
  loading?: boolean;
  icon?: ReactNode;
  small?: boolean;
  big?: boolean;
  block?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`btn ${variant ?? ""} ${small ? "small" : ""} ${big ? "big" : ""} ${block ? "block" : ""} ${rest.className ?? ""}`}
    >
      {loading ? <LoaderCircle size={17} className="spin" /> : icon}
      {children}
    </button>
  );
}

export function Badge({
  tone,
  children,
  dot,
  title,
  ...rest
}: {
  tone?: "good" | "warn" | "bad" | "mint";
  children: ReactNode;
  dot?: boolean;
  title?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`badge ${tone ?? ""}`} title={title} {...rest}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Note({
  tone,
  title,
  children,
  icon,
}: {
  tone?: "good" | "warn" | "bad";
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
    <div className={`note ${tone ?? ""}`} role={tone === "bad" ? "alert" : undefined}>
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
  head = 10,
  tail = 6,
  full,
  ...rest
}: {
  value: string;
  head?: number;
  tail?: number;
  full?: boolean;
} & React.HTMLAttributes<HTMLButtonElement>) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      title={`${value}\n(click to copy)`}
      {...rest}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          /* clipboard blocked: still show feedback */
        }
        setDone(true);
        toast.success("Copied");
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <span>{full ? value : short(value, head, tail)}</span>
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** Explorer link when a URL exists, otherwise the plain value (local chains / demo mode). */
export function Explorer({ href, label, title }: { href?: string; label: string; title?: string }) {
  return href ? (
    <a className="ext" href={href} target="_blank" rel="noreferrer noopener" title={title ?? href}>
      {label}
      <ExternalLink size={13} />
    </a>
  ) : (
    <span className="mono" title={title}>
      {label}
    </span>
  );
}

export type StepState = "todo" | "active" | "done";
export function Progress({
  steps,
  ...rest
}: {
  steps: { title: ReactNode; state: StepState; body?: ReactNode }[];
} & React.HTMLAttributes<HTMLOListElement>) {
  return (
    <ol className="progress" {...rest}>
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static ordered list
        <li key={i} className={s.state}>
          <span className="ico">
            {s.state === "done" ? (
              <Check size={15} strokeWidth={2.6} />
            ) : s.state === "active" ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              i + 1
            )}
          </span>
          <div>
            <div className="t">{s.title}</div>
            {s.body && s.state !== "todo" && <div className="b">{s.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Collapsed "technical details" area: the proof for people who want it, out of everyone else's way. */
export function More({
  label,
  children,
  open,
  ...rest
}: { label: ReactNode; children: ReactNode; open?: boolean } & React.HTMLAttributes<HTMLElement>) {
  return (
    <details className="more" open={open} {...rest}>
      <summary>
        <ChevronRight size={16} />
        {label}
      </summary>
      <div className="in">{children}</div>
    </details>
  );
}

export function Empty({
  icon,
  title,
  children,
}: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ring">{icon}</div>
      <b>{title}</b>
      {children && <p>{children}</p>}
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

export function Avatar({ name, lg }: { name: string; lg?: boolean }) {
  return <span className={`avatar ${lg ? "lg" : ""}`}>{name.slice(0, 1)}</span>;
}
