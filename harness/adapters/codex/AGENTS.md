## Browser automation — browxai

This environment has **browxai**, an MCP browser-control server, registered.
For browser tasks, drive it through its MCP tools (`navigate`, `snapshot`,
`find`, `click`, `fill`, ...).

Operating discipline (the full version is the `driving-browxai` skill):

- Loop: `navigate` → `snapshot` → `find` → act by `ref`. Read the returned
  `ActionResult` instead of screenshotting to confirm.
- `wait_for` is bounded — never loop a wait; an `ok:false` is a real negative.
- An `anti-wedge timeout`: retry the call once. Repeated timeouts, or a result
  with `sessionWedged: true`, mean the session is wedged — `close_session`
  then `open_session` a fresh one. Raising `timeoutMs` never recovers a wedged
  session.
- Hold a wall-clock budget and a recovery-attempt cap (~3). On hitting either,
  stop and return a partial result — never loop for hours.
