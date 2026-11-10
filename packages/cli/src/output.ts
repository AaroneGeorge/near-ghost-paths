/** Output helpers: JSON-safe values (bigint → string, Uint8Array → hex) and small text formatting. */

export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array)
    return Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = jsonSafe(x);
    return out;
  }
  return v;
}

export function toJson(v: unknown): string {
  return JSON.stringify(jsonSafe(v), null, 2);
}

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
  red: wrap("31"),
  magenta: wrap("35"),
};

export function short(s: string, head = 10, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Aligned two-column block. */
export function kv(rows: [string, string | number | undefined][], indent = "  "): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${indent}${c.dim(k.padEnd(w))}  ${v}`)
    .join("\n");
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((x, i) => (x ?? "").padEnd(widths[i] as number)).join("  ");
  return [c.dim(line(headers)), ...rows.map(line)].map((l) => `  ${l}`).join("\n");
}
