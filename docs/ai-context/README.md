# `docs/ai-context/` — agent-facing routing layer

This subtree is the **agent-facing** companion to the public `docs/` site. It is **not** part of the published VitePress documentation (excluded via `srcExclude`); it lives in the repo so every harness has the same context and so the discipline is version-controlled with the code it governs.

## Read this before touching the relevant area

- Moving a boundary, adding a world-touching surface, or working on a hot path → read `architecture/architecture-principles.md` (the Kalebtec doctrine, macro layer) alongside `agent-process/code-quality.md` (micro layer).
- Touching the browser-engine seam (session launch, `cdp()`, adding an engine) → read `architecture/engine-adapters.md` (the `BrowserEngine` port + adapter contract).
- Editing a tool handler → read `tool-registration/server-tool-registry.md` and `page-side-functions/`.
- Writing a test → read `testing/qa-patterns.md` and `testing/unit-vs-keystone.md`.
- Working on capabilities or any posture-broadening surface → read `architecture/capability-posture-map.md` and `secrets-and-egress/network-body-and-secrets.md`.
- Releasing or changing the surface → read `release-process/semver-clock.md` and `release-process/retired-registry-pattern.md`.
- Authoring or maintaining a plugin → read `plugin-runtime/lifecycle-and-namespacing.md`.
- Touching recorder / replay / action-trace IR → read `recorder-and-replay/action-trace-contract.md`.

## Information architecture

| Subdir                 | Purpose                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-process/`       | Cross-cutting discipline: commits, dist-rebuild, docs-impact, code-quality (the f3-inspired big one).                                                                                                 |
| `architecture/`        | Substrate-level architecture references: the Kalebtec architecture-principles doctrine, repo map deep dive, capability posture map, documentation contracts, the `BrowserEngine` engine-adapter seam. |
| `tool-registration/`   | How an MCP tool gets registered, gated, returned, and tested.                                                                                                                                         |
| `page-side-functions/` | The real-function-literal discipline + the dom_export / element_export trap lesson.                                                                                                                   |
| `recorder-and-replay/` | Action-trace IR, no-trace contract, replayability.                                                                                                                                                    |
| `plugin-runtime/`      | Plugin runtime: lifecycle, namespacing, dependsOn, capability composition.                                                                                                                            |
| `secrets-and-egress/`  | network-body capability, secrets masking chokepoint, egress order of composition.                                                                                                                     |
| `testing/`             | Unit / plugin-integration / keystone layering; the QA patterns playbook.                                                                                                                              |
| `release-process/`     | Semver clock, retired-registry deprecation pattern, branch protection.                                                                                                                                |
| `adopter-reports/`     | Time-ordered field reports that drove surface changes.                                                                                                                                                |
| `investigations/`      | One-off investigations triggered by adopter or substrate friction.                                                                                                                                    |

## How this differs from the public `docs/` site

|                | `docs/` (public)                                                          | `docs/ai-context/` (agent-facing)                        |
| -------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| Audience       | adopters integrating browxai                                              | agents and contributors working _on_ browxai             |
| Promise        | public API contract (tool names, ActionResult shape, capability defaults) | working discipline + design rationale + captured lessons |
| Published      | yes, via VitePress to GitHub Pages                                        | no, repo-only                                            |
| Versioned with | semver-frozen surface                                                     | code                                                     |
| Read when      | integrating, debugging adopter-side                                       | making changes here                                      |
