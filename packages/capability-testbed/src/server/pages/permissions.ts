// `permissions` — geolocation, notifications, camera/mic, and Permissions API
// queries. Exercises grant_permissions, set_permission_policy, permission_state,
// set_geolocation, set_notification_policy.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const permissions: Surface = {
  id: "permissions",
  path: "/permissions",
  title: "Permissions surface",
  blurb: "geolocation, notifications, camera, Permissions API queries",
  html: () =>
    doc(
      "Permissions surface",
      `
<section class="card">
  <button id="geo" data-testid="req-geo">getCurrentPosition()</button>
  <button id="notif" data-testid="req-notif">Notification.requestPermission()</button>
  <button id="cam" data-testid="req-cam">getUserMedia(video)</button>
  <button id="query" data-testid="query-perms">query permission states</button>
  <pre id="p-out" data-testid="perm-out"></pre>
</section>
`,
      {
        surfaceId: "permissions",
        script: `
const out = document.getElementById('p-out');
document.getElementById('geo').addEventListener('click', () => {
  navigator.geolocation.getCurrentPosition(
    (pos) => { out.textContent = 'geo:' + pos.coords.latitude + ',' + pos.coords.longitude; },
    (err) => { out.textContent = 'geo-error:' + err.message; },
  );
});
document.getElementById('notif').addEventListener('click', async () => {
  out.textContent = 'notif:' + (await Notification.requestPermission());
  try { new Notification('hello from testbed'); } catch (e) { out.textContent += ' (ctor:' + e + ')'; }
});
document.getElementById('cam').addEventListener('click', async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); out.textContent = 'cam:' + s.getVideoTracks().length; }
  catch (e) { out.textContent = 'cam-error:' + e.name; }
});
document.getElementById('query').addEventListener('click', async () => {
  const names = ['geolocation', 'notifications', 'camera'];
  const states = {};
  for (const n of names) {
    try { states[n] = (await navigator.permissions.query({ name: n })).state; }
    catch (e) { states[n] = 'query-error'; }
  }
  out.textContent = JSON.stringify(states, null, 2);
});
`,
      },
    ),
};
