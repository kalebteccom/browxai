# Browxai Report - 2026-05-20 - Codex File IO Rerun

## Summary

This report covers the second Codex Browxai run against Clipro after enabling the newer
capability-gated tools:

- `upload_file`, gated by `file-io`
- `drag({ preflight: true })`, gated by `unstable`
- `poll_eval`, requiring both `unstable` and `eval`

The run succeeded. `upload_file` replaced the previous `eval_js` based CSV file injection,
and `drag` preflight correctly identified resize-handle risk on a very narrow timeline clip.
Both tools materially improved the media-editor QA workflow.

No Browxai or Clipro commits were made during this rerun.

## Environment

Target app:

- Clipro local SPA: `https://localhost.clipro.tv:3000/clipro/clipro/...`
- Clipro branch at time of rerun: `fix/csv-script-upload-skip-replays`
- Clipro local commit under test: `91455f6f74 DEV-280630: Apply segment-aware CSV script upload mapping`

Browxai session:

- Session id: `clipro-csv-replay-fileio`
- Mode: `persistent`
- Profile: `clipro-manual-login`
- Viewport: `1440x1000`
- Browser profile was already authenticated.

Browxai repo state observed before the rerun:

- HEAD: `20bee4c feat: structured point_probe failure (point + url for triage)`

Capabilities after Codex restart:

```json
{
  "env.capabilities": ["read", "navigation", "action", "human", "eval", "unstable", "file-io"],
  "resolved.capabilities": ["action", "eval", "file-io", "human", "navigation", "read", "unstable"]
}
```

This confirmed the startup capability gate had picked up `file-io`, not just the persisted
managed config layer.

## Workflow Covered

### 1. Startup Capability Check

After Codex restart, `get_config({ scope: "env" })` included `file-io`, and tool discovery
exposed `upload_file`.

This fixed the previous issue where `get_config({ scope: "resolved" })` could show a newly
persisted capability while the live server-level gate still lacked it.

### 2. Clipro Session Restore

Opened:

```json
{
  "session": "clipro-csv-replay-fileio",
  "mode": "persistent",
  "profile": "clipro-manual-login",
  "viewport": {
    "width": 1440,
    "height": 1000
  }
}
```

Then navigated to the Clipro library URL.

The persistent profile restored login and project state, but the Clipro UI opened with a
`Games Table` modal. I closed it by clicking outside the modal, then clicked the timeline
toolbar arrow-up button and opened the AI Voiceover tab via:

```css
[data-testid="side-panel-audio-recap-tab"]
```

### 3. Drag Preflight On Narrow Replay Clip

I used the new `drag` preflight on a narrow replay timeline item:

```json
{
  "from": {
    "selector": "[data-type=\"timeline-master-channel\"] [data-testid=\"timeline-segment-971774589\"] [data-type=\"timeline-track-item-content\"]"
  },
  "preflight": true
}
```

Result:

```json
{
  "ok": true,
  "preflight": {
    "point": {
      "x": 237.19140625,
      "y": 917.203125
    },
    "resizeRisk": true
  }
}
```

The hit stack showed the top layers were timeline resize handles with `cursor: "ew-resize"`:

- `timeline-resize-left-handle`
- `timeline-resize-right-handle`

This directly explained the earlier accidental resize during the first Browxai run. The
preflight now gives an agent a reliable way to avoid dragging from a resize handle on small
timeline clips.

### 4. CSV Upload Via `upload_file`

Used `upload_file` against the hidden CSV input:

```json
{
  "selector": "input[type=\"file\"][accept=\".csv\"], input[accept=\".csv\"]",
  "name": "browx-fileio.csv",
  "mimeType": "text/csv",
  "content": "U2NyaXB0CkJST1dYX0ZJTEVJT18xCkJST1dYX0ZJTEVJT18yCkJST1dYX0ZJTEVJT18zCg=="
}
```

The decoded CSV content was:

