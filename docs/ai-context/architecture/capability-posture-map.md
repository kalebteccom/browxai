# Capability posture map

Safe by default, with no auto-broadening. The gate returns a structured capability-required refusal (`requiredCapability` names the missing capability), never a silent no-op. `test/keystone/capability-denials.keystone.test.ts` asserts the refusal against a default-set server for `captcha`, `credentials`, `secrets`, `network-body`, `extensions`, `canvas`, `file-io` (the 13 tool-gated tools plus `screenshot({path})`), `diagnostics`, and, as behaviour branches, `clipboard` and `stealth`. The other capabilities are pinned by their own feature keystones or unit tests; check before assuming a capability has a denial keystone.

## Default-on capabilities

These are enabled. Withholding them reduces browxai to a read-only crawler.

| Capability   | Tools                                                                                        | Rationale                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `read`       | snapshot, find, text_search, inspect, console_read, network_read (metadata only), screenshot | Observation has no side effect on the page; safe to enable everywhere.                                                   |
| `navigation` | navigate, go_back, go_forward, scroll, set_viewport                                          | URL changes are visible to the agent and to the user.                                                                    |
| `action`     | click, fill, select, drag, hover, press, wait_for                                            | User-emulating actions; bounded by anti-wedge deadlines.                                                                 |
| `human`      | confirmation hooks, await_human                                                              | Pause-for-human is a safety lever, not a posture broadener. The answer comes only from the `browxai` CDP isolated world. |

## Off-by-default capabilities

Each requires explicit opt-in via `BROWX_CAPABILITIES` (env) or `createBrowxai({ capabilities })` (SDK). A loud warning is emitted on first activation.

| Capability            | Tools                                                                                                                        | Why off by default                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eval`                | `eval_js`, `poll_eval`                                                                                                       | Arbitrary JS in page context bypasses curated handlers.                                                                                                        |
| `network-body`        | full response bodies                                                                                                         | Response bodies often contain PII / secrets.                                                                                                                   |
| `byob-attach`         | attach to user's existing Chrome                                                                                             | Skips managed-profile isolation; touches user data.                                                                                                            |
| `clipboard`           | `shortcut` copy/cut/paste writes the OS clipboard (write-only, never read back)                                              | Cross-application data egress.                                                                                                                                 |
| `file-io`             | `upload_file`, downloads to workspace                                                                                        | Filesystem touch via the workspace chokepoint.                                                                                                                 |
| `secrets`             | `register_secret`, secret materialization at egress                                                                          | Secret values live in process memory; egress order matters.                                                                                                    |
| `credentials`         | `get_totp`, `get_credential` (the latter also needs `secrets`)                                                               | Shells out to an operator-supplied password-manager CLI; returns a TOTP code in plaintext.                                                                     |
| `extensions`          | install/inspect Chrome extensions                                                                                            | Extension code runs with elevated browser privileges.                                                                                                          |
| `stealth`             | anti-fingerprint posture tweaks                                                                                              | Posture is operator-chosen, never a default.                                                                                                                   |
| `captcha`             | captcha solver glue                                                                                                          | Third-party service integration.                                                                                                                               |
| `device-emulation`    | `emulate_bluetooth`, `emulate_usb`, `emulate_hid`, `device_requests`                                                         | Synthetic Web device catalogs: the page believes devices exist that do not.                                                                                    |
| `diagnostics`         | recorder, `diagnostics_note` (write side). `diagnostics_search`, `diagnostics_report`, `perf_audit` and the rest ride `read` | Captures session artifacts (workspace-scoped, but artifact-producing).                                                                                         |
| `canvas`              | canvas-app eval routing (figma / tldraw / excalidraw plugins)                                                                | Composes with `eval`; canvas-app plugins gate through this.                                                                                                    |
| `native-device`       | none (gates the `ios-app` / `android-app` engines at `open_session`)                                                         | Installs and launches apps and drives OS-level input on a simulator or emulator.                                                                               |
| `replay`              | `.browx` session-replay artifact capture (DOM + network + console)                                                           | Archive carries real page content; as sensitive as the session was.                                                                                            |
| `self-approval`       | `approve_actions`                                                                                                            | Lets the agent answer the confirm hooks meant to stop its own actions.                                                                                         |
| `human-gate-override` | none (gates a branch of `set_permission_policy` / `set_fs_picker_policy` / `set_notification_policy` / `open_session`)       | Lets the agent move a policy off `ask-human` and answer the prompt itself.                                                                                     |
| `operator-channel`    | none (routes `await_human` and the confirm hooks to the daemon socket)                                                       | Makes the daemon behind an operator-set socket the only answer path. `self-approval` and `human-gate-override` skip it, so booting with either logs a warning. |
| `live-view`           | none (the operator-socket daemon starts a screencast; frames go to that socket only)                                         | Needs `operator-channel`, or the server will not start. Masking does not cover pixels. The agent cannot start, stop or read it.                                |

## Composition rules

- A tool may require **multiple** capabilities. `get_credential` requires `credentials` and `secrets`; `screenshot({path})` adds `file-io` to its `read` gate. `poll_eval` is gated by `eval` alone. `canvas_query` requires `canvas` + the host adapter's declared capabilities.
- Capability composition is multiplicative: missing any required capability returns `capability-denied`.
- The gate is composed in `src/server.ts` at registration time. A handler MUST NOT inline its own capability check beyond calling the shared gate.

## Adding a new capability

1. Add the constant to `src/util/capabilities.ts` (default off).
2. Add the threat-model row in `docs/threat-model.md`.
3. Add the row in this file and in the `AGENTS.md` capability table.
4. Add the keystone test asserting the gate blocks when the capability is unset.
5. CHANGELOG entry under `## Unreleased ### Added`.

## Retirement

Deprecating a capability: see [`../release-process/retired-registry-pattern.md`](../release-process/retired-registry-pattern.md). The retired value is accepted with a warning until the next major; never deleted abruptly.

## Related

- [`../../threat-model.md`](../../threat-model.md): per-capability threat-model rows.
- [`../secrets-and-egress/network-body-and-secrets.md`](../secrets-and-egress/network-body-and-secrets.md): egress composition order.
