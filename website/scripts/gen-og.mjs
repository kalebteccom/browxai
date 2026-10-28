// Generates the social-share card at public/og.png (1200x630).
// A flat SVG rasterized with sharp: one solid canvas, no gradients, glow or
// grid. Colours are the site tokens in src/styles/brand-tokens.css. Re-run
// after a brand change:
//   node scripts/gen-og.mjs
//
// The wordmark is Poppins 700 outlines (150px, letter-spacing -0.04em),
// baked in as paths so the render does not depend on an installed font. Body
// text uses the system stack's Helvetica Neue / Arial fallback.
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "og.png");

// Site tokens, dark theme.
const bg = "#0c0a14"; // --sl-color-bg
const accent = "#c084fc"; // --browx-violet-400, accent text on dark (7.4:1)
const text = "#faf8ff"; // --browx-on-accent (18.7:1)
const body = "#c0c2c7"; // --sl-color-gray-2 (11:1)
const muted = "#888b96"; // --sl-color-gray-3 (5.8:1)

const font = 'font-family="Helvetica Neue, Helvetica, Arial, sans-serif"';
const wordmarkRest =
  "M146.8 215.1Q157.1 215.1 165.5 220.4Q173.9 225.6 178.8 235.4Q183.6 245.1 183.6 258Q183.6 270.9 178.8 280.7Q173.9 290.6 165.5 295.9Q157.1 301.2 146.8 301.2Q137.9 301.2 131.3 297.7Q124.7 294.1 120.9 288.3V300H95.3V189H120.9V228.2Q124.5 222.3 131.3 218.7Q138.1 215.1 146.8 215.1ZM139.1 237.4Q131.4 237.4 126.1 243Q120.8 248.6 120.8 258.1Q120.8 267.8 126.1 273.3Q131.4 278.9 139.1 278.9Q146.8 278.9 152.2 273.2Q157.6 267.6 157.6 258Q157.6 248.4 152.2 242.9Q146.9 237.4 139.1 237.4Z M243 215.4V242.6H236Q226.4 242.6 221.6 246.7Q216.8 250.8 216.8 261.1V300H191.2V216.3H216.8V230.2Q221.3 223.4 228 219.4Q234.8 215.4 243 215.4Z M244.2 258.1Q244.2 245.2 249.9 235.4Q255.7 225.6 265.6 220.4Q275.4 215.1 287.8 215.1Q300.1 215.1 310 220.4Q319.9 225.6 325.6 235.4Q331.2 245.2 331.2 258.1Q331.2 271.1 325.5 280.9Q319.7 290.7 309.7 295.9Q299.8 301.2 287.4 301.2Q275.2 301.2 265.3 295.9Q255.5 290.7 249.9 280.9Q244.2 271.2 244.2 258.1ZM305.1 258.1Q305.1 248.1 300.1 242.7Q295.1 237.3 287.8 237.3Q280.2 237.3 275.3 242.6Q270.4 247.9 270.4 258.1Q270.4 268.2 275.2 273.6Q280.1 279 287.4 279Q294.8 279 300 273.6Q305.1 268.2 305.1 258.1Z M459.1 216.3 436.4 300H408.1L394.9 245.7L381.2 300H353L330.2 216.3H355.9L367.7 276.1L381.8 216.3H409L423.2 275.9L434.9 216.3Z M576.8 215.1Q585.7 215.1 592.3 218.7Q599 222.3 602.6 228.2V216.3H628.2V300H602.6V288.1Q598.9 294 592.2 297.6Q585.5 301.2 576.7 301.2Q566.5 301.2 558.1 295.9Q549.7 290.6 544.8 280.7Q539.9 270.9 539.9 258Q539.9 245.1 544.8 235.4Q549.7 225.6 558.1 220.4Q566.5 215.1 576.8 215.1ZM584.3 237.4Q576.7 237.4 571.3 242.9Q566 248.4 566 258Q566 267.6 571.3 273.2Q576.7 278.9 584.3 278.9Q592 278.9 597.3 273.3Q602.6 267.8 602.6 258.1Q602.6 248.6 597.3 243Q592 237.4 584.3 237.4Z M638.5 193.8Q638.5 187.8 642.7 183.8Q647 179.9 653.8 179.9Q660.4 179.9 664.6 183.8Q668.9 187.8 668.9 193.8Q668.9 199.7 664.6 203.6Q660.4 207.6 653.8 207.6Q647 207.6 642.7 203.6Q638.5 199.7 638.5 193.8ZM666.5 216.3V300H640.9V216.3Z";
const wordmarkX =
  "M512.3 300 496.2 276.8 482.8 300H455L482.6 257.2L454.2 216.3H483.1L499.1 239.4L512.6 216.3H540.4L512.3 258.4L541.1 300Z";

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${bg}"/>

  <!-- browxai mark (white, as shipped in brand/browxai-mark-white.svg) -->
  <g transform="translate(86,70) scale(0.708)" stroke="#FAFAF7" fill="#FAFAF7">
    <path d="M15.2 56.8A34 34 0 0 1 56.8 15.2" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M80.8 39.2A34 34 0 0 1 39.2 80.8" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M31 64L34.4 39.4L67.8 27.2L55.6 60.6Z" stroke="none"/>
  </g>

  <text x="90" y="170" ${font} font-weight="700" font-size="28" fill="${accent}">Open source MCP server</text>

  <path d="${wordmarkRest}" fill="${text}"/>
  <path d="${wordmarkX}" fill="${accent}"/>

  <text x="90" y="372" ${font} font-weight="400" font-size="40" fill="${body}">A browser, built for agents.</text>

  <text x="90" y="560" ${font} font-size="26" fill="${muted}">browxai.com</text>
  <text x="1110" y="560" text-anchor="end" ${font} font-size="26" fill="${muted}">MIT licensed</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
