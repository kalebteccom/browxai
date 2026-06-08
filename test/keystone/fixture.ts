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

    <table data-testid="record-grid">
      <thead><tr><th>Name</th><th>Type</th></tr></thead>
      <tbody>
        <tr><td data-testid="row-1-name">Persisted Row One</td><td>Alpha</td></tr>
        <tr><td data-testid="row-2-name">Persisted Row Two</td><td>Beta</td></tr>
      </tbody>
    </table>
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
    function askGeo() {
      var out = document.getElementById('geoResult');
      out.textContent = 'pending';
      if (!navigator.geolocation) { out.textContent = 'no-geo-api'; return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) { out.textContent = 'allowed lat=' + pos.coords.latitude + ' lng=' + pos.coords.longitude; },
        function (err) { out.textContent = 'denied code=' + err.code; }
      );
    }
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

/** Start the fixture on an ephemeral loopback port. Routes:
 *   GET /                 → the primitives page; `?setcookie=1` also sets `ks`
 *   GET /echo             → renders the request's Cookie header (isolation)
 */
export async function startFixture(): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/echo") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(echoPage(req.headers.cookie ?? ""));
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
