/**
 * Playwright smoke test: send → scan shows 1 → stranger sees 0 → auditor bundle + CSV → sweep → balance moves.
 *
 *   bun run e2e                                 starts `ghost serve --dev=1` itself (MemoryRegistry, simulated chains)
 *   GHOST_E2E_URL=http://127.0.0.1:8788 bun run e2e   drives an already running `ghost serve` (e.g. after `make demo`)
 *
 * Needs `bun run build` first when it starts its own server (the server serves apps/web/dist).
 * Screenshots go to e2e/out (override with GHOST_E2E_SHOTS).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, "../../..");
const shots = process.env.GHOST_E2E_SHOTS ?? join(import.meta.dir, "out");
mkdirSync(shots, { recursive: true });

/** Playwright wants the chromium build it was released with; fall back to any installed one. */
function findChromium(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(homedir(), ".cache", "ms-playwright"));
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).sort().reverse()) {
    for (const sub of [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-linux/headless_shell",
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-headless-shell-mac-x64/chrome-headless-shell",
    ]) {
      const p = join(base, d, sub);
      if (d.startsWith("chromium") && existsSync(p)) return p;
    }
  }
  return undefined;
}

async function waitFor(url: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not come up: ${url}`);
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main() {
  let server: ChildProcess | undefined;
  // REVIEW M4: ghost serve needs its session token; pass it as GHOST_SERVE_TOKEN or in GHOST_E2E_URL (?token=).
  let base = process.env.GHOST_E2E_URL;
  let token = process.env.GHOST_SERVE_TOKEN ?? "";
  if (base) {
    const u = new URL(base);
    token = u.searchParams.get("token") ?? token;
    base = u.origin;
  }
  if (!base) {
    token = crypto.randomUUID().replaceAll("-", "");
    if (!existsSync(join(import.meta.dir, "../dist/index.html")))
      throw new Error("apps/web/dist missing: run `bun run build` first");
    const port = 18800 + Math.floor(Math.random() * 500);
    server = spawn(
      "bun",
      [join(root, "packages/cli/src/ghost.ts"), "serve", "--dev=1", "--port", String(port)],
      {
        cwd: root,
        env: { ...process.env, GHOST_DEV_DELAY_MS: "150", GHOST_SERVE_TOKEN: token },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/health`);
  }
  const browser = await chromium.launch({ executablePath: findChromium() });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
  const txt = async (id: string) =>
    ((await page.getByTestId(id).first().textContent()) ?? "").trim();

  try {
    console.log(`smoke: ${base}`);
    await page.goto(`${base}/?token=${token}`);
    await page
      .getByTestId("status")
      .getByText(/NEAR|Demo mode/)
      .waitFor();
    await shot("01-send-empty");

    // ---- Send
    console.log("Send");
    await page.getByTestId("registered").getByText("Ready", { exact: true }).waitFor();
    await page.getByTestId("amount").fill("0.01");
    await page.getByTestId("memo").fill("invoice #42");
    await page.getByTestId("send").click();
    await page.getByTestId("pay-result").waitFor({ timeout: 120_000 });
    const addr = await txt("onetime-address");
    check(/^0x[0-9a-fA-F]{40}$/.test(addr), `one-time EVM address shown (${addr.slice(0, 10)}…)`);
    await page.getByTestId("pay-details").locator("summary").click();
    check(
      (await txt("announcement")).includes("no recipient"),
      "technical details show the note has no recipient field",
    );
    await shot("02-send-result");

    // ---- Inbox (the recipient's scan) shows 1
    console.log("Inbox");
    await page.getByTestId("to-inbox").click();
    await page.getByTestId("scan-result").waitFor();
    await page.getByTestId("found").filter({ hasText: /^1$/ }).waitFor();
    check((await txt("found")) === "1", "recipient inbox finds exactly 1 payment");
    check(
      (await page.getByTestId("payment-row").first().textContent())?.includes("invoice #42"),
      "note decrypted in the inbox",
    );
    await shot("03-inbox");

    // ---- What others see: a stranger finds nothing, public log has no recipient
    await page.getByTestId("tab-public").click();
    await page.getByTestId("public-log").waitFor();
    check(
      (await page.getByTestId("stranger-result").getByTestId("found").textContent())?.trim() ===
        "0",
      "stranger finds 0 payments",
    );
    check(
      (await page.getByTestId("public-log").locator("tbody tr").count()) >= 1,
      "public log lists the note",
    );
    await shot("04-public");

    // ---- Accountant: upload a viewing key, read-only table, CSV
    console.log("Accountant");
    const res = await fetch(`${base}/api/viewing-bundle?profile=bob`, {
      headers: { "x-ghost-token": token },
    });
    const bundleJson = JSON.stringify(((await res.json()) as { bundle: unknown }).bundle);
    const file = join(tmpdir(), `ghost-e2e-bundle-${process.pid}.json`);
    writeFileSync(file, bundleJson, { mode: 0o600 });
    await page.getByTestId("tab-accountant").click();
    await page.getByTestId("bundle-file").setInputFiles(file);
    await page.getByTestId("auditor-result").waitFor();
    check((await txt("audit-count")) === "1", "accountant view (uploaded key) lists 1 payment");
    check(
      !(await page.content()).includes(JSON.parse(bundleJson).view_priv),
      "view_priv is never rendered",
    );
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-csv").click(),
    ]);
    const csvPath = await dl.path();
    const csv = readFileSync(csvPath, "utf8");
    check(
      csv.includes("invoice #42") && csv.includes(addr),
      "CSV export has the note and the address",
    );
    await shot("05-accountant");

    // ---- Withdraw from the inbox
    console.log("Withdraw");
    await page.getByTestId("tab-inbox").click();
    await page.getByTestId("withdraw").first().click();
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="dest"]') as HTMLInputElement | null)?.value.length,
    );
    await shot("06-withdraw-form");
    await page.getByTestId("sweep").click();
    await page.getByTestId("sweep-result").waitFor({ timeout: 180_000 });
    const before = await txt("bal-before");
    const delta = await txt("bal-delta");
    const after = await txt("bal-after");
    check(before === "0", `destination balance before: ${before}`);
    check(/^\+0\.\d+ ETH$/.test(delta), `balance moved ${delta} (after: ${after})`);
    await shot("07-withdrawn");

    // the one-time address is now empty: the inbox says withdrawn
    await page.getByTestId("payment-row").first().getByText("Withdrawn").waitFor();
    check(true, "inbox now marks the payment withdrawn");

    check(
      errors.length === 0,
      `no browser console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`,
    );
    console.log("SMOKE PASSED");
  } catch (e) {
    await shot("failure").catch(() => {});
    console.error(
      `SMOKE FAILED: ${(e as Error).message}\n(screenshot: ${join(shots, "failure.png")})`,
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
    server?.kill();
  }
}

await main();
