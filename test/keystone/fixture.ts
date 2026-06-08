// Zero-dependency fixture for the headless-CI keystone. A Node built-in `http`
// server (no network, no extra deps) serving a small self-contained page that
// exercises the non-trivial primitives the non-Claude run covered:
//
//   - a stable test-attribute target            → find() tier-1 / stability
//   - a text input with a post-write value       → fill() ActionResult.element
//   - a *custom* combobox/listbox (not <select>) → choose_option()
//   - a repeated row grid with known text        → text_search() presence/absence
//   - a fixed-geometry box                       → inspect() box/style
//
// Plus an `/echo` route that renders whatever `Cookie` header it received into
// a `data-testid`-tagged element, so the keystone can prove two sessions have
// isolated cookie jars (set in A, absent in B).

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { AddressInfo } from "node:net";

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>browxai keystone fixture</title>
<style>
  #status-box { width: 200px; height: 80px; }
  .hidden { display: none; }
</style></head>
<body>
  <header><h1>Keystone Fixture</h1></header>
  <main>
    <form id="entry" onsubmit="return false">
      <label for="task">Task</label>
      <input data-testid="task-input" id="task" name="task" type="text" />

      <!-- custom combobox: NOT a native <select> -->
      <div class="combo">
        <button data-testid="type-select" id="typeBtn" aria-haspopup="listbox"
                aria-expanded="false" onclick="toggleList()">
          <span data-testid="type-display" id="typeDisplay">Choose type</span>
        </button>
        <ul role="listbox" id="typeList" class="hidden" aria-label="Type">
          <li role="option" data-value="alpha" onclick="pick('Alpha')">Alpha</li>
          <li role="option" data-value="beta"  onclick="pick('Beta')">Beta</li>
          <li role="option" data-value="gamma" onclick="pick('Gamma')">Gamma</li>
        </ul>
      </div>

      <button data-testid="save-btn" id="save" type="button"
              onclick="document.getElementById('saved').textContent='Saved OK'">
        Save
      </button>
      <output data-testid="saved-state" id="saved">Unsaved</output>
    </form>

    <!-- bare <a> with href, NO testid - DOM-walk emits role of the bare tag
         which is NOT a valid ARIA role token, so buildSelectorHint falls
         through to a role-locator that Playwright cannot resolve. Pre-v0.2.1
         the per-candidate probe loop would auto-wait the actionTimeout
         window on this hint. Targeted by the find wall-clock regression
         assertion. -->
    <a href="#">More info link</a>

    <div data-testid="status-box" id="status-box" role="status">Idle</div>

    <!-- permission_policy keystone: a click drives navigator.geolocation
         which triggers the page-side wrapper installed by attachPermissionPolicy.
         The result text is wired so the keystone assertion can distinguish
         allow (lat/lng present) from deny (error). -->
    <button data-testid="geo-btn" id="geoBtn" type="button"
            onclick="askGeo()">Ask geolocation</button>
    <output data-testid="geo-result" id="geoResult">unset</output>

    <!-- Drop-files keystone: a div that listens for HTML5 drag-drop and
         records the dropped files (names, sizes, types, plus the first
         8 bytes of the first file as base64) into a tagged output. The
         drop_files keystone reads it back to prove the in-page File +
         DataTransfer + dragenter/dragover/drop synthesis actually
         delivers the bytes. -->
    <div data-testid="drop-zone" id="dropZone"
         style="width:240px;height:120px;border:2px dashed #888;padding:8px"
         ondragenter="dzPrevent(event)"
         ondragover="dzPrevent(event)"
         ondrop="onDrop(event)">
      Drop files here
    </div>
    <output data-testid="drop-log" id="dropLog">undropped</output>
    <!-- notification_policy keystone: a click constructs new Notification(...)
         which is intercepted by attachNotificationPolicy's init-script wrapper.
         The button records whether the constructor returned (allow / ask-human)
         or threw NotAllowedError (deny / raise), so the keystone can assert
         the constructor surface tracks the policy. -->
    <button data-testid="notif-btn" id="notifBtn" type="button"
            onclick="showNotif()">Show notification</button>
    <output data-testid="notif-result" id="notifResult">unset</output>
    <!-- fs_picker_policy keystone: a click drives showSaveFilePicker (the
         common "save to disk" flow modern web editors use). The result
         text reports the picker outcome — picker-error (deny/raise),
         got-handle (allow), or wrote-N-bytes once the writable stream
         closed. The agent stages a workspace-rooted destination via
         fs_picker_respond before clicking. -->
    <button data-testid="save-btn-fs" id="saveBtnFs" type="button"
            onclick="askSavePicker()">Save via picker</button>
    <output data-testid="fs-result" id="fsResult">unset</output>

    <!-- device-emulation keystone (Phase 7): one button per Web platform
         device-picker API. Each calls navigator.<api>.requestDevice() and
         writes the outcome ('resolved name=…' / 'rejected name=…' /
         'empty count=…') into a tagged output so the keystone can assert
         the wrapper served the staged catalog (or the user-dismissed
         shape when no catalog is set). -->
    <button data-testid="bt-btn" id="btBtn" type="button"
            onclick="askBluetooth()">Ask Bluetooth</button>
    <output data-testid="bt-result" id="btResult">unset</output>
    <button data-testid="usb-btn" id="usbBtn" type="button"
            onclick="askUsb()">Ask USB</button>
    <output data-testid="usb-result" id="usbResult">unset</output>
    <button data-testid="hid-btn" id="hidBtn" type="button"
            onclick="askHid()">Ask HID</button>
    <output data-testid="hid-result" id="hidResult">unset</output>

    <!-- Touch keystone: a div that records touch events in a tagged
         output so the keystone can assert touchstart / touchend actually fire
         on the real headless browser via the CDP touch pipeline. -->
    <div data-testid="touch-pad" id="touchPad"
         style="width:200px;height:120px;border:1px solid #888;touch-action:none"
         ontouchstart="onTouch(event,'start')"
         ontouchmove="onTouch(event,'move')"
         ontouchend="onTouch(event,'end')">
      Touch me
    </div>
    <output data-testid="touch-log" id="touchLog">untouched</output>

    <table data-testid="record-grid">
      <thead><tr><th>Name</th><th>Type</th></tr></thead>
      <tbody>
        <tr><td data-testid="row-1-name">Persisted Row One</td><td>Alpha</td></tr>
        <tr><td data-testid="row-2-name">Persisted Row Two</td><td>Beta</td></tr>
      </tbody>
    </table>

    <!-- Phase 7: Shadow DOM keystone. Two custom elements with shadow
         roots (open + closed) carrying interactive content the agent
         should be able to discover via shadow_trees + via the pierce-
         aware find / snapshot. -->
    <open-widget id="open-widget"></open-widget>
    <closed-widget id="closed-widget"></closed-widget>
  </main>
  <script>
    function toggleList() {
      var l = document.getElementById('typeList');
      var b = document.getElementById('typeBtn');
      var open = l.classList.toggle('hidden') === false;
      b.setAttribute('aria-expanded', String(open));
    }
    function pick(label) {
      document.getElementById('typeDisplay').textContent = label;
      document.getElementById('typeList').classList.add('hidden');
      document.getElementById('typeBtn').setAttribute('aria-expanded', 'false');
    }
    function dzPrevent(ev) { ev.preventDefault(); ev.stopPropagation(); }
    function onDrop(ev) {
      ev.preventDefault();
      var dt = ev.dataTransfer;
      var files = (dt && dt.files) ? dt.files : [];
      var meta = [];
      var firstHead = '';
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        meta.push(f.name + ':' + f.type + ':' + f.size);
      }
      // Read first 8 bytes of file[0] as base64 so the keystone can
      // confirm the bytes themselves crossed the boundary.
      function done(b64) {
        document.getElementById('dropLog').textContent =
          'count=' + files.length +
          ' types=' + ((dt && dt.types) ? Array.prototype.slice.call(dt.types).join(',') : '') +
          ' files=' + meta.join('|') +
          ' head8=' + b64;
      }
      if (files.length > 0 && typeof files[0].slice === 'function') {
        var slice = files[0].slice(0, 8);
        var fr = new FileReader();
        fr.onload = function() {
          // FileReader.readAsDataURL → "data:<mime>;base64,<payload>"
          var s = String(fr.result || '');
          var idx = s.indexOf('base64,');
          done(idx >= 0 ? s.slice(idx + 7) : '');
        };
        fr.onerror = function() { done(''); };
        fr.readAsDataURL(slice);
      } else {
        done('');
      }
    }
    var _touchCounts = { start: 0, move: 0, end: 0 };
    var _touchIds = [];
    function onTouch(ev, phase) {
      ev.preventDefault();
      _touchCounts[phase]++;
      // Capture identifiers from changedTouches for the multi-touch keystone.
      for (var i = 0; i < ev.changedTouches.length; i++) {
        var id = ev.changedTouches[i].identifier;
        if (_touchIds.indexOf(id) === -1) _touchIds.push(id);
      }
      document.getElementById('touchLog').textContent =
        'start=' + _touchCounts.start +
        ' move=' + _touchCounts.move +
        ' end=' + _touchCounts.end +
        ' ids=' + _touchIds.join(',');
    }
    function askGeo() {
      var out = document.getElementById('geoResult');
      out.textContent = 'pending';
      if (!navigator.geolocation) { out.textContent = 'no-geo-api'; return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) { out.textContent = 'allowed lat=' + pos.coords.latitude + ' lng=' + pos.coords.longitude; },
        function (err) { out.textContent = 'denied code=' + err.code; }
      );
    }
    function showNotif() {
      var out = document.getElementById('notifResult');
      if (typeof Notification === 'undefined') { out.textContent = 'no-notif-api'; return; }
      try {
        var n = new Notification('hello', { body: 'world', icon: 'i.png', tag: 'kt' });
        out.textContent = 'constructed title=' + n.title;
      } catch (e) {
        out.textContent = 'threw name=' + e.name;
      }
    }
    async function askSavePicker() {
      var out = document.getElementById('fsResult');
      out.textContent = 'pending';
      if (typeof window.showSaveFilePicker !== 'function') {
        out.textContent = 'no-fs-api';
        return;
      }
      try {
        var handle = await window.showSaveFilePicker({ suggestedName: 'keystone.txt' });
        out.textContent = 'got-handle name=' + handle.name;
        var writable = await handle.createWritable();
        var payload = 'keystone-payload-' + Date.now();
        await writable.write(payload);
        await writable.close();
        out.textContent = 'wrote name=' + handle.name + ' bytes=' + payload.length;
      } catch (err) {
        out.textContent = 'picker-error name=' + (err && err.name) + ' msg=' + (err && err.message);
      }
    }
    // Phase 7 — Cache API + IndexedDB keystone seeding.
    // Populate one cache storage with a text entry + a binary entry, and
    // one IDB database with a kv store carrying two records. Both run in
    // an IIFE that flips a tagged <output> to "ready" so the keystone can
    // poll until the seeds are in place before exercising the tools.
    (async function seedStorageState() {
      var ready = document.createElement('output');
      ready.setAttribute('data-testid', 'storage-seed-state');
      ready.id = 'storageSeedState';
      ready.textContent = 'pending';
      document.body.appendChild(ready);
      try {
        // -- Cache API: open "v1", put one text entry + one binary entry.
        if (typeof caches !== 'undefined') {
          var c = await caches.open('v1');
          await c.put(
            new Request('/cached/hello.json'),
            new Response('{"hi":"world"}', { status: 200, headers: { 'content-type': 'application/json' } }),
          );
          // 4 bytes of binary (0x89 0x50 0x4e 0x47 = PNG magic).
          var bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
          await c.put(
            new Request('/cached/img.png'),
            new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
          );
        }
        // -- IndexedDB: db "app" with store "kv" (out-of-line key), two records.
        await new Promise(function (resolve, reject) {
          var req = indexedDB.open('app', 1);
          req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          };
          req.onsuccess = function () {
            var db = req.result;
            var tx = db.transaction('kv', 'readwrite');
            var s = tx.objectStore('kv');
            s.put({ name: 'Ada' }, 'u1');
            s.put({ name: 'Linus' }, 'u2');
            tx.oncomplete = function () { db.close(); resolve(); };
            tx.onerror = function () { db.close(); reject(tx.error); };
          };
          req.onerror = function () { reject(req.error); };
        });
        ready.textContent = 'ready';
      } catch (e) {
        ready.textContent = 'error msg=' + (e && e.message || e);
      }
    })();

    async function askBluetooth() {
      var out = document.getElementById('btResult');
      out.textContent = 'pending';
      if (!navigator.bluetooth || typeof navigator.bluetooth.requestDevice !== 'function') {
        out.textContent = 'no-bt-api';
        return;
      }
      try {
        var device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
        out.textContent = 'resolved name=' + (device && device.name) + ' id=' + (device && device.id);
      } catch (err) {
        out.textContent = 'rejected name=' + (err && err.name);
      }
    }
    async function askUsb() {
      var out = document.getElementById('usbResult');
      out.textContent = 'pending';
      if (!navigator.usb || typeof navigator.usb.requestDevice !== 'function') {
        out.textContent = 'no-usb-api';
        return;
      }
      try {
        var device = await navigator.usb.requestDevice({ filters: [] });
        out.textContent = 'resolved vendorId=' + device.vendorId + ' productName=' + device.productName;
      } catch (err) {
        out.textContent = 'rejected name=' + (err && err.name);
      }
    }
    async function askHid() {
      var out = document.getElementById('hidResult');
      out.textContent = 'pending';
      if (!navigator.hid || typeof navigator.hid.requestDevice !== 'function') {
        out.textContent = 'no-hid-api';
        return;
      }
      try {
        var devices = await navigator.hid.requestDevice({ filters: [] });
        if (!devices.length) {
          out.textContent = 'empty count=0';
        } else {
          out.textContent = 'resolved count=' + devices.length + ' first=' + devices[0].productName;
        }
      } catch (err) {
        out.textContent = 'rejected name=' + (err && err.name);
      }
    }
    // Phase 7 — Shadow DOM keystone fixtures.
    // open-widget: attachShadow({mode:"open"}) — Element.shadowRoot returns
    // the root, so Playwright / page-side JS / dom-walk can all pierce it.
    customElements.define('open-widget', class extends HTMLElement {
      connectedCallback() {
        var root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<button data-testid="open-widget-cta">Open Shadow CTA</button>';
      }
    });
    // closed-widget: attachShadow({mode:"closed"}) — Element.shadowRoot
    // returns null. The CDP DOM.getDocument({pierce:true}) path is the
    // only way to introspect the subtree.
    customElements.define('closed-widget', class extends HTMLElement {
      connectedCallback() {
        var root = this.attachShadow({ mode: 'closed' });
        root.innerHTML = '<button data-testid="closed-widget-cta">Closed Shadow CTA</button>';
      }
    });
  </script>
