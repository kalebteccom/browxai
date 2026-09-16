// RFC 0004 P3 / D4 (DRY). The bounded, timestamp-ordered record ring the five
// page-policy classes (`DialogPolicyState`, `PermissionPolicyState`,
// `NotificationPolicyState`, `FsPickerPolicyState`, `DeviceEmulationState`) each
// hand-rolled verbatim — a `buffer: T[]` + a hard `cap` + `record` / `since` /
// a predicate-windowed `matchedSince`. Five copies of one bound is five places
// the cap or the timestamp comparison could drift; this is the single home.
//
// The bound is load-bearing (L7 — a chatty page must not grow the ring without
// limit), so collapsing it here makes the cap one tested value instead of five.
//
// Timestamp accessor: four of the five records carry `ts`; `NotificationRecord`
// carries `timestamp`. Rather than rename a field that is exposed on the wire
// (`ActionResult` / the policy report), the buffer takes a `tsOf` extractor so
// each policy keeps its own record shape verbatim — byte-identical behaviour,
// one shared bound.

/** A bounded, append-only record ring with a per-record timestamp. The single
 *  source of the buffer+cap discipline the five policy classes shared.
 *
 *  `cap` defaults to 200 (every policy's historical default). `tsOf` extracts the
 *  per-record timestamp; it defaults to reading a `ts: number` field, so a record
 *  shaped `{ ts }` needs no extractor, and a record shaped `{ timestamp }` passes
 *  `(r) => r.timestamp`. */
export class PolicyRecordBuffer<TRecord> {
  private readonly buffer: TRecord[] = [];
  private readonly cap: number;
  private readonly tsOf: (rec: TRecord) => number;

  constructor(cap = 200, tsOf?: (rec: TRecord) => number) {
    this.cap = cap;
    this.tsOf = tsOf ?? ((rec) => (rec as { ts: number }).ts);
  }

  /** Append a record; drop the oldest once the ring exceeds `cap`. The one place
   *  the bound lives. */
  record(rec: TRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.cap) this.buffer.shift();
  }

  /** Slice records with timestamp `>= since`. Used by the action-window. */
  since(since: number): TRecord[] {
    return this.buffer.filter((r) => this.tsOf(r) >= since);
  }

  /** True if any record in `[since, now]` satisfies `pred`. Each policy passes
   *  its own "raised" test — e.g. `(r) => r.handledAs === "raised"`. */
  matchedSince(since: number, pred: (rec: TRecord) => boolean): boolean {
    return this.buffer.some((r) => this.tsOf(r) >= since && pred(r));
  }
}

/** The idempotent-install guard the five page-policy classes each hand-rolled
 *  as a `WeakSet<BrowserContext>` / `WeakSet<Page>` field. BYOB reconnect and
 *  context rebuild both re-run the attach path, so the wiring has to be a no-op
 *  the second time; the guard answers "already wired?".
 *
 *  The target is `object`, not a Playwright type, because the guard tracks
 *  IDENTITY ONLY — it never dereferences what it is handed, so naming
 *  `BrowserContext` bought nothing and made the policy modules, which the
 *  `ActionResult` vocabulary reads its record shapes from, reach
 *  playwright-core. A Safari or native adapter passes its own context object
 *  and the guard works unchanged. (RFC 0009 P1.)
 *
 *  `WeakSet` so a discarded context/page is collectable. */
export class InstallGuard {
  private readonly wired = new WeakSet<object>();

  /** Has this target already been wired? */
  has(target: object): boolean {
    return this.wired.has(target);
  }

  /** Mark a target as wired. */
  mark(target: object): void {
    this.wired.add(target);
  }
}
