/**
 * Fails the build if dist/ looks like it contains a secret. The web app never holds keys, so any of
 * these in the bundle is a bug: private-key blocks, NEAR/ed25519 secret keys, 64-hex blobs (seeds and
 * view keys look like that), or the values of secret-ish environment variables present at build time.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist");
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
};
try {
  walk(dist);
} catch {
  console.error("check-bundle: dist/ missing; run vite build first");
  process.exit(1);
}

const patterns: [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["NEAR/ed25519 secret key", /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/],
  ["secp256k1 secret key", /secp256k1:[1-9A-HJ-NP-Za-km-z]{60,}/],
  ["64+ hex blob", /(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])/],
  [
    "seed / view_priv assignment",
    /(seed|view_priv|d_spend|secret_key)["']?\s*[:=]\s*["'][0-9a-f]{32,}/i,
  ],
  ["API key assignment", /(api[_-]?key|authorization|bearer)\s*[:=]\s*["'][A-Za-z0-9_\-.]{16,}/i],
];
const envSecrets = Object.entries(process.env)
  .filter(
    ([k, v]) =>
      /(SECRET|PRIVATE|_PK$|_KEY$|TOKEN|PASSWORD|SEED)/i.test(k) && (v ?? "").length >= 12,
  )
  .map(([k, v]) => [k, v as string] as const);

let bad = 0;
for (const f of files) {
  if (/\.(png|ico|woff2?)$/.test(f)) continue;
  const text = readFileSync(f, "utf8");
  for (const [name, re] of patterns) {
    const m = re.exec(text);
    if (m) {
      console.error(
        `check-bundle: ${name} in ${f.replace(dist, "dist")}: ${m[0].slice(0, 6)}… (redacted)`,
      );
      bad++;
    }
  }
  for (const [k, v] of envSecrets) {
    if (text.includes(v)) {
      console.error(
        `check-bundle: value of env ${k} found in ${f.replace(dist, "dist")} (redacted)`,
      );
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log(`check-bundle: ${files.length} files, no secrets found`);
