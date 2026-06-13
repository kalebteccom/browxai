# Safari 26.5 ships WebDriver BiDi — empirical real-device probe (CORRECTS RFC 0002)

**Date:** 2026-06-13 · **Author:** Deep-research lane (Claude Code) · **Scope:** Does the *shipping* desktop Safari actually expose WebDriver BiDi, and if so, how much of the BiDi surface is live? Direct, reproducible automation of real `safaridriver` on this Mac — not docs inference. **This reference CORRECTS the RFC's "Safari has not shipped BiDi" claim** (see §6).

**Evidence base:** First-party empirical probing of the stock `safaridriver` shipped with macOS 26.5 / Safari 26.5 on this host, driven from Node v22.15.0 over the real HTTP/WebDriver endpoint and a live BiDi `ws://` socket. Every capability claim below was executed against the actual binary, not read from a spec or a man page. All findings are local-machine and marked **`[LOCAL]`**; they are authoritative for this exact OS/Safari build and supersede the prose-level prediction in [`05-safari-xpc.md`](05-safari-xpc.md) §4 Rank 4 and in [RFC 0002](../0002-multi-engine-bidi.md). Where this reference disagrees with an earlier one, **this one wins on the empirical point** (BiDi presence); the earlier XPC/BYOB conclusions are unaffected (see §5–§6).

---

## TL;DR verdict

- **WebDriver BiDi IS shipped in the stock Safari 26.5 release `[LOCAL]`.** `safaridriver --help` exposes `-b, --bidi`, and a session can be upgraded to a real bidirectional `ws://` socket. The RFC's "Safari has not shipped BiDi as of Safari 27 beta (June 2026)" is **empirically false** on the shipping 26.5 build.
- **It is gated behind a vendor experimental capability.** A plain `{webSocketUrl: true}` request is accepted but returns a **boolean placeholder** (`"webSocketUrl": true`) and opens **no socket** — spec-noncompliant. You must additionally pass **`"safari:experimentalWebSocketUrl": true`** to get a real URL string (`ws://127.0.0.1:<port>/session/<uuid>`) and a live listener. This boolean-true-vs-`ws://`-URL distinction is the load-bearing discovery.
- **The live BiDi surface is partial but real:** solid `script` (evaluate/callFunction/getRealms/addPreloadScript, multi-realm), `browsingContext` navigation + lifecycle, and **`log.entryAdded` console event streaming** — the bidirectional layer WebDriver Classic structurally cannot provide. **Missing:** `input`, `network`, `emulation`, `webExtension`, `browsingContext.captureScreenshot`/`locateNodes`. **Broken:** `storage.*` (throws `InternalError`).
- **WebDriver Classic remains the complete workhorse `[LOCAL]`** — navigate, screenshot, find/click/sendKeys, cookies, executeScript all pass. The realistic real-Safari automation adapter is **hybrid**: Classic for the full element/screenshot/cookie surface, BiDi (experimental cap) for live console + nav events + preload scripts + multi-realm eval.
- **Unchanged from [`05-safari-xpc.md`](05-safari-xpc.md):** BiDi does **not** change the BYOB picture. The session is still an isolated, ephemeral automation window — no cookies, localStorage, Keychain, or history from the user's real profile. BiDi shipping is a *sanctioned-automation-lane* upgrade, not a BYOB door.

---

## 1. Host and versions `[LOCAL]`

- **OS:** macOS 26.5, build `25F71`, Apple Silicon.
- **Safari:** 26.5 (`21624.2.5.11.4`) — the **shipping release**, not a beta or STP.
- **safaridriver:** `/usr/bin/safaridriver` → `/System/Cryptexes/App/usr/bin/safaridriver` (ships inside the Safari cryptex, per [`05-safari-xpc.md`](05-safari-xpc.md) §1.1).
- **Driver host:** Node v22.15.0, using the built-in `WebSocket` global — **no `ws` dependency**, so the BiDi client is a stock-Node probe with nothing to misattribute.

**Notable on this host:** **no `safaridriver --enable` and no `sudo` were required.** "Allow Remote Automation" was already permitted, and the `AllowRemoteAutomation` pref was absent; sessions were created directly. (This is a host-state observation, not a claim that `--enable` is never needed — see [`05-safari-xpc.md`](05-safari-xpc.md) §1.4 for the toggle mechanics.)

---

## 2. Launch and the BiDi gating discovery

### 2.1 Launch `[LOCAL]`
```
safaridriver -p 4444 --bidi 9223
```
- Listens on **4444** (HTTP / WebDriver Classic), as expected.
- **The `--bidi <port>` value is NOT honored as the listen port.** Passing `9223` did not bind BiDi to 9223; the BiDi socket is **allocated dynamically** by the driver and reported back in the granted capabilities (see §2.2). The `--bidi` flag is a *feature toggle*, not a port assignment.
- `safaridriver --help` documents the flag as: `-b, --bidi` — *"all sessions hosted by this instance will have WebDriver BiDi support enabled."*

