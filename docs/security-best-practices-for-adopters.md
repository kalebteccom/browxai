# Best practices for adopters

Operational practices for teams integrating browxai. Each practice carries its rationale inline; the full analysis lives in [the threat model](/threat-model/).

## Install

- `npm install browxai --ignore-scripts`: browxai has no install-time scripts; the flag enforces it as defense in depth.
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
- For a third-party plugin, read what it declares (`browxai plugin info <pkg>`) and audit the live set with `plugins_list`.
- Read [plugin governance](/plugin-governance/) for what the trust tier does and does not tell you.

The trust tier is a label describing where code came from. It is not enforcement: the loader gates every tier identically, and nothing intercepts a plugin's calls to check it only touches what it declared. A plugin runs in the host process with the host's permissions.

## Run it in a container

This is the one control on this page that is a boundary rather than a policy.

Everything else browxai ships (capability gates, the origin allow/blocklist, confirmation hooks, trust tiers) is administrative. It governs what the tool surface will do on request. None of it constrains what already-running code in the host process can reach, because none of it can: the process has whatever the OS gave it. A capability gate documents what a tool is allowed to reach. It does not contain a plugin that has reached past it.

So for any deployment where you did not write every plugin yourself, or where an off-by-default capability is on, put the process inside something the OS enforces:

- Run in an ephemeral container or VM. [`deploy/Dockerfile`](https://github.com/kalebteccom/browxai/blob/main/deploy/Dockerfile) is a working starting point: Playwright's base image, a non-root user, `--ignore-scripts`, and a workspace volume.
- Run as a non-root user. The reference Dockerfile already does.
- Give the container no route to your local network. A plugin or a page that reaches your internal services is the lateral-movement case, and network policy is where you stop it.
- Mount `$BROWX_WORKSPACE` as a volume so profiles, screenshots, downloads and diagnostics live outside the writable layer and can be inspected or discarded independently.
- Treat an authenticated profile inside the container as a live credential. It is one.

Node's `--permission` model is not a substitute here. It is process-wide, and browxai legitimately needs filesystem access for profiles and downloads plus child-process access to launch a browser, so the permissions that would matter are exactly the ones it must hold. Per-plugin restriction is not achievable while plugins are in-process; that would require out-of-process plugins, which the v1 runtime deliberately does not do.

## CI hygiene for adopter pipelines

If you integrate browxai into your own CI:

- Pin every GitHub Action by full SHA.
- Use `permissions: {}` at workflow level; elevate per-job only.
- Avoid third-party GitHub Apps that require org-wide write access.
- Use `npm ci --ignore-scripts` in CI as a baseline.
- Run browxai itself in a container in the pipeline. A CI runner is a machine with credentials on it, and hot-testing a branch means driving a browser at code that has not been reviewed yet.

## Deployment checklist

Before a browxai process handles anything you would mind losing:

- [ ] Running in a container or VM, not directly on the host.
- [ ] Non-root user.
- [ ] No route from the container to your internal network.
- [ ] `$BROWX_WORKSPACE` on a mounted volume, not the container's writable layer.
- [ ] Exact version pinned, lockfile committed, `--ignore-scripts` on install.
- [ ] `npm audit signatures` clean after install.
- [ ] Every enabled off-by-default capability has a reason someone can state out loud, checked against [the threat model](/threat-model/).
- [ ] Every installed plugin's declared capabilities reviewed via `plugins_list`.
- [ ] Any authenticated profile treated as a credential: not baked into an image, not committed, rotated when the container is.
