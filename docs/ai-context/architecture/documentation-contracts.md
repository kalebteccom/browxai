# Documentation contracts

browxai has three documentation surfaces with distinct contracts. Mixing them is a docs-impact bug.

## `docs/` — public adopter contract

VitePress-published to GitHub Pages. Source of truth for what browxai promises to its adopters.

- `docs/tool-reference.md` — every public tool: input / output shape, capability, ActionResult fields, defaults. Stability & semver section is the canonical pre-1.0 contract.
- `docs/threat-model.md` — per-capability security posture, threat rows, egress model.
- `docs/plugin-authoring.md` — the plugin manifest contract.
- `docs/plugins.md` — first-party plugin docs.
- `docs/getting-started.md` — adopter onboarding path.
- `docs/sdk.md`, `docs/byo-vision.md`, `docs/capabilities.md` — adjacent contracts.

**Every public behavior change updates the relevant page in the same diff.** Stale public docs poison adopter integration.

## `docs/ai-context/` — agent-facing routing layer

Not published. Read by agents (and contributors) working _on_ browxai.

- **Discipline.** `agent-process/commit-discipline.md`, `code-quality.md`, `docs-impact.md`, `dist-rebuild-discipline.md`.
- **Architecture rationale.** `architecture/repo-map.md`, `capability-posture-map.md`, this file.
- **Lessons captured.** `page-side-functions/dom-export-trap.md`, `secrets-and-egress/network-body-and-secrets.md`, `plugin-runtime/lifecycle-and-namespacing.md`.
- **Process.** `release-process/semver-clock.md`, `retired-registry-pattern.md`.
- **Field reports.** `adopter-reports/`, `investigations/`.

**VitePress excludes this subtree** via `srcExclude: ['ai-context/**', 'rfcs/**']`.

## Colocated `README.md` — internal contracts

Per-package and per-subdirectory READMEs are internal architecture contracts.

- `packages/plugins/<name>/README.md` — that plugin's purpose, capability surface, host-app version compatibility.
- `harness/README.md`, `harness/driving-browxai/SKILL.md`, `harness/adapters/<name>/README.md` — per-harness setup.

When refactoring a package, the colocated README travels with it.

## `docs/rfcs/` — design RFCs

Numbered RFCs for substantive design proposals. `0001-extract-ergonomics.md` is the inaugural. New RFCs use sequential numbering: `NNNN-short-slug.md`. Not published.

## What this means for a behavior-change diff

The full docs-impact pass: see [`../agent-process/docs-impact.md`](../agent-process/docs-impact.md).