</body>
</html>`;

// Page hosting two iframes: one same-origin (served from this server's
// /child route) and one cross-origin-ish (a `data:` URL — opaque origin,
// hits the same OOPIF code path on Chromium). Exercises Phase-7
// frame-scoped snapshot/find/action through the keystone.
const IFRAME_HOST = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>iframe host</title></head>
<body>
  <main>
    <h1 data-testid="host-title">Host</h1>
    <button data-testid="host-btn">Top-level Save</button>
    <iframe data-testid="same-origin-iframe" name="same" src="/child"></iframe>
    <iframe data-testid="data-iframe" name="data"
      srcdoc="<button data-testid='inside-data'>Inside Data</button>"></iframe>
  </main>
</body>
</html>`;

const CHILD_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>child</title></head>
<body>
  <button data-testid="child-save">Child Save</button>
  <input data-testid="child-input" type="text" />
  <output data-testid="child-state">child-idle</output>
  <script>
    var btn = document.querySelector('[data-testid="child-save"]');
    btn.addEventListener('click', function() {
      document.querySelector('[data-testid="child-state"]').textContent = 'child-saved';
    });
  </script>
</body>
</html>`;

// Phase-7 interactive-WS keystone — page opens a WebSocket against the
// fixture's `/ws` echo endpoint, then writes:
//   - every received message into `#ws-log` (newline-joined)
//   - the open/closed state into `#ws-state`
// The page does NOT call `.send()` on its own past the initial "hello" —
// the keystone drives `ws_send` from the server side and asserts the echo
// arrives. For `ws_intercept`, the page emits its own message after a
// short delay so the server can intercept it before the page handler runs.
const WS_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ws keystone</title></head>
<body>
<output data-testid="ws-state" id="ws-state">idle</output>
<pre data-testid="ws-log" id="ws-log"></pre>
<button data-testid="ws-trigger" id="ws-trigger" onclick="trigger()">trigger</button>
<script>
  var sock = new WebSocket("ws://" + location.host + "/ws");
  var log = document.getElementById("ws-log");
  sock.addEventListener("open", function () {
    document.getElementById("ws-state").textContent = "open";
    sock.send("hello");
  });
  sock.addEventListener("message", function (ev) {
    log.textContent += ev.data + "\\n";
  });
  sock.addEventListener("close", function () {
    document.getElementById("ws-state").textContent = "closed";
  });
  function trigger() { sock.send("INTERCEPT_ME"); }
