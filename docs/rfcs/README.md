# RFCs

Numbered RFCs for substantive design proposals. Each RFC is `NNNN-short-slug.md` with sequential numbering. Not VitePress-published (excluded via `srcExclude`); they live in the repo as design archive.

## Status

| #                                           | Title                                                                                             | Status                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [0001](0001-extract-ergonomics.md)          | Extract ergonomics                                                                                | Tracked — see CHANGELOG for landed proposals.                                                                                                                            |
| [0002](0002-multi-engine-bidi.md)           | Multi-engine browser support (driver-port abstraction; Firefox/Safari/mobile, WebDriver BiDi)     | Draft — research complete ([references/](references/)); Safari real-device lane pending reference 05.                                                                    |
| [0003](0003-capability-ports-decoupling.md) | Capability-ports decoupling (engine-blind tool surface via capability substrates)                 | Landed — Action/Capture/Storage/Script/Emulation substrates shipped; see CHANGELOG.                                                                                      |
| [0004](0004-architecture-hardening.md)      | Architecture hardening (a safety-critical maintainability standard + fitness-function guardrails) | Draft — proposal; adversarial audit + the ten-law standard + the phased plan complete, held to an iterate-until-clean review ([references/](references/) `0004-01..09`). |

## Reference corrections

- [`references/03-browxai-coupling-audit.md`](references/03-browxai-coupling-audit.md)
  was captured before the tool-registration decomposition. Its line counts are
  accurate **as of its commit** but stale now: `src/server.ts` is ~382 lines
  (composition only — the audit cites 12,889), and the tool registrations live in
  `src/tools/*-tools.ts` behind the `ToolHost` seam. Its coupling _map_
  (engine-agnostic vs. CDP-hard substrates) remains valid and is the input to
  [RFC 0004](0004-architecture-hardening.md)'s engine-seam work. For current
  structure see
  [`../ai-context/architecture/repo-map.md`](../ai-context/architecture/repo-map.md)
  and the enforced boundaries in
  [`../ai-context/architecture/fitness-functions.md`](../ai-context/architecture/fitness-functions.md).

## Adding an RFC

- A deep RFC may break its evidence, patterns, and specs into a companion suite
  `references/NNNN-NN-<slug>.md` (see 0004's suite). The spine stays the decision
  record; the references carry the depth.

- Reserve the next number.
- Filename: `NNNN-short-slug.md` (kebab-case slug).
- Body: problem statement, alternatives considered, recommendation, open questions.
- Add a row to the table above.
- Reference from CHANGELOG when implemented.
