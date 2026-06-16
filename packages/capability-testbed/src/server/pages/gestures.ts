// `gestures` — pointer/touch playground. Exercises drag, double_click, mouse_*,
// touch_*, gesture_pinch, gesture_swipe. A draggable chip + drop target, a
// double-click counter, and a touch log.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const gestures: Surface = {
  id: "gestures",
  path: "/gestures",
  title: "Gestures surface",
  blurb: "drag-drop, double-click, mouse + touch + pinch/swipe logging",
  html: () =>
    doc(
      "Gestures surface",
      `
<section class="card">
  <div id="chip" data-testid="drag-chip" draggable="true" style="width:80px;padding:.5rem;background:#0b6;color:#fff">drag me</div>
  <div id="target" data-testid="drop-target" style="margin-top:1rem;height:80px;border:2px dashed #888">drop target</div>
  <output id="drop-out" data-status data-testid="drop-out">empty</output>
</section>

<section class="card">
  <button id="dbl" data-testid="dbl-btn">double-click me</button>
  <output id="dbl-out" data-status data-testid="dbl-out">0</output>
</section>

<section class="card">
  <div id="touchpad" data-testid="touchpad" style="height:160px;border:1px solid #888;touch-action:none">touch / pinch / swipe here</div>
  <pre id="touch-out" data-testid="touch-out"></pre>
</section>
`,
      {
        surfaceId: "gestures",
        script: `
const chip = document.getElementById('chip');
const target = document.getElementById('target');
chip.addEventListener('dragstart', (e) => e.dataTransfer.setData('text', 'chip'));
target.addEventListener('dragover', (e) => e.preventDefault());
target.addEventListener('drop', (e) => { e.preventDefault(); document.getElementById('drop-out').textContent = 'dropped:' + e.dataTransfer.getData('text'); });

let dbl = 0;
document.getElementById('dbl').addEventListener('dblclick', () => { document.getElementById('dbl-out').textContent = String(++dbl); });

const tp = document.getElementById('touchpad');
const tout = document.getElementById('touch-out');
let active = 0;
// Touch-derived pointer events (pointerType 'touch') are IGNORED here so they do
// not overwrite the touch-event evidence below — otherwise a multi-touch gesture
// (touchstart/touchmove) would be clobbered by the trailing pointerup with
// 'pointers:0'. Real mouse pointers (mouse_down/up) still report 'pointers:N'.
tp.addEventListener('pointerdown', (e) => { active++; if (e.pointerType !== 'touch') tout.textContent = 'pointers:' + active; });
tp.addEventListener('pointerup', (e) => { active = Math.max(0, active - 1); if (e.pointerType !== 'touch') tout.textContent = 'pointers:' + active; });
tp.addEventListener('touchstart', (e) => { tout.textContent = 'touches:' + e.touches.length; }, { passive: true });
tp.addEventListener('touchmove', (e) => { tout.textContent = 'move-touches:' + e.touches.length; }, { passive: true });
window.addEventListener('wheel', (e) => { if (e.ctrlKey) tout.textContent = 'pinch-zoom:' + e.deltaY; }, { passive: true });
`,
      },
    ),
};