### 2.2 The two-capability gate — boolean-true vs `ws://` URL `[LOCAL]`

The defining finding. BiDi is real but sits behind a Safari-vendor experimental capability, and the spec-standard request alone is a no-op placeholder:

| Request capabilities | Granted `webSocketUrl` | `safari:experimentalWebSocketUrl` | Socket opens? |
|---|---|---|---|
| `{ webSocketUrl: true }` | `true` (**boolean**, not a URL) | `false` | **No** — placeholder only |
| `{ webSocketUrl: true, "safari:experimentalWebSocketUrl": true }` | `"ws://127.0.0.1:8085/session/<uuid>"` (**real URL string**) | — | **Yes** — listener live on that port |

- With only `{webSocketUrl: true}`, the granted caps **echo a boolean** `"webSocketUrl": true` and set `"safari:experimentalWebSocketUrl": false`. This is **spec-noncompliant** — the W3C BiDi flow expects the granted `webSocketUrl` to be the connection URL string. No socket is opened; there is nothing to connect to.
- Adding **`"safari:experimentalWebSocketUrl": true`** flips the behavior: the granted caps carry a **real `ws://127.0.0.1:<port>/session/<uuid>` URL** and a WebSocket listener is live on that port. **This is the proof that Safari 26.5 BiDi is real but vendor-gated behind the experimental cap.**
- **One session at a time `[LOCAL]`:** a second concurrent `POST /session` fails while the first is open — the single-session constraint from `man safaridriver` holds for BiDi sessions too.

---

## 3. BiDi module coverage (live, against the `ws://` socket) `[LOCAL]`

Every row below was executed over the real BiDi socket obtained via the experimental cap. Legend: **OK** = command succeeded · **MISS** = `unknown command` / `<domain> not found` · **ERR** = domain present but the command threw.

### 3.1 Events that fired (subscribe succeeded *and* the event was delivered)

| Module | Events observed |
|---|---|
| `browsingContext` | `navigationStarted`, `navigationCommitted`, `domContentLoaded`, `load` |
| `log` | `entryAdded` |

These are the unique BiDi win Classic cannot give: **live navigation-lifecycle events and streamed console entries** over a bidirectional channel.

### 3.2 Commands — OK

| Module | Commands (all succeeded) |
|---|---|
| `session` | `status`, `subscribe` |
| `browsingContext` | `getTree`, `navigate`, `setViewport`, `activate`, `create` |
| `script` | `evaluate`, `callFunction`, `getRealms`, `addPreloadScript` |
| `network` | `setCacheBehavior` |

### 3.3 Commands — MISS (`unknown command` / domain `not found`)

| Module / command | Failure |
|---|---|
| `browsingContext.captureScreenshot` | not found |
| `browsingContext.locateNodes` | not found |
| `network.addIntercept` | `network` domain not found — **no interception or observation** |
| `input.performActions`, `input.setFiles` | `input` domain not found |
| `emulation.setGeolocationOverride` | `emulation` domain not found |
| `webExtension.install` | `webExtension` domain not found |

> Note the asymmetry inside `network`: `setCacheBehavior` is present (§3.2) but `addIntercept` reports the `network` domain as not found for the interception/observation surface. Treat **network observation and interception as absent** on this build.

### 3.4 Commands — ERR (domain present, threw)

| Module / command | Failure |
|---|---|
| `storage.getCookies` | `unknown error: InternalError` |
| `storage.setCookie` | `unknown error: InternalError` |

`storage.*` is wired up enough to dispatch but **broken** — it throws rather than returning a result. Use Classic for cookies (§4).

### 3.5 Net BiDi picture

Solid **`script`** (evaluate / callFunction / getRealms / addPreloadScript, multi-realm) + **`browsingContext`** navigation & lifecycle + **`log.entryAdded`** console streaming + **preload scripts**. **No** `input`, **no** screenshot, **no** network observation/interception, **no** emulation, **no** webExtension; **storage broken**. The bidirectional console + navigation event stream is the capability Classic cannot reproduce.

---

## 4. WebDriver Classic coverage (same `safaridriver`, plain session) — ALL OK `[LOCAL]`

A second session against the same driver, with no BiDi upgrade, exercised the Classic surface end-to-end. Every command passed:

| Command | Result |
|---|---|
| `navigate` | OK |
| `screenshot` | OK — PNG, 100 840 base64 chars |
| `findElement` (css `h1`) | OK |
| `element.text` | `"Example Domain"` |
| `element.click` | OK |
| `getCookies` | OK |
| `executeScript` (`navigator.userAgent`) | OK |
| `sendKeys` | OK |

