/**
 * Links and the setup commands a recipient copies into their own terminal (receive.html). Guidance
 * only: the keys are made by the CLI on the recipient's computer; no page ever sees them.
 */
import { DEFAULT_GHOST_CONTRACT } from "@ghost-paths/sdk/src/constants.ts";
import type { PayConfig } from "../pay/config.ts";

/** NEAR account id rules (2–64 chars, lowercase, `-`/`_` inside a part, `.` between parts). */
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * Only a valid account id is ever put into a command: `?account=` comes from a link anyone can
 * craft, and the commands are pasted into a shell.
 */
export const isAccountId = (s: string) => ACCOUNT_RE.test(s);

export const placeholderAccount = (network: PayConfig["network"]) =>
  network === "testnet" ? "yourname.testnet" : "yourname.near";

/** `page` resolved next to the current page, so a host can serve the build from a sub-folder. */
const sibling = (base: string, page: string, q: Record<string, string>) => {
  const u = new URL(page, base);
  u.search = new URLSearchParams(q).toString();
  return u.href;
};
export const payUrl = (base: string, account: string) => sibling(base, "pay.html", { to: account });
export const receiveUrl = (base: string, account?: string) =>
  sibling(base, "receive.html", account ? { account } : {});

/** What a payer sends to a recipient who isn't set up yet. */
export const setupMessage = (base: string, account: string) =>
  `I'd like to pay you privately with Ghost Paths. Set up once (about 5 minutes) here: ${receiveUrl(base, account)}`;

export const PROFILE = "me";
export const CLONE =
  "git clone https://github.com/AaroneGeorge/near-ghost-paths && cd near-ghost-paths && bun install";
export const INSTALL_BUN = "curl -fsSL https://bun.sh/install | bash";

export interface SetupCommands {
  importAccount: string;
  createAccount: string;
  init: string;
  register: string;
  build: string;
  serve: string;
}

export function setupCommands(
  cfg: Pick<PayConfig, "network" | "contract" | "relayer" | "chains">,
  account: string,
): SetupCommands {
  const ghost = "bun packages/cli/src/ghost.ts";
  const contract =
    cfg.contract !== DEFAULT_GHOST_CONTRACT[cfg.network] ? ` GHOST_CONTRACT=${cfg.contract}` : "";
  const env = `GHOST_NETWORK=${cfg.network}${contract}`;
  return {
    importAccount: [
      // The key is read from the terminal (not typed on the command line, not kept in shell history).
      "printf 'Private key (ed25519:...): '; read -rs GHOST_NEAR_SECRET_KEY; echo",
      "export GHOST_NEAR_SECRET_KEY",
      `${env} ${ghost} account import --as ${PROFILE} --account-id ${account}`,
      "unset GHOST_NEAR_SECRET_KEY",
    ].join("\n"),
    createAccount: `${env} ${ghost} account create --as ${PROFILE} --account-id ${account}`,
    init: `${env} ${ghost} init --as ${PROFILE}`,
    register: `${env} ${ghost} register --as ${PROFILE}`,
    build: "bun run build",
    serve: [
      `${env} GHOST_CHAINS=${cfg.chains.join(",")} \\`,
      `GHOST_RELAYER_URL=${cfg.relayer.replace(/\/$/, "")} \\`,
      `${ghost} serve --as ${PROFILE}`,
    ].join("\n"),
  };
}
