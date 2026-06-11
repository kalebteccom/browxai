// Generates the social-share card at public/og.png (1200x630).
// Hand-built SVG rasterized with sharp. Re-run after a brand change:
//   node scripts/gen-og.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "og.png");

const violet = "#a855f7";
const pink = "#ec4899";
const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g1" cx="0.13" cy="0" r="0.75">
      <stop offset="0" stop-color="${violet}" stop-opacity="0.32"/>
      <stop offset="1" stop-color="${violet}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="0.9" cy="0.04" r="0.6">
      <stop offset="0" stop-color="${pink}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${pink}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#0c0a14"/>
  <rect width="1200" height="630" fill="url(#g1)"/>
  <rect width="1200" height="630" fill="url(#g2)"/>
  ${Array.from({ length: 13 }, (_, i) => `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="630" stroke="${violet}" stroke-opacity="0.05"/>`).join("")}
  ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${i * 100}" x2="1200" y2="${i * 100}" stroke="${violet}" stroke-opacity="0.05"/>`).join("")}

  <!-- browxai mark (white) -->
  <g transform="translate(86,70) scale(0.708)" stroke="#FAFAF7" fill="#FAFAF7">
    <path d="M15.2 56.8A34 34 0 0 1 56.8 15.2" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M80.8 39.2A34 34 0 0 1 39.2 80.8" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M31 64L34.4 39.4L67.8 27.2L55.6 60.6Z" stroke="none"/>
  </g>

  <text x="86" y="300" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="150" letter-spacing="-6" fill="#f4f1fa">brow<tspan fill="${violet}">x</tspan>ai</text>

  <text x="90" y="372" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="40" fill="#a99fc0">A browser, built for agents.</text>

  <text x="90" y="170" font-family="Courier New, monospace" font-weight="700" font-size="24" letter-spacing="6" fill="${violet}">MCP-NATIVE BROWSER CONTROL</text>

  <text x="90" y="560" font-family="Courier New, monospace" font-size="26" fill="#736b85">browxai.com</text>
  <text x="1110" y="560" text-anchor="end" font-family="Courier New, monospace" font-size="26" fill="#736b85">MIT licensed</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