</script>
</body>
</html>`;

// Phase-7 workers keystone — the page constructs a real Web Worker (built
// from a `Blob` so we don't need a separate served script), wires `onmessage`
// to write every received frame into `#worker-log` (newline-joined), and
// exposes a button that posts an "INTERCEPT_ME" string into the worker. The
// worker simply echoes back any message it receives prefixed with `echo:`.
// This is enough to prove `workers_list` sees `ww-N`, `worker_message_send`
// drives the worker's `onmessage`, and `worker_messages_read` drains the
// page-side ring of FROM-worker frames.
const WORKERS_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>workers keystone</title></head>
<body>
<output data-testid="worker-state" id="worker-state">idle</output>
<pre data-testid="worker-log" id="worker-log"></pre>
<button data-testid="worker-trigger" id="worker-trigger" onclick="trigger()">trigger</button>
<script>
  // Build the worker from a Blob so the fixture stays self-contained.
  var workerSrc = [
    "self.addEventListener('message', function (ev) {",
    "  self.postMessage('echo:' + ev.data);",
    "});",
    "self.postMessage('worker-ready');",
  ].join("\\n");
  var blob = new Blob([workerSrc], { type: "application/javascript" });
  var url = URL.createObjectURL(blob);
  var w = new Worker(url);
  var log = document.getElementById("worker-log");
  w.addEventListener("message", function (ev) {
    log.textContent += ev.data + "\\n";
    if (ev.data === "worker-ready") {
      document.getElementById("worker-state").textContent = "ready";
    }
  });
  function trigger() { w.postMessage("page-said-hi"); }
