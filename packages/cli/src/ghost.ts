#!/usr/bin/env bun
/**
 * ghost — Ghost Paths CLI. Every command prints human output, or exactly one JSON object with
 * --json ({"ok":true,...result} / {"ok":false,"error":...}); progress lines go to stderr then.
 * --json-out FILE additionally writes the JSON result to FILE (used by demo/demo.ts).
 */
import { writeFileSync } from "node:fs";
import { installTape } from "@ghost-paths/sdk/src/chains/index.ts";
import { type Flags, parseArgs } from "./args.ts";
import { COMMANDS } from "./commands/index.ts";
import { CliError, Ctx } from "./context.ts";
import { c, jsonSafe, toJson } from "./output.ts";

const GLOBAL_HELP = `ghost — stealth payments on Bitcoin, Ethereum and Solana to a NEAR account (Ghost Paths)

usage: ghost <command> [args] [--json] [--as PROFILE]

commands:
${Object.values(COMMANDS)
  .map((cmd) => `  ${cmd.name.padEnd(20)} ${cmd.summary}`)
  .join("\n")}
  serve                ${"HTTP API for the web UI (POST /api/<command>)"}

global flags:
  --json                 one JSON object on stdout
  --json-out FILE        also write the JSON result to FILE
  --as PROFILE           local profile (keystore + NEAR account) in GHOST_HOME
  --network testnet|mainnet   (GHOST_NETWORK)   --contract ID (GHOST_CONTRACT)
  --relayer URL | --no-relayer (GHOST_RELAYER_URL)   --mode contract|account (GHOST_MODE)
  --home DIR             profile directory (GHOST_HOME, default ~/.ghost)

env: GHOST_REPLAY=1 + GHOST_TAPE=FILE replays recorded network traffic (no network at all).
`;

async function main(): Promise<number> {
  installTape();
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const { cmd, pos, flags } = parsed;
  if (cmd === "help" || (cmd !== "serve" && !COMMANDS[cmd])) {
    if (cmd !== "help") process.stderr.write(`unknown command "${cmd}"\n\n`);
    process.stdout.write(GLOBAL_HELP);
    return cmd === "help" ? 0 : 2;
  }
  if (cmd === "serve") {
    // W4 owns serve.ts (route handlers over runCommand). Loaded lazily so the CLI works without it.
    try {
      const servePath = "./serve.ts";
      const mod = (await import(servePath)) as { serve: (f: Flags) => Promise<void> };
      await mod.serve(flags);
      return 0;
    } catch (e) {
      process.stderr.write(`ghost serve unavailable: ${(e as Error).message}\n`);
      return 1;
    }
  }
  const command = COMMANDS[cmd];
  if (!command) return 2;
  if (flags.help) {
    process.stdout.write(`${command.summary}\n\nusage: ${command.usage}\n`);
    return 0;
  }
  let ctx: Ctx;
  try {
    ctx = new Ctx(flags);
  } catch (e) {
    return fail(flags.json, e);
  }
  try {
    const result = await command.run(ctx, pos);
    if (flags["json-out"])
      writeFileSync(
        flags["json-out"],
        `${toJson({ ok: true, command: cmd, ...(result as object) })}\n`,
      );
    if (flags.json)
      process.stdout.write(`${toJson({ ok: true, command: cmd, ...(result as object) })}\n`);
    else process.stdout.write(`${command.human ? command.human(result, ctx) : toJson(result)}\n`);
    return 0;
  } catch (e) {
    if (flags["json-out"]) {
      writeFileSync(
        flags["json-out"],
        `${toJson({ ok: false, command: cmd, error: (e as Error).message, ...(jsonSafe((e as { result?: object }).result) as object) })}\n`,
      );
    }
    return fail(flags.json, e, cmd);
  }
}

function fail(json: string | undefined, e: unknown, cmd?: string): number {
  const err = e as Error & { code?: number; result?: object };
  const msg = err?.message ?? String(e);
  if (json)
    process.stdout.write(
      `${toJson({ ok: false, command: cmd, error: msg, ...(err.result ?? {}) })}\n`,
    );
  else {
    process.stderr.write(`${c.red("error:")} ${msg}\n`);
    if (process.env.GHOST_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
  }
  return e instanceof CliError ? (err.code ?? 1) : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fatal: ${(e as Error)?.stack ?? e}\n`);
    process.exit(1);
  },
);
