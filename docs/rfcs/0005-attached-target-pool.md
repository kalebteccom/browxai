# RFC 0005: Attached-target pool (per-session target identity, leases, heartbeat)

**Date:** 2026-09-09
**Status:** Landed. Target identity, refcounted per-endpoint connection, lease table, structured errors, pool ceiling, lease reclamation, dispatch-as-heartbeat, and public docs. A real-Chromium keystone is the regression gate.
**Trigger:** [`2026-09-09-rowin-profile.md`](../ai-context/adopter-reports/2026-09-09-rowin-profile.md) item 1. Six months of multi-agent use against one attached Chrome; roughly half of one agent's calls landed on another agent's page. Silent wrong writes, not errors.

## The defect

`src/engine/adapters/playwright-chromium.ts:90-91`:

```ts
const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
```

`attachByobChromium` then freezes that page into the session record as `page: () => page`.

Two independent faults compound:

1. **No target selection.** Every attach resolves the first context's first page. Session ids are distinct in the registry and identical at the target.
2. **No connection sharing.** Each `open_session` calls `connectOverCDP` independently, so N sessions open N browser connections to one Chrome and each one races to the same first page.

The result is not a race the caller can retry through. N sessions share one `Page` object by construction. There is no target identity on the session record and no liveness check, so a closed page leaves every session holding a stale handle that resolves to nothing.

`batch` with self-guarding evals is the field mitigation. It narrows the window; it does not close it.

## Scope

Attached (BYOB) chromium and android. Managed and incognito already isolate correctly (each owns its context) and are out of scope except where the shared types move.

Safari is out of scope: `safaridriver` hard-isolates automation into ephemeral windows, so there is no shared target to contend for.

## Design

### Target identity on the session record

`BrowserSession` gains `targetId?(): string`, optional because Safari has no CDP target. `SessionOptions` gains an internal `sessionId` so the factory can file the lease.

(An earlier draft also added `targetId` to `SessionInternals`. That interface turned out to have zero consumers anywhere in the tree and is not in the public export surface, so it was deleted instead of grown.)

`page()` stays synchronous and returns the bound `Page`, but it does check `page.isClosed()` first, a local boolean with no protocol round-trip. Without that check `attach-target-gone` has nowhere to fire and the stale-handle failure stays opaque, which is the defect this RFC exists to remove.

### Browser-connection registry

One CDP connection per endpoint, shared across every session attached to it, keyed by the normalized loopback URL. Today's per-session `connectOverCDP` becomes a lookup that connects on first use and refcounts thereafter. Last session out detaches.

This is the boundary change. It moves connection ownership from the session factory to a registry that outlives any one session.

### Leases

A lease binds one session id to one target id:

```
{ sessionId, targetId, endpoint, acquiredAt, renewedAt }
```

Acquisition at `open_session`, in order:

1. Enumerate live pages across every context on the endpoint, resolving each one's target id via `Target.getTargetInfo`.
2. Skip targets already leased.
3. Claim the first unleased target, or create a new one when none is free.
4. Refuse when the pool ceiling is reached.

Enumeration walks Playwright's page list rather than raw `Target.getTargets`, because a target id with no `Page` behind it is not bindable to a session. Same set; every candidate is usable.

Acquisition is serialized per endpoint. Enumerate-then-claim spans an `await`, so two concurrent `open_session` calls would otherwise both see the same target free and both claim it.

A session that created its own target records that fact and closes it at release. A session that claimed a pre-existing target leaves it open. Not-owned semantics stay intact: we never close a tab the operator opened.

Endpoint keys are normalized before use, so `localhost:9222` and `127.0.0.1:9222` share one connection and one lease set instead of splitting into two disjoint pools over the same Chrome. Android keys on the device serial rather than the forwarded port, since each session forwards its own port to the same device Chrome and the port would make two sessions look like two browsers.

### Heartbeat

