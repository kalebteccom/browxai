# Adversarial Review — Agent-Driven Dogfooding Harness

## Write-Probe Result

PASS. I created `/Users/rowin/Projects/Kalebtec/browxai/.write-probe` with content `OK`, read it back successfully, and deleted it before this review file was written.

## Verdict

go-with-amendments

The host-side topology is feasible, but the current design is not implementation-ready. The initial mission catalog does not cover the manifest, the coverage definition can falsely pass missions without exercising intended tools, and the startup path has an unclosed socket readiness race. These are not vague risks; they are concrete breakpoints in the design as written.

## Feasibility of Host-Side Run Path

The remotxai `CodexAppServerOwn` pattern does spawn `codex app-server` as a child of the host runner process. The default spawn function runs `process.env.CODEX_BIN ?? "codex"` with `["app-server"]` and host stdio wiring in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server-own.ts:108`; the constructor actually invokes that spawn and sends `initialize` in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server-own.ts:211`. The `thread/start` sandbox is only a Codex session parameter emitted after initialization, not a wrapper around the host runner itself, because `threadStartParams()` copies `sandbox`, `approvalPolicy`, `model`, and `reasoningEffort` into the JSON-RPC request in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server-own.ts:466`.

The design correctly routes browser launch outside the Codex sandbox by starting host-owned `browxai serve --socket <runRoot>/browxai.sock` and giving Codex only a stdio socket proxy, as described in `packages/capability-testbed/dogfood/DESIGN.md:51` and `packages/capability-testbed/dogfood/DESIGN.md:68`. Browxai supports this socket mode in `src/cli/serve.ts:38` and starts a Unix-socket MCP server in `src/cli/serve.ts:123`. That said, the wrapper sequence starts browxai and then spawns Codex without an explicit browxai socket readiness probe in `packages/capability-testbed/dogfood/DESIGN.md:1056`. If Codex's MCP proxy connects before `server.listen()` has bound the socket, the concrete failure mode is a Unix socket connect failure such as `connect ENOENT <runRoot>/browxai.sock` or `ECONNREFUSED`, depending on whether the socket path exists but is not accepting connections. The design does wait for the test app `/healthz` in `packages/capability-testbed/dogfood/DESIGN.md:96`, but it does not define the equivalent wait for browxai.

The design's sandbox claim is also only partially verified. It specifies `sandbox: { mode: "read-only" }` and `approvalPolicy: "never"` for the Codex thread in `packages/capability-testbed/dogfood/DESIGN.md:146`, and this is the right posture if the browser is truly launched by the host-owned browxai process. However, the design says the browser launch would fail if browxai were launched from inside the Codex sandbox in `packages/capability-testbed/dogfood/DESIGN.md:1076`, but neither the design nor the inspected code names the exact browser-launch error. That is an unverified claim. The exact verified Codex transport error I found is different: trying to talk raw JSON to `codex app-server --listen` fails with `failed to upgrade control socket websocket connection: WebSocket protocol error: httparse error: invalid token`, documented in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server.ts:10`.