</script>
</body>
</html>`;

// Phase-10 overflow_detect keystone — a page deliberately constructed to
// trip each of the four overflow detectors exactly once:
//
//   - `layout`              → #ks-layout: overflow:auto, content larger than box
//   - `clipped`             → #ks-clipped: overflow:hidden, content overruns
//   - `text-ellipsis`       → #ks-ellipsis: text-overflow:ellipsis, content longer than width
//   - `viewport-horizontal` → #ks-wide: 200vw element on the body
//
// Also: a fully off-screen `clipped` element (#ks-offscreen) the
// `scope:"viewport"` test asserts gets skipped. The page sets `width:100vw`
// on body so the viewport-horizontal check fires reliably.
const OVERFLOW_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>overflow keystone</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 14px sans-serif; }
  #ks-layout {
    overflow: auto;
    height: 50px;
    width: 200px;
    border: 1px solid #888;
  }
  #ks-layout-inner { width: 100%; height: 200px; background: linear-gradient(#eef, #cce); }
  #ks-clipped {
    overflow: hidden;
    width: 100px;
    height: 30px;
    border: 1px solid #888;
    white-space: nowrap;
  }
  #ks-clipped-inner { display: inline-block; width: 300px; background: #fcc; }
  #ks-ellipsis {
    display: inline-block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 80px;
    border: 1px solid #888;
    vertical-align: top;
  }
  #ks-wide {
    width: 200vw;
    height: 4px;
    background: #f00;
  }
  /* Off-screen clipped element — used to validate scope:viewport skips it. */
  #ks-offscreen {
    position: absolute;
    top: 5000px;
    left: 0;
    width: 100px;
    height: 30px;
    overflow: hidden;
  }
  #ks-offscreen-inner { width: 400px; height: 60px; display: inline-block; }
</style></head>
<body>
  <h1 data-testid="ks-title">Overflow Keystone</h1>

  <div data-testid="ks-layout" id="ks-layout">
    <div id="ks-layout-inner">tall content inside an auto-scroll box</div>
  </div>

  <div data-testid="ks-clipped" id="ks-clipped">
    <span data-testid="ks-clipped-inner" id="ks-clipped-inner">this content is wider than the box and clipped</span>
  </div>

  <span data-testid="ks-ellipsis" id="ks-ellipsis">this is a very long sentence that will definitely truncate</span>

  <div data-testid="ks-wide" id="ks-wide"></div>

  <div data-testid="ks-offscreen" id="ks-offscreen">
    <span data-testid="ks-offscreen-inner" id="ks-offscreen-inner">off-screen content also overflows</span>
  </div>
</body>
</html>`;