`renewedAt` updates on every tool dispatch for the session. No separate timer, no background task. Dispatch is the heartbeat, so a working agent never expires and a dead one stops renewing immediately.

A lease is reclaimable once `now - renewedAt` exceeds the TTL. Reclamation happens lazily at the next acquisition, so a dead agent's tab returns to the pool without a sweeper.

Default TTL 5 minutes, `BROWX_ATTACH_LEASE_TTL_MS`. Longer than any per-call deadline, short enough that a crashed agent frees its slot within one coffee break.

### Ceiling

`BROWX_ATTACH_POOL_MAX`, default 8. Acquisition past the ceiling refuses with a structured error naming the live leases. The ceiling exists because each claimed tab is real memory in the operator's browser and an unbounded pool turns a runaway agent loop into a browser OOM.

### Failure modes, all structured

| Condition                          | Result                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| Target closed while leased         | `attach-target-gone`, naming session id and target id       |
| Lease reclaimed by another session | `attach-lease-expired`, naming the session and the TTL      |
| Pool at ceiling                    | `attach-pool-exhausted`, naming the ceiling and live leases |
| Endpoint unreachable               | existing loopback / connect errors, unchanged               |

Every one replaces a silent wrong write or an indefinite hang. That is the whole point of the RFC: the current failure is that nothing fails.

### Per-session action logs

Already shipped. The `diagnostics` capability writes one JSONL line per tool call under `$BROWX_WORKSPACE/diagnostics/<sessionId>/`. No new code; the adopter report's ask is a documentation gap, and the attached-pool docs point at it.

## What this is not

Not a fix for cross-tab identity. One Chrome means one cookie jar, so every session in the pool shares an identity. Fine for one operator driving their own accounts, wrong for multi-tenant testing, and the docs must say so.

Not a fix for leader election. Slack, Figma and Gmail elect a leader across tabs; two agents in one app will still fight. Out of scope and unfixable at this layer.

Not focus arbitration. `bringToFront` steals focus globally. Playwright routes input over CDP and screenshots do not need focus, so the pool does not call it, and a tool that does is a bug against this RFC.

Context-level surfaces stay shared: dialogs, downloads, permission grants, file pickers. Two agents downloading at once still collide in one directory. Named as a known limit.

## Alternatives rejected

**Pin without claiming** (record a target id, still resolve `pages()[0]`). Removes the silent-wrong-write class and nothing else. Considered and rejected as the primary design because it leaves the multi-agent case broken while looking fixed.

**One context per session over the attached browser.** `connectOverCDP` cannot create isolated contexts against a real Chrome profile without losing the authenticated state that is the entire reason to attach.

**Managed mode with a copied profile.** Loses live session state and doubles disk. The report measures 140 profile directories already.

## Phasing

- **P1** covers target identity, the connection registry, the lease table and the four structured errors. Keystone against real Chromium: two sessions on one endpoint touch two targets.
- **P2** adds the ceiling, lease reclamation and dispatch-as-heartbeat. Landed.

  The heartbeat had to be wired before the sweep: reclamation against a
  `renewedAt` that nothing advances would have expired every live session at the
  TTL, busy ones included. Implementation also changed the reclamation semantics
  from the original draft: elapsed time alone never ends a lease. A lease is
  only dropped when another session actually needs a target, so an idle agent is
  not punished for thinking, and `renew` reports reclamation after the fact by
  checking the session still holds the target it was bound to.

- **P3** is the docs pass: `tool-reference.md` session table, `threat-model.md` byob row, the shared-cookie-jar limit stated plainly.

## Enforcement

Per `architecture-principles.md` §4a every invariant needs a machine:

- Keystone (real Chromium, two concurrent attached sessions) asserts distinct target ids and that a write through session A never lands on session B's page.
- Unit test asserts lease reclamation after TTL and refusal at ceiling.
- `pnpm depcruise` on the session/engine boundary, since connection ownership moves.