`@remotxai/adapter-codex` is not a dependency the testbed can rely on. The local package is marked `"private": true` in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/package.json:4`, and the design itself says it is private or workspace-only and not published into the testbed dependency graph in `packages/capability-testbed/dogfood/DESIGN.md:19`. The fallback, an inline minimal app-server client plus a socket proxy, is sufficient in architecture because the needed protocol is small: initialize, initialized, thread/start, turn/start, notifications, and shutdown. It is not sufficient unless the implementation adds protocol fixtures or golden tests, because the design is copying a private protocol surface that may drift.

## Required Amendments (Implement stage MUST honor all of these)

1. Add a browxai socket readiness gate before spawning Codex. The wrapper must actively connect to `<runRoot>/browxai.sock` and perform at least MCP `initialize` plus `tools/list`, or the proxy must retry until a bounded timeout. Failure must report the exact socket error, for example `connect ENOENT` or `ECONNREFUSED`.

2. Fix the mission catalog so `assertSetEquals(union(CATALOG.expectedTools), manifestTools)` passes at startup. The current design omits every `extensions_*` manifest row even though `MANIFEST` declares them in `packages/capability-testbed/src/harness/manifest.ts:282`.

3. Add an extensions mission or explicitly remove extensions from the claimed dogfood coverage denominator. The deterministic harness already has extension exercises in `packages/capability-testbed/src/harness/exercises/extensions.ts:137`, so the dogfood harness should reuse them instead of leaving that capability uncovered.

4. Make agent coverage a pass criterion separate from oracle success. A mission must not pass coverage merely because a verifier session can prove the final page state. The report must fail or mark incomplete when the Codex trace did not touch the required tool set or required tool partitions for that mission.

5. Stop counting only `ok: true` tool calls as coverage. Some correct behaviors are structured refusals or unavailable-provider results, especially `solve_captcha`, `get_totp`, `get_credential`, canvas adapter paths, and extension/headless cases. Coverage must count manifest-approved structured outcomes, not only successful `ActionResult.ok === true`.

6. Either add a real BYOB attach mission or downgrade `byob-attach` to a recorded posture flag outside coverage. The design currently tags it as behavior-only in `packages/capability-testbed/dogfood/DESIGN.md:300`, but it does not force an attach-to-existing-Chrome path.

7. Add typed retry, correction, and confusion signals. At minimum record schema validation failures, wrong-tool attempts, changed-argument retries, first-success latency, and the reasoning/prose span immediately preceding each tool call. The current retry detector only catches the same tool with equivalent args after a failed earlier call in `packages/capability-testbed/dogfood/DESIGN.md:651`.

8. Use the Codex reasoning stream in friction metrics, but label it accurately. The app-server can emit reasoning summaries in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server.ts:250` and the adapter advertises `reports_reasoning` in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/index.ts:118`, but this is not guaranteed to be full hidden thinking tokens. Metrics should measure visible reasoning summaries and token usage, not claim direct access to private chain-of-thought.

9. Fix the report schema before implementation. It must explicitly key `frictionMetrics` by tool name, add per-capability rollups, represent `passed_with_friction`, and support K-run stability fields. The design mentions `aggregateStability` in `packages/capability-testbed/dogfood/DESIGN.md:992`, but the JSON schema in `packages/capability-testbed/dogfood/DESIGN.md:751` does not include that field.

10. Add a normalized regression report that excludes volatile fields such as `generatedAt`, run-root paths, and raw timestamps. The JSON report is concrete, but it will be noisy to diff unless it has a stable comparable subset.

11. Add protocol drift tests for the inline Codex app-server client. The implementation should include golden raw notification frames for `mcpToolCall`, reasoning, plan updates, usage, `turn/completed`, and thread-start failures, based on the private remotxai adapter behavior in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server-own.ts:283`.

12. Add an explicit sandbox-preflight test or remove the unverified browser-launch failure claim. If the implementation intends to reject direct stdio browxai under Codex read-only sandbox, it must name and assert the exact failure string observed on this repo.

13. Add the missing `dogfood` package script and all designed source files before claiming the harness is runnable. `packages/capability-testbed/package.json:9` currently has `serve`, `report`, and `typecheck`, but no `dogfood` script. The design also says the dogfood directory currently contains only `DESIGN.md` in `packages/capability-testbed/dogfood/DESIGN.md:867`.

14. Keep the dogfood catalog derived from, or mechanically checked against, `MANIFEST` and `EXERCISES`. Manual expected-tool arrays have already drifted from the deterministic harness.

## Risks (ranked by severity)

1. False coverage pass: an agent can complete a browser goal while skipping the intended tools, because oracle success and tool coverage are not the same gate.

2. Manifest/catalog drift: the proposed catalog omits `extensions_*`, so the design's own startup validator should fail against the 198-tool manifest.

3. Startup race: Codex can start before `browxai.sock` is listening, causing `connect ENOENT` or `ECONNREFUSED` from the MCP proxy.

