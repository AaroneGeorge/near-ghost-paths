/**
 * "How Ghost Paths works": the full guide for newcomers and judges. Static like the pay page and the
 * setup guide, and like them it holds no keys and needs no wallet. Every name in it (network,
 * contract, MPC signer, relayer, chain) comes from the same config as the pay page, and the setup
 * commands come from setup.ts, so the text cannot drift from what the other pages do.
 * Sources for every claim: README.md, docs/SPEC.md, docs/THREAT-MODEL.md, docs/HOSTING.md, docs/DEMO.md.
 */
import { chainInfo } from "@ghost-paths/sdk/src/chains/config.ts";
import { MPC_CONTRACT } from "@ghost-paths/sdk/src/constants.ts";
import { parseHandle } from "@ghost-paths/sdk/src/keys.ts";
import type { ChainTag } from "@ghost-paths/sdk/src/types.ts";
import {
  ArrowRight,
  BookOpen,
  Eye,
  EyeOff,
  Ghost,
  KeyRound,
  Laptop,
  Megaphone,
  Network,
  ScrollText,
  Send,
  Wallet,
} from "lucide-react";
import { MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { GhostPath } from "../ghostpath.tsx";
import { type PayConfig, loadPayConfig, nearAccountUrl } from "../pay/config.ts";
import { isAccountId, placeholderAccount, receiveUrl, setupCommands } from "../receive/setup.ts";
import { Field, More, Note, PageHead, Panel } from "../ui.tsx";

const REPO = "https://github.com/AaroneGeorge/near-ghost-paths";
const doc = (path: string) => `${REPO}/blob/main/${path}`;

export default function HowApp() {
  const [cfg, setCfg] = useState<PayConfig | null>(null);
  useEffect(() => {
    loadPayConfig().then(setCfg);
  }, []);
  return <MotionConfig reducedMotion="user">{cfg && <How cfg={cfg} />}</MotionConfig>;
}

const SECTIONS: [id: string, label: string][] = [
  ["pieces", "The pieces"],
  ["paying", "Paying"],
  ["setup", "Set up to receive"],
  ["finding", "Finding your payments"],
  ["withdrawing", "Withdrawing"],
  ["privacy", "Public vs private"],
  ["check", "Check it yourself"],
  ["faq", "Questions"],
];

function How({ cfg }: { cfg: PayConfig }) {
  const chain = cfg.chains[0] as ChainTag;
  const info = chainInfo(chain);
  const chainName = info.name;
  const sym = info.symbol;
  const signer = MPC_CONTRACT[cfg.network];
  const testnet = cfg.network === "testnet";
  const ext = { target: "_blank", rel: "noreferrer noopener" } as const;
  const contractLink = (
    <a href={nearAccountUrl(cfg, cfg.contract)} {...ext}>
      <code>{cfg.contract}</code>
    </a>
  );
  const signerLink = (
    <a href={nearAccountUrl(cfg, signer)} {...ext}>
      <code>{signer}</code>
    </a>
  );

  return (
    <div className="shell">
      <header className="top">
        <div className="top-in pay-top">
          <a className="brand" href="./pay.html">
            <Ghost size={24} strokeWidth={2.2} />
            Ghost Paths
          </a>
          <div className="net">
            <span className="dot" />
            NEAR {cfg.network} · {chainName}
          </div>
          <div className="wallet-slot top-links">
            <a className="btn small quiet" href="./pay.html" data-testid="to-pay">
              <Send size={15} />
              <span className="long">Pay someone</span>
              <span className="short">Pay</span>
            </a>
            <a className="btn small" href="./receive.html" data-testid="to-receive">
              <Laptop size={15} />
              <span className="long">Set up to receive</span>
              <span className="short">Receive</span>
            </a>
          </div>
        </div>
      </header>

      <main>
        <div className="page guide">
          <PageHead title="How Ghost Paths works">
            Pay anyone by their NEAR account name. The money lands at a brand-new address on{" "}
            {chainName} that nobody else can link to them, and NEAR Chain Signatures lets them
            withdraw it later without ever holding a private key for that address.
          </PageHead>

          {testnet && (
            <Note title="Test network, no real money.">
              Everything here runs on NEAR testnet and {chainName}. The coins are free test coins.
            </Note>
          )}

          <Panel>
            <div className="stack" style={{ gap: 18 }}>
              <GhostPath from="Payer" to="Recipient" />
              <p className="lead">
                A normal payment shows the whole world who paid whom, because the recipient's
                address is public and reused. With Ghost Paths, the payer only needs the recipient's
                NEAR name. Each payment goes to its own fresh address, and only the recipient's keys
                can tell that the address is theirs.
              </p>
              <nav className="toc" aria-label="On this page" data-testid="toc">
                {SECTIONS.map(([id, label], i) => (
                  <a key={id} href={`#${id}`}>
                    <span className="n">{i + 1}</span>
                    {label}
                  </a>
                ))}
              </nav>
            </div>
          </Panel>

          {/* ---------------------------------------------------------------- 1. pieces */}
          <Section
            id="pieces"
            n={1}
            title="The pieces"
            sub="Who and what is involved, and who holds which key."
          >
            <PlaceMap cfg={cfg} chainName={chainName} signer={signer} />
            <ul className="cast" data-testid="cast">
              <Actor
                icon={<Wallet size={18} />}
                name="The payer"
                holds="Their own wallet (for example MetaMask) and its key."
              >
                Pays from their wallet as usual. Needs no NEAR account and no setup.
              </Actor>
              <Actor
                icon={<Laptop size={18} />}
                name="The recipient"
                holds="Two keys, on their own computer only: a spend key and a viewing key."
              >
                The viewing key finds payments; the spend key approves withdrawals. They hold no{" "}
                {chainName} key at all.
              </Actor>
              <Actor
                icon={<ScrollText size={18} />}
                name="The Ghost Paths contract on NEAR"
                holds="No money and no keys."
              >
                {contractLink}: a public phone book (each recipient's two public keys), a notice
                board (the encrypted notes) and the gate for withdrawals: it asks for a signature
                only when the request is signed by that payment's own key.
              </Actor>
              <Actor
                icon={<Network size={18} />}
                name="NEAR Chain Signatures (the MPC network)"
                holds="Shares of one big signing key; no single node has all of it."
              >
                {signerLink} is a network of independent nodes that sign together. Every one-time
                address is an address of this network, worked out from the contract's name and a
                path. It signs for that address only when the contract asks.
              </Actor>
              <Actor
                icon={<Megaphone size={18} />}
                name="The relayer"
                holds="Its own NEAR account key, which pays NEAR fees and note storage."
              >
                Posts notes and withdrawals on NEAR from its own account, so neither the payer nor
                the recipient appears there. It can refuse to post. It cannot steal or redirect
                money.
              </Actor>
            </ul>
            <More label="For the technically curious: the keys" data-testid="more-keys">
              <p>
                The recipient's keys come from one 32-byte random seed, stored in{" "}
                <code>~/.ghost/&lt;profile&gt;.json</code> (file mode 0600). With HKDF-SHA256 it
                gives a secp256k1 spend key <code>d_spend</code> and an X25519 viewing key{" "}
                <code>k_view</code>. Registering publishes only the public halves,{" "}
                <code>P_spend</code> and <code>P_view</code> (the "meta-address"), under the NEAR
                account name.
              </p>
              <p>
                Each payment has its own key <code>K = P_spend + h·G</code>; only the recipient can
                compute its private half <code>d_K = d_spend + h</code>, and it is never stored. The
                address itself is not <code>K</code>: it is the Chain Signatures address for
                predecessor = the contract and path <code>gp1/ + sha256(K)</code>. That is why one
                secp256k1 spend key can serve Ethereum, Bitcoin and Solana addresses alike.{" "}
                <a href={doc("docs/SPEC.md")} {...ext}>
                  Full spec
                </a>
                .
              </p>
            </More>
          </Section>

          {/* ---------------------------------------------------------------- 2. paying */}
          <Section
            id="paying"
            n={2}
            title="Paying, step by step"
            sub="What the pay page does when you press Send. It holds no keys: your wallet signs."
          >
            <ol className="steps">
              <Step n={1} title="You type the recipient's NEAR name">
                <p>
                  The page reads that name's two public keys from the contract's phone book and
                  shows <b>Ready</b>, or <b>Not set up</b> (then the Send button stays off and the
                  page offers a setup link for them instead). They never have to send you an
                  address.
                </p>
              </Step>
              <Step n={2} title="It checks the contract">
                <p>
                  Right before paying, it reads the public keys again and checks that {contractLink}{" "}
                  runs the expected code. If the code differs, it refuses to pay.
                </p>
              </Step>
              <Step n={3} title="It works out a brand-new address, in your browser">
                <p>
                  From the recipient's public keys and a fresh random number, it computes an address
                  on {chainName} that has never been used and never will be again. Nobody is asked
                  for it; nothing is sent anywhere to make it.
                </p>
              </Step>
              <Step n={4} title="Your wallet pays that address">
                <p>
                  Your wallet asks to switch to {chainName} if needed, then shows a plain transfer
                  of your amount to an address you have never seen. You confirm, and the page waits
                  for {chainName} to confirm it.
                </p>
              </Step>
              <Step n={5} title="An encrypted note goes on NEAR">
                <p>
                  The page hands a small note to the relayer, which posts it on the contract's
                  notice board from its own account. The note has no recipient field. Inside it,
                  encrypted so only the recipient can read it: the amount, the payment's transaction
                  and your message, if you wrote one.
                </p>
              </Step>
            </ol>
            <Note tone="good" title="What you see:">
              three progress steps (confirm in your wallet, {chainName} confirms, encrypted note on
              NEAR), then <b>Sent privately</b> with the one-time address. <b>Technical details</b>{" "}
              lists the {chainName} transaction, the NEAR note transaction and the note itself.
            </Note>
            <div className="compare" data-testid="explorers">
              <div>
                <h3>On the {chainName} explorer</h3>
                <ul>
                  <li>
                    A plain transfer from your address to a brand-new address with no history.
                  </li>
                  <li>The amount and the time. Nothing names the recipient.</li>
                </ul>
              </div>
              <div>
                <h3>On the NEAR explorer</h3>
                <ul>
                  <li>
                    The relayer's account calling <code>announce</code> on the contract.
                  </li>
                  <li>
                    Its arguments: the chain, a one-time public key, a 1-byte tag and a ciphertext.
                    No recipient.
                  </li>
                </ul>
              </div>
            </div>
            <More
              label="For the technically curious: the math in the browser"
              data-testid="more-pay"
            >
              <p>
                ERC-5564-style stealth addresses, adapted to Chain Signatures. With the recipient's{" "}
                <code>P_view</code> (X25519) and <code>P_spend</code> (secp256k1):
              </p>
              <pre className="code">
                {`// e: 32 fresh random bytes
E    = X25519(e, 9)       // public "ephemeral key"
S    = X25519(e, P_view)  // shared secret; the
                          // recipient gets it from E
tag  = sha256("ghost-paths/v1/view-tag" || S)[0]
h    = HKDF(S, "tweak" || E || P_spend
            || "${chain}")
K    = P_spend + h·G
path = "gp1/" + hex(sha256(K))
A    = ChainSig address(${cfg.contract},
                        path, domain 0)
ct   = XChaCha20-Poly1305(HKDF(S, "memo"),
         {amount, asset, txid, note?})
announce(chain, E, tag, ct) // no recipient field`}
              </pre>
              <p>
                The Chain Signatures derivation is public math:{" "}
                <code>
                  epsilon = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" || predecessor
                  || "," || path)
                </code>
                , child key = MPC root key + epsilon·G, address = the last 20 bytes of its keccak
                hash. The page uses a small re-implementation (<code>chainsig-lite.ts</code>) with
                the same root keys, tested byte for byte against chainsig.js; the derived keys equal
                the signer's own <code>derived_public_key</code> view. The code-hash check matters
                because the contract is the predecessor of every address: a look-alike contract
                would control the money.
              </p>
            </More>
          </Section>

          {/* ---------------------------------------------------------------- 3. setup */}
          <Section
            id="setup"
            n={3}
            title="Receiving: set up once"
            sub="About 5 minutes, in a terminal on your own computer."
          >
            <p>
              To be paid by name, you need keys, and you need to publish their public half so payers
              can find it. No website can do this for you without seeing your keys, so it happens on
              your computer: the keys are made there and never leave it.
            </p>
            <ol className="steps" data-testid="setup-summary">
              <Step n={1} title="Install git and bun">
                <p>The two tools the app needs (macOS or Linux; on Windows, WSL).</p>
              </Step>
              <Step n={2} title="Get the Ghost Paths app">
                <p>One command downloads it (it is open source) and installs its parts.</p>
              </Step>
              <Step n={3} title="Connect your NEAR account">
                <p>
                  Use your existing account (its key is saved only in your own <code>~/.ghost</code>{" "}
                  folder){testnet ? ", or make a free testnet account" : ""}.
                </p>
              </Step>
              <Step n={4} title="Make your keys">
                <p>
                  <code>ghost init</code> creates your spend and viewing keys in{" "}
                  <code>~/.ghost</code>. That file is your keys: back it up.
                </p>
              </Step>
              <Step n={5} title="Publish the public half, once">
                <p>
                  <code>ghost register</code>: one NEAR transaction from your own account. From then
                  on the pay page shows you as <b>Ready</b>.
                </p>
              </Step>
              <Step n={6} title="Open your app">
                <p>
                  <code>ghost serve</code> starts your own app on your computer, to see and withdraw
                  your payments (below).
                </p>
              </Step>
            </ol>
            <SetupBox cfg={cfg} />
          </Section>

          {/* ---------------------------------------------------------------- 4. finding */}
          <Section
            id="finding"
            n={4}
            title="Receiving: finding your payments"
            sub="In your own app, on your own computer."
          >
            <ol className="steps">
              <Step n={1} title="Open your app">
                <p>
                  Run the <code>ghost serve</code> command from the setup guide. It prints a line
                  like <code>open http://127.0.0.1:8788/?token=…</code>: open that full address in
                  your browser. The app runs only on your computer, and the token in the address is
                  what lets that tab scan and withdraw; other websites and programs can't.
                </p>
              </Step>
              <Step n={2} title="It reads every note">
                <p>
                  The app downloads all the notes on the contract's notice board, everyone's, so
                  even the NEAR server it asks cannot tell which ones are yours.
                </p>
              </Step>
              <Step n={3} title="Your viewing key picks out yours">
                <p>
                  For each note it does a quick test with your viewing key. The 1-byte tag lets it
                  skip almost all notes meant for others (255 out of 256) without further work. For
                  the rest it decrypts the note; a note that doesn't decrypt is not yours.
                </p>
              </Step>
              <Step n={4} title="Your Inbox lists them">
                <p>
                  For each payment it rebuilds the one-time address and reads its balance on{" "}
                  {chainName}. <b>Inbox</b> shows the amount, the decrypted note and the total ready
                  to withdraw. While it is open it checks again about every 10 seconds, so a new
                  payment appears without a click.
                </p>
              </Step>
            </ol>
            <Note title="Why this website can never show your money.">
              Each payment sits at its own new address, and only your viewing key can tell which
              addresses are yours. That key never leaves your computer, so no public page, this one
              included, can list your payments. That is the privacy working, not a missing feature.
            </Note>
            <More
              label="Can my accountant see my payments without being able to spend them?"
              data-testid="more-viewing"
            >
              <p>
                Yes. <code>ghost export-viewing-key</code> writes a viewing-key file. Opened in the
                app's <b>Accountant</b> page (or with <code>ghost scan --viewing-key</code>), it
                lists every payment and its note and can download a CSV, but it cannot withdraw: it
                has the viewing key and only the public half of the spend key.
              </p>
            </More>
            <More label="For the technically curious: the scan" data-testid="more-scan">
              <pre className="code">
                {`for each note (chain, E, tag, ct):
  S' = X25519(k_view, E)
  skip unless view-tag(S') == tag
  skip unless ct decrypts with HKDF(S', "memo")
    // drops the 1-in-256 false matches
  rebuild h, K, path, A  → a payment
  read A's balance`}
              </pre>
              <p>
                The balance lookups go to the {chainName} RPC, which therefore sees the set of your
                one-time addresses together (see "What's public" below).
              </p>
            </More>
          </Section>

          {/* ---------------------------------------------------------------- 5. withdrawing */}
          <Section
            id="withdrawing"
            n={5}
            title="Withdrawing"
            sub="From your Inbox to any wallet, without a key for the one-time address."
          >
            <ol className="steps">
              <Step n={1} title="Press Withdraw on a payment">
                <p>
                  Pick where the money should go. <b>Use my wallet's address</b> opens your wallet's
                  account picker; nothing is signed, it only reads the address. Or paste any{" "}
                  {chainName} address. Use a different address each time, so your payments can't be
                  linked together.
                </p>
              </Step>
              <Step n={2} title="Your app approves it with that payment's own key">
                <p>
                  On your computer, the app works out the private key of this one payment and signs
                  a withdrawal message. The destination, the payment's path and an expiry (about 10
                  minutes) are inside it. The {chainName} network fee is paid from the payment
                  itself.
                </p>
              </Step>
              <Step n={3} title="The relayer hands it to the contract">
                <p>
                  The relayer submits the message to the contract from its own NEAR account, so your
                  NEAR account does not appear and you need no NEAR to withdraw.
                </p>
              </Step>
              <Step n={4} title="The contract checks the signature">
                <p>
                  It accepts only a message signed by the key behind that exact payment, for that
                  exact path, that has not expired. Then it asks the MPC network to sign.
                </p>
              </Step>
              <Step n={5} title="NEAR Chain Signatures signs the transfer">
                <p>
                  The MPC network signs the {chainName} transfer for the one-time address, and your
                  app sends it. Usually 5 to 30 seconds in total.
                </p>
              </Step>
              <Step n={6} title="The money arrives">
                <p>
                  You see the amount arrive at your address, with its balance before and after. The
                  amount is the payment minus the {chainName} network fee: in a test on 2026-11-13,
                  0.000999 of 0.001 {sym} arrived.
                </p>
              </Step>
            </ol>
            <Note tone="good" title="Why the relayer can't redirect it.">
              The destination is inside the message your key signed. Changing it would break the
              signature, and the contract re-checks the signature itself. The most a relayer can do
              is refuse or delay.
            </Note>
            <More label="For the technically curious: the sweep" data-testid="more-sweep">
              <pre className="code">
                {`d_K     = d_spend + h       // never stored
payload = hash of the transfer A → destination
msg     = sha256("ghost-paths/v1/sweep"
            || contract || path || domain
            || expires_block || 1 || len || payload)
sig, v  = ECDSA(msg, d_K)
          // expires_block = now + 600 blocks
relayer  → ${cfg.contract}.sweep(
             path, domain, [payload],
             expires_block, K, sig, v)
contract:  not expired
           path == "gp1/" + sha256(K)
           ecrecover(msg, sig, v) == K
contract → ${signer}.sign(payload, path)
app      → broadcasts the signed transfer`}
              </pre>
              <p>
                Only the contract, as the predecessor, can get a signature for{" "}
                <code>derive(contract, path)</code>, and it asks only for a valid signature by that
                payment's key. On NEAR, the record shows the relayer and the contract requesting a
                signature for an opaque path; nothing names the recipient. The app refuses to
                withdraw if the network fee is more than 20% of the amount. A signed request can be
                replayed until it expires, which is harmless: it would sign the same transfer again,
                and {chainName}'s nonce prevents paying twice.
              </p>
            </More>
          </Section>

          {/* ---------------------------------------------------------------- 6. privacy */}
          <Section
            id="privacy"
            n={6}
            title="What's public, what's private"
            sub="Ghost Paths hides who was paid. It does not hide that a payment happened, or how much."
          >
            <div className="compare" data-testid="privacy-table">
              <div className="priv">
                <h3>
                  <EyeOff size={16} /> Hidden
                </h3>
                <ul>
                  <li>
                    Which person a one-time address belongs to, before and after the withdrawal.
                  </li>
                  <li>Who a note is for: it has no recipient field.</li>
                  <li>A recipient's total income: their addresses are unrelated to each other.</li>
                  <li>
                    At withdrawal, the recipient's NEAR account: the relayer submits it, and the
                    request carries only an opaque path.
                  </li>
                  <li>What the note says: amount and message are encrypted for the recipient.</li>
                </ul>
              </div>
              <div>
                <h3>
                  <Eye size={16} /> Not hidden
                </h3>
                <ul>
                  <li>That an account uses Ghost Paths, and when it registered.</li>
                  <li>Amounts, times, and the payer's {chainName} address.</li>
                  <li>
                    Timing: a note appears seconds after its payment, so an observer can often pair
                    them (which still doesn't say who was paid).
                  </li>
                  <li>Who posted each note: here, the relayer.</li>
                  <li>
                    The withdrawal transfer itself. Withdrawing to a wallet already known to be
                    yours links that payment to you; two payments withdrawn to one address are
                    linked to each other.
                  </li>
                  <li>
                    The payer knows the one-time address, so they can see where the money goes when
                    you withdraw it.
                  </li>
                  <li>
                    The 1-byte tag. With very few registered accounts, as on testnet today, it can
                    narrow down or even reveal the recipient.
                  </li>
                  <li>
                    The {chainName} RPC your app asks for balances sees which addresses you check,
                    together, and your IP address.
                  </li>
                  <li>The length of the encrypted note.</li>
                </ul>
              </div>
            </div>
            <More label="What you have to trust" data-testid="more-trust">
              <ul className="plain">
                <li>
                  <b>The MPC network.</b> If a supermajority of its nodes colluded, they could sign
                  for any address it derives. Ghost Paths adds no trust beyond that, and removes
                  none.
                </li>
                <li>
                  <b>The contract account.</b> The contract has no owner and no upgrade method, but
                  during the hackathon its testnet account kept one full-access key for fixes, which
                  could redeploy it. The README's{" "}
                  <a href={`${REPO}#testnet-deployment`} {...ext}>
                    Testnet deployment
                  </a>{" "}
                  section says whether that key has been deleted.
                </li>
                <li>
                  <b>The relayer</b> can refuse, delay, log requests and see IP addresses. It cannot
                  take or redirect money.
                </li>
                <li>
                  <b>No audit.</b> The cryptography uses standard libraries and is cross-checked by
                  tests against an independent implementation, not by a cryptographer. This is a
                  protocol demonstration on testnet, not an audited product.
                </li>
              </ul>
              <p>
                The full analysis:{" "}
                <a href={doc("docs/THREAT-MODEL.md")} {...ext}>
                  docs/THREAT-MODEL.md
                </a>
                .
              </p>
            </More>
          </Section>

          {/* ---------------------------------------------------------------- 7. check */}
          <Section
            id="check"
            n={7}
            title="Check it yourself"
            sub="After you pay, three checks on public explorers, without trusting us."
          >
            <ol className="steps" data-testid="checks">
              <Step n={1} title={`The ${chainName} payment went to a brand-new address`}>
                <p>
                  On the receipt, <b>View on explorer</b> opens the one-time address. It has no
                  history before your payment.
                </p>
              </Step>
              <Step n={2} title="The NEAR note names no one">
                <p>
                  Under <b>Technical details</b>, open the <b>Note on NEAR</b> transaction. It was
                  sent by the relayer's account, not yours, and its arguments are a one-time key, a
                  tag and a ciphertext: no recipient.
                </p>
              </Step>
              <Step n={3} title="The recipient's account shows nothing new">
                <p>
                  {cfg.defaultRecipient ? (
                    <>
                      Open{" "}
                      <a href={nearAccountUrl(cfg, cfg.defaultRecipient)} {...ext}>
                        {cfg.defaultRecipient} on the NEAR explorer
                      </a>
                      .
                    </>
                  ) : (
                    "Open the recipient's NEAR account on the NEAR explorer."
                  )}{" "}
                  It shows only its own setup, however many people paid it.
                </p>
              </Step>
            </ol>
            <p className="hint">
              The other side, finding and withdrawing the payment, needs the recipient's keys, which
              by design never leave their computer. The demo video shows it;{" "}
              <code>make two-party</code> in the source code runs both sides on one machine. The
              contract's own page: {contractLink}.
            </p>
          </Section>

          {/* ---------------------------------------------------------------- 8. faq */}
          <Section id="faq" n={8} title="Questions" className="faq">
            <div className="stack" style={{ gap: 4 }}>
              <More label="What does it cost?" data-testid="faq-cost">
                <p>
                  {testnet ? "Nothing real: everything here uses free test coins. " : ""}
                  The payer pays the usual {chainName} fee for one transfer and needs no NEAR. The
                  relayer pays for posting the note on NEAR (a few thousandths of a NEAR each). The
                  recipient pays about 0.0016 NEAR once, to publish their keys; a withdrawal costs
                  them only the {chainName} fee, taken from the payment.
                </p>
              </More>
              <More label="What if I lose my keys?" data-testid="faq-keys">
                <p>
                  There is no recovery. Your keys file in <code>~/.ghost</code> is the only thing
                  that can find and withdraw your payments: back it up somewhere safe and private. A
                  viewing key file can still list payments but can never withdraw them.
                </p>
              </More>
              <More label="Can the relayer steal my money?" data-testid="faq-steal">
                <p>
                  No. It never holds your money or your keys. A withdrawal's destination is inside
                  the message your key signed, and the contract checks that signature. A relayer can
                  only refuse or delay.
                </p>
              </More>
              <More label="What if the relayer is down?" data-testid="faq-down">
                <p>
                  <b>Paying:</b> the pay page posts the note after your payment confirms. If the
                  relayer doesn't answer, the page says so: the money is safe at the one-time
                  address, and <b>Post the note again</b> retries. Keep that page open until the
                  note is posted: the recipient needs the note to find the payment.
                </p>
                <p>
                  <b>Withdrawing:</b> under <b>Privacy options</b>, choose{" "}
                  <b>From my NEAR account</b>. It works without the relayer, but it uses your own
                  NEAR account, so anyone reading NEAR can see that this withdrawal was yours.
                </p>
              </More>
              <More
                label="I typed a name that isn't set up. Did I just lose money?"
                data-testid="faq-unset"
              >
                <p>
                  No: the pay page won't send. The Send button stays off until the name shows{" "}
                  <b>Ready</b>, and it checks again right before paying. Instead it offers a message
                  you can send them and a link to their setup guide.
                </p>
              </More>
              <More label="Which blockchains?" data-testid="faq-chains">
                <p>
                  This website pays on {chainName}. The command-line tool also pays and withdraws on
                  Solana devnet (and local test chains), and is configured for Base Sepolia. Bitcoin
                  testnet addresses are derived and match the MPC network, but no Bitcoin payment
                  has been made yet. One NEAR name covers all of them.
                </p>
              </More>
              <More label="Is this on mainnet?" data-testid="faq-mainnet">
                <p>
                  Not yet. Everything runs on NEAR testnet and test chains; no mainnet contract is
                  deployed.
                </p>
              </More>
              <More label="Why NEAR?" data-testid="faq-why-near">
                <p>
                  Chain Signatures makes it possible: anyone can work out the address for "this
                  contract plus this path", but only the contract can get a signature for it. So the
                  payer can compute a fresh address alone, and only the recipient, through the
                  contract, can move the money out, on several chains, with one NEAR name and no
                  chain-specific keys.
                </p>
              </More>
              <More label="Is the code open?" data-testid="faq-source">
                <p>
                  Yes, MIT licensed:{" "}
                  <a href={REPO} {...ext}>
                    github.com/AaroneGeorge/near-ghost-paths
                  </a>
                  . The protocol is in{" "}
                  <a href={doc("docs/SPEC.md")} {...ext}>
                    docs/SPEC.md
                  </a>
                  , the limits in{" "}
                  <a href={doc("docs/THREAT-MODEL.md")} {...ext}>
                    docs/THREAT-MODEL.md
                  </a>
                  .
                </p>
              </More>
            </div>
          </Section>

          <div className="row guide-next">
            <a className="btn primary" href="./pay.html" data-testid="cta-pay">
              <Send size={16} /> Pay someone privately
            </a>
            <a className="btn" href="./receive.html" data-testid="cta-receive">
              <Laptop size={16} /> Set up to receive
            </a>
          </div>
        </div>
      </main>

      <footer className="foot">
        <span>This page holds no keys and needs no wallet. It only explains.</span>
        <span>
          <a href="./pay.html">Pay someone</a>
          {" · "}
          <a href="./receive.html">Set up to receive</a>
          {" · "}
          <a href={nearAccountUrl(cfg, cfg.contract)} {...ext}>
            View the contract
          </a>
          {" · "}
          <a href={REPO} {...ext}>
            Source code
          </a>
        </span>
      </footer>
    </div>
  );
}

function Section({
  id,
  n,
  title,
  sub,
  className = "",
  children,
}: {
  id: string;
  n: number;
  title: string;
  sub?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Panel id={id} className={`guide-sec ${className}`} data-testid={`sec-${id}`}>
      <div className="panel-head">
        <div>
          <h2 className="sec-title">
            <span className="sec-n">{n}</span>
            {title}
          </h2>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      <div className="stack" style={{ gap: 16 }}>
        {children}
      </div>
    </Panel>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="n">{n}</span>
      <div className="body">
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  );
}

function Actor({
  icon,
  name,
  holds,
  children,
}: { icon: ReactNode; name: string; holds: string; children: ReactNode }) {
  return (
    <li>
      <span className="ico">{icon}</span>
      <div className="body">
        <h3>{name}</h3>
        <p>{children}</p>
        <p className="holds">
          <KeyRound size={14} />
          <span>
            <b>Holds:</b> {holds}
          </span>
        </p>
      </div>
    </li>
  );
}

/** Where each thing happens: three places on top, the target chain underneath, numbered in order. */
function PlaceMap({
  cfg,
  chainName,
  signer,
}: { cfg: PayConfig; chainName: string; signer: string }) {
  return (
    <figure className="map" data-testid="map">
      <div className="place">
        <div className="place-h">
          <Wallet size={16} /> Payer's browser
        </div>
        <ol>
          <Ev n={1}>Looks up the name's public keys on NEAR</Ev>
          <Ev n={2}>Works out a brand-new address</Ev>
          <Ev n={3}>The wallet pays it on {chainName}</Ev>
          <Ev n={4}>Sends the encrypted note to the relayer</Ev>
        </ol>
      </div>
      <div className="place near">
        <div className="place-h">
          <ScrollText size={16} /> NEAR {cfg.network}
        </div>
        <div className="box">
          <b>Relayer</b>
          <span>posts notes (4) and withdrawals (6) from its own account</span>
        </div>
        <div className="box">
          <b>Ghost Paths contract</b>
          <span className="mono">{cfg.contract}</span>
          <span>phone book · notice board · withdrawal gate (6)</span>
        </div>
        <div className="box">
          <b>MPC network</b>
          <span className="mono">{signer}</span>
          <span>signs the transfer, only when the contract asks (7)</span>
        </div>
      </div>
      <div className="place">
        <div className="place-h">
          <Laptop size={16} /> Recipient's computer
        </div>
        <ol>
          <Ev n={5}>Reads every note; the viewing key finds theirs</Ev>
          <Ev n={6}>Signs a withdrawal with that payment's own key</Ev>
        </ol>
      </div>
      <div className="place chain">
        <div className="place-h">
          <Ghost size={16} /> {chainName}
        </div>
        <div className="lane">
          <span className="pill">payer's address</span>
          <ArrowRight size={16} aria-hidden="true" />
          <span className="pill ghost">one-time address (3)</span>
          <ArrowRight size={16} aria-hidden="true" />
          <span className="pill">recipient's wallet (7)</span>
        </div>
      </div>
      <figcaption className="hint">
        Numbers follow the order of events. Only the recipient's computer holds a key that can move
        the money, and it never leaves that computer.
      </figcaption>
    </figure>
  );
}

function Ev({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li>
      <span className="ev">{n}</span>
      <span>{children}</span>
    </li>
  );
}

/** Type your name → your own filled-in setup guide (receive.html), so the commands live in one place. */
function SetupBox({ cfg }: { cfg: PayConfig }) {
  const [input, setInput] = useState("");
  const account = (() => {
    const t = input.trim().toLowerCase();
    try {
      return t ? parseHandle(t) : "";
    } catch {
      return t;
    }
  })();
  const valid = isAccountId(account);
  const name = valid ? account : placeholderAccount(cfg.network);
  const href = receiveUrl(window.location.href, valid ? account : undefined);
  const cmds = setupCommands(cfg, name);
  return (
    <div className="stack setup-box" style={{ gap: 12 }} data-testid="setup-box">
      <Field
        label="Your NEAR account"
        htmlFor="how-account"
        hint={
          account && !valid
            ? `That isn't a NEAR account name. It looks like ${placeholderAccount(cfg.network)}.`
            : "The setup guide fills in every command for this name and checks live whether you're set up."
        }
      >
        <input
          id="how-account"
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholderAccount(cfg.network)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          data-testid="how-account"
        />
      </Field>
      <div className="row">
        <a className="btn primary" href={href} data-testid="how-setup-link">
          <BookOpen size={16} />
          {valid ? `Open the setup guide for ${account}` : "Open the setup guide"}
          <ArrowRight size={16} />
        </a>
      </div>
      <More
        label="For the technically curious: the three commands that matter"
        data-testid="more-cmds"
      >
        <p>
          From the setup guide, for <code>{name}</code> (run in the downloaded folder, after step
          3):
        </p>
        <pre className="code" data-testid="how-cmds">
          {`${cmds.init}\n${cmds.register}\n${cmds.serve}`}
        </pre>
      </More>
    </div>
  );
}
