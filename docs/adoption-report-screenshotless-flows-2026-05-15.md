# Screenshot-less flow report: authed heavy-SPA record-entry run

**Date:** 2026-05-15
**Driver:** Codex through the browxai MCP surface
**Target shape:** authenticated third-party portal, heavy SPA, custom select controls, editable record grid, row-level save actions
**Scope:** identify what still forced screenshot checks after the round-5 improvements (`batch`, coordinate targets, `ActionResult.element.value`, `displayText`, `contextRef`) and what would make the same workflow fully state-driven.

This report is deliberately target-agnostic. It avoids portal, client, route, mission, and account identifiers. The important shape is a generic one: a form-like grid where each row is one dated record, several fields are custom React-style selects, and each row is saved independently before a separate period-level submit.

## TL;DR

- Screenshot-less flows are now realistic for plain inputs. `fill` returning the actual post-write `element.value` eliminates the old "did my task text land?" screenshot loop.
- `batch` is useful once the target sequence is known-safe, but it does not solve trust. The hard part is not reducing round trips; it is proving that custom controls and rows reached the intended semantic state.
- The remaining blocker is custom select observability. The run had one real error where a row was saved with the wrong type label. The corrected flow still needed screenshots because the action result could not prove "this row's Type is the expected value" after a portal/listbox click.
- The second blocker is row context. The final `snapshot()` showed 11 saved value groups, but the state was flat: date cells, type chips, task text, initiative chips, blank draft row, and saved rows were not grouped into row-shaped records.
- Coordinate clicks are the right escape hatch, but they currently discard too much evidence. For screenshot-less operation, a coordinate click needs to report what element was hit and which nearby/owning control changed.
- The highest-leverage additions are: an owned-control post-action probe, a generic custom-combobox option primitive, structured row/list context in `snapshot`/`find`, and an exact visible-text search primitive for verification and absence checks.

## What worked

### Plain input writes are close to solved

The enriched `fill` result is the right direction:

- `element.value` confirms the actual DOM value after the write.
- `valueRequested` makes mismatch detection trivial.
- `displayText` gives a path for chip-style wrappers when the DOM input clears on commit.

For ordinary text fields, this is enough to stop reading screenshots after every fill. In the record-entry flow, the free-text field was not the uncertainty point once this probe was available.

### `batch` reduced mechanical overhead

Server-side `batch` is useful for known-safe sequences such as "fill date, fill task, open a select" or "perform a short series of actions after the row pattern is known." It keeps the model out of needless one-call-per-field loops.

The important limit held up too: `batch` should stay explicit. It is a speed primitive, not a reasoning primitive. The caller still needs reliable state signals between risky steps like custom option selection and row save.

### Snapshot DOM-walk fallback exposed the necessary data

The page's accessible tree was sparse, but `snapshot()` still surfaced the controls and saved values through DOM-walk entries. Final verification could count the saved groups and read the displayed values.

That is a large improvement over an a11y-only surface. The gap is not "the data is unavailable"; it is that the data is not shaped in a way an agent can safely use without visual confirmation.

### Coordinate targets were necessary

The custom select/listbox controls were hard to drive reliably by ref alone. Coordinate clicks let the workflow continue when the curated target finders could not reach a precise menu option.

This validates the coordinate escape hatch. It also shows why the escape hatch needs better evidence in its result, because the agent otherwise has to screenshot to know whether it clicked the intended option.

## What still forced screenshots

### Custom select commits were not semantically confirmed

The workflow needed to set fields like Type and Initiative through custom selects. Typing and pressing Enter could choose the wrong option. Clicking a visible option by coordinates was more reliable, but the post-action result did not prove:

- which option was clicked,
- which select control owned that option,
- what chip/value the control displayed after the click,
- whether the selected value differed from the previous value.

This is the core screenshot-less blocker. A real row was initially saved with the wrong type. After correction, screenshots were still required to confirm the row showed the intended type before saving.

### Row state was flat, not grouped

The final snapshot exposed repeated groups like:

```text
Expected Type
Expected task text
Expected initiative tag
Delete row
```

That proved the saved values existed, but it did not reliably answer the higher-level question:

```text
For a specific dated row, is Type = Expected Type, Task = Expected task text, Initiative = Expected initiative tag?
```

The date column and value columns were serialized as neighboring DOM nodes rather than a row object. The reusable blank draft row at the top also created ambiguity because it kept a date value and empty fields after rows were saved.

For screenshot-less verification, an agent needs row/collection context, not just a flat element stream.