**Classic is the COMPLETE workhorse for real Safari automation:** element find/interaction, screenshot, cookies, navigation, and arbitrary `executeScript` all work on the shipping driver.

---

## 5. Synthesis — the hybrid-adapter thesis `[LOCAL]`

Sanctioned real-`Safari.app` automation (isolated automation windows, **non-BYOB**) is fully viable on this Mac today via a **hybrid adapter** that layers BiDi on top of Classic:

- **WebDriver Classic →** element find / click / sendKeys, screenshot, cookies, navigation, `executeScript`. The complete interaction + capture + cookie surface.
- **WebDriver BiDi (behind `safari:experimentalWebSocketUrl`) →** live `log.entryAdded` console streaming, navigation-lifecycle events (`navigationStarted` / `Committed` / `domContentLoaded` / `load`), `script.evaluate` / `callFunction` / `getRealms`, and `addPreloadScript`. The **bidirectional layer Classic lacks.**
- **Honestly gated — unavailable on real Safari at all (this build):** network observation/interception, CDP-deep tools, BiDi `input` / `emulation` / `captureScreenshot` / `locateNodes`, and storage-via-BiDi. Where the adapter needs cookies, route to Classic (§4), not broken BiDi `storage.*`.

This is consistent with [`05-safari-xpc.md`](05-safari-xpc.md): BiDi is a **sanctioned-automation-lane** capability upgrade. It does **not** unlock BYOB — the session is still an isolated, ephemeral automation window with none of the user's real cookies/localStorage/Keychain/history. The two-engine real-*logged-in*-Safari companion (AppleScript `do JavaScript` + Safari Web Extension) from `05` is untouched by this finding.

---

## 6. RFC impact — the correction

