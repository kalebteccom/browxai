---
title: Troubleshooting
description: The error strings browxai prints, what each one means, and the fix.
---

Start with `browxai doctor`. It checks Node, the browser, the workspace and your
configuration, and prints a fix next to anything that fails.

## A session will not open

The error mentions a browser. Run `browxai doctor`. It says whether Google
Chrome and the bundled Chromium are present. Install Chrome, or fetch Chromium:

```bash
npx playwright-core@1.64.1 install chromium
```

On a machine with no display, such as a server or a container, the first
headed session fails. Set `BROWX_HEADLESS=1` in the server's environment.

## A tool is disabled

```text
tool "eval_js" is disabled: its capability "eval" is not enabled on this server
```

The capability is off. Add it to `BROWX_CAPABILITIES`, keep the four defaults in
the list, and restart the server:

```bash
BROWX_CAPABILITIES=read,navigation,action,human,eval
```

The server reads capabilities once, at start. `set_config` cannot turn one on.
If it stays off after a restart, run `reset_config` to clear a saved list that
leaves it out. More in [Configuring](/security/threat-model/#configuring).

## `capability-required`

```text
capability-required: session "default": mode "attached" on engine "chromium" ...
```

Attaching to your own Chrome needs `byob-attach`. The `android-app` and
`ios-app` engines need `native-device`. Both are off by default. Add the
capability as above and restart. What each one grants is in
[The capability set](/security/threat-model/#the-capability-set).

## `profile-in-use`

```text
profile-in-use: session "b" cannot launch on the workspace default profile ...
```

One browser can hold a profile at a time. Another session, or a Chrome started
with `browxai chrome start` or `browxai chrome login`, has it open. Do one of
these:

- Quit that Chrome, or `close_session` the other session.
- Pass `profile: "name"` to `open_session`.
- Use `mode: "incognito"`.

## `invalid-name`

```text
invalid-name: profile "../x" is not a plain name ...
```

Session ids and profile names are plain names: letters, digits, `.`, `_` and
`-`, starting with a letter or digit, at most 128 characters. No slashes and no
`..`.

## `origin-blocked`

```text
origin-blocked: service worker sw-1 (https://example.com/sw.js) is on an origin ...
```

The origin policy does not allow that origin, so browxai did not message the
worker. Add the origin to `BROWX_ALLOWED_ORIGINS`, or remove it from
`BROWX_BLOCKED_ORIGINS`, and restart. Each entry needs a scheme:
`https://app.example.com`, not `app.example.com`. A bare host stops the server at
start. Matching rules are in [Origin allow/blocklist](/security/threat-model/#origin-allowblocklist).

## `electron-launch-not-supported`

browxai attaches to a desktop app. It does not launch one. Start the app with a
loopback debugging port, then point browxai at it:

```bash
/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9333
BROWX_ATTACH_CDP=http://127.0.0.1:9333
```

You also need `byob-attach` in `BROWX_CAPABILITIES`. That port has no
authentication while the app runs, and the app holds a logged-in session.

## A site shows a challenge page

browxai does not defeat or spoof bot detection, so it cannot clear the
challenge. `browxai chrome login` opens the same Chrome profile with nothing
attached, so you can clear it by hand. See
[Sites behind bot protection](/guides/sites-behind-bot-protection/).
