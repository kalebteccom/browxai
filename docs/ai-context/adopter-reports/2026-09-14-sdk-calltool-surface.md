# SDK `callTool` reaches 45 of 189 tools

**Date:** 2026-09-14
**Source:** agent driving browxai through the TypeScript SDK (`createBrowxai`) rather than the MCP wire.
**Status:** open defect. Triage verdict not yet assigned.

## Symptom

`client.callTool("canvas_capture", {format:"png"})` throws before anything reaches the wire, with
every capability enabled:

```
BROWXAI_SDK_NOT_EXPOSED: tool "canvas_capture" is not exposed on this SDK client.
Required capability: "canvas". Active capabilities: [read, navigation, action, eval, network-body,
secrets, file-io, canvas, extensions, stealth, captcha, credentials, clipboard, diagnostics].
Pass it in `createBrowxai({ capabilities: ["canvas"] })` to opt in.
```

The capability it names as required is already active, so the remedy the message gives cannot work.

That exact call is the worked example in `docs/tool-reference.md:3200`, the canvas/vision composition
loop. Both halves of it fail: `canvas_capture` and `gesture_chain`.

## Root cause

`buildClient` (`src/sdk/client.ts:32-44`) seeds the `exposed` set by iterating `SDK_TOOLS`, so
`exposed ⊆ SDK_TOOLS` always. `callTool` (`:59-71`) then rejects anything outside `exposed`.

`SDK_TOOLS` holds 45 entries. The server registers 189. The escape hatch documented on `callTool`
as covering "typed-but-unwrapped tools" escapes the _typed method surface_ only, and the registry
stays a hard ceiling underneath it. 144 tools have no SDK path at all, including 118 whose
capability is one of the four always-on ones (`read`, `navigation`, `action`, `human`) and which
therefore carry no posture argument for being withheld:

| capability   | absent from `SDK_TOOLS` | examples                                                                                                                |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `action`     | 66                      | `set_color_scheme`, `set_reduced_motion`, `clock`, `seed_random`, `route`, `double_click`, `drag`, `touch_*`, `mouse_*` |
| `read`       | 43                      | `sample`, `act_and_diff`, `frames_list`, `shadow_trees`, `export_session_report`, `perf_audit`                          |
| `human`      | 8                       | `start_recording`, `end_recording`, `record_annotate`, `region`                                                         |
| `navigation` | 1                       | `tab_visibility`                                                                                                        |

`capabilityFor` (`src/sdk/registry.ts`) resolves against the server's `TOOL_CAPABILITY` map, which
does know these tools. That is why the error text can name a real capability while the tool is
unreachable for an unrelated reason: the message has one branch for two distinct failures.

## What is not a defect

`eval_js` is exposed and works. It sits in `SDK_TOOLS` under the comment block at
`src/sdk/registry.ts:59-62`, absent from the typed surface on purpose and reachable through
`callTool` once `eval` is named. `callTool('eval_js', {session, expr:'1+1'})` returns
`{ok:true, value:2}`. An earlier report from this same agent claimed otherwise; that claim was wrong.

The same holds for `network_body`, `upload_file` and `register_secret`.

## Fix shape

Two changes, independent of each other.

1. **Split the error.** A tool outside `SDK_TOOLS` is a different condition from a tool whose
   capability is not opted in, and needs its own message naming the registry and pointing at the MCP
   path. Today one branch serves both and gives unusable advice for the first.
2. **Decide what `SDK_TOOLS` is for.** Either it is the curated typed surface and `callTool` gates
   on capability alone, which makes the documented canvas example work and gives the SDK the same
   reach as MCP, or the curation is deliberate and `docs/tool-reference.md` stops showing calls that
   cannot run. The registry header says "curated subset", the `callTool` docstring implies reach.

Option 1 for `callTool` matches `README.md:86`, which states the gate purely in posture terms:
"Tools that broaden the security posture are off by default and only appear once their capability is
named". Curation goes unmentioned there.

## Durable lessons captured

Pending. This report has no CHANGELOG entry yet.