### Exact absence checks were awkward

After correcting the wrong type, the natural verification was "there should be no visible Wrong Type value in the current saved rows." `find()` is a target-finding primitive, not a text search primitive; asking it for that text returned unrelated controls because it tried to produce actionable candidates.

Screenshot-less flows need a read primitive for exact visible text search and absence checks:

```jsonc
{
  "text": "Wrong Type",
  "exact": true,
  "scope": "record grid",
  "count": 0,
  "matches": []
}
```

This should not be overloaded onto `find()`. `find()` should locate things to act on. Text search should inspect rendered state.

### Coordinate clicks omitted target evidence

For `coords` targets, `ActionResult.element` is omitted because there is no pre-resolved ref or selector. That is mechanically true, but it leaves the agent blind at exactly the moment where coordinates were needed.

At minimum, a coordinate action should probe `document.elementFromPoint(x, y)` before and after the click and return:

- role/name/text/test attributes for the hit element,
- nearest labelled/control ancestor,
- visible text of that ancestor,
- bbox and clipped state,
- whether focus changed,
- whether any nearby/owning control display text changed.

That would not make coordinate flows as stable as refs, but it would make them inspectable.

### Row-level save did not produce a semantic persisted-record result

The row-level save button changed network/page state, but the result did not say "row for date X persisted with these values." The agent still needed to inspect the grid after saving.

This is not a request to expose arbitrary response bodies by default. A safe middle ground would be a redacted mutation summary plus a state probe of the row/container that owned the clicked save button.

## Concrete asks

### 1. Owned-control post-action probe

**Severity:** High

Extend `ActionResult` with a `control` probe in addition to the current `element` probe. The key distinction: `element` describes the direct target, while `control` describes the logical form control that changed.

Suggested shape:

```jsonc
{
  "element": {
    "ref": "e42",
    "role": "option",
    "displayText": "Expected Type"
  },
  "control": {
    "ref": "e31",
    "kind": "combobox",
    "label": "Type",
    "testId": "record-type-select-wrapper",
    "value": null,
    "displayTextBefore": "Enter Tag",
    "displayTextAfter": "Expected Type",
    "chips": ["Expected Type"],
    "changed": true
  }
}
```

Implementation notes:

- Walk up from the target to find a labelled wrapper, role-bearing ancestor, form field, combobox, listbox owner, or configured test-attribute wrapper.
- For portal menus, connect option to control through `aria-controls`, `aria-expanded`, `aria-activedescendant`, `aria-labelledby`, active element, or the most recently opened combobox.
- Run the probe for `click`, `press`, `fill`, and `select`, not only `fill`.
- Keep strings capped and page-derived text marked as untrusted, same as snapshot text.

This is the most direct fix for screenshot-less custom select flows.

### 2. Generic custom-combobox option primitive

**Severity:** High

Native `select()` covers real `<select>` elements, but modern portals often use custom combobox/listbox components. Add a generic primitive for that pattern rather than forcing agents into type-Enter or coordinate-click loops.

Possible shape:

```jsonc
{
  "tool": "choose_option",
  "args": {
    "target": { "selector": "[data-testing-id=\"type-select-wrapper\"]" },
    "option": "Expected Type",
    "exact": true
  }
}
```

Behavior:

1. Click/open the target control.
2. Search visible listbox/menu/portal options for exact text.
3. Click the option by resolved element, not by coordinates.
4. Return `ActionResult.control.displayTextAfter`.
5. Fail if zero or multiple exact options are visible unless disambiguation is provided.

This should remain generic: combobox/listbox/menu option selection, not app-specific select logic.

### 3. Structured row/list context in `snapshot()` and `find()`

**Severity:** High

Add context trails so candidates and serialized nodes carry their structural neighborhood.

For table/grid/list/card layouts, a node should be able to say:

```jsonc
{
  "role": "cell",
  "text": "Expected Type",
  "context": {
    "collection": "record grid",
    "rowKey": "Wed, May 13",
    "column": "Type",
    "rowText": "Dated row - Expected Type - Expected task text - Expected initiative tag"
  }
}
```

This does not need to be a record-type-specific helper. Generic sources:

- semantic table roles (`table`, `row`, `cell`, `columnheader`, `rowheader`),
- CSS grid/list patterns when headers are visible,
- nearest repeated parent with sibling rows of similar shape,
- ancestor text/test attributes,
- x/y alignment against visible headers when DOM semantics are poor.

