# Engine evidence: refresh the dates at release

The "Engine evidence" table in `docs/tool-reference.md` (the Sessions section, published at `/reference/tool-reference/sessions/`) has one row per engine: what ran, where, on which version, on what date and how to rerun it. The README's engine statements quote it.

## The release checklist line

`RELEASING.md` step 2 says to refresh the engine evidence dates in the release PR. Do this before the release commit:

1. Take the new release date from the CHANGELOG section you just promoted.
2. Move the `chromium`, `firefox` and `webkit` rows to that date and version, only after `pnpm test:keystone` is green. The keystone run is a release prerequisite, so the release date is the record. The repo keeps no CI run logs.
3. Mark any other row stale when its date is older than the previous release, by adding `(stale)` after the date. A row stays stale until a run is recorded.
4. Record a by-hand run (`safari`, `android`, `android-app`, `ios-app`, `electron`) only when someone ran it for this release. Put the date and the engine or app version in the CHANGELOG line for that release, then copy both into the row. A row without a CHANGELOG line or a report date says `not run`.
5. Check the README engine paragraphs against the table. `rg -n 'engine evidence|recorded run|recorded pass' README.md` finds the sentences that quote it.

## Rules for the table

- Never write a date or version the repo does not record. A blank is `not run`, or `recorded per run` for a browser build the pipeline downloads.
- `not run` means the repo records no passing run. It does not say nobody ran the keystone.
- The capability testbed report is a second source for Chromium only (`packages/capability-testbed/reports/FULL-REPORT.md`, 2026-06-16 as of 0.19.0). Rerun it with `pnpm --filter @browxai/capability-testbed report` when a release touches many tools, and copy the new report date into the note under the table.
- The `ios-app` row stays `not run` until the keystone passes. A separate `ios-app (real device)` row records the 2026-11-24 probe of a real WebDriverAgent (roadmap item 7), and it stays until the engine itself runs against a device. Record it with the block in RFC 0008 section 10.7: date, target (simulator or device), iOS version, device model, Xcode version, WebDriverAgent tag and commit, and the browxai commit. Never put a device UDID, name or address in the row.

## Related

- [`../../tool-reference.md`](../../tool-reference.md): the table.
- [`../../roadmap.md`](../../roadmap.md): item 6, dated evidence for every engine.
- [`../../../RELEASING.md`](../../../RELEASING.md): the checklist.
