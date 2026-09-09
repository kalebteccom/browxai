# RFC 0006 — Flow files as connectors (typed inputs, outputs, assertions, compile to MCP)

**Date:** 2026-09-09
**Status:** Draft — proposal. Depends on a prerequisite that has not landed.
**Trigger:** [`2026-09-09-rowin-profile.md`](../ai-context/adopter-reports/2026-09-09-rowin-profile.md) item 7. An adopter drove a dozen platforms daily for six months, exported a recording successfully, and found the export could not express the thing the session was actually for.

## The gap

`export_playwright_script` works. A two-step recording against a live site emitted valid TypeScript with the correct selector and the spec passed in 8.5 seconds under `@playwright/test` with no hand-editing. `end_recording` emits the flow-file YAML alongside, and the header comment flags tier-5 selectors with `// TODO: fragile selector`.

But the recorder keys off `DispatchedAction`, so it captures navigate / click / fill / press / hover / select / waitFor / chooseOption / goBack / goForward. `find`, `extract`, `snapshot` and `eval_js` produce no dispatched action and never enter the trace (`src/page/recording.ts:104-121`, and the `lowerStep` switch in `src/page/export-playwright-script.ts`).

So a session whose purpose was to **read** something exports as a script that performs the navigation and returns nothing. The reporter's worked example: open a mail thread, read sender and body, act on it. Exported, that is a script which opens the page and clicks reply, with all the reading dropped.

A replayable script that produces no output is a macro. What the adopter wants is a **function**.

Secondary: there are no parameters. The URL is baked in, and nothing distinguishes a value that was incidental to the recording from a value that is the input.

## The observation this RFC rests on

The YAML is already closer to the target than the TypeScript is, because it already hoists selectors into a named `locators:` block:

```yaml
name: gmail-reply
locators:
  reply_button: 'role=button[name="Reply"]'
  body_field: 'role=textbox[name="Message Body"]'
steps:
  - id: open-1
    action: navigate
    value: "https://mail.google.com/mail/u/0/#inbox"
```

That block is a seam. A flow file with typed inputs and outputs **is** an MCP tool definition — name, description, input schema, handler. The mapping is mechanical; nothing has to be invented.

## Proposal

Four additions to the flow-file format, then two compile targets.

### `inputs`

```yaml
inputs:
  subject: { type: string, required: true, description: "Thread subject to reply to" }
  body: { type: string, required: true }
  replyAll: { type: boolean, default: false }
```

Lowers directly to an MCP tool's input schema, and to a typed parameter object on the TypeScript target.

### `outputs`

```yaml
outputs:
  sent: { type: boolean, from: assert.send_confirmed }
  recipients: { type: array, from: extract.recipient_list }
```

Binds to recorded **read** steps. This is what turns a macro into a function, and it is why the prerequisite below is load-bearing: with no reads in the trace there is nothing for `from:` to reference.

### `{{...}}` interpolation

```yaml
- id: fill-1
  action: fill
  target: $body_field
  value: "{{ body }}"
```

Substitution happens at run time against the resolved inputs. Unresolved references are a load-time error, not a run-time surprise.

### `assert` as a first-class step

```yaml
- id: guard-1
  action: assert
  target: $thread_subject
  expect: { textIncludes: "{{ subject }}" }
  onFail: abort
```

This one earns its place from field evidence rather than symmetry. The reporter sent two real emails through browxai, and guarded both by re-reading the page inside the same script that acted — checking the thread subject before clicking reply, and the composed body before clicking send. Both guards were hand-written `eval_js` calls. Given attached-mode sessions did not isolate at the time (RFC 0005), that guard was the only thing standing between an automated send and the wrong thread, and it was written by hand twice.

Reuse the predicate vocabulary that `batch`'s `expect` already defines rather than inventing a second assertion DSL.

### Compile targets

- `browxai compile flow.yaml --target mcp` → a runnable MCP server exposing the flow as one tool.
- `browxai compile flow.yaml --target ts` → the current TypeScript export, now with typed params and a return value.
- `browxai run flow.yaml --param subject=...` → direct execution.

## Prerequisites

**1. Record the reads. — LANDED.** `RecordedStep` is now a discriminated union of an action step and a read step, covering `extract` / `find` / `snapshot` / `eval_js`. Both the YAML draft and the `.spec.ts` export lower them, and an exported spec now returns values instead of nothing. `outputs` has something to bind to. See `docs/ai-context/recorder-and-replay/action-trace-contract.md` for the recorded shape.

Two fidelity limits that constrain `outputs` and should be designed around rather than discovered later: `extract` lowering reads the recorded schema's `x-browx-source.selector`, so nested object/array properties are not lowered; and a ref-scoped `extract({ref:"eN"})` lowers page-wide with a TODO, because refs are session-local and mean nothing on replay. `snapshot` lowers to a comment by design — a serialised a11y tree is not a script step — and is counted as unhandled rather than inflating the `handled` stat.

**2. Locators need a stability contract.** A compiled flow must refuse, or warn loudly, when a low-stability locator misses, instead of silently matching something else. `end_recording` already emits `stability: medium|low`, so the data is present and unused. Note the existing semantics: `stability: "high"` means "uniquely identifies this element in **this snapshot**", not "survives a deploy". A compiled flow that runs next month needs the second property, and the format should not imply it has it.

## Why this is the payoff

Every site an adopter drives that has no public API becomes a flow file, and the compiled MCP server is the connector nobody ships. The reporter's own list: Gmail, LinkedIn, Wellfound, A.Team, Greenhouse. The browser is the integration surface of last resort, and this turns a recording of one into a callable tool.

## Open questions

- **Secrets.** A flow with an input that is a password must route through `register_secret` rather than interpolating a raw value into a YAML file. Probably an input `type: secret` that resolves from the credential provider at run time and never lands in the file.
- **Failure semantics beyond `onFail: abort`.** Retry, continue, and compensate are all plausible; none are justified by evidence yet, so v1 should ship `abort` alone.
- **Versioning.** A flow file pinned to a site's DOM will break. Whether that is the author's problem or the format's (a `recordedAgainst:` date plus a staleness warning) is unresolved.
- **Capability posture.** A compiled MCP server inherits the capabilities its steps need. Whether the compiler derives that set and declares it, or the operator does, needs deciding before anything ships.

## Not in scope

Not a general workflow engine. No branching, no loops, no scheduling. A flow file is a recorded interaction with typed edges. The moment it grows control flow, the TypeScript target is the better answer and the format should say so.