4. Wrong sandbox failure is not concretely verified: the design says browser launch fails inside Codex's read-only sandbox but does not name or assert the exact failure.

5. Friction under-reporting: wrong-tool attempts, semantic confusion, and argument corrections are collapsed into ordinary tool events unless they match a narrow same-tool retry shape.

6. Correct structured refusals may be misclassified as uncovered tools because the coverage definition counts successful Codex calls only.

7. Private protocol drift: the inline Codex app-server mirror depends on a private adapter protocol and has no specified fixtures.

8. Report instability: K-run stability is discussed but not represented by the concrete JSON schema, making regressions harder to diff.

9. Missing runnable implementation: the dogfood source files and package script do not exist yet.

10. Capability wording mismatch: the task and design talk about 16 capability surfaces, while the source capability list contains 17 real capabilities plus synthetic `control`.

## Axis-by-Axis Findings

### Axis 1 — Host-Run Feasibility

The core host-run path is viable. `CodexAppServerOwn` is host-owned: `defaultSpawn` calls `codex app-server` in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server-own.ts:108`, and the constructor invokes that spawn before sending `initialize` in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server-own.ts:211`. The sandbox posture is a thread parameter, not the process sandbox for the host runner, because `threadStartParams()` serializes it into the `thread/start` request in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server-own.ts:466`.

The design's browser topology is also pointed in the right direction: host app, host `browxai serve --socket`, Codex app-server, then a Codex-side stdio-to-socket proxy in `packages/capability-testbed/dogfood/DESIGN.md:51`. Browxai supports socket MCP mode in `src/cli/serve.ts:38`; the server binds the Unix socket in `src/cli/serve.ts:123` and exposes the same handler names as MCP tools in `src/cli/serve.ts:89`.

The missing piece is readiness. The design waits for the test app via `/healthz` in `packages/capability-testbed/dogfood/DESIGN.md:96`, but its wrapper sequence starts browxai and then starts Codex in `packages/capability-testbed/dogfood/DESIGN.md:1056` without proving that the socket is connectable. The concrete expected failure is not vague: the proxy's socket connect can fail with `connect ENOENT <runRoot>/browxai.sock` or `ECONNREFUSED`.

The design correctly avoids `codex app-server --listen` raw JSON because that path is known to fail. The remotxai adapter documents the exact error as `failed to upgrade control socket websocket connection: WebSocket protocol error: httparse error: invalid token` in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server.ts:10`.

The package dependency claim is grounded: the local remotxai adapter is private in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/package.json:4`, and the design says not to depend on it in `packages/capability-testbed/dogfood/DESIGN.md:14`. The fallback is architecturally sufficient but operationally incomplete until it has fixtures and drift tests.

### Axis 2 — Ergonomic Feel Capture

The event stream can include reasoning summaries, not just tool names. The design normalizes `item/completed` reasoning in `packages/capability-testbed/dogfood/DESIGN.md:207`; the remotxai app-server maps completed reasoning items in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/app-server.ts:250`; and the adapter declares `reports_reasoning: true` in `/Users/rowin/Projects/Kalebtec/remotxai/adapters/codex/src/index.ts:118`.

Retries are only partially surfaced. The design infers retry when the same tool is called with structurally equivalent args after a failed earlier call in `packages/capability-testbed/dogfood/DESIGN.md:651`. That misses common ergonomic failures: wrong tool followed by right tool, schema correction with changed args, natural-language confusion followed by a tool call, and abandonments where the agent never found the affordance.

There is a friction metric, but it is underpowered. The report schema has `frictionMetrics` in `packages/capability-testbed/dogfood/DESIGN.md:773`, and the formula uses retry count, abandonment count, error count, latency, and tokens in `packages/capability-testbed/dogfood/DESIGN.md:816`. It does not use the reasoning summary text to detect confusion, does not compute latency to first correct call, and does not attach confusion spans to individual tools.