[`browxai/docs/rfcs/0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md) currently asserts, in two places:

- **Line ~20:** *"**Safari has not shipped BiDi** as of Safari 27 beta (WWDC26, 8 Jun 2026). … plan Safari as Classic-only through at least early 2027."*
- **D7 (line ~68):** *"… Safari has not shipped BiDi (June 2026)."*

**Both are empirically FALSE on the shipping Safari 26.5 release `[LOCAL]`.** BiDi ships in stock Safari 26.5 today, gated behind the `safari:experimentalWebSocketUrl` vendor capability, with the live module coverage tabulated in §3.

**Correction required:**
1. Replace "Safari has not shipped BiDi" with "Safari 26.5 ships BiDi behind the `safari:experimentalWebSocketUrl` experimental capability; coverage is partial (`script` + `browsingContext` nav/lifecycle + `log` events; no `input`/`network`/`emulation`/screenshot; `storage` broken) — see [`references/06-safari-bidi-probe.md`](references/06-safari-bidi-probe.md)."
2. The "plan Safari as Classic-only through at least early 2027" posture should soften: the **Safari-BiDi engine row is real now**, not a 2027 watch item. The adapter design already anticipated this ("Safari-BiDi slots in as an engine row, not an architecture change", D5/P4) — this evidence promotes it from *forecast* to *available, partial*.
3. The architectural conclusion is **unchanged**: a Safari adapter should be **hybrid** (Classic workhorse + BiDi for console/nav events + preload + multi-realm eval), and BiDi does **not** unlock BYOB.

Per the standing in-repo directive (track the empirical research record), this probe is captured here as reference 06.

---

## 7. Reproducibility — exact commands and capabilities `[LOCAL]`

### 7.1 Launch the driver
```bash
safaridriver -p 4444 --bidi 9223
# HTTP/WebDriver on :4444. --bidi enables BiDi for all sessions hosted by this instance;
# the <port> value is NOT the BiDi listen port (it is allocated dynamically and
# reported in the granted capabilities). No `--enable` / sudo needed on this host
# (Allow Remote Automation already permitted).
```

### 7.2 Capabilities — BiDi placeholder (spec-standard request, NO socket)
```jsonc
// POST http://127.0.0.1:4444/session
{
  "capabilities": {
    "alwaysMatch": {
      "browserName": "safari",
      "webSocketUrl": true
    }
  }
}
// Granted caps echo: "webSocketUrl": true (boolean), "safari:experimentalWebSocketUrl": false
// => no ws:// socket opens. Placeholder only.
```

### 7.3 Capabilities — real BiDi socket (the working request)
```jsonc
// POST http://127.0.0.1:4444/session
{
  "capabilities": {
    "alwaysMatch": {
      "browserName": "safari",
      "webSocketUrl": true,
      "safari:experimentalWebSocketUrl": true
    }
  }
}
// Granted caps return: "webSocketUrl": "ws://127.0.0.1:<port>/session/<uuid>"
// => connect a WebSocket to that URL and speak BiDi JSON.
```

### 7.4 Minimal BiDi smoke (Node v22, built-in WebSocket — no `ws` dep)
```js
// 1) POST /session with the §7.3 caps; read granted webSocketUrl (a real ws:// string).
const ws = new WebSocket(grantedWebSocketUrl);
const send = (id, method, params = {}) =>
  ws.send(JSON.stringify({ id, method, params }));

ws.onopen = () => {
  send(1, "session.status");                                   // OK
  send(2, "session.subscribe", {                               // events delivered:
    events: ["browsingContext", "log.entryAdded"]              //   browsingContext.{navigationStarted,
  });                                                          //   navigationCommitted,domContentLoaded,load}
  send(3, "browsingContext.getTree");                          // OK                + log.entryAdded
  send(4, "browsingContext.navigate", {                        // OK
    context: "<ctx>", url: "https://example.com", wait: "complete"
  });
  send(5, "script.evaluate", {                                 // OK (also: callFunction,
    expression: "navigator.userAgent",                         //   getRealms, addPreloadScript)
    target: { context: "<ctx>" }, awaitPromise: true
  });
  send(6, "network.addIntercept", { phases: ["beforeRequestSent"] }); // MISS: 'network' domain not found
  send(7, "input.performActions", { context: "<ctx>", actions: [] }); // MISS: 'input' domain not found
  send(8, "storage.getCookies", {});                                  // ERR: unknown error: InternalError
};
```

### 7.5 WebDriver Classic smoke (plain session, no BiDi caps)
```jsonc
// POST /session  -> { "capabilities": { "alwaysMatch": { "browserName": "safari" } } }
// Then, all OK:
//   POST /session/<id>/url                 { "url": "https://example.com" }
//   GET  /session/<id>/screenshot          -> PNG (100840 b64 chars)
//   POST /session/<id>/element             { "using": "css selector", "value": "h1" }
//   GET  /session/<id>/element/<el>/text   -> "Example Domain"
//   POST /session/<id>/element/<el>/click
//   GET  /session/<id>/cookie
//   POST /session/<id>/execute/sync        { "script": "return navigator.userAgent", "args": [] }
//   POST /session/<id>/element/<el>/value  { "text": "..." }            // sendKeys
```

---

## Open uncertainties (flagged)

1. **Spec-compliance of the placeholder** — `{webSocketUrl: true}` returning a *boolean* `true` (rather than a URL string or an error) is spec-noncompliant; whether Apple intends to promote BiDi out of the `safari:experimentalWebSocketUrl` gate (and make plain `webSocketUrl` work) is unknown. Treat the experimental cap as **required** until a later build says otherwise.
2. **Build specificity** — all coverage is for Safari 26.5 (`21624.2.5.11.4`) / macOS 26.5 (`25F71`). The module matrix (esp. the `storage.*` `InternalError` and the missing `network`/`input`/`emulation`/screenshot domains) is expected to **grow** in later builds; re-run §7 against each Safari update rather than trusting this snapshot. The `network` split (`setCacheBehavior` present, `addIntercept` absent) in particular reads like in-progress work.
3. **`--bidi <port>` semantics** — the flag was observed to enable BiDi without honoring its port argument on this build; whether the port argument is honored in any configuration (or is vestigial) was not exhaustively probed.
4. **BYOB unchanged, by assertion** — this probe did not re-test the isolation model; it relies on [`05-safari-xpc.md`](05-safari-xpc.md) §1.6 (WebKit's documented automation-window isolation). No evidence here suggests BiDi attaches to a real profile, and the security rationale predicts it does not.

## Key sources

- **`[LOCAL]`** (macOS 26.5 build `25F71`, Safari 26.5 `21624.2.5.11.4`, Apple Silicon, 2026-06-13): direct execution of `/usr/bin/safaridriver -p 4444 --bidi 9223`; `safaridriver --help`; live `POST /session` capability negotiation (placeholder vs experimental-cap); a Node v22.15.0 BiDi client over the granted `ws://` socket exercising `session`/`browsingContext`/`script`/`network`/`input`/`emulation`/`storage`/`webExtension`/`log`; a parallel WebDriver Classic session exercising navigate/screenshot/find/text/click/cookies/executeScript/sendKeys.
- Sibling reference: [`05-safari-xpc.md`](05-safari-xpc.md) — the XPC/entitlement/BYOB feasibility deep dive this probe builds on and leaves intact.
- Corrected document: [`../0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md) (lines ~20 and D7).
- W3C WebDriver BiDi (module/event names used above): https://www.w3.org/TR/webdriver-bidi/
