import type { Flags } from "../args.ts";
/**
 * Command table. `ghost serve` (W4, packages/cli/src/serve.ts) mirrors these as
 * `POST /api/<name>` with body `{ pos?: string[], flags?: Record<string,string> }` via runCommand().
 */
import { Ctx } from "../context.ts";
import { account, exportViewingKey, init, meta, register } from "./keys.ts";
import { balance, derive, fund, quote, status } from "./misc.ts";
import { pay } from "./pay.ts";
import { scan } from "./scan.ts";
import { sweep } from "./sweep.ts";
import type { Command } from "./types.ts";

export const COMMANDS: Record<string, Command> = Object.fromEntries(
  [
    account,
    init,
    register,
    meta,
    pay,
    scan,
    sweep,
    exportViewingKey,
    derive,
    balance,
    fund,
    quote,
    status,
  ].map((c) => [c.name, c as Command]),
);

/** Runs a command in-process and returns its JSON-able result (used by `ghost serve`). */
export async function runCommand(
  name: string,
  pos: string[] = [],
  flags: Flags = {},
): Promise<unknown> {
  const cmd = COMMANDS[name];
  if (!cmd) throw new Error(`unknown command "${name}"`);
  const ctx = new Ctx({ ...flags, json: "1", quiet: flags.quiet ?? "1" });
  return cmd.run(ctx, pos);
}

export type { Command };