The missing human-useful signal is "the agent was confused before this call." The trace stores reasoning items separately in `packages/capability-testbed/dogfood/DESIGN.md:635`, but `ToolEvent` has no field for preceding reasoning, correction category, schema failure kind, or first-success timing. Without that, the report can say a tool was retried, but it cannot reliably say why the retry happened.

### Axis 3 — Coverage Guarantee

The proposed mission-to-capability mapping is:

1. `core-read-control`: `read`, `navigation`, `human`, `eval`, `action`, `control`, `diagnostics`, `stealth`, and `byob-attach` per `packages/capability-testbed/dogfood/DESIGN.md:309`.

2. `forms-input-providers`: `action`, `captcha`, `credentials`, and `clipboard` per `packages/capability-testbed/dogfood/DESIGN.md:357`.

3. `dialogs-policy`: `action` per `packages/capability-testbed/dogfood/DESIGN.md:369`.

4. `frames-tree`: `read` per `packages/capability-testbed/dogfood/DESIGN.md:381`.

5. `shadow-dom`: `read` per `packages/capability-testbed/dogfood/DESIGN.md:393`.

6. `scroll-overflow`: `navigation` per `packages/capability-testbed/dogfood/DESIGN.md:405`.

7. `network-http-ws-secrets`: `read`, `action`, `network-body`, and `secrets` per `packages/capability-testbed/dogfood/DESIGN.md:417`.

8. `workers-and-service-worker`: `read` and `action` per `packages/capability-testbed/dogfood/DESIGN.md:441`.

9. `storage-crud-auth`: `read` and `action` per `packages/capability-testbed/dogfood/DESIGN.md:453`.

10. `media-files-exports`: `file-io` and `action` per `packages/capability-testbed/dogfood/DESIGN.md:489`.

11. `permissions-and-geolocation`: `read` and `action` per `packages/capability-testbed/dogfood/DESIGN.md:513`.

12. `canvas-automation`: `canvas` and `read` per `packages/capability-testbed/dogfood/DESIGN.md:525`.

13. `gestures-pointer-touch`: `action` per `packages/capability-testbed/dogfood/DESIGN.md:537`.

14. `devices-synthetic`: `device-emulation` per `packages/capability-testbed/dogfood/DESIGN.md:549`.

15. `console-observation`: `read` per `packages/capability-testbed/dogfood/DESIGN.md:561`.

16. `perf-diagnostics`: `read` and `action` per `packages/capability-testbed/dogfood/DESIGN.md:573`.

That map does not cover all manifest tools. `MANIFEST` declares five extension tools in `packages/capability-testbed/src/harness/manifest.ts:282`, and the deterministic harness has exercises for them in `packages/capability-testbed/src/harness/exercises/extensions.ts:137`, but the design catalog has no extensions mission and no `extensions_*` expected tools. The design's startup check should therefore fail, because it requires exact equality between catalog expected tools and manifest tools in `packages/capability-testbed/dogfood/DESIGN.md:287`.

The "16 capability surfaces" wording is also imprecise. The app has 16 server surfaces in `packages/capability-testbed/src/server/pages/index.ts:22`, but the capability source lists 17 real capabilities in `packages/capability-testbed/src/harness/manifest.ts:306` and `src/util/capabilities.ts:36`, plus synthetic `control` in `packages/capability-testbed/src/harness/types.ts:21`.

Coverage is post-hoc, not guaranteed by mission execution. The prompt intentionally does not reveal expected tools in `packages/capability-testbed/dogfood/DESIGN.md:187`; oracles run in a separate verifier session in `packages/capability-testbed/dogfood/DESIGN.md:271`; and mission success is based on oracle pass/fail plus final marker extraction in `packages/capability-testbed/dogfood/DESIGN.md:838`. An agent can satisfy a page-state oracle while touching fewer tools than intended. The coverage matrix will expose the miss afterward in `packages/capability-testbed/dogfood/DESIGN.md:804`, but the mission itself is not forced across the surface.

### Axis 4 — Reproducibility

