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
- The policy keys (`capabilities`, `confirmRequired`, `allowedOrigins`,
  `blockedOrigins`, `disableWebSecurity`, `plugins`) can only be tightened
  through config. The server's environment is the ceiling; a loosening patch is
  refused and a loosening saved value is ignored at start with a warning.
- With `BROWX_CONFIG_READONLY=1` in the server's environment, `set_config`,
  `reset_config` and `approve_actions` are not registered at all, and the store
  refuses writes.

A `session` scope is set per call through `open_session`, and wins over the
persisted layers for that session only.

## Config keys

| Key                                 | What it does                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testAttributes`                    | HTML attributes treated as tier-1 selector anchors. Order-sensitive: the first match on a node wins.                                                                  |
| `capabilities`                      | Narrows the enabled capability set. `BROWX_CAPABILITIES` is the ceiling; a saved list can drop capabilities, never add.                                               |
| `confirmRequired`                   | Which policy hooks route through human confirmation before dispatch.                                                                                                  |
| `allowedOrigins` / `blockedOrigins` | Origin allow and block lists for `navigate`. Wildcards allowed; block overrides allow. An off-list navigation waits for a person to confirm.                          |
| `headless`                          | Launch managed Chrome headless.                                                                                                                                       |
| `channel`                           | Playwright browser channel for chromium sessions (`chrome`, `msedge`, `chromium`, …). Unset launches the installed Chrome, or the bundled Chromium when it is absent. |
| `defaultDevice` / `defaultViewport` | Applied when `open_session` does not specify a device or viewport.                                                                                                    |
| `actionTimeoutMs`                   | The anti-wedge hard deadline on every action and read path. Default 5000.                                                                                             |
| `disableWebSecurity`                | Turn off the same-origin policy and CORS for managed and incognito sessions. Dangerous; off by default.                                                               |
| `hideOverlaySelectors`              | CSS selectors for chrome or overlay elements to neutralize non-destructively on every navigation.                                                                     |
| `plugins`                           | Plugin names to load. A saved list is a subset of `BROWX_PLUGINS`, and a change applies on the next server start.                                                     |
| `unstable`                          | A free-form namespace for experimental knobs. Not stable across versions.                                                                                             |

### A few keys worth understanding

Each key opens to the details that the table leaves out.

<details>
<summary><code>actionTimeoutMs</code></summary>

**`actionTimeoutMs`** applies to every action body, `eval_js`, and the read CDP paths. The default of 5000 ms is deliberate: an action that needs longer is almost always a no-op or a wedged page op. Every action and read tool also takes a per-call `timeoutMs` override; raise that for one known-slow call. The value is clamped to a one-hour ceiling.

</details>

<details>
<summary><code>allowedOrigins</code> and <code>blockedOrigins</code></summary>

**`allowedOrigins`** and **`blockedOrigins`** do not refuse a navigation by themselves. A `navigate` to an origin off the allow list, or on the block list, hits the `navigate_off_allowlist` confirmation hook, which is on by default. A person then has five minutes to answer `__browx.confirm(true)` in the DevTools `browxai` console context, and the call fails if nobody does. A headless server has nobody to answer. Leaving `navigate_off_allowlist` out of `BROWX_CONFIRM_REQUIRED` lets those navigations through with a logged warning, which turns the lists into a warning in the log.

</details>

<details>
<summary><code>disableWebSecurity</code></summary>

**`disableWebSecurity`** is turned on only by the operator, with `BROWX_DISABLE_WEB_SECURITY=1` in the server's environment. `set_config` can turn it off and never on, because the agent can call `set_config`. It applies to managed and incognito sessions; an attached Chrome keeps whatever flags it was launched with.

</details>

<details>
<summary><code>channel</code></summary>

**`channel`** picks which browser binary a chromium session launches. Unset, you get the installed Google Chrome, and the bundled Chromium with a logged warning when Chrome is not installed. Set it to `chromium` to pin the bundled build, or to `msedge` or `chrome-beta` for that installed browser, which then must exist: browxai does not download it. The browser version follows the install and may differ from the version browxai pins. Chrome runs without Playwright's `--enable-automation` switch; `BROWX_AUTOMATION_SWITCH=1` restores it. Firefox has its own `BROWX_FIREFOX_CHANNEL`; WebKit, Safari and Android ignore the key. Override per session with `open_session({ channel })`.

</details>

<details>
<summary><code>hideOverlaySelectors</code></summary>

**`hideOverlaySelectors`** injects a CSS-only init script that applies `pointer-events: none; display: none` to matches on every navigation. It is non-destructive (no node removal, so assertions still see the DOM) and uses no agent JavaScript. Prefer it over hand-rolled per-session removal.

</details>

## Legacy environment variables

The `BROWX_*` variables below still work as a compatibility layer, one notch
above built-in defaults and below the user and project layers. They are
documented but no longer the recommended path. `BROWX_WORKSPACE` is the
exception: it anchors where the config store itself lives, so it is a location,
not config.

- `BROWX_WORKSPACE`, default `~/.browxai/`. Workspace root. All transient state lives here. Never `cwd`.
- `BROWX_ATTACH_CDP`, unset. Attach to an externally launched Chrome over CDP (BYOB). Loopback hostnames only. Needs `byob-attach`.
- `BROWX_HEADLESS`, default `0`. Managed mode only. `1` or `true` launches headless.
- `BROWX_TEST_ATTRIBUTES`, default `data-testid,data-test,data-cy,data-qa`. Selector-anchor attributes, order-sensitive.
- `BROWX_CAPABILITIES`, default `read,navigation,action,human`. The full capability set at server start. It replaces the default set, so list the defaults too.
- `BROWX_CONFIRM_REQUIRED`, default `navigate_off_allowlist,byob_action`. Policy hooks that route through human confirmation. Valid hooks: `navigate_off_allowlist`, `file_download`, `file_upload`, `byob_action`.
- `BROWX_ALLOWED_ORIGINS`, unset. Allow list for `navigate`, as full origins: `https://app.example.com`, `https://*.example.com` (subdomains, not the bare domain). No port means the scheme default only; a port matches that port. `navigate` checks the landed URL too.
- `BROWX_BLOCKED_ORIGINS`, unset. Block list; overrides the allow list. Ports match as for the allow list.
- `BROWX_CHANNEL`, unset. Playwright browser channel for chromium sessions. Unset uses the installed Chrome, else the bundled build.
- `BROWX_FIREFOX_CHANNEL`, unset. The same knob for Firefox sessions.
- `BROWX_AUTOMATION_SWITCH`, unset. `1` or `true` restores Playwright's `--enable-automation` switch on chromium launches.
- `BROWX_DEFAULT_PROFILE`, unset. Absolute path of the workspace default profile directory, in place of `<workspace>/profile`. Persistent sessions with no `profile`, `browxai chrome start` and `chrome login` all use it.
- `BROWX_HIDE_OVERLAY_SELECTORS`, unset. Comma-separated CSS selectors for the `hideOverlaySelectors` key.
- `BROWX_DISABLE_WEB_SECURITY`, unset. `1` or `true` launches managed and incognito sessions with the same-origin policy and CORS off. The only way to turn it on.
- `BROWX_PLUGINS`, unset. Plugin names a saved `plugins` config list may name. `plugins.json`, written by `browxai plugin install`, is unaffected.
- `BROWX_CONFIG_READONLY`, unset. `1` or `true` leaves out the write tools and refuses config writes.
- `BROWX_CREDENTIAL_ORIGINS`, unset. Origins each `get_credential` account may be typed into, as `acct=https://app.example.com|https://sso.example.com,other=host`. `get_credential` refuses an account that is not listed, before the vault is asked. An entry that does not parse is ignored with a startup warning. Read at start.

For the complete configuration and session surface, see the
[tool reference](/reference/tool-reference/).
