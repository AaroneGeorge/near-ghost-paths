/** QR codes for payment links (the library is `uqr`: no dependencies, no network). */
import { renderSVG, renderUnicodeCompact } from "uqr";

/** An SVG string for a web page. Error correction M survives a scuffed print or a screen glare. */
export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: "M", border: 2, whiteColor: "#fff", blackColor: "#000" });
}

/**
 * Two QR rows per terminal line. A phone wants dark modules on a light field: on the usual dark
 * terminal that means drawing the field with the light glyph (the default); pass `light: true` on a
 * light terminal theme.
 */
export function qrTerminal(text: string, opts: { light?: boolean } = {}): string {
  return renderUnicodeCompact(text, { ecc: "M", border: 2, invert: !!opts.light });
}
