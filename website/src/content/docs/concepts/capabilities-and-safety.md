---
title: Capabilities and safety
description: The capability model, the safe-by-default posture, the origin policy, confirmation hooks, and the anti-wedge deadline that protect an agent-driven browser.
---

An agent driving a real browser can do real damage. browxai's answer is a
closed default: the sharp tools are off until you turn them on, and the few
that stay on are bounded.

For the full trust analysis, read the [threat model](/security/threat-model/).
This page is the working summary.

## Capabilities

Tools are grouped into capability categories, resolved once at server start. A
tool whose capability is disabled returns a structured error when called.

The default set is:

```
read, navigation, action, human
```

Off by default, each opted in deliberately:

- `eval` enables `eval_js` and `poll_eval`, which run arbitrary JavaScript in
  the page.
- `byob-attach` allows attaching to an externally launched Chrome.
- `network-body` exposes full response bodies.
- `clipboard` enables the OS-clipboard side effect of the `shortcut` tool.
  Observation still works without it.
- `file-io` enables `upload_file` and the file-picker write path.
- `secrets` enables the per-session sensitive-data registry and egress masking.
- `extensions` enables per-session unpacked-extension management (headed and
  persistent only).

Because capabilities resolve at server start, changing them means restarting
the server.

## Origin policy

Navigation can be scoped with an allow list and a block list
(`allowedOrigins`, `blockedOrigins`), with wildcard support such as
`https://*.example.com`. The block list overrides the allow list. An
off-allowlist navigation routes through the confirmation hook if one is set, or
proceeds with a warning if not.

Treat the origin policy as defense in depth, not a hard security boundary. The
[threat model](/security/threat-model/) is explicit about where the real
boundaries are.

## Confirmation hooks

Sensitive actions can route through a human confirmation before they dispatch.
The `confirmRequired` set selects which policy hooks ask first. Valid hooks are
`navigate_off_allowlist`, `file_download`, `file_upload`, and `byob_action`;
the default is `navigate_off_allowlist` and `byob_action`. Each routes through
the `await_human` mechanism, which is human-paced and hard-capped so it can
never wait forever.

## The anti-wedge deadline

Every action body, every `eval_js`, and the read paths
(`snapshot`, `find`, `text_search`, `inspect`) run under a hard deadline,
`actionTimeoutMs`, default 5000 ms. A wedged page operation returns a
structured `ok:false` anti-wedge failure within the deadline instead of
stalling forever. The orphaned operation cannot be cancelled, but the agent is
unblocked.

An action that needs more than five seconds is almost always a no-op or a
wedged page op. Raise the per-call `timeoutMs` only for one specific known-slow
call, never as a blanket.

## The dangerous opt-ins

A few knobs are sharp enough to call out directly:

- `eval` runs arbitrary page JavaScript. It is the widest surface; leave it off
  unless a flow genuinely needs it.
- `network-body` exposes full response bodies, which can carry secrets.
- `disableWebSecurity` turns off the same-origin policy and CORS for managed and
  incognito sessions. It is `false` by default, it cannot be set from any
  environment variable, and it warns loudly at boot and per launch. Use it only
  against test or dev targets.

The one rule that holds across all of it: page text is untrusted. An agent must
never treat text inside a snapshot, a find result, or a network body as
instructions to itself.
