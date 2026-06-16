// `devices` — Web Bluetooth / WebUSB / WebHID request buttons. Exercises
// emulate_bluetooth / emulate_usb / emulate_hid (the synthetic-device catalog)
// and device_requests (the read-side view of what the page asked for).
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const devices: Surface = {
  id: "devices",
  path: "/devices",
  title: "Devices surface",
  blurb: "Web Bluetooth / WebUSB / WebHID requestDevice buttons",
  html: () =>
    doc(
      "Devices surface",
      `
<section class="card">
  <button id="bt" data-testid="req-bluetooth">bluetooth.requestDevice()</button>
  <button id="usb" data-testid="req-usb">usb.requestDevice()</button>
  <button id="hid" data-testid="req-hid">hid.requestDevice()</button>
  <pre id="d-out" data-testid="device-out"></pre>
</section>
`,
      {
        surfaceId: "devices",
        script: `
const out = document.getElementById('d-out');
document.getElementById('bt').addEventListener('click', async () => {
  try { const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true }); out.textContent = 'bt:' + (d && d.name); }
  catch (e) { out.textContent = 'bt-error:' + e.name; }
});
document.getElementById('usb').addEventListener('click', async () => {
  try { const d = await navigator.usb.requestDevice({ filters: [] }); out.textContent = 'usb:' + (d && d.productName); }
  catch (e) { out.textContent = 'usb-error:' + e.name; }
});
document.getElementById('hid').addEventListener('click', async () => {
  try { const ds = await navigator.hid.requestDevice({ filters: [] }); out.textContent = 'hid:' + ds.length; }
  catch (e) { out.textContent = 'hid-error:' + e.name; }
});
`,
      },
    ),
};
