---
title: Configuration
description: How browxai resolves config across layers, the keys you can set, and the legacy BROWX_ environment variables kept for compatibility.
---

browxai is configured through an MCP-managed config store, so no hand-edited
files are required. You read and write config with tools, and it takes effect for
sessions opened after the change.

Enabling a capability is the exception. It needs `BROWX_CAPABILITIES` in the
server's environment, because a saved list can only narrow it.

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
  `blockedOrigins`, `disableWebSecurity`, `plugins`, `chromiumSandbox`) can only be tightened
  through config. The server's environment is the ceiling; a loosening patch is
  refused and a loosening saved value is ignored at start with a warning.
- With `BROWX_CONFIG_READONLY=1` in the server's environment, `set_config`,
  `reset_config` and `approve_actions` are not registered at all, and the store
  refuses writes.

A `session` scope is set per call through `open_session`, and wins over the
persisted layers for that session only.

## Config keys

| Key                                 | What it does                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testAttributes`                    | HTML attributes treated as tier-1 selector anchors. Order-sensitive: the first match on a node wins.                                                                                   |
| `capabilities`                      | Narrows the enabled capability set. `BROWX_CAPABILITIES` is the ceiling; a saved list can drop capabilities, never add.                                                                |
| `confirmRequired`                   | Which policy hooks route through human confirmation before dispatch.                                                                                                                   |
| `allowedOrigins` / `blockedOrigins` | Origin allow and block lists for `navigate`. Wildcards allowed; block overrides allow. An off-list navigation waits for a person to confirm.                                           |
| `headless`                          | Launch managed Chrome headless.                                                                                                                                                        |
| `channel`                           | Playwright browser channel for chromium sessions (`chrome`, `msedge`, `chromium`, …). Unset launches the installed Chrome, or the bundled Chromium when it is absent.                  |
| `defaultDevice` / `defaultViewport` | Applied when `open_session` does not specify a device or viewport.                                                                                                                     |
| `actionTimeoutMs`                   | The anti-wedge hard deadline on every action and read path. Default 5000.                                                                                                              |
| `disableWebSecurity`                | Turn off the same-origin policy and CORS for managed and incognito sessions. Dangerous; off by default.                                                                                |
| `hideOverlaySelectors`              | CSS selectors for chrome or overlay elements to neutralize non-destructively on every navigation.                                                                                      |
| `plugins`                           | Plugin names to load. A saved list is a subset of `BROWX_PLUGINS`, and a change applies on the next server start.                                                                      |
| `toolList`                          | Which tools `tools/list` reports: `enabled` (default), only the tools the server can run, or `all`, every tool. Read once at server start.                                             |
| `toolProfile`                       | How many tools `tools/list` reports: `full` (default) or `core`, a set of 24 tools plus plugin tools plus `tool_catalog`. Read once at server start.                                   |
| `chromiumSandbox`                   | Chromium's OS sandbox for browsers browxai launches: `auto` (default) turns it on when the host supports it, `on` requires it, `off` launches without it. Applies to the next session. |
| `unstable`                          | A free-form namespace for experimental knobs. Not stable across versions.                                                                                                              |

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
<summary><code>toolList</code></summary>

**`toolList`** is `enabled` by default: `tools/list` shows only the tools this server can run, so a tool whose capability is off is not listed. That makes the listing smaller for the model: with the default capabilities it is 163 tools instead of 209. Set it to `all` to list everything, including the tools whose capability is off. A tool that is left out still returns the same refusal and hint when called by name, which says how to enable it. Before 0.18.0 the default was `all`. Plugin tools follow the capability their plugin declared. Capabilities are read once at server start, so the listing does not change while the server runs, and `toolList` is read once at start too: a saved change applies after a restart, and `get_config` shows the pending difference. The environment form is `BROWX_TOOL_LIST`.

</details>

<details>
<summary><code>toolProfile</code></summary>

**`toolProfile`** is `full` by default, which adds no limit of its own: `toolList` decides which tools `tools/list` reports. Set it to `core` and the listing holds 24 tools for the observe, locate, act and verify loop (`navigate`, `go_back`, `snapshot`, `find`, `text_search`, `inspect`, `extract`, `screenshot`, `console_read`, `network_read`, `click`, `fill`, `fill_form`, `select`, `hover`, `press`, `scroll`, `wait_for`, `verify_text`, `verify_visible`, `verify_count`, `close_session`, `list_sessions` and `batch`), every plugin tool, and `tool_catalog`. That is a much smaller listing for the model to carry. `tool_catalog` returns the tools the listing leaves out, grouped by capability, with a one-line summary each. With no argument that reply is 35,285 characters (about 8,800 tokens, 185 tools, measured on 0.19.0), so pass `capability` with one group name (a capability name, `none` or `plugin`) to get only that group. An unknown name answers with an error that lists the valid groups and how many tools each holds. The core listing itself measured 46,473 characters (25 tools, about 11,600 tokens) against 204,946 for the default `enabled` listing. `open_session` is not in the core set, because any tool with a `session` argument creates that session on first use.

The profile changes what is listed and nothing else. A tool it leaves out still answers a call by name, through the same capability gate, with the same refusal and hint. It composes with `toolList`: the capability filter runs first and the profile narrows the result, so `core` with `toolList` set to `all` still lists a core tool whose capability is off. A client that only sends tool names it saw in `tools/list` cannot call a name `tool_catalog` shows it, and needs `full`. Like `toolList`, `toolProfile` is read once at start: a saved change applies after a restart, and `get_config` shows the pending difference. The environment form is `BROWX_TOOL_PROFILE`, and an unknown value stops the server at start.

</details>

<details>
<summary><code>chromiumSandbox</code></summary>

**`chromiumSandbox`** is `auto` by default. Playwright launches Chromium with `--no-sandbox` unless it is asked for the sandbox, and `auto` asks for it when the process is not root, is not in a container and the host supports it (macOS, Windows, and Linux; the bundled Chromium and the headless shell also need user namespaces with no AppArmor policy restricting them, while an installed Chrome is tried regardless). On any other host `auto` launches with `--no-sandbox` and logs one warning that says why. If a launch fails on the sandbox, browxai retries once without it, logs a warning, and skips the sandbox for later launches in that process. On Windows there is no launch-time failure signal for a restricted environment (a Server Core container, a service account), so if pages crash there set `off`. Windows is not verified. `on` requires the sandbox, so a launch that cannot start it fails with an error that says what to change: `BROWX_CHROMIUM_SANDBOX=off`, or removing `chromiumSandbox` from `config.json` when the `on` was saved there. `off` launches without it and logs no warning, which is the setting for a container you mean to run that way.

It is a policy key. `set_config` can raise it toward `on` and cannot lower it below what the server's environment sets, which is `auto` when `BROWX_CHROMIUM_SANDBOX` is unset. Turning the sandbox off is an environment edit. It applies to the next `open_session`, with no restart. It covers browsers browxai launches through Playwright and not `browxai chrome start`, an attached Chrome, Android, Safari, Electron, Firefox or WebKit. `browxai doctor` has a `chromium-sandbox` row that shows what a host got.

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
- `BROWX_CONFIRM_REQUIRED`, default `navigate_off_allowlist,byob_action`. Policy hooks that route through human confirmation. Two hooks fire: `navigate_off_allowlist` and `byob_action`. The names `file_download` and `file_upload` are accepted but reserved: no tool consults them yet.
- `BROWX_ALLOWED_ORIGINS`, unset. Allow list for `navigate`, as full origins: `https://app.example.com`, `https://*.example.com` (subdomains, not the bare domain). No port means the scheme default only; a port matches that port. `navigate` checks the landed URL too.
- `BROWX_BLOCKED_ORIGINS`, unset. Block list; overrides the allow list. Ports match as for the allow list.
- `BROWX_CHANNEL`, unset. Playwright browser channel for chromium sessions. Unset uses the installed Chrome, else the bundled build.
- `BROWX_FIREFOX_CHANNEL`, unset. The same knob for Firefox sessions.
- `BROWX_AUTOMATION_SWITCH`, unset. `1` or `true` restores Playwright's `--enable-automation` switch on chromium launches.
- `BROWX_DEFAULT_PROFILE`, unset. Absolute path of the workspace default profile directory, in place of `<workspace>/profile`. Persistent sessions with no `profile`, `browxai chrome start` and `chrome login` all use it.
- `BROWX_HIDE_OVERLAY_SELECTORS`, unset. Comma-separated CSS selectors for the `hideOverlaySelectors` key.
- `BROWX_DISABLE_WEB_SECURITY`, unset. `1` or `true` launches managed and incognito sessions with the same-origin policy and CORS off. The only way to turn it on.
- `BROWX_PLUGINS`, unset. Plugin names a saved `plugins` config list may name. `plugins.json`, written by `browxai plugin install`, is unaffected.
- `BROWX_TOOL_LIST`, default `enabled`, which makes `tools/list` report only the tools whose capability is on. `all` lists every tool. A call by name to an unlisted tool still returns the capability refusal and hint.
- `BROWX_CHROMIUM_SANDBOX`, default `auto`. `auto`, `on` or `off`: whether Chromium's OS sandbox is on for browsers browxai launches. `auto` turns it on when the process is not root, not in a container and the host supports it, and otherwise launches with `--no-sandbox` and one warning. An unknown value stops the server at start.
- `BROWX_TOOL_PROFILE`, default `full`. `core` makes `tools/list` report 24 core tools, plugin tools and `tool_catalog`. Every other tool stays callable by name through the same capability gate.
- `BROWX_CONFIG_READONLY`, unset. `1` or `true` leaves out the write tools and refuses config writes.
- `BROWX_CREDENTIAL_ORIGINS`, unset. Origins each `get_credential` account may be typed into, as `acct=https://app.example.com|https://sso.example.com,other=host`. `get_credential` refuses an account that is not listed, before the vault is asked. An entry that does not parse is ignored with a startup warning. Read at start.

For every key and variable, see
[CLI and configuration](/reference/tool-reference/cli-and-configuration/) in the
tool reference. Session options are in its
[Sessions](/reference/tool-reference/sessions/) section.
