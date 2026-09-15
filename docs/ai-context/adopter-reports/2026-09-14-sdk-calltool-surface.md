# SDK `callTool` reaches 45 of 189 tools

**Date:** 2026-09-14
**Source:** agent driving browxai through the TypeScript SDK (`createBrowxai`) rather than the MCP wire.
**Status:** FIXED on branch `fix/sdk-calltool-reach`. See "Durable lessons captured" below.

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

Both fix-shape items landed. `callTool` gates on capability alone, resolving it from the same
`TOOL_CAPABILITY` rows the server's `gateCheck` reads (`src/sdk/client.ts`, `src/sdk/registry.ts`);
`SDK_TOOLS` keeps only its stated job, the curated set of tools carrying a typed method. The error
split into two branches with two tags: `BROWXAI_SDK_NOT_EXPOSED` for a capability that is not active,
`BROWXAI_SDK_UNKNOWN_TOOL` for a name no tool registers. CHANGELOG `## Unreleased` → Fixed.

What the regression gates now hold:

- Every off-by-default capability refuses, per capability, over every tool it gates — driven off the
  live `TOOL_CAPABILITY` map, so a tool added under one of them is covered the day it lands
  (`test/sdk/capability-gate.test.ts`).
- An unknown name is refused on its own branch BEFORE any capability is resolved, so a typo can never
  reach the permissive `human` default. That ordering was the one place where getting this wrong
  would have been a security regression.
- `SDK_TOOLS` ≡ the typed methods on a built client (`test/sdk/typed-surface.test.ts`). The drift this
  catches is real and was live: `frames_list` had a wrapper and no entry, so `client.frames_list()`
  threw on every call under the old ceiling.
- A tool name nested in the ARGS is gated like a top-level one. Widening the reach brought `batch`,
  `flake_check`, the `act_and_*` family and `cross_session_sample` into play, and each dispatches an
  inner tool by name — so `batch({calls:[{tool:"eval_js"}]})` would have walked around a client that
  refuses `eval_js` head-on. Found by a gate audit of the diff, not by the change's own tests, which
  is the lesson worth keeping: widening a gate's reach can widen what the tools BEHIND it can reach.

Two things this report got right that were worth keeping: the capability table was accurate, and the
"What is not a defect" section correctly retracted an earlier wrong claim about `eval_js`.

## Still open, separate defect

`createBrowxai({ capabilities })` configures the CLIENT gate only. The in-process transport builds its
server from `BROWX_CAPABILITIES` / the workspace config, so a capability named on the client and
nowhere else passes the SDK gate and then meets the server's `gateCheck` refusal. The effective set is
the intersection, which is why this is a usability defect and not a posture one — the client can never
widen past the server. `README.md` and the canvas worked example now say both ends must name the
capability; making one call configure both is not done.
