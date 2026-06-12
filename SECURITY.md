# Security Policy

browxai is an MCP-native browser-control server. Its threat surface is
shaped by two facts: it ships **no built-in code-execution surface** in
the default capability set, and every dangerous surface (filesystem,
arbitrary in-page evaluation, OS resources, persistence) lives behind an
**off-by-default capability gate**. This document tells you what we
will and will not commit to, and how to report a vulnerability.

## Supported versions

Security fixes are issued against the **latest minor** and (for
critical-only issues) the **previous minor**. Older minors are
end-of-life and receive no patches; upgrade.

| Version range                   | Support level                             |
| ------------------------------- | ----------------------------------------- |
| latest minor                    | Patches for any qualifying vulnerability. |
| previous minor                  | Critical only.                            |
| anything older                  | No support. Upgrade.                      |

(Pre-`1.0` releases carry no security guarantees, but reports are triaged
in good faith and fixes land on the active branch best-effort.)

"Critical" means: remote code execution, secrets exfiltration, capability
gate bypass, or workspace escape. Everything else is "qualifying."

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

**Primary channel:** GitHub Security Advisories. From the
[browxai repository](https://github.com/kalebteccom/browxai), open the
**Security** tab and choose **"Report a vulnerability"**. This creates a
private advisory thread visible only to you and the maintainers.

**Fallback channel:** email `security@kalebtec.com` with the subject
prefix `[browxai-security]`. Use this only if GitHub Security Advisories
is unavailable to you.

Please include:

- browxai version (output of `browxai --version` or `package.json`).
- Node version and OS.
- Capability set in effect (which capabilities were enabled).
- Minimal reproduction (a unit-style test, a keystone-style scenario, or
  a single `eval_js`-shaped invocation).
- Your assessment of impact and severity.

## What to expect

- **Acknowledgement:** within 48 business hours.
- **Initial assessment:** within 7 calendar days. We tell you whether
  the report is in scope, the severity we assign, and the patch path.
- **Critical patch target:** 30 days from confirmed report.
- **Lower-severity patch target:** 90 days from confirmed report.
- **Coordinated disclosure:** patch-then-disclose is the default. We
  publish the advisory once a fixed version is released and adopters
  have a window to upgrade. Embargo will not exceed 90 days from
  confirmed report without your written agreement.
- **Credit:** reporters are credited in the CHANGELOG entry and the
  GitHub Security Advisory by name and (optional) affiliation, unless
  you ask to be omitted.

## In scope

Reports against the following are in scope:

- **Capability gate bypass** — any path that lets a tool execute its
  dangerous side effect (arbitrary in-page evaluation, filesystem
  access, OS resource access, network mocking, persistence beyond
  session) when the corresponding capability was not granted by the
  host.
- **Secrets-masking sink leak** — secrets passed through any masking
  path appearing in any externally-visible sink (logs, MCP responses,
  artifacts, traces, recorded sessions).
- **Workspace-escape path traversal** — any tool reading or writing
  outside the configured workspace root via path traversal, symlink
  follow, or `..` segments.
- **MCP-handler input validation bypass** — any malformed MCP payload
  reaching tool internals past the schema boundary.
- **Plugin call-graph enforcement bypass** — any plugin invoking a
  host tool or capability it did not declare in its manifest.
- **In-page script injection outside the `eval_js` gate** — any path
  that ships agent-supplied code into the page that is not the documented
  `eval_js` tool behind the `eval` capability.

## Out of scope

The following are not browxai vulnerabilities:

- Vulnerabilities in upstream Playwright, Chromium, or Node.js that do
  not also have a browxai-specific code path. Report those to their
  respective projects.
- Findings that require an already-enabled dangerous capability —
  enabling `eval` and then executing arbitrary code is the documented
  contract of `eval_js`, not a vulnerability. The capability is the
  threat model boundary; once crossed, the host has consented.
- Social engineering, physical access, and denial-of-service via
  resource exhaustion on the adopter's own machine.
- Issues in adopter-side configuration (granting `eval` to untrusted
  agents, running browxai with elevated OS privileges, etc.).
- Issues in third-party plugins not published by Kalebtec. Report those
  to the plugin's maintainer.

## Trust posture — what we promise, what we do not, what we cannot prevent

**What we promise.** The published `browxai` package, installed from
npm with provenance verified (`npm audit signatures`), has no built-in
code-execution surface. All capability gates are **off by default**. No
lifecycle script runs at install time.

**What we DO NOT promise.** Enabling a capability gate (`eval`, `file-io`,
`network-body`, `extensions`, `byob-attach`, `device-emulation`,
`secrets`, `canvas`, etc.) is opt-in to adopter-side execution risk.
The capability gate is a **Schelling point**, not a sandbox. browxai
does not isolate or filter what runs once the gate is open. The host is
responsible for the trust posture of code, URLs, and inputs that pass
through it.

**What we cannot prevent.** If an adopter installs a typosquat
(`brwxai`, `browxa`, `browx-ai`, etc.) instead of `browxai`, our
defenses do not apply. Verify the package name before install; verify
provenance after install. See
[docs/security-best-practices-for-adopters.md](docs/security-best-practices-for-adopters.md).

## Plugin trust model

Plugins published under `@browxai/plugin-*` are reviewed and
released by the maintainer. Third-party plugins run **in-process with
full Node access** — there is no sandbox. The plugin trust tier
(`kalebtec`, `community`, `local`) signals the review
level the host has applied, not an isolation guarantee. See
[docs/plugin-governance.md](docs/plugin-governance.md) for the full
policy.

## Bug bounty

**None.** browxai is a solo-maintained MIT project with no hosted
offering and no monetisation. We cannot pay bounties. We can and do
credit reporters publicly (with consent) and coordinate disclosure
seriously.

## Bot allowlist policy

The repository enforces a strict GitHub App allowlist; bots commonly
installed for security scanning (Snyk, Sonatype, Mend, Socket.dev,
Codecov, etc.) are **not** installed and will not be invited. The
rationale: each installed App expands the trusted-write surface to a
third party whose own compromise becomes our compromise, and the
findings these tools surface are already covered by first-party CI
(`pnpm audit`, secret scanning, `zizmor`, license-checker, lockfile
lint). The full policy and the allowlist itself live in
`.github/BOT_ALLOWLIST.md`. Adding a new App that requires write access
requires explicit owner approval and a rationale entry in this file.
