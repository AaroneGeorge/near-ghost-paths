/**
 * Payment links: one static URL per purpose (`pay.html?to=bob.testnet&ref=freelance&amount=0.05`).
 *
 * A link only pre-fills the pay page; it carries no key and no address, and every payment made
 * through it still lands at a fresh one-time address. `ref` is a short label for the link ("freelance",
 * "invoice-42"): the payer's client copies it into the encrypted memo, so the recipient can tell which
 * link a payment came through and the chain still shows nothing (docs/SPEC.md §5). It is payer-supplied,
 * so a recipient must treat it as a hint, not as proof.
 */

/** A link label: 1 to 32 characters, letters, digits, `.`, `_`, `-`, starting with a letter or digit. */
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Longest `note` a link may pre-fill (the memo itself caps the total size). */
export const MAX_LINK_NOTE = 140;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;

/** Returns the label, or throws. `undefined` and "" mean "no label". */
export function parseRef(s: string | undefined | null): string | undefined {
  const t = (s ?? "").trim();
  if (!t) return undefined;
  if (!REF_RE.test(t))
    throw new Error(
      "label: 1 to 32 characters, letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
  return t;
}

/** Same as {@link parseRef} for untrusted input (a link, a decrypted memo): a bad label is dropped. */
export function cleanRef(s: unknown): string | undefined {
  return typeof s === "string" && REF_RE.test(s) ? s : undefined;
}

export interface PayLink {
  /** The recipient's NEAR account. */
  to: string;
  /** Decimal amount in the chain's native unit, pre-filled and editable by the payer. */
  amount?: string;
  /** Pre-filled note for the payer to send along (encrypted to the recipient). */
  note?: string;
  /** The link's label. */
  ref?: string;
}

/**
 * `base` is any URL of the pay page (or a sibling page, such as the receive page's own address):
 * the link is `pay.html` next to it. Query parameters on `base` are dropped.
 */
export function buildPayLink(base: string, link: PayLink): string {
  if (!link.to) throw new Error("payment link: the recipient account is required");
  const u = new URL("pay.html", base);
  const q = new URLSearchParams({ to: link.to });
  const ref = parseRef(link.ref);
  if (ref) q.set("ref", ref);
  if (link.amount !== undefined && link.amount !== "") {
    if (!AMOUNT_RE.test(link.amount)) throw new Error(`payment link: bad amount "${link.amount}"`);
    q.set("amount", link.amount);
  }
  const note = link.note?.trim();
  if (note) {
    if (note.length > MAX_LINK_NOTE)
      throw new Error(`payment link: note longer than ${MAX_LINK_NOTE} characters`);
    q.set("note", note);
  }
  u.search = q.toString();
  u.hash = "";
  return u.href;
}

/**
 * Reads a link's query string. Never throws: this is untrusted input from whoever made the link, so
 * every field that does not validate is left out (the page then asks the payer instead).
 */
export function parsePayLink(search: string): Partial<PayLink> {
  const q = new URLSearchParams(search);
  const out: Partial<PayLink> = {};
  const to = q.get("to")?.trim();
  if (to) out.to = to;
  const amount = q.get("amount")?.trim();
  if (amount && AMOUNT_RE.test(amount)) out.amount = amount;
  const note = q.get("note")?.trim();
  if (note && note.length <= MAX_LINK_NOTE) out.note = note;
  const ref = cleanRef(q.get("ref")?.trim());
  if (ref) out.ref = ref;
  return out;
}