```csv
Script
BROWX_FILEIO_1
BROWX_FILEIO_2
BROWX_FILEIO_3
```

Tool result:

```json
{
  "ok": true,
  "mode": "content",
  "name": "browx-fileio.csv"
}
```

Redux verification after upload:

```json
{
  "scripts": [
    {
      "text": "BROWX_FILEIO_1",
      "timelineIn": 0,
      "timelineOut": 12.195511,
      "clipAssetId": 971770828
    },
    {
      "text": "BROWX_FILEIO_2",
      "timelineIn": 12.195511,
      "timelineOut": 26.3253,
      "clipAssetId": 971773590
    },
    {
      "text": "BROWX_FILEIO_3",
      "timelineIn": 26.3253,
      "timelineOut": 38.4374,
      "clipAssetId": 971780129
    }
  ]
}
```

The replay clip at index 2 was skipped as a CSV match target, and script 2 extended through
that replay segment. This matches the expected Clipro behavior for the ticket under test.

### 5. Mismatch Error Path Via `upload_file`

Uploaded an 18-row CSV through `upload_file`:

```csv
Script
BROWX_FILEIO_TOO_MANY_1
...
BROWX_FILEIO_TOO_MANY_18
```

The upload tool succeeded at setting the file:

```json
{
  "ok": true,
  "mode": "content",
  "name": "browx-fileio-too-many.csv"
}
```

The application rejected the CSV, kept the existing 3 scripts intact, and showed:

```text
The number of scripts in the CSV exceeds the number of non-replay segments in the timeline. Please upload a file with a matching or smaller number of scripts.
```

Redux confirmation:

```json
{
  "len": 3,
  "first": "BROWX_FILEIO_1",
  "last": "BROWX_FILEIO_3"
}
```

### 6. Session Cleanup

Closed the Browxai session:

```json
{
  "ok": true,
  "session": "clipro-csv-replay-fileio",
  "wasOpen": true
}
```

## Prior Run Coverage For Context

The earlier Browxai run, before `upload_file` and drag preflight were available in this
session, also verified the full replay edge-case matrix with real timeline drags:

- Consecutive replay clips:
  - Reordered the two replay clips next to each other.
  - Uploaded 3 CSV rows.
  - Script 2 mapped to the preceding non-replay clip and extended through both replays.
  - Script 3 started on the next non-replay clip.

- Leading replay:
  - Moved a replay to index 0.
  - Uploaded 2 CSV rows.
  - Script 1 ignored the leading replay and mapped to the first non-replay clip.

- Trailing replay:
  - Moved a replay to the end.
  - Uploaded 17 rows for 17 non-replay segments.
  - Final script mapped to the final non-replay clip and extended through the trailing replay.

- Mismatch:
  - Uploaded 18 rows against 17 non-replay segments.
  - The app rejected the upload and preserved existing scripts.

The second run primarily validated that the newer Browxai tools cover the same CSV upload
path without `eval_js` file injection and with better drag safety diagnostics.

## Findings

### `upload_file` Works Well For Hidden Inputs

`upload_file` worked against a hidden CSV input using a selector. This is a meaningful
improvement over the previous `eval_js` workaround that manually constructed `File` and
`DataTransfer`.

Observed strengths:

- Works with hidden inputs.
- Content mode is simple for generated test CSVs.
- Does not require page-side JavaScript.
- Correctly triggered the app's upload/change flow.

Remaining untested path:

- `path` mode was not tested. The run only used inline base64 `content`.

### `drag` Preflight Directly Solves The Timeline Resize Hazard

The preflight result caught exactly the problem encountered earlier: the agent thought it
was dragging a replay clip body, but the press point was inside overlapping resize handles.

The returned `resizeRisk: true` signal was actionable and easy to interpret.

Recommended usage pattern for future media-editor flows:

1. Run `drag({ from, preflight: true })`.
2. If `resizeRisk` is true, choose a safer selector/coordinate or avoid dragging that item.
3. Only call the actual `drag` after the preflight hit stack is acceptable.

### Persistent Profile State Is Useful But Can Carry Test Mutations

The persistent Clipro profile preserved authentication and the previously loaded project.
That made the rerun fast. It also preserved manipulated timeline state from earlier tests,
including a replay clip that had been accidentally resized before drag preflight existed.

This is not a Browxai bug, but it matters for repeatability.

Wishlist:

- A documented pattern for cloning or snapshotting a persistent profile before destructive
  media-editor tests.
- A profile reset/restore helper would make these tests easier to repeat without asking the
  human to reload a fresh project manually.

### Config Precedence Is Now Clear In The Runbook

The runbook now documents that capabilities are resolved once at server startup and that
persisted capability arrays replace the env layer. The rerun confirmed the correct setup:
both the Codex MCP env and the Browxai managed user config included all needed capabilities.

The important diagnostic was checking both:

- `get_config({ scope: "env" })`
- `get_config({ scope: "resolved" })`

If either omits a startup-gated capability, the agent should expect disabled-tool failures
until the MCP server is restarted with the correct grant.

### Tool Discovery Reflected The New Surface Correctly

After restart, tool discovery exposed:

- `upload_file`
- `drag` with `preflight`
- `poll_eval`

This made it clear that the live MCP process was using the updated Browxai build and
startup capabilities.

## Errors Or Friction

### Clipro Opened With A Modal Blocking The Workspace

The persistent profile opened with a `Games Table` modal over the workspace. This was easy
to clear with a real click, but it is a recurring prerequisite for this target app.

Not a Browxai issue.

### Preflight On Very Narrow Clips Can Still Point At Handles By Default

Element-center targeting on a very narrow clip can still land inside handle overlap,
because the resize handles themselves are wider than the clip body.

This is exactly why preflight is useful, but agents should not assume element-center is safe
for tiny media-editor clips.

Possible future enhancement:

- Return a suggested safer point when `resizeRisk` is true, if Browxai can infer one from
  the stack geometry.

### `upload_file` Result Is Minimal

The result shape was enough:

```json
{
  "ok": true,
  "mode": "content",
  "name": "browx-fileio.csv"
}
```

For debugging, it might be useful to also include:

- target selector/ref summary
- file size in bytes
- MIME type
- whether the target input was hidden
- number of files set

This is a wishlist item, not a blocker.

## Recommendations

### Documentation

Add or keep examples for the two exact patterns that worked well:

Upload generated CSV:

```json
{
  "selector": "input[type=\"file\"][accept=\".csv\"], input[accept=\".csv\"]",
  "name": "example.csv",
  "mimeType": "text/csv",
  "content": "<base64 CSV>"
}
```

Preflight before dragging timeline clips:

```json
{
  "from": {
    "selector": "[data-type=\"timeline-master-channel\"] [data-testid=\"timeline-segment-...\"] [data-type=\"timeline-track-item-content\"]"
  },
  "preflight": true
}
```

### Future Browxai Enhancements

- `upload_file` could return file size/MIME/input visibility/file count.
- `drag` preflight could optionally suggest a safer drag coordinate when `resizeRisk` is true.
- A persistent-profile clone/restore pattern would help with destructive authenticated SPA tests.
- `path` mode for `upload_file` should get a small adoption test that proves:
  - workspace-relative accepted path works
  - path escape is rejected

## Final Assessment

The new Browxai tools are a clear improvement for media-editor QA.

- `upload_file` eliminated unsafe/awkward page-side file injection.
- `drag` preflight made a previously subtle timeline resize failure obvious before action.
- `poll_eval` continued to be the right primitive for Redux-state assertions after upload.

For the Clipro CSV replay-ticket workflow, Browxai now has the right primitives to test the
feature predictably without relying on brittle manual coordinate guesses or page-side file
construction.
