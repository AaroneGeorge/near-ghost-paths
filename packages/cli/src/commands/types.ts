import type { Ctx } from "../context.ts";

/** A CLI command. `run` returns one JSON-able object (printed as-is with --json); `human` renders it. */
export interface Command<R = unknown> {
  name: string;
  summary: string;
  usage: string;
  run(ctx: Ctx, pos: string[]): Promise<R>;
  human?(r: R, ctx: Ctx): string;
}
