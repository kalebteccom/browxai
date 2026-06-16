// `canvas` — a canvas app surface. Draws a known scene (so canvas_capture /
// canvas_diff have stable pixels), exposes a world<->screen transform on a global
// (so canvas_world_to_screen / canvas_screen_to_world can discover it), and
// records pointer programs (so gesture_chain strokes land).
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const canvas: Surface = {
  id: "canvas",
  path: "/canvas",
  title: "Canvas surface",
  blurb: "canvas scene + world/screen transform global + pointer-stroke recorder",
  html: () =>
    doc(
      "Canvas surface",
      `
<section class="card">
  <canvas id="stage" data-testid="canvas-stage" width="400" height="300" style="border:1px solid #888"></canvas>
  <button id="recolor" data-testid="recolor">recolor scene</button>
  <pre id="c-out" data-testid="canvas-out"></pre>
</section>
`,
      {
        surfaceId: "canvas",
        script: `
const cv = document.getElementById('stage');
const ctx = cv.getContext('2d');
let hue = 200;
function draw() {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 300);
  ctx.fillStyle = 'hsl(' + hue + ',70%,50%)';
  ctx.fillRect(50, 50, 120, 80);
  ctx.fillStyle = '#222';
  ctx.fillText('canvas-scene', 60, 200);
}
draw();
document.getElementById('recolor').addEventListener('click', () => { hue = (hue + 60) % 360; draw(); });

// A discoverable affine transform (zoom + pan), the kind canvas apps expose.
window.__canvasApp = {
  camera: { x: 0, y: 0, zoom: 1 },
  worldToScreen(p) { return { x: (p.x - this.camera.x) * this.camera.zoom, y: (p.y - this.camera.y) * this.camera.zoom }; },
  screenToWorld(p) { return { x: p.x / this.camera.zoom + this.camera.x, y: p.y / this.camera.zoom + this.camera.y }; },
};

// Record pointer strokes (gesture_chain target).
const out = document.getElementById('c-out');
const stroke = [];
cv.addEventListener('pointerdown', () => { stroke.length = 0; });
cv.addEventListener('pointermove', (e) => { if (e.buttons) stroke.push([Math.round(e.offsetX), Math.round(e.offsetY)]); });
cv.addEventListener('pointerup', () => { out.textContent = 'stroke points:' + stroke.length; window.__lastStroke = stroke.slice(); });
`,
      },
    ),
};