// Phase-9a canvas keystone — a fixture page with a real `<canvas>` painted
// with a recognizable pattern (red square top-left, blue square bottom-
// right) so `canvas_capture` round-trips through Chromium with predictable
// bytes. Also wires mousedown/mousemove/mouseup listeners on the canvas
// that record an event log into a tagged output so the `gesture_chain`
// keystone can assert the page-side events fire.
const CANVAS_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>canvas keystone</title>
<style>
  html, body { margin: 0; padding: 0; }
  #canvas-target { display: block; border: 1px solid #888; }
</style></head>
<body>
  <h1 data-testid="kc-title">Canvas Keystone</h1>
  <canvas data-testid="kc-canvas" id="canvas-target" width="64" height="64"></canvas>
  <output data-testid="kc-event-log" id="event-log">none</output>
  <script>
    var c = document.getElementById('canvas-target');
    var ctx = c.getContext('2d');
    // Background — opaque white so getImageData has predictable RGBA.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 64, 64);
    // Red square top-left 8x8 — exact channel values, easy to assert.
    ctx.fillStyle = 'rgb(255,0,0)';
    ctx.fillRect(0, 0, 8, 8);
    // Blue square bottom-right 8x8.
    ctx.fillStyle = 'rgb(0,0,255)';
    ctx.fillRect(56, 56, 8, 8);
    // Event log — record mousedown / mousemove / mouseup counts so the
    // gesture_chain keystone can confirm the page-side listeners fired.
    var counts = { down: 0, move: 0, up: 0 };
    function bump(k) {
      counts[k]++;
      document.getElementById('event-log').textContent =
        'down=' + counts.down + ' move=' + counts.move + ' up=' + counts.up;
    }
    c.addEventListener('mousedown', function() { bump('down'); });
    c.addEventListener('mousemove', function() { bump('move'); });
    c.addEventListener('mouseup', function() { bump('up'); });
    // Stage a synthetic app-side viewport global so the canvas_world_to_screen
    // discovery probe has a deterministic shape to match. The keystone's
    // explicit-mode test asserts math on a known transform; this global
    // lets a future discovery-mode keystone (or an adopter walking the
    // BYO-vision example) confirm the probe sees what's documented.
    window.app = window.app || {};
    window.app.viewport = { zoom: 2.0, center: { x: -50, y: -30 } };
  </script>
