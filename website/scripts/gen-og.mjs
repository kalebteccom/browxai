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

  <!-- browxai mark -->
  <g transform="translate(86,70) scale(0.708)">
    <path d="M15.2 56.8A34 34 0 0 1 56.8 15.2" stroke="${lime}" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M80.8 39.2A34 34 0 0 1 39.2 80.8" stroke="${lime}" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M31 64L34.4 39.4L67.8 27.2L55.6 60.6Z" fill="${lime}"/>
  </g>

  <text x="86" y="300" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="150" letter-spacing="-6" fill="#e6e8ea">brow<tspan fill="${lime}">x</tspan>ai</text>

  <text x="90" y="372" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="40" fill="#9aa0a6">A browser, built for agents.</text>

  <text x="90" y="170" font-family="Courier New, monospace" font-weight="700" font-size="24" letter-spacing="6" fill="${lime}">MCP-NATIVE BROWSER CONTROL</text>

  <text x="90" y="560" font-family="Courier New, monospace" font-size="26" fill="#6b7280">browxai.com</text>
  <text x="1110" y="560" text-anchor="end" font-family="Courier New, monospace" font-size="26" fill="#6b7280">MIT licensed</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