The design is strong on fixed inputs. The catalog is supposed to be git-tracked and deterministic in `packages/capability-testbed/dogfood/DESIGN.md:240`, and the default model, effort, sandbox, approval policy, K, and timeouts are pinned in `packages/capability-testbed/dogfood/DESIGN.md:961`. The driver also records runtime overrides in the trace per `packages/capability-testbed/dogfood/DESIGN.md:157`.

K is specified. Missions default to five runs in `packages/capability-testbed/dogfood/DESIGN.md:277`; expensive media and perf missions override K to three in `packages/capability-testbed/dogfood/DESIGN.md:510` and `packages/capability-testbed/dogfood/DESIGN.md:592`; and smoke mode is K=1 in `packages/capability-testbed/dogfood/DESIGN.md:988`.

The report is mostly deterministic if computed only from trace and oracle results. However, the schema has an internal mismatch: smoke mode mentions `aggregateStability: "single-run"` in `packages/capability-testbed/dogfood/DESIGN.md:992`, but the concrete `DogfoodReport` schema in `packages/capability-testbed/dogfood/DESIGN.md:751` does not contain that field. Likewise, mission outcomes are modeled as a boolean `passed` in `packages/capability-testbed/dogfood/DESIGN.md:783`, but K-run aggregation needs to distinguish stable pass, unstable pass, and stable fail per `packages/capability-testbed/dogfood/DESIGN.md:860`.

The JSONL trace is sufficient for trace replay and diffing if the implementation really writes raw app-server frames, normalized events, diagnostics, and final trace records as described in `packages/capability-testbed/dogfood/DESIGN.md:973`. It is not sufficient for deterministic browser replay unless the run also records app fixture version, server inputs, workspace artifacts, and oracle state. The design records repo SHA and dirty state in `packages/capability-testbed/dogfood/DESIGN.md:612`, which is necessary but not enough by itself for replaying a browser run outside the original checkout.

### Axis 5 — Report Usefulness and Diffability

The report schema is concrete. `DogfoodReport` is defined in `packages/capability-testbed/dogfood/DESIGN.md:751`; it includes metadata, `coverageByCapability`, `coverageByTool`, `frictionMetrics`, `missionOutcomes`, `topFrictionTools`, and `risks`.

The schema is not yet regression-grade. It includes volatile fields such as `generatedAt` and run paths in `packages/capability-testbed/dogfood/DESIGN.md:755`, so two reports will have noise even when behavior did not regress. The design needs a normalized diff artifact or a documented ignore list.

Friction appears to be per-tool because `topFrictionTools` references tool names in `packages/capability-testbed/dogfood/DESIGN.md:793`, but `frictionMetrics: Record<string, ...>` in `packages/capability-testbed/dogfood/DESIGN.md:773` does not explicitly say the key is a tool name. It also lacks a per-capability rollup, which is useful when a capability gate or surface design is the real source of friction.

The report can distinguish "failed" from "passed with some friction" only indirectly. Mission outcomes have `passed: boolean` in `packages/capability-testbed/dogfood/DESIGN.md:783`, while friction is stored elsewhere. A human can infer that a mission passed with a high confusion score, but the schema should represent that state directly as `passed_with_friction` or equivalent.

### Axis 6 — Reuse and Deduplication

The reuse intent is good. The design says to import `MANIFEST` and `HARNESS_CAPABILITIES` instead of duplicating them in `packages/capability-testbed/dogfood/DESIGN.md:949`, and to reuse `buildContext` and `runExercise` in `packages/capability-testbed/dogfood/DESIGN.md:951`. Those exports exist in `packages/capability-testbed/src/harness/driver.ts:44` and `packages/capability-testbed/src/harness/driver.ts:76`. The exercise registry is centralized in `packages/capability-testbed/src/harness/exercises/index.ts:66`, and the dogfood design correctly points at it.

The duplication risk is already real. The design manually copies expected tools into mission arrays, while `MANIFEST` already declares all rows. That manual list omitted the extension tools from `packages/capability-testbed/src/harness/manifest.ts:282`, even though extension exercises are already registered in `packages/capability-testbed/src/harness/exercises/index.ts:41`. This is exactly the drift the design says to prevent.