</body>
</html>`;

function echoPage(cookie: string): string {
  // Render the received Cookie header verbatim into a tagged element. No
  // template injection risk for the keystone's own controlled values; still
  // escape the basics defensively.
  const safe = cookie.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>echo</title></head><body>
<span data-testid="cookie-echo">COOKIE=${safe || "NONE"}</span>
</body></html>`;
}

export interface Fixture {
  url: string;
  close: () => Promise<void>;
}

// Minimal RFC 6455 echo server — text frames only. We don't take on a
// `ws` runtime dep just for the keystone; the protocol surface we need
// (single-frame text in, single-frame text out, masked client→server,
// unmasked server→client) is small and self-contained.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsHandshake(key: string): string {
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n");
}

/** Parse one client→server text frame from a buffer. Returns null if the
 *  buffer doesn't yet contain a full frame. Only text (opcode 0x1) +
 *  control-frame close (0x8) are handled — enough for the echo path. */
function parseFrame(buf: Buffer): { opcode: number; payload: string; consumed: number } | null {
  if (buf.length < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    // 64-bit length — for the keystone path we cap at 32-bit
    len = Number(buf.readBigUInt64BE(off));
    off += 8;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const data = buf.subarray(off, off + len);
  const unmasked = mask ? Buffer.from(data.map((b, i) => b ^ mask![i % 4]!)) : Buffer.from(data);
  return { opcode, payload: unmasked.toString("utf-8"), consumed: off + len };
}

/** Build a server→client text frame (unmasked, single-fragment). */
function buildTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf-8");
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function handleUpgrade(req: { headers: Record<string, string | string[] | undefined> }, socket: Duplex): void {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end();
    return;
  }
  socket.write(wsHandshake(key));
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    // Drain any complete frames.
    for (;;) {
      const f = parseFrame(buf);
      if (!f) return;
      buf = buf.subarray(f.consumed);
      if (f.opcode === 0x8) {
        // close — reply with a close frame and end.
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      if (f.opcode === 0x1) {
        // text — echo it back (prefixed so the keystone can tell direction).
        socket.write(buildTextFrame(`echo:${f.payload}`));
      }
    }
  });
  socket.on("error", () => undefined);
}

