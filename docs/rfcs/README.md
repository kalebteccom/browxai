# RFCs

Numbered RFCs for substantive design proposals. Each RFC is `NNNN-short-slug.md` with sequential numbering. Not VitePress-published (excluded via `srcExclude`); they live in the repo as design archive.

## Status

| #                                  | Title                                                                                         | Status                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [0001](0001-extract-ergonomics.md) | Extract ergonomics                                                                            | Tracked — see CHANGELOG for landed proposals.                                                         |
| [0002](0002-multi-engine-bidi.md)  | Multi-engine browser support (driver-port abstraction; Firefox/Safari/mobile, WebDriver BiDi) | Draft — research complete ([references/](references/)); Safari real-device lane pending reference 05. |

## Adding an RFC

- Reserve the next number.
- Filename: `NNNN-short-slug.md` (kebab-case slug).
- Body: problem statement, alternatives considered, recommendation, open questions.
- Add a row to the table above.
- Reference from CHANGELOG when implemented.
