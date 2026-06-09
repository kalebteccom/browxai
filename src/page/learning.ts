// Learned `find()` ranking — Phase-2 follow-on.
//
// Session-scoped, in-memory feedback signal: when the agent calls
// `find_feedback({ query, ref })` after a successful find→act, we remember that
// (queryTokenSet → element-identity) pair. On subsequent finds whose query token
// set overlaps, we boost candidates that match the prior winner's identity.
//
// Identity = testId (most stable) or role+name (medium) — the same features the
// stable-ref scheme uses. So the boost survives snapshots that re-key refs.
//
// Cap: 100 entries per session, LRU-evict. Adding more learning sophistication
// (frequency, decay over wall-clock) is straightforward but Phase-3 work; this
// minimum-viable version closes the "ranking should adapt" loop without
// committing to a model.

export interface WinnerIdentity {
  testId?: string;
  testIdAttr?: string;
  role: string;
  name?: string;
}

interface FeedbackEntry {
  tokens: Set<string>;
  winner: WinnerIdentity;
  ts: number; // for LRU
}

export class FeedbackMemory {
  private entries: FeedbackEntry[] = [];
  private readonly cap: number;

  constructor(cap = 100) {
    this.cap = cap;
  }

  record(query: string, winner: WinnerIdentity): void {
    const tokens = tokenise(query);
    if (tokens.size === 0) return;
    // De-dupe: drop any prior entry with identical token set + winner identity.
    this.entries = this.entries.filter(
      (e) => !(setsEqual(e.tokens, tokens) && identityEqual(e.winner, winner)),
    );
    this.entries.push({ tokens, winner, ts: Date.now() });
    if (this.entries.length > this.cap) this.entries.shift();
  }

  /**
   * Compute a bonus score (≥ 0) for a candidate against the given query, based on
   * prior feedback. The bonus = +5 per matching prior entry whose token-set overlaps
   * the query and whose winner-identity matches the candidate. Capped at +15 per
   * candidate so a single repeated mistake can't dominate.
   */
  bonusFor(query: string, candidate: WinnerIdentity): number {
    const qTokens = tokenise(query);
    if (qTokens.size === 0) return 0;
    let bonus = 0;
    for (const e of this.entries) {
      if (!hasIntersection(qTokens, e.tokens)) continue;
      if (identityEqual(e.winner, candidate)) bonus += 5;
      if (bonus >= 15) break;
    }
    return bonus;
  }

  size(): number {
    return this.entries.length;
  }
  clear(): void {
    this.entries = [];
  }
}

function tokenise(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

function hasIntersection(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

function identityEqual(a: WinnerIdentity, b: WinnerIdentity): boolean {
  // testId is the strongest disambiguator; if both sides have one, only that matters.
  if (a.testId && b.testId)
    return (
      a.testId === b.testId && (a.testIdAttr ?? "data-testid") === (b.testIdAttr ?? "data-testid")
    );
  return a.role === b.role && (a.name ?? "") === (b.name ?? "");
}