/** Start the fixture on an ephemeral loopback port. Routes:
 *   GET /                 → the primitives page; `?setcookie=1` also sets `ks`
 *   GET /echo             → renders the request's Cookie header (isolation)
 *   GET /ws-page          → page that opens a WebSocket against /ws
 *   WS  /ws               → RFC 6455 echo (text frames only)
 */
export async function startFixture(): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/echo") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(echoPage(req.headers.cookie ?? ""));
      return;
    }
    if (u.pathname === "/with-iframe") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(IFRAME_HOST);
      return;
    }
    if (u.pathname === "/child") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CHILD_PAGE);
      return;
    }
    if (u.pathname === "/ws-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(WS_PAGE);
      return;
    }
    if (u.pathname === "/workers-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(WORKERS_PAGE);
      return;
    }
    if (u.pathname === "/overflow-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(OVERFLOW_PAGE);
      return;
    }
    if (u.pathname === "/canvas-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CANVAS_PAGE);
      return;
    }
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (u.pathname === "/" && u.searchParams.get("setcookie") === "1") {
      // session-scoped cookie (no Expires) — lives in that context's jar only
      headers["set-cookie"] = "ks=present; Path=/; SameSite=Lax";
    }
    res.writeHead(u.pathname === "/" ? 200 : 404, headers);
    res.end(u.pathname === "/" ? PAGE : "<!doctype html><title>404</title>not found");
  });

  server.on("upgrade", (req, socket) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/ws") handleUpgrade(req as never, socket);
    else socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