Even a best-effort `context.rowText` would have prevented the final verification ambiguity.

### 4. Exact visible-text search primitive

**Severity:** Medium-high

Add a read-only primitive for text verification and absence checks:

```jsonc
{
  "tool": "text_search",
  "args": {
    "text": "Wrong Type",
    "exact": true,
    "scope": "optional ref/selector/named",
    "includeHidden": false
  }
}
```

Return:

```jsonc
{
  "count": 0,
  "matches": []
}
```

When matches exist, include bounded context: ref, text, nearest labelled ancestor, row/list context if available, visible rect, and clipped state.

This gives agents a deterministic way to ask "is the bad value gone?" without abusing `find()` or reading a screenshot.

### 5. Coordinate target evidence

**Severity:** Medium

For `click({ coords })` and `hover({ coords })`, return a coordinate probe:

```jsonc
{
  "coordinateTarget": {
    "x": 452,
    "y": 566,
    "before": {
      "tag": "div",
      "role": "option",
      "text": "Expected Type",
      "testAttrs": {},
      "ancestorText": "Expected Type Wrong Type ..."
    },
    "after": {
      "focusedRef": "e31",
      "controlDisplayText": "Expected Type"
    }
  }
}
```

Coordinates should stay the escape hatch, but escape hatches still need observability.

### 6. Row/container probe for submit/save buttons

**Severity:** Medium

When clicking an action inside a repeated row/card/panel, probe the nearest repeated container before and after the click.

Suggested addition:

```jsonc
{
  "container": {
    "kind": "row",
    "ref": "e120",
    "textBefore": "Dated row - Expected Type - ... - Send",
    "textAfter": "Dated row - Expected Type - ... - Delete row",
    "context": {
      "rowKey": "Wed, May 13"
    }
  }
}
```

This would let agents verify that row-level save changed the row state without screenshotting the table after every save.

### 7. Redacted mutation summary

**Severity:** Medium

`ActionResult.network` already summarizes request counts and failures. For form persistence flows, add a bounded mutation view:

```jsonc
{
  "mutations": [
    {
      "method": "POST",
      "urlPattern": "/api/.../records",
      "status": 200,
      "ok": true,
      "responseShape": ["id", "date", "type", "task", "initiative"],
      "durationMs": 184
    }
  ]
}
```

Do not dump arbitrary response bodies by default. The useful part is knowing that the click caused one successful mutation, not seeing every byte.

This pairs well with the row/container probe: network says persistence succeeded; row context says the visible state matches.

### 8. Batch labels and optional expectations

**Severity:** Low-medium

`batch` would be easier to audit if each call could carry an optional label:

```jsonc
{
  "tool": "fill",
  "label": "set task for Wed May 13",
  "args": { "...": "..." }
}
```

An optional lightweight `expect` block could also reduce screenshot checks:

```jsonc
{
  "tool": "choose_option",
  "label": "set type",
  "args": { "...": "..." },
  "expect": {
    "controlDisplayTextIncludes": "Expected Type"
  }
}
```

This should be kept simple. The goal is not to build a full assertion DSL inside browxai; it is to let known-safe batches fail early with structured evidence.

## Priority order

1. Owned-control post-action probe.
2. Generic custom-combobox option selection.
3. Structured row/list context.
4. Exact visible-text search.
5. Coordinate target evidence.
6. Row/container probe for repeated-layout action buttons.
7. Redacted mutation summary.
8. Batch labels/expectations.

The first four are the screenshot-less unlock. The remaining four make the same flow faster and easier to audit, but they are not enough on their own.

## What not to build

- Do not make screenshot OCR the answer. It would hide the same state gaps behind a more expensive and less deterministic read path.
- Do not encourage coordinate-first flows. Coordinates are necessary for canvas/custom-painted/poorly-semantic UIs, but refs/selectors should remain the primary path.
- Do not add app-specific table or record-entry helpers. The needed primitive is structural context for repeated layouts, not a per-target workflow API.
- Do not expose full network response bodies by default. Keep mutation summaries bounded and redacted unless a caller explicitly enables a higher-risk inspection mode.

## Closing assessment

The current surface is much closer than it was before the round-5 improvements. Plain text fields, known-safe batched actions, and final flat snapshots can now be handled with far fewer screenshots.

The remaining screenshot dependency is concentrated in one problem class: proving semantic state after actions that target custom controls inside repeated layouts. If browxai can return "what logical control changed" and "which row/container it belongs to," agents can stop screenshotting most form-heavy SPA workflows.
