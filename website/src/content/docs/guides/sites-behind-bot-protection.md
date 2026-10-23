---
title: Sites behind bot protection
description: What browxai does and does not do for sites that gate access with bot protection, and the human sign-in flow for strict challenges.
---

Some sites put a bot-protection layer (a Cloudflare challenge, Turnstile and
similar) in front of the page. browxai does not defeat or spoof bot detection.
It patches no fingerprint, runs no token service and bundles no solver, and it
cannot guarantee access to any site. One optional tool, `solve_captcha`, sends a
captcha to a third-party solving service that you configure and pay for. It is
off by default and described [at the end of this page](#captcha-solving-through-a-third-party-service-off-by-default).
A site's terms of use apply to what you drive against it. What follows is how to
run a normal browser and how to hand the one step a person has to do to a person.

## Light protection: a regular Chrome

By default a chromium session launches the installed Google Chrome, and drops
Playwright's `--enable-automation` switch. Playwright's bundled testing build
launched with that switch reports `navigator.webdriver` as true and lacks
components a real Chrome carries, and lighter protection flags exactly that.
With no `channel` set you get the regular Chrome automatically; if Chrome is not
installed browxai falls back to the bundled Chromium and logs a warning saying
so. `channel: "chromium"` pins the bundled build, and `BROWX_AUTOMATION_SWITCH=1`
puts the automation switch back for debugging.

That is all it changes. browxai adds no `--disable-blink-features` flag, does
not patch `navigator`, injects no script to hide the debugger and does not
rewrite the user agent.

## Strict challenges: clear them by hand, then continue

Strict managed challenges and Turnstile also probe for an attached CDP client.
While browxai drives the browser it is attached, so these may not pass
automated. Do the challenge once with nothing attached, and let the profile keep
the result.

1. Quit any Chrome using the profile, and close the browxai session on it. A
   profile is open in one Chrome at a time.
2. Run `browxai chrome login --url https://the-site.example/`. It opens the
   installed Chrome on the workspace's default profile (the one persistent
   sessions use; add `--profile NAME` for `profiles/NAME`) with no remote
   debugging port and no automation flags.
3. Clear the challenge and sign in by hand.
4. Quit that Chrome completely. The cookies are written and the profile is
   released only on quit.
5. Open a persistent session on the same profile (`open_session({ mode:
"persistent" })`, or the same `profile` name) and navigate. The clearance
   and session cookies are in the profile, so the automated run reuses them.

Clearance cookies expire and may be tied to the browser and network they were
issued to, so a later run can meet the challenge again. Repeat the steps.

`browxai chrome start` uses the same installed Chrome and the same profile, with
a debug port, when you want to attach with `BROWX_ATTACH_CDP` instead.

## Handoffs inside a session

When a challenge appears mid-run, `ActionResult.challenge` names it. The
`await_human` tool pauses the run and lets a person clear it in the live browser,
then the run continues. Use it for one-off gates; use `chrome login` for a
profile you want to keep signed in.

## Captcha solving through a third-party service (off by default)

The `captcha` capability registers `solve_captcha`. It is not in the default set
(`read`, `navigation`, `action`, `human`), and enabling it logs a warning at
server start that names the terms-of-service exposure. Solving captchas may break
a site's terms and, depending on where you are, computer-misuse law. You carry
that exposure.

browxai bundles no solver, so the tool needs an account with one of two services:
2Captcha or CapMonster. Set `BROWX_CAPTCHA_PROVIDER` (`2captcha` or `capmonster`)
and `BROWX_CAPTCHA_API_KEY` in the server's environment, both together.
`BROWX_CAPTCHA_API_BASE`, `BROWX_CAPTCHA_TIMEOUT_MS` (default 120000) and
`BROWX_CAPTCHA_POLL_MS` (default 5000) are optional. browxai never buys credits.
With the capability on and no provider set, the tool returns `ok:false` and sends
nothing.

What leaves your machine on a call: the API key, the URL of the current page,
and the widget's site key, or the image bytes for an `image` captcha. They go to
the provider's API (`https://2captcha.com` or `https://api.capmonster.cloud`
unless you override the base URL). Cookies, page content and screenshots are not
sent. The provider solves on its own infrastructure, and browxai polls it until
an answer arrives or the timeout passes.

`solve_captcha` takes a `type` (`recaptcha2`, `recaptcha3`, `hcaptcha`,
`turnstile` or `image`) plus a `siteKey`, or a `selector` whose element carries
`data-sitekey`. It returns `{ ok, provider, solution, taskId, elapsedMs }`. It
does not submit anything: you put the token into the page yourself, and how that
works differs per site. It does not read `ActionResult.challenge`.

For a gate you want a person to clear, use `await_human` or the `chrome login`
flow above. The [tool reference](/reference/tool-reference/) has the full
contract, and the [threat model](/security/threat-model/) has the posture row.
