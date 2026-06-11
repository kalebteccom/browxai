// Generates the social-share card at public/og.png (1200x630).
// Hand-built SVG rasterized with sharp. Re-run after a brand change:
//   node scripts/gen-og.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "og.png");

const lime = "#b5f23d";
const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${lime}" stop-opacity="0.16"/>
      <stop offset="0.6" stop-color="${lime}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#0a0b0d"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  ${Array.from({ length: 13 }, (_, i) => `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="630" stroke="${lime}" stroke-opacity="0.05"/>`).join("")}
  ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${i * 100}" x2="1200" y2="${i * 100}" stroke="${lime}" stroke-opacity="0.05"/>`).join("")}

  <!-- reticle mark -->
  <g transform="translate(86,78)">
    <rect x="1.5" y="2" width="58" height="54" rx="12" stroke="#e6e8ea" stroke-width="3.5" fill="none"/>
    <path d="M1.5 16H59.5" stroke="#e6e8ea" stroke-width="3.5"/>
    <circle cx="13" cy="9" r="2.4" fill="#e6e8ea"/>
    <circle cx="21" cy="9" r="2.4" fill="#e6e8ea"/>
    <circle cx="34" cy="38" r="10" stroke="${lime}" stroke-width="3.5" fill="none"/>
    <path d="M34 22V27M34 49V54M18 38H23M45 38H50" stroke="${lime}" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="34" cy="38" r="3" fill="${lime}"/>
  </g>

  <text x="86" y="300" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="150" letter-spacing="-6" fill="#e6e8ea">brow<tspan fill="${lime}">x</tspan>ai</text>

  <text x="90" y="372" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="40" fill="#9aa0a6">A browser, built for agents.</text>

  <text x="90" y="170" font-family="Courier New, monospace" font-weight="700" font-size="24" letter-spacing="6" fill="${lime}">MCP-NATIVE BROWSER CONTROL</text>

  <text x="90" y="560" font-family="Courier New, monospace" font-size="26" fill="#6b7280">browxai.com</text>
  <text x="1110" y="560" text-anchor="end" font-family="Courier New, monospace" font-size="26" fill="#6b7280">MIT licensed</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
