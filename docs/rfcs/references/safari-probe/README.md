# Safari automation probe scripts

First-party, reproducible probes of real `safaridriver` (the empirical basis for
[`../06-safari-bidi-probe.md`](../06-safari-bidi-probe.md) and the implementation
plan [`../07-safari-adapter-implementation-plan.md`](../07-safari-adapter-implementation-plan.md)).
Node v22+ only (they use the built-in global `WebSocket` — no `ws` dependency).

```bash
# 1. start safaridriver (HTTP on 4444; --bidi enables BiDi for hosted sessions)
safaridriver -p 4444 --bidi 9223 &
#    On a fresh host you may first need: sudo safaridriver --enable
#    + Safari ▸ Develop ▸ "Allow Remote Automation".

# 2. run a probe
node docs/rfcs/references/safari-probe/bidi-probe.mjs       # BiDi module coverage
node docs/rfcs/references/safari-probe/classic-probe.mjs    # WebDriver Classic coverage
node docs/rfcs/references/safari-probe/safari-substrate-spike.mjs  # DOM-walk over Classic execute/sync

# 3. stop it
pkill -f safaridriver
```

- **`bidi-probe.mjs`** — requests a session with `{webSocketUrl:true, "safari:experimentalWebSocketUrl":true}`, connects the granted `ws://` socket, and exercises one command per BiDi module + checks which events fire. Prints the OK / MISS / ERR coverage table.
- **`classic-probe.mjs`** — exercises the full WebDriver Classic surface (navigate, screenshot, find, click, text, cookies, executeScript, sendKeys).
- **`safari-substrate-spike.mjs`** — extracts browxai's real `PAGE_SCRIPT` from `src/page/dom-walk.ts` and runs it via Classic `execute/sync`, proving the snapshot substrate is feasible (returns the identical `DomWalkEntry` shape).

These open real (visible) Safari automation windows — there is no headless Safari.
