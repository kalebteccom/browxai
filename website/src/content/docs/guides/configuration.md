---
title: Configuration
description: How browxai resolves config across layers, the keys you can set, and the legacy BROWX_ environment variables kept for compatibility.
---

browxai is configured through an MCP-managed config store. No environment
variables and no hand-edited files are required. You read and write config with
tools, and it takes effect for sessions opened after the change.

## Precedence

Config resolves across layers, lowest to highest:

```
built-in defaults  <  env (legacy BROWX_*)  <  user  <  project  <  session (open_session)
```

- `get_config({ scope? })` returns the resolved merged view by default. Pass a
  `scope` of `defaults`, `env`, `user`, `project`, `session`, or `resolved` to
  read one raw layer.
- `set_config({ scope: "user" | "project", patch })` is the only supported way
  to persist config. It writes `config.json` under the workspace, which is
  machine-managed (do not hand-edit it). Arrays replace; the `unstable.*`
  namespace shallow-merges. Changes apply to sessions opened after the call.
- `reset_config({ scope: "user" | "project" })` clears that persistent layer.

A `session` scope is set per call through `open_session`, and wins over the
persisted layers for that session only.

## Config keys

| Key                                 | What it does                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `testAttributes`                    | HTML attributes treated as tier-1 selector anchors. Order-sensitive: the first match on a node wins.    |
| `capabilities`                      | The enabled capability set. See [Capabilities and safety](/concepts/capabilities-and-safety/).          |
| `confirmRequired`                   | Which policy hooks route through human confirmation before dispatch.                                    |
| `allowedOrigins` / `blockedOrigins` | Origin allow and block lists for `navigate`. Wildcards allowed; block overrides allow.                  |
| `headless`                          | Launch managed Chromium headless.                                                                       |
| `defaultDevice` / `defaultViewport` | Applied when `open_session` does not specify a device or viewport.                                      |
| `actionTimeoutMs`                   | The anti-wedge hard deadline on every action and read path. Default 5000.                               |
| `disableWebSecurity`                | Turn off the same-origin policy and CORS for managed and incognito sessions. Dangerous; off by default. |
| `hideOverlaySelectors`              | CSS selectors for chrome or overlay elements to neutralize non-destructively on every navigation.       |
| `unstable`                          | A free-form namespace for experimental knobs. Not stable across versions.                               |

### A few keys worth understanding

**`actionTimeoutMs`** applies to every action body, `eval_js`, and the read CDP
paths. The default of 5000 ms is deliberate: an action that needs longer is
almost always a no-op or a wedged page op. Every action and read tool also
takes a per-call `timeoutMs` override; raise that for one known-slow call
rather than raising the global default. The value is clamped to a one-hour
ceiling.

**`disableWebSecurity`** cannot be set from any environment variable. Set it
only through `set_config` or the managed config file, so it can never be
ambiently enabled. It applies to managed and incognito sessions; an attached
Chrome keeps whatever flags it was launched with.

**`hideOverlaySelectors`** injects a CSS-only init script that applies
`pointer-events: none; display: none` to matches on every navigation. It is
non-destructive (no node removal, so assertions still see the DOM) and uses no
agent JavaScript. Prefer it over hand-rolled per-session removal.

## Legacy environment variables

The `BROWX_*` variables below still work as a compatibility layer, one notch
above built-in defaults and below the user and project layers. They are
documented but no longer the recommended path. `BROWX_WORKSPACE` is the
exception: it anchors where the config store itself lives, so it is a location,
not config.

| Env var                  | Default                                 | What                                                                              |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------- |
| `BROWX_WORKSPACE`        | `~/.browxai/`                           | Workspace root. All transient state lives here. Never `cwd`.                      |
| `BROWX_ATTACH_CDP`       | unset                                   | Attach to an externally launched Chrome over CDP (BYOB). Loopback hostnames only. |
| `BROWX_HEADLESS`         | `0`                                     | Managed mode only. `1` launches headless.                                         |
| `BROWX_TEST_ATTRIBUTES`  | `data-testid,data-test,data-cy,data-qa` | Selector-anchor attributes, order-sensitive.                                      |
| `BROWX_CAPABILITIES`     | `read,navigation,action,human`          | Capability categories enabled at server start.                                    |
| `BROWX_CONFIRM_REQUIRED` | `navigate_off_allowlist,byob_action`    | Policy hooks that route through human confirmation.                               |
| `BROWX_ALLOWED_ORIGINS`  | unset                                   | Allow list for `navigate`. Wildcards allowed.                                     |
| `BROWX_BLOCKED_ORIGINS`  | unset                                   | Block list; overrides the allow list.                                             |

For the complete configuration and session surface, see the
[tool reference](/reference/tool-reference/).
