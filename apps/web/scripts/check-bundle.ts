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

/**
 * Public values the pay page legitimately carries (they would trip the patterns above): the curve
 * parameters of secp256k1 and ed25519 (field primes, group orders, generator coordinates, d,
 * sqrt(-1)) from @noble/curves, and NEAR's MPC root PUBLIC keys (packages/sdk/src/chainsig-lite.ts).
 * Exact strings only; they are removed before scanning.
 */
const PUBLIC = [
  "fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f", // secp256k1 p
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", // secp256k1 n
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", // secp256k1 Gx
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8", // secp256k1 Gy
  "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed", // ed25519 p
  "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec", // ed25519 a = p - 1
  "1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed", // ed25519 L
  "52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3", // ed25519 d
  "216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a", // ed25519 Gx
  "6666666666666666666666666666666666666666666666666666666666666658", // ed25519 Gy
  "7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee", // secp256k1 endomorphism beta (GLV)
  "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3", // MPC testnet root
  "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya", // MPC mainnet root
];

let bad = 0;
for (const f of files) {
  if (/\.(png|ico|woff2?)$/.test(f)) continue;
  const text = PUBLIC.reduce((t, v) => t.replaceAll(v, ""), readFileSync(f, "utf8"));
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
