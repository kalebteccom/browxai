# Best practices for adopters

This page lists the operational practices we recommend for teams integrating browxai. The rationale behind each practice is summarised inline; the threat model behind them lives in [docs/threat-model.md](./threat-model.md).

## Install

- `npm install browxai --ignore-scripts` — browxai has no install-time scripts; the flag enforces it as defense in depth.
- Pin exact versions in `package.json` for high-assurance deployments (`"browxai": "1.2.3"`, not `^1.2.3`).
- Commit your lockfile. Use `npm ci` or `pnpm install --frozen-lockfile` in CI; never loose `install`.

## Verify

- After install: `npm audit signatures` verifies the published provenance.
- Watch GitHub Security Advisories on `kalebteccom/browxai`.
- The `browxai doctor` subcommand verifies the local `dist/` matches the attested build (lands in v1.0).

## Capability posture

browxai ships off-by-default for posture-broadening capabilities (`eval`, `byob-attach`, `extensions`, `device-emulation`, `secrets`, `network-body`, `file-io`). Enabling any of these is opt-in to a broader risk surface. Read `docs/threat-model.md` before enabling a capability.

The capability gate documents what a tool is allowed to reach. It does not contain a tool that has reached it.

## Plugin trust

Plugins are in-process JS modules with full Node access. Treat plugin adoption like a dependency review:

- Prefer `@browxai/*` first-party plugins (and the bare `browxai` host package).
- For third-party plugins, check the registry trust tier.
- Read `docs/plugin-governance.md` for the trust tier policy.

## CI hygiene for adopter pipelines

If you integrate browxai into your own CI:

- Pin every GitHub Action by full SHA.
- Use `permissions: {}` at workflow level; elevate per-job only.
- Avoid third-party GitHub Apps that require org-wide write access.
- Use `npm ci --ignore-scripts` in CI as a baseline.
