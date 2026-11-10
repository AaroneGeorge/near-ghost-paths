/** Tiny argv parser: positionals + `--flag value` / `--flag=value` / boolean `--flag`. */

/** Flags that never take a value. */
const BOOLEAN = new Set([
  "json",
  "quiet",
  "force",
  "no-view-tag",
  "no-announce",
  "no-relayer",
  "all",
  "full",
  "dry",
  "help",
  "check",
  "wet",
  "yes",
  "dev",
  "allow-link",
]);

export type Flags = Record<string, string | undefined> & {
  json?: string;
  as?: string;
  network?: string;
  contract?: string;
  relayer?: string;
  home?: string;
  mode?: string;
  via?: string;
};

export interface Parsed {
  cmd: string;
  pos: string[];
  flags: Flags;
}

export function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (BOOLEAN.has(name)) flags[name] = "1";
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
        flags[name] = v;
        i++;
      }
    } else if (a === "-h") flags.help = "1";
    else pos.push(a);
  }
  const cmd = pos.shift() ?? "help";
  return { cmd, pos, flags };
}