The boundary with future core e2e absorption is documented. The design says the dogfood harness starts under `packages/capability-testbed/dogfood/` and can later move into `src/harness/dogfood/` without changing trace/report contracts in `packages/capability-testbed/dogfood/DESIGN.md:1122`. That is clean enough, assuming the implementation keeps dogfood-specific Codex protocol code isolated from the deterministic harness.

### Axis 7 — What Is Missing or Will Break

1. HIGH: The initial catalog will fail the design's own manifest equality check. The manifest includes `extensions_install`, `extensions_list`, `extensions_reload`, `extensions_trigger`, and `extensions_uninstall` in `packages/capability-testbed/src/harness/manifest.ts:282`; the design catalog contains no extensions mission in `packages/capability-testbed/dogfood/DESIGN.md:304`; and the validator requires exact equality in `packages/capability-testbed/dogfood/DESIGN.md:287`.

2. HIGH: The host-run path has a browxai socket race. Browxai binds the socket in `src/cli/serve.ts:123`, but the wrapper sequence does not wait for that socket before starting Codex in `packages/capability-testbed/dogfood/DESIGN.md:1063`. Expected failure: `connect ENOENT <runRoot>/browxai.sock` or `ECONNREFUSED`.

3. HIGH: The implementation files do not exist yet. The design says only `DESIGN.md` exists in `packages/capability-testbed/dogfood/DESIGN.md:867`, and `packages/capability-testbed/package.json:9` has no `dogfood` script. A user cannot run the harness from the current repo state.

4. HIGH: Coverage can be a false positive. Mission pass is oracle-driven in `packages/capability-testbed/dogfood/DESIGN.md:838`, while expected tool coverage is a separate report computation in `packages/capability-testbed/dogfood/DESIGN.md:804`. The agent can skip intended surfaces and still pass the page-state oracle.

5. HIGH: The exact failure for "wrong sandbox posture" is unverified. The design raises the risk in `packages/capability-testbed/dogfood/DESIGN.md:1076`, but no inspected source or design section names the concrete browser-launch error. The implementation must add a preflight or stop making that claim.

6. MEDIUM: Correct structured refusals can be counted as uncovered tools. The design counts coverage from "successful Codex tool calls" in `packages/capability-testbed/dogfood/DESIGN.md:806`, but deterministic exercises accept structured unavailable-provider outcomes, for example captcha and credential provider paths in `packages/capability-testbed/src/harness/exercises/credentials-captcha.ts:58`.

7. MEDIUM: Friction metrics miss semantic corrections. Retry detection only covers same-tool equivalent-args retries in `packages/capability-testbed/dogfood/DESIGN.md:651`; it does not capture wrong-tool then right-tool corrections.

8. MEDIUM: The report schema cannot represent K-run stability cleanly. `missionOutcomes` has only `passed: boolean` in `packages/capability-testbed/dogfood/DESIGN.md:783`, but aggregation calls out unstable pass/fail states in `packages/capability-testbed/dogfood/DESIGN.md:860`.

9. MEDIUM: BYOB attach is not actually exercised. It is listed as behavior-only in `packages/capability-testbed/dogfood/DESIGN.md:300`, but no mission starts or attaches to an existing Chrome instance.

10. MEDIUM: The inline Codex adapter path has no drift guard. The design says to mirror protocol logic in `packages/capability-testbed/dogfood/DESIGN.md:38`, but it does not require golden-frame tests against the private adapter behavior.

11. LOW: The report's friction map key type is underspecified. `Record<string, ...>` in `packages/capability-testbed/dogfood/DESIGN.md:773` should explicitly mean tool name and should include capability rollups.

12. LOW: The design's "16 capability surfaces" language is likely conflating app surfaces with capabilities. Server surfaces are 16 in `packages/capability-testbed/src/server/pages/index.ts:22`; real capabilities are 17 in `src/util/capabilities.ts:36`, plus synthetic `control` in `packages/capability-testbed/src/harness/types.ts:21`.
