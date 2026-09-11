# Documentation contracts

browxai has three documentation surfaces, and each one makes a different promise to a different reader. Mixing them up is a docs-impact bug.

## `docs/`: the public adopter contract

VitePress-published to GitHub Pages, and the source of truth for what browxai promises its adopters.

- `docs/tool-reference.md`: every public tool, with input / output shape, capability, ActionResult fields and defaults. Its stability & semver section is the canonical pre-1.0 contract.
- `docs/threat-model.md`: per-capability security posture, threat rows, egress model.
- `docs/plugin-authoring.md`: the plugin manifest contract.
- `docs/plugins.md`: first-party plugin docs.
- `docs/getting-started.md`: adopter onboarding path.
- `docs/sdk.md`, `docs/byo-vision.md`, `docs/capabilities.md`: adjacent contracts.

**Every public behavior change updates the relevant page in the same diff.** Stale public docs poison adopter integration.

## `docs/ai-context/`: the agent-facing routing layer

Not published. Read by agents and contributors working _on_ browxai.

Discipline lives in `agent-process/commit-discipline.md`, `code-quality.md`, `docs-impact.md` and `dist-rebuild-discipline.md`. Architecture rationale is in `architecture/repo-map.md`, `capability-posture-map.md` and this file. Captured lessons are in `page-side-functions/dom-export-trap.md`, `secrets-and-egress/network-body-and-secrets.md` and `plugin-runtime/lifecycle-and-namespacing.md`, and each of those exists because somebody already hit the problem once. Release process sits in `release-process/semver-clock.md` and `retired-registry-pattern.md`. Field reports are under `adopter-reports/` and `investigations/`, in date order, and several of the surface changes in this repo trace back to them.

**VitePress excludes this subtree** via `srcExclude: ['ai-context/**', 'rfcs/**']`.

## Colocated `README.md`: internal contracts

Per-package and per-subdirectory READMEs are internal architecture contracts. They bind nobody outside the repo, and they still have to be right.

- `packages/plugins/<name>/README.md`: that plugin's purpose, capability surface, and the host-app versions it works against.
- `harness/README.md`, `harness/driving-browxai/SKILL.md`, `harness/adapters/<name>/README.md`: per-harness setup.

When refactoring a package, the colocated README travels with it.

## `docs/rfcs/`: design RFCs

Numbered RFCs for substantive design proposals. `0001-extract-ergonomics.md` is the inaugural. New RFCs use sequential numbering: `NNNN-short-slug.md`. Not published.

## What this means for a behavior-change diff

The full docs-impact pass: see [`../agent-process/docs-impact.md`](../agent-process/docs-impact.md).
