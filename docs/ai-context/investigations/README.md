# Investigations

Root-cause write-ups for tricky bugs, performance traps, and page-side function gotchas — the kind of issues a future maintainer would otherwise hit a second time before remembering they'd been solved. Time-ordered. Each entry captures the symptom, the hypothesis chase, the actual root cause, and whatever discipline change (if any) followed.

## When to file one

After solving a non-obvious issue where the path from symptom to cause was non-linear, or where the cause sits in a layer (browser internals, Playwright semantics, page-side JS quirks) that future eyes wouldn't naturally suspect. Skip filing for run-of-the-mill bugs whose fix is its own documentation.

## Loop

1. Investigation lands as `<YYYY-MM-DD>-<slug>.md`.
2. Cross-reference it from the closest in-context spot — typically `docs/ai-context/agent-process/code-quality.md` or `docs/ai-context/page-side-functions/`-tree pattern docs — if the lesson generalizes.
3. If the investigation produced a discipline change or a surface change, the originating doc links back to the CHANGELOG entry or roadmap phase that landed the fix.

## Investigations

- [`2026-05-27-screenshot-marks.md`](2026-05-27-screenshot-marks.md) — `screenshot_marks` rendering behavior; page-side overlay lifecycle and capture-window race conditions surfaced during a debugging session.
